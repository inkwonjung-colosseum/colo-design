import { timeAgo } from "../../lib/format";
import type { OtherProjectItem } from "../../lib/home-feed";

const EVENT_LABEL: Record<NonNullable<OtherProjectItem["lastEventKind"]>, string> = {
  merged: "반영됨",
  closed: "반려됨",
  changes_requested: "반려됨",
  comments: "코멘트 도착",
};

/** 요약 행 한 줄 — pending 수와 마지막 사건을 가운뎃점으로 잇는다. 어느 쪽도
 *  없으면(필터가 이미 걸러내지만 방어적으로) 빈 문자열을 보이지 않는다. */
function summaryLine(item: OtherProjectItem): string {
  const parts: string[] = [];
  if (item.pendingCount > 0) parts.push(`확인 필요 ${item.pendingCount}건`);
  if (item.lastEventKind) parts.push(EVENT_LABEL[item.lastEventKind]);
  return parts.join(" · ");
}

/**
 * 크로스 프로젝트 인박스(PLAN P3-2)의 "다른 프로젝트" 그룹 — 비활성 프로젝트는
 * 살아 있는 세션이 없어 결정 카드의 인용·즉답을 못 그리므로, 대신
 * 폴러가 준 숫자만으로 한 줄씩 보인다. 클릭 = 그 프로젝트로 전환 — 전환된
 * 프로젝트의 홈이 그 프로젝트의 결정 카드를 보이므로, 대화 자체는 그 다음
 * 카드 클릭에서 열린다(활성 프로젝트 결정 카드와 같은 두 단계).
 */
export function OtherProjectsCard({
  items,
  onOpen,
}: {
  items: OtherProjectItem[];
  onOpen: (slug: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <div className="home-glabel">
        다른 프로젝트에도 확인할 게 있어요 <span className="home-gcount">{items.length}</span>
        <span className="home-gline" />
      </div>
      {items.map((item) => (
        <button
          key={item.slug}
          type="button"
          className="home-card home-card--quiet home-card--other"
          onClick={() => onOpen(item.slug)}
          aria-label={`${item.name} 프로젝트로 전환`}
        >
          <div className="home-row">
            <span className={item.pendingCount > 0 ? "dot dot--ask" : "dot dot--done"} />
            <div className="home-body">
              <div className="home-top">
                <span className="home-name">{item.name}</span>
                {item.lastEventAt && (
                  <span className="home-time">{timeAgo(Date.parse(item.lastEventAt))}</span>
                )}
              </div>
              <div className="home-line">{summaryLine(item)}</div>
            </div>
          </div>
        </button>
      ))}
    </>
  );
}
