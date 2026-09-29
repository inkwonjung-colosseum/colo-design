/**
 * 줄 목록에서 '이번에 새로 들어온 열쇠' 판정 — 컴포넌트가 렌더마다 다시 셈하지 않게 한
 * 곳에 모았다(시험이 곧장 읽는 순수 모듈). 등장 애니메이션을 CSS 만으로 걸면 React 가
 * 재정렬에서 옮긴 옆 줄까지 다시 등장하므로, 새로 들어온 열쇠만 이 판정이 가린다.
 *
 * 앞 렌더에 있던 열쇠는 새 것이 아니다. 앞 렌더를 모를 때(`before === null` — 처음
 * 그리거나 범위가 바뀐 때)는 지금 있는 것을 전부 이미 본 것으로 새긴다 — 앱을 켜거나
 * 프로젝트를 옮길 때 이미 있는 줄이 한꺼번에 등장하지 않는다.
 */
export function takeFreshKeys(
  before: ReadonlySet<string> | null,
  keys: readonly string[],
): { fresh: string[]; keys: Set<string> } {
  if (before === null) return { fresh: [], keys: new Set(keys) };
  return { fresh: keys.filter((key) => !before.has(key)), keys: new Set(keys) };
}
