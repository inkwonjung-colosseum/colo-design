import type {
  AskQuestion,
  ContextUsage,
  EffortLevel,
  SessionCommand,
  SessionModelInfo,
} from "@colo-design/protocol";
import { BROWSER_TOOLS, callBrowserTool, refused } from "../../../browser-tools.js";
import { sanitizeRepoAgentSettings } from "../../../claude-trust.js";
import { composeTurnText, prepareAttachments } from "../../attachments.js";
import type {
  AgentSession,
  DriverHooks,
  LaunchConfig,
  PermissionVerdict,
  Turn,
} from "../../driver.js";
import { ompModelRows } from "./catalog.js";
import { approvalToolName, classifyOmpTool } from "./classify.js";
import { OmpRpcTransport } from "./transport.js";

/** The omp wire shapes this driver reads — kept loose, the protocol evolves. */
type Wire = Record<string, any>;

/**
 * bypass(바로 실행) — 에이전트의 모드가 아니라 데몬의 집행 방식. omp 는 승인
 * 모드를 런타임에 바꾸는 명령이 없으므로(RpcCommand 에 그런 항목이 없다) 세션은
 * 언제나 `--approval-mode always-ask` 로 뜬다: 읽기는 조용하고 쓰기·실행은
 * 전부 승인 요청으로 데몬에 온다. 그 요청에 카드를 열지 않고 Approve 로
 * 답하는 것이 bypass 다 — codex bypass(approvalPolicy never)의 동등물.
 */
const BYPASS_MODE_ID = "bypass";

/**
 * 모드 행 — 서술자의 티어 표와 컴포저 칩이 같은 목록을 쓴다. omp 의 rpc 에는
 * 계획 모드 와이어가 없다(`/plan` 은 TUI 전용 슬래시 명령이고 RpcCommand 에
 * 대응이 없다). 없는 자세를 칩에 세우면 고른 순간 아무 일도 일어나지 않으므로
 * 두 줄만 선다.
 */
export const OMP_MODE_ROWS: Array<{
  id: string;
  label: string;
  tier: "safe" | "moderate" | "planning" | "dangerous";
  description: string;
}> = [
  {
    id: "default",
    label: "실행 전에 물어보기",
    tier: "moderate",
    description: "쓰기·실행 전에 카드로 물어봅니다",
  },
  {
    id: BYPASS_MODE_ID,
    label: "바로 진행",
    tier: "dangerous",
    description: "아무것도 묻지 않습니다",
  },
];

/** 승인을 기다리는 도구 호출 — 어시스턴트 메시지가 실은 순서 그대로. */
interface PendingCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * An AgentSession over omp's `--mode rpc-ui` protocol: one child process per
 * session, JSONL commands on stdin, frames on stdout.
 *
 * Why `rpc-ui` and not plain `rpc`: the `-ui` suffix installs an
 * ExtensionUIContext on the tool path, so approvals and the `ask` tool reach
 * the host as `extension_ui_request` frames instead of failing closed with
 * "requires approval but no interactive UI available".
 *
 * Turn model: `prompt` resolves on acceptance; the turn ends on `agent_end`
 * with `isTerminal !== false` — retries, queued follow-ups and steered input
 * all settle inside one agent run (검증됨: steer 는 같은 run 안에서 두 번째
 * turn_start 를 열 뿐이다). `abort` interrupts.
 *
 * Approval flow: `extension_ui_request{method:"select"}` whose title starts
 * with `Allow tool:` is a permission gate. The frame carries no arguments, so
 * the call it belongs to is matched against the tool calls the preceding
 * assistant `message_end` announced — that message always lands first
 * (검증됨: message_end → select → tool_execution_start).
 */
