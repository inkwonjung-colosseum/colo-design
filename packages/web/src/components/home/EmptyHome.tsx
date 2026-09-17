import { useMemo } from "react";
import { CircleCheckIcon, NewChatIcon } from "../icons";
import { returnedPhrase } from "./ReturnBanner";

/**
 * 완전히 빈 상태(§1)의 홈 — 배너가 "쌓인 일이 없어요"로 축소되던 자리를 한
 * 덩어리의 영웅 블록으로 접는다. 이전에는 배너의 sub("새 대화를 시작해 보세요")
 * 와 아래 `home-empty` 문장이 같은 말을 두 번 했는데, 이제 다음 행동은 문장이
 * 아니라 화면에서 유일한 잉크 버튼(새 대화 시작)으로 명시된다. 되돌아온 시각
 * eyebrow 와 연결 끊김 배지는 ReturnBanner 의 것을 그대로 재사용한다.
 */
export function EmptyHome({
  lastSeenAt,
  connectionLost,
  onNewThread,
  hasThreads,
}: {
  /** 이 기기가 마지막으로 홈을 본 시각(epoch ms) — 첫 방문이면 null. */
  lastSeenAt: number | null;
  connectionLost: boolean;
  onNewThread: () => void;
  /** 사이드바에 이전 대화가 남아 있을 때만 — 잃어버렸다는 착각을 막는 안내. */
  hasThreads: boolean;
}) {
  const phrase = useMemo(
    () => (lastSeenAt !== null ? returnedPhrase(Date.now() - lastSeenAt) : null),
    [lastSeenAt],
  );

  return (
    <div className="home-hero">
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
      <span className="home-hero__mark" aria-hidden="true">
        <CircleCheckIcon size={20} />
      </span>
      <div className="home-back__title">쌓인 일이 없어요</div>
      <div className="home-back__sub">
        {hasThreads
          ? "새 일이 생기면 맨 위에 쌓아 둘게요 — 이전 대화는 왼쪽 목록에 그대로 있어요."
          : "새 일이 생기면 맨 위에 쌓아 둘게요."}
      </div>
      <button type="button" className="primary home-hero__cta" onClick={onNewThread}>
        <NewChatIcon />새 대화 시작
        <kbd>⌘T</kbd>
      </button>
    </div>
  );
}
