import type { ColoDesignScreen } from "@colo-design/protocol";

/**
 * What the 넘기기 dialog opens on.
 *
 * The daemon owns the fallback, so this contributes only what the browser
 * knows: which screens the running app declared, and the states each one
 * implements. A blank field never crosses the wire, which is what lets the
 * daemon's own proposal win when the repo reports nothing.
 *
 * One line per declared screen — its title, its route, and the states it
 * implements. Deliberately absent: the preview URL. It is a loopback address
 * on the planner's own machine, and in a handoff a developer reads, a link
 * that looks openable and never is costs more than no link.
 */
export function handoffDraft(
  projectName: string,
  screens: ColoDesignScreen[],
): { title: string; body: string } {
  return {
    // The project is usually already named for what it is ("재고 실사 화면");
    // appending 화면 unconditionally produced "재고 실사 화면 화면".
    title: projectName ? (projectName.endsWith("화면") ? projectName : `${projectName} 화면`) : "",
    body: bodyFor(screens),
  };
}

function bodyFor(screens: ColoDesignScreen[]): string {
  const lines: string[] = [];
  for (const screen of screens) {
    // The states the repo DECLARED for this screen. This is the only
    // mechanical answer a developer gets to "how far did the mock go": the
    // list is handed over unjudged instead of summarised.
    const states = screen.states.length > 0 ? ` — 상태 ${screen.states.join(" · ")}` : "";
    lines.push(`- ${screen.title} \`${screen.route}\`${states}`);
  }
  // The trailing blank line is deliberate: the planner types on top of this
  // proposal, and the daemon appends below it.
  return lines.length > 0 ? `넘기는 화면:\n${lines.join("\n")}\n\n` : "";
}

/**
 * What the 넘기기 dialog shows once the agent.s draft lands (비개발자 넘기기).
 *
 * Two halves with two authors, and the order is the point: the sentences a
 * developer reads first are the agent.s, and under them the screen list stays
 * exactly what the running app declared. Routes and states are mechanical
 * facts — a composed line about them would be a place to be wrong — so the
 * draft never rewrites this half, it only sits above it.
 *
 * Either half may be missing: no draft leaves today's proposal untouched,
 * and a repo that declares no screen leaves the draft standing alone.
 */
export function mergeHandoffBody(draft: string, screens: string): string {
  const halves = [draft.trim(), screens.trim()].filter(Boolean);
  // The trailing newline keeps the daemon's own sections (의견 · 화면
  // 미리보기) off the last line the planner typed.
  return halves.length > 0 ? `${halves.join("\n\n")}\n` : "";
}
