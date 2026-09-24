/**
 * 충돌 표식 검사 (PLAN L5 · 단계 3) — 턴이 끝난 파일에 git 의 충돌 표식이
 * 남았는지를 가리는 순수 함수. 감독자가 도구의 마무리(add + commit)를 하기
 * 전에 부른다: 표식이 남았으면 AI 의 정리 턴을 다시 열고, 없으면 도구가
 * 마무리한다. 이 판정이 성급하면 정리가 끝난 파일을 계속 고치는 턴이 열리고,
 * 늦으면 표식이 커밋에 구워진 채 올라간다.
 *
 * "짝을 이뤄" 의 뜻: git 이 남기는 세 표식 — 줄 머리의 `<<<<<<< ` · 정확히
 * `=======` · 줄 머리의 `>>>>>>> ` — 이 이 순서로 나타나야만 참이다. 코드 안
 * 문자열에 `=======` 한 줄이 있는 것만으로 참이 되면 안 된다. diff3 의
 * `||||||| `(공통 조상)은 시작과 가운데 사이에 오므로, 그 사이에는 무엇이
 * 와도 관계없다.
 */

/** git 이 충돌 구간을 여는 표식 — 뒤에 분기 이름이 따라온다. */
const START = "<<<<<<< ";
/** 충돌의 가운데 — 이 줄이 정확히 이것일 때만 가운데다(여덟 개 `=` 는 아니다). */
const MIDDLE = "=======";
/** git 이 충돌 구간을 닫는 표식 — 뒤에 분기 이름이 따라온다. */
const END = ">>>>>>> ";

/**
 * 세 표식이 짝을 이뤄 나타나는가. 줄 단위 상태 기계: 시작을 만나면 문이 열리고,
 * 정확한 가운데를 지나 닫는 표식을 만나면 참이다. CRLF 도 줄로 쪼개 잰다.
 */
export function conflictMarkers(text: string): boolean {
  let started = false;
  let middled = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(START)) {
      // 새 충돌 구간의 시작 — 앞 구간의 가운데 기록은 버리고 다시 센다.
      started = true;
      middled = false;
      continue;
    }
    if (started && line === MIDDLE) {
      middled = true;
      continue;
    }
    if (middled && line.startsWith(END)) return true;
  }
  return false;
}
