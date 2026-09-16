import type { ContextUsage, SessionCommand, SessionModelInfo } from "@colo-design/protocol";
import type { AgentSession, DriverHooks, LaunchConfig, SessionHandle, Turn } from "../../driver.js";
import { OmpTransport } from "./transport.js";

/** The omp wire shapes this driver reads — kept loose, the protocol evolves. */
type Wire = Record<string, any>;

/**
 * An AgentSession over the omp RPC protocol: one child process per
 * session, JSONL commands on stdin, events on stdout. The handshake is just
 * `get_state` — omp emits a `ready` frame we need not wait for — so calls
 * made early queue behind `ready` and the core session never sees the gap.
 *
 * Turn model: `prompt` resolves on acceptance; the turn's end is the
 * `agent_end` event with `willRetry` unset — retries and queued
 * continuations settle inside it. `abort` interrupts; `steer`/`follow_up`
 * carry mid-turn input.
 */
export class OmpAgentSession implements AgentSession {
  private readonly transport: OmpTransport;
  private readonly ready: Promise<void>;
  private vendorSessionId: string | null = null;
  private closed = false;
  private turnStartedAt = 0;
  private turnActive = false;
  private turnFailed: string | null = null;
  private turnCostUsd: number | null = null;
  private currentModel: string | null = null;
  private availableCommands: SessionCommand[] = [];
  private messageSeq = 0;
  private currentMessageId = "m0";
  private readonly launch: LaunchConfig;

  constructor(
    command: string,
    launch: LaunchConfig,
    private readonly hooks: DriverHooks,
  ) {
    this.launch = launch;
    const args = ["--mode", "rpc"];
    const resumeId = typeof launch.resume === "string" ? launch.resume : null;
    if (resumeId) args.push("--session", resumeId);
    if (launch.model) args.push("--model", launch.model);
    if (launch.effort) args.push("--thinking", launch.effort);
    if (launch.appendSystemPrompt) args.push("--append-system-prompt", launch.appendSystemPrompt);
    this.transport = new OmpTransport(command, args, launch.cwd, {
      onEvent: (frame) => this.onAgentEvent(frame),
      onUiRequest: () => Promise.resolve({ cancelled: true }),
      onEnd: (code) => this.onTransportEnd(code),
    });
    this.ready = this.handshake();
  }

  handle(): SessionHandle {
    return { provider: "omp", vendorSessionId: this.vendorSessionId ?? "" };
  }
  private async handshake(): Promise<void> {
    // 되감기의 fork: the process opened the OLD session via --session; the
    // fork command cuts it at the dropped prompt's entry and switches this
    // process to the new file. `get_state` then names the fork's own id.
    const forkAt =
      this.launch.forkSession === true && typeof this.launch.resumeSessionAt === "string"
        ? this.launch.resumeSessionAt
        : null;
    if (forkAt) {
      await this.transport.command("branch", { entryId: forkAt });
    }
    const state = (await this.transport.command("get_state")) as Wire;
    this.vendorSessionId = typeof state.sessionId === "string" ? state.sessionId : null;
    const model = (state.model ?? null) as Wire | null;
    this.currentModel = model?.id ? String(model.id) : this.launch.model;
    this.hooks.onEvent({
      kind: "init",
      sessionId: this.vendorSessionId ?? this.launch.sessionId,
      model: this.currentModel ?? "default",
      cwd: this.launch.cwd,
      tools: [],
      apiKeySource: "none",
      permissionMode: this.launch.modeId || "default",
    });
  }

  // -------------------------------------------------------------------------
  // AgentSession
  // -------------------------------------------------------------------------

  async send(turn: Turn): Promise<void> {
    await this.ready;
    if (this.closed || !this.transport.alive) throw new Error("omp transport closed");
    this.turnStartedAt = Date.now();
    this.turnActive = true;
    this.turnFailed = null;
    this.turnCostUsd = null;
    try {
      await this.transport.command("prompt", {
        message: turn.text,
        ...(turn.images?.length
          ? {
              images: turn.images.map((image) => ({
                type: "image",
                data: image.data,
                mimeType: image.mediaType,
              })),
            }
          : {}),
        // Accepted while streaming = queued as a follow-up; the daemon's own
        // queue normally keeps this from mattering.
        streamingBehavior: "followUp",
      });
    } catch (error) {
      this.turnActive = false;
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
    }
  }

