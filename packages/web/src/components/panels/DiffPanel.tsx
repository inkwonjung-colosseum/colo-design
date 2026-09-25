import type { DiffFile, DiffStatus } from "@colo-design/protocol";

/**
 * 저장·넘기기가 함께 쓰는 진행 어휘 (구 DiffPanel 의 몸통): 모달 검토가
 * 대화 안 카드로 옮겨 간 뒤에도 이 어휘는 한 곳에 산다 — `stageLine` 을
 * 읽는 표면(기록 드로어·저장 카드·넘기기 카드)이 각자 문장을 쓰면 같은
 * 단계가 두 이름을 입는 병이 도로 생긴다. 파일 이름은 `HistoryDrawer` 가
 * 함께 쓰는 수입 경로를 지키려고 그대로 두었다.
 */

/** 파일 한 줄의 상태 단어 — 화면 패널의 개발자 검토 행이 입는다. */
export const FILE_STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "추가",
  modified: "수정",
  deleted: "삭제",
  renamed: "이름 변경",
};

const STAGE_LABEL: Record<DiffStatus["stage"], string> = {
  computing: "변경사항을 모으는 중",
  pushing: "변경사항을 보관하는 중",
  published: "보관했습니다",
  "handing-off": "개발자에게 보내는 중",
  "handed-off": "개발자에게 보냈어요",
  failed: "끝내지 못했습니다",
};

/**
 * Gates arrive as the daemon's own identifiers — `commit`, `push`, `pr`. Read
 * out raw they put git's vocabulary back on the planner's screen one word at
 * a time, so each names the step it actually is instead. The words a
 * repo's own command goes by (`레포 검사`) come from labels.ts — the
 * same job must not wear two names between the transcript and this line.
 */
const GATE_LABEL: Record<NonNullable<DiffStatus["gate"]>, string> = {
  commit: "변경사항 정리",
  push: "변경사항 올리기",
  diff: "변경사항 확인",
  pr: "제출",
};

/** In flight: neither a 저장 nor a 넘기기 can be started on top of this. */
export const RUNNING: DiffStatus["stage"][] = ["computing", "pushing", "handing-off"];

/**
 * The one progress line every save/handoff surface reads. 저장 and 넘기기
 * stream on the same `diff.status` channel, so a second reading of it would
 * only be a second place to forget a stage. A failed stage names the step it
 * stopped at — "끝내지 못했습니다 · 개발자에게 전달" 처럼 실패와 완료가 한 줄에
 * 공존하는 문장이 아니라 (실사 결함), 어느 단계까지 갔는지가 그 자체로 읽힌다.
 */
export function stageLine(status: DiffStatus | null): string {
  if (!status) return "";
  if (status.stage === "failed") {
    return `${GATE_LABEL[status.gate ?? "diff"]}에서 멈췄습니다`;
  }
  const label = STAGE_LABEL[status.stage];
  // A settled stage names itself; which gate ran matters only while one is
  // running, or when it is the one that failed.
  const settled = status.stage === "published" || status.stage === "handed-off";
  if (!status.gate || settled) return label;
  return `${label} · ${GATE_LABEL[status.gate]}`;
}
