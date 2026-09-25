import type { HandoffStatus, RepoPhase } from "@colo-design/protocol";

/**
 * 배치 상태는 칩 하나, 동작은 상수. 스테퍼의 다섯 단계 레일은
 * 지워졌다 — 이 파일은 그 판정만 이어받되, 인덱스를 만들지 않고 **사실을 그대로
 * 내놓는다**: 지금 어느 상태인지, 칩이 무슨 말을 하는지, 제출·상태 확인 둘이
 * 각각 열려 있는지 잠겼는지와 잠긴 이유 한 문장. 화면이 이 판정을 어떻게
 * 그릴지는 ScreenPanel 의 몫이다.
 *
 * P2-1(자동 저장) 뒤로 이 파일에 `저장` 이라는 단어는 없다. 턴이 끝나면 도구가
 * 스스로 커밋하므로 "저장 안 한 작업" 이라는 상태 자체가 사라졌다. E2 로
 * 칩의 말은 셋으로 접혔다 — `제출 전` · `개발자가 보고 있어요` · `반영됐어요`.
 * 행(constant `state`)은 여전히 다섯으로 기계적 판정에 쓰이되, 사람이 읽는
 * 칩은 그 차이를 말하지 않는다: 코멘트 · 반려 같은 세부는 색(tone) 과
 * title · next.line 이 말한다. 칩은 "어디까지 왔나"만 말한다.
 *
 * 사이드바 행 표식은 이 파일의 단어 상수를 빌려 쓴다 — 행과 칩이 어긋날 길이
 * 없다.
 */
export const WORKING_LABEL = "작업 중";
export const HANDOFF_BADGE = "넘김";
export const MERGED_BADGE = "반영됨";
export const changesBadge = (count: number): string => `변경 ${count}`;

/** 턴이 도는 동안 칩이 하는 말 — 어느 행에 서 있든 이것이 이긴다. */
const MAKING_LABEL = "만드는 중";

/**
 * The rows of the table — mechanical, no screen list needed.
 * `clean` · `unsaved` · `saved` 셋은 P2-1 에서 `unsubmitted` 하나로 접혔다:
 * 자동 저장이 셋을 가르던 유일한 사실(사람이 저장을 눌렀는가)을 없앴으므로,
 * 남는 질문은 "개발자에게 넘겼는가" 하나다.
 */
type DeliveryState = "unsubmitted" | "handed" | "changes_requested" | "merged" | "closed";

/** 칩의 색 — the tones styles.css knows. */
type DeliveryTone = "none" | "pending" | "saved" | "handed" | "changes" | "merged";

/** One button of the action set: 열림, or 잠깐 with its reason in a title. */
interface DeliveryAction {
  enabled: boolean;
  /** 잠긴 이유 한 문장 — the button's title, the planner's only why. */
  reason?: string;
}

export interface Delivery {
  state: DeliveryState;
  chip: {
    label: string;
    tone: DeliveryTone;
    /** 마우스를 올릴 때의 한 문장 — 칩이 말 못한 것을 말한다. */
    title?: string;
    /** 문서앱 제목바 문법 — 칩과 같은 사실을 짧은 말로. */
    docLabel: string;
  };
  /**
   * 그 순간 가장 자연스러운 다음 수 하나.
   * 강조 판정이 상단 바의 인라인 삼항에 흩어져 있으면 복도 버튼(DiffPanel)
   * 까지 네 군데에서 제각각 읽는다 — 칩·버튼·복도가 하나의 원천을 본다.
   * `변경 요청` 처럼 눌러야 할 것이 회색으로 남는 일이 없어진다.
   */
  primary: "submit" | "check" | null;
  /**
   * 지금 상태 한 줄 + 다음 한 동작: 칩 팝오버와
   * 개발자 패널 머리가 **같은 문장**을 읽는다 — 두 표면이 각자 문자열을
   * 가지면 칩과 진실이 어긋나던 병이 문장 층에서 재발한다(사이드바 배지가
   * 이 파일의 단어를 빌려 쓰는 규율).
   */
  next: { line: string };
  actions: {
    /**
     * 제출 = 이번 작업을 개발자에게 넘긴다. P2-1 뒤로 계획자에게 남은 유일한
     * 손이다 — 저장은 턴이 끝날 때마다 도구가 스스로 한다.
     */
    submit: DeliveryAction;
    /** 상태 확인은 PR 이 있을 때만 그린다 — 없을 때 확인할 것이 없다. */
    check: DeliveryAction | null;
  };
}

