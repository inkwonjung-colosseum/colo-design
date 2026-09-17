/**
 * What the 넘기기 dialog opens on.
 *
 * The daemon owns the fallback, so this contributes only what the browser
 * knows: the project name as the title seed. A blank field never crosses
 * the wire, which is what lets the daemon's own proposal win when the repo
 * reports nothing.
 */
export function handoffDraft(projectName: string): { title: string; body: string } {
  return {
    // The project is usually already named for what it is ("재고 실사 화면");
    // appending 화면 unconditionally produced "재고 실사 화면 화면".
    title: projectName ? (projectName.endsWith("화면") ? projectName : `${projectName} 화면`) : "",
    body: "",
  };
}

/**
 * What the 넘기기 dialog shows once the agent's draft lands (비개발자 넘기기).
 * The draft is the whole proposal now — the declared screen list is gone.
 * The trailing newline keeps the daemon's own sections (의견 · 화면
 * 미리보기) off the last line the planner typed.
 */
export function mergeHandoffBody(draft: string): string {
  const trimmed = draft.trim();
  return trimmed ? `${trimmed}\n` : "";
}
