import type { ColoDesignScreen } from "@colo-design/protocol";

/**
 * The empty conversation's one-click starts (PLAN D92의 시작 칩). Each sentence
 * becomes the composer's draft verbatim — press, fix, send.
 */
export const GENERIC_STARTERS = [
  "로그인 화면의 상태 3개를 만들어 줘",
  "이 화면을 모바일 폭에서도 읽히게 다듬어 줘",
  "테이블에 빈 상태와 오류 상태를 추가해 줘",
];

/**
 * The same starters, pointed at the CONNECTED repo. The repo declares its
 * screens (colo-design.json → colo-design.screens), and a first prompt that
 * names a real screen beats a generic one — 화면 구성·수정의 첫 걸음이 여기서
 * 정해진다. Nothing here invents routes or states; a declaration too thin to
 * name a screen falls back to the generic sentences.
 */
export function suggestionsFromScreens(screens: ColoDesignScreen[]): string[] {
  const named = screens.filter((screen) => screen.title.trim() !== "");
  if (named.length === 0) return GENERIC_STARTERS;
  const out: string[] = [];
  const first = named[0];
  if (first) out.push(`「${first.title}」화면을 만들어 줘`);
  const stateful = named.find((screen) => screen.states.some((state) => state !== "default"));
  if (stateful) out.push(`「${stateful.title}」에 빈 상태와 오류 상태를 추가해 줘`);
  const another = named.find((screen) => screen !== first && screen !== stateful);
  if (another) out.push(`「${another.title}」화면을 모바일 폭에서도 읽히게 다듬어 줘`);
  return out.length > 0 ? out : GENERIC_STARTERS;
}
