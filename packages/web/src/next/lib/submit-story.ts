/**
 * 제출 단추의 성공 이야기 — 단추가 답하는 순간부터 여정이
 * 따라오기까지의 안내 동작 순서. 시각은 전부 여기 한 곳에서 정하고
 * `submitStoryPhase` 가 판정한다 — 컴포넌트는 타이머만 돌린다.
 */

/** 체크가 그려지는 동안 — 붉은 실패의 흔들림에도 같은 길이를 쓴다. */
export const SUBMIT_STORY_BAR_MS = 250;
/** 첫 막대가 차기 시작하는 때 — 체크가 다 그려진 뒤. */
export const SUBMIT_STORY_POINT_MS = 650;
/** 실패가 붉어지기 전 흔들림의 길이. */
export const SUBMIT_SHAKE_MS = 200;

/** 성공 이야기의 국면 — 그려지는 체크 → 차는 첫 막대 → 켜지는 둘째 점. */
export type SubmitStoryPhase = "draw" | "bar" | "point";

/**
 * 보낸 뒤 흐른 시간이 어느 국면인가. 이야기가 시작되지 않았으면(음수) null —
 * 단추는 잠긴 채 지금의 모양만 지킨다.
 */
export function submitStoryPhase(elapsedMs: number): SubmitStoryPhase | null {
  if (!(elapsedMs >= 0)) return null;
  if (elapsedMs < SUBMIT_STORY_BAR_MS) return "draw";
  if (elapsedMs < SUBMIT_STORY_POINT_MS) return "bar";
  return "point";
}
