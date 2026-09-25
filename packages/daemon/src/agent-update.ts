/**
 * 에이전트 업데이트 (PLAN-UI U12) — 새 버전을 확인하고, 설치 진행기(agent-install
 * .ts)의 같은 길로 바꿔 깐다. 확인 박자는 셋이다: 데몬이 설 때(기다리지 않음),
 * 하루에 한 번, 그리고 마지막 확인에서 한 시간이 지난 뒤의 상태 요청. 확인의
 * 실패는 로그에만 남는다 — 상태를 늦추지도, 사용자에게 말하지도 않는다.
 *
 * 설치는 **도는 작업이 없을 때만** 한다. 어느 프로젝트에서든 턴이 돌거나 답을
 * 기다리면 미뤄 두고(pending), 마지막 턴이 내려앉는 순간 깐다. 자동 설치는
 * 버전마다 한 번만 시도한다 — 시도한 버전을 machine.json 에 적어 실패하는
 * 업데이트가 한 시간마다 도는 일을 막는다.
 *
 * 버전의 출처:
 * - Codex — 설치가 읽는 GitHub releases/latest 의 `tag_name`(`rust-v0.46.0`).
 * - Claude Code — 공식 설치 스크립트(claude.ai/install.sh · install.ps1)가 맨
 *   먼저 받는 `downloads.claude.ai/claude-code-releases/latest` 의 글 한 줄
 *   (`2.1.282`). 업데이트는 스크립트에 `latest` 를 건네 같은 버전을 깐다.
 */

import type { AgentInstallKind, DaemonStatus, ServerMessage } from "@colo-design/protocol";
import { type AgentInstall, CODEX_RELEASE_API } from "./agent-install.js";
import type { DaemonNotice } from "./notices.js";
import { isNewerVersion, plainVersion } from "./versions.js";

/** 공식 설치 스크립트가 읽는 최신 버전 파일 — 몸통은 버전 한 줄이다. */
export const CLAUDE_LATEST_API = "https://downloads.claude.ai/claude-code-releases/latest";
/** 하루 한 번의 확인. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
/** 상태 요청이 확인을 다시 부르는 나이 — 마지막 확인에서 한 시간. */
export const STALE_CHECK_MS = 60 * 60_000;
/** 확인 한 번의 시간 상한 — 넘으면 그 에이전트는 이번에 모르는 채로 둔다. */
const CHECK_TIMEOUT_MS = 15_000;

export type UpdateAgent = "claude" | "codex";
const AGENTS: UpdateAgent[] = ["claude", "codex"];
type AgentUpdateMap = NonNullable<DaemonStatus["agentUpdates"]>;
export type AgentUpdateState = NonNullable<AgentUpdateMap[UpdateAgent]>;

/** machine.json 의 키 — 자동 설치가 시도한 마지막 버전. */
export function attemptedKey(agent: UpdateAgent): string {
  return `agentUpdateTried.${agent}`;
}

// ---------------------------------------------------------------------------
// 순수 함수 — 몸통 읽기와 판정
// ---------------------------------------------------------------------------

/**
 * Claude 의 `latest` 몸통 → 버전. 스크립트와 같은 잣대로 버전이 아닌 몸통
 * (HTML 오류 페이지 따위)은 거절한다.
 */
export function parseClaudeLatest(body: string): string | null {
  const text = body.trim();
  if (!/^\d+\.\d+\.\d+/.test(text)) return null;
  return plainVersion(text);
}

/** Codex releases/latest 의 JSON → 버전(`tag_name` 먼저, 없으면 `name`). */
export function parseCodexRelease(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const release = json as { tag_name?: unknown; name?: unknown };
  for (const field of [release.tag_name, release.name]) {
    if (typeof field === "string") {
      const version = plainVersion(field);
      if (version) return version;
    }
  }
  return null;
}

/**
 * 업데이트 요청의 다음 걸음 — 이미 도는 중이면 그대로, 도는 작업이 있으면
 * 미루기, 아니면 지금 깔기.
 */
export function updateStep(input: {
  busy: boolean;
  running: boolean;
}): "run" | "pending" | "already" {
  if (input.running) return "already";
  return input.busy ? "pending" : "run";
}

/**
 * 자동 설치를 걸 것인가 — 켜져 있고, 깔린 버전보다 새것이 있고, 그 버전을
 * 아직 시도하지 않았고, 이미 걸린(미뤄 둔 · 도는) 업데이트가 없을 때만.
 * 깔려 있지 않은 에이전트(current 없음)는 설치가 아니라 업데이트의 일이 아니다.
 */
