import type { SessionState } from "@colo-design/protocol";

/**
 * The daemon's one opinion about when a planner should be called back. The
 * shape is semantic on purpose — a thread's own name, never a session id or
 * a git word — so the receiver can paint it without re-deriving anything.
 */
export type DaemonNotice =
  | { kind: "done"; sessionId: string; title: string; durationMs?: number }
  | { kind: "crashed"; sessionId: string; title: string }
  | {
      kind: "ask";
      sessionId: string;
      title: string;
      what: "permission" | "question";
    }
  | {
      kind: "gate";
      sessionId: string;
      title: string;
      /** `screen` 은 턴 끝의 화면 확인 — 나머지 셋은 사용자가 누른 단추다. */
      stage: "save" | "handoff" | "refresh" | "screen";
    }
  | {
      /**
       * 커미티 B1 (2026-09-15): the developer's side moved — 반영됨·변경 요청·
       * 새 코멘트. No sessionId: the destination is a PROJECT, so the click
       * switches by slug, not by thread.
       */
      kind: "handoff";
      slug: string;
      /** The project's own name — the notification's unit (커미티 A 수정). */
      projectName: string;
      event: "merged" | "closed" | "changes_requested" | "comments";
      /** `comments` 만: 새로 읽힌 개수. */
      count?: number;
    };

/**
 * 상태 전환 중 부르는 값이 되는 것: AI 가 멈췄거나(idle), 중단됐거나
 * (error), 사용자의 답을 기다리거나(waiting_*). starting 과 running 은
 * 사용자가 방금 본 것이고 closed 는 스스로 닫은 것이다.
 */
export function noticeForState(
  sessionId: string,
  state: SessionState,
  title: string,
  durationMs?: number,
): DaemonNotice | null {
  switch (state) {
    case "idle":
      return {
        kind: "done",
        sessionId,
        title,
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
    case "error":
      return { kind: "crashed", sessionId, title };
    case "waiting_permission":
      return { kind: "ask", sessionId, title, what: "permission" };
    case "waiting_question":
      return { kind: "ask", sessionId, title, what: "question" };
    default:
      return null;
  }
}
