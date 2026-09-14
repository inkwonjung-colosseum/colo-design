import type { ColoDesignScreen, SessionSummary, ThreadSummary } from "@colo-design/protocol";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ChatColumn } from "./ChatColumn";
import { ConfirmDialog } from "./ConfirmDialog";
import type { Daemon } from "./daemon-client";
import { Palette } from "./Palette";
import type { PreviewTarget } from "./PreviewHost";
import { ScreenPanel } from "./ScreenPanel";
import { ShortcutsSheet } from "./ShortcutsSheet";
import { Splitter } from "./Splitter";
import {
  type ChatSettings,
  type LayoutSettings,
  PREVIEW_WIDTH_BOUNDS,
  type Settings,
} from "./settings";
import { downloadTranscript, transcriptToMarkdown } from "./transcript-export";
import { usePins } from "./usePins";
import { useSessions } from "./useSessions";

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
  return Math.round(
    Math.min(Math.max(value, PREVIEW_WIDTH_BOUNDS.min), Math.max(PREVIEW_WIDTH_BOUNDS.min, max)),
  );
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
  /** 대화 내보내기 (리뷰 E5) — the transcript leaves as a markdown file. */
  exportThread: (slug: string, thread: ThreadSummary) => void;
  /** The tree's `이전 대화 더 보기` — the palette, scoped to that project. */
  browseThreads: (slug: string) => void;
}

