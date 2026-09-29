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

/**
 * 화살표 한 번이 하이라이트를 옮기는 곳 — 대화·프로젝트 줄 다음에 명령 칩이 이어 서서
 * 한 줄로 걷는다(`index` 는 그 한 줄의 자리: 줄이 `rows` 개, 그 뒤로 칩이 `commands` 개).
 * ↑↓ 는 끝에서도 그 자리에 머물며 키를 가져간다 — 입력칸의 커서가 처음 · 끝으로 튀지
 * 않게. 칩은 가로로 서 있어 칩 위에서는 ←/→ 도 걷는데, 실제로 옮겨 갈 때만 가져가고
 * 끝에서는 null 을 돌려 입력칸의 커서에 남긴다. 걸음의 일이 아닌 키도 null.
 */
export function stepWalk(
  key: string,
  index: number,
  rows: number,
  commands: number,
): number | null {
  const total = rows + commands;
  if (key === "ArrowDown") return Math.min(index + 1, Math.max(0, total - 1));
  if (key === "ArrowUp") return Math.max(index - 1, 0);
  // ←/→ 는 칩의 것이다 — 줄 위에서는 입력칸의 커서가 쓴다.
  if (index < rows) return null;
  if (key === "ArrowRight") return index < total - 1 ? index + 1 : null;
  if (key === "ArrowLeft") return index > rows ? index - 1 : null;
  return null;
}
