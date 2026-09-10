import type { ChatEvent, PermissionMode } from "@cds-design/protocol";

/**
 * Turns raw SDKMessage values into the small, UI-shaped ChatEvent union.
 *
 * Stateful because streaming text arrives as deltas that must be grouped into
 * blocks, and the block index is only meaningful relative to the message that
 * started. Sequence numbers are tracked per agent (`parent_tool_use_id`) so a
 * subagent's messages never renumber the main thread's blocks.
 */
export class MessageTranslator {
  private seqByAgent = new Map<string | null, number>();
  /**
   * The id of the message currently streaming, per agent. Block ids have to
   * survive the gap between the deltas and the aggregated assistant message
   * that repeats the same content: if the two disagree, the UI renders every
   * sentence twice. The message id is the only key both sides carry, and the
   * sequence counter is the fallback for a stream that never announced one.
   */
  private messageIdByAgent = new Map<string | null, string | null>();

  private nextSeq(agentId: string | null): number {
    const next = (this.seqByAgent.get(agentId) ?? 0) + 1;
    this.seqByAgent.set(agentId, next);
    return next;
  }

  private currentSeq(agentId: string | null): number {
    return this.seqByAgent.get(agentId) ?? 0;
  }

  private blockId(agentId: string | null, index: number, messageId?: string | null): string {
    const scope = agentId ?? "main";
    const id = messageId ?? this.messageIdByAgent.get(agentId) ?? null;
    return id ? `${scope}:${id}:b${index}` : `${scope}:m${this.currentSeq(agentId)}:b${index}`;
  }

  translate(message: unknown): ChatEvent[] {
    const m = message as Record<string, any>;
    switch (m?.type) {
      case "system":
        return this.system(m);
      case "stream_event":
        return this.streamEvent(m);
      case "assistant":
        return this.assistant(m);
      case "user":
        return this.user(m);
      case "result":
        return this.result(m);
      default:
        return [];
    }
  }

  private system(m: Record<string, any>): ChatEvent[] {
    if (m.subtype === "init") {
      return [
        {
          kind: "init",
          sessionId: String(m.session_id),
          model: String(m.model ?? ""),
          cwd: String(m.cwd ?? ""),
          tools: Array.isArray(m.tools) ? m.tools.map(String) : [],
          apiKeySource: String(m.apiKeySource ?? "unknown"),
          permissionMode: (m.permissionMode ?? "default") as PermissionMode,
        },
      ];
    }
    if (m.subtype === "api_retry") {
      return [
        {
          kind: "retry",
          attempt: Number(m.attempt ?? 0),
          maxRetries: Number(m.max_retries ?? 0),
          delayMs: Number(m.retry_delay_ms ?? 0),
          error: String(m.error ?? "unknown"),
        },
      ];
    }
    if (m.subtype === "compact_boundary") {
      return [{ kind: "compact", trigger: String(m.compact_metadata?.trigger ?? "auto") }];
    }
    if (m.subtype === "permission_denied") {
      return [
        {
          kind: "notice",
          level: "warn",
          text: `Permission denied for ${String(m.tool_name ?? "a tool")}`,
        },
      ];
    }
    if (m.subtype === "local_command_output") {
      // A /command the planner ran from the composer; its text is the answer.
      return [{ kind: "notice", level: "info", text: String(m.content ?? "") }];
    }
    return [];
  }

