/**
 * 창 포커스가 감독자의 틱을 깨우는 조용한 읽기(PLAN 단계 10) — 순수 판정만
 * 담는다. `repo.handoffStatus` 는 병합이 보이면 착지까지 하는 능동적 읽이라
 * GitHub API 도 함께 쓰므로, 돌아올 때마다 부르지 않고 시간당 몇 번으로
 * 억제한다(20분 — 시간당 세 번 이하).
 */
export const FOCUS_READ_THROTTLE_MS = 20 * 60_000;

/** 마지막 읽은 시각과 지금이 주어지면 이번에 다시 읽을지를 가른다. */
export function focusReadDue(lastAt: number, now: number): boolean {
  return now - lastAt >= FOCUS_READ_THROTTLE_MS;
}
