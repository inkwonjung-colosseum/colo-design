import type { ProjectSummary, ThreadSummary } from "@colo-design/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { Tip } from "../../components/Tip";
import type { Sessions } from "../../hooks/useSessions";
import type { Daemon } from "../../lib/daemon-client";
import { composing } from "../../lib/ime";
import { previewPathOf } from "../../lib/screen-link";
import { SYSTEM_THREAD_TITLES, visibleThreads } from "../../lib/thread-visibility";
import { downloadTranscript, transcriptToMarkdown } from "../../lib/transcript-export";
import { threadScreens } from "../../lib/turn-screens";
import { MoreIcon } from "../chat/icons";
import { L } from "../labels";
import { exportFileName } from "../lib/export-name";
import { ChevronRightIcon, Spin } from "../ui/icons";
import { Popover } from "../ui/Popover";

/**
 * 활성 프로젝트의 대화 목록 — 제목과 둘째 줄(그 대화가 만진 화면들). 도구가
 * 스스로 연 대화(연결 준비 · 리뷰 반영 · 문제 해결)는 맨 아래 접힌 `도구가 한
 * 일` 로 간다 — 판정은 옛 사이드바와 같은 `SYSTEM_THREAD_TITLES`(데몬의 제목).
 * 줄의 `···` 메뉴는 이름 바꾸기 · 내보내기 · 지우기를 단다(도구가 한 일의 줄은
 * 이름 바꾸기가 없다 — 제목이 도구의 것이다).
 */
