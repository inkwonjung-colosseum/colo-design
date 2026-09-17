import type { ThreadSummary } from "@colo-design/protocol";
import { useEffect, useMemo, useRef } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { buildHomeFeed } from "../../lib/home-feed";
import { markSeenNow, readLastSeen } from "../../lib/last-seen";
import { DecisionCard } from "./DecisionCard";
import { DoneCard } from "./DoneCard";
import { EmptyHome } from "./EmptyHome";
import { OtherProjectsCard } from "./OtherProjectsCard";
import { ProgressCard } from "./ProgressCard";
import { ReturnBanner } from "./ReturnBanner";

/** 그룹 헤더 한 줄 — 카운트가 0이면 그룹째로 숨기므로(§1) 여기선 항상 1 이상. */
function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="home-glabel">
      {label} <span className="home-gcount">{count}</span>
      <span className="home-gline" />
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="home-work">
      <div className="home-col">
        <div className="home-back home-back--skeleton" aria-hidden="true" />
        <div className="home-card home-card--skeleton" aria-hidden="true" />
        <div className="home-card home-card--skeleton" aria-hidden="true" />
        <div className="home-card home-card--skeleton" aria-hidden="true" />
      </div>
    </div>
  );
}

/**
 * 앱의 문 — 켤 때마다, 또는 자리를 비웠다 돌아왔을 때 랜딩하는 화면
 * (`mockups/hero/home.html`). v1은 활성 프로젝트로 스코프를 좁힌다: 비활성
 * 프로젝트는 살아 있는 세션이 없어 웹소켓 브로드캐스트가 오지 않는다(§3).
 */
export function HomeInbox({
  daemon,
  onOpenThread,
  onNewThread,
}: {
  daemon: Daemon;
  /** 카드/사이드바가 공유하는 단 하나의 열기 경로로 그대로 넘긴다(§2). */
  onOpenThread: (thread: ThreadSummary) => void;
  /** 완전히 빈 상태의 유일한 행동 — PageWorkspace 의 startNewThread 단일 통로. */
  onNewThread: () => void;
}) {
  const activeProject =
    daemon.projects.find((project) => project.slug === daemon.activeSlug) ?? null;
  const repoReady = daemon.repo?.phase === "ready";

  // 마지막 방문은 마운트 시각의 스냅샷 하나로 고정한다 — 매 렌더 다시 읽으면
  // "3시간 만에"가 렌더될 때마다 줄어드는 게 아니라, markSeenNow 가 그 사이
  // 다시 불리는 일이 없으니 값 자체는 안정적이지만 굳이 매번 localStorage를
  // 다시 읽을 이유가 없다.
  const lastSeenAt = useRef<number | null>(null);
  if (lastSeenAt.current === null) lastSeenAt.current = readLastSeen();
  useEffect(() => {
    markSeenNow();
    // 마운트 시 한 번만 — 이 방문이 끝나기 전에 배너 기준이 앞으로 밀리면
    // "0분 만에 돌아오셨어요"가 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const feed = useMemo(
    () => buildHomeFeed(daemon.pending, daemon.sessions, daemon.projects, daemon.activeSlug),
    [daemon.pending, daemon.sessions, daemon.projects, daemon.activeSlug],
  );

  const openSession = (sessionId: string) => {
    const thread = activeProject?.threads?.find((entry) => entry.id === sessionId);
    if (!thread) return;
    onOpenThread(thread);
  };

  if (daemon.connection === "connecting" || daemon.connection === "idle" || !activeProject) {
    return <HomeSkeleton />;
  }

  const connectionLost = daemon.connection === "closed" || daemon.connection === "error";
  const empty = feed.asking.length === 0 && feed.running.length === 0 && feed.done.length === 0;
  // 세 그룹이 비어도 다른 프로젝트에 확인할 게 남아 있으면 배너 형태를 유지한다 —
  // 영웅 블록의 "쌓인 일이 없어요"는 정말 아무 데도 없을 때만 정직하다(§5).
  const fullyEmpty = empty && feed.otherProjects.length === 0;

  return (
    <div className="home-work">
      <div className={connectionLost ? "home-col home-col--stale" : "home-col"}>
        {fullyEmpty ? (
          <EmptyHome
            lastSeenAt={lastSeenAt.current}
            connectionLost={connectionLost}
            onNewThread={onNewThread}
            hasThreads={(activeProject.threads?.length ?? 0) > 0}
          />
        ) : (
          <ReturnBanner
            lastSeenAt={lastSeenAt.current}
            counts={{
              asking: feed.asking.length,
              running: feed.running.length,
              done: feed.done.length,
            }}
            connectionLost={connectionLost}
          />
        )}

        {feed.asking.length > 0 && (
          <>
            <GroupHeader label="나를 기다리는 일" count={feed.asking.length} />
            {feed.asking.map((item) => (
              <DecisionCard
                key={item.kind === "review" ? `review-${item.sessionId}` : item.requestId}
                item={item}
                repoReady={repoReady}
                commands={daemon.repo?.commands}
                onOpenThread={() => openSession(item.sessionId)}
                onQuickPick={(label) => {
                  if (item.kind !== "question" || !item.quote) return;
                  void daemon.api.respondQuestion(item.requestId, { [item.quote]: label }, {});
                  daemon.resolvePending(item.requestId);
                }}
                onRespondPermission={(decision, message) => {
                  if (item.kind !== "permission") return;
                  void daemon.api.respondPermission(item.requestId, decision, message);
                  daemon.resolvePending(item.requestId);
                }}
              />
            ))}
          </>
        )}

        {feed.running.length > 0 && (
          <>
            <GroupHeader label="지금 진행 중" count={feed.running.length} />
            {feed.running.map((item) => (
              <ProgressCard
                key={item.sessionId}
                item={item}
                repoReady={repoReady}
                onOpen={() => openSession(item.sessionId)}
              />
            ))}
          </>
        )}

        {feed.done.length > 0 && (
          <>
            <GroupHeader label="방금 있던 일" count={feed.done.length} />
            {feed.done.map((item) => (
              <DoneCard
                key={item.sessionId}
                item={item}
                repoReady={repoReady}
                onOpen={() => openSession(item.sessionId)}
              />
            ))}
          </>
        )}

        <OtherProjectsCard
          items={feed.otherProjects}
          onOpen={(slug) => void daemon.api.projectActivate(slug).catch(() => undefined)}
        />

        {!fullyEmpty && (
          <p className="home-empty">여기까지예요. 새 일이 생기면 맨 위에 쌓아 둘게요.</p>
        )}
      </div>
    </div>
  );
}
