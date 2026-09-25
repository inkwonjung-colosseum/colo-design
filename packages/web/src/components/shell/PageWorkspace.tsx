import type { SessionSummary, ThreadSummary } from "@colo-design/protocol";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePins } from "../../hooks/usePins";
import { useSessions } from "../../hooks/useSessions";
import type { Daemon } from "../../lib/daemon-client";
import {
  type ChatSettings,
  type LayoutSettings,
  PREVIEW_WIDTH_BOUNDS,
  type Settings,
} from "../../lib/settings";
import { visibleThreads } from "../../lib/thread-visibility";
import { downloadTranscript, transcriptToMarkdown } from "../../lib/transcript-export";
import { ChatColumn } from "../chat/ChatColumn";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import type { SettingsCategory } from "../dialogs/SettingsDialog";
import { ShortcutsSheet } from "../dialogs/ShortcutsSheet";
import { HomeInbox } from "../home/HomeInbox";
import { ScreenPanel } from "../panels/ScreenPanel";
import { StateBanner } from "../StateBanner";
import { Palette } from "./Palette";
import { Splitter } from "./Splitter";
import { Tip } from "./Tip";

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
  // E′ — 미리보기가 이 도구의 무대다. 기본 나눔을 대화 쪽에서 한 끗씩 옮긴
  // 것이다 (0.45/0.5 → 0.5/0.55 → 0.55/0.6). clampWidth 가 CHAT_MIN 을
  // 지키므로 좁은 창에서는 어차피 대화 바닥이 이 값을 이긴다.
  const narrow = window.matchMedia("(max-width: 1280px)").matches;
  return Math.round(window.innerWidth * (narrow ? 0.55 : 0.6));
}

/** 미리보기의 절대 바닥 — 대화 바닥과 창이 다투면 미리보기가 먼저 양보한다. */
const PREVIEW_HARD_MIN = 240;

/**
 * The preview's width, clamped to its own bounds and to what the body has
 * left for the chat. 창이 두 바닥을 다 품지 못하면 미리보기가 양보한다 —
 * 대화 열이 0까지 짜이는 대신. (데스크톱은 창의 minWidth 가 이 갈림길에
 * 거의 닿지 않게 한다; 이 클램프는 브라우저 경로와 창 축소의 보험이다.)
 */
function clampWidth(value: number, bodyWidth: number): number {
  const max = Math.min(PREVIEW_WIDTH_BOUNDS.max, Math.max(PREVIEW_HARD_MIN, bodyWidth - CHAT_MIN));
  const min = Math.min(PREVIEW_WIDTH_BOUNDS.min, max);
  return Math.round(Math.min(Math.max(value, min), max));
}

/**
 * What the sidebar tree may ask of the workspace: the open, the
 * new, the delete. Shell holds the handle and hands the tree its callbacks;
 * the flows live here because only this hook knows which thread is open.
 */
export interface WorkspaceHandle {
  openThread: (slug: string, thread: ThreadSummary) => void;
  newThread: (slug: string) => void;
  /** 지우기, from a leaf's `···`. */
  deleteThread: (slug: string, thread: ThreadSummary) => void;
  /** 대화 모두 지우기, from a project row's `···` — every thread of that
      project at once, active or not. */
  clearThreads: (slug: string) => void;
  /** 대화 내보내기 — the transcript leaves as a markdown file. */
  exportThread: (slug: string, thread: ThreadSummary) => void;
  /** The tree's `이전 대화 더 보기` — the palette, scoped to that project. */
  browseThreads: (slug: string) => void;
  /** 레일의 "홈" 행 — 지금 보는 대화가 무엇이든 홈 인박스로. */
  goHome: () => void;
}

