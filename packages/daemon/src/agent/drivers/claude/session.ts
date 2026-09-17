import {
  type ModelInfo,
  type PermissionResult,
  type Query,
  query,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ContextUsage,
  EffortLevel,
  PermissionMode,
  PlanUsage,
  SessionCommand,
  SessionModelInfo,
} from "@colo-design/protocol";
import { PLAN_TOOL } from "@colo-design/protocol";
import { BROWSER_MCP_SERVER_NAME, claudeBrowserMcpServer } from "../../../browser-launch.js";
import type { AgentSession, DriverHooks, LaunchConfig, ToolClass, Turn } from "../../driver.js";
import { MessageTranslator } from "./event-mapper.js";

/**
 * 중지가 답을 기다리는 유예. 이 안에 CLI 가 control 요청에 답하지 못하면 질의를
 * 강제로 끊는다 — 영원히 매달린 중지 버튼은 버튼이 아니다 (실사 결함).
 */
const INTERRUPT_GRACE_MS = 5_000;
/** close 의 짧은 관대함 — 여러 wedged 세션을 닫아도 종료가 늦어지지 않게. */
const CLOSE_GRACE_MS = 1_000;
/**
 * How long an unattended probe waits for its one control answer. The CLI it
 * boots has no turn to run, so a second is the honest measure and twenty is
 * only patience for a slow machine.
 */
const PROBE_GRACE_MS = 20_000;

/** An async iterable the daemon can push user turns into while the query runs. */
class PushQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    this.buffer.push(message);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const next = this.buffer.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

/**
 * File-edit tools that `acceptEdits` mode used to silence. Under the pinned
 * `default` mode the CLI asks about them like anything else, so the daemon
 * answers here instead, through the session's own `writePolicy`.
 */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch"]);

/**
 * The provider's tool name → the core's normalized class. The core's policy
 * (writePolicy, git-write refusal, plan gate) reads `kind`; the card and the
 * 항상 허용 signature keep `name`.
 */
function classifyTool(toolName: string, input: Record<string, unknown>): ToolClass {
  if (toolName.startsWith("mcp__")) {
    const mcpServer = toolName.split("__")[1];
    return { kind: "mcp", name: toolName, ...(mcpServer ? { mcpServer } : {}) };
  }
  if (toolName === "AskUserQuestion") return { kind: "question", name: toolName };
  if (toolName === PLAN_TOOL) return { kind: "plan", name: toolName };
  if (toolName === "Bash") {
    return {
      kind: "exec",
      name: toolName,
      ...(typeof input.command === "string" ? { command: input.command } : {}),
    };
  }
  if (EDIT_TOOLS.has(toolName)) {
    const paths = [input.file_path, input.notebook_path, input.path].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return { kind: "edit", name: toolName, ...(paths.length > 0 ? { paths } : {}) };
  }
  if (READ_TOOLS.has(toolName)) {
    const path = [input.file_path, input.path].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return { kind: "read", name: toolName, ...(path ? { paths: [path] } : {}) };
  }
  return { kind: "other", name: toolName };
}

/**
 * What the daemon hands the driver to start a query. `sessionId` is the
 * session's own id (already minted by the core); `forkSession` marks the D95
 * truncating fork where that id names the fork, not the resumed thread.
 */
export interface ClaudeLaunch extends LaunchConfig {
  executable: string;
}

export class ClaudeAgentSession implements AgentSession {
  readonly id: string;
  private readonly queue = new PushQueue();
  private readonly translator = new MessageTranslator();
  private readonly hooks: DriverHooks;
  private readonly run: Query;
  private readonly consumer: Promise<void>;
  private closed = false;
  /** The SDK stream finished — sends past this point are swallowed. */
  private streamEnded = false;
  /**
   * CLI 가 스스로 내려간다고 예고한 이유 (`worker_shutting_down`), 없으면 null.
   * 예고 뒤의 스트림 끝은 고장이 아니다 — 크래시 카드의 말이 달라진다.
   */
  private shutdownReason: string | null = null;
  /** SDK 질의의 취소 수단 — 생성자에서 질의에 묶는다. */
  private readonly abort = new AbortController();

