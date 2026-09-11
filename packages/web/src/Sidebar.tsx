import { useEffect, useReducer, useRef, useState } from "react";
import type { ProjectSummary, RepoPhase, ThreadSummary } from "@cds-design/protocol";
import type { Daemon } from "./daemon-client";
import { changesBadge, HANDOFF_BADGE, MERGED_BADGE, WORKING_LABEL } from "./stage";
import { loadArchivedSessionIds, loadTreeFoldedFor, saveTreeFolded } from "./settings";

/** Recent children first (PLAN D59 rule 3): five rows, then the archive —
 * the palette is where an older conversation stays reachable. */
const RECENT_THREADS = 5;
/** The one custom event the archive writes emit; the tree listens for it. */
const ARCHIVED_EVENT = "cds-design:archived";

/**
 * The project tree (PLAN D59): every connected repo as a row the planner can
 * unfold into its conversations. Other projects' threads show too — a turn
 * running, or an answer waiting in a clone nobody is looking at, is exactly
 * what the old tab strip could not say. Only the active project runs a
 * preview server; clicking another project's child says so in its tooltip,
 * switches in one click, and the preview follows (`켜는 중 → ready`).
 *
 * One badge per project row, in the plan's priority: 내려받는 중 (a clone
 * coming up) > 작업 중 (a Claude turn running) > 넘김 / 반영됨 (the handoff)
 * > 변경 N.
 */