export interface DeliveryInput {
  /**
   * 아직 커밋되지 않은 파일 수 — 자동 저장 뒤로는 턴이 도는 동안과, 커밋이
   * 걸린 턴에만 0 이 아니다. 판정(0인가 아닌가)과 버리기 확인의 개수는
   * 여전히 이 값을 쓴다.
   */
  pendingChanges: number;
  /** This cycle's `colo-design/…` branch, or null before this cycle's first commit. */
  branch: string | null;
  /** null before the daemon has reported — as good as not ready. */
  phase: RepoPhase | null;
  /** The open (or merged) pull request of this save cycle. */
  handoff: HandoffStatus | null;
  /** An agent turn is running in the open thread. */
  running: boolean;
}

const BUSY_SUBMIT = "AI가 고치는 중 — 끝나면 제출할 수 있습니다";
const NOTHING_TO_SUBMIT = "제출할 변경이 없습니다";

/**
 * 리뷰어 보고: GitHub 이 PR 에 대해 보고한 요청 리뷰어들.
 * undefined(구형 기록)는 "모른다" — 아무 말도 하지 않는다. 빈 배열도 칩 타이틀
 * 에서는 조용하다(넘기기 성공 화면이 그 근거를 길게 말한다).
 */
function reviewerNote(handoff: HandoffStatus): string | null {
  if (handoff.reviewers === undefined || handoff.reviewers.length === 0) return null;
  return handoff.reviewers.join(" · ");
}

/**
 * `phase !== "ready"` 면 null — 지금처럼 ProgressPanel 이 열을 갖는다. 단
 * `error` 는 예외: 미리보기 서버가 죽어도 워크트리와 원격은 살아 있어 제출이
 * 열려 있으니(ScreenPanel 의 `workable`), 칩이 "화면 대기 중" 으로 워크트리의
 * 진실을 지우면 안 된다. 어느 행에 설지는 cycleRow 가 정하고, 턴이 도는 동안
 * 칩의 말은 사이드바 행의 우선순위를 따른다.
 */
export function deriveDelivery(input: DeliveryInput): Delivery | null {
  const { phase, running } = input;
  if (phase !== "ready" && phase !== "error") return null;
  const row = cycleRow(input);
  const chip = { ...row.chip, docLabel: docLabel(row, input) };
  // 행과 칩이 어긋나면 안 된다: 턴이 도는 동안 사이드바 행은 넘김 ·
  // 반영됨 대신 작업 중을 말하는데, 오른쪽 칩이 반영됨을 말하고 있으면 둘이
  // 어긋난다. 말만 바뀐다 — 제출의 잠김은 표가 정한 그대로다.
  if (!running) return { ...row, chip };
  return { ...row, chip: { ...chip, label: MAKING_LABEL, tone: "pending" } };
}

/**
 * 문서앱 칩의 한 줄 — 표의 행마다 정해진다(문자열 생성은 이 파일의 일,
 * 컴포넌트에 분기를 두지 않는다).
 */
function docLabel(row: CycleRow, input: DeliveryInput): string {
  if (input.running) return MAKING_LABEL;
  switch (row.state) {
    case "handed":
    case "changes_requested":
    case "closed":
      return "검토 중";
    case "merged":
      // 새 사이클의 작업이 앞선다 — 머지 뒤에 쌓인 것을 `반영됨` 이 가리지 않는다.
      return hasWork(input) ? "제출 전" : "반영됨";
    case "unsubmitted":
      return "제출 전";
  }
}

