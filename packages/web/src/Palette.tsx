import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSummary, SessionSummary } from "@cds-design/protocol";
import { FolderIcon, GearIcon, PlusIcon } from "./icons";

/** The walk is grouped 대화 → 프로젝트 → 명령; a header prints on each turn. */
type Group = "대화" | "프로젝트" | "명령";

type Row =
  | {
      kind: "session";
      group: Group;
      key: string;
      label: string;
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
    };

/**
 * One overlay the frame's every jump lives behind (⌘K): the threads of this
 * workspace, the other projects, and the three actions a planner reaches for
 * most. The modal's bones — the scrim, the panel, the self-dismissing
 * backdrop — one level above it, because it may open over a dialog.
 */
export function Palette({
  sessions,
  titleFor,
  activeSessionId,
  projects,
  activeSlug,
  onOpenSession,
  onCreateSession,
  onActivateProject,
  onAddProject,
  onOpenSettings,
  onClose,
}: {
  sessions: SessionSummary[];
  /** The name a thread wears: the planner's rename, else the daemon's summary. */
  titleFor: (session: SessionSummary) => string;
  activeSessionId: string | null;
  projects: ProjectSummary[];
  activeSlug: string | null;
  onOpenSession: (session: SessionSummary) => void;
  onCreateSession: () => void;
  /** Resolves when the registry moved; a refusal keeps the palette up. */
  onActivateProject: (slug: string) => Promise<void>;
  onAddProject: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
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
    for (const session of sessions) {
      const label = titleFor(session);
      if (rank(label) < 0) continue;
      out.push({
        kind: "session",
        group: "대화",
        key: session.sessionId,
        label,
        live: session.live,
        now: session.sessionId === activeSessionId,
        run: async () => {
          onOpenSession(session);
          onClose();
        },
      });
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
    return out;
  }, [sessions, projects, activeSlug, activeSessionId, query, titleFor, onOpenSession, onCreateSession, onActivateProject, onAddProject, onOpenSettings, onClose]);

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
                  {row.kind === "project" && <span className="palette__hint">프로젝트</span>}
                  {row.kind === "action" && <span className="palette__hint">{row.hint}</span>}
                </li>
              </Fragment>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
