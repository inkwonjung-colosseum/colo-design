import type { Block } from "./daemon-client";

/**
 * 화면 카드의 상태 칩 — docs/plan/chat.md §3.3. 순수 함수: 칩이 말하는
 * 것은 어디까지나 사이클(저장·넘김·반영)의 진척이고, 그 진실은 데몬의
 * `repo` 브로드캐스트와 세션 테이프가 안다. 이 파일은 판정만 한다.
 *
 * "마지막 저장"은 **그 카드의 답변 뒤에 온** 마지막 저장이다(chat.md
 * §4.2의 목업 이야기): 넘김→코멘트→고침의 다음 라운드에서 새 답변은
 * 자기를 담은 저장을 아직 갖지 못했으므로 `저장 전`으로 되돌아 간다.
 * 저장이 route 를 담았는지는 파일 단위로 알 수 없어 스펙대로 전역
 * `pendingChanges` 로 판정한다 — 대략의 진행 표시이지 감사가 아니다.
 */

/** `repo.handoff.state` 중 칩이 읽는 것 — null 은 아직 넘긴 적 없음. */
type ScreenHandoffState = "open" | "changes_requested" | "merged" | "closed";

export type ScreenChipTone = "ok" | "info" | "danger" | "default";

export interface ScreenChip {
  label: string;
  tone: ScreenChipTone;
}

/** 데몬 `repo` 중 칩이 읽는 두 값 — 호출부가 즉석에서 줄인다. */
export interface ScreenRepoSnapshot {
  /** `repo.pendingChanges`. null 은 데몬이 아직 모름(미연결·재생 테이프). */
  pendingChanges: number | null;
  handoffState: ScreenHandoffState | null;
}

export interface ScreenChipInput extends ScreenRepoSnapshot {
  /** 마지막 저장이 담은 화면들 — 이 답변 이후의 것(latestSaveAfter). */
  savedScreens: ReadonlyArray<{ route: string }>;
}

/**
 * route 의 사이클 진행을 칩으로: 저장 전 → 저장됨 → 확인 중/반영됨.
 * 저장됨은 여정의 누적이다(목업: `저장됨`+`확인 중`, `저장됨`+`반영됨`) —
 * 넘김 칩은 그 화면의 작업이 저장에 담겼을 때만 온다. 반려(closed)는
 * §5.4: 별도 카드가 아니라 칩 어휘로만 남는다. `지금 화면`(미리보기가
 * 보는 중)은 사이클이 아니므로 여기가 아니라 렌더가 얹는다.
 */
export function screenChips(route: string, input: ScreenChipInput): ScreenChip[] {
  const chips: ScreenChip[] = [];
  const saved = input.savedScreens.some((screen) => screen.route === route);
  if (saved) {
    chips.push({ label: "저장됨", tone: "ok" });
    if (input.handoffState === "open" || input.handoffState === "changes_requested") {
      chips.push({ label: "확인 중", tone: "info" });
    } else if (input.handoffState === "merged") {
      chips.push({ label: "반영됨", tone: "ok" });
    } else if (input.handoffState === "closed") {
      chips.push({ label: "반려", tone: "danger" });
    }
  } else if (input.pendingChanges !== null && input.pendingChanges > 0) {
    chips.push({ label: "저장 전", tone: "default" });
  }
  return chips;
}

/** 이 답변 뒤에 온 마지막 저장 — 시각(캡션)과 화면별 고침 설명(제목 접미)을 운반한다. */
export interface SaveCover {
  at: string;
  screens: ReadonlyArray<{ route: string; title: string; note?: string }>;
}

/**
 * 그 답변 이후의 마지막 `cycle.saved`. 테이프의 저장 블록을 거꾸로 훑어
 * 처음 만나는 것 — "마지막 저장"이 그 카드의 작업을 담았는지는 그 저장의
 * screens 가 안다. 답변이 저장 뒤에 온 옛 카드는 null (이미 지난 라운드).
 */
export function latestSaveAfter(blocks: Block[], index: number): SaveCover | null {
  for (let i = blocks.length - 1; i > index; i -= 1) {
    const block = blocks[i];
    if (block?.type === "save") return { at: block.at, screens: block.screens };
  }
  return null;
}
