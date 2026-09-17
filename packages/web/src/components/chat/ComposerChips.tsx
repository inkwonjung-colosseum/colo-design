/**
 * 컴포저 상태 칩: 저장 · 넘기기의 실행 자리. 카드는 없다 — 대기 상태의
 * 심장박동(상태 칩)과 실행 버튼(변경사항 저장 → 개발자에게 보내기)이
 * 입력창 위에 나란히 선다. 계산은 `lib/delivery.ts` 의 `deriveDelivery`
 * 를 그대로 빌려 쓴다(잠금 규칙 재사용 계약) — 칩이 판정을 다시 쓰지
 * 않는다.
 */
import type { HandoffStatus, RepoPhase } from "@colo-design/protocol";
import { deriveDelivery } from "../../lib/delivery";
import { Tip } from "../shell/Tip";

export interface ComposerChipsProps {
  pendingChanges: number;
  branch: string | null;
  phase: RepoPhase | null;
  handoff: HandoffStatus | null;
  running: boolean;
  shelf: { at: string } | null;
  /** 저장·넘기기가 오가는 중(computing · pushing · handing-off) — 버튼이 진행을 말한다. */
  savingInFlight: boolean;
  /** "변경사항 저장" 클릭 → 저장(상단바·⌘S 와 같은 핸들러). */
  onSaveNow: () => void;
  /** "개발자에게 보내기" 클릭 → 대화 안의 넘기기 카드를 연다. */
  onHandoff: () => void;
}

export function ComposerChips({
  pendingChanges,
  branch,
  phase,
  handoff,
  running,
  shelf,
  savingInFlight,
  onSaveNow,
  onHandoff,
}: ComposerChipsProps) {
  const delivery = deriveDelivery({ pendingChanges, branch, phase, handoff, running, shelf });

  // 상태 칩: repo.pendingChanges·repo.shelf 로 기계적으로 정해진다 — 개발자
  // 검토 중·변경 요청 같은 더 자세한 말은 제목바(product 슬라이스)의 몫이고,
  // 여기는 "저장할 게 있는가"만 심장박동으로 뛴다.
  const statusChip =
    pendingChanges > 0 ? "unsaved" : shelf ? "shelf" : branch || handoff ? "saved" : null;

  // 실행 버튼은 상태가 정한다: 변경이 있으면 저장, 저장만 끝난 사이클
  // (열린 요청 없음)이면 넘기기. 나머지 상태(검토 중·반려·반영됨)는
  // 상태 칩과 상단 바의 몫이다.
  const saveAction = delivery?.actions.save;
  const handoffAction = delivery?.actions.handoff;

  if (!statusChip) return null;

  return (
    <div className="inbox-chips">
      {statusChip === "unsaved" && (
        <span className="chip chip--save">
          <span className="dot dot--ask" />
          저장하지 않은 변경 {pendingChanges}개
        </span>
      )}
      {pendingChanges > 0 && saveAction && (
        <Tip label={saveAction.enabled && !savingInFlight ? undefined : saveAction.reason}>
          <button
            type="button"
            className="chip chip--now"
            disabled={!saveAction.enabled || savingInFlight}
            onClick={onSaveNow}
          >
            {savingInFlight ? "저장하는 중…" : "변경사항 저장"}
          </button>
        </Tip>
      )}
      {statusChip === "saved" && <span className="chip chip--saved">모두 저장됨</span>}
      {handoffAction?.enabled && (
        <button type="button" className="chip chip--now" onClick={onHandoff}>
          개발자에게 보내기
        </button>
      )}
    </div>
  );
}
