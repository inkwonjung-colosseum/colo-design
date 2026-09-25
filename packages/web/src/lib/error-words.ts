/**
 * 오류 id 의 한국어. The daemon's retry events carry the CLI's own
 * error ids (`overloaded`, `api_error`, …); this maps the ones a planner can
 * act on to a sentence, and everything unknown falls through to the caller's
 * fallback wording. Raw ids stay available to `자세히` folds.
 */
const WORDS: Record<string, string> = {
  overloaded: "AI가 붐빕니다",
  api_error: "잠시 문제가 있었습니다",
  invalid_request: "요청을 처리하지 못했습니다",
  timeout: "응답이 늦어졌습니다",
};

/** The subscription-limit refusal's own sentence. The SDK names it only in
    English inside the turn's closing text, so the failed card's `자세히`
    needs a Korean line ahead of the raw words — and `WORDS` keys are the
    daemon's retry ids, which this refusal is not. */
export const LIMIT_WORDS = "구독 사용량을 채워 작업이 멈췄습니다";

/** The Korean sentence for an error id, or `null` when it is unknown. */
export function errorWords(id: string): string | null {
  return WORDS[id] ?? null;
}

/**
 * 데몬이 준 오류 문장(영어일 수 있다)을 배너 제목으로 고르는 판정 (PLAN L8).
 * 개발 실행이 아니면 짧은 한국어 한 줄만 보이고 원문은 console 로 — 화면의
 * 문제 문장은 셋이라는 약속(I2)의 바깥에 원문을 새지 않는다. 계속되는 문제는
 * 주의 한 줄(AttentionLine)이 이미 말하므로 여기서 덧붙이지 않는다.
 *
 * 예외 — 사용자가 고칠 수 있는 한국어 안내(예: `8MB 를 넘는 파일은 붙일 수
 * 없습니다`)는 가리지 않고 그대로 보인다: 그런 문장을 한 줄로 바꾸면 무엇을
 * 고쳐야 하는지가 사라진다. 판정은 보수적으로 — 한국어 문장이면서 영어 ·
 * 경로 · 스택 흔적(3자 이상의 라틴 글자 뭉치, `/` · `\` · `~`)이 없는 문장만
 * 통과시킨다. `MB` 같은 두 자 약어는 한국어 안내에도 흔해 문제 삼지 않는다.
 */
export const RAW_ERROR_WORDS = "잠시 문제가 있었어요 — 다시 시도해 주세요";

/** 한국어 문장인가 — 한글 음절 · 자모가 하나라도 들어 있다.
 *  `8MB 를 넘는…` 처럼 숫자로 시작하는 안내도 한국어 문장이다. */
const hasKorean = (raw: string): boolean => /[\uAC00-\uD7A3\u1100-\u11FF]/.test(raw);

/** 영어 · 경로 · 스택 흔적의 단서 — 3자 이상의 라틴 글자 뭉치(PDF · git ·
 *  파일명 조각도 가린다 — 보수 쪽), 또는 경로 · 홈 표식(`/a/b` 처럼 짧은
 *  조각만의 경로도 새지 않게). `MB` 같은 두 자 약어는 한국어 안내에도 흔해
 *  문제 삼지 않는다. */
const latinLeak = (raw: string): boolean => /[A-Za-z]{3,}|[/\\~]/.test(raw);

/** 가리지 않고 보여도 되는 한국어 안내인가 (모듈 머리의 예외 규칙). */
export function koreanNoticeWords(raw: string): boolean {
  return hasKorean(raw) && !latinLeak(raw);
}

/** 배너가 보일 제목 — 개발 실행은 원문 그대로(개발자가 원인을 읽는다).
 *  개발 실행이 아니어도 한국어 안내(koreanNoticeWords)는 원문 그대로다. */
export function plainErrorTitle(raw: string, dev: boolean): string {
  if (dev || koreanNoticeWords(raw)) return raw;
  return RAW_ERROR_WORDS;
}