/**
 * cycleRow 가 채우는 행 — docLabel 은 아직 없다: 그 문자열은 행이 정해진
 * 뒤 deriveDelivery 가 docLabel() 로 덧붙인다(문법이 한 곳에 모이게).
 */
type CycleRow = Omit<Delivery, "chip"> & { chip: Omit<Delivery["chip"], "docLabel"> };

/**
 * 이번 사이클에 아직 개발자에게 넘어가지 않은 것이 있는가. 자동 저장 뒤의
 * 정상 상태는 `branch`(커밋이 쌓인 사이클 브랜치)이고, `pendingChanges` 는
 * 턴이 도는 중이거나 자동 저장이 걸린 순간의 잔여다 — 둘 중 하나라도 있으면
 * 제출은 할 일이 있다.
 */
function hasWork(input: DeliveryInput): boolean {
  return input.branch !== null || input.pendingChanges > 0;
}

/**
 * 어느 행에 서는지는 전부 기계적으로 정해진다. P2-1 전에는 `unsaved` 가 PR
 * 상태보다 앞섰다 — 칩이 "지금 눌러야 할 것"(저장)을 말해야 했기 때문이다.
 * 자동 저장이 그 버튼을 없앴으므로 이제는 PR 의 상태가 앞선다: 넘긴 뒤에 쌓인
 * 작업은 같은 요청에 합쳐지므로 칩이 새 말을 할 이유가 없다.
 */
