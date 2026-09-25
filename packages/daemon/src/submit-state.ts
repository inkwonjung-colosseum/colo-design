/**
 * 제출 상태 (PLAN-UI U13) — 원장의 제출 의도 · 푸시 · 예산 · 서 있는 알림을
 * 한 값(`RepoStatus.submit`)으로 읽는 순수 함수들. 상태 줄의 `제출하지 못했어요`
 * 와 `이번 작업` 의 제출 기록이 이 값에서 나온다 — 문장은 웹이 짓고, 여기서는
 * 국면과 기록 줄만 정한다.
 *
 * 국면:
 * - idle — 제출 의도가 없다.
 * - running — 의도가 있고 아직 실패가 없다(한 번 누른 제출이 도는 중).
 * - retrying — 잠깐의 실패(network · rejected · other)가 예산 안에 있다.
 *   감독자가 백오프 간격으로 스스로 다시 제출한다.
 * - blocked — 개발자 몫이다. 연결 코드가 만료됐거나(auth), 예산을 다 써
 *   개발자에게 알렸다(developer-notified). 시도는 백오프로 계속되고, 풀리면
 *   도구가 다시 제출한다.
 *
 * 기록 줄의 말은 이 판의 어휘 그대로다 — 개발자 말(턴 · git · PR …)을 쓰지 않는다.
 */
import type { BudgetLedger } from "./budgets.js";
import type {
  CycleLedger,
  CyclePushState,
  CycleSubmitTrail,
  SubmitErrorKind,
  SubmitPhase,
} from "./cycle-ledger.js";

/** 기록 줄의 문장 — 웹의 labels 와 같은 말(PLAN-UI U13). */
export const SUBMIT_LOG_TEXT = {
  blocked: "제출하지 못했어요 — 개발자에게 알렸어요",
  unblocked: "개발자가 풀었어요 — 도구가 다시 제출해요",
  succeeded: "제출했어요",
  retrying: "다시 제출하는 중",
} as const;

/** 선로에 싣는 기록 줄의 수 — `이번 작업` 은 최근 셋을 보인다. */
export const SUBMIT_LOG_MAX = 3;

export type SubmitBlockReason = "auth" | "developer-notified";

export interface SubmitPhaseView {
  phase: SubmitPhase;
  attempts: number;
  lastError?: SubmitErrorKind;
  /** blocked 일 때만 — 알림(`submit-blocked`)의 reason. */
  blockedBy?: SubmitBlockReason;
}

/**
 * 원장 조각에서 지금의 국면을 판정한다. 인증이 먼저다 — 만료된 연결 코드는
 * 예산과 상관없이 사람(새 초대 파일)이 풀어야 한다.
 */
export function deriveSubmitPhase(input: {
  intent: CycleLedger["submit"];
  push: CyclePushState | null;
  budgets: BudgetLedger;
  notices: CycleLedger["notices"];
  authExpired: boolean;
}): SubmitPhaseView {
  const { intent, push } = input;
  if (intent === null) return { phase: "idle", attempts: 0 };
  const stepAttempts = intent.attempts ?? 0;
  const pushAttempts = push?.attempts ?? 0;
  const attempts = Math.max(stepAttempts, pushAttempts);
  // 단계의 실패가 있으면 그 분류가, 없으면 밀린 푸시의 분류가 마지막 오류다.
  const lastError: SubmitErrorKind | undefined =
    stepAttempts > 0 && intent.lastError !== undefined
      ? intent.lastError
      : pushAttempts > 0
        ? push?.lastError
        : undefined;
  const auth =
    input.authExpired ||
    (stepAttempts > 0 && intent.lastError === "auth") ||
    (pushAttempts > 0 && push?.lastError === "auth");
  if (auth) return { phase: "blocked", attempts, lastError: "auth", blockedBy: "auth" };
  // 예산이 다해 알림이 나갔다 — 단계 예산의 escalated 표식, 또는 1시간 넘게
  // 밀린 푸시의 서 있는 알림(push:behind).
  const escalated =
    input.budgets["submit:pr"]?.escalated === true ||
    input.budgets["submit:commit"]?.escalated === true ||
    input.notices["push:behind"] !== undefined;
  if (escalated) {
    return {
      phase: "blocked",
      attempts,
      lastError: lastError ?? "other",
      blockedBy: "developer-notified",
    };
  }
  if (attempts > 0) {
    return { phase: "retrying", attempts, ...(lastError ? { lastError } : {}) };
  }
  return { phase: "running", attempts: 0 };
}

/**
 * 국면의 전이를 기록에 적는다 — 같은 국면이면 그대로(기록은 사건이지 틱이
 * 아니다). `succeeded` 는 제출이 끝까지 선 순간에만 부른다: 의도가 지워지는
 * 다른 길(보낼 것이 없음)은 성공이 아니다. 돌려주는 `blocked` 는 이번 전이로
 * 막힘에 새로 들어섰을 때만 — 알림이 막힘마다 한 번 나가는 근거다.
 */
export function advanceSubmitTrail(
  trail: CycleSubmitTrail | undefined,
  next: SubmitPhaseView,
  at: string,
  succeeded = false,
): { trail: CycleSubmitTrail; changed: boolean; blocked: SubmitBlockReason | null } {
  const prev = trail ?? { phase: "idle" as const, log: [] };
  const lines: string[] = [];
  let blocked: SubmitBlockReason | null = null;
  if (succeeded) {
    lines.push(SUBMIT_LOG_TEXT.succeeded);
  } else if (next.phase !== prev.phase) {
    if (next.phase === "blocked") {
      lines.push(SUBMIT_LOG_TEXT.blocked);
      blocked = next.blockedBy ?? "developer-notified";
    } else if (prev.phase === "blocked" && next.phase !== "idle") {
      lines.push(SUBMIT_LOG_TEXT.unblocked);
    } else if (next.phase === "retrying") {
      lines.push(SUBMIT_LOG_TEXT.retrying);
    }
  }
  const phase = succeeded ? "idle" : next.phase;
  if (phase === prev.phase && lines.length === 0) {
    return { trail: prev, changed: false, blocked: null };
  }
  const log = [...prev.log, ...lines.map((text) => ({ at, text }))].slice(-SUBMIT_LOG_MAX);
  return { trail: { phase, log }, changed: true, blocked };
}

/**
 * 제출 단계의 실패 이유(사람의 문장 · git · GitHub 의 말)를 네 분류로 — 푸시의
 * 분류(classifyPushError)와 같은 잣대에 GitHub 의 401 문장 · fetch 의 실패를 더한다.
 */
export function classifySubmitError(reason: string): SubmitErrorKind {
  if (
    /Authentication failed|could not read Username|Permission denied|\b401\b|\b403\b|토큰이 유효하지 않|연결 코드를 확인/.test(
      reason,
    )
  ) {
    return "auth";
  }
  if (
    /could not resolve host|connection|timed out|unable to access|network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(
      reason,
    )
  ) {
    return "network";
  }
  if (/rejected|non-fast-forward|fetch first/.test(reason)) return "rejected";
  return "other";
}