export function Sidebar({
  daemon,
  collapsed,
  collapsedByViewport,
  onToggleCollapsed,
  onAddProject,
  onOpenSettings,
  boundary,
  sessionTitles,
  activeThreadId,
  onOpenThread,
  onNewThread,
  onOpenArchive,
  onArchiveThread,
  onRenameThread,
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
  /** The planner's own names for threads (설정's store), over the daemon's. */
  sessionTitles: Record<string, string>;
  /** The open thread of the active project — the leaf's active mark. */
  activeThreadId: string | null;
  /** The tree's jumps (PLAN D59 rule 1): another project's child first
      switches the project, then opens the conversation — one click. */
  onOpenThread: (slug: string, thread: ThreadSummary) => void;
  /** `＋ 새 대화` — starts a thread in that project, switching to it first. */
  onNewThread: (slug: string) => void;
  /** `보관된 대화 N` — the palette holds the hidden threads (PLAN D54). */
  onOpenArchive: (slug: string) => void;
  /** 보관, from a leaf's `···`: the thread leaves its project's list. */
  onArchiveThread: (slug: string, thread: ThreadSummary) => void;
  /** The planner renames threads; 설정's store keeps them by session id. */
  onRenameThread: (sessionId: string, title: string) => void;
}) {
  const { projects, activeSlug, api } = daemon;
  const [switching, setSwitching] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** The project row whose `···` menu is open. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** The leaf whose `···` menu is open. */
  const [leafMenuFor, setLeafMenuFor] = useState<string | null>(null);
  /** The project whose conversation popover is open (the folded rail). */
  const [popoverFor, setPopoverFor] = useState<string | null>(null);
  /** A removal (or rename) that the daemon refused, in its own words. */
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** The project row being renamed, and the draft while it is. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  /** The leaf being renamed, and the draft while it is. */
  const [threadRenaming, setThreadRenaming] = useState<{ slug: string; id: string } | null>(null);
  const [threadDraft, setThreadDraft] = useState("");
  /** The project row the removal dialog is open for. */
  const [removing, setRemoving] = useState<ProjectSummary | null>(null);
  /** Folds live in 설정's store; this session's toggles overlay it so the
      chevron moves before the write rounds-trips. */
  const [foldToggles, setFoldToggles] = useState<Record<string, boolean>>({});
  /** Archive writes land in localStorage from anywhere (tree, palette, the
      hook) — this ping is how the tree, reading the stored ids fresh, knows
      to redraw. */
  const [, bumpArchive] = useReducer((count: number) => count + 1, 0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!switching) return;
    // The wire answers when the registry moved; the row unlocks then.
    if (activeSlug !== switching) return;
    setSwitching(null);
    setFailed(false);
  }, [activeSlug, switching]);

  useEffect(() => {
    window.addEventListener(ARCHIVED_EVENT, bumpArchive);
    return () => window.removeEventListener(ARCHIVED_EVENT, bumpArchive);
  }, []);

  /** The rail (user-folded or a narrow window) shows icons and popovers. */
  const rail = collapsed || collapsedByViewport;

  const threadTitle = (thread: ThreadSummary): string =>
    sessionTitles[thread.id] ?? thread.title;

  const folded = (slug: string): boolean =>
    foldToggles[slug] ?? loadTreeFoldedFor(slug);

  const toggleFold = (slug: string) => {
    const next = !folded(slug);
    saveTreeFolded(slug, next);
    setFoldToggles((prev) => ({ ...prev, [slug]: next }));
  };

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

  const beginThreadRename = (slug: string, thread: ThreadSummary) => {
    setLeafMenuFor(null);
    setThreadRenaming({ slug, id: thread.id });
    setThreadDraft(threadTitle(thread));
  };

  const commitThreadRename = () => {
    const renamingThread = threadRenaming;
    if (!renamingThread) return;
    const name = threadDraft.trim();
    setThreadRenaming(null);
    if (!name) return;
    onRenameThread(renamingThread.id, name);
  };

  const remove = async (project: ProjectSummary, deleteFiles: boolean) => {
    setRemoving(null);
    try {
      await api.projectRemove(project.slug, deleteFiles);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  /** Keyboard row-walking for the tree: focus moves in DOM order, a row's
      F2 renames it (project or conversation), Delete removes the project. */
  const onKeyDown = (event: React.KeyboardEvent, slug: string, threadId?: string) => {
    const rows = [...listRef.current?.querySelectorAll<HTMLButtonElement>("button.node__row, button.leaf") ?? []];
    const at = rows.indexOf(event.currentTarget as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      rows[at + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
      event.preventDefault();
    } else if (event.key === "ArrowLeft" && !threadId) {
      if (!folded(slug)) toggleFold(slug);
      event.preventDefault();
    } else if (event.key === "ArrowRight" && !threadId) {
      if (folded(slug)) toggleFold(slug);
      event.preventDefault();
    } else if (event.key === "F2") {
      const project = projects.find((entry) => entry.slug === slug);
      const thread = project?.threads?.find((entry) => entry.id === threadId);
      if (thread) beginThreadRename(slug, thread);
      else if (project) beginRename(project);
      event.preventDefault();
    } else if (event.key === "Delete" && !threadId) {
      const project = projects.find((entry) => entry.slug === slug);
      if (project) setRemoving(project);
      event.preventDefault();
    }
  };

  /** What a child row says about its conversation, right of the title. */
  const leafMeta = (project: ProjectSummary, thread: ThreadSummary) => {
    if (switching === project.slug) return <span className="leaf__meta">전환 중…</span>;
    if (thread.state === "running") return <span className="leaf__meta leaf__meta--live">작업 중</span>;
    if (thread.state === "awaiting") return <span className="leaf__meta leaf__meta--ask">확인 대기</span>;
    if (thread.state === "finished" && thread.id !== activeThreadId) {
      return <span className="leaf__meta">답이 왔습니다</span>;
    }
    return <span className="leaf__meta">{timeAgo(thread.updatedAt)}</span>;
  };

  /** The child row's leading mark (PLAN D59/D50): a spinner for a turn on,
      the orange dot for a permission or question, a ring for an answer that
      landed while the planner was elsewhere, a plain dot for the rest. The
      open thread never wears the ring — the planner is reading it. */
  const leafDot = (thread: ThreadSummary) => {
    if (thread.state === "running") return <span className="leaf__dot leaf__dot--live" />;
    if (thread.state === "awaiting") return <span className="leaf__dot leaf__dot--ask" />;
    if (thread.state === "finished" && thread.id !== activeThreadId) {
      return <span className="leaf__dot leaf__dot--done" title="답이 왔습니다" />;
    }
    return <span className="leaf__dot" />;
  };

  return (
    <>
      <nav className={`sidebar${rail ? " sidebar--collapsed" : ""}`} aria-label="프로젝트">
        <div className="sidebar__brand">
          {!rail && <span className="brand-name">CDS Design</span>}
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

        <div className="tree" role="tree" aria-label="프로젝트와 대화" ref={listRef}>
          {projects.map((project) => {
            const active = project.slug === activeSlug;
            const badge = badgeFor(project);
            const isFolded = folded(project.slug);
            const hidden = loadArchivedSessionIds(project.slug);
            const visibleThreads = (project.threads ?? []).filter(
              (thread) => !hidden.includes(thread.id),
            );
            return (
              <div
                key={project.slug}
                className={`node${active ? " node--active" : ""}${isFolded ? " node--folded" : ""}`}
                role="treeitem"
                aria-expanded={!isFolded}
              >
                {renaming === project.slug ? (
                  <input
                    className="node__rename"
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
                  <div className="node__rowwrap">
                    <button
                      type="button"
                      data-slug={project.slug}
                      className="node__row"
                      disabled={switching !== null}
                      title={
                        switching === project.slug
                          ? "전환 중…"
                          : rail
                            ? `${project.name} 대화`
                            : project.name
                      }
                      onClick={() =>
                        rail
                          ? setPopoverFor(popoverFor === project.slug ? null : project.slug)
                          : void activate(project.slug)
                      }
                      onKeyDown={(event) => onKeyDown(event, project.slug)}
                    >
                      <span
                        className="node__chev"
                        aria-hidden="true"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleFold(project.slug);
                        }}
                      >
                        ▾
                      </span>
                      <span className="node__dot" aria-hidden="true" />
                      <span className="node__name">{project.name}</span>
                      {badge && (
                        <span className={`node__badge node__badge--${badge.kind}`}>
                          {switching === project.slug ? "전환 중…" : badge.label}
                        </span>
                      )}
                      {switching === project.slug && !badge && (
                        <span className="node__badge">전환 중…</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="ghost node__add"
                      aria-label={`${project.name} 에 새 대화`}
                      title="새 대화"
                      onClick={() => {
                        setPopoverFor(null);
                        onNewThread(project.slug);
                      }}
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      className="ghost node__menu-btn"
                      aria-label={`${project.name} 프로젝트 메뉴`}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === project.slug}
                      onClick={() => setMenuFor(menuFor === project.slug ? null : project.slug)}
                    >
                      ···
                    </button>
                    {menuFor === project.slug && (
                      <span className="selector__menu node__menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          className="selector__row"
                          onClick={() => {
                            setMenuFor(null);
                            onNewThread(project.slug);
                          }}
                        >
                          <span className="selector__label">새 대화</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="selector__row"
                          onClick={() => beginRename(project)}
                        >
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
                    {rail && popoverFor === project.slug && (
                      <span className="selector__menu node__pop" role="menu" aria-label={`${project.name} 대화`}>
                        {visibleThreads.slice(0, RECENT_THREADS).map((thread) => (
                          <button
                            key={thread.id}
                            type="button"
                            role="menuitem"
                            className={`selector__row${thread.id === activeThreadId && active ? " selector__row--on" : ""}`}
                            onClick={() => {
                              setPopoverFor(null);
                              onOpenThread(project.slug, thread);
                            }}
                          >
                            <span className="selector__label">{threadTitle(thread)}</span>
                            <span className="selector__hint">{leafMetaText(project, thread, activeThreadId)}</span>
                          </button>
                        ))}
                        {hidden.length > 0 && (
                          <button
                            type="button"
                            role="menuitem"
                            className="selector__row"
                            onClick={() => {
                              setPopoverFor(null);
                              onOpenArchive(project.slug);
                            }}
                          >
                            <span className="selector__label">보관된 대화 {hidden.length}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          role="menuitem"
                          className="selector__row"
                          onClick={() => {
                            setPopoverFor(null);
                            onNewThread(project.slug);
                          }}
                        >
                          <span className="selector__label">＋ 새 대화</span>
                        </button>
                      </span>
                    )}
                  </div>
                )}

                {!isFolded && !rail && (
                  <div className="node__kids" role="group">
                    {visibleThreads.slice(0, RECENT_THREADS).map((thread) => (
                      <div key={thread.id} className="leafwrap">
                        {threadRenaming?.id === thread.id ? (
                          <input
                            className="leaf__rename"
                            value={threadDraft}
                            autoFocus
                            aria-label="대화 이름"
                            onChange={(event) => setThreadDraft(event.target.value)}
                            onBlur={commitThreadRename}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") commitThreadRename();
                              if (event.key === "Escape") setThreadRenaming(null);
                            }}
                          />
                        ) : (
                          <>
                            <button
                              type="button"
                              role="treeitem"
                              aria-selected={active && thread.id === activeThreadId}
                              data-slug={project.slug}
                              data-thread-id={thread.id}
                              className={`leaf${active && thread.id === activeThreadId ? " leaf--active" : ""}`}
                              title={
                                active
                                  ? threadTitle(thread)
                                  : `누르면 ${project.name} 이 활성이 되고 미리보기가 그쪽으로 바뀝니다`
                              }
                              onClick={() => {
                                if (switching) return;
                                setLeafMenuFor(null);
                                onOpenThread(project.slug, thread);
                              }}
                              onDoubleClick={() => beginThreadRename(project.slug, thread)}
                              onKeyDown={(event) => onKeyDown(event, project.slug, thread.id)}
                            >
                              {leafDot(thread)}
                              <span className="leaf__title">{threadTitle(thread)}</span>
                              {leafMeta(project, thread)}
                            </button>
                            <button
                              type="button"
                              className="ghost leaf__menu-btn"
                              aria-label={`${threadTitle(thread)} 대화 메뉴`}
                              aria-haspopup="menu"
                              aria-expanded={leafMenuFor === thread.id}
                              onClick={() =>
                                setLeafMenuFor(leafMenuFor === thread.id ? null : thread.id)
                              }
                            >
                              ···
                            </button>
                            {leafMenuFor === thread.id && (
                              <span className="selector__menu leaf__menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="selector__row"
                                  onClick={() => beginThreadRename(project.slug, thread)}
                                >
                                  <span className="selector__label">이름 바꾸기</span>
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="selector__row"
                                  onClick={() => {
                                    setLeafMenuFor(null);
                                    onArchiveThread(project.slug, thread);
                                  }}
                                >
                                  <span className="selector__label">보관</span>
                                </button>
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                    {hidden.length > 0 && (
                      <button
                        type="button"
                        className="leaf leaf--more"
                        onClick={() => onOpenArchive(project.slug)}
                      >
                        보관된 대화 {hidden.length}
                      </button>
                    )}
                    {visibleThreads.length === 0 && hidden.length === 0 && (
                      <p className="leaf leaf--empty">아래에서 새 대화를 시작해 주세요.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

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

/** The popover's short state word — the same words the row's meta uses, minus
    the markup (a menu row has no room for the dot diagram). */
function leafMetaText(
  project: ProjectSummary,
  thread: ThreadSummary,
  activeThreadId: string | null,
): string {
  if (thread.state === "running") return "작업 중";
  if (thread.state === "awaiting") return "확인 대기";
  if (thread.state === "finished" && thread.id !== activeThreadId) return "답이 왔습니다";
  return timeAgo(thread.updatedAt);
}

/** One badge per row, decided once (PLAN D15 · D45 — the stepper's words).
 * Null means a quiet row. */
function badgeFor(project: ProjectSummary): { kind: string; label: string } | null {
  const progress: RepoPhase[] = ["cloning", "pulling", "installing", "starting"];
  if (progress.includes(project.phase)) return { kind: "progress", label: "내려받는 중…" };
  // 확인 대기 is louder than 작업 중: a thread paused for the planner's own
  // answer outranks one that is merely working (PLAN D50).
  const awaiting = (project.threads ?? []).some((thread) => thread.state === "awaiting");
  if (awaiting) return { kind: "working", label: "확인 대기" };
  if (project.working) return { kind: "working", label: WORKING_LABEL };
  if (project.handoff?.state === "merged") return { kind: "merged", label: MERGED_BADGE };
  if (project.handoff) return { kind: "handoff", label: HANDOFF_BADGE };
  if (project.pendingChanges > 0) return { kind: "changes", label: changesBadge(project.pendingChanges) };
  return null;
}

/** How long ago a conversation moved, in the tree's words. Days is the last
    rung on purpose: a planner does not schedule screens by the hour. */
function timeAgo(updatedAt: string): string {
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return "방금";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86400)}일 전`;
}
