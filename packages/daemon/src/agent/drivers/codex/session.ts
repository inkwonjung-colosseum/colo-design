import type {
  ContextUsage,
  EffortLevel,
  PlanUsage,
  SessionCommand,
  SessionModelInfo,
} from "@colo-design/protocol";
import { BROWSER_MCP_SERVER_NAME, codexBrowserMcpServer } from "../../../browser-launch.js";
import { ensureGitGuardHooks, gitGuardEnv } from "../../../git-guard.js";
import { composeTurnText, prepareAttachments } from "../../attachments.js";
import type {
  AgentSession,
  DriverHooks,
  LaunchConfig,
  PermissionVerdict,
  ToolClass,
  Turn,
} from "../../driver.js";
import { JsonRpcTransport } from "../../jsonrpc.js";

/** The app-server wire shapes this driver reads — kept loose, the spec evolves. */
type Wire = Record<string, any>;

/** The composer's effort enum — codex names more levels than we offer. */
const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * 이 도구의 유일한 확인 방식 — 바로 진행 (2026-09-23). Codex splits the
 * decision two ways: `approvalPolicy` (does the agent ask?) and `sandbox`
 * (what may it touch). 바로 진행은 `never` + `danger-full-access` — 묻는
 * 카드 없이, 샌드박스 없이. Both are per-turn params, so the pin rides every
 * `thread/*` and `turn/start`.
 */
const BYPASS_APPROVAL_POLICY = "never";
const BYPASS_SANDBOX = "danger-full-access";

/** `thread/*` takes a SandboxMode string; `turn/start` takes the full policy. */
function bypassSandboxPolicy(): Wire {
  return { type: "dangerFullAccess" };
}

/**
 * The `account/rateLimits/read` answer as the protocol's plan reading. Codex
 * names its own windows, so the buckets are classified by duration: ≤12h is
 * the short window, longer is weekly, and every extra metered limit lands in
 * modelWeekly under its own name — or, when the server names nothing, under
 * the period the window actually runs on ("이번 달" for the free plan's
 * monthly budget). Pure, and exported for the mapper test — this
 * classification is the only bridge between the app-server's answer and the
 * chip's rows, so it is tested without an app-server in the way.
 */
export function toPlanUsage(result: Wire): PlanUsage {
  const snapshots: Wire[] = [];
  if (result?.rateLimits) snapshots.push(result.rateLimits as Wire);
  const byId = result?.rateLimitsByLimitId as Wire | null | undefined;
  if (byId) {
    for (const [key, snapshot] of Object.entries(byId)) {
      if (key !== (result.rateLimits as Wire)?.limitId) snapshots.push(snapshot as Wire);
    }
  }
  const plan: PlanUsage = {
    provider: "codex",
    subscriptionType: null,
    fiveHour: null,
    sevenDay: null,
    modelWeekly: [],
  };
  for (const snapshot of snapshots) {
    // The first snapshot is the plan's own budget row; the rest are metered
    // extras that may carry their own names.
    const isPrimary = snapshot === result?.rateLimits;
    if (typeof snapshot?.planType === "string" && !plan.subscriptionType) {
      plan.subscriptionType = snapshot.planType;
    }
    const windows: Array<{ window: Wire; label: string | null }> = [];
    if (snapshot?.primary) {
      windows.push({ window: snapshot.primary as Wire, label: null });
    }
    if (snapshot?.secondary) {
      windows.push({ window: snapshot.secondary as Wire, label: null });
    }
    for (const { window } of windows) {
      const mapped = {
        utilization: typeof window.usedPercent === "number" ? window.usedPercent : null,
        resetsAt:
          typeof window.resetsAt === "number"
            ? new Date(window.resetsAt * 1000).toISOString()
            : null,
      };
      const mins = Number(window.windowDurationMins ?? 0);
      if (mins > 0 && mins <= 720 && !plan.fiveHour) {
        plan.fiveHour = mapped;
      } else if (mins > 0 && mins <= 11000 && !plan.sevenDay) {
        plan.sevenDay = mapped;
      } else {
        // The server names metered extras itself; an unnamed long window is
        // the plan's own budget, so the row spells its period — "이번 달" for
        // the free plan's monthly window, not the weekly word the chip used
        // to append to every row. The primary snapshot's limitId is the
        // provider's own id ("codex"), which the account line already says.
        const named = isPrimary ? snapshot?.limitName : (snapshot?.limitName ?? snapshot?.limitId);
        plan.modelWeekly.push({
          ...mapped,
          label:
            named != null
              ? String(named)
              : mins >= 28 * 1440
                ? "이번 달"
                : mins > 0
                  ? `${Math.round(mins / 1440)}일`
                  : "limit",
        });
      }
    }
  }
  return plan;
}

