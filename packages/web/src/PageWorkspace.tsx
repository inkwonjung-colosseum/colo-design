import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { SessionSummary, ThreadSummary } from "@cds-design/protocol";
import type { Daemon } from "./daemon-client";
import { useSessions } from "./useSessions";
import { ChatColumn } from "./ChatColumn";
import { ScreenPanel } from "./ScreenPanel";
import { Palette } from "./Palette";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  PREVIEW_WIDTH_BOUNDS,
  type ChatSettings,
  type LayoutSettings,
  type Settings,
} from "./settings";
import { Splitter } from "./Splitter";

/** The chat column's floor, in px. The preview's drag may squeeze the chat;
 * it may never squeeze the conversation the planner is reading. */
const CHAT_MIN = 320;

/**
 * What an untouched workspace opens at — half the window, because the
 * preview is the thing a planner looks at. Below 1280 the preview takes a
 * smaller share, so the default lives here rather than in a media rule:
 * an inline grid template outranks one.
 */
function defaultPreviewWidth(): number {
  const narrow = window.matchMedia("(max-width: 1280px)").matches;
  return Math.round(window.innerWidth * (narrow ? 0.45 : 0.5));
}

/**
 * The preview's width, clamped to its own bounds and to what the body has
 * left for the chat. On a window too narrow for both maxima the clamp floor
 * wins and the boundary simply stops.
 */
function clampWidth(value: number, bodyWidth: number): number {
  const max = Math.min(PREVIEW_WIDTH_BOUNDS.max, bodyWidth - CHAT_MIN);
  return Math.round(Math.min(Math.max(value, PREVIEW_WIDTH_BOUNDS.min), Math.max(PREVIEW_WIDTH_BOUNDS.min, max)));
}

/**
 * What the sidebar tree may ask of the workspace (PLAN D59): the open, the
 * new, the delete. Shell holds the handle and hands the tree its callbacks;
 * the flows live here because only this hook knows which thread is open.
 */
export interface WorkspaceHandle {
  openThread: (slug: string, thread: ThreadSummary) => void;
  newThread: (slug: string) => void;
  /** 지우기, from a leaf's `···` (PLAN D76). */
  deleteThread: (slug: string, thread: ThreadSummary) => void;
}

/**
 * The workspace, all of it (PLAN D1). The 기획/디자인 split is gone — so are
 * the page tree, the 문서|화면 segment, and the screen rail: the preview is
 * the screens' only door, and its toolbar is where a planner picks one. The
 * conversations the screens live in are chosen in the sidebar's tree now;
 * this column is one transcript under one `.thread` head. The boundary the
 * preview shares with it is draggable (Splitter); the width lives in 설정's
 * store and survives a reload.
 */
