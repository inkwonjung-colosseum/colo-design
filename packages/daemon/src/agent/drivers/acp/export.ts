import type { ChatEvent } from "@colo-design/protocol";

type Wire = Record<string, unknown>;

/**
 * Rebuild an `opencode export` document as ChatEvents so the UI can show a
 * past session. The export holds whole messages with typed parts — text,
 * reasoning, tool calls — already complete, so like the Claude importer this
 * replays finished blocks rather than deltas.
 */
export function replayExport(doc: Wire): ChatEvent[] {
  const out: ChatEvent[] = [];
  const messages = Array.isArray(doc?.messages) ? (doc.messages as Wire[]) : [];

  for (const message of messages) {
    const info = (message?.info ?? {}) as Wire;
    const role = info.role;
    const messageId = String(info.id ?? info.messageID ?? `m${out.length}`);
    const parts = Array.isArray(message?.parts) ? (message.parts as Wire[]) : [];

    if (role === "user") {
      const text = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
      const images = parts.filter(
        (p) => p?.type === "file" && String((p as Wire).mime ?? "").startsWith("image/"),
      ).length;
      if (text.trim() || images > 0) {
        out.push({ kind: "user.echo", text, images });
      }
      continue;
    }

    if (role !== "assistant") continue;

    parts.forEach((part, index) => {
      const blockId = `main:${messageId}:b${index}`;
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        out.push({ kind: "text.done", blockId, text: part.text, agentId: null });
      } else if (part?.type === "reasoning" && typeof part.text === "string") {
        out.push({ kind: "thinking.delta", blockId, text: part.text, agentId: null });
      } else if (part?.type === "tool") {
        const callId = String(part.callID ?? part.id ?? blockId);
        const state = (part.state ?? {}) as Wire;
        out.push({
          kind: "tool.start",
          toolUseId: callId,
          name: String(part.tool ?? "tool"),
          input: state.input ?? {},
          agentId: null,
        });
        const status = String(state.status ?? "completed");
        if (status === "completed" || status === "error") {
          out.push({
            kind: "tool.end",
            toolUseId: callId,
            isError: status === "error",
            content: state.output ?? state.error ?? null,
            agentId: null,
          });
        }
      }
      // step-start / step-finish carry no content the tape needs.
    });
  }

  return out;
}

/** 대화록에 이미 있는 프롬프트 수 — 재시작 뒤 턴 번호의 밑값. */
export function exportPromptCount(doc: Wire): number {
  const messages = Array.isArray(doc?.messages) ? (doc.messages as Wire[]) : [];
  return messages.filter((m) => {
    const info = (m?.info ?? {}) as Wire;
    return (
      info.role === "user" &&
      (m.parts as Wire[] | undefined)?.some(
        (p) => p?.type === "text" && String(p.text ?? "").trim(),
      )
    );
  }).length;
}
