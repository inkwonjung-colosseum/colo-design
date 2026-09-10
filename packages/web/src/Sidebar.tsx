import { useEffect, useRef, useState } from "react";
import type { ProjectSummary, RepoPhase } from "@cds-design/protocol";
import type { Daemon } from "./daemon-client";

/**
 * The project list (PLAN D12–D21): every connected repo the planner works
 * on, one row each, the active one's workspace filling the rest of the
 * window. Only the active project runs a preview server — the badges exist
 * to say what the other clones are doing while nobody is looking at them.
 *
 * One badge per row, in the plan's priority: 내려받는 중 (a clone coming up)
 * > 작업 중 (a Claude turn running) > 넘김 / 반영됨 (the handoff) > 변경 N.
 */
export function Sidebar({
  daemon,
  collapsed,
  collapsedByViewport,
  onToggleCollapsed,
  onAddProject,
  onOpenSettings,
  boundary,
}: {
  daemon: Daemon;
  collapsed: boolean;
  /** A narrow window folds the rail no matter what the setting says. */
  collapsedByViewport: boolean;
  onToggleCollapsed: () => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
  /** Rendered between the rail and the drag boundary (Shell composes it —
      the width state and its persistence live there, beside the preview's). */
  boundary: React.ReactNode;
}) {
  const { projects, activeSlug, api } = daemon;
  const [switching, setSwitching] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** The row whose `···` menu is open. */
const [menuFor, setMenuFor] = useState<string | null>(null);
  /** A removal (or rename) that the daemon refused, in its own words. */
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** The row being renamed, and the draft while it is. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  /** The row the removal dialog is open for. */
  const [removing, setRemoving] = useState<ProjectSummary | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!switching) return;
    // The wire answers when the registry moved; the row unlocks then.
    if (activeSlug !== switching) return;
    setSwitching(null);
    setFailed(false);
  }, [activeSlug, switching]);

  const activate = async (slug: string) => {
    if (slug === activeSlug || switching) return;
    setSwitching(slug);
    setFailed(false);
    try {
      await api.projectActivate(slug);
      setSwitching(null);
    } catch {
      // The daemon kept the old project: nothing moved, pick again.
      setSwitching(null);
      setFailed(true);
    }
  };

  const beginRename = (project: ProjectSummary) => {
    setMenuFor(null);
    setRenaming(project.slug);
    setNameDraft(project.name);
  };

  const commitRename = async () => {
    const slug = renaming;
    if (!slug) return;
    const name = nameDraft.trim();
    setRenaming(null);
    if (!name) return;
    const current = projects.find((project) => project.slug === slug);
    if (current?.name === name) return;
    try {
      await api.projectUpdate(slug, { name });
    } catch {
      setFailed(true);
    }
  };

  const remove = async (project: ProjectSummary, deleteFiles: boolean) => {
    setRemoving(null);
    try {
      await api.projectRemove(project.slug, deleteFiles);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  /** Keyboard row-walking for the listbox: focus moves, Enter activates. */
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const rows = [...listRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
      next?.focus();
      event.preventDefault();
    } else if (event.key === "F2") {
      const project = projects[index];
      if (project) beginRename(project);
      event.preventDefault();
    } else if (event.key === "Delete") {
      const project = projects[index];
      if (project) setRemoving(project);
      event.preventDefault();
    }
  };

  return (
    <>
      <nav className={`sidebar${collapsed || collapsedByViewport ? " sidebar--collapsed" : ""}`} aria-label="프로젝트">
        <div className="sidebar__brand">
          {!collapsed && !collapsedByViewport && <span className="brand-name">CDS Design</span>}
          {!collapsedByViewport && (
            <button
              type="button"
              className="ghost sidebar__fold"
              aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
            >
              {collapsed ? "›" : "‹"}
            </button>
          )}
        </div>

        {!collapsed && !collapsedByViewport && (
          <div className="sidebar__list" role="listbox" aria-label="프로젝트" ref={listRef}>
            {projects.map((project, index) => {
              const active = project.slug === activeSlug;
              const badge = badgeFor(project);
              return (
                <div key={project.slug} className="sidebar__rowwrap">
                  {renaming === project.slug ? (
                    <input
                      className="sidebar__rename"
                      value={nameDraft}
                      autoFocus
                      aria-label="프로젝트 이름"
                      onChange={(event) => setNameDraft(event.target.value)}
                      onBlur={() => void commitRename()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void commitRename();
                        if (event.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <div className={`sidebar__row${active ? " sidebar__row--active" : ""}`}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        className="sidebar__main"
                        disabled={switching !== null}
                        title={switching === project.slug ? "전환 중…" : project.name}
                        onClick={() => void activate(project.slug)}
                        onKeyDown={(event) => onKeyDown(event, index)}
                      >
                        <span className="sidebar__name">{project.name}</span>
                        {badge && (
                          <span className={`sidebar__badge sidebar__badge--${badge.kind}`}>
                            {switching === project.slug ? "전환 중…" : badge.label}
                          </span>
                        )}
                        {switching === project.slug && !badge && (
                          <span className="sidebar__badge">전환 중…</span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="ghost sidebar__menu-btn"
                        aria-label={`${project.name} 프로젝트 메뉴`}
                        aria-haspopup="menu"
                        aria-expanded={menuFor === project.slug}
                        onClick={() => setMenuFor(menuFor === project.slug ? null : project.slug)}
                      >
                        ···
                      </button>
                      {menuFor === project.slug && (
                        <span className="selector__menu sidebar__menu" role="menu">
                          <button type="button" role="menuitem" className="selector__row" onClick={() => beginRename(project)}>
                            <span className="selector__label">이름 바꾸기</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="selector__row"
                            onClick={() => {
                              setMenuFor(null);
                              onOpenSettings();
                            }}
                          >
                            <span className="selector__label">설정</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="selector__row"
                            onClick={() => {
                              setMenuFor(null);
                              setRemoving(project);
                            }}
                          >
                            <span className="selector__label">프로젝트 지우기</span>
                          </button>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!collapsedByViewport && (
          <button type="button" className="ghost sidebar__new" onClick={onAddProject}>
            + 새 프로젝트
          </button>
        )}
        {failed && <span className="sidebar__error hint">다시 시도해 주세요</span>}
      </nav>
      {boundary}
      {removing && (
        <div className="modal" onMouseDown={(event) => event.target === event.currentTarget && setRemoving(null)}>
          <div className="modal__panel sidebar__remove" role="dialog" aria-modal="true" aria-label="프로젝트 지우기">
            <header className="modal__head">
              <h2 className="modal__title">프로젝트 지우기</h2>
              <button type="button" className="ghost" aria-label="닫기" onClick={() => setRemoving(null)}>
                ✕
              </button>
            </header>
            <p className="sidebar__removetext">
              <strong>{removing.name}</strong> 을 지웁니다.
              {removing.pendingChanges > 0 && (
                <>
                  <br />
                  저장하지 않은 변경 {removing.pendingChanges}개가 있습니다.
                </>
              )}
            </p>
            <div className="sidebar__removebtns">
              <button type="button" className="ghost" onClick={() => void remove(removing, false)}>
                목록에서만 지우기
              </button>
              <button type="button" className="danger" onClick={() => void remove(removing, true)}>
                폴더까지 지우기
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** One badge per row, decided once (PLAN D15). Null means a quiet row. */
function badgeFor(project: ProjectSummary): { kind: string; label: string } | null {
  const progress: RepoPhase[] = ["cloning", "pulling", "installing", "starting"];
  if (progress.includes(project.phase)) return { kind: "progress", label: "내려받는 중…" };
  if (project.working) return { kind: "working", label: "작업 중" };
  if (project.handoff?.state === "merged") return { kind: "merged", label: "반영됨" };
  if (project.handoff) return { kind: "handoff", label: "넘김" };
  if (project.pendingChanges > 0) return { kind: "changes", label: `변경 ${project.pendingChanges}` };
  return null;
}
