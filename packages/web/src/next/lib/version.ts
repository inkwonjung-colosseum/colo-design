/**
 * 버전 문자열의 순수 판정(PLAN-UI U12) — 설정의 업데이트 줄과 사이드바의
 * 점이 함께 읽는다. 에이전트 CLI 가 내는 버전은 모양이 제각각이다
 * (`2.1.4 (Claude Code)` · `codex-cli 0.46.0`) — 글 속의 첫 `숫자(.숫자)*`
 * 만을 버전으로 읽고 점찍은 숫자끼리 비교한다. 데몬의 versions.ts 와 같은
 * 규칙을 웹 쪽의 작은 판으로 가져왔다: 형제 import 는 node:test 가 못 푸니까.
 */

/** 문장 속의 첫 버전 — `2.1.4 (Claude Code)` → `2.1.4`. 없으면 null. */
export function plainDotted(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = /(\d+(?:\.\d+)*)/.exec(text);
  return match?.[1] ?? null;
}

/**
 * `latest` 가 `current` 보다 새것인가 — 어느 쪽이든 버전을 읽지 못하면
 * 거짓이다. 「새 버전 있어요」 가 헛된 글로 켜지지 않게 하는 안전판.
 */
export function hasNewerVersion(
  current: string | null | undefined,
  latest: string | null | undefined,
): boolean {
  const from = plainDotted(current);
  const to = plainDotted(latest);
  if (!from || !to || from === to) return false;
  const left = from.split(".").map(Number);
  const right = to.split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}
