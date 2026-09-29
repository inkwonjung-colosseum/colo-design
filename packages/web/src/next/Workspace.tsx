import type { ThreadSummary } from "@nova-design/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Palette } from "../components/shell/Palette";
import { Splitter } from "../components/shell/Splitter";
import { usePins } from "../hooks/usePins";
import { useSessions } from "../hooks/useSessions";
import { ChatColumn } from "./chat/ChatColumn";
import { HomeView } from "./home/HomeView";
import { L } from "./labels";
import { deriveJourney } from "./lib/journey";
import { keyHint } from "./lib/key-hint";
import { firstTurn, makingPhase } from "./lib/making";
import { submitCopy } from "./lib/submit-copy";
import { useNarrow, useShellNav } from "./lib/use-shell-nav";
import { commentCount } from "./lib/work-ledger";
import type { NextShellProps } from "./NextShell";
import { PreviewColumn } from "./preview/PreviewColumn";
import { SettingsDialog } from "./settings/SettingsDialog";
import { Sidebar } from "./sidebar/Sidebar";
import type { SlotProps } from "./slots";
import { ProblemLine } from "./status/ProblemLine";
import { StatusLine } from "./status/StatusLine";
import { useWorkLedger } from "./status/use-work-ledger";
import { Count } from "./ui/Count";
import { MenuIcon, PanelIcon } from "./ui/icons";
import { Toast } from "./ui/Toast";

/**
 * 대화 칸의 폭(U1) — 320~640px, 처음은 목업의 400. 미리보기가 `PREVIEW_MIN` 아래로 줄지 않게
 * 위쪽 한도는 창 폭에 따라 더 낮아진다. 고른 폭은 기억한다(다음에 켤 때도 그대로).
 */
const CHAT_MIN = 320;
const CHAT_MAX = 640;
const CHAT_DEFAULT = 400;
const PREVIEW_MIN = 360;
const CHAT_KEY = "nova-design.chatWidth";