export class OmpAgentSession implements AgentSession {
  private readonly transport: OmpRpcTransport;
  private readonly ready: Promise<void>;
  private vendorSessionId: string | null = null;
  get vendorId(): string | null {
    return this.vendorSessionId;
  }
  private closed = false;
  private readonly abort = new AbortController();
  private turnStartedAt = 0;
  private turnActive = false;
  private turnCostUsd: number | null = null;
  private turnFailure: string | null = null;
  /** Whether THIS turn produced any agent text or tool call — an empty
      "successful" turn is a swallowed provider failure, not an answer. */
  private turnSawContent = false;
  private currentModeId: string;
  private currentModel: string | null;
  /** The model/effort the CLI opened with — what a null pick restores. */
  private initialModel: string | null = null;
  private initialEffort: string | null = null;
  private availableCommands: SessionCommand[] = [];
  private lastContext: { used: number; size: number } | null = null;
  /** Blocks are keyed per message — contentIndex restarts at 0 each message. */
  private messageSeq = 0;
  private readonly pendingCalls: PendingCall[] = [];
  /** Host tool calls in flight, so `host_tool_cancel` can stop the relay. */
  private readonly hostCalls = new Map<string, AbortController>();
  private readonly launch: LaunchConfig;
  /** One `prompt` at a time — the core's wait room owns the rest. */
  private sendChain: Promise<void> = Promise.resolve();
  /** Resolves when the running turn settles — interrupt waits on it. */
  private turnDone: Promise<void> | null = null;
  private markTurnDone: (() => void) | null = null;

  get alive(): boolean {
    return !this.closed && this.transport.alive;
  }

