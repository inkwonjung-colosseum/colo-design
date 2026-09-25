import type { Shell } from "../components/shell/Shell";
import { L } from "./labels";
import "./next.css";

/** 옛 셸과 같은 계약 — App 은 두 셸에 같은 값을 건넨다(PLAN-UI 4 · 병행 셸). */
export type NextShellProps = Parameters<typeof Shell>[0];

/**
 * 새 셸의 뼈대(PLAN-UI 단계 0) — 사이드바 · 상태 줄 · 대화 · 미리보기의 빈
 * 자리만 선다. 각 칸은 단계 1~3 이 채운다. 사용자 문자열은 전부 `labels.ts`
 * 에서 온다.
 */
export function NextShell({ daemon, onOpenSettings }: NextShellProps) {
  const projects = daemon.status?.projects ?? [];
  const activeSlug = daemon.status?.activeProject ?? null;
  const active = projects.find((project) => project.slug === activeSlug) ?? null;
  const others = projects.filter((project) => project.slug !== activeSlug);

  return (
    <div className="nx" data-testid="next-shell">
      <aside className="nx-sidebar">
        <div className="nx-side-top" />
        <nav className="nx-side-nav">
          <button type="button" className="nx-side-row">
            {L.sidebar.newConv}
            <kbd>⌘T</kbd>
          </button>
          <button type="button" className="nx-side-row">
            {L.sidebar.home}
          </button>
          <button type="button" className="nx-side-row">
            {L.sidebar.find}
            <kbd>⌘K</kbd>
          </button>
        </nav>
        {active && <div className="nx-proj">{active.name}</div>}
        {others.length > 0 && (
          <>
            <div className="nx-side-label">{L.sidebar.others}</div>
            {others.map((project) => (
              <div key={project.slug} className="nx-orow">
                {project.name}
              </div>
            ))}
          </>
        )}
        <div className="nx-side-label">{L.sidebar.convs}</div>
        <div className="nx-conv-list">
          <div className="nx-side-label">{L.sidebar.toolWork}</div>
        </div>
        <div className="nx-side-bottom">
          <button type="button" className="nx-side-row" onClick={() => onOpenSettings()}>
            {L.sidebar.settings}
          </button>
        </div>
      </aside>

      <main className="nx-main">
        <header className="nx-statusbar">
          <div className="nx-conv-title" />
          <div className="nx-grow" />
          <div className="nx-journey" title={L.journey.openWork}>
            <span>{L.journey.before}</span>
            <span>·</span>
            <span>{L.journey.review}</span>
            <span>·</span>
            <span>{L.journey.merged}</span>
          </div>
          <button type="button" className="nx-submit" disabled title={L.submit.whyNothing}>
            {L.submit.idle}
          </button>
        </header>
        <div className="nx-body">
          <section className="nx-chat">
            <div className="nx-transcript" />
            <div className="nx-composer">{L.composer.placeholder}</div>
          </section>
          <section className="nx-preview">
            <div className="nx-pvbar" />
            <div className="nx-pvstage" />
          </section>
        </div>
      </main>
    </div>
  );
}
