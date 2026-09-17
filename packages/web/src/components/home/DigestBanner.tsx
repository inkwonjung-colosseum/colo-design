import { useMemo } from "react";
import type { HomeFeed } from "../../lib/home-feed";
import { subjectParticle, withParticle } from "../../lib/labels";
import { StateBanner } from "../StateBanner";

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

/** 요약 문장 안의 스레드 이름 — 누르면 그 대화로 바로 들어가는 링크 버튼. */
function DigestLink({
  sessionId,
  title,
  onOpenSession,
}: {
  sessionId: string;
  title: string;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <button type="button" className="home-digest__link" onClick={() => onOpenSession(sessionId)}>
      {title}
    </button>
  );
}

/** 이름 목록을 "A, B와 C" 로 잇는다 — 마지막 둘 사이만 와/과. */
function joinNames(
  items: { sessionId: string; title: string }[],
  onOpenSession: (sessionId: string) => void,
) {
  return items.map((item, i) => {
    const isLast = i === items.length - 1;
    const prevTitle = items[i - 1]?.title ?? "";
    return (
      <span key={item.sessionId}>
        {i > 0 && (isLast ? `${withParticle(prevTitle)} ` : ", ")}
        <DigestLink sessionId={item.sessionId} title={item.title} onOpenSession={onOpenSession} />
      </span>
    );
  });
}

/**
 * 돌아온 순간의 배너 — 카운트를 나열하던 자리를, 무슨 대화가 끝났고 무엇이
 * 아직 도는지 이름으로 말하는 한 문단 요약으로 바꾼다(목업 13). 답을 기다리는
 * 건 문장이 아니라 아래 카드가 맡으므로 문장은 진행·완료·다른 프로젝트만
 * 요약하고, 기다리는 건수는 마지막 절에서 건수로만 짚는다.
 */
export function DigestBanner({
  lastSeenAt,
  feed,
  connectionLost,
  onOpenSession,
}: {
  /** 이 기기가 마지막으로 홈을 본 시각(epoch ms) — 첫 방문이면 null. */
  lastSeenAt: number | null;
  feed: HomeFeed;
  connectionLost: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const phrase = useMemo(
    () => (lastSeenAt !== null ? returnedPhrase(Date.now() - lastSeenAt) : null),
    [lastSeenAt],
  );

  const { asking, running, done, otherProjects } = feed;
  const otherPending = otherProjects.reduce((sum, p) => sum + p.pendingCount, 0);

  return (
    <div className="home-digest">
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
      <p className="home-digest__summary">
        {phrase && <span className="home-digest__when">{phrase} </span>}
        {running.length > 0 && (
          <>
            자리를 비운 사이 {joinNames(running, onOpenSession)}
            {subjectParticle(running[running.length - 1]?.title ?? "")} 계속 돌고 있
            {done.length > 0 ? "고, " : "어요. "}
          </>
        )}
        {done.length > 0 && (
          <>
            {running.length === 0 && "자리를 비운 사이 "}
            {joinNames(done, onOpenSession)}
            {running.length > 0
              ? "도 끝났어요. "
              : `${subjectParticle(done[done.length - 1]?.title ?? "")} 끝났어요. `}
          </>
        )}
        {asking.length > 0
          ? `지금 답을 기다리는 건 아래 ${asking.length}건이에요.`
          : "기다리는 답은 없어요."}
        {otherPending > 0 && ` 다른 프로젝트에도 확인할 게 ${otherPending}건 있어요.`}
      </p>
    </div>
  );
}
