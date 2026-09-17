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