/**
 * The workspace, all of it (PLAN D1). The 기획/디자인 split is gone — so are
 * the page tree, the 문서|화면 segment, and the screen rail: the preview is
 * the screens' only door, and its address bar is where a planner names one. The
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

  /**
   * The pin attachments of this project (재설계 C1) — the composer's tray,
   * the overlay's badges and the sent-turn record all read this one list.
   */
  const pins = usePins(daemon.activeSlug, daemon.api);

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
  /** The project the palette was opened for (the tree's 더 보기 row); null —
      the palette answers to the whole frame. ⌘K always opens it unscoped. */
  const [paletteSlug, setPaletteSlug] = useState<string | null>(null);
  /**
   * The screens the connected repo declares (PLAN D7), owned HERE so one
   * declaration feeds three doors: the preview picker (ScreenPanel), the
   * empty conversation's starter chips (ChatColumn), and the palette's
   * 화면 rows. ScreenPanel reports the envelope; the others only read.
   */
  const [screens, setScreens] = useState<ColoDesignScreen[]>([]);
  /**
   * A palette screen pick: handed to the preview as an ask; cleared once the
   * panel has turned (the effect's null early-return makes that a no-op).
   */
  const [jumpRequest, setJumpRequest] = useState<PreviewTarget | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  /**
   * 핀 모드 (재설계 C10): the preview toolbar's toggle, lifted HERE so
   * ⌘⇧P answers from anywhere — even while the preview page holds focus,
   * its key relay replays into this window's listeners. The panel below
   * only draws the toggle and passes the truth down.
   */
  const [commentsOn, setCommentsOn] = useState(false);
  const shortcuts = useRef({
    palette: () => {},
    newSession: () => {},
    settings: () => {},
    sheet: () => {},
  });
  shortcuts.current = {
    palette: () => {
      setPaletteSlug(null);
      setPalette((open) => !open);
    },
    newSession: () => void sessions.create(),
    settings: onOpenSettings,
    sheet: () => setSheetOpen((open) => !open),
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
  const jump = useRef<{
    slug: string;
    threadId?: string;
    fresh?: boolean;
  } | null>(null);
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
      // 실사 결함: 이 요약의 lastModified 가 곧 행의 시각으로 새겨져, 방금
      // 연 대화가 "방금" 이 되는 시간이 뒤바꿨다. 목록이 아는 그 시각을 쓰고,
      // 모르면 0 — 행은 데몬의 다음 스캔이 바로잡는다.
      const known = daemon.projects
        .flatMap((project) => project.threads ?? [])
        .find((thread) => thread.id === threadId);
      const lastModified = known ? Date.parse(known.updatedAt) : 0;
      await sessions.open({
        sessionId: threadId,
        title: known?.title ?? threadId,
        lastModified,
        live: true,
        state: view.state,
        // 이 창이 이미 아는 진행 시계 — 여는 순간 0초로 되감기지 않게.
        turnStartedAt: view.turnStartedAt,
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

  /**
   * 리뷰 B7: the OS notification's click lands here as a session id, relayed
   * by the desktop main. Locate the owning project first — resuming in the
   * wrong project would fork the thread there — then walk the same paths the
   * tree's rows use. Browser path (no bridge) never subscribes.
   */
  const openSessionFromNotice = (sessionId: string) => {
    void daemon.api
      .locateSession(sessionId)
      .then((located) => {
        if (located.slug && located.slug !== daemon.activeSlug) {
          jumpTo({ slug: located.slug, threadId: sessionId });
        } else {
          void openThreadById(sessionId);
        }
      })
      .catch(() => undefined);
  };
  const noticeRef = useRef(openSessionFromNotice);
  noticeRef.current = openSessionFromNotice;
  useEffect(() => {
    const bridge = window.coloDesignDesktop;
    if (!bridge?.onOpenSession) return;
    return bridge.onOpenSession((sessionId) => noticeRef.current(sessionId));
  }, []);

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
          turnStartedAt: null,
        },
      );
    },
    exportThread: (slug, thread) => {
      // 리뷰 E5: the transcript is the planner's deliverable — one click takes
      // it out of the machine and into a markdown file they can keep.
      if (slug !== daemon.activeSlug) return;
      void daemon.api
        .history(thread.id)
        .then((events) =>
          downloadTranscript(
            transcriptToMarkdown(events, titleForThread(thread)),
            titleForThread(thread),
          ),
        )
        .catch(() => undefined);
    },
    browseThreads: (slug) => {
      setPaletteSlug(slug);
      setPalette(true);
    },
  }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      // ⌘⇧P (재설계 C10): 핀 모드 토글 — shift 가 붙은 조합은 여기서 갈린다.
      // 미리보기에 포커스가 있는 동안에도 D71 릴레이가 shiftKey 를 살려
      // 이 창으로 되말리므로, 워크스페이스의 이 한 곳이면 충분하다.
      if (event.shiftKey) {
        if (event.key === "p" || event.key === "P") {
          event.preventDefault();
          setCommentsOn((on) => !on);
        }
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        shortcuts.current.sheet();
      } else if (event.key === "k" || event.key === "K") {
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
   * A machine-authored turn — the error banner's 고치기, a review's 고치기,
   * 화면 보여 주기, a failing gate's brief — lands in the working thread,
   * started on the spot if there is none: the ask should not depend on the
   * planner having opened a conversation first. A thread the TOOL opens is
   * named by the tool (the M5 lesson) — the ask carries the name.
   *
   * The boolean is what the caller shows: false means the daemon refused the
   * turn (D35) and it stays retryable. 핀은 이 길을 타지 않는다 — 컴포저가
   * 보내고 markSent 가 기록한다 (재설계 C2).
   */
  const forwardMachineTurn = useCallback(
    async (turn: string, name?: string, images?: Array<{ mediaType: string; data: string }>) => {
      try {
        // The thread this turn lands in is the one create just named — the
        // closure's activeId still reads the pre-create null, and resolving
        // through it would open a second, nameless thread and leave the named
        // one empty on the list (M5: a thread the TOOL opens is named by the
        // tool).
        const target = sessions.activeId ?? (await sessions.create(name));
        if (!target) return false;
        await sessions.sendTurn(turn, images, target);
        return true;
      } catch {
        // sendTurn already put the reason in the error strip.
        return false;
      }
    },
    [sessions],
  );

  /**
   * The pins (재설계 C1): one list per project, owned HERE so the chat's
   * composer and the preview's badge projection read the same truth. A badge
   * click asks for its tray row's memo input; the nonce re-focuses on
   * repeated clicks.
   */
  const [focusPinId, setFocusPinId] = useState<{ id: string; nonce: number } | null>(null);
  const focusPin = useCallback((id: string) => {
    setFocusPinId((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // 고스트의 수명은 턴의 수명 (재설계 C10): the active thread leaving
  // running — done, failed, stopped — is the moment the grey badges go.
  // 해결 상태는 저장하지 않는다: the record popover is where the past reads.
  const turnState = sessions.active?.state ?? "idle";
  const turnWasRunning = useRef(false);
  useEffect(() => {
    if (turnState === "running") {
      turnWasRunning.current = true;
    } else if (turnWasRunning.current) {
      turnWasRunning.current = false;
      pins.dismissGhosts();
    }
    // pins 는 렌더마다 새 겉모습일 뿐 dismissGhosts 는 setState 의 포장이다 — state 만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnState]);

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
  const [drag, setDrag] = useState<{
    startX: number;
    startWidth: number;
  } | null>(null);

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
    setPreviewWidth(clampWidth(drag.startWidth - delta, bodyWidth));
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
          midTurnSend={settings.midTurnSend}
          // D83 (2026-09-14 커미티 F-A2′ 로 갱신): 빈 대화의 placeholder 가
          // 가르친다 — 화면 만들기는 단계가 아니라 아무 대화에서나 하는 한
          // 턴이다. 문법 안내(@ 로 파일, / 로 명령)는 살리되 개발자 어휘
          // (@files 태그 · /commands)는 기획자의 말로 벗겼다.
          placeholder={
            sessions.activeId
              ? "메시지를 보내 보세요 — @로 파일을, /로 명령을 불러올 수 있어요"
              : "기획서를 첨부하고 만들고 싶은 화면을 말해 보세요 (@로 파일, /로 명령)"
          }
          disabled={false}
          titleFor={titleFor}
          onRenameSession={onRenameSession}
          onDeleteSession={(session) => void sessions.remove(session)}
          screens={screens}
          showThinking={settings.chat.showThinking}
          showTools={settings.chat.showTools}
          pins={pins}
          focusPinId={focusPinId}
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
        onMachineTurn={forwardMachineTurn}
        turnState={sessions.active?.state ?? "idle"}
        sessionId={sessions.activeId}
        showPip={settings.chat.showPip}
        followClaude={settings.chat.followClaude}
        screens={screens}
        onScreens={setScreens}
        jumpRequest={jumpRequest}
        commentsOn={commentsOn}
        onCommentsMode={setCommentsOn}
        pins={pins}
        onPin={(pin) => {
          pins.add(pin);
          focusPin(pin.id);
        }}
        onPinFocus={focusPin}
      />

      {palette && (
        <Palette
          titleForThread={titleForThread}
          activeSessionId={sessions.activeId}
          projects={daemon.projects}
          activeSlug={daemon.activeSlug}
          projectSlug={paletteSlug}
          screens={screens}
          onOpenScreen={(screen) =>
            setJumpRequest({
              kind: "screen",
              route: screen.route,
              state: screen.states[0] ?? null,
            })
          }
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

      <ShortcutsSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />

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