  private streamEvent(m: Record<string, any>): ChatEvent[] {
    const agentId: string | null = m.parent_tool_use_id ?? null;
    const ev = m.event as Record<string, any> | undefined;
    if (!ev) return [];

    if (ev.type === "message_start") {
      this.nextSeq(agentId);
      const id = (ev.message as Record<string, any> | undefined)?.id;
      this.messageIdByAgent.set(agentId, typeof id === "string" ? id : null);
      return [];
    }
    if (ev.type === "content_block_delta") {
      // Deltas can be the first thing we see: older CLI builds and subagent
      // streams skip `message_start`. Open a group here or the aggregated
      // message will key its blocks differently and duplicate the text.
      if (this.currentSeq(agentId) === 0) this.nextSeq(agentId);
      const index = Number(ev.index ?? 0);
      const delta = ev.delta as Record<string, any> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return [
          { kind: "text.delta", blockId: this.blockId(agentId, index), text: delta.text, agentId },
        ];
      }
      if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        return [
          {
            kind: "thinking.delta",
            blockId: this.blockId(agentId, index),
            text: delta.thinking,
            agentId,
          },
        ];
      }
    }
    return [];
  }

  private assistant(m: Record<string, any>): ChatEvent[] {
    const agentId: string | null = m.parent_tool_use_id ?? null;
    const content = m.message?.content;
    if (!Array.isArray(content)) return [];
    const messageId = typeof m.message?.id === "string" ? (m.message.id as string) : null;
    // An assistant message with no preceding stream (subagents, or partial
    // messages disabled) still needs a key for its blocks.
    if (!messageId && this.currentSeq(agentId) === 0) this.nextSeq(agentId);

    const out: ChatEvent[] = [];
    content.forEach((block: Record<string, any>, index: number) => {
      if (block?.type === "text" && typeof block.text === "string") {
        out.push({
          kind: "text.done",
          blockId: this.blockId(agentId, index, messageId),
          text: block.text,
          agentId,
        });
      } else if (block?.type === "tool_use") {
        out.push({
          kind: "tool.start",
          toolUseId: String(block.id),
          name: String(block.name),
          input: block.input,
          agentId,
        });
      }
    });
    return out;
  }

  private user(m: Record<string, any>): ChatEvent[] {
    const agentId: string | null = m.parent_tool_use_id ?? null;
    const content = m.message?.content;
    if (!Array.isArray(content)) return [];
    const out: ChatEvent[] = [];
    for (const block of content as Record<string, any>[]) {
      if (block?.type === "tool_result") {
        out.push({
          kind: "tool.end",
          toolUseId: String(block.tool_use_id),
          isError: Boolean(block.is_error),
          content: block.content,
          agentId,
        });
      }
    }
    return out;
  }

  private result(m: Record<string, any>): ChatEvent[] {
    return [
      {
        kind: "turn.end",
        subtype: String(m.subtype ?? "unknown"),
        isError: Boolean(m.is_error),
        costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
        numTurns: typeof m.num_turns === "number" ? m.num_turns : null,
        durationMs: typeof m.duration_ms === "number" ? m.duration_ms : null,
        resultText: typeof m.result === "string" ? m.result : null,
      },
    ];
  }
}

/**
 * Rebuild a stored transcript as ChatEvents so the UI can show a past session.
 *
 * Separate from the live translator on purpose. A live session streams text and
 * thinking as deltas and the daemon echoes the user's own turn itself; a stored
 * transcript instead holds every block already complete, so replaying it
 * through the streaming path would either duplicate turns or drop reasoning.
 */
export function replayHistory(messages: unknown[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  let seq = 0;

  for (const raw of messages) {
    const m = raw as Record<string, any>;
    const agentId: string | null = m?.parent_tool_use_id ?? null;
    const content = m?.message?.content;

    if (m?.type === "user") {
      // Claude Code writes its own interruption and reminder turns as user
      // messages. Showing them as the person's words would be misleading.
      const synthetic = Boolean(m.isSynthetic);

      if (typeof content === "string") {
        if (content.trim()) {
          out.push(
            synthetic
              ? { kind: "notice", level: "info", text: content }
              : { kind: "user.echo", text: content, images: 0, files: [] },
          );
        }
        continue;
      }
      if (!Array.isArray(content)) continue;

      const text = content
        .filter((b: Record<string, any>) => b?.type === "text" && typeof b.text === "string")
        .map((b: Record<string, any>) => b.text)
        .join("\n");
      const images = content.filter((b: Record<string, any>) => b?.type === "image").length;

      if (text.trim() || images > 0) {
        out.push(
          synthetic
            ? { kind: "notice", level: "info", text: text || `${images} image(s)` }
            : { kind: "user.echo", text, images, files: [] },
        );
      }
      for (const block of content as Record<string, any>[]) {
        if (block?.type === "tool_result") {
          out.push({
            kind: "tool.end",
            toolUseId: String(block.tool_use_id),
            isError: Boolean(block.is_error),
            content: block.content,
            agentId,
          });
        }
      }
      continue;
    }

    if (m?.type === "assistant") {
      if (!Array.isArray(content)) continue;
      seq += 1;
      content.forEach((block: Record<string, any>, index: number) => {
        const blockId = `${agentId ?? "main"}:replay${seq}:b${index}`;
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          out.push({ kind: "text.done", blockId, text: block.text, agentId });
        } else if (block?.type === "thinking" && typeof block.thinking === "string") {
          out.push({ kind: "thinking.delta", blockId, text: block.thinking, agentId });
        } else if (block?.type === "tool_use") {
          out.push({
            kind: "tool.start",
            toolUseId: String(block.id),
            name: String(block.name),
            input: block.input,
            agentId,
          });
        }
      });
    }
  }

  return out;
}