  constructor(launch: ClaudeLaunch, hooks: DriverHooks) {
    this.hooks = hooks;
    this.id = launch.sessionId;
    this.run = query({
      prompt: this.queue,
      options: {
        cwd: launch.cwd,
        // 프로젝트별 지침(P1#8): 기본 프롬프트를 대체하지 않고 끝에 붙인다 —
        // 도구가 Claude 에게 주는 나머지 규칙은 그대로 살아 있어야 한다.
        ...(launch.appendSystemPrompt
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: launch.appendSystemPrompt,
              },
            }
          : {}),
        pathToClaudeCodeExecutable: launch.executable,
        // 중지의 이행 보장: 유예 안에 interrupt 가 답하지 못하는 질의는 이
        // 컨트롤러로 끊는다 — SDK 가 자원을 정리하고 CLI 를 내린다.
        abortController: this.abort,
        // `default` is pinned on purpose: current CLI builds auto-approve
        // safe Bash under acceptEdits/auto without ever consulting
        // `canUseTool`, which would let a session run shell commands with no
        // planner in the loop. The daemon answers edit-class tools itself
        // (see canUse), so the UX stays "edits are silent, everything else
        // asks".
        permissionMode: "default",
        // The launch flag — not the mode — is what the CLI checks before it
        // accepts a later `setPermissionMode("bypassPermissions")`; without
        // it every 전부 맡기기 switch dies with "was not launched with
        // --dangerously-skip-permissions". The starting mode above stays
        // `default`, so nothing widens until the planner picks it themselves.
        allowDangerouslySkipPermissions: true,
        // Policy tier beats a user's own `defaultMode` (e.g. `"auto"`) in
        // ~/.claude/settings.json — without it that setting silently widens
        // every hub session.
        managedSettings: { permissions: { defaultMode: "default" } },
        includePartialMessages: true,
        // Load the same user/project configuration the terminal would, so
        // CLAUDE.md, skills, and permission rules behave identically. (The
        // project tier is the repo's own files — a repo that ships
        // pre-approved tool rules surfaces as a header warning; see
        // repoSettingsWarning.)
        settingSources: ["user", "project", "local"],
        // 브라우저 도구(3단계): host가 브라우저 팩토리를 주입한 세션만 세션
        // 시크릿을 든 stdio MCP 서버를 받는다 — 메인 query에만 주입하고,
        // probe·one-shot 사이트는 의도적 무도구 그대로다.
        ...(launch.browserMcp
          ? {
              mcpServers: {
                [BROWSER_MCP_SERVER_NAME]: claudeBrowserMcpServer(launch.browserMcp),
              },
            }
          : {}),
        // 질문 카드의 선택지 미리보기를 HTML 로 받는다 (PLAN D96): 이 앱의
        // 카드는 웹이라 monospace 박스가 아니라 그려진 시안을 보여 줄 수 있다.
        // 카드는 스크립트 없는 sandbox iframe 으로만 그린다.
        toolConfig: { askUserQuestion: { previewFormat: "html" } },
        // 보조 작업이 30초마다 한 줄로 지금 무엇을 하는지 말한다 (PLAN D97).
        // 포크는 서브에이전트의 프롬프트 캐시를 재사용하므로 값이 싸다.
        agentProgressSummaries: true,
        // 보조 작업의 말과 생각까지 받아 중첩 기록으로 그린다 (PLAN D98).
        // 이게 없으면 서브에이전트는 도구 행의 심장 박동으로만 보인다.
        forwardSubagentText: true,
        // 턴이 끝나면 다음에 할 만한 말 한 문장 (PLAN D99) — 부모 턴의 캐시에
        // 얹혀 오므로 사실상 공짜다.
        promptSuggestions: true,
        // 작업별 중지를 이 앱이 그린다고 CLI 에 알린다 (PLAN D101). 선언하지
        // 않으면 중지 한 번이 백그라운드 작업까지 함께 죽인다 — 선언과 UI 는
        // 반드시 같이 간다(둘 중 하나만 있으면 폭주하는 작업을 세울 길이 없다).
        perTaskStopAffordance: true,
        // A fresh query starts on the chips' choices; mid-session switches
        // go through the control methods below instead.
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.effort ? { effort: launch.effort } : {}),
        ...(launch.resume
          ? {
              resume: launch.resume,
              // D95: a fork keeps the old transcript and continues as OUR id.
              ...(launch.forkSession ? { sessionId: launch.sessionId, forkSession: true } : {}),
              ...(launch.resumeSessionAt ? { resumeSessionAt: launch.resumeSessionAt } : {}),
              ...(launch.resumeDropsTurn ? { resumeDropsTurn: launch.resumeDropsTurn } : {}),
            }
          : { sessionId: launch.sessionId }),
        canUseTool: (toolName, input, opts) =>
          this.hooks
            .decidePermission(classifyTool(toolName, input), input, opts)
            .then((verdict) => verdict as PermissionResult),
      },
    });

    this.consumer = this.consume();
  }

  get alive(): boolean {
    return !this.closed && !this.streamEnded;
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.run) {
        // 빠르게의 진실은 CLI 에 있다: init·result·system 이 실어 오는
        // fast_mode_state 를 번역 전에 읽어 둔다. 'cooldown' 은 한도 뒤의
        // 쉬는 중 - 켜 달라는 뜻은 살아 있으나 지금 도는 것은 보통 속도라,
        // 켜짐으로 세지 않는다.
        this.readFastMode(message);
        for (const event of this.translator.translate(message)) {
          if (event.kind === "shutdown") {
            // 예고된 종료는 고장이 아니다: 스트림 끝이 이 깃발을 읽고 다른
            // 말을 한다. 화면에는 올리지 않는다 - 계획자가 할 일은 없고, 곧
            // 이어지는 카드가 이어가는 길을 말한다.
            this.shutdownReason = event.reason;
            continue;
          }
          this.hooks.onEvent(event);
        }
      }
      // A deliberate close() ends the stream too — that end is not a crash.
      if (!this.closed) this.hooks.onTransportEnd(this.shutdownReason);
    } catch (error) {
      this.hooks.onTransportError(error instanceof Error ? error.message : String(error));
    } finally {
      this.streamEnded = true;
    }
  }

  async send(turn: Turn): Promise<void> {
    const images = turn.images ?? [];
    const content =
      images.length > 0
        ? [
            { type: "text" as const, text: turn.text },
            ...images.map((image) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.mediaType,
                data: image.data,
              },
            })),
          ]
        : turn.text;
    this.queue.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.id,
    } as SDKUserMessage);
  }

  async interrupt(): Promise<"answered" | "timeout" | "dead"> {
    const outcome = await this.settleInterrupt();
    if (outcome !== "answered") {
      // `dead`: the control request rejected — the query is already gone, so
      // there is no stream left to abort, but the flag costs nothing.
      // `timeout`: the CLI never answered; cut the query so it cannot quietly
      // swallow later sends.
      this.abort.abort();
    }
    return outcome;
  }

  /**
   * A control request's grace. The CLI answers an interrupt quickly when it
   * can. `timeout` is the wedged case and `dead` the already-gone one — both
   * are the caller's cue to abort the query outright.
   */
  private settleInterrupt(graceMs = INTERRUPT_GRACE_MS): Promise<"answered" | "timeout" | "dead"> {
    const { promise, resolve } = Promise.withResolvers<"answered" | "timeout" | "dead">();
    const timer = setTimeout(() => resolve("timeout"), graceMs);
    this.run.interrupt().then(
      () => {
        clearTimeout(timer);
        resolve("answered");
      },
      () => {
        clearTimeout(timer);
        resolve("dead");
      },
    );
    return promise;
  }

  async contextUsage(): Promise<ContextUsage | null> {
    try {
      const usage = await this.run.getContextUsage({ detail: "summary" });
      return {
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        percentage: usage.percentage,
        // The core session owns the running total and overwrites this.
        sessionCostUsd: null,
        model: usage.model,
        plan: await this.usage(),
      };
    } catch {
      return null;
    }
  }

  /**
   * The signed-in plan's windows, from the SDK's /usage control call. Any
   * failure just means the composer shows nothing — the context ring above
   * still works, so a broken experimental call must not take it down.
   */
  async usage(): Promise<PlanUsage | null> {
    try {
      return toPlanUsage(
        await this.run.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
          skipBehaviors: true,
        }),
      );
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Composer selector chips — mid-session switches (SDK control requests)
  // -------------------------------------------------------------------------

  /** Effective from the next response. `null` returns to the CLI default. */
  async setModel(model: string | null): Promise<void> {
    await this.run.setModel(model ?? undefined);
  }

  /** Effective from the next response. `null` clears the override. */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    await this.run.applyFlagSettings({ effortLevel: effort ?? null });
  }

  async setMode(mode: string): Promise<void> {
    // 갓 살아난 CLI 는 제어 요청을 받아들일 준비가 늦는다 — 방금 만들거나
    // 되살린 대화의 첫 칩(계획 먼저)이 부팅 창에 부딪히면 계획자는 자기가
    // 누른 칩이 오류 밴드로 돌아오는 것을 받는다. "준비 안 됨"은 거절이
    // 아니라 아직이라는 뜻이니, 묻는 것을 잠시 뒤로 미룬다.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.run.setPermissionMode(mode as PermissionMode);
        break;
      } catch (e) {
        if (attempt >= 5 || !/not ready/i.test(e instanceof Error ? e.message : String(e))) {
          throw e;
        }
        const backoff = Promise.withResolvers<void>();
        setTimeout(backoff.resolve, 300 * attempt);
        await backoff.promise;
      }
    }
  }

  /**
   * 빠르게 (fast mode): 같은 모델을 더 빠른 응답으로 돌린다. 노력 수준과 같은
   * 깃발 층으로 가고(`applyFlagSettings`), 켜 달라는 부탁일 뿐이다 — 받아들여
   * 졌는지는 다음 메시지의 `fast_mode_state` 가 말한다(아래 readFastMode).
   */
  async setFastMode(fast: boolean): Promise<void> {
    await this.run.applyFlagSettings({ fastMode: fast });
  }

  /**
   * CLI 가 매 메시지에 실어 보내는 빠르게의 상태를 그대로 받아 적는다.
   * 말이 없는 메시지는 소식이 없는 것이지 꺼졌다는 뜻이 아니라, 건드리지
   * 않는다.
   */
  private readFastMode(message: unknown): void {
    const m = message as {
      fast_mode_state?: "off" | "cooldown" | "on";
      fast_mode_disabled_reason?: string;
    };
    if (m.fast_mode_state === undefined) return;
    this.hooks.onFastMode?.(m.fast_mode_state === "on", m.fast_mode_disabled_reason ?? null);
  }

  /**
   * 이 작업만 중지 (PLAN D101): 폭주하는 명령 하나, 서브에이전트 하나를 턴을
   * 끊지 않고 세운다.
   */
  async stopTask(taskId: string): Promise<void> {
    await this.run.stopTask(taskId);
  }

  /**
   * 뒤로 보내기 (PLAN D101): 지금 턴을 붙잡고 있는 작업을 백그라운드로 옮긴다.
   * 옮길 것이 없으면 false — 버튼이 거짓말하지 않게 그대로 올린다.
   */
  async backgroundTask(toolUseId: string): Promise<boolean> {
    return await this.run.backgroundTasks(toolUseId);
  }

  /** The model picker rows, or [] when the query cannot answer. */
  async models(): Promise<SessionModelInfo[]> {
    // 죽은 질의의 SDK 메서드는 거절이 아니라 동기 throw 로 답하는 수가
    // 있다 — .catch 는 붙지 못하니 try 로 감싼다.
    let models: ModelInfo[] = [];
    try {
      models = (await this.run.supportedModels()) ?? [];
    } catch {
      models = [];
    }
    return models.map((model) => ({
      value: model.value,
      displayName: model.displayName,
      resolvedModel: model.resolvedModel ?? null,
      description: model.description,
      supportsEffort: model.supportsEffort ?? false,
      supportedEffortLevels: model.supportedEffortLevels ?? null,
      supportsFastMode: model.supportsFastMode ?? false,
    }));
  }

  /** The composer's /command palette: names, descriptions, argument hints. */
  async commands(): Promise<SessionCommand[]> {
    let commands: SlashCommand[] = [];
    try {
      commands = (await this.run.supportedCommands()) ?? [];
    } catch {
      commands = [];
    }
    return commands.map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint ?? "",
      aliases: command.aliases ?? [],
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
    // The same grace as 중지, only shorter: a shutdown must not hang on a
    // wedged CLI either — and it must not pay the full grace per session.
    if ((await this.settleInterrupt(CLOSE_GRACE_MS)) === "timeout") this.abort.abort();
    await this.consumer.catch(() => undefined);
  }
}

