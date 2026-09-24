/**
 * 턴 자기치유의 판정만 — 언제 같은 말로 스스로 다시 시도할지 (감독 정책).
 *
 * 계약: 이 모듈은 순수하다. 타이머도 세션도 모른다 — 판단에 필요한 것을
 * 받아 판정만 내린다. 세션(session.ts)은 이 판정을 믿고 스스로 재전송하며,
 * 그 규칙이 한 곳에 사는 것이 무한 재시도를 막는 상한의 전부다.
 *
 * 네 갈래 (PLAN L12):
 * - `retry` — 일시적 실패(전송 거절 · 스트림 오류). 같은 말을 백오프로 다시.
 * - `wait`  — 사용량 한도. resetsAt 을 아는 한 그 시각에 맞춰 다시.
 * - `stop`  — 같은 말로는 영영 안 될 이유(로그인 만료 · 프롬프트 Too Long,
 *   한도인데 돌아올 시각을 모름). 로그인 만료는 상태가 돌아오면 세션이 한 번
 *   다시 보내고(auth), 나머지만 사람의 손 — 실패 카드가 남는다.
 */

import { BUDGETS } from "./budgets.js";

/** 백오프 간격 — 재시도마다 하나씩 소비한다. 길이가 곧 상한이다 (PLAN L7). */
export const RETRY_DELAYS_MS: readonly number[] = BUDGETS.turnRetry.delaysMs;

/** 한도 기다림의 상한 — 이보다 먼 재충전은 기다리는 것이 아니라 잊는 것이다. */
const LIMIT_WAIT_MAX_MS = BUDGETS.turnRetry.limitWaitMaxMs;
/** 재충전 직후엔 서버의 시계와 우리의 시계가 어긋난다 — 그만큼 여유. */
const LIMIT_RETRY_GRACE_MS = 3_000;

/** 크래시 자동 재개의 상한 — 같은 대화가 10분 창 안에 스스로 일으키는 횟수. */
export const MAX_AUTO_REVIVES = BUDGETS.revive.max;
/** 죽은 CLI 가 완전히 내려앉을 유예 — 재개가 그 시체와 경합하지 않게. */
export const REVIVE_GRACE_MS = BUDGETS.revive.graceMs;

export interface RetryInput {
  /** 이미 쓴 재시도 수 — 0 이면 첫 재시도를 묻는 중. */
  attempt: number;
  /** 실패한 턴의 결과 문장 (resultText). 없는 실패도 있다. */
  resultText: string | null;
  /** 이 세션이 마지막으로 본 한도 상태 — 턴 직전의 ratelimit 이벤트. */
  rateLimit: { status: string; resetsAt: number | null } | null;
  /** 판정의 기준 시각 (epoch ms). */
  now: number;
  /** 백오프 간격 — 테스트가 짧은 값을 넣는 길. 생략하면 RETRY_DELAYS_MS. */
  delays?: readonly number[];
}

export type RetryDecision =
  | { action: "retry"; delayMs: number }
  | { action: "wait"; delayMs: number }
  | {
      action: "stop";
      reason: "auth" | "exhausted" | "permanent" | "limit-no-reset";
    };

/**
 * 로그인 만료의 문장들 — 같은 말로 다시 시도해도 소용없는 실패다(PLAN L12).
 * 시간이 풀지 않고 사용자의 로그인이 푼다: 세션은 멈춘 말을 기억하고 상태가
 * 돌아오면 한 번 스스로 다시 보낸다.
 */
const AUTH_RESULT =
  /authentication_error|invalid api key|oauth token|please run \/login|not logged in|\b401\b/i;

/**
 * 같은 말로는 다시 시도해도 소용없는 실패 — 길이의 문제는 말을 줄여야
 * 하니 사람의 몫으로 남는다. 한도와 혼동하지 않는다: 한도는 시간의 문제다.
 */
const PERMANENT_RESULT =
  /prompt is too long|too many tokens|context (window|length)|maximum input|input.*too long/i;

