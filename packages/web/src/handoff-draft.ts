import type { CdsDesignScreen } from "@cds-design/protocol";

/**
 * What the 넘기기 dialog opens on (PLAN D5).
 *
 * The daemon owns the fallback, so this contributes only what the browser
 * knows: which screens the running app declared, and the states each one
 * implements. A blank field never crosses the wire, which is what lets the
 * daemon's own proposal win when the repo reports nothing.
 *
 * One line per screen that names the 기획서 it was built from (D5); a screen
 * with no spec contributes no line at all rather than a line with a hole in
 * it. Deliberately absent: the preview URL. It is a loopback address on the
 * planner's own machine, and in a handoff a developer reads, a link that
 * looks openable and never is costs more than no link.
 */
export function handoffDraft(
  projectName: string,
  screens: CdsDesignScreen[],
): { title: string; body: string } {
  return {
    // The project is usually already named for what it is ("재고 실사 화면");
    // appending 화면 unconditionally produced "재고 실사 화면 화면".
    title: projectName ? (projectName.endsWith("화면") ? projectName : `${projectName} 화면`) : "",
    body: bodyFor(screens),
  };
}

function bodyFor(screens: CdsDesignScreen[]): string {
  const lines: string[] = [];
  for (const screen of screens) {
    if (!screen.spec) continue;
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
