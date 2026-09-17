import type { HandoffStatus, RepoPhase } from "@colo-design/protocol";

/**
 * 배치 상태는 칩 하나, 동작은 상수. 스테퍼의 다섯 단계 레일은
 * 지워졌다 — 이 파일은 그 판정만 이어받되, 인덱스를 만들지 않고 **사실을 그대로
 * 내놓는다**: 지금 어느 상태인지, 칩이 무슨 말을 하는지, 저장·넘기기·상태 확인
 * 셋이 각각 열려 있는지 잠겼는지와 잠긴 이유 한 문장. 화면이 이 판정을 어떻게
 * 그릴지는 ScreenPanel 의 몫이다.
 *
 * 사이드바 행 표식은 이 파일의 단어 상수를 빌려 쓴다 — 행과 칩이 어긋날 길이
 * 없다.
 */
export const WORKING_LABEL = "작업 중";
export const HANDOFF_BADGE = "넘김";
export const MERGED_BADGE = "반영됨";
export const changesBadge = (count: number): string => `변경 ${count}`;

/** The rows of the table — mechanical, no screen list needed. `closed`
 *  (개발자 반려) joined later: 그 전까지 반려된 요청은
 *  `저장됨` 으로 위장돼 넘기기까지 열려 있었다. */
type DeliveryState =
  | "clean"
  | "unsaved"
  | "saved"
  | "handed"
  | "changes_requested"
  | "merged"
  | "closed";

/** 칩의 색 — the tones styles.css knows. */
type DeliveryTone = "none" | "pending" | "saved" | "handed" | "changes" | "merged" | "shelf";

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
    /**
     * 문서앱 제목바 문법(`바꿈 N · 저장 안 됨` — docs/plan/preview.md §1-B,
     * README D6). N 은 "화면을 바꾼 턴 수"가 목표지만 지금 데이터로는
     * `pendingChanges`로 근사한다 — 필드명을 docLabel 로 둔 것은 나중에
     * 정확한 수(`pendingScreens` 등)로 갈아 끼우기 위해서다.
     */
    docLabel: string;
  };
  /**
   * 그 순간 가장 자연스러운 다음 수 하나.
   * 강조 판정이 상단 바의 인라인 삼항에 흩어져 있으면 복도 버튼(DiffPanel)
   * 까지 네 군데에서 제각각 읽는다 — 칩·버튼·복도가 하나의 원천을 본다.
   * `변경 요청` 처럼 눌러야 할 것이 회색으로 남는 일이 없어진다.
   */
  primary: "save" | "handoff" | "check" | null;
  /**
   * 지금 상태 한 줄 + 다음 한 동작: 칩 팝오버와
   * 개발자 패널 머리가 **같은 문장**을 읽는다 — 두 표면이 각자 문자열을
   * 가지면 칩과 진실이 어긋나던 병이 문장 층에서 재발한다(사이드바 배지가
   * 이 파일의 단어를 빌려 쓰는 규율).
   */
  next: { line: string };
  actions: {
    save: DeliveryAction;
    handoff: DeliveryAction;
    /** 상태 확인은 PR 이 있을 때만 그린다 — 없을 때 확인할 것이 없다. */
    check: DeliveryAction | null;
  };
}

export interface DeliveryInput {
  /**
   * Unsaved-change files. 칩의 숫자는 그만두었다:
   * 파일 수는 기획자의 체감과 역상관이라서.
   * 판정(0인가 아닌가)과 버리기 확인의 개수는 여전히 이 값을 쓴다.
   */
  pendingChanges: number;
  /** This cycle's `colo-design/…` branch, or null before the first 저장. */
  branch: string | null;
  /** null before the daemon has reported — as good as not ready. */
  phase: RepoPhase | null;
  /** The open (or merged) pull request of this save cycle. */
  handoff: HandoffStatus | null;
  /** An agent turn is running in the open thread. */
  running: boolean;
  /**
   * 치워둔 작업: the ONE shelf slot, or null.
   * While filled, the clean row's chip must not say `변경 없음` — parked is
   * a state, not an absence; a gray there read as "nothing to do" is how a
   * parked work comes to feel lost.
   */
  shelf?: { at: string } | null;
}

export const BUSY_SAVE = "AI가 고치는 중 — 끝나면 저장할 수 있습니다";
const NOTHING_TO_SAVE = "저장할 변경이 없습니다";
/**
 * 치워둔 작업이 있을 때의 저장·넘기기 잠금 이유: "없다"는
 * 문장(NOTHING_TO_SAVE)이 치워둔 순간 거짓말이 되므로, 없는 말은 치워둔 곳을
 * 가리킨다. 칩은 clean 행에서만 바뀌고(칩 하나 계약), 다른 행에서는
 * 이 title 들이 자리를 지킨다.
 */
const PARKED_AWAY = "치워둔 작업이 있습니다 — 더 보기 메뉴에서 꺼내 주세요";

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
 * `error` 는 예외: 미리보기 서버가 죽어도 워크트리와 원격은 살아 있어 저장·
 * 넘기기가 열려 있으니(ScreenPanel 의 `workable`), 칩이 "화면 대기 중" 으로
 * 워크트리의 진실을 지우면 안 된다. 어느 행에 설지는 cycleRow 가 정하고,
 * 턴이 도는 동안 칩의 말은 사이드바 행의 우선순위를 따른다.
 */