  /** Mid-turn input — omp's own steer queue, delivered between tool rounds. */
  async steer(turn: Turn): Promise<void> {
    await this.ready;
    await this.transport.command("steer", {
      message: turn.text,
      ...(turn.images?.length
        ? {
            images: turn.images.map((image) => ({
              type: "image",
              data: image.data,
              mimeType: image.mediaType,
            })),
          }
        : {}),
    });
  }

  async interrupt(): Promise<"answered" | "timeout" | "dead"> {
    if (!this.transport.alive) return "dead";
    try {
      await this.transport.command("abort");
      return "answered";
    } catch {
      return "dead";
    }
  }

  async setMode(_modeId: string): Promise<void> {
    // omp has no permission modes — tools run as configured. The chip
    // shows a single "default" row; switching is a no-op.
    await this.ready;
  }

  async setModel(id: string | null): Promise<void> {
    await this.ready;
    if (id === null) return;
    // The picker's value is "provider/modelId" when the catalog said so.
    const slash = id.indexOf("/");
    const provider = slash > 0 ? id.slice(0, slash) : "";
    const modelId = slash > 0 ? id.slice(slash + 1) : id;
    await this.transport.command("set_model", { provider, modelId });
    this.currentModel = id;
  }

  async setEffort(effort: string | null): Promise<void> {
    await this.ready;
    if (effort === null) return;
    await this.transport.command("set_thinking_level", { level: effort });
  }

  async setFastMode(on: boolean): Promise<void> {
    await this.ready;
    await this.transport.command("set_fast_mode", { enabled: on });
  }

  async modes(): Promise<Array<{ id: string; label: string; description?: string }> | null> {
    return [{ id: "default", label: "Default" }];
  }

  async commands(): Promise<SessionCommand[]> {
    await this.ready;
    if (this.availableCommands.length === 0) {
      try {
        const data = (await this.transport.command("get_available_commands")) as Wire;
        this.availableCommands = this.mapCommands(data?.commands);
      } catch {
        // No palette is better than a wrong one.
      }
    }
    return this.availableCommands;
  }

  async models(): Promise<SessionModelInfo[]> {
    await this.ready;
    try {
      const data = (await this.transport.command("get_available_models")) as Wire;
      const rows = Array.isArray(data?.models) ? (data.models as Wire[]) : [];
      return rows.map((m) => {
        const provider = String(m.provider ?? "");
        const modelId = String(m.id ?? m.name ?? "");
        const value = provider && modelId ? `${provider}/${modelId}` : modelId;
        const thinking = (m.thinking ?? null) as Wire | null;
        const efforts = Array.isArray(thinking?.efforts)
          ? (thinking.efforts as unknown[]).map(String)
          : null;
        return {
          value,
          displayName: String(m.name ?? modelId),
          resolvedModel: modelId || null,
          description: "",
          supportsEffort: m.reasoning === true,
          supportedEffortLevels: efforts as SessionModelInfo["supportedEffortLevels"],
          supportsFastMode: true,
        };
      });
    } catch {
      return [];
    }
  }

