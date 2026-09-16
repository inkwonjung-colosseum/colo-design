import type { ChatEvent } from "@colo-design/protocol";

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
              : { kind: "user.echo", text: content, images: 0 },
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
            ? {
                kind: "notice",
                level: "info",
                text: text || `${images} image(s)`,
              }
            : { kind: "user.echo", text, images },
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
          out.push({
            kind: "thinking.delta",
            blockId,
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
    }
  }

  return out;
}
