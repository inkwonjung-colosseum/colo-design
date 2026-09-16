import type { ChatEvent, PermissionMode } from "@colo-design/protocol";
import { toolLabel } from "@colo-design/protocol";

/** A wire number, or 0 — nothing here invents a count the CLI did not send. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A non-empty wire string, or null. */
function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

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
      case "tool_progress":
        return this.toolProgress(m);
      case "prompt_suggestion": {
        // 턴이 끝난 뒤에야 온다(PLAN D99): result 뒤에도 스트림을 계속 읽는
        // 소비자만 받는다 — 데몬의 consume 루프가 바로 그것이다.
        const text = String(m.suggestion ?? "").trim();
        return text ? [{ kind: "suggestion", text }] : [];
      }
      case "conversation_reset":
        // `/clear` (팔레트의 `대화 새로 시작`): CLI 는 새 대화로 갈아탔다.
        // 기록은 일어난 일이라 남기되, 위의 말이 더는 Claude 의 기억이 아님을
        // 그 자리에 적는다 — 지우면 되감기의 k(프롬프트 순번)가 대화록과
        // 어긋나고, 안 적으면 계획자는 Claude 가 기억한다고 믿는다.
        return [
          {
            kind: "notice",
            level: "info",
            text: "대화를 새로 시작했습니다 — 여기서부터 Claude 는 위의 대화를 기억하지 않습니다.",
          },
        ];
      case "rate_limit_event": {
        // 한도의 변화는 즉시 읽어야 할 소식이다: 데몬이 이걸 받으면 요금 칩의
        // 다음 읽기를 앞당긴다(server). 기록에는 남기지 않는다.
        const info = (m.rate_limit_info ?? {}) as Record<string, any>;
        return [
          {
            kind: "ratelimit",
            status: str(info.status) ?? "allowed",
            resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : null,
          },
        ];
      }
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
      return [
        {
          kind: "compact",
          trigger: String(m.compact_metadata?.trigger ?? "auto"),
        },
      ];
    }
    if (m.subtype === "permission_denied") {
      // PLAN D36/D37: the planner reads an action name, not a tool name — the
      // same dictionary the transcript uses, or the two surfaces drift.
      const label = toolLabel(String(m.tool_name ?? ""));
      return [
        {
          kind: "notice",
          level: "warn",
          text: `${label} 요청이 허용되지 않았습니다`,
        },
      ];
    }
    if (m.subtype === "local_command_output") {
      // A /command the planner ran from the composer; its text is the answer.
      return [{ kind: "notice", level: "info", text: String(m.content ?? "") }];
    }
    if (m.subtype === "status") {
      const status = m.status;
      return [
        {
          kind: "status",
          status: status === "compacting" || status === "requesting" ? status : null,
        },
      ];
    }
    if (m.subtype === "task_started") {
      // 집안일(ambient · skip_transcript)은 활동이 아니다 — SDK 가 그렇게
      // 이름표를 달아 보내므로 여기서 끊는다.
      if (m.ambient || m.skip_transcript) return [];
      return [
        {
          kind: "task.start",
          taskId: String(m.task_id ?? ""),
          toolUseId: str(m.tool_use_id),
          description: String(m.description ?? ""),
          subagentType: str(m.subagent_type),
          backgrounded: Boolean(m.is_backgrounded),
        },
      ];
    }
    if (m.subtype === "task_progress") {
      const usage = (m.usage ?? {}) as Record<string, any>;
      return [
        {
          kind: "task.progress",
          taskId: String(m.task_id ?? ""),
          toolUseId: str(m.tool_use_id),
          description: String(m.description ?? ""),
          summary: str(m.summary),
          lastTool: str(m.last_tool_name),
          tokens: num(usage.total_tokens),
          toolUses: num(usage.tool_uses),
          durationMs: num(usage.duration_ms),
        },
      ];
    }
    if (m.subtype === "task_updated") {
      const patch = (m.patch ?? {}) as Record<string, any>;
      return [
        {
          kind: "task.update",
          taskId: String(m.task_id ?? ""),
          status: str(patch.status),
          backgrounded: typeof patch.is_backgrounded === "boolean" ? patch.is_backgrounded : null,
          error: str(patch.error),
        },
      ];
    }
    if (m.subtype === "task_notification") {
      if (m.ambient || m.skip_transcript) return [];
      const usage = m.usage as Record<string, any> | undefined;
      const status = m.status;
      return [
        {
          kind: "task.end",
          taskId: String(m.task_id ?? ""),
          toolUseId: str(m.tool_use_id),
          status: status === "failed" || status === "stopped" ? status : "completed",
          summary: String(m.summary ?? ""),
          tokens: usage ? num(usage.total_tokens) : null,
          toolUses: usage ? num(usage.tool_uses) : null,
          durationMs: usage ? num(usage.duration_ms) : null,
        },
      ];
    }
    if (m.subtype === "background_tasks_changed") {
      // REPLACE: 받은 목록이 곧 지금 살아 있는 전부다.
      const tasks = Array.isArray(m.tasks) ? (m.tasks as Record<string, any>[]) : [];
      return [
        {
          kind: "tasks",
          tasks: tasks
            .filter((task) => !task?.ambient)
            .map((task) => ({
              taskId: String(task?.task_id ?? ""),
              type: String(task?.task_type ?? ""),
              description: String(task?.description ?? ""),
            })),
        },
      ];
    }
    if (m.subtype === "model_refusal_fallback") {
      return [
        {
          kind: "notice",
          level: "info",
          text: "이 요청은 지금 모델이 답하지 않아 다른 모델로 이어서 답합니다.",
        },
      ];
    }
    if (m.subtype === "model_refusal_no_fallback") {
      return [
        {
          kind: "notice",
          level: "warn",
          text: "모델이 이 요청에 답하지 않았습니다 — 말을 바꿔 다시 보내면 이어집니다.",
        },
      ];
    }
    if (m.subtype === "informational") {
      // CLI 가 사람에게 하는 말 — 없으면 조용히 사라진다.
      const text = String(m.content ?? "").trim();
      return text ? [{ kind: "notice", level: "info", text }] : [];
    }
    if (m.subtype === "worker_shutting_down") {
      // 예고된 종료: 곧 스트림이 끝난다. 기록 이벤트가 아니라 세션이 읽는
      // 귀띔이다 — 이걸 들은 뒤의 끝은 고장이 아니라 종료다.
      return [{ kind: "shutdown", reason: String(m.reason ?? "unknown") }];
    }
    return [];
  }

  /**
   * 한 도구 호출이 도는 동안의 심장 박동 (PLAN D97). 도구 행이 스스로 몇 초째인지
   * 말하게 하는 유일한 소식이고, 서브에이전트의 재시도도 여기에만 실린다.
   */
  private toolProgress(m: Record<string, any>): ChatEvent[] {
    const toolUseId = str(m.tool_use_id);
    if (!toolUseId) return [];
    const retry = m.subagent_retry as Record<string, any> | undefined;
    return [
      {
        kind: "tool.progress",
        toolUseId,
        elapsedSeconds: num(m.elapsed_time_seconds),
        agentId: str(m.parent_tool_use_id),
        ...(retry
          ? {
              retry: {
                attempt: num(retry.attempt),
                maxRetries: num(retry.max_retries),
                delayMs: num(retry.retry_delay_ms),
              },
            }
          : {}),
      },
    ];
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
          {
            kind: "text.delta",
            blockId: this.blockId(agentId, index),
            text: delta.text,
            agentId,
          },
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
      } else if (block?.type === "thinking" && typeof block.thinking === "string") {
        // 서브에이전트의 생각은 stream_event 없이 이 메시지로만 온다
        // (`forwardSubagentText`, PLAN D98): 델타 한 번으로 통째로 올리고,
        // 턴 끝이 그 접힘을 정착시킨다 — 메인 스레드의 생각과 같은 길.
        out.push({
          kind: "thinking.delta",
          blockId: this.blockId(agentId, index, messageId),
          text: block.thinking,
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
