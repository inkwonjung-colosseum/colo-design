import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanUsage, PlanWindow, SessionModelInfo } from "@colo-design/protocol";
import { probePlanUsage } from "./agent/drivers/claude/session.js";
import { CONFIG_DIR } from "./environment.js";
import type { Session } from "./session.js";

/** Where the last plan-limit reading waits for the next start. */
const PLAN_USAGE_FILE = join(CONFIG_DIR, "plan-usage.json");
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
  /** The most recently active idle session — a live reading rides it. */
  idleSession: () => Pick<Session, "contextUsage"> | null;
  claudeExecutable: () => string | null;
  /** Where a probe CLI runs when no session can be asked. */
  probeCwd: () => string;
  /** Aborted when the daemon stops — a probe must not outlive it. */
  signal: AbortSignal;
  /** A fresh reading changed what `status` reports — rebroadcast it. */
  onChanged: () => void;
}

/**
 * The account's plan limits and the CLI's model catalog — both belong to the
 * account, not to one thread: whatever reading lands last stands for every
 * client, so the composer can show them with no session open at all. The last
 * reading also survives a restart (each rides a file under CONFIG_DIR), and it
 * settles what the run still owes — one fresh reading per run, because the
 * cache on disk is only as complete as the build that wrote it and the
 * account's numbers move whether this daemon is running or not.
 */
export class PlanTracker {
  /** Minimum spacing between re-reads of the plan's limits. */
  private static readonly REFRESH_BACKOFF_MS = 120_000;
  /** Last time `refresh` actually asked, epoch ms. */
  private lastPlanRefresh = 0;
  /** Account-wide plan limits: last reading, restored across restarts. */
  private planUsage: PlanUsage | null;
  /**
   * One fresh reading is owed per run. The cache on disk is only as complete
   * as the build that wrote it — one from before per-model weeks carries no
   * Fable row at all — and the account's numbers move whether this daemon is
   * running or not, so the chip opens on a reading of its own rather than on
   * whatever the last turn happened to leave behind.
   */
  private planReadingOwed = true;
  /** The CLI's model rows, cached so the picker works before any thread. */
  private modelRows: SessionModelInfo[];

  constructor(private readonly deps: PlanTrackerDeps) {
    this.planUsage = this.loadPlanUsage();
    this.modelRows = this.loadModels();
  }

  /** The model picker's rows — empty until a session has reported once. */
  get models(): SessionModelInfo[] {
    return this.modelRows;
  }

  /**
   * 한도가 움직였다 (PLAN D100): 요금 칩이 2분 뒤에야 진실을 말하면,
   * 계획자는 이미 막힌 뒤에 그 사실을 안다. 다음 읽기를 앞당긴다.
   */
  noteRateLimit(): void {
    this.planReadingOwed = true;
    this.lastPlanRefresh = 0;
    this.refresh();
  }

