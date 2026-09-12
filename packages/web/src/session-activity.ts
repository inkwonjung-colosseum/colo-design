import type { SessionState } from "@colo-design/protocol";

/**
 * Which threads finished a turn — or stopped to ask — while the planner was
 * looking somewhere else (PLAN D2 · D50). The strip marks finished ones until
 * they are opened: a live dot that simply vanishes spends the same pixel on
 * "finished" and on "never ran", and a strip whose whole purpose is that a
 * turn keeps going in another tab has to distinguish them. A thread that
 * stopped to ask (permission · question) is not finished at all — it comes
 * back in `awaiting`, the state the tree's `확인 대기` marking reads (D50).
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
): { running: Record<string, boolean>; settled: string[]; awaiting: string[] } {
  const running: Record<string, boolean> = {};
  const settled: string[] = [];
  const awaiting: string[] = [];
  for (const [sessionId, state] of Object.entries(states)) {
    running[sessionId] = state === "running";
    if (previous[sessionId] && !running[sessionId] && sessionId !== activeId) {
      if (state === "waiting_permission" || state === "waiting_question") awaiting.push(sessionId);
      else settled.push(sessionId);
    }
  }
  return { running, settled, awaiting };
}
