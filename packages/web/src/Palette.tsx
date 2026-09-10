import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSummary, SessionSummary, ThreadSummary } from "@cds-design/protocol";
import { FolderIcon, GearIcon, PlusIcon } from "./icons";
import { loadArchivedSessionIds } from "./settings";

/** The walk is grouped 대화 → 프로젝트 → 명령; a header prints on each turn. */
type Group = "대화" | "프로젝트" | "명령";

type Row =
  | {
      kind: "session";
      group: Group;
      key: string;
      label: string;
      /** Which project the conversation belongs to — the cross-project
          row's hint, and what its run jumps through. */
      slug: string;
      projectName: string;
      live: boolean;
      now: boolean;
      run: () => void | Promise<void>;
    }
  | {
      kind: "project";
      group: Group;
      key: string;
      label: string;
      run: () => void | Promise<void>;
    }
  | {
      kind: "action";
      group: Group;
      key: string;
      label: string;
      hint: string;
      icon: typeof PlusIcon;
      run: () => void | Promise<void>;
    }
  /** The `보관된 대화 N` entry (PLAN D54); clicking folds the hidden threads open. */
  | {
      kind: "archivetoggle";
      group: Group;
      key: string;
      label: string;
      hint: string;
      run: () => void | Promise<void>;
    }
  /** One hidden thread: a click 되살리기s it, the row's 삭제 button purges it. */
  | {
      kind: "archived";
      group: Group;
      key: string;
      label: string;
      run: () => void | Promise<void>;
      purge: () => void | Promise<void>;
    };

/**
 * One overlay the frame's every jump lives behind (⌘K): every project's
 * conversations (the daemon's threads, PLAN D59), the other projects, and
 * the few commands that exist. 보관's hidden threads (PLAN D54) stay here —
 * the one list that folds them open.
 */
