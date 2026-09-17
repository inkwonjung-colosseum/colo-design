import { useMemo } from "react";

/** "N분/시간/일 만에 돌아오셨어요" — 방금 막 열었을 때(1분 미만)는 아무 근거도
 *  없는 문장이라 아예 생략한다(거짓말 금지 원칙, §0). EmptyHome 의 영웅 블록도
 *  같은 포매터를 쓴다 — 두 빈 화면이 "N시간 만에"를 다르게 계산하는 일이 없도록. */
export function returnedPhrase(elapsedMs: number): string | null {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60) return `${minutes}분 만에 돌아오셨어요`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 만에 돌아오셨어요`;
  const days = Math.floor(hours / 24);
  return `${days}일 만에 돌아오셨어요`;
}

/**
 * 돌아온 순간의 배너 — "그사이 이런 일이 있었어요" + 세 그룹의 카운트만
 * 요약한다(§2). 데몬 데이터가 아니라 `last-seen.ts`의 로컬 시각 하나만 쓴다.
 */
export function ReturnBanner({
  lastSeenAt,
  counts,
  connectionLost,
}: {
  /** 이 기기가 마지막으로 홈을 본 시각(epoch ms) — 첫 방문이면 null. */
  lastSeenAt: number | null;
  counts: { asking: number; running: number; done: number };
  connectionLost: boolean;
}) {
  const empty = counts.asking === 0 && counts.running === 0 && counts.done === 0;
  const phrase = useMemo(
    () => (lastSeenAt !== null ? returnedPhrase(Date.now() - lastSeenAt) : null),
    [lastSeenAt],
  );

  return (
    <div className="home-back">
      {connectionLost && (
        <div className="home-back__reconnect" role="status">
          다시 연결하는 중…
        </div>
      )}
      {phrase && (
        <div className="home-back__eyebrow">
          <span className="dot dot--ask" />
          {phrase}
        </div>
      )}
      <div className="home-back__title">
        {empty ? "쌓인 일이 없어요" : "그사이 이런 일이 있었어요"}
      </div>
      <div className="home-back__sub">
        {empty
          ? "새 대화를 시작해 보세요 — 화면을 만들 준비가 됐어요."
          : "결정이 필요한 것부터 위에 뒀어요. 카드를 누르면 그 대화로 바로 들어가요."}
      </div>
      {!empty && (
        <div className="home-recap">
          {counts.asking > 0 && <span>확인 필요 {counts.asking}건</span>}
          {counts.running > 0 && <span>지금 만드는 중 {counts.running}건</span>}
          {counts.done > 0 && <span>방금 있던 일 {counts.done}건</span>}
        </div>
      )}
    </div>
  );
}