export function PageWorkspace({
  ref,
  daemon,
  settings,
  onChatChange,
  onLayoutChange,
  onOpenSettings,
  onAddProject,
  onRenameSession,
  onActiveThreadChange,
}: {
  ref?: React.Ref<WorkspaceHandle>;
  daemon: Daemon;
  settings: Settings;
  /** 설정 owns how Claude answers; threads start on it. */
  onChatChange: (patch: Partial<ChatSettings>) => void;
  /** Same store, same shape: the dragged column width. */
  onLayoutChange: (patch: Partial<LayoutSettings>) => void;
  onOpenSettings: () => void;
  /** Shell owns the 추가 dialog; the palette's 명령 just opens it. */
  onAddProject: () => void;
  /** The planner renames threads; 설정's store keeps them by session id. */
  onRenameSession: (sessionId: string, title: string) => void;
  /** The tree's active mark — the hook's state, reported up. */
  onActiveThreadChange: (activeThreadId: string | null) => void;
}) {
  /**
   * One session list (PLAN D1): every thread is about screens, so there is
   * nothing to split. `ready` is the connected repo having a clone — the
   * daemon needs it before it can give Claude a cwd.
   */
  const sessions = useSessions(daemon, {
    ready: daemon.repo?.phase === "ready",
    chat: settings.chat,
    onChatChange,
  });
  /** The name a stored thread wears, for the chat head: the planner's
      rename, else the daemon's summary. */
  const titleFor = useCallback(
    (session: SessionSummary) => settings.sessionTitles[session.sessionId] ?? session.title,
    [settings.sessionTitles],
  );

  /** The same name for daemon thread rows, for the tree and the palette. */
  const titleForThread = useCallback(
    (thread: ThreadSummary) => settings.sessionTitles[thread.id] ?? thread.title,
    [settings.sessionTitles],
  );

  /**
   * The keyboard's frame jumps (⌘K 팔레트 · ⌘T 새 대화 · ⌘, 설정). One
   * subscription; the handlers read through a ref so the newest closures run
   * without resubscribing on every render. These are the app's own chords —
   * they carry a modifier, so typing in the composer never meets them.
   */
  const [palette, setPalette] = useState(false);
  const shortcuts = useRef({ palette: () => {}, newSession: () => {}, settings: () => {} });
  shortcuts.current = {
    palette: () => setPalette((open) => !open),
    newSession: () => void sessions.create(),
    settings: onOpenSettings,
  };

  /** The active thread, reported up for the tree's active mark. */
  useEffect(() => {
    onActiveThreadChange(sessions.activeId);
  }, [sessions.activeId, onActiveThreadChange]);

  /**
   * A jump across projects (PLAN D59 rule 1): the click landed while another
   * project was active. The switch runs first; when the registry moves, the
   * stashed ask — open a thread, start one — lands in its own project. One
   * click for the planner, two hops here.
   */
  const jump = useRef<{ slug: string; threadId?: string; fresh?: boolean } | null>(null);
  useEffect(() => {
    const pending = jump.current;
    if (!pending || daemon.activeSlug !== pending.slug) return;
    jump.current = null;
    if (pending.threadId) void openThreadById(pending.threadId);
    else if (pending.fresh) void sessions.create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemon.activeSlug]);

  /**
   * Open one of THIS project's conversations by id. The list is the fast
   * path (the old open, hydrate included); a live thread the list has not
   * caught up with is focused; anything else — a row the switch just cleared
   * the list of — resumes straight into a live session
   * (`session.create { resume }`).
   */
  const openThreadById = async (threadId: string) => {
    const listed = sessions.list.find((session) => session.sessionId === threadId);
    if (listed) {
      await sessions.open(listed);
      return;
    }
    const view = daemon.sessions[threadId];
    if (view?.live) {
      await sessions.open({
        sessionId: threadId,
        title: threadId,
        lastModified: Date.now(),
        live: true,
        state: view.state,
      });
      return;
    }
    await sessions.resume(threadId);
  };

  const jumpTo = (pending: { slug: string; threadId?: string; fresh?: boolean }) => {
    if (jump.current) return;
    jump.current = pending;
    void daemon.api.projectActivate(pending.slug).catch(() => {
      jump.current = null;
    });
  };

  // Rebuilt without a dep array on purpose: every render hands the tree the
  // newest closures, so a click never runs against a stale session list.
  useImperativeHandle(ref, () => ({
    openThread: (slug, thread) => {
      if (slug === daemon.activeSlug) void openThreadById(thread.id);
      else jumpTo({ slug, threadId: thread.id });
    },
    newThread: (slug) => {
      if (slug === daemon.activeSlug) void sessions.create();
      else jumpTo({ slug, fresh: true });
    },
    deleteThread: (slug, thread) => {
      // 지우기 is the active leaf's item alone (PLAN D76): the daemon
      // resolves a delete inside the active clone's transcript store.
      if (slug !== daemon.activeSlug) return;
      const listed = sessions.list.find((session) => session.sessionId === thread.id);
      void sessions.remove(
        listed ?? {
          sessionId: thread.id,
          title: thread.title,
          lastModified: Date.parse(thread.updatedAt) || 0,
          live: false,
          state: "closed",
        },
      );
    },
  }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        shortcuts.current.palette();
      } else if (event.key === "t" || event.key === "T") {
        event.preventDefault();
        shortcuts.current.newSession();
      } else if (event.key === ",") {
        event.preventDefault();
        shortcuts.current.settings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  /**
   * Comment pins from the preview land in the working thread, started on the
   * spot if there is none: a planner marking up a screen should not have to
   * open a conversation first. A thread the TOOL opens is named by the tool
   * (the M5 lesson) — ScreenPanel names it after the screen. `images` ride
   * the same wire as a composer attachment (D87): the crops the view took.
   */
  const forwardComments = useCallback(
    async (turn: string, name?: string, images?: Array<{ mediaType: string; data: string }>) => {
      if (!sessions.activeId) await sessions.create(name);
      await sessions.sendTurn(turn, images);
    },
    [sessions],
  );

  /**
   * The preview's width, the one resizable boundary left. It drives the grid
   * template inline, and the stored setting seeds it, so the workspace opens
   * the way it was last dragged; an untouched window keeps the old layout's
   * number. The store already clamps what it loads.
   */
  const [previewWidth, setPreviewWidth] = useState(
    () => settings.layout.previewWidth ?? defaultPreviewWidth(),
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  /** The drag in flight: where the pointer started, how wide. */
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null);

  // A shrunken window must not keep overflowing widths: the chat column is
  // what gives, down to its floor.
  useEffect(() => {
    const onResize = () => {
      const bodyWidth = bodyRef.current?.clientWidth;
      if (!bodyWidth) return;
      setPreviewWidth((prev) => clampWidth(prev, bodyWidth));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Pointer capture keeps the drag alive when the pointer crosses into the
  // preview iframe — the element that would otherwise swallow the moves.
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // The pointer can be gone before the browser registers the grab (a tap
    // released in the same tick). The drag still works inside the window —
    // only the across-the-iframe reach needs the capture.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* no live pointer with that id */
    }
    setDrag({ startX: event.clientX, startWidth: previewWidth });
  };

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const bodyWidth = bodyRef.current?.clientWidth;
    if (!bodyWidth) return;
    const delta = event.clientX - drag.startX;
    setPreviewWidth((prev) => clampWidth(drag.startWidth - delta, bodyWidth));
  };

  // The last render before the pointer came up carries the final width, so
  // persisting here needs nothing fancier than the current closure.
  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(null);
    onLayoutChange({ previewWidth });
  };

  /** The keyboard's version of the same drag, in a fixed 24px step. */
  const nudgeWidth = (delta: number) => {
    const bodyWidth = bodyRef.current?.clientWidth;
    if (!bodyWidth) return;
    const preview = clampWidth(previewWidth + delta, bodyWidth);
    setPreviewWidth(preview);
    onLayoutChange({ previewWidth: preview });
  };

  /** Double-click: the column goes back to its default and stops persisting. */
  const resetWidth = () => {
    setPreviewWidth(defaultPreviewWidth());
    onLayoutChange({ previewWidth: null });
  };

  return (
    <div
      ref={bodyRef}
      className={`planner__body${drag ? " planner__body--resizing" : ""}`}
      style={{ gridTemplateColumns: `minmax(0, 1fr) ${previewWidth}px` }}
    >
      <div className="planner__chatcol">
        <ChatColumn
          daemon={daemon}
          sessions={sessions}
          sendKey={settings.sendKey}
          placeholder="만들고 싶은 화면을 말해 주세요"
          disabled={false}
          titleFor={titleFor}
          onRenameSession={onRenameSession}
          onDeleteSession={(session) => void sessions.remove(session)}
        />
      </div>
      <Splitter
        side="right"
        width={previewWidth}
        bounds={PREVIEW_WIDTH_BOUNDS}
        label="미리보기 너비"
        active={drag !== null}
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onNudge={nudgeWidth}
        onReset={resetWidth}
      />

      <ScreenPanel
        daemon={daemon}
        onOpenSettings={onOpenSettings}
        onComments={forwardComments}
        turnState={sessions.active?.state ?? "idle"}
        sessionId={sessions.activeId}
        onPrecheck={(turn) => void sessions.sendTurn(turn)}
        onNewSession={() => void sessions.create()}
        showPip={settings.chat.showPip}
        followClaude={settings.chat.followClaude}
      />

      {palette && (
        <Palette
          titleForThread={titleForThread}
          activeSessionId={sessions.activeId}
          projects={daemon.projects}
          activeSlug={daemon.activeSlug}
          onOpenThread={(slug, thread) => {
            if (slug === daemon.activeSlug) void openThreadById(thread.id);
            else jumpTo({ slug, threadId: thread.id });
          }}
          onCreateSession={() => void sessions.create()}
          onActivateProject={(slug) => daemon.api.projectActivate(slug).then(() => undefined)}
          onAddProject={onAddProject}
          onOpenSettings={onOpenSettings}
          onClose={() => setPalette(false)}
        />
      )}

      {sessions.confirmRemove && (
        <ConfirmDialog
          title="대화 삭제"
          body={
            <>
              <strong>{titleFor(sessions.confirmRemove)}</strong> 대화를 삭제할까요?
            </>
          }
          hint="대화 기록이 영구히 사라집니다."
          confirmLabel="삭제"
          onConfirm={() => void sessions.acceptRemove()}
          onClose={sessions.cancelRemove}
        />
      )}
    </div>
  );
}

