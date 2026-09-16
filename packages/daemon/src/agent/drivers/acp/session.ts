import type { ContextUsage, SessionCommand, SessionModelInfo } from "@colo-design/protocol";
import type {
  AgentSession,
  DriverHooks,
  LaunchConfig,
  SessionHandle,
  ToolClass,
  Turn,
} from "../../driver.js";
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
  private modeOptions: AcpModeInfo[] = [];
  private currentModeId: string;
  private availableCommands: SessionCommand[] = [];
  private readonly toolCalls = new Map<string, Wire>();
  private readonly launch: LaunchConfig;
  private instructionsSent = false;

  constructor(
    private readonly providerId: string,
    command: string,
    args: string[],
    launch: LaunchConfig,
    private readonly hooks: DriverHooks,
  ) {
    this.launch = launch;
    this.currentModeId = launch.modeId || "default";
    this.transport = new JsonRpcTransport(command, args, launch.cwd, {
      onRequest: (method, params) => this.onAgentRequest(method, params),
      onNotify: (method, params) => this.onAgentNotify(method, params),
      onEnd: (code) => this.onTransportEnd(code),
    });
    this.ready = this.handshake();
  }

  handle(): SessionHandle {
    return { provider: this.providerId, vendorSessionId: this.vendorSessionId ?? "" };
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  private async handshake(): Promise<void> {
    await this.transport.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        // The agent keeps its own file tools — we only answer permissions.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "colo-design", version: "0" },
    });

    const mcpServers = Object.entries(this.launch.mcpServers ?? {}).map(([name, s]) => ({
      name,
      type: "http",
      url: s.url,
      headers: Object.entries(s.headers ?? {}).map(([k, v]) => ({ name: k, value: v })),
    }));

    const resumeId = typeof this.launch.resume === "string" ? this.launch.resume : null;
    const created = (await this.transport.request(resumeId ? "session/resume" : "session/new", {
      cwd: this.launch.cwd,
      mcpServers,
      ...(resumeId ? { sessionId: resumeId } : {}),
    })) as Wire;

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
      await this.setMode(this.launch.modeId).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // AgentSession
  // -------------------------------------------------------------------------

  async send(turn: Turn): Promise<void> {
    await this.ready;
    if (this.closed || !this.transport.alive) throw new Error("ACP transport closed");
    const sessionId = this.vendorSessionId;
    if (!sessionId) throw new Error("ACP session not established");

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
    if (!this.transport.alive) return "dead";
    const sessionId = this.vendorSessionId;
    if (!sessionId) return "dead";
    // The in-flight prompt resolves with stopReason "cancelled" — that IS
    // the answer; nothing further is waited on.
    this.transport.notify("session/cancel", { sessionId });
    return "answered";
  }

  async setMode(modeId: string): Promise<void> {
    await this.ready;
    const sessionId = this.vendorSessionId;
    if (!sessionId) return;
    if (this.modeOptions.length > 0) {
      await this.transport.request("session/set_mode", { sessionId, modeId });
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
    return option.options.map((o) => ({
      value: o.value,
      displayName: o.name ?? o.value,
      resolvedModel: o.value,
      description: o.description ?? "",
      supportsEffort: false,
      supportedEffortLevels: null,
      supportsFastMode: false,
    }));
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
    const sessionId = this.vendorSessionId;
    if (sessionId && this.transport.alive) {
      // session/close is a courtesy — the process dies either way.
      await this.transport.request("session/close", { sessionId }).catch(() => undefined);
    }
    this.transport.close();
  }

  // -------------------------------------------------------------------------
  // Agent → client traffic
  // -------------------------------------------------------------------------

  private async setConfig(configId: string, value: string): Promise<void> {
    const sessionId = this.vendorSessionId;
    if (!sessionId) return;
    const result = (await this.transport.request("session/set_config_option", {
      sessionId,
      configId,
      value,
    })) as Wire;
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
      signal: new AbortController().signal,
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
    this.hooks.onTransportEnd(null);
  }
}
