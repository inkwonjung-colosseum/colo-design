import type {
  ContextUsage,
  EffortLevel,
  SessionCommand,
  SessionModelInfo,
} from "@colo-design/protocol";
import { acpBrowserMcpServer } from "../../../browser-launch.js";
import type { AgentSession, DriverHooks, LaunchConfig, ToolClass, Turn } from "../../driver.js";
import { JsonRpcTransport } from "../../jsonrpc.js";

/** The ACP wire shapes this driver reads — kept loose, the spec evolves. */
type Wire = Record<string, any>;

interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string }>;
}

interface AcpModeInfo {
  id: string;
  name?: string;
  description?: string;
}

/**
 * An AgentSession over the Agent Client Protocol: one child process per
 * session, JSON-RPC on stdio. The handshake is async, so calls made before
 * `session/new` (or `session/resume`) resolves queue behind `ready` — the
 * core session is synchronous and must never see the gap.
 *
 * Turn model: `session/prompt` resolves when the turn ends, so `send`
 * awaits it and translates the result into `turn.end`. `session/cancel`
 * settles the in-flight prompt with `stopReason: "cancelled"`.
 */
export class AcpAgentSession implements AgentSession {
  private readonly transport: JsonRpcTransport;
  private readonly ready: Promise<void>;
  private vendorSessionId: string | null = null;
  private closed = false;
  private turnStartedAt = 0;
  private turnCostUsd: number | null = null;
  private lastUsage: { used: number; size: number; costUsd: number | null } | null = null;
  private configOptions: AcpConfigOption[] = [];
  private agentCapabilities: Wire = {};
  private readonly abort = new AbortController();
  private modeOptions: AcpModeInfo[] = [];
  private currentModeId: string;
  /** The agent's own effort value at session open — what `setEffort(null)` restores. */
  private initialEffort: string | null = null;
  private availableCommands: SessionCommand[] = [];
  private readonly toolCalls = new Map<string, Wire>();

  get alive(): boolean {
    return !this.closed && this.transport.alive;
  }
  private readonly launch: LaunchConfig;
  private instructionsSent = false;
  /** One `session/prompt` at a time — the wire forbids a second in flight. */
  private sendChain: Promise<void> = Promise.resolve();
  /**
   * Resolves when the in-flight `session/prompt` settles — session/cancel is
   * fire-and-forget, so interrupt waits on this to learn whether the agent
   * honoured the cancel before escalating.
   */
  private promptDone: Promise<void> | null = null;
  private markPromptDone: (() => void) | null = null;

