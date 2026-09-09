import type { DocSummary, DrafthouseScreen, HandoffStatus } from "@drafthouse/protocol";

/**
 * Where one 기획서 has got to, and therefore what to do with it next
 * (PLAN D8).
 *
 * This is the only place that decides. The page tree's marks and the stepper
 * above the document read the same function, so the badge and the button can
 * never disagree about the same page — before this, one was computed in
 * `PageTree` and the other did not exist, and adding a second opinion is how
 * they start drifting.
 *
 * Every signal here is mechanical: a file the mirror says is edited, a screen
 * the repo declared, a pull request GitHub reports. Nothing asks whether the
 * work is any GOOD — that judgement belongs to the planner, and 넘기기 전 점검
 * is where it gets asked out loud.
 */

export type StageId =
  | "writing"
  | "publish"
  | "build"
  | "revise"
  | "save"
  | "handoff"
  | "merged";

/**
 * The seven words a planner reads most often in this tool.
 *
 * They are a DRAFT until `OBSERVE.md` is filled in — M6.5 watches planners
 * work and records what they call these steps themselves. When that record
 * disagrees with this table, the record wins and only this table changes.
 */
export const STAGES: Array<{ id: StageId; label: string }> = [
  { id: "writing", label: "기획서 쓰기" },
  { id: "publish", label: "게시" },
  { id: "build", label: "화면 만들기" },
  { id: "revise", label: "검토·수정" },
  { id: "save", label: "저장" },
  { id: "handoff", label: "개발자에게 넘기기" },
  { id: "merged", label: "반영됨" },
];

/** What the one primary button does. `null` on a step that only reports. */
export type StageAction =
  | "publishDoc"
  | "buildScreen"
  | "viewScreen"
  | "save"
  | "handoff"
  | "refreshHandoff"
  | null;

export interface Stage {
  id: StageId;
  /** 0-based position in `STAGES`, for the rail. */
  index: number;
  label: string;
  /** The single primary button, or null when the step only reports state. */
  primary: { label: string; action: StageAction } | null;
  /** Why this step and not the next one — shown under the rail, and in tests. */
  reason: string;
  /** The tree's one-glyph form of the same verdict. */
  mark: string;
}

export interface StageInput {
  /** The open 기획서, or null when the tree has no selection. */
  page: DocSummary | null;
  /** What the connected repo declared it can render (empty until it loads). */
  screens: DrafthouseScreen[];
  /** Uncommitted changes in the clone, as the daemon last counted them. */
  pendingChanges: number;
  /** This cycle's branch, or null before the first 저장. */
  branch: string | null;
  handoff: HandoffStatus | null;
}

/**
 * The tree's one-glyph form. ○ means no screen exists yet, ◐ means one does —
 * the same two marks the tree carried before this function absorbed it, so a
 * planner's reading of the sidebar does not change under them.
 */
const MARK: Record<StageId, string> = {
  writing: "○",
  publish: "○",
  build: "○",
  revise: "◐",
  save: "◐",
  handoff: "✓",
  merged: "●",
};

function stage(
  id: StageId,
  reason: string,
  primary: { label: string; action: StageAction } | null,
): Stage {
  const index = STAGES.findIndex((entry) => entry.id === id);
  return { id, index, label: STAGES[index]!.label, primary, reason, mark: MARK[id] };
}

/**
 * The order below is the order the checks must run in, and each one is a
 * question about something that already happened rather than about intent.
 *
 * Handoff first: once a developer is holding the work, that is the truest
 * thing about this 기획서, and a screen edited afterwards is a revision OF a
 * handoff rather than a fresh start. Publishing beats having a screen, because
 * a 기획서 that only exists on this machine cannot be the thing a developer
 * reads — the PR body links Confluence.
 */
export function deriveStage(input: StageInput): Stage {
  const { page, screens, pendingChanges, branch, handoff } = input;

  if (!page) {
    return stage("writing", "왼쪽에서 기획서를 골라 주세요.", null);
  }

  const handedOver = handoff !== null && handoff.pageIds.includes(page.pageId);
  if (handedOver && handoff.state === "merged") {
    return stage("merged", "개발자가 받아 갔습니다. 다음 변경은 새로 시작합니다.", null);
  }

  // A page that has never reached Confluence has nothing for a developer to
  // read, whatever else is true of it.
  if (page.isNew) {
    return stage("publish", "아직 Confluence에 올라가지 않은 새 기획서입니다.", {
      label: "기획서 게시",
      action: "publishDoc",
    });
  }
  if (page.modified) {
    return stage("publish", "고친 내용이 아직 Confluence에 올라가지 않았습니다.", {
      label: "기획서 게시",
      action: "publishDoc",
    });
  }

  const built = screens.some((screen) => screen.spec === page.path);

  // Work already with a developer. New edits since then are a revision of it,
  // not a new cycle — the same pull request accumulates them.
  if (handedOver && pendingChanges === 0) {
    return stage("handoff", "개발자가 보고 있습니다.", {
      label: "상태 다시 확인",
      action: "refreshHandoff",
    });
  }

  if (!built) {
    return stage("build", "이 기획서로 만든 화면이 아직 없습니다.", {
      label: "이 문서로 화면 만들기",
      action: "buildScreen",
    });
  }

  if (pendingChanges > 0) {
    return stage("revise", `아직 저장하지 않은 화면 변경이 ${pendingChanges}건 있습니다.`, {
      label: "저장",
      action: "save",
    });
  }

  if (branch) {
    return stage("save", "저장했습니다. 이제 개발자에게 넘길 수 있습니다.", {
      label: "개발자에게 넘기기",
      action: "handoff",
    });
  }

  /**
   * A screen exists, the clone is clean, and nothing was saved this cycle: the
   * screen came from an earlier cycle a developer already merged, or from the
   * base branch. There is nothing to save and nothing to hand over, so the
   * useful move is to go and look at it — which is also how the planner finds
   * the next thing to change.
   */
  return stage("revise", "화면은 있지만 이번에 저장한 변경이 없습니다.", {
    label: "화면 보기",
    action: "viewScreen",
  });
}

/**
 * What the tree says about a page: the four marks it has always shown, in the
 * tree's own words.
 *
 * The VERDICT comes from `deriveStage`, so the sidebar and the stepper can
 * never disagree about whether a 기획서 has a screen. The WORDING does not,
 * and deliberately: the stepper is about a cycle — uncommitted files, this
 * project's branch, one pull request — and none of that is per-page. A tree
 * row that said "화면은 있지만 이번에 저장한 변경이 없습니다" would be answering
 * a question the sidebar never asked.
 */
const MARK_TITLE: Record<string, string> = {
  "○": "기획 중 — 아직 이 기획서로 만든 화면이 없습니다",
  "◐": "화면 있음 — 이 기획서로 만든 화면이 레포에 있습니다",
  "✓": "넘김 — 개발자가 보고 있습니다",
  "●": "반영됨 — 개발자가 받아 갔습니다",
};

export function pageMark(
  page: DocSummary,
  screens: DrafthouseScreen[],
  handoff: HandoffStatus | null,
): { mark: string; title: string } {
  // Zero and null on purpose: the clone's dirty-file count is one number for
  // the whole project, and asking it per page would mark every row at once.
  const derived = deriveStage({ page, screens, pendingChanges: 0, branch: null, handoff });
  return { mark: derived.mark, title: MARK_TITLE[derived.mark] ?? derived.label };
}