  async contextUsage(): Promise<ContextUsage | null> {
    await this.ready;
    try {
      const stats = (await this.transport.command("get_session_stats")) as Wire;
      const usage = (stats?.contextUsage ?? null) as Wire | null;
      const tokens = stats?.tokens as Wire | undefined;
      const cost = typeof stats?.cost === "number" ? stats.cost : null;
      const used = Number(usage?.tokens ?? tokens?.total ?? 0);
      const size = Number(usage?.contextWindow ?? 0);
      return {
        totalTokens: used,
        maxTokens: size,
        percentage: size > 0 ? Math.min(100, Math.round((used / size) * 100)) : 0,
        sessionCostUsd: cost,
        model: this.currentModel ?? "",
        plan: null,
      };
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  // -------------------------------------------------------------------------
  // Agent → client events
  // -------------------------------------------------------------------------

  private onAgentEvent(frame: Wire): void {
    switch (frame?.type) {
      case "ready":
        // omp's greeting — protocol version negotiation is optional; v1 is fine.
        break;
      case "message_start":
        this.currentMessageId = `m${++this.messageSeq}`;
        break;
      case "message_update":
        this.onMessageUpdate(frame);
        break;
      case "message_end":
        this.onMessageEnd(frame);
        break;
      case "tool_execution_start":
        this.hooks.onEvent({
          kind: "tool.start",
          toolUseId: String(frame.toolCallId ?? `t${this.messageSeq}`),
          name: String(frame.toolName ?? "tool"),
          input: (frame.args ?? {}) as Record<string, unknown>,
          agentId: null,
        });
        break;
      case "tool_execution_end":
        this.hooks.onEvent({
          kind: "tool.end",
          toolUseId: String(frame.toolCallId ?? ""),
          isError: frame.isError === true,
          content: this.toolContent(frame.result),
          agentId: null,
        });
        break;
      case "agent_end":
        // willRetry means a transient-error retry is still coming — not
        // the end yet. agent_settled is kept for older builds that emit it.
        if (frame.willRetry !== true) this.endTurn();
        break;
      case "agent_settled":
        this.endTurn();
        break;
      case "compaction_start":
        this.hooks.onEvent({ kind: "compact", trigger: String(frame.reason ?? "auto") });
        break;
      case "available_commands_update":
        this.availableCommands = this.mapCommands(frame.commands);
        break;
      case "extension_error":
        this.hooks.onEvent({
          kind: "notice",
          level: "warn",
          text: String(frame.error ?? "extension error"),
        });
        break;
      default:
        break;
    }
  }

  private onMessageUpdate(frame: Wire): void {
    const delta = frame.assistantMessageEvent as Wire | undefined;
    if (!delta) return;
    const blockId = `${this.currentMessageId}:c${Number(delta.contentIndex ?? 0)}`;
    if (delta.type === "text_delta" && typeof delta.delta === "string") {
      this.hooks.onEvent({ kind: "text.delta", blockId, text: delta.delta, agentId: null });
    } else if (delta.type === "thinking_delta" && typeof delta.delta === "string") {
      this.hooks.onEvent({ kind: "thinking.delta", blockId, text: delta.delta, agentId: null });
    }
    // toolcall_* deltas are covered by tool_execution_* — richer and keyed
    // by toolCallId, so the tape never sees a half-parsed argument blob.
  }

  private onMessageEnd(frame: Wire): void {
    const message = frame.message as Wire | undefined;
    if (message?.role !== "assistant") return;
    const stop = String(message.stopReason ?? "");
    if (stop === "error" || stop === "aborted") {
      this.turnFailed =
        stop === "aborted" ? "aborted" : String(message.errorMessage ?? "turn failed");
    }
    const usage = message.usage as Wire | undefined;
    const cost = usage?.cost as Wire | undefined;
    if (typeof cost?.total === "number") this.turnCostUsd = cost.total;
  }

  private endTurn(): void {
    if (!this.turnActive) return;
    this.turnActive = false;
    const failed = this.turnFailed;
    this.turnFailed = null;
    const subtype =
      failed === "aborted" ? "interrupted" : failed ? "error_during_execution" : "success";
    this.hooks.onEvent({
      kind: "turn.end",
      subtype,
      isError: subtype === "error_during_execution",
      costUsd: this.turnCostUsd,
      numTurns: null,
      durationMs: Date.now() - this.turnStartedAt,
      resultText: failed && failed !== "aborted" ? failed : null,
    });
  }

  private toolContent(result: unknown): unknown {
    const content = (result as Wire)?.content;
    if (Array.isArray(content)) {
      const text = content
        .filter((c: Wire) => c?.type === "text" && typeof c.text === "string")
        .map((c: Wire) => c.text)
        .join("\n");
      if (text) return text;
    }
    return result ?? null;
  }

  private mapCommands(raw: unknown): SessionCommand[] {
    if (!Array.isArray(raw)) return [];
    return (raw as Wire[]).map((c) => ({
      name: String(c.name ?? ""),
      description: String(c.description ?? ""),
      argumentHint: String(c.input?.hint ?? c.argumentHint ?? ""),
      aliases: [],
    }));
  }

  private onTransportEnd(_code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    if (this.turnActive) this.endTurn();
    this.hooks.onTransportEnd(null);
  }
}
