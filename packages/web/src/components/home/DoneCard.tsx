import { timeAgo } from "../../lib/format";
import type { DoneItem } from "../../lib/home-feed";

/** "방금 있던 일" 카드 한 장 — 조용한 기록, 뱃지도 푸시도 없다. */
export function DoneCard({
  item,
  repoReady,
  onOpen,
}: {
  item: DoneItem;
  repoReady: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="home-card home-card--quiet"
      disabled={!repoReady}
      onClick={onOpen}
      aria-label={`${item.title} 대화 열기`}
    >
      <div className="home-row">
        <span className="dot dot--done" />
        <div className="home-body">
          <div className="home-top">
            <span className="home-name">{item.title}</span>
            <span className="home-time">{timeAgo(item.at)}</span>
          </div>
          <div className="home-line">{item.line}</div>
          {!repoReady && <span className="tag tag--warn">레포 준비 중</span>}
        </div>
      </div>
    </button>
  );
}
