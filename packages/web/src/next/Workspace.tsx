import type { ThreadSummary } from "@colo-design/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Palette } from "../components/shell/Palette";
import { Splitter } from "../components/shell/Splitter";
import { usePins } from "../hooks/usePins";
import { useSessions } from "../hooks/useSessions";
import { ChatColumn } from "./chat/ChatColumn";
import { HomeView } from "./home/HomeView";
import { L } from "./labels";
import { deriveJourney } from "./lib/journey";
import { useNarrow, useShellNav } from "./lib/use-shell-nav";
import type { NextShellProps } from "./NextShell";
import { PreviewColumn } from "./preview/PreviewColumn";
import { Sidebar } from "./sidebar/Sidebar";
import type { SlotProps } from "./slots";
import { StatusLine } from "./status/StatusLine";
import { MenuIcon, PanelIcon } from "./ui/icons";

/** 대화 칸의 폭(U1) — 360~420px, 처음은 목업의 400. */
const CHAT_BOUNDS = { min: 360, max: 420 } as const;
const CHAT_DEFAULT = 400;

/** 턴이 살아 있는 상태 — 진행 시계와 `만드는 중` 이 읽는다. */
const LIVE = new Set(["starting", "running", "waiting_permission", "waiting_question"]);

/**
 * 프로젝트가 하나 이상 있는 기계의 작업 틀(PLAN-UI U1) — Claude Desktop 의
 * 배치: 사이드바 · 상태 줄(대화와 미리보기 위에 걸친다) · 대화 · 미리보기.
 * 900px 아래(U16)에서는 사이드바가 `≡` 뒤의 서랍, 대화와 미리보기가 두 탭이다.
 *
 * 훅(`useSessions` · `usePins`)은 여기서 한 번만 불리고 칸들이 같은 결과를
 * 나눠 쓴다. 대화 · 미리보기 칸은 홈에서도 마운트된 채 숨는다 — 미리보기의
 * 게스트가 죽지 않게(PreviewColumn 의 계약).
 */