export function wantsAutoUpdate(input: {
  enabled: boolean;
  current: string | null;
  latest: string | null;
  attempted: string | null;
  phase?: AgentUpdateState["phase"];
}): boolean {
  if (!input.enabled || !input.latest) return false;
  if (input.phase === "pending" || input.phase === "running") return false;
  if (input.attempted !== null && plainVersion(input.attempted) === plainVersion(input.latest)) {
    return false;
  }
  return isNewerVersion(input.latest, input.current);
}

// ---------------------------------------------------------------------------
// 확인 — 네트워크
// ---------------------------------------------------------------------------

/**
 * 한 에이전트의 최신 버전. 주소는 환경 변수로 갈아 끼운다(시험용):
 * `COLO_DESIGN_CLAUDE_LATEST_API` · `COLO_DESIGN_CODEX_RELEASE_API`(설치와 공유).
 * 실패는 던진다 — 부르는 쪽이 로그에 남긴다.
 */
export async function fetchLatestVersion(
  agent: UpdateAgent,
  deps: { env?: NodeJS.ProcessEnv; fetchLike?: typeof fetch } = {},
): Promise<string | null> {
  const env = deps.env ?? process.env;
  const fetchLike = deps.fetchLike ?? fetch;
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  if (agent === "claude") {
    const response = await fetchLike(env.COLO_DESIGN_CLAUDE_LATEST_API ?? CLAUDE_LATEST_API, {
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseClaudeLatest(await response.text());
  }
  const response = await fetchLike(env.COLO_DESIGN_CODEX_RELEASE_API ?? CODEX_RELEASE_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "colo-design" },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseCodexRelease(await response.json());
}

// ---------------------------------------------------------------------------
// 업데이트 담당
// ---------------------------------------------------------------------------

export interface AgentUpdatesDeps {
  installer: Pick<AgentInstall, "start" | "isRunning">;
  /** 어느 프로젝트에서든 턴이 돌거나 답을 기다리는가 — SessionManager.anyBusy. */
  busy(): boolean;
  setting: { get(key: string): string | null; set(key: string, value: string | null): void };
  /** 지금 깔린 버전 — 드라이버의 진단이 읽은 CLI 의 버전 글. */
  currentVersion(agent: UpdateAgent): Promise<string | null>;
  /** Claude 업데이트가 성공 판정에 쓴 경로를 데몬에 심는다 — 다음 새 대화가 새 CLI 를 쓴다. */
  adoptClaudeExecutable(path: string): void;
  /** 설치 진행기의 방송 — onboarding.install.progress · done. */
  broadcast(message: ServerMessage): void;
  /** 상태를 다시 보낸다. */
  announce(): void;
  notice(notice: DaemonNotice): void;
  log?(message: string, fields?: Record<string, unknown>): void;
  /** 시험 구멍 — 없으면 fetchLatestVersion. */
  fetchLatest?(agent: UpdateAgent): Promise<string | null>;
  now?(): number;
}

export class AgentUpdates {
  private readonly latestByAgent: Partial<Record<UpdateAgent, string>> = {};
  private readonly states: Partial<Record<UpdateAgent, AgentUpdateState>> = {};
  private lastCheckAt: number | null = null;
  private checking: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: AgentUpdatesDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  /** 확인해 둔 최신 버전 — 모르면 undefined(상태의 키가 빠진다). */
  latest(agent: string): string | undefined {
    return agent === "claude" || agent === "codex" ? this.latestByAgent[agent] : undefined;
  }

  /** 상태에 실을 업데이트의 지금 — 이 실행에서 아무 일도 없었으면 undefined. */
  snapshot(): DaemonStatus["agentUpdates"] {
    const entries = AGENTS.flatMap((agent) => {
      const state = this.states[agent];
      return state ? [[agent, { ...state }] as const] : [];
    });
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  /** 데몬이 설 때 — 첫 확인은 기다리지 않고, 그 뒤로 하루에 한 번. */
  start(): void {
    void this.check();
    this.timer ??= setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 상태 요청의 곁가지 — 마지막 확인에서 한 시간이 지났으면 뒤에서 다시 본다. */
  maybeCheck(): void {
    if (this.checking) return;
    if (this.lastCheckAt !== null && this.now() - this.lastCheckAt < STALE_CHECK_MS) return;
    void this.check();
  }

  /**
   * 두 에이전트의 최신 버전을 읽고, 자동 설치를 판정한다. 도는 확인이 있으면
   * 그것을 함께 기다린다. 버전이 바뀌었거나 업데이트가 걸렸을 때만 방송한다.
   */
  check(): Promise<void> {
    if (this.checking) return this.checking;
    this.lastCheckAt = this.now();
    this.checking = (async () => {
      let changed = false;
      for (const agent of AGENTS) {
        try {
          const latest = await (this.deps.fetchLatest ?? fetchLatestVersion)(agent);
          if (latest && latest !== this.latestByAgent[agent]) {
            this.latestByAgent[agent] = latest;
            changed = true;
          }
        } catch (error) {
          this.deps.log?.("에이전트 새 버전 확인 실패", { agent, error: String(error) });
        }
      }
      const scheduled = await this.applyAuto({ announce: false });
      if (changed || scheduled) this.deps.announce();
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /**
   * 자동 설치의 판정만 — 확인이 끝났을 때와 토글이 켜졌을 때. 건 것이 있으면 참.
   */
  async applyAuto(opts: { announce?: boolean } = {}): Promise<boolean> {
    const enabled = this.deps.setting.get("agentAutoUpdate") !== "off";
    if (!enabled) return false;
    let scheduled = false;
    for (const agent of AGENTS) {
      const latest = this.latestByAgent[agent] ?? null;
      if (!latest) continue;
      const current = await this.deps.currentVersion(agent).catch(() => null);
      const wanted = wantsAutoUpdate({
        enabled,
        current,
        latest,
        attempted: this.deps.setting.get(attemptedKey(agent)),
        ...(this.states[agent] ? { phase: this.states[agent].phase } : {}),
      });
      if (!wanted) continue;
      // 시도를 먼저 적는다 — 설치가 도중에 죽어도 같은 버전을 다시 돌지 않게.
      this.deps.setting.set(attemptedKey(agent), latest);
      this.deps.log?.("에이전트 자동 업데이트", { agent, from: current, to: latest });
      this.request(agent, { announce: false });
      scheduled = true;
    }
    if (scheduled && opts.announce !== false) this.deps.announce();
    return scheduled;
  }

  /**
   * 업데이트 요청 — 도는 작업이 있으면 미루고, 없으면 지금 깐다. 돌려주는 것은
   * 요청 뒤의 단계다.
   */
  request(agent: UpdateAgent, opts: { announce?: boolean } = {}): AgentUpdateState["phase"] {
    const kind: AgentInstallKind = `update-${agent}`;
    const step = updateStep({
      busy: this.deps.busy(),
      running: this.deps.installer.isRunning(kind) || this.states[agent]?.phase === "running",
    });
    if (step === "already") return "running";
    if (step === "pending") {
      if (this.states[agent]?.phase !== "pending") {
        this.states[agent] = { phase: "pending", at: this.stamp() };
        if (opts.announce !== false) this.deps.announce();
      }
      return "pending";
    }
    this.run(agent, kind, opts.announce !== false);
    return this.states[agent]?.phase ?? "running";
  }

  /**
   * 턴이 내려앉을 때마다 — 미뤄 둔 업데이트가 있고 이제 도는 작업이 없으면 깐다.
   * 서버의 세션 상태 갈고리가 부른다.
   */
  settle(): void {
    for (const agent of AGENTS) {
      if (this.states[agent]?.phase !== "pending") continue;
      if (this.deps.busy()) return;
      this.run(agent, `update-${agent}`, true);
    }
  }

  private run(agent: UpdateAgent, kind: AgentInstallKind, announce: boolean): void {
    const started = this.deps.installer.start(kind, {
      onProgress: (line) =>
        this.deps.broadcast({ type: "onboarding.install.progress", kind, line }),
      onDone: (ok, detail, executable) => void this.finish(agent, kind, ok, detail, executable),
    });
    if (!started.started) return;
    this.states[agent] = { phase: "running", at: this.stamp() };
    if (announce) this.deps.announce();
  }

  private async finish(
    agent: UpdateAgent,
    kind: AgentInstallKind,
    ok: boolean,
    detail: string,
    executable?: string | null,
  ): Promise<void> {
    // 방송 전에 먼저: 성공 판정에 쓴 경로를 심어야 다음 새 대화와 이 뒤의 버전
    // 읽기가 방금 깐 CLI 를 본다(설치의 install-claude 와 같은 순서).
    if (ok && agent === "claude" && executable) this.deps.adoptClaudeExecutable(executable);
    let version: string | undefined;
    if (ok) {
      const current = await this.deps.currentVersion(agent).catch(() => null);
      version = plainVersion(current) ?? this.latestByAgent[agent];
    }
    this.states[agent] = ok
      ? { phase: "done", at: this.stamp(), ...(version ? { version } : {}) }
      : { phase: "failed", at: this.stamp(), detail };
    this.deps.broadcast({ type: "onboarding.install.done", kind, ok, detail });
    this.deps.announce();
    if (ok) this.deps.notice({ kind: "update-done", agent, version: version ?? "" });
  }
}