export function deriveDelivery(input: DeliveryInput): Delivery | null {
  const { pendingChanges, phase, running } = input;
  if (phase !== "ready" && phase !== "error") return null;
  const row = cycleRow(input);
  const chip = { ...row.chip, docLabel: docLabel(row, input) };
  // 행과 칩이 어긋나면 안 된다: 턴이 도는 동안 사이드바 행은 넘김 ·
  // 반영됨 대신 작업 중을 말하는데, 오른쪽 칩이 반영됨을 말하고 있으면 둘이
  // 어긋난다. 말만 바뀐다 — 저장 · 넘기기의 잠김은 표가 정한 그대로다.
  if (!running) return { ...row, chip };
  return {
    ...row,
    chip: {
      ...chip,
      label: pendingChanges > 0 ? "고치는 중" : WORKING_LABEL,
      tone: "pending",
    },
  };
}

/**
 * 문서앱 칩의 한 줄 — 표의 행마다 정해진다(문자열 생성은 이 파일의 일,
 * 컴포넌트에 분기를 두지 않는다). `바꿈 N` 의 N 은 바뀐 화면 수가 목표지만
 * 그 데이터가 오기 전까지 pendingChanges 로 근사한다.
 */
function docLabel(row: CycleRow, input: DeliveryInput): string {
  const unsaved = input.pendingChanges > 0;
  if (input.running && unsaved) return "고치는 중";
  switch (row.state) {
    case "unsaved":
      return `바꿈 ${input.pendingChanges} · 저장 안 됨`;
    case "saved":
      return "모두 저장됨";
    case "handed":
      return "검토 중";
    case "changes_requested":
      return "변경 요청";
    case "closed":
      return "개발자가 반려함";
    case "merged":
      // unsaved 가 앞선다 — 머지 뒤에 쌓인 바꿈은 `반영됨` 이 가리지 않는다.
      return unsaved ? `바꿈 ${input.pendingChanges} · 저장 안 됨` : "반영됨";
    case "clean":
      return input.shelf ? "치워둔 작업 1건" : "변경 없음";
  }
}

/**
 * cycleRow 가 채우는 행 — docLabel 은 아직 없다: 그 문자열은 행이 정해진
 * 뒤 deriveDelivery 가 docLabel() 로 덧붙인다(문법이 한 곳에 모이게).
 */
type CycleRow = Omit<Delivery, "chip"> & { chip: Omit<Delivery["chip"], "docLabel"> };

/**
 * 어느 행에 서는지는 전부 기계적으로 정해진다. `unsaved` 가 PR
 * 상태보다 앞선다 — 칩은 하나고 "지금 눌러야 할 것"은 저장이기 때문이다; PR 은
 * 상태 확인 버튼의 존재와 칩의 title 로 남는다.
 */