export function Workspace({
  daemon,
  settings,
  onChatChange,
  onLayoutChange,
  onOpenSettings,
  onRenameSession,
}: NextShellProps) {
  const sessions = useSessions(daemon, {
    ready: daemon.repo?.phase === "ready",
    chat: settings.chat,
    onChatChange,
  });
  const pins = usePins(daemon.activeSlug, daemon.api);
  const narrow = useNarrow();
  const { state, nav, toast, setCollapsed, setDrawer } = useShellNav({
    daemon,
    sessions,
    collapsed: settings.layout.sidebarCollapsed,
    onLayoutChange,
    onOpenSettings,
  });
  const project = daemon.projects.find((entry) => entry.slug === daemon.activeSlug) ?? null;

  const titleForThread = useCallback(
    (thread: ThreadSummary) => settings.sessionTitles[thread.id] ?? thread.title,
    [settings.sessionTitles],
  );
  const activeId = sessions.activeId;
  const title = (() => {
    if (!activeId) return L.sidebar.newConv;
    const renamed = settings.sessionTitles[activeId];
    if (renamed) return renamed;
    const listed = sessions.list.find((session) => session.sessionId === activeId);
    if (listed) return listed.title;
    return project?.threads?.find((thread) => thread.id === activeId)?.title ?? L.sidebar.newConv;
  })();

  // 이 프로젝트에서 AI 가 도는가 — 열린 대화의 상태가 먼저, 다른 대화는 등록부가 안다.
  const activeLive = LIVE.has(sessions.active?.state ?? "idle");
  const awaiting = sessions.awaitingTurn?.sessionId === activeId ? sessions.awaitingTurn : null;
  const running = activeLive || awaiting !== null || project?.working === true;
  const turnStartedAt = activeLive
    ? (sessions.active?.turnStartedAt ?? null)
    : (awaiting?.since ?? null);
  const attention = daemon.repo?.attention ?? daemon.status?.attention ?? null;
  const journey = deriveJourney(
    {
      repo: daemon.repo,
      diffStatus: daemon.diffStatus,
      running,
      reconnect: attention?.kind === "reconnect",
    },
    L,
  );

  // 팔레트와 단축키(⌘K · ⌘T · ⌘,) — 조합키가 붙어 입력창의 타이핑과 만나지 않는다.
  const [palette, setPalette] = useState(false);
  const keys = useRef({ palette: () => {}, fresh: () => {}, settings: () => {} });
  keys.current = {
    palette: () => setPalette((open) => !open),
    fresh: () => nav.newThread(),
    settings: () => onOpenSettings(),
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      // 대화상자가 떠 있으면 물러선다 — 팔레트 자기 토글(⌘K)만 예외.
      const modal = document.querySelector(".modal, .palette") !== null;
      const key = event.key.toLowerCase();
      if (modal && key !== "k") return;
      if (key === "k") {
        event.preventDefault();
        keys.current.palette();
      } else if (key === "t") {
        event.preventDefault();
        keys.current.fresh();
      } else if (key === ",") {
        event.preventDefault();
        keys.current.settings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 대화 칸의 폭 — 넓은 창의 한 경계. 설정에 남기지 않는다(폭이 60px 뿐이다).
  const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT);
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null);
  const clamp = (value: number) =>
    Math.round(Math.min(CHAT_BOUNDS.max, Math.max(CHAT_BOUNDS.min, value)));

  /** 지금 화면의 제목 — 미리보기 칸이 알린다(단계 3). 좁은 창의 탭이 읽는다. */
  const [screenName, setScreenName] = useState<string | null>(null);

  const slot: SlotProps = {
    daemon,
    settings,
    sessions,
    pins,
    project,
    activeSessionId: activeId,
    nav,
    narrow,
    onChatChange,
    onRenameSession,
  };

  const sidebarHidden = narrow ? !state.drawer : state.collapsed;
  const openSidebar = () => (narrow ? setDrawer(true) : setCollapsed(false));
  const classes = [
    "nx",
    state.collapsed && !narrow ? "nx--collapsed" : "",
    narrow ? "nx--narrow" : "",
    narrow && state.drawer ? "nx--drawer" : "",
    drag ? "nx--resizing" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const home = state.view === "home";
  const pinCount = pins.list.length;

  return (
    <>
      <div className={classes} data-testid="next-shell">
        <Sidebar
          daemon={daemon}
          activeSessionId={activeId}
          view={state.view}
          titleFor={titleForThread}
          nav={nav}
          onPalette={() => setPalette(true)}
          onCollapse={() => (narrow ? setDrawer(false) : setCollapsed(true))}
        />
        {narrow && state.drawer && (
          <button
            type="button"
            className="nx-scrim"
            aria-label={L.shell.closeMenu}
            onClick={() => setDrawer(false)}
          />
        )}

        <main className="nx-main">
          {home && (
            <div className="nx-view">
              {sidebarHidden && (
                <div className="nx-homebar">
                  <button
                    type="button"
                    className="nx-ibtn"
                    title={narrow ? L.shell.menu : L.sidebar.expand}
                    aria-label={narrow ? L.shell.menu : L.sidebar.expand}
                    onClick={openSidebar}
                  >
                    {narrow ? <MenuIcon /> : <PanelIcon />}
                  </button>
                </div>
              )}
              <HomeView daemon={daemon} sessions={sessions} nav={nav} />
            </div>
          )}
          <div className={`nx-view nx-work${home ? " nx-offstage" : ""}`} aria-hidden={home}>
            <StatusLine
              daemon={daemon}
              sessions={sessions}
              project={project}
              title={title}
              journey={journey}
              turnStartedAt={turnStartedAt}
              narrow={narrow}
              nav={nav}
              onSubmit={() => undefined}
              sidebarHidden={sidebarHidden}
              onOpenSidebar={openSidebar}
            />
            {narrow && (
              <div className="nx-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.tab === "chat"}
                  className={state.tab === "chat" ? "nx-tab--on" : ""}
                  onClick={() => nav.showTab("chat")}
                >
                  {L.narrow.chatTab}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.tab === "preview"}
                  className={state.tab === "preview" ? "nx-tab--on" : ""}
                  onClick={() => nav.showTab("preview")}
                >
                  {L.narrow.screenTab(screenName ?? project?.name ?? "")}
                  {pinCount > 0 && <span className="nx-cnt">{pinCount}</span>}
                </button>
              </div>
            )}
            <div
              className={`nx-body${drag ? " planner__body--resizing" : ""}`}
              data-tab={narrow ? state.tab : undefined}
              style={narrow ? undefined : { gridTemplateColumns: `${chatWidth}px minmax(0, 1fr)` }}
            >
              <ChatColumn {...slot} discardableInvitePath={state.discardableInvitePath} />
              {!narrow && (
                <Splitter
                  side="left"
                  width={chatWidth}
                  bounds={CHAT_BOUNDS}
                  label={L.shell.chatWidth}
                  active={drag !== null}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      /* 이미 떠난 포인터 — 창 안의 끌기는 그대로 된다 */
                    }
                    setDrag({ startX: event.clientX, startWidth: chatWidth });
                  }}
                  onPointerMove={(event) => {
                    if (!drag) return;
                    if (event.buttons === 0) {
                      setDrag(null);
                      return;
                    }
                    setChatWidth(clamp(drag.startWidth + (event.clientX - drag.startX)));
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                    setDrag(null);
                  }}
                  onNudge={(delta) => setChatWidth((prev) => clamp(prev + delta))}
                  onReset={() => setChatWidth(CHAT_DEFAULT)}
                />
              )}
              <PreviewColumn {...slot} onScreenName={setScreenName} />
            </div>
          </div>
        </main>
        {toast && (
          <div className="nx-toast" role="status">
            {toast}
          </div>
        )}
      </div>

      {/* 팔레트는 옛 셸의 것을 그대로 쓴다 — `.nx` 의 버튼 초기화가 그 모양을
          덮지 않게 뿌리 밖에 그린다. 단계 6 이 새 모양으로 바꿀 때까지. */}
      {palette && (
        <Palette
          titleForThread={titleForThread}
          activeSessionId={activeId}
          projects={daemon.projects}
          hiddenThreads={daemon.hiddenThreads}
          activeSlug={daemon.activeSlug}
          onOpenThread={(slug, thread) => nav.openThread(slug, thread.id)}
          onCreateSession={() => nav.newThread()}
          onActivateProject={(slug) => daemon.api.projectActivate(slug).then(() => undefined)}
          onOpenSettings={onOpenSettings}
          onClose={() => setPalette(false)}
        />
      )}
    </>
  );
}