  /**
   * Plan limits belong to the account, not to one thread: whatever reading
   * lands last stands for every client, so the composer can show them with no
   * session open at all. The last reading also survives a restart, and it
   * settles what the run still owes — one reading has now been had.
   */
  rememberPlanUsage(plan: PlanUsage | null): void {
    if (!plan) return;
    this.planReadingOwed = false;
    if (JSON.stringify(plan) === JSON.stringify(this.planUsage)) return;
    this.planUsage = plan;
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(PLAN_USAGE_FILE, `${JSON.stringify(plan, null, 2)}\n`);
    } catch {
      // A cache that cannot be written just means the next start shows nothing.
    }
    this.deps.onChanged();
  }

  /**
   * The cached reading as the composer may see it now. A window whose reset
   * has passed is refilled here, not just on load — a daemon that sits for
   * hours would otherwise keep saying 43% about a window that no longer
   * exists — and the row keeps its place either way, because a planner
   * checking whether the weekly Fable cap is near must find it there whatever
   * the answer turns out to be. A reset also asks for a fresh reading: it is
   * exactly when the number matters again, and the next turn is not the only
   * moment one can land.
   */
  current(): PlanUsage | null {
    const plan = this.planUsage;
    if (!plan) {
      this.refresh();
      return null;
    }
    const now = Date.now();
    const fiveHour = plan.fiveHour ? refilled(plan.fiveHour, now) : null;
    const sevenDay = plan.sevenDay ? refilled(plan.sevenDay, now) : null;
    const modelWeekly = plan.modelWeekly.map((row) => refilled(row, now));
    // `refilled` hands back the same object when nothing moved, so identity
    // is the whole test for "a window reset since this reading".
    const reset =
      fiveHour !== plan.fiveHour ||
      sevenDay !== plan.sevenDay ||
      modelWeekly.some((row, index) => row !== plan.modelWeekly[index]);
    if (reset || this.planReadingOwed) this.refresh();
    if (!reset) return plan;
    return { ...plan, fiveHour, sevenDay, modelWeekly };
  }

  /**
   * Re-read the plan's limits, through the most recently active idle session
   * when there is one and a probe CLI when there is not — the limits are the
   * account's, so a planner who has opened no thread is exactly the planner
   * most in need of being told. Failures stay silent: the cache keeps serving
   * whatever it still has. Spaced out because status() runs on every
   * broadcast, and a CLI that cannot answer must not turn those broadcasts
   * into a request storm.
   */
  refresh(): void {
    const now = Date.now();
    if (now - this.lastPlanRefresh < PlanTracker.REFRESH_BACKOFF_MS) return;
    const session = this.deps.idleSession();
    // Before `start` has resolved the CLI there is nothing to ask and nothing
    // to record: leave the reading owed rather than spending the window on a
    // question that cannot be put.
    if (!session && !this.deps.claudeExecutable()) return;
    this.lastPlanRefresh = now;
    this.planReadingOwed = false;
    if (session) {
      void session
        .contextUsage()
        .then((usage) => this.rememberPlanUsage(usage?.plan ?? null))
        .catch(() => undefined);
      return;
    }
    void probePlanUsage({
      cwd: this.deps.probeCwd(),
      executable: this.deps.claudeExecutable(),
      signal: this.deps.signal,
    })
      .then((plan) => this.rememberPlanUsage(plan))
      .catch(() => undefined);
  }

  /** The last reading from disk, with every window that has since reset refilled. */
  private loadPlanUsage(): PlanUsage | null {
    try {
      const stored = JSON.parse(readFileSync(PLAN_USAGE_FILE, "utf8")) as PlanUsage;
      const now = Date.now();
      const fiveHour = stored.fiveHour ? refilled(stored.fiveHour, now) : null;
      const sevenDay = stored.sevenDay ? refilled(stored.sevenDay, now) : null;
      // A cache written by an older build has no `modelWeekly` at all; the
      // reading this run owes fills the rows in.
      const modelWeekly = (stored.modelWeekly ?? []).map((row) => refilled(row, now));
      if (!fiveHour && !sevenDay) return null;
      return { ...stored, fiveHour, sevenDay, modelWeekly };
    } catch {
      return null;
    }
  }

  /**
   * The model picker's rows come from the CLI through a live session, but the
   * choice itself belongs to the planner before any thread exists — so the
   * list is cached here and kept across restarts.
   */
  rememberModels(models: SessionModelInfo[]): void {
    if (models.length === 0 || JSON.stringify(models) === JSON.stringify(this.modelRows)) return;
    this.modelRows = models;
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(MODEL_CATALOG_FILE, `${JSON.stringify(models, null, 2)}\n`);
    } catch {
      // Same as the plan cache: a failed write only costs the next start.
    }
    this.deps.onChanged();
  }

  private loadModels(): SessionModelInfo[] {
    try {
      const stored = JSON.parse(readFileSync(MODEL_CATALOG_FILE, "utf8")) as SessionModelInfo[];
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }
}
