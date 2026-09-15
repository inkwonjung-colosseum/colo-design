import type { ChatEvent } from "@colo-design/protocol";

/**
 * 대화록 내보내기 (리뷰 E5): the transcript is the planner's own deliverable —
 * the reasoning behind screens they will be asked about in a meeting room.
 * Until now it lived only in ~/.colo-design, one 지우기 away from gone; this
 * turns it into a markdown file the planner can keep wherever they keep
 * documents.
 *
 * Pure here, download in the DOM helper below — the shape is unit tested.
 */

export function transcriptToMarkdown(
  events: ChatEvent[],
  title: string,
  exportedAt = new Date(),
): string {
  const out: string[] = [`# ${title}`, "", `- 내보낸 시각: ${exportedAt.toLocaleString()}`, ""];
  for (const event of events) {
    if (event.kind === "user.echo") {
      const extra = event.images > 0 ? [`이미지 ${event.images}장`] : [];
      out.push(
        `**나**${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`,
        "",
        event.text.trim() || "(빈 메시지)",
        "",
      );
    } else if (event.kind === "text.done") {
      out.push("**Claude**", "", event.text.trim(), "");
    } else if (event.kind === "turn.end") {
      out.push("---", "");
    }
  }
  return out.join("\n").trimEnd();
}

/** 브라우저 내려받기 — markdown 파일 하나로. */
export function downloadTranscript(markdown: string, title: string): void {
  const safe = title.replace(/[/\\:*?"<>|]/g, "_").trim() || "conversation";
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safe}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}