/**
 * An AgentSession over Codex's `app-server` JSON-RPC protocol: one child
 * process per session, stdio framing. The handshake is async, so calls made
 * before `thread/start` (or resume/fork) resolves queue behind `ready` — the
 * core session is synchronous and must never see the gap.
 *
 * Turn model: `turn/start` resolves on acceptance; the turn's end is the
 * `turn/completed` notification. `turn/steer` carries mid-turn input (it
 * needs the live turn id as a precondition), `turn/interrupt` stops it.
 * Approvals arrive as server→client requests and are answered through
 * `hooks.decidePermission`.
 */
export class CodexAgentSession implements AgentSession {
  private readonly transport: JsonRpcTransport;
  private readonly ready: Promise<void>;
  private threadId: string | null = null;
  private closed = false;
  /** 세션 수명의 승인 신호 — 전송이 죽으면 기다리던 카드도 함께 끊긴다(acp 와 같은 모양). */
  private readonly abort = new AbortController();
  private turnStartedAt = 0;
  /** The turn the server says is in progress — interrupt's target. */
  private activeTurnId: string | null = null;
  /** Resolves when the in-flight `turn/start`'s turn completes. */
  private turnDone: Promise<void> | null = null;
  private markTurnDone: (() => void) | null = null;
  /**
   * Resolves once the in-flight `turn/start` has answered — interrupt must
   * not read `activeTurnId` while the server is still naming the turn. The
   * core fires `send()` without awaiting it, so that window is reachable.
   */
  private turnAccepted: Promise<void> | null = null;
  private markTurnAccepted: (() => void) | null = null;
  /** interrupt() waiters — resolved "answered" on turn/completed, "dead" on end. */
  private readonly turnSettlers = new Set<(outcome: "answered" | "dead") => void>();
  private currentModel: string | null;
  private currentEffort: EffortLevel | null;
  private lastContext: { used: number; size: number } | null = null;
  /** Items whose deltas already streamed — completed items don't re-emit. */
  private readonly streamedItems = new Set<string>();
  private readonly launch: LaunchConfig;
  /** One `turn/start` at a time — concurrent sends would clobber the slots. */
  private sendChain: Promise<void> = Promise.resolve();

  get alive(): boolean {
    return !this.closed && this.transport.alive;
  }

  constructor(
    command: string,
    launch: LaunchConfig,
    private readonly hooks: DriverHooks,
  ) {
    this.launch = launch;
    this.currentModel = launch.model;
    this.currentEffort = launch.effort;
    this.transport = new JsonRpcTransport(
      command,
      ["app-server"],
      launch.cwd,
      {
        onRequest: (method, params) => this.onAgentRequest(method, params),
        onNotify: (method, params) => this.onAgentNotify(method, params),
        onEnd: (code) => this.onTransportEnd(code),
      },
      // git 수준 가드 (PLAN L5): BYPASS_APPROVAL_POLICY 라 권한을 묻는 길이
      // 없으므로, 참조를 바꾸는 git 은 core.hooksPath 의 훅이 거절한다.
      gitGuardEnv({ ...process.env }, ensureGitGuardHooks()),
    );
    const handshake = this.handshake();
    // 핸드셰이크 거절(initialize·thread/* 타임아웃)은 자식을 죽이지 않는다 —
    // 그대로 두면 좀비 프로세스 위에서 alive 가 참으로 남아 코어가 크래시로
    // 표시하지 못하고 부활 경로도 영원히 못 탄다. 전송을 끊고 거절을 전송
    // 오류로 올려 크래시 기계가 닫게 한다. ready 자체는 원래 거절을 유지해
    // 뒤에 선 await 가 같은 사유를 받게 한다.
    handshake.catch((error) => {
      if (this.closed) return;
      this.closed = true;
      this.abort.abort();
      this.transport.close();
      this.hooks.onTransportError(error instanceof Error ? error.message : String(error));
    });
    this.ready = handshake;
  }