/** 시간이 풀어 줄 실패 — 한도 계열. 재충전 시각을 아는 것이 재시도의 조건. */
const LIMIT_RESULT = /usage limit|rate limit|limit reached|weekly limit|quota/i;

/** ratelimit 이벤트의 status 중 "막힘"이 아닌 말들 — claude `allowed`, codex `updated`. */
const RATE_LIMIT_CLEAR = /^(allowed|updated|ok|)$/i;

/** 막힌 한도 상태인가 — status 가 조용한 말이 아니면 막힌 것이다. */
function rateLimitBlocked(rateLimit: RetryInput["rateLimit"]): boolean {
  if (!rateLimit) return false;
  return !RATE_LIMIT_CLEAR.test(rateLimit.status);
}

/**
 * 공급자 스트림 오류가 답변 옷을 입고 도착한 모양 — 드라이버가 isError 를
 * 못 달 때(오류가 마지막 메시지 텍스트로 흘러들 때)의 실패 신호다.
 * 실측: "Devin stream error unavailable: The third-party model provider is
 * experiencing issues ... Please try this model again later. (error ID: ...)".
 *
 * 오류 문구와 근거 문구를 함께 요구하고 길이 상한을 두는 것은, 스트림 오류를
 * 화제로 설명하는 정상 답변(길고 문맥이 있는 말)과 갈라 놓기 위해서다.
 */
const STREAM_ERROR_HEADLINE = /\bstream error\b/i;
const STREAM_ERROR_DETAIL =
  /\b(unavailable|not available|try (this |the )?model again|again later|error id:)\b/i;
const STREAM_ERROR_MAX_CHARS = 600;

export function looksLikeStreamError(resultText: string | null): boolean {
  if (!resultText || resultText.length > STREAM_ERROR_MAX_CHARS) return false;
  return STREAM_ERROR_HEADLINE.test(resultText) && STREAM_ERROR_DETAIL.test(resultText);
}

export function classifyRetry(input: RetryInput): RetryDecision {
  const delays = input.delays ?? RETRY_DELAYS_MS;
  const delay = delays.at(input.attempt);
  if (delay === undefined) return { action: "stop", reason: "exhausted" };
  const text = input.resultText ?? "";
  // 로그인 만료는 사다리를 타지 않는다 — 기다림이 문제를 풀지 않는다.
  if (AUTH_RESULT.test(text)) return { action: "stop", reason: "auth" };
  if (PERMANENT_RESULT.test(text)) return { action: "stop", reason: "permanent" };
  const limited = LIMIT_RESULT.test(text) || rateLimitBlocked(input.rateLimit);
  if (limited) {
    const resetsAt = input.rateLimit?.resetsAt ?? null;
    if (resetsAt === null) return { action: "stop", reason: "limit-no-reset" };
    const wait = resetsAt + LIMIT_RETRY_GRACE_MS - input.now;
    if (wait > LIMIT_WAIT_MAX_MS) return { action: "stop", reason: "limit-no-reset" };
    // 이미 지난 재충전 — 기다릴 것이 없으니 백오프로 곧바로 다시.
    return { action: "wait", delayMs: Math.max(wait, delay) };
  }
  return { action: "retry", delayMs: delay };
}

/** 실패의 단계 — 턴 통계(turn-stats)가 실패 행에 새기는 한 마디. */
export type FailureStage = "length" | "auth" | "limit" | "stream" | "other";

/**
 * 실패 문장의 최선 분류 — 재시도 판정(classifyRetry)이 쓰는 같은 사전으로
 * 읽는다. 세션의 ratelimit 상태는 여기 없으므로 limit 은 문장에 흔적이 남을
 * 때만 나온다: 판정이 아니라 측정이다(실패 단계의 분포를 보는 잣대).
 */
export function classifyFailure(resultText: string | null): FailureStage {
  const text = resultText ?? "";
  if (PERMANENT_RESULT.test(text)) return "length";
  if (AUTH_RESULT.test(text)) return "auth";
  if (looksLikeStreamError(resultText)) return "stream";
  if (LIMIT_RESULT.test(text)) return "limit";
  return "other";
}