  constructor(
    private readonly providerId: string,
    command: string,
    args: string[],
    launch: LaunchConfig,
    private readonly hooks: DriverHooks,
    private readonly wiring: {
      effortConfigId?: string;
      enrichModels?(rows: SessionModelInfo[]): SessionModelInfo[] | Promise<SessionModelInfo[]>;
    } = {},
  ) {
    this.launch = launch;
    this.currentModeId = launch.modeId || "default";
    this.transport = new JsonRpcTransport(command, args, launch.cwd, {
      onRequest: (method, params) => this.onAgentRequest(method, params),
      onNotify: (method, params) => this.onAgentNotify(method, params),
      onEnd: (code) => this.onTransportEnd(code),
    });
    const handshake = this.handshake();
    // 핸드셰이크 거절(initialize·session/new 타임아웃, loadSession 거부)은
    // 자식을 죽이지 않는다 — 그대로 두면 좀비 프로세스 위에서 alive 가 참으로
    // 남아 코어가 크래시로 표시하지 못하고 부활 경로도 영원히 못 탄다. 전송을
    // 끊고 거절을 전송 오류로 올려 크래시 기계가 닫게 한다. ready 자체는 원래
    // 거절을 유지해 뒤에 선 await 가 같은 사유를 받게 한다.
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
    const init = (await this.transport.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          // The agent keeps its own file tools — we only answer permissions.
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "colo-design", version: "0" },
      },
      15_000,
    )) as Wire;
    this.agentCapabilities = (init?.agentCapabilities ?? {}) as Wire;

    // ACP's session/new requires the field. 브라우저 도구(3단계): host가
    // 팩토리를 주입한 세션만 stdio 서버 하나를 실어 보낸다 — command는
    // 절대경로, args·env는 스키마상 생략 불가라 빌더가 채워 준다. 주입이
    // 없으면 (게이트 재배선 이후의 기본) 빈 배열 그대로다.
    const mcpServers: Wire[] = this.launch.browserMcp
      ? [acpBrowserMcpServer(this.launch.browserMcp)]
      : [];
    const resumeId = typeof this.launch.resume === "string" ? this.launch.resume : null;
    if (resumeId && this.agentCapabilities.loadSession === false) {
      throw new Error(`${this.providerId} 에이전트는 대화 재개를 지원하지 않습니다.`);
    }
    const created = (await this.transport.request(
      resumeId ? "session/resume" : "session/new",
      {
        cwd: this.launch.cwd,
        mcpServers,
        ...(resumeId ? { sessionId: resumeId } : {}),
      },
      30_000,
    )) as Wire;

    // `session/resume` answers without a sessionId — the resumed id IS the
    // vendor id; only `session/new` names a fresh one.
    this.vendorSessionId = resumeId ?? String(created?.sessionId ?? this.launch.sessionId);
    this.configOptions = (created?.configOptions ?? []) as AcpConfigOption[];
    const modes = created?.modes as Wire | undefined;
    this.modeOptions = (modes?.availableModes ?? []) as AcpModeInfo[];
    if (modes?.currentModeId) this.currentModeId = String(modes.currentModeId);

    // The model the session actually runs on — the config option's current
    // value, or the launch pin when the agent did not echo one.
    const modelOption = this.configOptions.find((o) => o.category === "model" || o.id === "model");
    const model = modelOption?.currentValue ?? this.launch.model ?? "default";

    this.hooks.onEvent({
      kind: "init",
      sessionId: this.vendorSessionId,
      model: String(model),
      cwd: this.launch.cwd,
      tools: [],
      apiKeySource: "none",
      permissionMode: this.currentModeId,
    });

    // Launch-time pins the agent did not already apply.
    if (this.launch.model && modelOption && this.launch.model !== modelOption.currentValue) {
      await this.setConfig("model", this.launch.model).catch(() => undefined);
    }
    if (this.launch.modeId && this.launch.modeId !== this.currentModeId) {
      // setMode's own `await this.ready` would deadlock here — this IS the
      // handshake — so the pin is applied inline with the same branch.
      try {
        if (this.modeOptions.length > 0) {
          await this.transport.request(
            "session/set_mode",
            { sessionId: this.vendorSessionId, modeId: this.launch.modeId },
            10_000,
          );
        } else {
          await this.setConfig("mode", this.launch.modeId);
        }
        this.currentModeId = this.launch.modeId;
      } catch {
        // A pin the agent refuses is not fatal — the session runs its own mode.
      }
    }
    // 노력 수준 핀 — 에이전트가 effort를 configOption으로 노출할 때만. null
    // 복원(setEffort(null))은 이 초기값으로 되돌린다.
    if (this.wiring.effortConfigId) {
      const effortOption = this.configOptions.find((o) => o.id === this.wiring.effortConfigId);
      this.initialEffort = effortOption?.currentValue ?? null;
      if (this.launch.effort && this.launch.effort !== this.initialEffort) {
        await this.setConfig(this.wiring.effortConfigId, this.launch.effort).catch(() => undefined);
      }
    }
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
    if (this.closed || !this.transport.alive) throw new Error("ACP transport closed");
    const sessionId = this.vendorSessionId;
    if (!sessionId) throw new Error("ACP session not established");

    const promptCaps = (this.agentCapabilities.promptCapabilities ?? {}) as Wire;
    if (turn.images?.length && promptCaps.image === false) {
      throw new Error(`${this.providerId} 에이전트는 이미지 입력을 지원하지 않습니다.`);
    }
    const prompt: Wire[] = [];
    // The app's instruction block rides as embedded context on the first
    // turn — ACP has no system-prompt field, and a resource block is the
    // spec's own channel for it.
    if (this.launch.appendSystemPrompt && !this.instructionsSent) {
      this.instructionsSent = true;
      prompt.push({
        type: "resource",
        resource: {
          uri: "colo-design://instructions",
          name: "instructions.md",
          mimeType: "text/markdown",
          text: this.launch.appendSystemPrompt,
        },
      });
    }
    prompt.push({ type: "text", text: turn.text });
    for (const image of turn.images ?? []) {
      prompt.push({ type: "image", data: image.data, mimeType: image.mediaType });
    }

    this.turnStartedAt = Date.now();
    this.turnCostUsd = null;
    this.promptDone = new Promise<void>((resolve) => {
      this.markPromptDone = resolve;
    });
    try {
      const result = (await this.transport.request("session/prompt", {
        sessionId,
        prompt,
      })) as Wire;
      this.endTurn(result);
    } catch (error) {
      if (this.closed) return;
      this.hooks.onEvent({
        kind: "turn.end",
        subtype: "error_during_execution",
        isError: true,
        costUsd: this.turnCostUsd,
        numTurns: null,
        durationMs: Date.now() - this.turnStartedAt,
        resultText: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.markPromptDone?.();
      this.markPromptDone = null;
      this.promptDone = null;
    }
  }

  private endTurn(result: Wire | null): void {
    const stopReason = String(result?.stopReason ?? "end_turn");
    const usage = result?.usage as Wire | undefined;
    if (usage) {
      const cost = usage.cost as Wire | number | undefined;
      this.lastUsage = {
        used: Number(usage.totalTokens ?? usage.inputTokens ?? 0),
        size: this.lastUsage?.size ?? 0,
        costUsd: typeof cost === "number" ? cost : (cost?.amount ?? null),
      };
      if (this.lastUsage.costUsd != null) this.turnCostUsd = this.lastUsage.costUsd;
    }
    const subtype =
      stopReason === "cancelled"
        ? "interrupted"
        : stopReason === "end_turn" || stopReason === "stop_sequence"
          ? "success"
          : stopReason === "max_tokens" || stopReason === "max_turn_requests"
            ? "error_max_turns"
            : stopReason === "refusal"
              ? "refusal"
              : "error_during_execution";
    this.hooks.onEvent({
      kind: "turn.end",
      subtype,
      isError: subtype.startsWith("error") || subtype === "refusal",
      costUsd: this.turnCostUsd,
      numTurns: null,
      durationMs: Date.now() - this.turnStartedAt,
      resultText: null,
    });
  }

  async interrupt(): Promise<"answered" | "timeout" | "dead"> {
    if (!this.alive) return "dead";
    if (!this.vendorSessionId) {
      // 부팅 창(initialize + session/new 는 수십 초 걸릴 수 있다)에는 아직
      // sessionId 가 없다 — 그걸 dead 로 읽으면 코어가 멀쩡히 뜨는 세션을
      // 닫아 버린다. codex 드라이버처럼 ready 를 기다리되, 짧은 유예로 묶어
      // 중지 버튼이 부팅만큼 잠기지 않게 한다.
      await Promise.race([
        this.ready,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]).catch(() => undefined);
      if (!this.alive) return "dead";
    }
    const sessionId = this.vendorSessionId;
    // 아직 부팅 중이면 취소할 프롬프트도 없다 — 그 자체가 답이다.
    if (!sessionId) return "answered";
    this.transport.notify("session/cancel", { sessionId });
    // session/cancel 은 fire-and-forget — 응하는 에이전트는 in-flight
    // session/prompt 를 stopReason "cancelled" 로 풀고, 그 해결이 곧 답이다.
    // 유예 안에 풀리지 않으면 wedged — 프롬프트가 sendChain 을 영원히 막기
    // 전에 전송을 끊어 크래시 기계가 닫게 한다(claude 의 interrupt 유예와
    // 같은 5초).
    const settled = await Promise.race([
      this.promptDone ?? Promise.resolve(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    if (settled === "timeout") {
      this.transport.close();
      return "timeout";
    }
    // 유예 안에 풀렸어도 전송이 죽어 풀린 거면 answered 가 아니다 — dead 를
    // 돌려 코어가 크래시 상태를 idle 로 덮지 않고 닫게 한다(codex 의
    // turnSettlers 가 전송 종료에 dead 로 푸는 것과 같은 판정).
    if (!this.alive) return "dead";
    return "answered";
  }

  async setMode(modeId: string): Promise<void> {
    await this.ready;
    const sessionId = this.vendorSessionId;
    if (!sessionId) return;
    if (this.modeOptions.length > 0) {
      await this.transport.request("session/set_mode", { sessionId, modeId }, 10_000);
    } else {
      await this.setConfig("mode", modeId);
    }
    this.currentModeId = modeId;
  }

  async setModel(id: string | null): Promise<void> {
    await this.ready;
    if (id === null) return; // ACP has no "back to default" — keep the pin.
    await this.setConfig("model", id);
  }

  /** Effective from the next response. `null` restores the agent's own open value. */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    if (!this.wiring.effortConfigId) {
      throw new Error("이 에이전트는 노력 수준을 지원하지 않습니다.");
    }
    await this.ready;
    const value = effort ?? this.initialEffort;
    if (value === null) return;
    await this.setConfig(this.wiring.effortConfigId, value);
  }

  async modes(): Promise<Array<{ id: string; label: string; description?: string }> | null> {
    await this.ready;
    if (this.modeOptions.length > 0) {
      return this.modeOptions.map((m) => ({
        id: m.id,
        label: m.name ?? m.id,
        ...(m.description ? { description: m.description } : {}),
      }));
    }
    const option = this.configOptions.find((o) => o.category === "mode" || o.id === "mode");
    if (option?.options?.length) {
      return option.options.map((o) => ({
        id: o.value,
        label: o.name ?? o.value,
        ...(o.description ? { description: o.description } : {}),
      }));
    }
    return null;
  }

  async models(): Promise<SessionModelInfo[]> {
    await this.ready;
    const option = this.configOptions.find((o) => o.category === "model" || o.id === "model");
    if (!option?.options?.length) return [];
    const rows = option.options.map((o) => ({
      value: o.value,
      displayName: o.name ?? o.value,
      resolvedModel: o.value,
      description: o.description ?? "",
      supportsEffort: false,
      supportedEffortLevels: null,
      supportsFastMode: false,
    }));
    // configOptions는 어떤 모델이 있는지는 알지만 모델별 특성(노력 수준 등)은
    // 모를 때가 많다 — 설정이 자기 세션 없는 출처에서 되찾아 준다.
    return this.wiring.enrichModels ? await this.wiring.enrichModels(rows) : rows;
  }

  async commands(): Promise<SessionCommand[]> {
    await this.ready;
    return this.availableCommands;
  }

  async contextUsage(): Promise<ContextUsage | null> {
    await this.ready;
    if (!this.lastUsage) return null;
    const { used, size, costUsd } = this.lastUsage;
    return {
      totalTokens: used,
      maxTokens: size,
      percentage: size > 0 ? Math.min(100, Math.round((used / size) * 100)) : 0,
      sessionCostUsd: costUsd,
      model: this.launch.model ?? "",
      plan: null,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    const sessionId = this.vendorSessionId;
    if (sessionId && this.transport.alive) {
      // session/close is a courtesy — the process dies either way.
      await this.transport.request("session/close", { sessionId }, 5_000).catch(() => undefined);
    }
    this.transport.close();
  }

  // -------------------------------------------------------------------------
  // Agent → client traffic
  // -------------------------------------------------------------------------

  private async setConfig(configId: string, value: string): Promise<void> {
    const sessionId = this.vendorSessionId;
    if (!sessionId) return;
    const result = (await this.transport.request(
      "session/set_config_option",
      {
        sessionId,
        configId,
        value,
      },
      10_000,
    )) as Wire;
    if (Array.isArray(result?.configOptions)) {
      this.configOptions = result.configOptions as AcpConfigOption[];
    }
  }

  private async onAgentRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      return await this.answerPermission(params as Wire);
    }
    // fs/* and terminal/* are unimplemented on purpose — the client
    // capabilities we advertise say so, and an agent that asks anyway gets
    // a method-not-found rather than a silent wrong answer.
    throw new Error(`Unsupported client method: ${method}`);
  }

  private async answerPermission(params: Wire): Promise<unknown> {
    const toolCall = (params?.toolCall ?? {}) as Wire;
    const options = (params?.options ?? []) as Wire[];
    const tool = this.classifyTool(toolCall);
    const input = (toolCall.rawInput ?? {}) as Record<string, unknown>;

    const verdict = await this.hooks.decidePermission(tool, input, {
      signal: this.abort.signal,
      // The option list rides as suggestions so the card can offer
      // "always allow" only when the agent actually has such an option.
      suggestions: options,
    });

    if (verdict.behavior === "deny") {
      const reject =
        options.find((o) => o.kind === "reject_once") ??
        options.find((o) => /reject|deny/i.test(String(o.kind ?? o.optionId ?? "")));
      return {
        outcome: { outcome: "selected", optionId: String(reject?.optionId ?? "reject") },
      };
    }
    // 항상 허용 echoes the options back through updatedPermissions — its
    // presence is the signal that the planner picked the durable answer.
    const always = verdict.updatedPermissions !== undefined;
    const pick =
      (always ? options.find((o) => o.kind === "allow_always") : undefined) ??
      options.find((o) => o.kind === "allow_once") ??
      options.find((o) => /allow/i.test(String(o.kind ?? o.optionId ?? "")));
    return {
      outcome: { outcome: "selected", optionId: String(pick?.optionId ?? "allow") },
    };
  }

  /** ACP tool kinds → the core's normalized classes. */
  private classifyTool(toolCall: Wire): ToolClass {
    const kind = String(toolCall.kind ?? "");
    const name = String(toolCall.title ?? toolCall.kind ?? "tool");
    const paths = Array.isArray(toolCall.locations)
      ? toolCall.locations.map((l: Wire) => String(l?.path ?? "")).filter(Boolean)
      : [];
    const rawInput = (toolCall.rawInput ?? {}) as Record<string, unknown>;
    switch (kind) {
      case "edit":
      case "delete":
      case "move":
        return { kind: "edit", name, paths };
      case "execute":
        return {
          kind: "exec",
          name,
          command: String(rawInput.command ?? rawInput.cmd ?? ""),
        };
      case "read":
      case "search":
      case "fetch":
        return { kind: "read", name, paths };
      default:
        return { kind: "other", name, paths };
    }
  }

  private onAgentNotify(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const update = (params as Wire)?.update as Wire | undefined;
    if (!update) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.onChunk(update, "text.delta");
        break;
      case "agent_thought_chunk":
        this.onChunk(update, "thinking.delta");
        break;
      case "tool_call":
        this.onToolCall(update);
        break;
      case "tool_call_update":
        this.onToolCallUpdate(update);
        break;
      case "available_commands_update":
        this.availableCommands = ((update.availableCommands ?? []) as Wire[]).map((c) => ({
          name: String(c.name ?? ""),
          description: String(c.description ?? ""),
          argumentHint: "",
          aliases: [],
        }));
        break;
      case "current_mode_update":
        this.currentModeId = String(update.currentModeId ?? this.currentModeId);
        break;
      case "config_option_update":
        if (Array.isArray(update.configOptions)) {
          this.configOptions = update.configOptions as AcpConfigOption[];
        }
        break;
      case "usage_update": {
        const cost = update.cost as Wire | number | undefined;
        this.lastUsage = {
          used: Number(update.used ?? 0),
          size: Number(update.size ?? 0),
          costUsd:
            typeof cost === "number" ? cost : typeof cost?.amount === "number" ? cost.amount : null,
        };
        if (this.lastUsage.costUsd != null) this.turnCostUsd = this.lastUsage.costUsd;
        break;
      }
      default:
        break;
    }
  }

  /**
   * Text and thinking stream as chunks keyed by messageId — each chunk goes
   * out as a delta on the message's own block id.
   */
  private onChunk(update: Wire, kind: "text.delta" | "thinking.delta"): void {
    const messageId = String(update.messageId ?? "main");
    const text = String(update.content?.text ?? "");
    if (!text) return;
    this.hooks.onEvent({ kind, blockId: messageId, text, agentId: null });
  }

  private onToolCall(update: Wire): void {
    const id = String(update.toolCallId ?? "");
    if (!id) return;
    this.toolCalls.set(id, update);
    this.hooks.onEvent({
      kind: "tool.start",
      toolUseId: id,
      name: String(update.title ?? update.kind ?? "tool"),
      input: update.rawInput ?? {},
      agentId: null,
    });
  }

  private onToolCallUpdate(update: Wire): void {
    const id = String(update.toolCallId ?? "");
    if (!id) return;
    const status = String(update.status ?? "");
    if (status === "completed" || status === "failed") {
      const original = this.toolCalls.get(id) ?? {};
      const content = update.content ?? original.content ?? update.rawOutput ?? null;
      this.hooks.onEvent({
        kind: "tool.end",
        toolUseId: id,
        isError: status === "failed",
        content,
        agentId: null,
      });
      this.toolCalls.delete(id);
    }
  }

  private onTransportEnd(_code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.hooks.onTransportEnd(null);
  }
}