export function ConversationList({
  daemon,
  project,
  sessions,
  activeSessionId,
  threadView,
  titleFor,
  onOpen,
  onRenameSession,
  onToast,
}: {
  daemon: Daemon;
  project: ProjectSummary | null;
  /** `useSessions` 의 결과 — 지운 대화가 열려 있으면 새 대화의 빈 자리로 돌린다. */
  sessions: Sessions;
  activeSessionId: string | null;
  /** 대화 보기가 앞에 서 있는가 — 홈에서는 어느 행도 켜지 않는다. */
  threadView: boolean;
  titleFor: (thread: ThreadSummary) => string;
  onOpen: (thread: ThreadSummary) => void;
  /** 이름 바꾸기 — 셸의 `onRenameSession`(설정의 대화 제목에 남는다). */
  onRenameSession: (sessionId: string, title: string) => void;
  onToast: (text: string) => void;
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

  // 줄의 `···` 메뉴와 그 안의 지우기 확인, 이름 바꾸기 입력의 상태.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  // Popover 가 누름 요소를 바깥으로 치지 않게 하는 줄의 `···` 단추들.
  const menuButtons = useRef(new Map<string, HTMLButtonElement>());
  const closeMenu = () => {
    setMenuFor(null);
    setConfirmFor(null);
  };

  // 이름 바꾸기 입력 — 시작할 때 안내해 고른다(autoFocus 는 쓰지 않는다).
  const renameInput = useRef<HTMLInputElement>(null);
  const renamingId = renaming?.id ?? null;
  useEffect(() => {
    if (renamingId !== null) renameInput.current?.select();
  }, [renamingId]);

  /** 이름 바꾸기의 저장 — 흰칸만 다듬어 남기고, 같은 제목은 다시 쓰지 않는다. */
  const commitRename = () => {
    const target = renaming;
    if (!target) return;
    setRenaming(null);
    const name = target.draft.trim();
    if (!name) return;
    const thread = threads.find((entry) => entry.id === target.id);
    if (thread && titleFor(thread) === name) return;
    onRenameSession(target.id, name);
  };

  /**
   * 내보내기 — 대화를 markdown 파일 하나로. 아직 읽지 않은 대화는 여는 길과 같은
   * 읽기로 채우니(ensureSession · hydrate) 둘째 줄의 화면도 함께 생긴다.
   */
  const exportThread = (thread: ThreadSummary) => {
    const title = titleFor(thread);
    void daemon.api
      .history(thread.id)
      .then((events) => {
        if (!daemon.sessions[thread.id]) {
          daemon.ensureSession(thread.id);
          daemon.hydrate(thread.id, events);
        }
        const base = exportFileName(title, new Date());
        downloadTranscript(transcriptToMarkdown(events, title), base);
        onToast(L.convMenu.exportDone(`${base}.md`));
      })
      .catch(() => onToast(L.convMenu.exportFailed));
  };

  /**
   * 지우기 — 확인은 메뉴 안의 한 줄. 승인과 같은 커밋에서 행을 먼저 거둔다(낙관
   * 숨김, thread-visibility), 데몬의 목록이 따라오면 숨김을 거둔다. 실패하면
   * 행을 되돌린다.
   */
  const removeThread = (thread: ThreadSummary) => {
    const slug = project?.slug;
    if (!slug) return;
    closeMenu();
    daemon.hideThread(slug, thread.id);
    // 지운 대화가 열려 있으면 새 대화의 빈 자리로 — 보던 화면은 그대로다.
    if (activeSessionId === thread.id) sessions.fresh();
    void daemon.api.deleteSession(thread.id).catch(() => {
      daemon.unhideThread(slug, thread.id);
      onToast(L.convMenu.removeFailed);
    });
  };

  const row = (thread: ThreadSummary) => {
    const view = daemon.sessions[thread.id];
    const failed = view?.state === "error";
    const on = threadView && thread.id === activeSessionId;
    const system = Boolean(SYSTEM_THREAD_TITLES[thread.title]);
    const menuOpen = menuFor === thread.id;
    const sub =
      thread.state === "running"
        ? L.journey.making
        : thread.state === "awaiting"
          ? L.sidebar.waitingAnswer
          : failed
            ? L.sidebar.aiFailedRetry
            : (screensById.get(thread.id) ?? "");

    if (renaming?.id === thread.id) {
      return (
        <div key={thread.id} className="nx-conv-row">
          <input
            ref={renameInput}
            className="nx-conv-rename"
            value={renaming.draft}
            aria-label={L.convMenu.renameLabel}
            onChange={(event) => setRenaming({ id: thread.id, draft: event.target.value })}
            onBlur={commitRename}
            onKeyDown={(event) => {
              // 한글이 조합 중이면 Enter 를 저장으로 읽지 않는다.
              if (composing(event)) return;
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") setRenaming(null);
            }}
          />
        </div>
      );
    }

    return (
      <div
        key={thread.id}
        className={`nx-conv-row${on ? " nx-conv-row--on" : ""}${menuOpen ? " nx-conv-row--menu" : ""}`}
      >
        <button
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
        <Tip
          label={menuOpen ? undefined : L.convMenu.label}
          side="bottom"
          align="end"
          className="nx-conv-tip"
        >
          <button
            ref={(element) => {
              if (element) menuButtons.current.set(thread.id, element);
              else menuButtons.current.delete(thread.id);
            }}
            type="button"
            className="nx-conv-menu"
            aria-label={L.convMenu.label}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => {
              setConfirmFor(null);
              setMenuFor(menuOpen ? null : thread.id);
            }}
          >
            <MoreIcon />
          </button>
        </Tip>
        {menuOpen && (
          <Popover
            anchor={{ current: menuButtons.current.get(thread.id) ?? null }}
            onClose={closeMenu}
            align="end"
            className="nx-conv-pop"
          >
            {confirmFor === thread.id ? (
              <div className="nx-conv-confirm">
                <p>{L.convMenu.removeConfirm}</p>
                <div className="nx-conv-confirm-row">
                  <button
                    type="button"
                    className="nx-btn nx-btn--sm nx-btn--ghost"
                    onClick={() => setConfirmFor(null)}
                  >
                    {L.convMenu.removeCancel}
                  </button>
                  <button
                    type="button"
                    className="nx-btn nx-btn--sm nx-btn--pri"
                    onClick={() => removeThread(thread)}
                  >
                    {L.convMenu.remove}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {!system && (
                  <button
                    type="button"
                    className="nx-mi"
                    onClick={() => {
                      closeMenu();
                      setRenaming({ id: thread.id, draft: titleFor(thread) });
                    }}
                  >
                    <b>{L.convMenu.rename}</b>
                  </button>
                )}
                <button
                  type="button"
                  className="nx-mi"
                  onClick={() => {
                    closeMenu();
                    exportThread(thread);
                  }}
                >
                  <b>{L.convMenu.export}</b>
                </button>
                <div className="nx-msep" />
                <button
                  type="button"
                  className="nx-mi nx-mi--dng"
                  onClick={() => setConfirmFor(thread.id)}
                >
                  <b>{L.convMenu.remove}</b>
                </button>
              </>
            )}
          </Popover>
        )}
      </div>
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
