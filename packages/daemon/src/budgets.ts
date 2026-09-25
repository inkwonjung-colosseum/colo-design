/**
 * 예산 한 표 (PLAN L7 · 단계 2a) — 같은 문제에 자동 조치를 시도하는 횟수 ·
 * 간격의 상한. 지금 흩어져 있는 상한(turn-retry 의 재시도 · repo-publish 의
 * 밀린 푸시)을 하나의 표로 모으는 자리다. 상수를 실제 호출자로 옮기는 일은
 * 뒤 단계(8)가 하고, 여기서는 표와 셈만 세운다 — 초과했을 때의 행동은 언제나
 * 같다는 게 이 표의 존재 이유다: 개발자 알림 한 번, 화면은 `개발자에게
 * 알렸어요`(I4).
 *
 * 원장 항목의 모양은 cycle.json 의 budgets 필드(PLAN L10)와 같다 — 시각은 ISO
 * 문자열이고, 조정 표(cycle-reconcile)가 같은 원장을 읽고 쓴다.
 */

/** 원장의 예산 항목 — 창 안에서 몇 번 셌는지, 개발자에게 알렸는지. */
export interface BudgetEntry {
  spent: number;
  firstAt: string;
  lastAt: string;
  escalated: boolean;
}

/** 예산 원장 — cycle.json 의 `budgets` 필드가 곧 이 모양이다. */
export type BudgetLedger = Record<string, BudgetEntry>;

export interface BudgetRule {
  /** 창 안에서 허용하는 셈의 상한. */
  max: number;
  /** 이 창 밖의 셈은 잊는다. null 이면 첫 셈부터 영원히 센다. */
  windowMs: number | null;
}

export interface BudgetSpend {
  allowed: boolean;
  /** 상한에 닿았는가 — 이번 셈이 마지막 몫이거나, 이미 다한 뒤다. */
  exhausted: boolean;
  ledger: BudgetLedger;
}

/**
 * PLAN L7 표의 값. 근거와 옮겨질 호출자는 표의 "지금" 열이 가리킨다.
 * turn-retry · bring-up-briefs 의 상수는 아직 그 자리에 산다 — 옮기는 일은
 * 뒤 단계다. 여기 있는 값이 곧 그 표의 다음 판이다.
 */
export const BUDGETS = {
  /** 턴 일시 실패 재시도 — 다섯 계단의 사다리. 시도마다 한 계단씩 쓴다. */
  turnRetry: {
    attempts: 5,
    delaysMs: [4_000, 16_000, 60_000, 300_000, 900_000],
    /** 한도 기다림의 상한 — 이보다 먼 재충전은 기다리는 것이 아니라 잊는 것이다. */
    limitWaitMaxMs: 24 * 60 * 60_000,
  },
  /** 크래시 되살리기 — 10분 창 안에 3회, 시도 사이 1.5초 유예(시체와 경합하지 않게). */
  revive: { max: 3, windowMs: 10 * 60_000, graceMs: 1_500 },
  /** 푸시 백오프 — 30초에서 두 배씩, 최대 10분. 1시간 넘게 밀리면 알림. */
  push: { baseMs: 30_000, capMs: 10 * 60_000, behindAlarmMs: 60 * 60_000 },
  /** 충돌 정리 턴 — 같은 충돌(같은 파일 묶음)에 2회. 창은 없다: 같은 충돌은 사건 하나다. */
  conflict: { max: 2, windowMs: null },
  /** 준비 실패 턴 — 같은 단계에 2회, 한 바퀴(에피소드)에 4회. */
  bringUpPerKind: { max: 2, windowMs: null },
  bringUpPerEpisode: { max: 4, windowMs: null },
  /** 제출 단계 — 단계마다 5회. */
  submitStep: { max: 5, windowMs: null },
  /** 코멘트 반영 — PR 당 5 라운드. */
  reviewRounds: { max: 5, windowMs: null },
  /** 재클론 — 하루 1회. 창을 넘은 재클론은 새 사건이다. */
  reclone: { max: 1, windowMs: 24 * 60 * 60_000 },
  /** 같은 문제의 개발자 알림 — 10분에 한 번 갱신. */
  noticeRefreshMs: 10 * 60_000,
} as const;

/**
 * 제출 재시도의 사다리 (N6, 2026-09-25 결정) — 잠깐의 실패(network · rejected ·
 * other)는 관찰 틱(활성 2분)에 얹히지 않고 제출이 자기 타이머로 다시 센다.
 * 다섯 시도 사이의 네 간격이고 합은 3분 — 막힘 판정이 예산 다섯 번을 다 쓰는
 * 순간에 선다(예전 백오프로는 12분 넘게 걸렸다). 사다리가 끝난 뒤(막힌 뒤)의
 * 시도는 푸시 백오프로 돌아가 관찰 틱에 얹힌다.
 */
export const SUBMIT_RETRY_MS = [20_000, 40_000, 60_000, 60_000] as const;

/**
 * 한 번 쓴다 — 창 밖의 셈은 잊고 새로 센다. 거절하면 원장은 그대로 돌아온다
 * (거절이 창을 늘리지 않는다). 허용하면 이번 셈으로 상한에 닿았는지를
 * `exhausted` 로 알린다 — 호출자는 마지막 몫인지 알고 다음 소비에서 알림을
 * 준비할 수 있다.
 */
export function spend(
  ledger: BudgetLedger,
  key: string,
  rule: BudgetRule,
  now: number,
): BudgetSpend {
  const entry = ledger[key];
  const stale =
    entry !== undefined && rule.windowMs !== null && now - Date.parse(entry.lastAt) > rule.windowMs;
  const base = entry !== undefined && !stale ? entry : undefined;
  if (base !== undefined && base.spent >= rule.max) {
    return { allowed: false, exhausted: true, ledger };
  }
  const spent = (base?.spent ?? 0) + 1;
  return {
    allowed: true,
    exhausted: spent >= rule.max,
    ledger: {
      ...ledger,
      [key]: {
        spent,
        // 창이 돌아온 첫 셈은 새 사건이다 — 첫 시각도 다시 찍는다.
        firstAt: base?.firstAt ?? new Date(now).toISOString(),
        lastAt: new Date(now).toISOString(),
        escalated: base?.escalated ?? false,
      },
    },
  };
}

/** 예산이 다해 개발자에게 알렸다는 표식 — 알림은 이 표식으로 한 번만 나간다. */
export function markEscalated(ledger: BudgetLedger, key: string): BudgetLedger {
  const entry = ledger[key];
  if (entry === undefined || entry.escalated) return ledger;
  return { ...ledger, [key]: { ...entry, escalated: true } };
}

/** 예산을 지운다 — 문제가 풀렸을 때 부르는 자리(같은 문제의 다음 발생은 새 사건). */
export function resetBudget(ledger: BudgetLedger, key: string): BudgetLedger {
  if (!(key in ledger)) return ledger;
  const next = { ...ledger };
  delete next[key];
  return next;
}

/**
 * 지수 백오프 — 첫 시도가 baseMs 이고 시도마다 두 배, capMs 에서 자른다.
 * 곱셈을 접어 capMs 에 닿으면 멈춘다 — 시도 횟수가 커져도 오버플로 없이
 * 항상 capMs 를 돌려준다(푸시의 최대 간격이 10분을 넘지 않는 근거).
 */
export function backoffDelay(attempt: number, baseMs: number, capMs: number): number {
  let delay = baseMs;
  for (let i = 1; i < attempt; i += 1) {
    if (delay >= capMs) return capMs;
    delay = Math.min(delay * 2, capMs);
  }
  return delay;
}