  // -------------------------------------------------------------------------
  // Handshake — initialize, then start/resume/fork the thread.
  // -------------------------------------------------------------------------

  private async handshake(): Promise<void> {
    await this.transport.request(
      "initialize",
      {
        clientInfo: { name: "colo-design", title: null, version: "0" },
        capabilities: {
          // steer, item/* approvals and skills/list live behind this flag.
          experimentalApi: true,
          requestAttestation: false,
        },
      },
      15_000,
    );
    this.transport.notify("initialized");

    const resumeId = typeof this.launch.resume === "string" ? this.launch.resume : null;
    const fork = this.launch.forkSession === true;
    const cut =
      typeof this.launch.resumeSessionAt === "string" ? this.launch.resumeSessionAt : null;
    const overrides = this.threadOverrides();

    let response: Wire;
    if (resumeId && fork && cut) {
      // D95 truncating fork: keep the source thread through `cut`, drop the
      // rest, continue as a fresh thread id.
      response = (await this.transport.request(
        "thread/fork",
        {
          threadId: resumeId,
          lastTurnId: cut,
          ...overrides,
        },
        30_000,
      )) as Wire;
    } else if (resumeId && !fork) {
      response = (await this.transport.request(
        "thread/resume",
        {
          threadId: resumeId,
          ...overrides,
        },
        30_000,
      )) as Wire;
    } else {
      // fork without a cut means "keep nothing" — a fresh thread IS that fork.
      response = (await this.transport.request(
        "thread/start",
        {
          cwd: this.launch.cwd,
          ...overrides,
        },
        30_000,
      )) as Wire;
    }

    const thread = (response?.thread ?? {}) as Wire;
    this.threadId = String(thread.id ?? resumeId ?? this.launch.sessionId);
    this.currentModel = String(response?.model ?? this.launch.model ?? "default");

    this.hooks.onEvent({
      kind: "init",
      sessionId: this.threadId,
      model: this.currentModel,
      cwd: this.launch.cwd,
      tools: [],
      apiKeySource: "none",
    });
  }

