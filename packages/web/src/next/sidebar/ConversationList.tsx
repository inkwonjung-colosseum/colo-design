import type { ProjectSummary, ThreadSummary } from "@colo-design/protocol";
import { useMemo } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { previewPathOf } from "../../lib/screen-link";
import { SYSTEM_THREAD_TITLES, visibleThreads } from "../../lib/thread-visibility";
import { threadScreens } from "../../lib/turn-screens";
import { L } from "../labels";
import { ChevronRightIcon, Spin } from "../ui/icons";

/**
 * 활성 프로젝트의 대화 목록 — 제목과 둘째 줄(그 대화가 만진 화면들). 도구가
 * 스스로 연 대화(연결 준비 · 리뷰 반영 · 문제 해결)는 맨 아래 접힌 `도구가 한
 * 일` 로 간다 — 판정은 옛 사이드바와 같은 `SYSTEM_THREAD_TITLES`(데몬의 제목).
 */
export function ConversationList({
  daemon,
  project,
  activeSessionId,
  threadView,
  titleFor,
  onOpen,
}: {
  daemon: Daemon;
  project: ProjectSummary | null;
  activeSessionId: string | null;
  /** 대화 보기가 앞에 서 있는가 — 홈에서는 어느 행도 켜지 않는다. */
  threadView: boolean;
  titleFor: (thread: ThreadSummary) => string;
  onOpen: (thread: ThreadSummary) => void;
}) {
  const threads = project
    ? visibleThreads(project.threads, daemon.hiddenThreads, project.slug)
    : [];
  const planner = threads.filter((thread) => !SYSTEM_THREAD_TITLES[thread.title]);
  const tool = threads.filter((thread) => SYSTEM_THREAD_TITLES[thread.title]);

  // 둘째 줄의 화면 — 이 창이 기록을 읽은 대화만 안다. 읽지 않은 대화는 비워 둔다
  // (모르는 것을 `아직 만든 화면이 없어요` 로 말하지 않는다).
  const previewUrl = daemon.repo?.previewUrl ?? null;
  const screensById = useMemo(() => {
    const toPath = (href: string) => previewPathOf(href, previewUrl);
    const out = new Map<string, string>();
    for (const [id, view] of Object.entries(daemon.sessions)) {
      if (view.blocks.length === 0) continue;
      // 제목 없는 맨 주소는 줄에 세우지 않는다 — 사용자 면에는 화면 이름만(U10).
      const titles = threadScreens(view.blocks, toPath).flatMap((screen) =>
        screen.title ? [screen.title] : [],
      );
      out.set(id, titles.length > 0 ? titles.join(" · ") : L.sidebar.noScreensYet);
    }
    return out;
  }, [daemon.sessions, previewUrl]);

  const row = (thread: ThreadSummary) => {
    const view = daemon.sessions[thread.id];
    const failed = view?.state === "error";
    const on = threadView && thread.id === activeSessionId;
    const sub =
      thread.state === "running"
        ? L.journey.making
        : thread.state === "awaiting"
          ? L.sidebar.waitingAnswer
          : failed
            ? L.sidebar.aiFailedRetry
            : (screensById.get(thread.id) ?? "");
    return (
      <button
        key={thread.id}
        type="button"
        className={`nx-conv${on ? " nx-conv--on" : ""}`}
        aria-current={on ? "true" : undefined}
        onClick={() => onOpen(thread)}
      >
        <span className="nx-conv-t">
          <span>{titleFor(thread)}</span>
          {thread.state === "running" ? (
            <Spin />
          ) : thread.state === "awaiting" ? (
            <i className="nx-dot nx-dot--amber" aria-hidden="true" />
          ) : failed ? (
            <i className="nx-dot nx-dot--red" aria-hidden="true" />
          ) : null}
        </span>
        {sub && <span className="nx-conv-s">{sub}</span>}
      </button>
    );
  };

  const toolOpen = tool.some((thread) => thread.id === activeSessionId);
  return (
    <div className="nx-conv-list">
      {planner.map(row)}
      {tool.length > 0 && (
        // 열린 대화가 그 안에 있을 때만 펼친 채로 선다 — 기본은 접힘.
        <details className="nx-toolg" open={toolOpen || undefined}>
          <summary>
            <ChevronRightIcon />
            {L.sidebar.toolWorkCount(tool.length)}
          </summary>
          {tool.map(row)}
        </details>
      )}
    </div>
  );
}