  constructor(
    command: string,
    launch: LaunchConfig,
    private readonly hooks: DriverHooks,
    /**
     * argv placed before the mode flags — the test seam that runs a stub
     * agent script under `node`. Empty in production: the driver hands us
     * the `omp` binary itself.
     */
    prefixArgs: string[] = [],
  ) {
    this.launch = launch;
    this.currentModeId = launch.modeId || "default";
    this.currentModel = launch.model;
    // 프로젝트 티어가 적재되기 직전의 마지막 방어선: omp 는 <cwd>/.omp/config.yml 을
    // 신뢰 대화상자 없이 verbatim 으로 읽는다. 클론·갱신·기동 스윕과 같은 칼이며,
    // 이미 깨끗하면 무동작이다.
    sanitizeRepoAgentSettings(launch.cwd);
    this.transport = new OmpRpcTransport(command, [...prefixArgs, ...ompArgs(launch)], launch.cwd, {
      onFrame: (frame) => this.onFrame(frame),
      onEnd: () => this.onTransportEnd(),
    });
    const handshake = this.handshake();
    // 핸드셰이크 거절(ready 타임아웃, branch 거부)은 자식을 죽이지 않는다 —
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
  // Handshake
  // -------------------------------------------------------------------------

  private async handshake(): Promise<void> {
    await this.transport.ready();

    // 절단 포크: 프로세스는 `--resume` 으로 옛 세션을 열었다. `branch` 가 버릴
    // 프롬프트의 엔트리에서 잘라 내고 이 프로세스를 새 파일로 옮긴다 —
    // 새 세션 id 는 뒤이은 get_state 가 말한다(검증됨).
    const dropAt =
      this.launch.forkSession === true && typeof this.launch.resumeDropsTurn === "string"
        ? this.launch.resumeDropsTurn
        : null;
    if (dropAt) await this.transport.command("branch", { entryId: dropAt }, 30_000);

    if (this.launch.browserMcp) await this.registerHostTools();

    const state = (await this.transport.command("get_state", undefined, 30_000)) as Wire;
    this.vendorSessionId = typeof state.sessionId === "string" ? state.sessionId : null;
    const model = (state.model ?? null) as Wire | null;
    this.currentModel = model?.provider && model?.id ? `${model.provider}/${model.id}` : null;
    this.initialModel = this.currentModel;
    this.initialEffort = typeof state.thinkingLevel === "string" ? state.thinkingLevel : null;
    this.noteContext(state.contextUsage as Wire | undefined);

    this.hooks.onEvent({
      kind: "init",
      sessionId: this.vendorSessionId ?? this.launch.sessionId,
      model: this.currentModel ?? String(model?.id ?? "default"),
      cwd: this.launch.cwd,
      tools: [],
      apiKeySource: "none",
      permissionMode: this.currentModeId,
    });

    // 런치 핀 중 CLI 가 이미 적용하지 못한 것. 모델은 `--model` 이 퍼지 매칭을
    // 하므로 답이 다를 수 있고, 노력 수준은 모델을 바꾸면 되돌아간다(실측).
    if (this.launch.model && this.launch.model !== this.currentModel) {
      await this.applyModel(this.launch.model).catch(() => undefined);
    }
    if (this.launch.effort && this.launch.effort !== this.initialEffort) {
      await this.transport
        .command("set_thinking_level", { level: this.launch.effort }, 10_000)
        .catch(() => undefined);
    }
  }

  /**
   * 브라우저 도구를 호스트 도구로 싣는다 — omp 의 rpc 는 도구 주입에 자식
   * 프로세스를 요구하지 않는다(`set_host_tools` → `host_tool_call` →
   * `host_tool_result`). 같은 계약, MCP 자식 하나 없이.
   *
   * `loadMode: "essential"` 이어야 모델이 직접 부를 수 있는 도구가 된다 —
   * 기본값 discoverable 은 `write` 로 `xd://<name>` 에 적는 장치가 되어(실측)
   * 카드도 결과도 한 겹 돌아간다.
   */
  private async registerHostTools(): Promise<void> {
    await this.transport.command(
      "set_host_tools",
      {
        tools: BROWSER_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          loadMode: "essential",
          parameters: {
            type: "object",
            properties: tool.properties,
            ...(tool.required?.length ? { required: tool.required } : {}),
          },
        })),
      },
      15_000,
    );
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
    if (this.closed || !this.transport.alive) throw new Error("omp transport closed");
    this.turnStartedAt = Date.now();
    this.turnActive = true;
    this.turnCostUsd = null;
    this.turnFailure = null;
    this.turnSawContent = false;
    this.turnDone = new Promise<void>((resolve) => {
      this.markTurnDone = resolve;
    });
    try {
      await this.transport.command("prompt", this.promptParams(turn), 60_000);
    } catch (error) {
      if (this.closed) return;
      this.turnActive = false;
      this.markTurnDone?.();
      this.markTurnDone = null;
      this.turnDone = null;
      this.hooks.onEvent({
        kind: "turn.end",
        subtype: "error_during_execution",
        isError: true,
        costUsd: null,
        numTurns: null,
        durationMs: Date.now() - this.turnStartedAt,
        resultText: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 바로 실어 보내기 — 도는 턴에 말을 얹는다. omp 는 steer 를 같은 agent run
   * 안에서 소화하므로(검증됨) 턴 장부는 건드리지 않는다: 이 턴의 끝은 여전히
   * 하나의 `agent_end` 다.
   */
  async steer(turn: Turn): Promise<void> {
    await this.ready;
    if (this.closed || !this.transport.alive) throw new Error("omp transport closed");
    const { message, images } = this.promptParams(turn);
    await this.transport.command("steer", { message, ...(images ? { images } : {}) }, 15_000);
  }

  private promptParams(turn: Turn): { message: string; images?: Wire[] } {
    const prepared = prepareAttachments(this.launch.cwd, turn.attachments);
    const images = prepared.images.map((image) => ({
      type: "image",
      data: image.data,
      mimeType: image.mediaType,
    }));
    return {
      message: composeTurnText(turn.text, prepared),
      ...(images.length ? { images } : {}),
    };
  }

  async interrupt(): Promise<"answered" | "timeout" | "dead"> {
    await this.ready.catch(() => undefined);
    if (!this.alive) return "dead";
    try {
      await this.transport.command("abort", undefined, 10_000);
    } catch {
      // A wedged agent that never answered is a timeout, not a corpse.
      return this.alive ? "timeout" : "dead";
    }
    if (!this.turnActive) return "answered";
    // abort 의 응답은 접수일 뿐 — 턴이 실제로 풀리는 것은 agent_end 다. 유예
    // 안에 풀리지 않으면 wedged: 프롬프트가 sendChain 을 영원히 막기 전에
    // 전송을 끊어 크래시 기계가 닫게 한다(acp·claude 와 같은 판정).
    const settled = await Promise.race([
      this.turnDone ?? Promise.resolve(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
    ]);
    if (settled === "timeout") {
      this.transport.close();
      return "timeout";
    }
    return this.alive ? "answered" : "dead";
  }

  /** 모드는 데몬의 집행 방식이다 — 에이전트에 보낼 명령이 없다(위 BYPASS 주석). */
  async setMode(modeId: string): Promise<void> {
    await this.ready;
    if (OMP_MODE_ROWS.some((row) => row.id === modeId)) this.currentModeId = modeId;
  }

  async setModel(id: string | null): Promise<void> {
    await this.ready;
    const target = id ?? this.initialModel;
    if (target === null) return;
    await this.applyModel(target);
  }

  private async applyModel(target: string): Promise<void> {
    // 고르개의 값은 카탈로그가 만든 "provider/modelId" 다.
    const slash = target.indexOf("/");
    const provider = slash > 0 ? target.slice(0, slash) : "";
    const modelId = slash > 0 ? target.slice(slash + 1) : target;
    await this.transport.command("set_model", { provider, modelId }, 15_000);
    this.currentModel = target;
  }

  async setEffort(effort: EffortLevel | null): Promise<void> {
    await this.ready;
    const level = effort ?? this.initialEffort;
    if (level === null) return;
    await this.transport.command("set_thinking_level", { level }, 10_000);
  }

  /**
   * 빠르게 — 세션의 service tier 설정. 받지 않는 모델 위에서는 omp 가 문장으로
   * 거절하고, 그 거절이 그대로 올라가 토글이 눌리기 전 자리로 돌아간다.
   * 성공해도 `active` 는 다를 수 있다(프로바이더 수준 설정) — 에이전트가 말한
   * 실제 상태를 그대로 코어에 알린다.
   */
  async setFastMode(on: boolean): Promise<void> {
    await this.ready;
    const result = (await this.transport.command("set_fast_mode", { enabled: on }, 15_000)) as Wire;
    this.hooks.onFastMode?.(result?.active === true, null);
  }

  async modes(): Promise<Array<{
    id: string;
    label: string;
    description?: string;
    tier?: string;
  }> | null> {
    return OMP_MODE_ROWS.map(({ id, label, description, tier }) => ({
      id,
      label,
      description,
      tier,
    }));
  }

  async commands(): Promise<SessionCommand[]> {
    await this.ready;
    return this.availableCommands;
  }

  async models(): Promise<SessionModelInfo[]> {
    await this.ready;
    const data = (await this.transport.command("get_available_models", undefined, 20_000)) as Wire;
    return ompModelRows(Array.isArray(data?.models) ? (data.models as Wire[]) : []);
  }

  async contextUsage(): Promise<ContextUsage | null> {
    await this.ready;
    if (this.lastContext === null) return null;
    const { used, size } = this.lastContext;
    return {
      totalTokens: used,
      maxTokens: size,
      percentage: size > 0 ? Math.min(100, Math.round((used / size) * 100)) : 0,
      sessionCostUsd: null,
      model: this.currentModel ?? "",
      plan: null,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const [, controller] of this.hostCalls) controller.abort();
    this.hostCalls.clear();
    this.transport.close();
  }

  // -------------------------------------------------------------------------
  // Agent → client frames
  // -------------------------------------------------------------------------

  private onFrame(frame: Wire): void {
    switch (frame?.type) {
      case "message_start":
        this.messageSeq += 1;
        break;
      case "message_update":
        this.onMessageUpdate(frame);
        break;
      case "message_end":
        this.onMessageEnd(frame);
        break;
      case "tool_execution_start":
        this.turnSawContent = true;
        this.hooks.onEvent({
          kind: "tool.start",
          toolUseId: String(frame.toolCallId ?? ""),
          name: String(frame.toolName ?? "tool"),
          input: (frame.args ?? {}) as Record<string, unknown>,
          agentId: null,
        });
        break;
      case "tool_execution_end":
        this.dropPending(String(frame.toolCallId ?? ""));
        this.hooks.onEvent({
          kind: "tool.end",
          toolUseId: String(frame.toolCallId ?? ""),
          isError: frame.isError === true,
          content: toolContent(frame.result),
          agentId: null,
        });
        break;
      case "agent_end":
        // isTerminal:false = 유지보수나 비동기 배달이 뒤를 예약했다는 뜻 —
        // 아직 턴의 끝이 아니다.
        if (frame.isTerminal !== false) this.endTurn();
        break;
      case "auto_compaction_start":
        this.hooks.onEvent({ kind: "compact", trigger: String(frame.reason ?? "auto") });
        break;
      case "auto_retry_start":
        this.hooks.onEvent({
          kind: "notice",
          level: "warn",
          text: `일시 오류로 다시 시도합니다${frame.error ? ` — ${String(frame.error)}` : ""}`,
        });
        break;
      case "available_commands_update":
        this.availableCommands = mapCommands(frame.commands);
        break;
      case "notice":
        this.hooks.onEvent({
          kind: "notice",
          level: frame.level === "error" ? "error" : frame.level === "warning" ? "warn" : "info",
          text: String(frame.message ?? ""),
        });
        break;
      case "extension_error":
        this.hooks.onEvent({
          kind: "notice",
          level: "warn",
          text: String(frame.error ?? "extension error"),
        });
        break;
      case "extension_ui_request":
        void this.onUiRequest(frame);
        break;
      case "host_tool_call":
        void this.onHostToolCall(frame);
        break;
      case "host_tool_cancel": {
        const controller = this.hostCalls.get(String(frame.targetId ?? ""));
        controller?.abort();
        break;
      }
      default:
        break;
    }
  }

  private onMessageUpdate(frame: Wire): void {
    const delta = frame.assistantMessageEvent as Wire | undefined;
    if (!delta || typeof delta.delta !== "string" || delta.delta === "") return;
    const blockId = `m${this.messageSeq}:c${Number(delta.contentIndex ?? 0)}`;
    if (delta.type === "text_delta") {
      this.turnSawContent = true;
      this.hooks.onEvent({ kind: "text.delta", blockId, text: delta.delta, agentId: null });
    } else if (delta.type === "thinking_delta") {
      this.hooks.onEvent({ kind: "thinking.delta", blockId, text: delta.delta, agentId: null });
    }
    // toolcall_* 델타는 tool_execution_* 이 더 낫다 — toolCallId 로 키가 잡혀
    // 테이프가 반쯤 파싱된 인자 뭉치를 보지 않는다.
  }

  /**
   * 어시스턴트 메시지가 끝났다 — 이 메시지가 부른 도구 호출이 곧 승인 요청의
   * 후보 목록이 된다(승인 frame 에는 인자가 없다). 비용과 실패 사유도 여기서
   * 읽는다.
   */
  private onMessageEnd(frame: Wire): void {
    const message = frame.message as Wire | undefined;
    if (message?.role !== "assistant") return;
    for (const block of (message.content ?? []) as Wire[]) {
      if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
      this.pendingCalls.push({
        id: block.id,
        name: String(block.name ?? ""),
        args: (block.arguments ?? {}) as Record<string, unknown>,
      });
    }
    const stop = String(message.stopReason ?? "");
    if (stop === "error") this.turnFailure = String(message.errorMessage ?? "turn failed");
    else if (stop === "aborted") this.turnFailure = "aborted";
    const usage = message.usage as Wire | undefined;
    const cost = usage?.cost as Wire | undefined;
    if (typeof cost?.total === "number") {
      this.turnCostUsd = (this.turnCostUsd ?? 0) + cost.total;
    }
    const snapshot = message.contextSnapshot as Wire | undefined;
    if (typeof usage?.totalTokens === "number" || typeof snapshot?.promptTokens === "number") {
      this.lastContext = {
        used: Number(usage?.totalTokens ?? snapshot?.promptTokens ?? 0),
        size: this.lastContext?.size ?? 0,
      };
    }
  }

  private noteContext(usage: Wire | undefined): void {
    if (!usage) return;
    this.lastContext = {
      used: Number(usage.tokens ?? 0),
      size: Number(usage.contextWindow ?? 0),
    };
  }

  private endTurn(): void {
    if (!this.turnActive) return;
    this.turnActive = false;
    this.pendingCalls.length = 0;
    const failure = this.turnFailure;
    this.turnFailure = null;
    const subtype =
      failure === "aborted"
        ? "interrupted"
        : failure
          ? "error_during_execution"
          : this.turnSawContent
            ? "success"
            : "empty";
    // 답도 도구 호출도 없이 "성공"으로 끝난 턴은 답이 아니다 — 프로바이더
    // 실패(사용량·모델 버전·로그인)를 삼킨 턴을 성공으로 올리면 계획자는
    // 조용한 턴을 바라보게 된다.
    this.hooks.onEvent({
      kind: "turn.end",
      subtype: subtype === "empty" ? "error_during_execution" : subtype,
      isError: subtype === "error_during_execution" || subtype === "empty",
      costUsd: this.turnCostUsd,
      numTurns: null,
      durationMs: Date.now() - this.turnStartedAt,
      resultText:
        subtype === "empty"
          ? "에이전트가 아무 응답 없이 턴을 끝냈습니다 — 프로바이더 오류(모델 버전·권한·로그인 상태)일 수 있습니다."
          : failure && failure !== "aborted"
            ? failure
            : null,
    });
    this.markTurnDone?.();
    this.markTurnDone = null;
    this.turnDone = null;
  }

  // -------------------------------------------------------------------------
  // Extension UI — approvals and the ask tool
  // -------------------------------------------------------------------------

  private async onUiRequest(frame: Wire): Promise<void> {
    const id = typeof frame.id === "string" ? frame.id : null;
    if (!id) return;
    const method = String(frame.method ?? "");
    if (method === "notify") {
      this.hooks.onEvent({
        kind: "notice",
        level:
          frame.notifyType === "error" ? "error" : frame.notifyType === "warning" ? "warn" : "info",
        text: String(frame.message ?? ""),
      });
      return;
    }
    if (method !== "select") {
      // setStatus · setWidget · setTitle · set_editor_text 는 터미널 표면의
      // 것이라 이 앱에 자리가 없고, confirm · input · editor 는 승인 카드가
      // 아니므로 정중히 거절한다 — 답하지 않으면 확장이 영원히 멈춘다.
      if (method === "confirm" || method === "input" || method === "editor") {
        this.answerUi(id, { cancelled: true });
      }
      return;
    }
    const title = String(frame.title ?? "");
    const options = (Array.isArray(frame.options) ? frame.options : []) as string[];
    const toolName = approvalToolName(title);
    if (toolName === null) {
      await this.answerQuestionSelect(id, title, options, frame);
      return;
    }
    await this.answerApproval(id, toolName, options);
  }

  private answerUi(id: string, payload: Wire): void {
    this.transport.write({ type: "extension_ui_response", id, ...payload });
  }

  /** `Approve`/`Deny` 를 고를 때 쓰는 이름 — 목록이 달라져도 첫/끝을 잡는다. */
  private pick(options: string[], want: "allow" | "deny"): string {
    const allow = options.find((option) => /^approve/i.test(option)) ?? options[0] ?? "Approve";
    const deny = options.find((option) => /^deny|^reject/i.test(option)) ?? options[1] ?? "Deny";
    return want === "allow" ? allow : deny;
  }

  private async answerApproval(id: string, toolName: string, options: string[]): Promise<void> {
    // bypass(바로 실행): 카드를 열지 않고 허용으로 답한다.
    if (this.currentModeId === BYPASS_MODE_ID) {
      this.answerUi(id, { value: this.pick(options, "allow") });
      return;
    }
    // 승인 frame 에는 인자가 없다 — 직전 어시스턴트 메시지가 실은 호출 중
    // 같은 이름의 첫 건이 이 승인의 주인이다. 목록에 없으면(재시도·복원 경로)
    // 제목만으로 카드를 연다: 인자 없는 카드가 잘못된 인자보다 낫다.
    const slot = this.pendingCalls.findIndex((call) => call.name === toolName);
    const call = slot === -1 ? null : this.pendingCalls.splice(slot, 1)[0];
    const args = call?.args ?? {};
    const tool = classifyOmpTool(toolName, args);
    let verdict: PermissionVerdict;
    try {
      verdict = await this.hooks.decidePermission(tool, args, { signal: this.abort.signal });
    } catch {
      // 카드를 띄울 수 없으면(세션이 닫히는 중) 거절이 안전한 쪽이다.
      this.answerUi(id, { value: this.pick(options, "deny") });
      return;
    }
    this.answerUi(id, {
      value: this.pick(options, verdict.behavior === "allow" ? "allow" : "deny"),
    });
  }

  /**
   * 승인이 아닌 select — `ask` 도구다(rpc-ui 에서만 산다). 한 번에 질문
   * 하나씩 오므로 카드도 한 줄짜리 질문이 된다; 답은 질문 글자를 키로 돌아온다
   * (웹의 질문 카드 규약).
   */
  private async answerQuestionSelect(
    id: string,
    title: string,
    options: string[],
    frame: Wire,
  ): Promise<void> {
    const details = (Array.isArray(frame.optionDetails) ? frame.optionDetails : []) as Wire[];
    const question: AskQuestion = {
      question: title,
      header: "질문",
      multiSelect: false,
      options: options.map((label, index) => ({
        label,
        description: String(details[index]?.description ?? ""),
      })),
    };
    let verdict: PermissionVerdict;
    try {
      verdict = await this.hooks.decidePermission(
        { kind: "question", name: "ask" },
        { questions: [question] },
        { signal: this.abort.signal },
      );
    } catch {
      this.answerUi(id, { cancelled: true });
      return;
    }
    if (verdict.behavior !== "allow") {
      this.answerUi(id, { cancelled: true });
      return;
    }
    const answers = (verdict.updatedInput.answers ?? {}) as Record<string, string | string[]>;
    const answer = answers[title];
    const value = Array.isArray(answer) ? answer[0] : answer;
    if (typeof value === "string" && options.includes(value)) this.answerUi(id, { value });
    else this.answerUi(id, { cancelled: true });
  }

  // -------------------------------------------------------------------------
  // Host tools — the browser toolset, answered in-process
  // -------------------------------------------------------------------------

  private async onHostToolCall(frame: Wire): Promise<void> {
    const id = typeof frame.id === "string" ? frame.id : null;
    if (!id) return;
    const name = String(frame.toolName ?? "");
    const tool = BROWSER_TOOLS.find((candidate) => candidate.name === name);
    const relay = this.launch.browserMcp;
    if (!tool || !relay) {
      this.transport.write({
        type: "host_tool_result",
        id,
        isError: true,
        result: refused(`알 수 없는 호스트 도구: ${name || "(이름 없음)"}`),
      });
      return;
    }
    const controller = new AbortController();
    this.hostCalls.set(id, controller);
    try {
      const outcome = await callBrowserTool(tool, (frame.arguments ?? {}) as Wire, {
        daemonUrl: relay.env.COLO_DAEMON_URL ?? "",
        secret: relay.env.COLO_BROWSER_SECRET ?? "",
      });
      if (controller.signal.aborted || this.closed) return;
      this.transport.write({
        type: "host_tool_result",
        id,
        result: outcome,
        ...(outcome.isError ? { isError: true } : {}),
      });
    } finally {
      this.hostCalls.delete(id);
    }
  }

  private dropPending(toolCallId: string): void {
    const slot = this.pendingCalls.findIndex((call) => call.id === toolCallId);
    if (slot !== -1) this.pendingCalls.splice(slot, 1);
  }

  private onTransportEnd(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    // 턴 도중에 죽은 파이프는 성공이 아니다 — 테이프가 무슨 일이 있었는지
    // 적도록 실패로 표시한 뒤 턴을 닫는다.
    if (this.turnActive && this.turnFailure === null) {
      this.turnFailure = "omp 프로세스가 턴 도중에 끊겼습니다.";
    }
    this.endTurn();
    this.hooks.onTransportEnd(null);
  }
}

/**
 * 런치 argv. 승인 모드가 always-ask 로 고정인 이유는 위 BYPASS 주석에 —
 * rpc 에는 모드를 바꾸는 명령이 없고, 데몬이 모든 쓰기·실행 승인을 봐야
 * 쓰기 정책(클론 밖 거절)이 집행되기 때문이다. 읽기는 티어 규칙이 조용히
 * 통과시키므로 카드 소음이 되지 않는다.
 */
function ompArgs(launch: LaunchConfig): string[] {
  const args = ["--mode", "rpc-ui", "--approval-mode", "always-ask", "--cwd", launch.cwd];
  const resume = typeof launch.resume === "string" ? launch.resume : null;
  if (resume) {
    // 절단 없는 분기는 "전부 남긴다" — `--fork` 가 대화록을 통째로 새 id 로
    // 복사한다(검증됨). 절단이 있으면 옛 세션을 열고 handshake 의 `branch` 가
    // 자른다.
    const wholeFork = launch.forkSession === true && typeof launch.resumeDropsTurn !== "string";
    args.push(wholeFork ? "--fork" : "--resume", resume);
  }
  // `--model` 은 퍼지 매칭이라 "provider/id" 도 맨 id 도 받는다.
  if (launch.model) args.push("--model", launch.model);
  if (launch.effort) args.push("--thinking", launch.effort);
  if (launch.appendSystemPrompt) args.push("--append-system-prompt", launch.appendSystemPrompt);
  return args;
}

function toolContent(result: unknown): unknown {
  const content = (result as Wire)?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((block: Wire) => block?.type === "text" && typeof block.text === "string")
      .map((block: Wire) => block.text)
      .join("\n");
    if (text) return text;
  }
  return result ?? null;
}

function mapCommands(raw: unknown): SessionCommand[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Wire[]).map((command) => ({
    name: String(command.name ?? ""),
    description: String(command.description ?? ""),
    argumentHint: String(command.input?.hint ?? ""),
    aliases: Array.isArray(command.aliases) ? command.aliases.map(String) : [],
  }));
}
