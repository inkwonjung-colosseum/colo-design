import type { HandoffStatus, RepoPhase } from "@colo-design/protocol";

/**
 * 배치 상태는 칩 하나, 동작은 상수 (PLAN D81 · D82). 스테퍼의 다섯 단계 레일은
 * 지워졌다 — 이 파일은 그 판정만 이어받되, 인덱스를 만들지 않고 **사실을 그대로
 * 내놓는다**: 지금 어느 상태인지, 칩이 무슨 말을 하는지, 저장·넘기기·상태 확인
 * 셋이 각각 열려 있는지 잠겼는지와 잠긴 이유 한 문장. 화면이 이 판정을 어떻게
 * 그릴지는 ScreenPanel 의 몫이다.
 *
 * 사이드바 행 표식은 이 파일의 단어 상수를 빌려 쓴다 — 행과 칩이 어긋날 길이
 * 없다 (PLAN D45 의 규칙, D81 이 이어받았다).
 */
export const WORKING_LABEL = "작업 중";
export const HANDOFF_BADGE = "넘김";
export const MERGED_BADGE = "반영됨";
export const changesBadge = (count: number): string => `변경 ${count}`;

/** The six rows of the D82 table — mechanical, no screen list needed. */
type DeliveryState = "clean" | "unsaved" | "saved" | "handed" | "changes_requested" | "merged";

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
  };
  actions: {
    save: DeliveryAction;
    handoff: DeliveryAction;
    /** 상태 확인은 PR 이 있을 때만 그린다 — 없을 때 확인할 것이 없다. */
    check: DeliveryAction | null;
  };
}

export interface DeliveryInput {
  /** Unsaved-change files, the chip's number (PLAN D8). */
  pendingChanges: number;
  /** This cycle's `colo-design/…` branch, or null before the first 저장. */
  branch: string | null;
  handoff: HandoffStatus | null;
  /** A Claude turn is running in the open thread. */
  running: boolean;
  /** null before the daemon has reported — as good as not ready. */
  phase: RepoPhase | null;
}

const BUSY_SAVE = "Claude가 고치는 중 — 끝나면 저장할 수 있습니다";
const NOTHING_TO_SAVE = "저장할 변경이 없습니다";

/**
 * `phase !== "ready"` 면 null — 지금처럼 ProgressPanel 이 열을 갖는다. 단
 * `error` 는 예외: 미리보기 서버가 죽어도 워크트리와 원격은 살아 있어 저장·
 * 넘기기가 열려 있으니(ScreenPanel 의 `workable`), 칩이 "화면 대기 중" 으로
 * 워크트리의 진실을 지우면 안 된다. 어느 행에 설지는 cycleRow 가 정하고,
 * 턴이 도는 동안 칩의 말은 사이드바 행의 우선순위(PLAN D45)를 따른다.
 */
export function deriveDelivery(input: DeliveryInput): Delivery | null {
  const { pendingChanges, phase, running } = input;
  if (phase !== "ready" && phase !== "error") return null;
  const row = cycleRow(input);
  // 행과 칩이 어긋나면 안 된다(PLAN D45): 턴이 도는 동안 사이드바 행은 넘김 ·
  // 반영됨 대신 작업 중을 말하는데, 오른쪽 칩이 반영됨을 말하고 있으면 둘이
  // 어긋난다. 말만 바뀐다 — 저장 · 넘기기의 잠김은 표가 정한 그대로다.
  if (!running) return row;
  return {
    ...row,
    chip: {
      ...row.chip,
      label: pendingChanges > 0 ? `고치는 중 · ${pendingChanges}건` : WORKING_LABEL,
      tone: "pending",
    },
  };
}

/**
 * 어느 행에 서는지는 전부 기계적으로 정해진다 (PLAN D82 표). `unsaved` 가 PR
 * 상태보다 앞선다 — 칩은 하나고 "지금 눌러야 할 것"은 저장이기 때문이다; PR 은
 * 상태 확인 버튼의 존재와 칩의 title 로 남는다.
 */
function cycleRow(input: DeliveryInput): Delivery {
  const { pendingChanges, branch, handoff, running } = input;
  const unsaved = pendingChanges > 0;
  const saveLocked = unsaved && running;
  if (handoff?.state === "merged") {
    return {
      state: "merged",
      chip: {
        label: "반영됨",
        tone: "merged",
        title: "다음 저장은 새 사이클을 시작합니다",
      },
      actions: {
        save: unsaved
          ? running
            ? { enabled: false, reason: BUSY_SAVE }
            : { enabled: true }
          : { enabled: false, reason: NOTHING_TO_SAVE },
        handoff: { enabled: false, reason: "개발자가 이미 받아 갔습니다" },
        check: null,
      },
    };
  }

  if (unsaved) {
    return {
      state: "unsaved",
      chip: {
        label: running ? `고치는 중 · ${pendingChanges}건` : `저장 안 함 ${pendingChanges}건`,
        tone: "pending",
        ...(handoff ? { title: "저장하면 넘긴 요청에 함께 담깁니다" } : {}),
      },
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
        title: `넘긴 요청 ${handoff.number}번을 개발자가 검토하는 중입니다`,
      },
      actions: {
        save: { enabled: false, reason: NOTHING_TO_SAVE },
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
      actions: {
        save: { enabled: false, reason: NOTHING_TO_SAVE },
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
      actions: {
        save: { enabled: false, reason: NOTHING_TO_SAVE },
        handoff: { enabled: true },
        check: null,
      },
    };
  }

  return {
    state: "clean",
    chip: { label: "변경 없음", tone: "none" },
    actions: {
      save: { enabled: false, reason: NOTHING_TO_SAVE },
      handoff: { enabled: false, reason: "먼저 저장해 주세요" },
      check: null,
    },
  };
}
