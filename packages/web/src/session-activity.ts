import type { SessionState } from "@cds-design/protocol";

/**
 * Which threads finished a turn while the planner was looking somewhere else
 * (PLAN D2). The strip marks those until they are opened: a live dot that
 * simply vanishes spends the same pixel on "finished" and on "never ran", and
 * a strip whose whole purpose is that a turn keeps going in another tab has to
 * distinguish them.
 *
 * A transition, not a state: only a thread this client watched go from running
 * to not-running counts. Anything else would mark every idle thread on load.
 * The thread the planner is already reading is never marked — they are
 * watching it settle.
 */
export function settleTransitions(
  /** Which threads were running the last time this ran. */
  previous: Record<string, boolean>,
  states: Record<string, SessionState>,
  activeId: string | null,
): { running: Record<string, boolean>; settled: string[] } {
  const running: Record<string, boolean> = {};
  const settled: string[] = [];
  for (const [sessionId, state] of Object.entries(states)) {
    running[sessionId] = state === "running";
    if (previous[sessionId] && !running[sessionId] && sessionId !== activeId) {
      settled.push(sessionId);
    }
  }
  return { running, settled };
}
