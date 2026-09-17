import type { ThreadSummary } from "@colo-design/protocol";
import { useMemo } from "react";
import { timeAgo } from "../../lib/format";
import { ChevronRightIcon, CircleCheckIcon, NewChatIcon } from "../icons";
import { StateBanner } from "../StateBanner";
import { returnedPhrase } from "./DigestBanner";

/** 이어하기 카드의 상태 표현 — 사이드바의 leaf 어휘와 같은 말을 쓴다. */
function resumeMeta(thread: ThreadSummary): { dot: string; label: string } {
  if (thread.state === "running") return { dot: "dot--live", label: "작업 중" };
  if (thread.state === "awaiting") return { dot: "dot--ask", label: "확인 대기" };
  return { dot: "dot--done", label: timeAgo(Date.parse(thread.updatedAt)) };
}

/**
 * 완전히 빈 상태(§1)의 홈 — 배너가 "쌓인 일이 없어요"로 축소되던 자리를 한
 * 덩어리의 영웅 블록으로 접는다. 다음 행동은 문장이 아니라 화면에서 유일한
 * 잉크 버튼(새 대화 시작)으로 명시되고, 이전 대화가 남아 있으면 버튼 아래에
 * 최근 스레드 카드를 놓아 빈 홈이 막다른 곳이 되지 않게 한다(목업 16).
 * 되돌아온 시각 eyebrow 와 연결 끊김 배너는 DigestBanner 의 것을 그대로 쓴다.
 */
export function EmptyHome({
  lastSeenAt,
  connectionLost,
  onNewThread,
  threads,
  onOpenThread,
}: {
  /** 이 기기가 마지막으로 홈을 본 시각(epoch ms) — 첫 방문이면 null. */
  lastSeenAt: number | null;
  connectionLost: boolean;
  onNewThread: () => void;
  /** 최근 대화, 새 것부터 — 이어하기 카드의 원천. 없으면 영웅 블록만 선다. */
  threads: ThreadSummary[];
  onOpenThread: (thread: ThreadSummary) => void;
}) {
  const phrase = useMemo(
    () => (lastSeenAt !== null ? returnedPhrase(Date.now() - lastSeenAt) : null),
    [lastSeenAt],
  );
  const recent = threads.slice(0, 3);

  return (
    <div className="home-hero">
      {connectionLost && (
        <StateBanner
          tone="warn"
          role="status"
          icon={<span className="spinner" />}
          className="home-back__banner"
          title="다시 연결하는 중…"
          sub="연결이 끊기면 대화와 저장이 잠시 멈춥니다"
        />
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
        {recent.length > 0
          ? "새 일이 생기면 맨 위에 쌓아 둘게요 — 이전 대화는 왼쪽 목록에 그대로 있어요."
          : "새 일이 생기면 맨 위에 쌓아 둘게요."}
      </div>
      <button type="button" className="primary home-hero__cta" onClick={onNewThread}>
        <NewChatIcon />새 대화 시작
        <kbd>⌘T</kbd>
      </button>

      {recent.length > 0 && (
        <div className="home-resume">
          <div className="home-resume__label">이어서 볼까요</div>
          {recent.map((thread) => {
            const meta = resumeMeta(thread);
            return (
              <button
                key={thread.id}
                type="button"
                className="home-resume__card"
                onClick={() => onOpenThread(thread)}
                aria-label={`${thread.title} 대화 열기`}
              >
                <span className={`dot ${meta.dot}`} />
                <span className="home-resume__body">
                  <span className="home-resume__name">{thread.title}</span>
                  {meta.label && <span className="home-resume__line">{meta.label}</span>}
                </span>
                <ChevronRightIcon />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
