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
 */
export const RAW_ERROR_WORDS = "잠시 문제가 있었어요 — 다시 시도해 주세요";

/** 배너가 보일 제목 — 개발 실행은 원문 그대로(개발자가 원인을 읽는다). */
export function plainErrorTitle(raw: string, dev: boolean): string {
  return dev ? raw : RAW_ERROR_WORDS;
}
