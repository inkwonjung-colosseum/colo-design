import type { RefObject } from "react";
import { L } from "../labels";
import type { Journey } from "../lib/journey";
import { Popover } from "../ui/Popover";

/**
 * `이번 작업` 팝오버의 자리(U2) — 여정을 누르면 뜬다. 지금은 머리(제목 · 한
 * 줄)와 세 점의 막대만 선다; 바뀐 화면 · 제출 기록 · 개발자 코멘트 · `작업 기록
 * 열기` 는 단계 4 가 이 몸통을 바꿔 채운다.
 */
export function WorkPopover({
  anchor,
  journey,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  journey: Journey;
  onClose: () => void;
}) {
  const sub =
    journey.cycle === "draft"
      ? L.work.subDraft
      : journey.cycle === "review"
        ? L.work.subReview
        : L.work.subMerged;
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" className="nx-work-pop">
      <div className="nx-wp-h">
        <b>{L.work.title}</b>
        <div>{sub}</div>
      </div>
      <div className={`nx-wp-journey nx-cycle--${journey.cycle}`}>
        {journey.points.map((point) => (
          <div key={point.label} className={`nx-wp-step nx-wp-step--${point.state}`}>
            {point.label}
          </div>
        ))}
      </div>
      <div className="nx-wp-sec">
        <h5>{L.work.changed}</h5>
        <div className="nx-wp-empty">
          {journey.cycle === "merged" ? L.work.changedEmptyMerged : journey.submit.reason}
        </div>
      </div>
    </Popover>
  );
}
