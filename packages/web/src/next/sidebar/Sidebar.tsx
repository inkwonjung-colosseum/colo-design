import type { ThreadSummary } from "@colo-design/protocol";
import type { Daemon } from "../../lib/daemon-client";
import { L } from "../labels";
import { hasNewerVersion } from "../lib/version";
import type { ShellNav } from "../slots";
import { GearIcon, HomeIcon, PanelIcon, PlusIcon, SearchIcon } from "../ui/icons";
import { ConversationList } from "./ConversationList";
import { OtherProjects } from "./OtherProjects";
import { ProjectSwitcher } from "./ProjectSwitcher";

/**
 * 사이드바(U1 · U7) — 위에서부터 `새 대화 · 홈 · 찾기`, 프로젝트 전환기, 다른
 * 프로젝트 줄, 대화 목록, 접힌 `도구가 한 일`, 바닥에 작성자와 설정. 넓은 창은
 * 264px 열(접힘 가능), 좁은 창은 `≡` 뒤의 서랍이다 — 모양은 셸의 CSS 가 정하고
 * 이 컴포넌트는 같은 내용을 그린다.
 */
export function Sidebar({
  daemon,
  activeSessionId,
  view,
  titleFor,
  nav,
  onPalette,
  onCollapse,
}: {
  daemon: Daemon;
  activeSessionId: string | null;
  view: "home" | "thread";
  titleFor: (thread: ThreadSummary) => string;
  nav: ShellNav;
  /** ⌘K 팔레트를 연다. */
  onPalette: () => void;
  /** 넓은 창의 접기 — 좁은 창에서는 서랍 닫기. */
  onCollapse: () => void;
}) {
  const projects = daemon.projects;
  const active = projects.find((project) => project.slug === daemon.activeSlug) ?? null;
  // 홈 배지는 확인 요청만 센다 — 「내 손이 필요한 일」의 수, 모든 프로젝트에 걸쳐(U6).
  const waiting = projects.reduce((sum, project) => sum + project.pendingCount, 0);
  const author = daemon.status?.authorName?.trim() || null;
  // 설정 바퀴의 점 — 깔려 있는 AI 중 새 버전을 아는 것이 있으면 한 알(PLAN-UI U12).
  const updateReady = (daemon.status?.providers ?? []).some(
    (provider) => provider.available && hasNewerVersion(provider.version, provider.latestVersion),
  );

  return (
    <aside className="nx-sidebar">
      <div className="nx-side-top">
        <button
          type="button"
          className="nx-ibtn nx-collapse-btn"
          title={L.sidebar.collapse}
          aria-label={L.sidebar.collapse}
          onClick={onCollapse}
        >
          <PanelIcon />
        </button>
      </div>
      <nav className="nx-side-nav">
        <button type="button" className="nx-side-row" onClick={() => nav.newThread()}>
          <PlusIcon />
          {L.sidebar.newConv}
          <kbd>⌘T</kbd>
        </button>
        <button
          type="button"
          className={`nx-side-row${view === "home" ? " nx-side-row--on" : ""}`}
          aria-current={view === "home" ? "page" : undefined}
          onClick={nav.goHome}
        >
          <HomeIcon />
          {L.sidebar.home}
          {waiting > 0 && <span className="nx-cnt nx-r">{waiting}</span>}
        </button>
        <button type="button" className="nx-side-row" onClick={onPalette}>
          <SearchIcon />
          {L.sidebar.find}
          <kbd>⌘K</kbd>
        </button>
      </nav>
      <ProjectSwitcher projects={projects} active={active} onSwitch={nav.switchProject} />
      <OtherProjects
        projects={projects}
        activeSlug={daemon.activeSlug}
        onSwitch={nav.switchProject}
      />
      <div className="nx-side-label">{L.sidebar.convs}</div>
      <ConversationList
        daemon={daemon}
        project={active}
        activeSessionId={activeSessionId}
        threadView={view === "thread"}
        titleFor={titleFor}
        onOpen={(thread) => active && nav.openThread(active.slug, thread.id)}
      />
      <div className="nx-side-bottom">
        <button
          type="button"
          className="nx-me"
          aria-label={L.sidebar.settings}
          title={L.sidebar.settings}
          onClick={() => nav.openSettings()}
        >
          {author && <span className="nx-av">{Array.from(author)[0]}</span>}
          <b>{author ?? L.sidebar.settings}</b>
          <span className="nx-grow" />
          <span className="nx-muted">
            <span className={updateReady ? "nx-gear-dot" : ""}>
              <GearIcon />
            </span>
          </span>
        </button>
      </div>
    </aside>
  );
}