/**
 * A CLI booted just far enough to answer one control request — the init
 * handshake, no model turn, no transcript. The prompt stream never yields, so
 * the process only ever answers the question the caller asks before closing
 * it, and closing it is the caller's job.
 */
function probeQuery(cwd: string, executable: string): Query {
  const idle = Promise.withResolvers<IteratorResult<SDKUserMessage>>();
  const never: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => idle.promise }),
  };
  return query({
    prompt: never,
    options: {
      cwd,
      pathToClaudeCodeExecutable: executable,
      // The same user/project configuration a session loads, so a probe's
      // answer is the one the first session will actually agree with.
      settingSources: ["user", "project", "local"],
    },
  });
}

/**
 * One probe question, bounded twice over: by the grace above, and by the
 * caller's own signal. The signal is shutdown — a daemon that has stopped
 * must not be held open by a CLI that never answers. Without it every
 * offline suite paid the full grace at exit (the stub CLI answers no
 * control request the probes ask), which is where ~20s per suite went.
 *
 * A give-up answers `null`; the ask's own failure is carried out to the
 * caller, whose retry rule differs per question. Either way the loser of
 * the race is settled here, so nothing rejects into no one's hands once
 * `close` tears the query down.
 */
async function askProbe<T>(
  options: { cwd: string; executable: string | null; signal?: AbortSignal },
  ask: (run: Query) => Promise<T>,
): Promise<T | null> {
  if (!options.executable || options.signal?.aborted) return null;
  const run = probeQuery(options.cwd, options.executable);
  const gaveUp = Promise.withResolvers<null>();
  const abandon = () => gaveUp.resolve(null);
  const timer = setTimeout(abandon, PROBE_GRACE_MS);
  options.signal?.addEventListener("abort", abandon, { once: true });
  try {
    const settled = await Promise.race([
      ask(run).then(
        (value) => ({ ok: true, value }) as const,
        (error) => ({ ok: false, error }) as const,
      ),
      gaveUp.promise,
    ]);
    if (settled === null) return null;
    if (!settled.ok) throw settled.error;
    return settled.value;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abandon);
    run.close();
  }
}

