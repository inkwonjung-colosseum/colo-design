/**
 * 찾기(⌘K) 창의 걸음 판정 — 순위와 친 글자의 위치. 순수 모듈이라 시험이 곧장
 * 읽는다(next/ 의 순수 판정과 같은 계약 — 형제를 부르지 않는다).
 */

/**
 * Substring beats subsequence: `결제` ranks an answer that starts with it
 * above one that merely scatters its letters. Plain lowercase matching —
 * the planner's words are Korean and short.
 */
export function rank(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return at === 0 ? 1 : 2;
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return 3;
  }
  return -1;
}

/**
 * 친 글자의 자리 — 결과에서 `<mark>` 로 묶을 한 덩이. 접두 · 중간 어느 쪽이든
 * 이어진 덩이로 있고, 흩어져 맞은 차례(rank 3)는 한 덩이로 될 수 없으니 비운다.
 * 찾는 말이 비었으면 하이라이트도 없다.
 */
export function matchRange(query: string, text: string): [number, number] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const at = text.toLowerCase().indexOf(q);
  return at < 0 ? null : [at, at + q.length];
}
