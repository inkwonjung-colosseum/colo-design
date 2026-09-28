/**
 * 첫 실행 · 확인판 · 테마 겹의 움직임 판정 — 컴포넌트가 매 프레임 다시 계산하지
 * 않게 한 곳에 모았다. 문장은 받지 않는다(시험이 곧장 읽는 순수 모듈).
 */

/** 체크리스트 세 항목의 열쇠 — 통과의 순간을 항목별로 가리킨다. */
export type GateKey = "tools" | "agent" | "invite";

/**
 * 통과 목록을 보고, 이번에 새로 통과한 항목과 갱신한 '본 적'을 돌려준다. 이미
 * 본 항목은 다시 새 것이 아니다 — 앱을 켰을 때 이미 통과한 항목이 튀지 않는
 * 이유다. 처음 볼 때는(빈 '본 적') 전부 이미 본 것으로 새긴다.
 */
export function takeFreshPasses(
  seen: ReadonlySet<GateKey> | null,
  passes: GateKey[],
): { fresh: GateKey[]; seen: Set<GateKey> } {
  if (seen === null) return { fresh: [], seen: new Set(passes) };
  const fresh = passes.filter((key) => !seen.has(key));
  return { fresh, seen: new Set([...seen, ...passes]) };
}

/** 가져오기 진행의 채움 비율(0~100) — 진행기가 아는 만큼만 보여 준다. */
export function inviteProgress(done: number, total: number): number {
  if (total <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

/**
 * 테마 미리보기가 입을 팔레트 — 시스템 따르기는 밝음과 어두움의 반반으로
 * 말하고, 나머지는 자기 팔레트 한 장이다.
 */
export function themePeekHalves(choice: "system" | string): string[] {
  return choice === "system" ? ["light", "dark"] : [choice];
}

/**
 * 겹이 닫히는 동안 기다리는 시간 — 역방향 pop 의 길이다. 움직임을 끈 창은
 * 기다리지 않는다(0 은 곧바로 닫는다는 뜻).
 */
export function modalCloseMs(reducedMotion: boolean): number {
  return reducedMotion ? 0 : 120;
}
