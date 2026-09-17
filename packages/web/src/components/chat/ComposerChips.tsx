/**
 * 컴포저 상태 칩 (docs/plan/chat.md §1.3, §4.3): "저장 안 함 상태의
 * 심장박동" — 입력창 위, 두 칩뿐이다. 계산은 `lib/delivery.ts` 의
 * `deriveDelivery` 를 그대로 빌려 쓴다(잠금 규칙 재사용 계약); 상태 칩
 * 자체의 글자는 이 목업 어휘가 새로 쓴 것으로, 제목바(product 슬라이스)의
 * 더 자세한 문장과는 다른, 일부러 뭉툭한 심장박동이다.
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
  /** "저장하지 않은 변경 N개" 클릭 → 살아있는 저장 카드로 스크롤 + flash. */
  onScrollToSave: () => void;
  /** "지금 저장하기" 클릭 → 스크롤 + 저장(§4.1 과 같은 핸들러). */
  onSaveNow: () => void;
}

export function ComposerChips({
  pendingChanges,
  branch,
  phase,
  handoff,
  running,
  shelf,
  onScrollToSave,
  onSaveNow,
}: ComposerChipsProps) {
  const delivery = deriveDelivery({ pendingChanges, branch, phase, handoff, running, shelf });
  if (!delivery) return null;

  // 상태 칩: repo.pendingChanges·repo.shelf 로 기계적으로 정해진다 — 개발자
  // 검토 중·변경 요청 같은 더 자세한 말은 제목바(product 슬라이스)의 몫이고,
  // 여기는 "저장할 게 있는가"만 심장박동으로 뛴다.
  const statusChip =
    pendingChanges > 0 ? "unsaved" : shelf ? "shelf" : branch || handoff ? "saved" : null;

  // "지금 저장하기": 변경이 있고 도는 중이 아닐 때만 나타난다. 잠금 이유는
  // deriveDelivery 의 save 액션을 그대로 읽는다 — 판정을 다시 쓰지 않는다.
  const showSaveNow = pendingChanges > 0 && !running;
  const saveAction = delivery.actions.save;

  if (!statusChip && !showSaveNow) return null;

  return (
    <div className="inbox-chips">
      {statusChip === "unsaved" && (
        <button type="button" className="chip chip--save" onClick={onScrollToSave}>
          <span className="dot dot--ask" />
          저장하지 않은 변경 {pendingChanges}개
        </button>
      )}
      {statusChip === "shelf" && (
        <Tip label="더 보기 메뉴에서 꺼내면 이어서 작업합니다">
          <span className="chip chip--shelf">치워둔 작업</span>
        </Tip>
      )}
      {statusChip === "saved" && <span className="chip chip--saved">모두 저장됨</span>}
      {showSaveNow && (
        <Tip label={saveAction.enabled ? undefined : saveAction.reason}>
          <button
            type="button"
            className="chip chip--now"
            disabled={!saveAction.enabled}
            onClick={onSaveNow}
          >
            지금 저장하기
          </button>
        </Tip>
      )}
    </div>
  );
}