  /**
   * The per-thread overrides every thread/* call carries. 브라우저 도구
   * (3단계): host가 팩토리를 주입한 세션만 config.mcp_servers에 stdio 서버
   * 하나를 실는다 — 스레드가 start·resume·fork 어느 길로 열리든 그 프로세스가
   * MCP 자식을 함께 기동해야 하므로 예외는 없다.
   */
  private threadOverrides(): Wire {
    const browser = this.launch.browserMcp;
    return {
      ...(this.launch.model ? { model: this.launch.model } : {}),
      approvalPolicy: BYPASS_APPROVAL_POLICY,
      sandbox: BYPASS_SANDBOX,
      ...(this.launch.appendSystemPrompt
        ? { developerInstructions: this.launch.appendSystemPrompt }
        : {}),
      ...(browser
        ? {
            config: {
              mcp_servers: { [BROWSER_MCP_SERVER_NAME]: codexBrowserMcpServer(browser) },
            },
          }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // AgentSession
  // -------------------------------------------------------------------------

  async send(turn: Turn): Promise<void> {
    const run = this.sendChain.then(() => this.doSend(turn));
    this.sendChain = run.catch(() => undefined);
    return run;
  }

  private async doSend(turn: Turn): Promise<void> {
    await this.ready;
    if (this.closed || !this.transport.alive) throw new Error("Codex transport closed");
    const threadId = this.threadId;
    if (!threadId) throw new Error("Codex thread not established");

    this.turnStartedAt = Date.now();
    this.turnDone = new Promise<void>((resolve) => {
      this.markTurnDone = resolve;
    });
    this.turnAccepted = new Promise<void>((resolve) => {
      this.markTurnAccepted = resolve;
    });
    try {
      let result: Wire;
      try {
        result = (await this.transport.request(
          "turn/start",
          this.turnStartParams(threadId, turn),
        )) as Wire;
        // The acceptance answer names the turn before turn/started lands.
        this.activeTurnId = String(result?.turn?.id ?? "") || this.activeTurnId;
      } finally {
        // Open the gate even on rejection — a waiting interrupt must not hang.
        this.markTurnAccepted?.();
        this.markTurnAccepted = null;
      }
      await this.turnDone;
    } catch (error) {
      if (this.closed) return;
      this.hooks.onEvent({
        kind: "turn.end",
        subtype: "error_during_execution",
        isError: true,
        costUsd: null,
        numTurns: null,
        durationMs: Date.now() - this.turnStartedAt,
        resultText: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.turnDone = null;
      this.markTurnDone = null;
      this.turnAccepted = null;
    }
  }

  /**
   * `turn/start`'s params. Mode, model and effort are per-turn overrides, so
   * this is where a stored pick becomes real.
   */
  private turnStartParams(threadId: string, turn: Turn): Wire {
    return {
      threadId,
      input: this.userInput(turn),
      approvalPolicy: BYPASS_APPROVAL_POLICY,
      sandboxPolicy: bypassSandboxPolicy(),
      ...(this.currentModel ? { model: this.currentModel } : {}),
      ...(this.currentEffort ? { effort: this.currentEffort } : {}),
    };
  }

  async interrupt(): Promise<"answered" | "timeout" | "dead"> {
    await this.ready.catch(() => undefined);
    if (!this.alive) return "dead";
    // A send in flight is still naming its turn — wait for the answer, but
    // bounded: turn/start carries no timeout, so an app-server that never
    // answers would park the stop button forever (아래 settle race 와 같은
    // 10초).
    if (this.turnAccepted) {
      await Promise.race([
        this.turnAccepted,
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
    const threadId = this.threadId;
    const turnId = this.activeTurnId;
    if (!threadId || !turnId) return "answered";
    try {
      await this.transport.request("turn/interrupt", { threadId, turnId }, 10_000);
    } catch {
      // The turn may have completed as the request flew — that IS the answer.
      if (!this.alive) return "dead";
      if (!this.activeTurnId) return "answered";
    }
    if (!this.activeTurnId) return "answered";
    let settle: (outcome: "answered" | "dead") => void = () => undefined;
    const settled = new Promise<"answered" | "dead">((resolve) => {
      settle = resolve;
      this.turnSettlers.add(resolve);
    });
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 10_000),
    );
    try {
      return await Promise.race([settled, timeout]);
    } finally {
      this.turnSettlers.delete(settle);
    }
  }

  /**
   * 바로 실어 보내기 — `turn/steer` carries mid-turn input into the turn
   * now running (experimentalApi). Resolves when the server accepts the
   * input; the turn's own completion still lands through `turn/completed`,
   * so nothing here touches the turn bookkeeping `send` owns.
   */
  async steer(turn: Turn): Promise<void> {
    await this.ready;
    if (this.closed || !this.transport.alive) throw new Error("Codex transport closed");
    const threadId = this.threadId;
    if (!threadId) throw new Error("Codex thread not established");
    // A send in flight is still naming its turn — the same bounded wait
    // interrupt takes, so a steer never reads a turn id the server dropped.
    if (this.turnAccepted) {
      await Promise.race([
        this.turnAccepted,
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("steer: no live turn");
    await this.transport.request(
      "turn/steer",
      { threadId, turnId, input: this.userInput(turn) },
      10_000,
    );
  }

  async setModel(id: string | null): Promise<void> {
    await this.ready;
    this.currentModel = id;
  }

  async setEffort(effort: EffortLevel | null): Promise<void> {
    await this.ready;
    this.currentEffort = effort;
  }

  async commands(): Promise<SessionCommand[]> {
    await this.ready;
    try {
      const result = (await this.transport.request(
        "skills/list",
        {
          cwds: [this.launch.cwd],
        },
        10_000,
      )) as Wire;
      const entries = Array.isArray(result?.data) ? (result.data as Wire[]) : [];
      return entries.flatMap((entry) =>
        (Array.isArray(entry?.skills) ? (entry.skills as Wire[]) : [])
          .filter((skill) => skill?.enabled !== false)
          .map((skill) => ({
            name: String(skill.name ?? ""),
            description: String(skill.description ?? skill.shortDescription ?? ""),
            argumentHint: "",
            aliases: [],
          })),
      );
    } catch {
      return [];
    }
  }

  async models(): Promise<SessionModelInfo[]> {
    await this.ready;
    try {
      const rows: Wire[] = [];
      let cursor: string | null = null;
      do {
        const page = (await this.transport.request(
          "model/list",
          {
            ...(cursor ? { cursor } : {}),
          },
          10_000,
        )) as Wire;
        rows.push(...(Array.isArray(page?.data) ? (page.data as Wire[]) : []));
        cursor = typeof page?.nextCursor === "string" ? page.nextCursor : null;
      } while (cursor);
      return rows.map((m) => {
        const efforts = (
          Array.isArray(m.supportedReasoningEfforts)
            ? (m.supportedReasoningEfforts as Wire[]).map((o) => String(o?.reasoningEffort ?? ""))
            : []
        ).filter((e) => EFFORT_LEVELS.includes(e)) as EffortLevel[];
        return {
          value: String(m.id ?? m.model ?? ""),
          displayName: String(m.displayName ?? m.id ?? ""),
          resolvedModel: String(m.model ?? m.id ?? "") || null,
          description: String(m.description ?? ""),
          supportsEffort: efforts.length > 0,
          supportedEffortLevels: efforts,
          supportsFastMode: false,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * `account/rateLimits/read` — the window classification lives in the pure
   * `toPlanUsage` above; this only asks and maps.
   */
  async usage(): Promise<PlanUsage | null> {
    await this.ready;
    try {
      return toPlanUsage(
        (await this.transport.request("account/rateLimits/read", undefined, 10_000)) as Wire,
      );
    } catch {
      return null;
    }
  }

  /** The token ring rides `thread/tokenUsage/updated` — free, no extra call. */
  async contextUsage(): Promise<ContextUsage | null> {
    await this.ready;
    if (!this.lastContext) return null;
    const { used, size } = this.lastContext;
    return {
      totalTokens: used,
      maxTokens: size,
      percentage: size > 0 ? Math.min(100, Math.round((used / size) * 100)) : 0,
      sessionCostUsd: null,
      model: this.currentModel ?? "",
      // The plan reading rides along, claude-parity (one extra account read
      // per settle, and only for a thread that has answered at least once —
      // the guard above is what keeps a fresh thread from asking).
      plan: await this.usage(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  // -------------------------------------------------------------------------
  // Server → client requests — approvals go through the core's policy.
  // -------------------------------------------------------------------------

  private async onAgentRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Wire;
    switch (method) {
      case "item/commandExecution/requestApproval":
        return await this.approveCommandExecution(p);
      case "item/fileChange/requestApproval":
        return await this.approveFileChange(p);
      case "item/permissions/requestApproval":
        return await this.approvePermissions(p);
      case "execCommandApproval":
        return await this.approveExecLegacy(p);
      case "applyPatchApproval":
        return await this.approvePatchLegacy(p);
      default:
        // item/tool/call, item/tool/requestUserInput, mcpServer/elicitation/*,
        // attestation/generate, account/chatgptAuthTokens/refresh — no client
        // surface for these; an error beats a hang.
        throw new Error(`Unsupported client method: ${method}`);
    }
  }

  private async decide(
    tool: ToolClass,
    input: Record<string, unknown>,
  ): Promise<PermissionVerdict> {
    return await this.hooks.decidePermission(tool, input, {
      signal: this.abort.signal,
    });
  }

  private async approveCommandExecution(p: Wire): Promise<unknown> {
    const command = String(p.command ?? "");
    const verdict = await this.decide(
      {
        kind: "exec",
        name: "commandExecution",
        command,
        ...(p.cwd ? { paths: [String(p.cwd)] } : {}),
      },
      {
        command,
        cwd: p.cwd ?? null,
        reason: p.reason ?? null,
        kind: p.kind ?? "command",
      },
    );
    if (verdict.behavior === "deny") return { decision: "decline" };
    // 항상 허용 echoes through updatedPermissions — its presence is the
    // signal that the planner picked the durable answer.
    return { decision: verdict.updatedPermissions !== undefined ? "acceptForSession" : "accept" };
  }

  private async approveFileChange(p: Wire): Promise<unknown> {
    const verdict = await this.decide(
      {
        kind: "edit",
        name: "fileChange",
        ...(p.grantRoot ? { paths: [String(p.grantRoot)] } : {}),
      },
      { reason: p.reason ?? null, grantRoot: p.grantRoot ?? null },
    );
    if (verdict.behavior === "deny") return { decision: "decline" };
    return { decision: verdict.updatedPermissions !== undefined ? "acceptForSession" : "accept" };
  }

  private async approvePermissions(p: Wire): Promise<unknown> {
    const requested = (p.permissions ?? {}) as Wire;
    const fs = (requested.fileSystem ?? {}) as Wire;
    const paths = [...(fs.read ?? []), ...(fs.write ?? [])].map(String);
    const verdict = await this.decide(
      { kind: "other", name: "permissions", paths },
      {
        reason: p.reason ?? null,
        permissions: requested,
      },
    );
    if (verdict.behavior === "deny") {
      // Granting nothing is the decline shape this request understands.
      return { permissions: {}, scope: "turn" };
    }
    return {
      permissions: {
        ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
        ...(requested.network ? { network: requested.network } : {}),
      },
      scope: verdict.updatedPermissions !== undefined ? "session" : "turn",
    };
  }

  /** Legacy `execCommandApproval` — the ReviewDecision vocabulary. */
  private async approveExecLegacy(p: Wire): Promise<unknown> {
    const command = Array.isArray(p.command) ? (p.command as unknown[]).join(" ") : "";
    const verdict = await this.decide(
      {
        kind: "exec",
        name: "execCommand",
        command,
        ...(p.cwd ? { paths: [String(p.cwd)] } : {}),
      },
      { command, cwd: p.cwd ?? null, reason: p.reason ?? null },
    );
    if (verdict.behavior === "deny") {
      return { decision: { denied: { rejection: verdict.message } } };
    }
    return {
      decision: verdict.updatedPermissions !== undefined ? "approved_for_session" : "approved",
    };
  }

  /** Legacy `applyPatchApproval` — fileChanges is a path→change map. */
  private async approvePatchLegacy(p: Wire): Promise<unknown> {
    const changes = (p.fileChanges ?? {}) as Wire;
    const verdict = await this.decide(
      { kind: "edit", name: "applyPatch", paths: Object.keys(changes) },
      { fileChanges: changes, reason: p.reason ?? null, grantRoot: p.grantRoot ?? null },
    );
    if (verdict.behavior === "deny") {
      return { decision: { denied: { rejection: verdict.message } } };
    }
    return {
      decision: verdict.updatedPermissions !== undefined ? "approved_for_session" : "approved",
    };
  }

  // -------------------------------------------------------------------------
  // Server → client notifications — the event tape.
  // -------------------------------------------------------------------------

  private onAgentNotify(method: string, params: unknown): void {
    const p = (params ?? {}) as Wire;
    switch (method) {
      case "turn/started":
        this.activeTurnId = String(p.turn?.id ?? this.activeTurnId ?? "");
        this.turnStartedAt = Date.now();
        break;
      case "turn/completed":
        this.onTurnCompleted(p);
        break;
      case "item/started":
        this.onItemStarted(p.item as Wire | undefined);
        break;
      case "item/completed":
        this.onItemCompleted(p.item as Wire | undefined);
        break;
      case "item/agentMessage/delta":
        this.onDelta(p, "text.delta");
        break;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/plan/delta":
        this.onDelta(p, "thinking.delta");
        break;
      case "error":
        this.onError(p);
        break;
      case "thread/tokenUsage/updated": {
        const usage = (p.tokenUsage ?? {}) as Wire;
        const last = (usage.last ?? usage.total ?? {}) as Wire;
        this.lastContext = {
          used: Number(last.totalTokens ?? 0),
          size: Number(usage.modelContextWindow ?? 0),
        };
        break;
      }
      case "account/rateLimits/updated": {
        const primary = (p.rateLimits?.primary ?? null) as Wire | null;
        this.hooks.onEvent({
          kind: "ratelimit",
          status: String(p.rateLimits?.rateLimitReachedType ?? "updated"),
          resetsAt: typeof primary?.resetsAt === "number" ? primary.resetsAt * 1000 : null,
        });
        break;
      }
      case "thread/compacted":
        this.hooks.onEvent({ kind: "compact", trigger: "auto" });
        break;
      default:
        break;
    }
  }

  private onDelta(p: Wire, kind: "text.delta" | "thinking.delta"): void {
    const itemId = String(p.itemId ?? "main");
    const text = String(p.delta ?? "");
    if (!text) return;
    this.streamedItems.add(itemId);
    this.hooks.onEvent({ kind, blockId: itemId, text, agentId: null });
  }

  private onItemStarted(item: Wire | undefined): void {
    if (!item) return;
    const id = String(item.id ?? "");
    if (!id) return;
    switch (item.type) {
      case "commandExecution":
        this.hooks.onEvent({
          kind: "tool.start",
          toolUseId: id,
          name: "commandExecution",
          input: { command: item.command ?? "", cwd: item.cwd ?? null },
          agentId: null,
        });
        break;
      case "fileChange":
        this.hooks.onEvent({
          kind: "tool.start",
          toolUseId: id,
          name: "fileChange",
          input: { changes: item.changes ?? [] },
          agentId: null,
        });
        break;
      case "mcpToolCall":
        this.hooks.onEvent({
          kind: "tool.start",
          toolUseId: id,
          name: `${item.server ?? "mcp"}/${item.tool ?? "tool"}`,
          input: item.arguments ?? {},
          agentId: null,
        });
        break;
      case "dynamicToolCall":
        this.hooks.onEvent({
          kind: "tool.start",
          toolUseId: id,
          name: String(item.tool ?? "tool"),
          input: item.arguments ?? {},
          agentId: null,
        });
        break;
      case "collabAgentToolCall":
        this.hooks.onEvent({
          kind: "tool.start",
          toolUseId: id,
          name: String(item.tool ?? "collab"),
          input: { prompt: item.prompt ?? null, model: item.model ?? null },
          agentId: null,
        });
        break;
      case "webSearch":
        this.hooks.onEvent({
          kind: "tool.start",
          toolUseId: id || `web-${this.turnStartedAt}`,
          name: "webSearch",
          input: { query: item.query ?? item.action?.query ?? null },
          agentId: null,
        });
        break;
      default:
        break;
    }
  }

  private onItemCompleted(item: Wire | undefined): void {
    if (!item) return;
    const id = String(item.id ?? "");
    switch (item.type) {
      case "commandExecution": {
        const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
        this.hooks.onEvent({
          kind: "tool.end",
          toolUseId: id,
          isError: item.status === "failed" || item.status === "declined" || (exitCode ?? 0) !== 0,
          content: item.aggregatedOutput ?? null,
          agentId: null,
        });
        break;
      }
      case "fileChange":
        this.hooks.onEvent({
          kind: "tool.end",
          toolUseId: id,
          isError: item.status === "failed" || item.status === "declined",
          content: item.changes ?? null,
          agentId: null,
        });
        break;
      case "mcpToolCall":
        this.hooks.onEvent({
          kind: "tool.end",
          toolUseId: id,
          isError: item.status === "failed" || item.error != null,
          content: item.error ?? item.result ?? null,
          agentId: null,
        });
        break;
      case "dynamicToolCall":
        this.hooks.onEvent({
          kind: "tool.end",
          toolUseId: id,
          isError: item.status === "failed" || item.success === false,
          content: item.contentItems ?? null,
          agentId: null,
        });
        break;
      case "collabAgentToolCall":
        this.hooks.onEvent({
          kind: "tool.end",
          toolUseId: id,
          isError: item.status === "failed",
          content: item.agentsStates ?? null,
          agentId: null,
        });
        break;
      case "webSearch":
        this.hooks.onEvent({
          kind: "tool.end",
          toolUseId: id || `web-${this.turnStartedAt}`,
          isError: false,
          content: item.action ?? null,
          agentId: null,
        });
        break;
      case "agentMessage":
        // Deltas streamed the text live; text.done closes the block.
        if (typeof item.text === "string" && item.text) {
          this.hooks.onEvent({ kind: "text.done", blockId: id, text: item.text, agentId: null });
        }
        break;
      case "plan":
      case "reasoning": {
        // Only emit when no delta stream covered this item — otherwise the
        // tape would carry the same words twice.
        if (this.streamedItems.has(id)) break;
        const text =
          item.type === "plan"
            ? String(item.text ?? "")
            : [...(item.summary ?? []), ...(item.content ?? [])]
                .map((part) => String(part?.text ?? ""))
                .filter(Boolean)
                .join("\n");
        if (text) {
          this.hooks.onEvent({ kind: "thinking.delta", blockId: id, text, agentId: null });
        }
        break;
      }
      default:
        break;
    }
  }

  private onTurnCompleted(p: Wire): void {
    const turn = (p.turn ?? {}) as Wire;
    this.activeTurnId = null;
    const status = String(turn.status ?? "");
    const subtype =
      status === "completed"
        ? "success"
        : status === "interrupted"
          ? "interrupted"
          : "error_during_execution";
    this.hooks.onEvent({
      kind: "turn.end",
      subtype,
      isError: subtype === "error_during_execution",
      costUsd: null,
      numTurns: null,
      durationMs:
        typeof turn.durationMs === "number"
          ? turn.durationMs
          : this.turnStartedAt
            ? Date.now() - this.turnStartedAt
            : null,
      resultText: turn.error?.message ? String(turn.error.message) : null,
    });
    this.markTurnDone?.();
    for (const settle of this.turnSettlers) settle("answered");
    this.turnSettlers.clear();
    this.streamedItems.clear();
  }

  private onError(p: Wire): void {
    const error = (p.error ?? {}) as Wire;
    const message = String(error.message ?? "Codex error");
    if (p.willRetry === true) {
      // "Reconnecting... 2/5" — the only retry shape the server sends.
      const match = /(\d+)\s*\/\s*(\d+)/.exec(message);
      this.hooks.onEvent({
        kind: "retry",
        attempt: match ? Number(match[1]) : 1,
        maxRetries: match ? Number(match[2]) : 5,
        delayMs: 0,
        error: message,
      });
      return;
    }
    this.hooks.onEvent({ kind: "notice", level: "error", text: message });
  }

  private userInput(turn: Turn): Wire[] {
    const prepared = prepareAttachments(this.launch.cwd, turn.attachments);
    const input: Wire[] = [
      { type: "text", text: composeTurnText(turn.text, prepared), text_elements: [] },
    ];
    for (const image of prepared.images) {
      input.push({ type: "image", url: `data:${image.mediaType};base64,${image.data}` });
    }
    return input;
  }

  private onTransportEnd(_code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    // 죽은 전송 위에 승인 카드가 영원히 pending 으로 남지 않게 — hooks 알림보다 먼저.
    this.abort.abort();
    this.markTurnDone?.();
    for (const settle of this.turnSettlers) settle("dead");
    this.turnSettlers.clear();
    this.hooks.onTransportEnd(null);
  }
}
