import { useEffect, useState } from "react";
import { waitedFor } from "../../lib/format";
import type { RunningItem } from "../../lib/home-feed";

/** ProgressCard 여럿이 동시에 리렌더돼도 부담이 없도록 10초 간격만 깬다 —
 *  1초 tick 인 TurnClock 을 그대로 여러 장 쓰면 홈 하나가 초당 N번 리렌더된다. */
function useTick(intervalMs: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

/** "지금 진행 중" 카드 한 장 — 마지막 행동 한 줄 + 경과 시계. */
export function ProgressCard({
  item,
  repoReady,
  onOpen,
}: {
  item: RunningItem;
  repoReady: boolean;
  onOpen: () => void;
}) {
  useTick(10_000);
  // turnStartedAt 이 null 인데 running 인 레이스(§5)는 "방금 시작"으로 폴백한다.
  const elapsed = item.turnStartedAt ? waitedFor(Date.now() - item.turnStartedAt) : null;

  return (
    <button
      type="button"
      className="home-card"
      disabled={!repoReady}
      onClick={onOpen}
      aria-label={`${item.title} 대화 열기`}
    >
      <div className="home-row">
        <span className="dot dot--live" />
        <div className="home-body">
          <div className="home-top">
            <span className="home-name">{item.title}</span>
          </div>
          <div className="home-line">{item.line}</div>
          {!repoReady && <span className="tag tag--warn">레포 준비 중</span>}
        </div>
        <span className="home-run">만드는 중 · {elapsed ?? "방금 시작"}</span>
      </div>
    </button>
  );
}
