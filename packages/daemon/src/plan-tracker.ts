import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanUsage, PlanWindow, SessionModelInfo } from "@colo-design/protocol";
import { probePlanUsage } from "./agent/drivers/claude/session.js";
import { CONFIG_DIR } from "./environment.js";
import type { Session } from "./session.js";

/** Where the last plan-limit readings wait for the next start. */
function planUsageFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLO_DESIGN_PLAN_USAGE ?? join(CONFIG_DIR, "plan-usage.json");
}
/** Where the model picker's rows wait for the next start. */
const MODEL_CATALOG_FILE = join(CONFIG_DIR, "model-catalog.json");

/** Whether a window's own reset moment has already gone by. */
function hasReset(window: PlanWindow | null | undefined, now: number): boolean {
  if (!window?.resetsAt) return false;
  const at = Date.parse(window.resetsAt);
  return !Number.isNaN(at) && at <= now;
}

/**
 * The window as it stands now. A reset that has passed does not make the
 * window unknown — it makes it empty, so it comes back refilled instead of
 * disappearing: the row a planner watches is exactly the one that must not
 * vanish the moment its news turns good. The next reading names the new
 * reset time; until then there is none to promise.
 */
function refilled<T extends PlanWindow>(window: T, now: number): T {
  return hasReset(window, now) ? { ...window, utilization: 0, resetsAt: null } : window;
}

export interface PlanTrackerDeps {
  /**
   * The most recently active idle session of one provider — a live reading
   * rides it. A codex rate-limit hit must not be answered by reading claude:
   * the limits are the account's, and one machine signs into one account per
   * provider, so every ask names its provider and only that provider's
   * session answers.
   */
  idleSession: (provider: string) => Pick<Session, "usage"> | null;
  claudeExecutable: () => string | null;
  /** Where a probe CLI runs when no session can be asked. */
  probeCwd: () => string;
  /** Aborted when the daemon stops — a probe must not outlive it. */
  signal: AbortSignal;
  /** A fresh reading changed what `status` reports — rebroadcast it. */
  onChanged: () => void;
  /**
   * Session-less model catalogs a driver can answer without a thread —
   * `omp models --json`. Each is read once per run; the
   * disk cache covers the rest.
   */
  catalogSources: Array<{ provider: string; read: () => Promise<SessionModelInfo[]> }>;
}

/**
 * Each provider account's plan limits, and the CLI's model catalog — both
 * belong to the account, not to one thread. One machine signs into one
 * account per provider, so the readings live in a map keyed by provider and
 * the composer reads the row of the provider it is about to spend: a planner
 * working in codex must see codex's budget, not claude's.
 */
export class PlanTracker {
  /** Minimum spacing between re-reads of one provider's limits. */
  private static readonly REFRESH_BACKOFF_MS = 120_000;
  /** Last time each provider was actually asked, epoch ms. */
  private lastPlanRefresh: Record<string, number> = {};
  /** Per-provider plan limits: last reading, restored across restarts. */
  private planUsage: Record<string, PlanUsage>;
  /**
   * One fresh reading is owed per provider. The cache on disk is only as
   * complete as the build that wrote it — one from before per-model weeks
   * carries no Fable row at all — and the account's numbers move whether
   * this daemon is running or not, so the chip opens on a reading of its own
   * rather than on whatever the last turn happened to leave behind.
   */
  private readonly planReadingOwed = new Set<string>(["claude"]);
  /** Each provider's model rows, cached so the picker works before any thread. */
  private modelRows: Record<string, SessionModelInfo[]>;
  /** Providers whose session-less catalog this run already asked for. */
  private readonly catalogRead = new Set<string>();

  constructor(private readonly deps: PlanTrackerDeps) {
    this.planUsage = this.loadPlanUsage();
    for (const provider of Object.keys(this.planUsage)) this.planReadingOwed.add(provider);
    this.modelRows = this.loadModels();
  }

  /** The model picker's rows per provider — empty until a session has reported. */
  get models(): Record<string, SessionModelInfo[]> {
    return this.modelRows;
  }