function cycleRow(input: DeliveryInput): CycleRow {
  const { handoff, running } = input;
  const work = hasWork(input);
  // 턴이 도는 동안의 제출은 반쯤 고쳐진 화면을 넘긴다 — 끝나고 누른다.
  const submitWhenWork = running
    ? { enabled: false, reason: BUSY_SUBMIT }
    : work
      ? { enabled: true }
      : { enabled: false, reason: NOTHING_TO_SUBMIT };
  if (handoff?.state === "merged") {
    // 새 사이클의 작업이 앞선다(위의 원칙): 머지 뒤에 쌓인 것을 `반영됐어요` 가
    // 가리면 넘길 일감 자체가 칩에서 사라진다.
    return {
      state: "merged",
      chip: work
        ? {
            label: "제출 전",
            tone: "saved",
            title: "이번 제출은 새 사이클을 시작합니다",
          }
        : {
            label: "반영됐어요",
            tone: "merged",
            title: "다음 제출은 새 작업을 시작합니다",
          },
      next: {
        line: work
          ? "이번 작업이 제품에 합쳐졌습니다 — 그 뒤에 만든 것은 제출이 새 사이클로 엽니다"
          : "이번 작업이 제품에 합쳐졌습니다 — 다음 제출은 새 작업을 시작합니다",
      },
      primary: work ? "submit" : null,
      actions: { submit: submitWhenWork, check: null },
    };
  }

  // 반려: 개발자가 요청을 닫으면 그것도
  // 사이클의 끝이다 — merged 행을 미러한다. 이 행이 없던 동안 반려된 요청은
  // `저장됨` + "아직 개발자에게 전달되지 않았습니다"로 위장됐고, 넘기기가
  // 열려 있어 닫힌 요청의 제목·본문만 덮어쓰는 길이 나 있었다. 데몬은 이제
  // 반려를 보면 사이클을 닫고 베이스로 돌아온다(repo.ts refreshHandoff).
  if (handoff?.state === "closed") {
    return {
      state: "closed",
      // 반려도 칩은 같은 말을 한다(E2) — "개발자가 보고 있어요". 색(changes) 과
      // title 이 반려를 정확히 말하고, next.line 이 다음 수를 준다. 칩이 여섯
      // 번째 말을 배우는 것이 사용자에게 남길 것이 아니다.
      chip: {
        label: "개발자가 보고 있어요",
        tone: "changes",
        title: `개발자가 넘긴 요청 ${handoff.number}번을 닫았습니다 — 상태 확인에서 이유를 읽고 이어 가세요`,
      },
      next: {
        line: "개발자가 이번 요청을 닫았습니다 — 상태 확인에서 이유를 읽고, 고쳐 제출하면 새 요청이 열립니다",
      },
      primary: "check",
      actions: { submit: submitWhenWork, check: { enabled: true } },
    };
  }

  if (handoff?.state === "open") {
    return {
      state: "handed",
      chip: {
        label: "개발자가 보고 있어요",
        tone: "handed",
        title: `넘긴 요청 ${handoff.number}번을 개발자가 검토하는 중입니다${
          reviewerNote(handoff) ? ` · ${reviewerNote(handoff)}` : ""
        }`,
      },
      // 기다리는 동안의 할 일을 말한다 — "확인하라" 가 아니라 "계속해도
      // 된다". 자동 보관은 같은 가지로 올라가 열린 요청에 이어 담긴다.
      // 요청 번호는 칩의 title(마우스를 올릴 때)에만 남는다.
      next: {
        line: "개발자가 보고 있어요 — 계속 고쳐도 같은 요청에 이어 담겨요",
      },
      primary: "check",
      // 넘긴 뒤에도 제출은 열어 둔다: 자동 저장의 푸시는 백그라운드라 조용히
      // 실패할 수 있고, 그때 밀린 커밋을 원격까지 밀어 올릴 손은 이것뿐이다
      // (제출만이 푸시를 기다리고 실패를 게이트로 올린다).
      actions: { submit: submitWhenWork, check: { enabled: true } },
    };
  }

  if (handoff?.state === "changes_requested") {
    return {
      state: "changes_requested",
      // 코멘트가 달렸다는 것은 칩의 색(changes) 만이 말한다 — 반영은 도구가
      // 스스로 맡으므로, 사람이 칩에서 읽을 것은 "개발자가 보고 있다"뿐이다.
      chip: {
        label: "개발자가 보고 있어요",
        tone: "changes",
        title: `개발자가 넘긴 요청 ${handoff.number}번에 코멘트를 남겼습니다 — 도구가 반영을 맡깁니다`,
      },
      next: {
        line: "개발자가 코멘트를 남겼습니다 — 도구가 반영을 맡았고 끝나면 알려 드립니다",
      },
      // 개발자 쪽 판정은 도구가 스스로 반영한다(슬라이스 2) — 이때 상태 확인이
      // 회색이면 바의 버튼이 전부 잠긴 채 며칠이 흐른다.
      primary: "check",
      actions: { submit: submitWhenWork, check: { enabled: true } },
    };
  }

  if (work) {
    return {
      state: "unsubmitted",
      chip: {
        label: "제출 전",
        tone: "saved",
        title: "만든 것은 이 컴퓨터에 보관돼 있습니다 — 아직 개발자에게 가지 않았습니다",
      },
      next: { line: "완성했으면 제출을 눌러 개발자에게 보내세요" },
      primary: "submit",
      actions: { submit: submitWhenWork, check: null },
    };
  }

  return {
    state: "unsubmitted",
    // 만든 것이 없어도 칩은 `제출 전` 이다(E2) — `변경 없음` 은 일곱 번째
    // 말을 배우게 할 뿐, 다음 수는 같다: 화면을 만들어 달라고 하는 것.
    chip: { label: "제출 전", tone: "none", title: "새로 만든 것이 없습니다" },
    next: { line: "새로 만든 것이 없습니다 — 화면을 만들어 달라고 하면 시작됩니다" },
    primary: null,
    actions: { submit: { enabled: false, reason: NOTHING_TO_SUBMIT }, check: null },
  };
}