function cycleRow(input: DeliveryInput): CycleRow {
  const { pendingChanges, branch, handoff, running } = input;
  const unsaved = pendingChanges > 0;
  const saveLocked = unsaved && running;
  // 치워둔 작업이 있으면 "없다"는 거짓말 — 잠금 이유가 치워둔 곳을 가리킨다.
  const saveReason = input.shelf ? PARKED_AWAY : NOTHING_TO_SAVE;
  if (handoff?.state === "merged") {
    // unsaved 가 앞선다(위의 원칙): 머지 뒤에 쌓인 변경을 `반영됨` 이
    // 가리면 저장할 일감 자체가 칩에서 사라진다 — 말은 `저장 안 함` 이
    // 하고, 머지라는 사실은 title 과 다음 줄이 전한다.
    return {
      state: "merged",
      chip: unsaved
        ? {
            label: "저장 안 함",
            tone: "pending",
            title: "다음 저장은 새 사이클을 시작합니다",
          }
        : {
            label: "반영됨",
            tone: "merged",
            title: "다음 저장은 새 사이클을 시작합니다",
          },
      next: {
        line: unsaved
          ? "이번 작업이 제품에 합쳐졌습니다 — 저장하지 않은 작업이 있으니 저장이 새 사이클을 엽니다"
          : "이번 작업이 제품에 합쳐졌습니다 — 다음 저장은 새 작업을 시작합니다",
      },
      primary: unsaved ? "save" : null,
      actions: {
        save: unsaved
          ? running
            ? { enabled: false, reason: BUSY_SAVE }
            : { enabled: true }
          : { enabled: false, reason: saveReason },
        handoff: { enabled: false, reason: "개발자가 이미 받아 갔습니다" },
        check: null,
      },
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
      chip: {
        label: "개발자가 반려함",
        tone: "changes",
        title: `개발자가 넘긴 요청 ${handoff.number}번을 닫았습니다 — 코멘트를 읽고 이어 가세요`,
      },
      next: {
        line: "개발자가 이번 요청을 닫았습니다 — 상태 확인에서 이유를 읽고, 고쳐 저장하면 새 요청이 열립니다",
      },
      primary: "check",
      actions: {
        save: unsaved
          ? running
            ? { enabled: false, reason: BUSY_SAVE }
            : { enabled: true }
          : { enabled: false, reason: saveReason },
        handoff: {
          enabled: false,
          reason: "개발자가 이번 요청을 닫았습니다 — 새로 저장하면 새 요청이 열립니다",
        },
        check: { enabled: true },
      },
    };
  }

  if (unsaved) {
    return {
      state: "unsaved",
      chip: {
        // 파일 수는 칩에서 나갔다: 핀 하나가 파일
        // 셋을 건드리면 3건, 핀 둘이 한 파일에 모이면 1건 — 숫자가 체감과
        // 역상관이었다. 개수는 저장 검토의 `자세히 보기`에만 산다.
        label: running ? "고치는 중" : "저장 안 함",
        tone: "pending",
        ...(handoff ? { title: "저장하면 넘긴 요청에 함께 담깁니다" } : {}),
      },
      next: {
        line: running
          ? "AI가 고치는 중입니다 — 끝나면 남은 작업을 저장으로 묶으세요"
          : "저장하지 않은 작업이 있습니다 — 저장을 눌러 검토하고 이번 작업에 묶으세요",
      },
      primary: "save",
      actions: {
        save: saveLocked ? { enabled: false, reason: BUSY_SAVE } : { enabled: true },
        handoff: { enabled: false, reason: "저장하지 않은 변경이 있습니다" },
        check: handoff ? { enabled: true } : null,
      },
    };
  }

  if (handoff?.state === "open") {
    return {
      state: "handed",
      chip: {
        label: "개발자 검토 중",
        tone: "handed",
        title: `넘긴 요청 ${handoff.number}번을 개발자가 검토하는 중입니다${
          reviewerNote(handoff) ? ` · ${reviewerNote(handoff)}` : ""
        }`,
      },
      next: {
        line: `넘긴 요청 ${handoff.number}번을 개발자가 보고 있습니다 — 상태 확인으로 최근 소식을 보세요`,
      },
      primary: "check",
      actions: {
        save: { enabled: false, reason: saveReason },
        handoff: {
          enabled: false,
          reason: "이미 넘겼습니다 — 새로 저장하면 같은 요청에 합쳐집니다",
        },
        check: { enabled: true },
      },
    };
  }

  if (handoff?.state === "changes_requested") {
    return {
      state: "changes_requested",
      chip: {
        label: "변경 요청",
        tone: "changes",
        title: `개발자가 넘긴 요청 ${handoff.number}번에 코멘트를 남겼습니다 — 상태 확인에서 이어 가세요`,
      },
      next: {
        line: "개발자가 코멘트를 남겼습니다 — 상태 확인에서 읽고 고치기로 이어 가세요",
      },
      // 개발자가 기획자를 기다리는 상태 — 이때 상태 확인이 회색이면 바의
      // 세 버튼이 전부 잠긴 채 며칠이 흐른다.
      primary: "check",
      actions: {
        save: { enabled: false, reason: saveReason },
        handoff: {
          enabled: false,
          reason: "이미 넘겼습니다 — 새로 저장하면 같은 요청에 합쳐집니다",
        },
        check: { enabled: true },
      },
    };
  }

  if (branch) {
    return {
      state: "saved",
      chip: {
        label: "저장됨",
        tone: "saved",
        title: "이번 저장은 아직 개발자에게 전달되지 않았습니다",
      },
      next: { line: "저장했습니다 — 개발자에게 넘기면 검토가 시작됩니다" },
      primary: "handoff",
      actions: {
        save: { enabled: false, reason: saveReason },
        handoff: { enabled: true },
        check: null,
      },
    };
  }

  // 치워둔 작업이 있는 clean 행: `변경 없음` 칩은 존재하지
  // 않는다 — 치워둔 것은 없음이 아니라 상태다. 회색은 "할 일 없음"으로
  // 읽히고(styles.css 4813의 옛 판정), 그 회색이 분실이 시작되는 곳이다.
  if (input.shelf) {
    return {
      state: "clean",
      chip: {
        label: "치워둔 작업 1건",
        tone: "shelf",
        title: "다시 꺼내면 이어서 작업합니다 — 더 보기 메뉴에서 꺼냅니다",
      },
      next: { line: "치워둔 작업이 있습니다 — 더 보기 메뉴에서 꺼내면 이어서 작업합니다" },
      primary: null,
      actions: {
        save: { enabled: false, reason: PARKED_AWAY },
        handoff: { enabled: false, reason: "치워둔 작업을 먼저 꺼내 저장해 주세요" },
        check: null,
      },
    };
  }

  return {
    state: "clean",
    chip: { label: "변경 없음", tone: "none" },
    next: { line: "저장할 새 작업이 없습니다 — 화면을 만들어 달라고 하면 시작됩니다" },
    primary: null,
    actions: {
      save: { enabled: false, reason: saveReason },
      handoff: { enabled: false, reason: "먼저 저장해 주세요" },
      check: null,
    },
  };
}