  /**
   * The picker's rows before any thread: drivers that can answer without a
   * session are read once per run — the same "one fresh reading" rule the
   * plan limits follow — and land in the same cache a live session feeds.
   * A provider the disk cache already holds is still read: that cache is
   * only as complete as the build that wrote it. Failures stay silent and
   * the cache keeps serving whatever it still has.
   */
  refreshModels(): void {
    for (const source of this.deps.catalogSources) {
      if (this.catalogRead.has(source.provider)) continue;
      this.catalogRead.add(source.provider);
      void source
        .read()
        .then((rows) => this.rememberModels(source.provider, rows))
        .catch(() => undefined);
    }
  }

  /**
   * 한도가 움직였다 (PLAN D100): 요금 칩이 2분 뒤에야 진실을 말하면,
   * 계획자는 이미 막힌 뒤에 그 사실을 안다. 다음 읽기를 앞당긴다 — 그 계정의
   * 세션으로. 다른 계정을 읽어 대신하는 건 "맞는 모양의 틀린 답"이라 침묵이
   * 낫다.
   */
  noteRateLimit(provider: string): void {
    this.planReadingOwed.add(provider);
    this.lastPlanRefresh[provider] = 0;
    this.refresh(provider);
  }

  /**
   * Plan limits belong to the account, not to one thread: whatever reading
   * lands last stands for that provider's every client, so the composer can
   * show them with no session open at all. The last reading also survives a
   * restart, and it settles what the run still owes — one reading has now
   * been had.
   */
  rememberPlanUsage(plan: PlanUsage | null): void {
    if (!plan) return;
    const provider = plan.provider ?? "claude";
    this.planReadingOwed.delete(provider);
    // The account was just asked, however the answer travelled — the next
    // backoff window starts at the answer, so a reading that raced a refresh
    // collapses into it instead of paying for a second ask.
    this.lastPlanRefresh[provider] = Date.now();
    if (JSON.stringify(plan) === JSON.stringify(this.planUsage[provider])) return;
    this.planUsage = { ...this.planUsage, [provider]: plan };
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(planUsageFile(), `${JSON.stringify(this.planUsage, null, 2)}\n`);
    } catch {
      // A cache that cannot be written just means the next start shows nothing.
    }
    this.deps.onChanged();
  }

  /**
   * Every provider's reading as the composer may see it now. A window whose
   * reset has passed is refilled here, not just on load — a daemon that sits
   * for hours would otherwise keep saying 43% about a window that no longer
   * exists — and the row keeps its place either way, because a planner
   * checking whether the weekly Fable cap is near must find it there whatever
   * the answer turns out to be. A reset also asks for a fresh reading: it is
   * exactly when the number matters again, and the next turn is not the only
   * moment one can land.
   *
   * A provider with no reading yet owes one — the first codex session to go
   * idle is asked even before its first turn, which is the whole point: the
   * planner who just opened codex is exactly the one who needs its numbers
   * now. A provider that can never answer (the session-less drivers) pays
   * for that with one no-op ask per backoff window — a resolved null, no
   * subprocess — until its first reading retires the debt.
   */
  currentAll(providers: readonly string[]): Record<string, PlanUsage> {
    const now = Date.now();
    const out: Record<string, PlanUsage> = {};
    for (const provider of providers) {
      const plan = this.planUsage[provider];
      if (!plan) {
        this.planReadingOwed.add(provider);
        this.refresh(provider);
        continue;
      }
      const fiveHour = plan.fiveHour ? refilled(plan.fiveHour, now) : null;
      const sevenDay = plan.sevenDay ? refilled(plan.sevenDay, now) : null;
      const modelWeekly = plan.modelWeekly.map((row) => refilled(row, now));
      // `refilled` hands back the same object when nothing moved, so identity
      // is the whole test for "a window reset since this reading".
      const reset =
        fiveHour !== plan.fiveHour ||
        sevenDay !== plan.sevenDay ||
        modelWeekly.some((row, index) => row !== plan.modelWeekly[index]);
      if (reset || this.planReadingOwed.has(provider)) this.refresh(provider);
      out[provider] = reset ? { ...plan, fiveHour, sevenDay, modelWeekly } : plan;
    }
    return out;
  }

  /**
   * Re-read one provider's limits, through the most recently active idle
   * session of that provider — claude falls back to a probe CLI when no
   * session is idle, because the limits are the account's and a planner who
   * has opened no thread is exactly the planner most in need of being told.
   * Failures stay silent: the cache keeps serving whatever it still has.
   * Spaced out because status() runs on every broadcast, and a CLI that
   * cannot answer must not turn those broadcasts into a request storm.
   *
   * A scoped ask (a rate-limit hit naming its account) stays scoped: with
   * none of that provider's sessions idle, the reading stays owed and the
   * next natural window tries again — silence beats the right shape of the
   * wrong answer, and the row would only caption the substitution.
   */
  refresh(provider: string): void {
    const now = Date.now();
    if (now - (this.lastPlanRefresh[provider] ?? 0) < PlanTracker.REFRESH_BACKOFF_MS) return;
    const session = this.deps.idleSession(provider);
    // The probe reads claude, so only claude may fall back to it; every other
    // provider waits for one of its own sessions to go idle.
    if (!session) {
      if (provider !== "claude") return;
      if (!this.deps.claudeExecutable()) return;
      this.lastPlanRefresh[provider] = now;
      void probePlanUsage({
        cwd: this.deps.probeCwd(),
        executable: this.deps.claudeExecutable(),
        signal: this.deps.signal,
      })
        .then((plan) => this.rememberPlanUsage(plan))
        .catch(() => undefined);
      return;
    }
    this.lastPlanRefresh[provider] = now;
    void session
      .usage()
      .then((plan) => this.rememberPlanUsage(plan))
      .catch(() => undefined);
  }

  /**
   * The last readings from disk, with every window that has since reset
   * refilled. The file holds a map keyed by provider; a cache written by an
   * older build is one provider's single reading — the only writer back then
   * spoke claude (session or probe), so it lands under `claude`, stamped
   * when the tag was missing. An entry with no window at all is not a
   * reading — it would only make the chip say nothing with confidence.
   */
  private loadPlanUsage(): Record<string, PlanUsage> {
    try {
      const stored = JSON.parse(readFileSync(planUsageFile(), "utf8")) as unknown;
      const entries = Object.entries(
        // A pre-map cache is a single reading; its own provider tag (or the
        // claude inference) names the slot it lands in.
        stored !== null &&
          typeof stored === "object" &&
          !Array.isArray(stored) &&
          !("fiveHour" in stored)
          ? (stored as Record<string, PlanUsage>)
          : { [(stored as PlanUsage).provider ?? "claude"]: stored as PlanUsage },
      );
      const now = Date.now();
      const out: Record<string, PlanUsage> = {};
      for (const [provider, raw] of entries) {
        if (!raw || typeof raw !== "object") continue;
        const fiveHour = raw.fiveHour ? refilled(raw.fiveHour, now) : null;
        const sevenDay = raw.sevenDay ? refilled(raw.sevenDay, now) : null;
        // A cache written by an older build has no `modelWeekly` at all; the
        // reading this run owes fills the rows in.
        const modelWeekly = (raw.modelWeekly ?? []).map((row) => refilled(row, now));
        const plan: PlanUsage = {
          ...raw,
          provider: raw.provider ?? provider,
          fiveHour,
          sevenDay,
          modelWeekly,
        };
        if (plan.fiveHour === null && plan.sevenDay === null && plan.modelWeekly.length === 0)
          continue;
        out[provider] = plan;
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * The model picker's rows come from the provider's CLI through a live
   * session, but the choice itself belongs to the planner before any thread
   * exists — so each provider's list is cached under its own id and kept
   * across restarts. A Claude alias and a Codex model id are different
   * vocabularies; one shared list would offer a model the session cannot run.
   */
  rememberModels(provider: string, models: SessionModelInfo[]): void {
    if (models.length === 0) return;
    if (JSON.stringify(models) === JSON.stringify(this.modelRows[provider])) return;
    this.modelRows = { ...this.modelRows, [provider]: models };
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(MODEL_CATALOG_FILE, `${JSON.stringify(this.modelRows, null, 2)}\n`);
    } catch {
      // Same as the plan cache: a failed write only costs the next start.
    }
    this.deps.onChanged();
  }

  private loadModels(): Record<string, SessionModelInfo[]> {
    try {
      const stored = JSON.parse(readFileSync(MODEL_CATALOG_FILE, "utf8")) as unknown;
      // A cache written by the single-list build is one provider's rows —
      // that provider was Claude, the only one the picker knew then.
      if (Array.isArray(stored)) return { claude: stored as SessionModelInfo[] };
      if (stored && typeof stored === "object") {
        return stored as Record<string, SessionModelInfo[]>;
      }
      return {};
    } catch {
      return {};
    }
  }
}
