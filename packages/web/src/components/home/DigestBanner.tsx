import { useMemo } from "react";
import { timeAgo } from "../../lib/format";
import type { HomeFeed } from "../../lib/home-feed";
import { ChevronRightIcon } from "../icons";
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

/** 요약 행 한 장 — EmptyHome 의 이어하기 카드와 같은 어휘(dot · 이름 · 줄 ·
 *  셰브론). 이름은 한 줄로 잘리고, 행 전체가 그 대화로 가는 버튼이다. */
function DigestRow({
  dot,
  title,
  line,
  onOpen,
}: {
  dot: string;
  title: string;
  line: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="home-resume__card"
      onClick={onOpen}
      aria-label={`${title} 대화 열기`}
    >
      <span className={`dot ${dot}`} />
      <span className="home-resume__body">
        <span className="home-resume__name">{title}</span>
        <span className="home-resume__line">{line}</span>
      </span>
      <ChevronRightIcon />
    </button>
  );
}

/**
 * 돌아온 순간의 배너 — 문단 안에 스레드 제목을 심던 요약은 제목이 한 문장이
 * 넘는 순간(첫 말이 통째로 제목이 되는 이 레포에서는 늘 그렇다) 줄이 갈라지고
 * 조사가 홀로 남었다. 이제 문장은 건수만 말하고, 이름은 한 줄로 잘린 조용한
 * 행이 부른다 — 누르면 그 대화. 목업 13의 "이름으로 말하기"는 문장이 아니라
 * 행이 이어받는다. 요약 행은 첫 화면의 재료일 뿐, 전부는 아래 폴드가 기록으로
 * 갖는다.
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

  const digestDone = done.slice(0, 3);
  const folded = done.length - digestDone.length;

  const summary: string[] = [];
  if (running.length > 0 && done.length > 0) {
    summary.push(
      `자리를 비운 사이 대화 ${done.length}개가 끝나고 ${running.length}개가 돌고 있어요.`,
    );
  } else if (running.length > 0) {
    summary.push(`자리를 비운 사이에도 대화 ${running.length}개가 돌고 있어요.`);
  } else if (done.length > 0) {
    summary.push(`자리를 비운 사이 대화 ${done.length}개가 끝났어요.`);
  }
  summary.push(
    asking.length > 0
      ? `지금 내 확인을 기다리는 일이 아래 ${asking.length}건 있어요.`
      : "기다리는 답은 없어요.",
  );
  if (otherPending > 0) {
    summary.push(`다른 프로젝트에도 확인할 게 ${otherPending}건 있어요.`);
  }

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
      {phrase && (
        <div className="home-back__eyebrow">
          <span className="dot dot--ask" />
          {phrase}
        </div>
      )}
      <p className="home-digest__summary">{summary.join(" ")}</p>
      {(running.length > 0 || digestDone.length > 0) && (
        <div className="home-digest__rows">
          {running.map((item) => (
            <DigestRow
              key={item.sessionId}
              dot="dot--live"
              title={item.title}
              line={item.line}
              onOpen={() => onOpenSession(item.sessionId)}
            />
          ))}
          {digestDone.map((item) => (
            <DigestRow
              key={item.sessionId}
              dot="dot--done"
              title={item.title}
              line={timeAgo(item.at)}
              onOpen={() => onOpenSession(item.sessionId)}
            />
          ))}
        </div>
      )}
      {folded > 0 && (
        <p className="home-digest__more">나머지 {folded}건은 아래 기록에 정리했어요</p>
      )}
    </div>
  );
}