/**
 * The workspace, all of it. The 기획/디자인 split is gone — so are
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
  onRenameSession,
  onActiveThreadChange,
}: {
  ref?: React.Ref<WorkspaceHandle>;
  daemon: Daemon;
  settings: Settings;
  /** 설정 owns how the agent answers; threads start on it. */
  onChatChange: (patch: Partial<ChatSettings>) => void;
  /** Same store, same shape: the dragged column width. */
  onLayoutChange: (patch: Partial<LayoutSettings>) => void;
  onOpenSettings: (category?: SettingsCategory) => void;
  /** The planner renames threads; 설정's store keeps them by session id. */
  onRenameSession: (sessionId: string, title: string) => void;
  /** The tree's active mark — the hook's state, reported up. */
  onActiveThreadChange: (activeThreadId: string | null) => void;
}) {
  /**
   * One session list: every thread is about screens, so there is
   * nothing to split. `ready` is the connected repo having a clone — the
   * daemon needs it before it can give the agent a cwd.
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
   * The pin attachments of this project — the composer's tray,
   * the overlay's badges and the sent-turn record all read this one list.
   */
  const pins = usePins(daemon.activeSlug, daemon.api);

  /** The same name for daemon thread rows, for the tree and the palette. */
  const titleForThread = useCallback(
    (thread: ThreadSummary) => settings.sessionTitles[thread.id] ?? thread.title,
    [settings.sessionTitles],
  );

  /**
   * 홈 ↔ 대화: 앱을 열 때·프로젝트를 막 활성화했을 때는 늘 홈이 기본값이다
   * (P1 홈 인박스) — 특정 스레드를 연 순간에만(openThreadById ·
   * startNewThread) "thread"로 넘어간다.
   */
  const [view, setView] = useState<"home" | "thread">("home");
  /**
   * 새 대화 버튼·⌘T 의 단일 통로 — "thread" 로 넘어가되 세션은 만들지 않는다
   * (fresh). 첫 입력 전까지 컴포저의 프로바이더 칩이 살아 있어 연결되고 켠
   * 프로바이더 중에 고를 수 있고, 세션은 첫 문장이 나갈 때 submit 이 만든다.
   * 곧장 보내는 길(화면 넘김·기계 턴)은 세션 id 가 곧 필요하므로
   * `sessions.create` 를 직접 쓴다 — 그 자리엔 이미 문장이 있다.
   */
  const startNewThread = useCallback(() => {
    setView("thread");
    sessions.fresh();
  }, [sessions]);

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
   * 사이클 동작의 단일 통로 — 상단 바의 제출 버튼, 팔레트의 상태 확인이
   * 전부 이 요청으로 간다. 모달이던 시절의 setSaveOpen 대신 대화 열의 카드가
   * 응답한다: nonce 가 오르면 ChatColumn·ScreenPanel 이 각자의 몫을 집는다.
   * `save` 는 P2-1 에서 빠졌다 — 저장은 턴이 끝날 때마다 데몬이 스스로 한다.
   */
  const [cycleRequest, setCycleRequest] = useState<{
    kind: "submit" | "handoff" | "check" | "history";
    nonce: number;
  } | null>(null);
  const askCycle = (kind: "submit" | "handoff" | "check" | "history") => {
    setView("thread");
    setCycleRequest((prev) => ({ kind, nonce: (prev?.nonce ?? 0) + 1 }));
  };
  /** 개발자 코멘트의 처리 표식 — 대화(고치기·답하기)가 쓰고 상단 바의
      `· 개발자 코멘트 N` 배지가 읽는다. 한 창의 두 열이 같은 수를 본다. */
  const [reviewsTick, setReviewsTick] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  /**
   * 핀 모드: the preview toolbar's toggle, lifted HERE so
   * ⌘⇧P answers from anywhere — even while the preview page holds focus,
   * its key relay replays into this window's listeners. The panel below
   * only draws the toggle and passes the truth down.
   */
  const [commentsOn, setCommentsOn] = useState(false);
  /**
   * 제출이 도는 중 — 대화 열의 제출 핸들러가 시작과 끝을 알리고, 상단 바의
   * 제출 버튼(ScreenPanel)이 읽는다. 두 열이 같은 누름을 본다.
   */
  const [submitBusy, setSubmitBusy] = useState(false);
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
    newSession: () => void startNewThread(),
    settings: onOpenSettings,
    sheet: () => setSheetOpen((open) => !open),
  };

  /** The active thread, reported up for the tree's active mark. */
  useEffect(() => {
    onActiveThreadChange(sessions.activeId);
  }, [sessions.activeId, onActiveThreadChange]);

  // 활성 프로젝트가 바뀌면 늘 홈부터: 같은 커밋에서 뒤이어 실행되는 아래
  // jump 이펙트가 실제로 스레드를 열면(openThreadById 가 "thread"로 다시
  // 되돌린다) 그 결과가 이 setView 를 덮어쓴다 — 순서는 선언 순서다.
  useEffect(() => {
    setView("home");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemon.activeSlug]);

  /**
   * A jump across projects: the click landed while another
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
    if (!pending) return;
    if (daemon.activeSlug !== pending.slug) {
      // 등록부가 다른 슬러그에 정착했다 — 이 요청은 거둔다. 남겨 두면 나중에
      // 그 슬러그로 돌아왔을 때 낡은 점프가 갑자기 재생된다.
      jump.current = null;
      return;
    }
    jump.current = null;
    if (pending.threadId) void openThreadById(pending.threadId);
    else if (pending.fresh) void startNewThread();
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
    setView("thread");
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
    // 기다린 점프가 이미 있어도 갈아끼운다 — 새 요청이 낡은 것보다 사용자의
    // 최신 뜻이다. 조기 반환으로 버리면 두 번째 클릭이 소실된다.
    jump.current = pending;
    void daemon.api.projectActivate(pending.slug).catch(() => {
      jump.current = null;
    });
  };

  /**
   * The OS notification's click lands here as a session id, relayed
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
  /** 대화를 내보낸 자리의 소식 — 성공은 잠깐 알리고 실패는 사람이 거둔다.
      이 메뉴의 유일한 피드백이었다(베타 테스트 B13): 거절이 조용히 사라지면
      누른 손은 버튼이 죽었다고 읽는다. */
  const [exportNote, setExportNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!exportNote?.ok) return;
    const timer = window.setTimeout(() => setExportNote(null), 6000);
    return () => window.clearTimeout(timer);
  }, [exportNote]);
  /** The transcript is the planner's deliverable — one click takes it out of
      the machine and into a markdown file they can keep. The tree's row and
      the thread head's menu share this one hand. */
  const exportThreadById = (id: string, title: string) => {
    void daemon.api
      .history(id)
      .then((events) => {
        downloadTranscript(transcriptToMarkdown(events, title), title);
        setExportNote({
          ok: true,
          text: `${title}.md 파일로 내보냈습니다 — 다운로드 폴더에 있습니다.`,
        });
      })
      .catch((error: Error) => {
        setExportNote({ ok: false, text: error.message });
      });
  };

  useImperativeHandle(ref, () => ({
    openThread: (slug, thread) => {
      if (slug === daemon.activeSlug) void openThreadById(thread.id);
      else jumpTo({ slug, threadId: thread.id });
    },
    newThread: (slug) => {
      if (slug === daemon.activeSlug) void startNewThread();
      else jumpTo({ slug, fresh: true });
    },
    deleteThread: (slug, thread) => {
      // 지우기 is the active leaf's item alone: the daemon
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
    clearThreads: (slug) => {
      // 대화 모두 지우기는 slug 를 들고 데몬에 간다 — 비활성 프로젝트도
      // 지울 수 있는 게 단건 지우기와 다른 점이다.
      sessions.clearAll(slug);
    },
    exportThread: (slug, thread) => {
      if (slug !== daemon.activeSlug) return;
      exportThreadById(thread.id, titleForThread(thread));
    },
    browseThreads: (slug) => {
      setPaletteSlug(slug);
      setPalette(true);
    },
    goHome: () => setView("home"),
  }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      // 오버레이가 열려 있는 동안 전역 조합은 물러선다 — 대화상자는 z-70
      // 스크림 아래에 마운트되어 보이지 않는 채 포커스만 훔친다. 팔레트의
      // 자기 토글(⌘K)만 예외다 — 그 키는 닫는 길이기도 하니까.
      if (
        document.querySelector(".modal, .palette") !== null &&
        event.key !== "k" &&
        event.key !== "K"
      )
        return;
      // ⌘⇧P: 핀 모드 토글 — shift 가 붙은 조합은 여기서 갈린다.
      // 미리보기에 포커스가 있는 동안에도 키 릴레이가 shiftKey 를 살려
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
      } else if (event.key === "s" || event.key === "S") {
        // ⌘S 는 P2-1 에서 할 일을 잃었다(저장은 턴마다 도구가 한다). 그래도
        // 삼키는 이유는 하나 — 손에 밴 ⌘S 가 브라우저의 `페이지 저장` 대화
        // 상자를 열면, 저장이라는 개념을 지운 자리에 OS 가 그것을 되돌려 준다.
        event.preventDefault();
      } else if (event.key === ",") {
        event.preventDefault();
        shortcuts.current.settings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 한 번에 하나의 기계 턴 — create 가 끝나 activeId 가 앉기 전의 창에
  // 두 번째 부름이 겹치면 같은 요청이 두 대화에 실려 간다(화면 패널의
  // lookBusy 와 같은 규칙). 겹친 부름은 거절로 돌려 보낸다 — 부른 쪽의
  // 재시도 규칙(거절 표식을 새기지 않음)이 이미 그 뜻을 알고 있다.
  const forwardBusyRef = useRef(false);
  /**
   * A machine-authored turn — a preview error's fix turn, a review's 고치기,
   * 화면 보여 주기, a failing gate's brief — lands in the working thread,
   * started on the spot if there is none: the ask should not depend on the
   * planner having opened a conversation first. A thread the TOOL opens is
   * named by the tool — the ask carries the name.
   *
   * The boolean is what the caller shows: false means the daemon refused the
   * turn and it stays retryable. 핀은 이 길을 타지 않는다 — 컴포저가
   * 보내고 markSent 가 기록한다.
   */
  const forwardMachineTurn = useCallback(
    async (
      turn: string,
      name?: string,
      attachments?: Array<{ name: string; mediaType: string; data: string }>,
      pins?: Array<{ screen: string }>,
    ) => {
      if (forwardBusyRef.current) return false;
      forwardBusyRef.current = true;
      try {
        // The thread this turn lands in is the one create just named — the
        // closure's activeId still reads the pre-create null, and resolving
        // through it would open a second, nameless thread and leave the named
        // one empty on the list (a thread the TOOL opens is named by the
        // tool).
        const target = sessions.activeId ?? (await sessions.create(name));
        if (!target) return false;
        await sessions.sendTurn(turn, attachments, target, pins);
        return true;
      } catch {
        // sendTurn already put the reason in the error strip.
        return false;
      } finally {
        forwardBusyRef.current = false;
      }
    },
    [sessions],
  );

  /**
   * The pins: one list per project, owned HERE so the chat's
   * composer and the preview's badge projection read the same truth. A badge
   * click asks for its tray row's memo input; the nonce re-focuses on
   * repeated clicks.
   */
  const [focusPinId, setFocusPinId] = useState<{ id: string; nonce: number } | null>(null);
  const focusPin = useCallback((id: string) => {
    setFocusPinId((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // 고스트의 수명은 턴의 수명: done, failed, stopped — 그 순간
  // 회색 배지는 간다. 해결 상태는 저장하지 않는다: the record popover is
  // where the past reads. 판정은 종착 상태가 내린다 — 'running' 렌더를 봤는가에
  // 기대면(옛 코드) 연달아 도착한 상태 갱신이 한 렌더로 합쳐질 때 중간의
  // running 은 화면에 오지 않아 배지가 영원히 남는다(커밋 게이트 교훈: 시계는
  // 창이 아니라 데몬의 것이다). 데몬이 아는 두 사실로 답한다: 살아 있는 턴이
  // 없고 대기 중인 보내기도 없으면, 핀을 실은 턴은 끝난 것이다. 턴 중간에
  // 받아 대기열에 든 보내기는(ⓘ) 대기줄이 비어야 끝난 것이다 — 중지가 줄을
  // 지우면 배지도 함께 간다. 종착 상태가 오래 됐으면(무장한 지 750ms 넘음)
  // 그 자리에서 해산한다 — 상태가 다시 running 으로 튀는 짧은 창을 놓치면
  // 배지는 다음 정착을 기다리게 된다. 여유는 markSent 직후 아직 오지 않은
  // running 갱신을 기다리는 것뿐, 무장한 지 얼마 안 됐을 때만 쓴다.
  const turnState = sessions.active?.state ?? "idle";
  const turnLive =
    turnState === "starting" ||
    turnState === "running" ||
    turnState === "waiting_permission" ||
    turnState === "waiting_question";
  const settledEmpty = !turnLive && (sessions.active?.queue?.length ?? 0) === 0;
  /** 제목바의 이름 — 활성 프로젝트. 프레임의 헤더가 이 행으로 흡수됐다. */
  const projectName =
    daemon.projects.find((project) => project.slug === daemon.activeSlug)?.name ?? null;

  const ghostCount = pins.ghosts.length;
  // 핀을 보냈으면 찍기는 끝났다 — 모드를 스스로 끈다. 켜진 채로 남으면 다음
  // 클릭이 화면을 누르는 대신 핀을 또 찍어, 방금 고친 화면을 써 보려던 손이
  // 막힌다. 고스트가 늘어나는 순간이 보냄의 신호다(markSent).
  const sentGhosts = useRef(ghostCount);
  useEffect(() => {
    if (ghostCount > sentGhosts.current) setCommentsOn(false);
    sentGhosts.current = ghostCount;
  }, [ghostCount]);
  const ghostArmedAt = useRef<number | null>(null);
  if (ghostCount > 0 && ghostArmedAt.current === null) ghostArmedAt.current = Date.now();
  if (ghostCount === 0) ghostArmedAt.current = null;
  useEffect(() => {
    if (!settledEmpty) return;
    const armed = ghostArmedAt.current ?? Date.now();
    const wait = 750 - (Date.now() - armed);
    // 무장한 지 오래됐으면 그 자리에서 해산한다 — 상태가 다시 running 으로
    // 튀는 짧은 창에서 타이머가 취소되면 배지는 다음 정착을 기다린다.
    if (wait <= 0) {
      pins.dismissGhosts();
      return;
    }
    const timer = setTimeout(() => pins.dismissGhosts(), wait);
    return () => clearTimeout(timer);
    // pins 는 렌더마다 새 겉모습일 뿐 dismissGhosts 는 setState 의 포장이다 — state 만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledEmpty, ghostCount]);

  /**
   * The preview's width, the one resizable boundary left. The state is the
   * planner's PREFERENCE — what they dragged it to — and the rendered width
   * is that preference clamped to the body that exists right now. Keeping
   * the two apart is what lets a re-grown window hand the preview its width
   * back: a clamp that overwrote the preference could only ever shrink.
   */
  const [previewWidth, setPreviewWidth] = useState(
    () => settings.layout.previewWidth ?? defaultPreviewWidth(),
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  /** The drag in flight: where the pointer started, how wide. */
  const [drag, setDrag] = useState<{
    startX: number;
    startWidth: number;
  } | null>(null);

  // A shrunken window must not keep overflowing widths: the chat column is
  // what gives, down to its floor. The preference survives the squeeze, so
  // growing the window back restores the preview instead of stranding it.
  useLayoutEffect(() => {
    const onResize = () => setBodyWidth(bodyRef.current?.clientWidth ?? 0);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** The width actually painted — the preference, clamped to today's body. */
  const previewShown = clampWidth(previewWidth, bodyWidth || Math.max(0, window.innerWidth - 240));

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
    setDrag({ startX: event.clientX, startWidth: previewShown });
  };

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    // 버튼이 이미 떼졌는데 move 가 흘러온다 — 포인터 캡처가 실패(혹은 브라우저가
    // 조기에 놓은) 자리다. 끝으로 본다: 그렇지 않으면 drag 가 붙은 채 남아
    // 나중의 hover 만으로 미리보기 폭이 흔들린다.
    if (event.buttons === 0) {
      endResize(event);
      return;
    }
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
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);
  return (
    <div className="planner__work">
      {/* 프레임의 한 헤더 줄 — 프로젝트 이름이 왼쪽을 쓰고, ScreenPanel 이
          그린 사이클 바(상태 → 행동)가 이 슬롯으로 올라와 나머지를
          채운다. 바의 상태는 전부 패널의 것이라 끌어올리는 대신 자리만
          내준다. */}
      <header className="planner__header">
        {projectName && <span className="planner__project">{projectName}</span>}
        <div ref={setBarSlot} className="planner__barslot" />
        {daemon.connection !== "open" && (
          <Tip label="연결이 끊기면 대화와 제출이 잠시 멈춥니다" side="bottom">
            <span className="hint">연결하는 중…</span>
          </Tip>
        )}
      </header>
      {exportNote && (
        <StateBanner
          tone={exportNote.ok ? "accent" : "danger"}
          role={exportNote.ok ? "status" : "alert"}
          title={exportNote.ok ? "대화를 내보냈습니다" : "대화를 내보내지 못했습니다"}
          sub={exportNote.text}
          onClose={() => setExportNote(null)}
        />
      )}
      {/* home·thread 양쪽에서 planner__body(미리보기 열 포함)는 항상 마운트된
          채 둔다 — <webview> 게스트는 요소가 철거되는 순간 죽고, 죽으면
          warm(돌아오면 그 자리) 약속이 무너진다. home 에서는 대화 열 자리에
          홈 수신함이 서고 미리보기 열은 0 으로 접힌다(게스트는 살아 있는 채
          숨는다). */}
      <div
        ref={bodyRef}
        className={`planner__body${drag ? " planner__body--resizing" : ""}`}
        style={{
          gridTemplateColumns:
            view === "home" ? "minmax(0, 1fr) 0px" : `minmax(0, 1fr) ${previewShown}px`,
        }}
      >
        {view === "home" ? (
          <HomeInbox
            daemon={daemon}
            onOpenThread={(thread) => void openThreadById(thread.id)}
            onNewThread={() => void startNewThread()}
          />
        ) : (
          <>
            <div className="planner__chatcol">
              <ChatColumn
                daemon={daemon}
                sessions={sessions}
                sendKey={settings.sendKey}
                // 빈 대화의 placeholder 가
                // 가르친다 — 화면 만들기는 단계가 아니라 아무 대화에서나 하는 한
                // 턴이다. 문법 안내(@ 로 파일, / 로 명령)는 살리되 개발자 어휘
                // (@files 태그 · /commands)는 사용자의 말로 벗겼다.
                // E′ — 트레이에 핀이 서 있으면 입력창이 "고칠 곳"을 먼저 묻는다:
                // 핀은 문장과 한 턴으로 나가므로, 물음도 고침의 말이 먼저다.
                // 문자열 제약: 첫 턴은 `만들고 싶은 화면을` 접두, 이후는
                // `메시지를 보내 보세요` 포함 — 두 e2e가 실제로 읽는다.
                placeholder={
                  sessions.activeId
                    ? pins.list.length > 0
                      ? "고칠 곳을 말해 주세요 — 찍은 핀과 함께 보내져요"
                      : "메시지를 보내 보세요 — @로 파일을, /로 명령을 불러올 수 있어요"
                    : "만들고 싶은 화면을 말해 보세요 — 그림을 붙여도 돼요 (@로 파일, /로 명령)"
                }
                disabled={false}
                titleFor={titleFor}
                onRenameSession={onRenameSession}
                onDeleteSession={(session) => void sessions.remove(session)}
                showThinking={settings.chat.showThinking}
                showTools={settings.chat.showTools}
                midturn={settings.chat.midturn}
                // 설정에서 끈 프로바이더 — 새 대화의 칩에서도 빠진다.
                disabledProviders={settings.chat.disabledProviders ?? []}
                pins={pins}
                onExportThread={() => {
                  const id = sessions.activeId;
                  if (!id) return;
                  const summary = sessions.list.find((session) => session.sessionId === id);
                  exportThreadById(id, summary ? titleFor(summary) : "conversation");
                }}
                focusPinId={focusPinId}
                onChatChange={onChatChange}
                onOpenProviderSettings={() => onOpenSettings("providers")}
                onOpenHistory={() => askCycle("history")}
                onSubmitBusy={setSubmitBusy}
                cycleRequest={cycleRequest}
                onReviewsHandled={() => setReviewsTick((tick) => tick + 1)}
              />
            </div>
            <Splitter
              side="right"
              width={previewShown}
              bounds={PREVIEW_WIDTH_BOUNDS}
              label="미리보기 너비"
              active={drag !== null}
              onPointerDown={beginResize}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onNudge={nudgeWidth}
              onReset={resetWidth}
            />
          </>
        )}
        <ScreenPanel
          barSlot={barSlot}
          daemon={daemon}
          onOpenSettings={onOpenSettings}
          onMachineTurn={forwardMachineTurn}
          turnState={sessions.active?.state ?? "idle"}
          sessionId={sessions.activeId}
          commentsOn={commentsOn}
          onCommentsMode={setCommentsOn}
          pins={pins}
          onPin={(pin) => {
            pins.add(pin);
            focusPin(pin.id);
          }}
          onPinFocus={focusPin}
          onCycleAction={askCycle}
          cycleRequest={cycleRequest}
          reviewsTick={reviewsTick}
          submitBusy={submitBusy}
        />
      </div>

      {palette && (
        <Palette
          titleForThread={titleForThread}
          activeSessionId={sessions.activeId}
          projects={daemon.projects}
          hiddenThreads={daemon.hiddenThreads}
          activeSlug={daemon.activeSlug}
          projectSlug={paletteSlug}
          onOpenThread={(slug, thread) => {
            if (slug === daemon.activeSlug) void openThreadById(thread.id);
            else jumpTo({ slug, threadId: thread.id });
          }}
          onCreateSession={() => {
            // A scoped palette's 새 대화 belongs to the project it names —
            // the same jump the tree's own new-conversation row makes.
            if (paletteSlug && paletteSlug !== daemon.activeSlug) {
              jumpTo({ slug: paletteSlug, fresh: true });
            } else {
              void startNewThread();
            }
          }}
          onActivateProject={(slug) => daemon.api.projectActivate(slug).then(() => undefined)}
          onOpenSettings={onOpenSettings}
          onCheckState={() => askCycle("check")}
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
          hint="대화 기록이 영구히 사라집니다. 화면 작업과 작업 기록은 그대로 남습니다."
          confirmLabel="삭제"
          onConfirm={() => void sessions.acceptRemove()}
          onClose={sessions.cancelRemove}
        />
      )}

      {sessions.confirmClear && (
        <ConfirmDialog
          title="대화 모두 삭제"
          body={(() => {
            const project = daemon.projects.find((p) => p.slug === sessions.confirmClear);
            const count = visibleThreads(
              project?.threads,
              daemon.hiddenThreads,
              sessions.confirmClear ?? "",
            ).length;
            return (
              <>
                <strong>{project?.name ?? sessions.confirmClear}</strong> 프로젝트의 대화
                {count ? ` ${count}개를` : "를"} 모두 삭제할까요?
              </>
            );
          })()}
          hint="대화 기록이 영구히 사라집니다. 화면 작업과 작업 기록은 그대로 남습니다."
          confirmLabel="모두 삭제"
          onConfirm={() => void sessions.acceptClear()}
          onClose={sessions.cancelClear}
        />
      )}
    </div>
  );
}