/**
 * The `/` palette before any thread exists. A live session answers from its
 * own CLI (`Session.commands`); this asks the same question of a probe, so an
 * empty workspace still reads like the terminal's `/`.
 *
 * A probe that never answered is not an empty palette: it throws, so the
 * caller retries the next time someone opens `/` instead of caching a CLI
 * as commandless.
 */
export async function probeCommands(options: {
  cwd: string;
  executable: string | null;
  signal?: AbortSignal;
}): Promise<SessionCommand[]> {
  if (!options.executable) return [];
  const commands = await askProbe(options, (run) => run.supportedCommands());
  if (!commands) throw new Error("명령 목록을 묻는 probe 가 답하지 않았습니다");
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint ?? "",
    aliases: command.aliases ?? [],
  }));
}

/**
 * The SDK's usage answer as the protocol's plan reading. API-key, Bedrock and
 * Vertex sessions answer `rate_limits_available: false` and get null — plan
 * limits do not apply there at all. Pure, and exported for the mapper test:
 * the classification is the only bridge between the SDK's answer and the
 * chip's rows, so it is tested without a session in the way.
 */
export function toPlanUsage(usage: SDKControlGetUsageResponse): PlanUsage | null {
  const limits = usage.rate_limits;
  if (!usage.rate_limits_available || !limits) return null;
  return {
    provider: "claude",
    subscriptionType: usage.subscription_type,
    fiveHour: limits.five_hour
      ? { utilization: limits.five_hour.utilization, resetsAt: limits.five_hour.resets_at }
      : null,
    sevenDay: limits.seven_day
      ? { utilization: limits.seven_day.utilization, resetsAt: limits.seven_day.resets_at }
      : null,
    // The per-model weekly rows (Fable, Opus, …) are additive and named by
    // the server, so they are carried through as they arrive rather than
    // picked one by one — a bucket this build has never heard of still gets
    // its row.
    modelWeekly: (limits.model_scoped ?? []).map((row) => ({
      label: row.display_name,
      utilization: row.utilization,
      resetsAt: row.resets_at,
    })),
  };
}

/**
 * The plan's limits with no thread in the way. The chip has to read the
 * account before the planner has opened anything — and the numbers move on
 * the account, not in the thread — so this asks a probe rather than keeping a
 * session alive for it: one process for a second, no tokens, no turn.
 *
 * A reading that never came is no reading: the chip keeps the last one and
 * the next refresh asks again. Failure and give-up read the same here, which
 * is why this one swallows where `probeCommands` throws.
 */
export async function probePlanUsage(options: {
  cwd: string;
  executable: string | null;
  signal?: AbortSignal;
}): Promise<PlanUsage | null> {
  const usage = await askProbe(options, (run) =>
    run.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
  ).catch(() => null);
  return usage ? toPlanUsage(usage) : null;
}
