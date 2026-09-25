import type { RepoStatus } from "@colo-design/protocol";
import type { L } from "../labels";

/**
 * 제출 상태의 문장(PLAN-UI U13) — 데몬은 `RepoStatus.submit` 의 국면과 실패의
 * 분류만 싣고, 사람이 읽는 말은 여기서 짓는다. 버튼 · 여정의 첫 점 · 잠긴 이유가
 * 이 한 판정을 읽는다(`deriveJourney` 가 입력으로 받는다).
 *
 * 문장은 인자로 받는다 — 시험이 src 에서 곧장 읽는 순수 모듈은 형제를 부르지
 * 않는다(journey.ts 와 같은 규칙). 부르는 쪽은 `submitCopy(repo?.submit, L)`.
 */
export type SubmitWords = Pick<typeof L, "journey" | "submit">;

export type SubmitPhase = NonNullable<RepoStatus["submit"]>["phase"];

export interface SubmitCopy {
  phase: SubmitPhase;
  /** 버튼이 스스로 답하는 말 — 막힘이면 3초 동안의 `제출하지 못했어요`. */
  label: string;
  /** 도는 제출의 모양 — 버튼이 돌고 잠긴다. */
  busy: "running" | "retrying" | null;
  /** 여정 첫 점을 덮는 말(막힘) — 없으면 여정이 스스로 센다. */
  firstPoint: string | null;
  /** 잠긴 이유 — 도는 중 · 막힘일 때만. 쉬는 제출은 여정이 판정한다. */
  reason: string | null;
  /** 제출 기록의 마지막 시각 — 보낸 뒤 바뀐 화면을 세는 기준. 기록이 없으면 null. */
  lastAt: string | null;
}

export function submitCopy(
  submit: RepoStatus["submit"] | null | undefined,
  words: SubmitWords,
): SubmitCopy {
  const { submit: S, journey: J } = words;
  const phase: SubmitPhase = submit?.phase ?? "idle";
  let lastAt: string | null = null;
  for (const entry of submit?.log ?? []) {
    if (lastAt === null || Date.parse(entry.at) > Date.parse(lastAt)) lastAt = entry.at;
  }
  const base = { phase, lastAt };
  switch (phase) {
    case "running":
      return { ...base, label: S.running, busy: "running", firstPoint: null, reason: S.running };
    case "retrying":
      return { ...base, label: S.retrying, busy: "retrying", firstPoint: null, reason: S.retrying };
    case "blocked":
      // auth 는 사람의 손(새 초대 파일)이 풀고, 그 밖의 막힘은 개발자가 푼다 —
      // 둘 다 계속 만들 수 있고, 풀리면 도구가 다시 제출한다.
      return {
        ...base,
        label: S.failed,
        busy: null,
        firstPoint: J.beforeBlocked,
        reason: submit?.lastError === "auth" ? S.whyAuth : S.whyBlocked,
      };
    default:
      return { ...base, label: S.idle, busy: null, firstPoint: null, reason: null };
  }
}

/** `이번 작업` 제출 칸의 문장을 짓는 데 필요한 칸 — `submitCopy` 에 막힘 문장을 곁들인다. */
export type LedgerWords = SubmitWords & Pick<typeof L, "work">;

/**
 * `이번 작업` 의 제출 칸 한 줄(W1 · N4) — 도는 제출은 상태 문장(`제출하는 중…` ·
 * `다시 제출하는 중…`)을, 막힘은 그 이유를 칸에 세운다. 쉬는 제출은 null — 칸은
 * 여정이 아는 문장(영수증 · 아직 제출하지 않았어요)으로 말한다.
 */
export function ledgerLine(
  submit: RepoStatus["submit"] | null | undefined,
  words: LedgerWords,
): string | null {
  const copy = submitCopy(submit, words);
  if (copy.busy) return copy.label;
  if (copy.phase === "blocked") return words.work.blocked;
  return null;
}