function storedChatWidth(): number {
  try {
    const value = Number(localStorage.getItem(CHAT_KEY));
    return Number.isFinite(value) && value >= CHAT_MIN && value <= CHAT_MAX ? value : CHAT_DEFAULT;
  } catch {
    return CHAT_DEFAULT;
  }
}

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
  onSettingsChange,
  onRenameSession,
  discardableInvitePath = null,
}: NextShellProps & { discardableInvitePath?: string | null }) {
  const sessions = useSessions(daemon, {
    ready: daemon.repo?.phase === "ready",
    chat: settings.chat,
    onChatChange,
  });
  const pins = usePins(daemon.activeSlug, daemon.api);
  const narrow = useNarrow();
  // 설정 대화상자(단계 6) — 사이드바 바퀴 · ⌘, · 팔레트가 같은 문으로 연다.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = () => setSettingsOpen(true);
  const { state, nav, toast, setCollapsed, setDrawer } = useShellNav({
    daemon,
    sessions,
    collapsed: settings.layout.sidebarCollapsed,
    discardableInvitePath,
    onLayoutChange,
    onOpenSettings: openSettings,
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
  // 단계 10 — 단계 말은 지금 도는 도구의 묶음이 고르고, 첫 보내기에는 60초 뒤 안내가 붙는다.
  const phase = makingPhase(sessions.active?.blocks ?? []);
  const firstSend = firstTurn(sessions.active?.blocks ?? []);
  const attention = daemon.repo?.attention ?? daemon.status?.attention ?? null;
  // 단계 4 — 제출 상태의 문장과 이번 작업의 장부(코멘트 수가 여정의 둘째 점에 붙는다).
  const ledger = useWorkLedger(daemon);
  const copy = submitCopy(daemon.repo?.submit, L);
  const journey = deriveJourney(
    {
      repo: daemon.repo,
      diffStatus: daemon.diffStatus,
      running,
      reconnect: attention?.kind === "reconnect",
      comments: commentCount(ledger.reviews),
      submitCopy: copy,
    },
    L,
  );

  // 팔레트와 단축키(⌘K · ⌘T · ⌘,) — 조합키가 붙어 입력창의 타이핑과 만나지 않는다.
  const [palette, setPalette] = useState(false);
  const keys = useRef({
    palette: () => {},
    fresh: () => {},
    settings: () => {},
    sidebar: () => {},
  });
  keys.current = {
    palette: () => setPalette((open) => !open),
    fresh: () => nav.newThread(),
    settings: openSettings,
    // ⌘B — 사이드바를 접고 편다(좁은 창에서는 서랍을 여닫는다).
    sidebar: () => (narrow ? setDrawer(!state.drawer) : setCollapsed(!state.collapsed)),
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      // 대화상자가 떠 있으면 물러선다 — 팔레트 자기 토글(⌘K)만 예외.
      const modal = document.querySelector(".modal, .nx-pal, .nx-set") !== null;
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
      } else if (key === "b") {
        event.preventDefault();
        keys.current.sidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 대화 칸의 폭 — 넓은 창의 한 경계. 끌어 바꾸면 기억하고, 창이 좁아져 못 맞으면 조여서 그린다.
  const [chatWidth, setChatWidth] = useState(storedChatWidth);
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setBodyWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const chatBounds = {
    min: CHAT_MIN,
    max: bodyWidth > 0 ? Math.max(CHAT_MIN, Math.min(CHAT_MAX, bodyWidth - PREVIEW_MIN)) : CHAT_MAX,
  };
  const clamp = (value: number) =>
    Math.round(Math.min(chatBounds.max, Math.max(chatBounds.min, value)));
  const shownChatWidth = clamp(chatWidth);
  useEffect(() => {
    if (drag !== null) return;
    try {
      localStorage.setItem(CHAT_KEY, String(chatWidth));
    } catch {
      /* 비공개 모드 — 이번 실행에서만 산다 */
    }
  }, [chatWidth, drag]);

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

  // 좁은 창 서랍 — Esc 로 닫히고, 열리면 첫 줄로 초점이 간다. 위에 대화상자가
  // 떠 있으면 물러난다(위의 조합키와 같은 규칙).
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!(narrow && state.drawer)) return;
    sidebarRef.current?.querySelector<HTMLElement>(".nx-side-nav .nx-side-row")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".modal, .nx-pal, .nx-set") !== null) return;
      setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, state.drawer, setDrawer]);

  // 사이드바가 접히거나 닫힐 때 — 초점이 그 안에 있었다면 펼치기 · ≡ 단추로
  // 되돌린다. 홈은 홈 막대의 단추, 대화 화면은 상태 줄의 단추가 그 자리다.
  const sidebarWasHidden = useRef(sidebarHidden);
  useEffect(() => {
    if (sidebarHidden === sidebarWasHidden.current) return;
    sidebarWasHidden.current = sidebarHidden;
    if (!sidebarHidden) {
      // 펴면 손이 있던 펴기 단추가 사라지며 초점이 body 로 떨어진다 — 사이드바 첫 줄로 옮긴다.
      if (document.activeElement === document.body) {
        sidebarRef.current?.querySelector<HTMLElement>(".nx-side-nav .nx-side-row")?.focus();
      }
      return;
    }
    if (!sidebarRef.current?.contains(document.activeElement)) return;
    const bar = home ? ".nx-homebar" : ".nx-statusbar";
    document.querySelector<HTMLElement>(`${bar} .nx-ibtn`)?.focus();
  }, [sidebarHidden, home]);

  // 대화 화면이 홈 뒤에서 나올 때 — 대화 화면은 홈이 떠 있는 동안에도 마운트돼 있어(미리보기가
  // 살아 있게) 입력창의 열쇠가 안 바뀐다. 입력창이 초점을 받도록 알린다.
  useEffect(() => {
    if (!home) window.dispatchEvent(new Event("nx:composer:focus"));
  }, [home]);

  return (
    <>
      <div className={classes} data-testid="next-shell">
        <Sidebar
          daemon={daemon}
          sessions={sessions}
          activeSessionId={activeId}
          view={state.view}
          titleFor={titleForThread}
          nav={nav}
          onPalette={() => setPalette(true)}
          onCollapse={() => (narrow ? setDrawer(false) : setCollapsed(true))}
          onRenameSession={onRenameSession}
          hidden={sidebarHidden}
          containerRef={sidebarRef}
        />
        {narrow && state.drawer && (
          <button
            type="button"
            className="nx-scrim"
            aria-label={L.shell.closeMenu}
            onClick={() => setDrawer(false)}
          />
        )}

        {/* 좁은 창의 서랍이 열려 있는 동안 뒷화면은 눌리지도 초점을 받지도 않는다(서랍은 모달처럼 보인다). */}
        <main className="nx-main" inert={narrow && state.drawer}>
          {home && (
            <div className="nx-view">
              {sidebarHidden && (
                <div className="nx-homebar">
                  <button
                    type="button"
                    className="nx-ibtn"
                    title={narrow ? L.shell.menu : keyHint(L.sidebar.expand)}
                    aria-label={narrow ? L.shell.menu : keyHint(L.sidebar.expand)}
                    onClick={openSidebar}
                  >
                    {narrow ? <MenuIcon /> : <PanelIcon />}
                  </button>
                  {/* 사이드바가 들어가면 지금 어느 프로젝트인지 이 막대가 말한다. */}
                  {project && <span className="nx-homebar-name">{project.name}</span>}
                </div>
              )}
              {/* 홈에서도 같은 한 줄(W2) — 가져온 직후 첫 화면이 홈이므로 초대 파일
                  지우기 · 문제 문장이 여기 서지 않으면 안내가 사라진다. 대화 화면의
                  자리(상태 줄 아래)는 아래 nx-work 안에 그대로 있다. */}
              <ProblemLine
                daemon={daemon}
                invitePath={state.discardableInvitePath}
                onClearInvite={() => nav.setDiscardableInvitePath(null)}
                onToast={nav.toast}
              />
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
              makingPhase={phase}
              firstTurn={firstSend}
              narrow={narrow}
              nav={nav}
              onSubmit={() => undefined}
              ledger={ledger}
              submitCopy={copy}
              sidebarHidden={sidebarHidden}
              onOpenSidebar={openSidebar}
            />
            <ProblemLine
              daemon={daemon}
              invitePath={state.discardableInvitePath}
              onClearInvite={() => nav.setDiscardableInvitePath(null)}
              onToast={nav.toast}
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
                  {pinCount > 0 && <Count n={pinCount} />}
                </button>
              </div>
            )}
            <div
              ref={bodyRef}
              className={`nx-body${drag ? " planner__body--resizing" : ""}`}
              data-tab={narrow ? state.tab : undefined}
              style={
                narrow ? undefined : { gridTemplateColumns: `${shownChatWidth}px minmax(0, 1fr)` }
              }
            >
              <ChatColumn {...slot} />
              {!narrow && (
                <Splitter
                  side="left"
                  width={shownChatWidth}
                  bounds={chatBounds}
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
                    setDrag({ startX: event.clientX, startWidth: shownChatWidth });
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
                  onNudge={(delta) => setChatWidth(clamp(shownChatWidth + delta))}
                  onReset={() => setChatWidth(CHAT_DEFAULT)}
                />
              )}
              <PreviewColumn {...slot} onScreenName={setScreenName} />
            </div>
          </div>
        </main>
        <Toast text={toast} />
        {settingsOpen && (
          <SettingsDialog
            daemon={daemon}
            settings={settings}
            onChatChange={onChatChange}
            onSettingsChange={onSettingsChange}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>

      {/* 팔레트는 스스로 `.nx` 뿌리다(`palette.css`) — 앱 뿌리의 격자 · 100vh · 잘림에
          갇히지 않게 그 옆에 그린다. */}
      {palette && (
        <Palette
          titleForThread={titleForThread}
          activeSessionId={activeId}
          projects={daemon.projects}
          hiddenThreads={daemon.hiddenThreads}
          activeSlug={daemon.activeSlug}
          onOpenThread={(slug, thread) => nav.openThread(slug, thread.id)}
          onCreateSession={() => nav.newThread()}
          onOpenHome={() => nav.goHome()}
          onActivateProject={(slug) => daemon.api.projectActivate(slug).then(() => undefined)}
          onOpenSettings={openSettings}
          onClose={() => setPalette(false)}
        />
      )}
    </>
  );
}
