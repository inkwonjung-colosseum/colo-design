import type { ProjectSummary, RepoPhase, ThreadSummary } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import type { Daemon } from "./daemon-client";
import { changesBadge, HANDOFF_BADGE, MERGED_BADGE, WORKING_LABEL } from "./delivery";
import { ownerRepoOf } from "./format";
import {
  CloseIcon,
  ExportIcon,
  FolderPlusIcon,
  GearIcon,
  HistoryIcon,
  NewChatIcon,
  PencilIcon,
  RefreshIcon,
  ShieldIcon,
  TrashIcon,
  WarnIcon,
} from "./icons";
import { composing } from "./ime";
import { loadTreeFoldedFor, saveTreeFolded } from "./settings";
import { useModalFocus } from "./use-modal-focus";

/** Recent children first (PLAN D59 rule 3): five rows — the palette is where
 * an older conversation stays reachable. */
const RECENT_THREADS = 5;

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
  commonInstructions,
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
  onDeleteThread,
  onExportThread,
  onRenameThread,
  onBrowseThreads,
}: {
  daemon: Daemon;
  /** 앱이 늘 하는 말(커미티 2026-09-14) — 읽기 전용 표시의 원천. */
  commonInstructions: string | null;
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
  /** 지우기, from a leaf's `···` (PLAN D76): the transcript goes for good.
      The active project's leaf alone — the daemon resolves a delete inside
      the active clone's transcript store, so a cross-project delete would
      silently miss. */
  onDeleteThread: (slug: string, thread: ThreadSummary) => void;
  /** 대화 내보내기 (리뷰 E5) — the transcript leaves as a markdown file. The
      active project's leaf alone, for the same resolve reason as 지우기. */
  onExportThread: (slug: string, thread: ThreadSummary) => void;
  /** The planner renames threads; 설정's store keeps them by session id. */
  onRenameThread: (sessionId: string, title: string) => void;
  /** `이전 대화 더 보기` — the palette, opened on this project's threads. */
  onBrowseThreads: (slug: string) => void;
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
  /** Where that popover opens, in window coordinates: the rail's overflow
      clipping eats an absolutely positioned menu, so the popover pins itself
      beside its tile with position:fixed instead. */
  const [popAt, setPopAt] = useState<{ top: number; left: number } | null>(null);
  /** A removal (or rename) that the daemon refused, in its own words. */
  const [, setErrorMessage] = useState<string | null>(null);
  /** The project row being renamed, and the draft while it is. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  /** The leaf being renamed, and the draft while it is. */
  const [threadRenaming, setThreadRenaming] = useState<{
    slug: string;
    id: string;
  } | null>(null);
  const [threadDraft, setThreadDraft] = useState("");
  /** The project row the removal dialog is open for. */
  const [removing, setRemoving] = useState<ProjectSummary | null>(null);
  /**
   * 지켜 줄 것(설정 문서 P1#8): 프로젝트 하나의 지침 상자. 설정 모달이
   * 아니라 프로젝트의 자리에 산다 — 프로젝트에 귀속된 값이기 때문이다.
   */
  const [guarding, setGuarding] = useState<ProjectSummary | null>(null);
  const [guardDraft, setGuardDraft] = useState("");
  const [savingGuard, setSavingGuard] = useState(false);
  /** Folds live in 설정's store; this session's toggles overlay it so the
      chevron moves before the write rounds-trips. */
  const [foldToggles, setFoldToggles] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLDivElement>(null);

  // --- 커미티 C-3 (2026-09-15): 사이드바 배지도 반영됨의 한 박자를 입는다 -----
  // 데이터는 project.changed 가 이미 옮긴다 — 이 신호는 오직 리듬이다(ScreenPanel
  // 의 칩 펄스와 같은 초에 운다).
  const [mergedPulse, setMergedPulse] = useState<string | null>(null);
  useEffect(() => {
    const onMerged = (event: Event) => {
      const slug = (event as CustomEvent<{ slug: string | null }>).detail?.slug ?? null;
      if (!slug) return;
      setMergedPulse(slug);
      const timer = window.setTimeout(() => setMergedPulse(null), 1200);
      return () => clearTimeout(timer);
    };
    window.addEventListener("colo-design:merged", onMerged);
    return () => window.removeEventListener("colo-design:merged", onMerged);
  }, []);
  // 커미티 B2 목적지: 같은 이름의 프로젝트 둘은 부제로, 나머지는 title 로.
  const duplicatedNames = new Set(
    projects
      .map((project) => project.name)
      .filter((name, index, all) => all.indexOf(name) !== index),
  );

  useEffect(() => {
    if (!switching) return;
    // The wire answers when the registry moved; the row unlocks then.
    if (activeSlug !== switching) return;
    setSwitching(null);
    setFailed(false);
  }, [activeSlug, switching]);

  /** The rail (user-folded or a narrow window) shows icons and popovers. */
  const rail = collapsed || collapsedByViewport;

  const threadTitle = (thread: ThreadSummary): string => sessionTitles[thread.id] ?? thread.title;

  const folded = (slug: string): boolean => foldToggles[slug] ?? loadTreeFoldedFor(slug);

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

  const beginGuardrails = (project: ProjectSummary) => {
    setMenuFor(null);
    setPopoverFor(null);
    setGuarding(project);
    setGuardDraft(project.instructions ?? "");
  };

  /**
   * 관례 최신화(커미티 2026-09-14): 낡은 관례 표식을 단 프로젝트에만 뜨는
   * 메뉴 항목. 한 턴의 대화를 열고, 결과는 저장 → 넘기기로 개발자 PR 승인을
   * 받는다 — 여기서 하는 일은 그 대화를 여는 것까지다.
   */
  const refreshConventions = async (project: ProjectSummary) => {
    setMenuFor(null);
    setPopoverFor(null);
    try {
      await api.projectRefreshConventions(project.slug);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setFailed(true);
    }
  };

  /** 저장은 다음 대화부터 적용된다 — 돌고 있는 대화의 프롬프트는 그대로다. */
  const saveGuardrails = async () => {
    if (!guarding) return;
    setSavingGuard(true);
    try {
      await api.projectUpdate(guarding.slug, { instructions: guardDraft.trim() || null });
      setGuarding(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setFailed(true);
    } finally {
      setSavingGuard(false);
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

  /** The dialog answers Escape like every other one, and focus moves onto the
      panel so Tab and a screen reader start here, not in the tree behind it. */
  const removePanel = useRef<HTMLDivElement>(null);
  useModalFocus(removePanel, removing !== null);
  useEffect(() => {
    if (!removing) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRemoving(null);
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [removing]);
  useEffect(() => {
    if (removing) removePanel.current?.focus();
  }, [removing]);

  // Every dropdown here — the project menu, the leaf menu, the rail's
  // conversation popover — answers Escape, and the backdrop under an open
  // menu takes any click that misses it. The composer's chips already keep
  // these rules; the tree now keeps the same ones.
  useEffect(() => {
    if (!menuFor && !leafMenuFor && !popoverFor) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuFor(null);
        setLeafMenuFor(null);
        setPopoverFor(null);
        setPopAt(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuFor, leafMenuFor, popoverFor]);

  /** Keyboard row-walking for the tree: focus moves in DOM order, a row's
      F2 renames it (project or conversation), Delete removes the project. */
  const onKeyDown = (event: React.KeyboardEvent, slug: string, threadId?: string) => {
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>("button.node__row, button.leaf") ??
        []),
    ];
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
    if (thread.state === "running")
      return <span className="leaf__meta leaf__meta--live">작업 중</span>;
    if (thread.state === "awaiting")
      return <span className="leaf__meta leaf__meta--ask">확인 대기</span>;
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
        {/* A viewport-forced rail has nothing to say in the brand row and no
            fold to offer — the empty strip goes away entirely. */}
        {(!rail || !collapsedByViewport) && (
          <div className="sidebar__brand">
            {!rail && <span className="brand-name">Colo Design</span>}
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
        )}

        <div className="tree" role="tree" aria-label="프로젝트와 대화" ref={listRef}>
          {projects.map((project) => {
            const active = project.slug === activeSlug;
            const badge = badgeFor(project);
            const isFolded = folded(project.slug);
            const threads = project.threads ?? [];
            /* The rail tile's pip wears the badge's kind — the fold keeps the
               state, drops the words (the tooltip says them). */
            const pipKind = switching === project.slug ? "working" : (badge?.kind ?? null);
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
                      // Enter that commits the hangul must not commit the rename.
                      if (composing(event)) return;
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
                        rail
                          ? `${project.name} 대화${badge ? ` · ${badge.label}` : ""}`
                          : switching === project.slug
                            ? "전환 중…"
                            : ownerRepoOf(project.repoUrl)
                              ? `${project.name} — ${ownerRepoOf(project.repoUrl)}`
                              : project.name
                      }
                      aria-label={
                        rail ? `${project.name} 대화${badge ? `, ${badge.label}` : ""}` : undefined
                      }
                      onClick={(event) => {
                        if (!rail) {
                          void activate(project.slug);
                          return;
                        }
                        if (popoverFor === project.slug) {
                          setPopoverFor(null);
                          setPopAt(null);
                          return;
                        }
                        const rect = event.currentTarget.getBoundingClientRect();
                        // The menu caps at 70vh — anchoring it no lower than
                        // 28vh keeps the whole thing inside the window. The
                        // left edge is the RAIL's right side, not the tile's.
                        const railRect = event.currentTarget
                          .closest(".sidebar")
                          ?.getBoundingClientRect();
                        const maxTop = window.innerHeight * 0.28;
                        setPopAt({
                          top: Math.min(rect.top, maxTop),
                          left: railRect ? railRect.right : rect.right + 8,
                        });
                        setPopoverFor(project.slug);
                      }}
                      onKeyDown={(event) => onKeyDown(event, project.slug)}
                    >
                      {rail ? (
                        <>
                          <span className="node__letter" aria-hidden="true">
                            {monogram(project.name)}
                          </span>
                          {pipKind && (
                            <span
                              className={`node__pip node__pip--${pipKind}`}
                              aria-hidden="true"
                            />
                          )}
                        </>
                      ) : (
                        <>
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
                          {duplicatedNames.has(project.name) && ownerRepoOf(project.repoUrl) && (
                            <span className="node__owner">{ownerRepoOf(project.repoUrl)}</span>
                          )}
                          {badge && (
                            <span
                              className={`node__badge node__badge--${badge.kind}${
                                mergedPulse === project.slug ? " node__badge--pulse" : ""
                              }`}
                            >
                              {switching === project.slug ? "전환 중…" : badge.label}
                            </span>
                          )}
                          {switching === project.slug && !badge && (
                            <span className="node__badge">전환 중…</span>
                          )}
                        </>
                      )}
                    </button>
                    {!rail && (
                      <>
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
                          <>
                            <button
                              type="button"
                              className="selector__backdrop"
                              aria-label="메뉴 닫기"
                              onClick={() => setMenuFor(null)}
                            />
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
                                <span className="ic ic--quiet ic--sm">
                                  <NewChatIcon />
                                </span>
                                <span className="selector__label">새 대화</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="selector__row"
                                onClick={() => beginRename(project)}
                              >
                                <span className="ic ic--quiet ic--sm">
                                  <PencilIcon />
                                </span>
                                <span className="selector__label">이름 바꾸기</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="selector__row"
                                onClick={() => beginGuardrails(project)}
                              >
                                <span className="ic ic--quiet ic--sm">
                                  <ShieldIcon />
                                </span>
                                <span className="selector__label">지켜 줄 것</span>
                              </button>
                              {project.conventionsStale && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="selector__row"
                                  onClick={() => void refreshConventions(project)}
                                >
                                  <span className="ic ic--quiet ic--sm">
                                    <RefreshIcon />
                                  </span>
                                  <span className="selector__label">관례 최신화</span>
                                </button>
                              )}
                              <button
                                type="button"
                                role="menuitem"
                                className="selector__row"
                                onClick={() => {
                                  setMenuFor(null);
                                  setRemoving(project);
                                }}
                              >
                                <span className="ic ic--danger ic--sm">
                                  <TrashIcon />
                                </span>
                                <span className="selector__label">프로젝트 지우기</span>
                              </button>
                            </span>
                          </>
                        )}
                      </>
                    )}
                    {rail && popoverFor === project.slug && (
                      <>
                        <button
                          type="button"
                          className="selector__backdrop"
                          aria-label="메뉴 닫기"
                          onClick={() => setPopoverFor(null)}
                        />
                        <span
                          className="selector__menu node__pop node__pop--fixed"
                          role="menu"
                          aria-label={`${project.name} 대화`}
                          style={
                            popAt
                              ? {
                                  position: "fixed",
                                  top: popAt.top,
                                  left: popAt.left,
                                }
                              : undefined
                          }
                        >
                          {threads.slice(0, RECENT_THREADS).map((thread) => (
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
                              <span className="selector__hint">
                                {leafMetaText(thread, activeThreadId)}
                              </span>
                            </button>
                          ))}
                          {threads.length > RECENT_THREADS && (
                            <button
                              type="button"
                              role="menuitem"
                              className="selector__row"
                              onClick={() => {
                                setPopoverFor(null);
                                onBrowseThreads(project.slug);
                              }}
                            >
                              <span className="ic ic--quiet ic--sm">
                                <HistoryIcon />
                              </span>
                              <span className="selector__label">
                                이전 대화 {threads.length - RECENT_THREADS}개 더 보기
                              </span>
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
                            <span className="ic ic--quiet ic--sm">
                              <NewChatIcon />
                            </span>
                            <span className="selector__label">＋ 새 대화</span>
                          </button>
                          {/* The row menu's tail: a rail has no ··· button, so the
                            project's own moves ride here. 이름 바꾸기 stays out —
                            its inline input cannot live in a 44px column. */}
                          <span className="node__pop__sep" aria-hidden="true" />
                          <button
                            type="button"
                            role="menuitem"
                            className="selector__row"
                            onClick={() => {
                              setPopoverFor(null);
                              setRemoving(project);
                            }}
                          >
                            <span className="ic ic--danger ic--sm">
                              <TrashIcon />
                            </span>
                            <span className="selector__label">프로젝트 지우기</span>
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                )}

                {!isFolded && !rail && (
                  <div className="node__kids" role="group">
                    {threads.slice(0, RECENT_THREADS).map((thread) => (
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
                              // Same hangul guard as the project rename above.
                              if (composing(event)) return;
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
                              <>
                                <button
                                  type="button"
                                  className="selector__backdrop"
                                  aria-label="메뉴 닫기"
                                  onClick={() => setLeafMenuFor(null)}
                                />
                                <span className="selector__menu leaf__menu" role="menu">
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="selector__row"
                                    onClick={() => beginThreadRename(project.slug, thread)}
                                  >
                                    <span className="ic ic--quiet ic--sm">
                                      <PencilIcon />
                                    </span>
                                    <span className="selector__label">이름 바꾸기</span>
                                  </button>
                                  {project.slug === activeSlug && (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="selector__row"
                                      onClick={() => {
                                        setLeafMenuFor(null);
                                        onExportThread(project.slug, thread);
                                      }}
                                    >
                                      <span className="ic ic--quiet ic--sm">
                                        <ExportIcon />
                                      </span>
                                      <span className="selector__label">대화 내보내기</span>
                                    </button>
                                  )}
                                  {project.slug === activeSlug && (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="selector__row"
                                      onClick={() => {
                                        setLeafMenuFor(null);
                                        onDeleteThread(project.slug, thread);
                                      }}
                                    >
                                      <span className="ic ic--danger ic--sm">
                                        <TrashIcon />
                                      </span>
                                      <span className="selector__label">지우기</span>
                                    </button>
                                  )}
                                </span>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                    {/* Five rows are all a tree holds (PLAN D59 rule 3); the
                        rest must not read as gone — this row names the count
                        and hands the search to the palette, already narrowed
                        to this project's conversations. */}
                    {threads.length > RECENT_THREADS && (
                      <button
                        type="button"
                        className="leaf leaf--more"
                        title="명령 팔레트에서 이 프로젝트의 대화를 찾습니다"
                        onClick={() => {
                          setPopoverFor(null);
                          onBrowseThreads(project.slug);
                        }}
                      >
                        <span className="ic ic--quiet ic--sm">
                          <HistoryIcon />
                        </span>
                        이전 대화 {threads.length - RECENT_THREADS}개 더 보기
                      </button>
                    )}
                    {/* A project with nothing in it: the place the eye lands
                        is where the way in belongs, so this line IS the way
                        in (PLAN D3/D59) — not a sentence pointing elsewhere.
                        The row's ＋ does the same thing for a project that
                        already has conversations. */}
                    {threads.length === 0 && (
                      <button
                        type="button"
                        className="leaf leaf--start"
                        onClick={() => {
                          setPopoverFor(null);
                          onNewThread(project.slug);
                        }}
                      >
                        <span className="ic ic--quiet ic--sm">
                          <NewChatIcon />
                        </span>
                        ＋ 새 대화 시작
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* The rail's foot: 새 프로젝트 on the left, 설정 on the right — the
            gear moved here from the header so every frame control lives in
            one room. The fold keeps both: a 44px rail stacks the ＋ tile
            over the gear, so narrow windows lose neither move. */}
        <div className="sidebar__foot">
          {rail ? (
            <button
              type="button"
              className="ghost sidebar__plus"
              aria-label="새 프로젝트"
              title="새 프로젝트"
              onClick={onAddProject}
            >
              ＋
            </button>
          ) : (
            <button type="button" className="ghost sidebar__new" onClick={onAddProject}>
              <FolderPlusIcon />+ 새 프로젝트
            </button>
          )}
          <button
            type="button"
            className="ghost sidebar__gear"
            aria-label="설정"
            title="설정"
            onClick={onOpenSettings}
          >
            <GearIcon />
          </button>
        </div>
        {failed && <span className="sidebar__error hint">다시 시도해 주세요</span>}
      </nav>
      {boundary}
      {removing && (
        <div
          className="modal"
          onMouseDown={(event) => event.target === event.currentTarget && setRemoving(null)}
        >
          <div
            className="modal__panel sidebar__remove"
            role="dialog"
            aria-modal="true"
            aria-label="프로젝트 지우기"
            tabIndex={-1}
            ref={removePanel}
          >
            <header className="modal__head">
              <h2 className="modal__title">프로젝트 지우기</h2>
              <button
                type="button"
                className="ghost"
                aria-label="프로젝트 지우기 닫기"
                onClick={() => setRemoving(null)}
              >
                <CloseIcon />
              </button>
            </header>
            <p className="sidebar__removetext">
              <strong>{removing.name}</strong> 프로젝트를 지울까요?
            </p>
            {removing.pendingChanges > 0 && (
              <p className="sidebar__removewarn">
                <WarnIcon /> 저장하지 않은 변경 {removing.pendingChanges}개가 사라집니다.
              </p>
            )}
            <p className="sidebar__removehint">
              목록에서만 지우면 폴더는 그대로 남습니다. 폴더까지 지우면 이 프로젝트의 대화 기록까지
              되돌릴 수 없이 사라집니다.
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
      {guarding && (
        <div
          className="modal"
          onMouseDown={(event) => event.target === event.currentTarget && setGuarding(null)}
        >
          <div
            className="modal__panel sidebar__guard"
            role="dialog"
            aria-modal="true"
            aria-label="지켜 줄 것"
            tabIndex={-1}
          >
            <header className="modal__head">
              <h2 className="modal__title">{guarding.name} · 지켜 줄 것</h2>
              <button
                type="button"
                className="ghost"
                aria-label="지켜 줄 것 닫기"
                onClick={() => setGuarding(null)}
              >
                <CloseIcon />
              </button>
            </header>
            <p className="sidebar__removehint">
              이 프로젝트에서 Claude가 늘 지켜 줬으면 하는 것을 적어 주세요. 새로 시작하는 대화부터
              적용됩니다.
            </p>
            {commonInstructions != null && (
              <details className="sidebar__common">
                <summary>앱이 늘 하는 말 — 모든 프로젝트에 공통, 읽기 전용</summary>
                <pre className="sidebar__commontext">{commonInstructions}</pre>
              </details>
            )}
            <textarea
              className="sidebar__guardbox"
              rows={7}
              value={guardDraft}
              aria-label="지켜 줄 것"
              placeholder="예) 버튼은 CDS 컴포넌트만 씁니다. 색은 디자인 토큰으로만 지정해 주세요."
              onChange={(event) => setGuardDraft(event.target.value)}
            />
            <div className="sidebar__removebtns">
              <button type="button" className="ghost" onClick={() => setGuarding(null)}>
                취소
              </button>
              <button
                type="button"
                className="primary"
                disabled={savingGuard}
                onClick={() => void saveGuardrails()}
              >
                {savingGuard ? "저장 중…" : "저장"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The rail tile's one letter: the name's first grapheme, uppercased — the
    project's face in a 44px column, where a full name has no room. */
function monogram(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "·";
}

/** The popover's short state word — the same words the row's meta uses, minus
    the markup (a menu row has no room for the dot diagram). */
function leafMetaText(thread: ThreadSummary, activeThreadId: string | null): string {
  if (thread.state === "running") return "작업 중";
  if (thread.state === "awaiting") return "확인 대기";
  if (thread.state === "finished" && thread.id !== activeThreadId) return "답이 왔습니다";
  return timeAgo(thread.updatedAt);
}

/** One badge per row, decided once (PLAN D15 · D45 — the chip's words).
 * Null means a quiet row. 확인 대기 gets its own kind: a paused turn is the
 * one state the planner must answer, and warn says so louder than the
 * working accent (PLAN D50) — in the tree's words and on the rail's pip. */
function badgeFor(project: ProjectSummary): { kind: string; label: string } | null {
  const progress: RepoPhase[] = ["cloning", "pulling", "installing", "starting"];
  if (progress.includes(project.phase)) return { kind: "progress", label: "내려받는 중…" };
  const awaiting = (project.threads ?? []).some((thread) => thread.state === "awaiting");
  if (awaiting) return { kind: "ask", label: "확인 대기" };
  if (project.working) return { kind: "working", label: WORKING_LABEL };
  if (project.handoff?.state === "merged") return { kind: "merged", label: MERGED_BADGE };
  if (project.handoff) return { kind: "handoff", label: HANDOFF_BADGE };
  if (project.pendingChanges > 0)
    return { kind: "changes", label: changesBadge(project.pendingChanges) };
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
