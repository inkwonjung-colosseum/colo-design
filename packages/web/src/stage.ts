import type { CdsDesignScreen, HandoffStatus, RepoPhase } from "@cds-design/protocol";

/**
 * The five words of the cycle (PLAN D44), in rail order. The ids are wire
 * values for `deriveStage`; the labels are the only ones the UI shows.
 */
export const STAGES = [
  { id: "create", label: "화면 만들기" },
  { id: "review", label: "검토·수정" },
  { id: "save", label: "저장" },
  { id: "handoff", label: "넘기기" },
  { id: "merged", label: "반영됨" },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

/**
 * The row badges speak the same words as the stepper (PLAN D45): 사이드바 행과
 * 스테퍼가 어긋날 길이 없도록, 문장은 여기 한 벌이고 표식은 그것을 빌려 쓴다.
 */
export const WORKING_LABEL = "작업 중";
export const HANDOFF_BADGE = "넘김";
export const MERGED_BADGE = "반영됨";
export const changesBadge = (count: number): string => `변경 ${count}`;

/** What the cycle asks of the planner right now, and the words on the button. */
export interface StagePrimary {
  label: string;
  /** A running turn holds the 저장 button — the diff is moving under it. */
  disabled?: boolean;
}

/**
 * One judgement about the whole cycle. `step: null` means the stepper has
 * nothing to say — the repo is not ready, and the ProgressPanel owns the
 * column instead.
 */
export interface Stage {
  step: StageId | null;
  primary: StagePrimary | null;
  why: string | null;
}

export interface StageInput {
  /** The screens the repo declared. Kept for the D45 signature — see below. */
  screens: CdsDesignScreen[];
  /** Unsaved-change files, the stepper's number (PLAN D8). */
  pendingChanges: number;
  /** This cycle's `cds-design/…` branch, or null before the first 저장. */
  branch: string | null;
  handoff: HandoffStatus | null;
  /** A Claude turn is running in the open thread. */
  running: boolean;
  /** null before the daemon has reported — as good as not ready. */
  phase: RepoPhase | null;
}

/**
 * 어느 단계인지는 전부 기계적으로 정해진다 (PLAN D45). One primary button at
 * every moment, and its label is the table's — the tester can read this file
 * instead of the running app. The precedence is the boundary plan's:
 * 반영됨 ends a cycle, 새 변경 during 넘기기 returns to 검토·수정 (같은 PR 에
 * 쌓인다), and only a repo with nothing in flight stands at 화면 만들기.
 *
 * `screens` is in the signature because D45's table names it, but it does not
 * move the judgement: a repo that declares screens and has no unsaved work is
 * still at 화면 만들기 — 저장할 것도 넘길 것도 없으면 다음 행동은 화면을
 * 시키는 것이다.
 */
export function deriveStage(input: StageInput): Stage {
  const { pendingChanges, branch, handoff, running, phase } = input;
  if (phase !== "ready") return { step: null, primary: null, why: null };

  if (handoff?.state === "merged") {
    return {
      step: "merged",
      primary: null,
      why: "개발자가 받아 갔습니다. 다음 저장은 새 사이클을 시작합니다.",
    };
  }

  if (pendingChanges > 0) {
    return {
      step: "review",
      primary: running ? { label: "작업 중…", disabled: true } : { label: "저장" },
      why: running
        ? "Claude 가 고치는 중 — 끝나면 변경 수가 다시 세어지고 저장할 수 있습니다."
        : handoff
          ? `저장하지 않은 변경 ${pendingChanges}건 — 미리보기에서 검토하고 저장하면 넘긴 PR 에 계속 쌓입니다.`
          : `저장하지 않은 변경 ${pendingChanges}건 — 미리보기에서 검토하고 저장하면 이 사이클의 브랜치에 올라갑니다.`,
    };
  }

  if (handoff?.state === "open") {
    return { step: "handoff", primary: { label: "상태 다시 확인" }, why: "개발자가 보고 있습니다" };
  }
  if (handoff?.state === "changes_requested") {
    return {
      step: "handoff",
      primary: { label: "상태 다시 확인" },
      why: "변경 요청이 왔습니다 — 대화에서 이어 가세요",
    };
  }

  if (branch) {
    return {
      step: "save",
      primary: { label: "개발자에게 넘기기" },
      why: "저장한 것을 개발자가 볼 수 있게 보냅니다.",
    };
  }

  return {
    step: "create",
    primary: { label: "새 대화" },
    why: "기획서를 첨부하고 화면을 시켜 보세요.",
  };
}