export function Palette({
  titleForThread,
  activeSessionId,
  projects,
  activeSlug,
  archivedSessions,
  onRestoreSession,
  onDeleteSession,
  onOpenThread,
  onCreateSession,
  onActivateProject,
  onAddProject,
  onOpenSettings,
  openArchived,
  onClose,
}: {
  /** The name a thread wears: the planner's rename, else the daemon's title. */
  titleForThread: (thread: ThreadSummary) => string;
  activeSessionId: string | null;
  projects: ProjectSummary[];
  activeSlug: string | null;
  /**
   * 보관 (PLAN D54). Optional until the shell above wires them: without both
   * callbacks the palette cannot restore or purge, so it stays silent about
   * the archive instead of showing rows that can do neither.
   */
  archivedSessions?: SessionSummary[];
  onRestoreSession?: (session: SessionSummary) => void | Promise<void>;
  onDeleteSession?: (session: SessionSummary) => void | Promise<void>;
  /** Opens a conversation — switching projects first when it is not this
      one's (PLAN D59 rule 1). */
  onOpenThread: (slug: string, thread: ThreadSummary) => void;
  onCreateSession: () => void;
  /** Resolves when the registry moved; a refusal keeps the palette up. */
  onActivateProject: (slug: string) => Promise<void>;
  onAddProject: () => void;
  onOpenSettings: () => void;
  /** Opened from the tree's `보관된 대화 N` — the section starts unfolded. */
  openArchived?: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Whether the 보관된 대화 section is unfolded (PLAN D54). */
  const [archivedOpen, setArchivedOpen] = useState(openArchived ?? false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const rows: Row[] = useMemo(() => {
    /**
     * Substring beats subsequence: `결제` ranks an answer that starts with it
     * above one that merely scatters its letters. Plain lowercase matching —
     * the planner's words are Korean and short.
     */
    const rank = (text: string): number => {
      const q = query.trim().toLowerCase();
      if (!q) return 0;
      const t = text.toLowerCase();
      const at = t.indexOf(q);
      if (at >= 0) return at === 0 ? 1 : 2;
      let i = 0;
      for (const ch of t) {
        if (ch === q[i]) i += 1;
        if (i === q.length) return 3;
      }
      return -1;
    };

    const out: Row[] = [];
    // Every project's conversations (PLAN D59) — 보관's hidden ones excepted
    // (the archive section below is where those live). The daemon owns the
    // project's own archive for the ACTIVE project.
    for (const project of projects) {
      const hidden = loadArchivedSessionIds(project.slug);
      for (const thread of project.threads ?? []) {
        if (hidden.includes(thread.id)) continue;
        const label = titleForThread(thread);
        if (rank(label) < 0) continue;
        out.push({
          kind: "session",
          group: "대화",
          key: `${project.slug}:${thread.id}`,
          slug: project.slug,
          projectName: project.name,
          label,
          live: thread.state === "running",
          now: project.slug === activeSlug && thread.id === activeSessionId,
          run: async () => {
            onOpenThread(project.slug, thread);
            onClose();
          },
        });
      }
    }
    for (const project of projects) {
      if (project.slug === activeSlug || rank(project.name) < 0) continue;
      out.push({
        kind: "project",
        group: "프로젝트",
        key: project.slug,
        label: project.name,
        run: async () => {
          try {
            await onActivateProject(project.slug);
            onClose();
          } catch {
            setError("프로젝트로 옮기지 못했습니다 — 잠시 뒤 다시 시도해 주세요.");
          }
        },
      });
    }
    const actions: Array<{ label: string; hint: string; run: () => void; icon: typeof PlusIcon }> = [
      { label: "새 대화", hint: "화면 대화를 시작합니다", run: onCreateSession, icon: PlusIcon },
      { label: "새 프로젝트", hint: "레포를 하나 더 연결합니다", run: onAddProject, icon: FolderIcon },
      { label: "설정", hint: "연결 · 대화 · 문제 해결", run: onOpenSettings, icon: GearIcon },
    ];
    const q = query.trim().toLowerCase();
    for (const action of actions) {
      if (q && !action.label.toLowerCase().includes(q)) continue;
      out.push({
        kind: "action",
        group: "명령",
        key: action.label,
        label: action.label,
        hint: action.hint,
        icon: action.icon,
        run: async () => {
          action.run();
          onClose();
        },
      });
    }
    // 보관된 대화 (PLAN D54): one folding entry at the end of the 대화 group;
    // inside it, a hidden thread per row — click brings it back, 삭제 ends it.
    // Both actions come from above; without the pair the section stays quiet.
    const archive = archivedSessions ?? [];
    if (onRestoreSession && onDeleteSession && archive.length > 0 && rank("보관된 대화") >= 0) {
      out.push({
        kind: "archivetoggle",
        group: "대화",
        key: "archived",
        label: `보관된 대화 ${archive.length}`,
        hint: archivedOpen ? "접기" : "되살리기 · 영구 삭제",
        run: () => setArchivedOpen((open) => !open),
      });
      if (archivedOpen) {
        for (const session of archive) {
          // The archive holds summaries; the tree-shaped name answers the
          // same way (planner's rename first).
          const label = titleForThread({
            id: session.sessionId,
            title: session.title,
            state: "idle",
            updatedAt: new Date(session.lastModified).toISOString(),
          });
          if (rank(label) < 0) continue;
          out.push({
            kind: "archived",
            group: "대화",
            key: `archived:${session.sessionId}`,
            label,
            run: async () => {
              await onRestoreSession(session);
              onOpenThread(activeSlug ?? "", {
                id: session.sessionId,
                title: label,
                state: "idle",
                updatedAt: new Date(session.lastModified).toISOString(),
              });
              onClose();
            },
            purge: () => onDeleteSession(session),
          });
        }
      }
    }
    return out;
  }, [projects, activeSlug, activeSessionId, query, titleForThread, archivedSessions, onRestoreSession, onDeleteSession, archivedOpen, onOpenThread, onCreateSession, onActivateProject, onAddProject, onOpenSettings, onClose]);

  // A shrinking list must not keep a highlight past its end.
  const index = Math.min(highlight, Math.max(0, rows.length - 1));
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, rows.length]);

  const run = (row: Row) => {
    setError(null);
    void row.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight(Math.min(index + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(Math.max(index - 1, 0));
    } else if (event.key === "Enter" && rows[index]) {
      event.preventDefault();
      run(rows[index]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette__panel">
        <input
          ref={searchRef}
          className="palette__search"
          value={query}
          placeholder="대화, 프로젝트, 명령 찾기"
          aria-label="대화, 프로젝트, 명령 찾기"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={rows[index] ? `palette-opt-${index}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
        />
        {error && <p className="notice notice--error palette__error">{error}</p>}
        <ul className="palette__list" id="palette-list" role="listbox" ref={listRef}>
          {rows.length === 0 && (
            <li className="palette__empty">&apos;{query.trim()}&apos;와 맞는 것이 없습니다.</li>
          )}
          {rows.map((row, i) => {
                const header = i === 0 || rows[i - 1]?.group !== row.group ? row.group : null;
            const Icon = row.kind === "action" ? row.icon : null;
            return (
              <Fragment key={row.kind + row.key}>
                {header && (
                  <li className="palette__group" role="presentation">
                    {header}
                  </li>
                )}
                <li
                  id={`palette-opt-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={row.kind === "session" ? row.now : undefined}
                  className={i === index ? "palette__row palette__row--on" : "palette__row"}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => run(row)}
                >
                  {row.kind === "session" && row.live && <span className="dot dot--live" />}
                  {Icon && (
                    <span className="palette__icon">
                      <Icon />
                    </span>
                  )}
                  <span className="palette__label">{row.label}</span>
                  {row.kind === "session" && row.now && <span className="palette__hint">지금 열림</span>}
                  {row.kind === "session" && !row.now && row.slug !== activeSlug && (
                    <span className="palette__hint">{row.projectName}</span>
                  )}
                  {row.kind === "project" && <span className="palette__hint">프로젝트</span>}
                  {row.kind === "action" && <span className="palette__hint">{row.hint}</span>}
                  {row.kind === "archivetoggle" && <span className="palette__hint">{row.hint}</span>}
                  {row.kind === "archived" && (
                    <>
                      {/* 삭제 stops the row's own 되살리기 click — it is the one
                          destructive act here and acts alone (PLAN D54). */}
                      <button
                        type="button"
                        className="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setError(null);
                          void row.purge();
                        }}
                      >
                        영구 삭제
                      </button>
                      <span className="palette__hint">보관됨</span>
                    </>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
