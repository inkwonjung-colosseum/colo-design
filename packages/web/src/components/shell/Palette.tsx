import type { ProjectSummary, ThreadSummary } from "@colo-design/protocol";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import { timeAgo } from "../../lib/format";
import { composing } from "../../lib/ime";
import { CATEGORIES, type SettingsCategory } from "../dialogs/SettingsDialog";
import { FolderIcon, GearIcon, PlusIcon, SearchIcon } from "../icons";

/** The walk is grouped 대화 → 화면 → 프로젝트 → 명령; a header prints on each turn. */
type Group = "대화" | "화면" | "프로젝트" | "명령";

type Row =
  | {
      kind: "session";
      group: Group;
      key: string;
      label: string;
      /** The sidebar's state mark: a turn on, a question up, an answer that
          landed while the planner looked elsewhere. */
      dot: "live" | "ask" | "done" | null;
      /** Right of the title: the state word or how long ago the conversation
          moved — plus the project's name when the frame-wide walk reaches
          into another project. */
      hint: string;
      run: () => void | Promise<void>;
    }
  | {
      kind: "project";
      group: Group;
      key: string;
      label: string;
      hint: string;
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

/**
 * One overlay the frame's every jump lives behind (⌘K): every project's
 * conversations (the daemon's threads), the repo's declared screens
 * (a search that reaches the preview), the other projects, and the few
 * commands that exist.
 */
export function Palette({
  titleForThread,
  activeSessionId,
  projects,
  activeSlug,
  projectSlug = null,
  onOpenThread,
  onCreateSession,
  onActivateProject,
  onAddProject,
  onOpenSettings,
  onCheckState,
  onClose,
}: {
  /** The name a thread wears: the planner's rename, else the daemon's title. */
  titleForThread: (thread: ThreadSummary) => string;
  activeSessionId: string | null;
  projects: ProjectSummary[];
  activeSlug: string | null;
  /** Opened for ONE project's conversations (the tree's 더 보기 row): the
      session walk stays inside it, and the search says so. Null — the whole
      frame's jumps, as ever. */
  projectSlug?: string | null;
  /** Opens a conversation — switching projects first when it is not this
      one's. */
  onOpenThread: (slug: string, thread: ThreadSummary) => void;
  onCreateSession: () => void;
  /** Resolves when the registry moved; a refusal keeps the palette up. */
  onActivateProject: (slug: string) => Promise<void>;
  onAddProject: () => void;
  onOpenSettings: (category?: SettingsCategory) => void;
  /** 개발자의 판정을 GitHub 에서 다시 읽는다 — 상단 바의 상태 확인과 같은 통로. */
  onCheckState: () => void;
  onClose: () => void;
}) {
  // The scoped walk names its project once — in the group header — instead
  // of repeating it on every row.
  const scopedName = projectSlug
    ? (projects.find((entry) => entry.slug === projectSlug)?.name ?? null)
    : null;
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Esc 닫기는 입력칸의 onKeyDown 에 갇혀 있지 않다 (실사 결함): 화살표로
  // 목록을 걷다 포커스가 입력칸을 벗어나도 팔레트는 닫혀야 한다. 위에
  // 대화상자가 떠 있으면 그쪽의 몫이다 — 최상단 규칙이 그린다.
  useModalEscape(panelRef, onClose);

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

    const out: Array<{ row: Row; rank: number }> = [];
    // Every project's conversations — or, when the palette was
    // opened for one project (the tree's 더 보기 row), that project's alone.
    const scope = projectSlug ? projects.filter((entry) => entry.slug === projectSlug) : projects;
    for (const project of scope) {
      for (const thread of project.threads ?? []) {
        const label = titleForThread(thread);
        const at = rank(label);
        if (at < 0) continue;
        const now = project.slug === activeSlug && thread.id === activeSessionId;
        // A scoped walk already named its project in the search box, so the
        // row's right side carries the state word or the clock — the project
        // name only where the frame-wide walk leaves the active project.
        const hint = now
          ? "지금 열림"
          : [
              projectSlug || project.slug === activeSlug ? null : project.name,
              thread.state === "running"
                ? "작업 중"
                : thread.state === "awaiting"
                  ? "확인 대기"
                  : thread.state === "finished"
                    ? "답이 왔습니다"
                    : timeAgo(Date.parse(thread.updatedAt)),
            ]
              .filter(Boolean)
              .join(" · ");
        out.push({
          rank: at,
          row: {
            kind: "session",
            group: "대화",
            key: `${project.slug}:${thread.id}`,
            label,
            dot:
              thread.state === "running"
                ? "live"
                : thread.state === "awaiting"
                  ? "ask"
                  : thread.state === "finished" && !now
                    ? "done"
                    : null,
            hint,
            run: async () => {
              onOpenThread(project.slug, thread);
              onClose();
            },
          },
        });
      }
    }
    // A scoped palette already knows its project, so the switch rows would
    // only repeat what the tree just said.
    for (const project of projects) {
      const at = rank(project.name);
      if (projectSlug || project.slug === activeSlug || at < 0) continue;
      out.push({
        rank: at,
        row: {
          kind: "project",
          group: "프로젝트",
          key: project.slug,
          label: project.name,
          hint: "프로젝트",
          run: async () => {
            try {
              await onActivateProject(project.slug);
              onClose();
            } catch {
              setError("프로젝트로 옮기지 못했습니다 — 잠시 뒤 다시 시도해 주세요.");
            }
          },
        },
      });
    }
    const actions: Array<{
      label: string;
      hint: string;
      run: () => void;
      icon: typeof PlusIcon;
    }> = [
      {
        label: "새 대화",
        hint: "화면 대화를 시작합니다",
        run: onCreateSession,
        icon: PlusIcon,
      },
      {
        label: "새 프로젝트",
        hint: "레포를 하나 더 연결합니다",
        run: onAddProject,
        icon: FolderIcon,
      },
      {
        label: "상태 확인",
        hint: "개발자의 판정과 코멘트를 다시 읽어 옵니다",
        run: onCheckState,
        icon: SearchIcon,
      },
      {
        label: "설정",
        hint: "연결 · 대화 · 문제 해결",
        run: onOpenSettings,
        icon: GearIcon,
      },
    ];
    // 설정의 방 행 — 검색이 방의 이름을 가리킬 때만 줄에 선다. 빈 검색의
    // 명령 그룹을 일곱 행이 밀어내지 않고, `동작` `연결` 을 친 그 순간에
    // 그 방으로 곧장 닿는다.
    if (query.trim()) {
      for (const category of CATEGORIES) {
        const at = rank(`설정 ${category.label}`);
        if (at < 0) continue;
        const Icon = category.icon;
        out.push({
          rank: at + 1,
          row: {
            kind: "action",
            group: "명령",
            key: `settings:${category.id}`,
            label: `설정 · ${category.label}`,
            hint: `설정을 ${category.label} 칸으로 엽니다`,
            icon: Icon,
            run: async () => {
              onOpenSettings(category.id);
              onClose();
            },
          },
        });
      }
    }
    for (const action of actions) {
      const at = rank(action.label);
      if (at < 0) continue;
      out.push({
        rank: at,
        row: {
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
        },
      });
    }
    // Groups keep their walk order; inside one, the better match leads —
    // the sort is stable, so equal ranks keep the daemon's recency order.
    const order: Record<Group, number> = { 대화: 0, 화면: 1, 프로젝트: 2, 명령: 3 };
    return out
      .sort((a, b) => order[a.row.group] - order[b.row.group] || a.rank - b.rank)
      .map((entry) => entry.row);
  }, [
    projects,
    activeSlug,
    activeSessionId,
    projectSlug,
    query,
    titleForThread,
    onOpenThread,
    onCreateSession,
    onActivateProject,
    onAddProject,
    onOpenSettings,
    onCheckState,
    onClose,
  ]);

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
    // Composition keys pass straight through: Enter would run a half-typed
    // search and the arrows would yank the IME's candidate list.
    if (composing(event)) return;
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
      <div className="palette__panel" ref={panelRef}>
        <div className="palette__searchrow">
          <SearchIcon />
          <input
            ref={searchRef}
            className="palette__search"
            value={query}
            placeholder={
              projectSlug ? "이 프로젝트의 대화 찾기" : "대화, 화면, 프로젝트, 명령 찾기"
            }
            aria-label={projectSlug ? "이 프로젝트의 대화 찾기" : "대화, 화면, 프로젝트, 명령 찾기"}
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
        </div>
        {error && <p className="notice notice--error palette__error">{error}</p>}
        <ul className="palette__list" id="palette-list" role="listbox" ref={listRef}>
          {rows.length === 0 && (
            <li className="menuempty">
              <span className="ic">
                <SearchIcon />
              </span>
              <span>
                {query.trim()
                  ? `'${query.trim()}'와 맞는 것이 없습니다.`
                  : "이 프로젝트에 아직 대화가 없습니다."}
              </span>
            </li>
          )}
          {rows.map((row, i) => {
            const header =
              i === 0 || rows[i - 1]?.group !== row.group
                ? row.group === "대화" && scopedName
                  ? `${scopedName}의 대화`
                  : row.group
                : null;
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
                  aria-selected={i === index}
                  className={i === index ? "palette__row palette__row--on" : "palette__row"}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => run(row)}
                >
                  {row.kind === "session" && row.dot && <span className={`dot dot--${row.dot}`} />}
                  {Icon && (
                    <span className="palette__icon">
                      <Icon />
                    </span>
                  )}
                  <span className="palette__label">{row.label}</span>
                  {row.hint && <span className="palette__hint">{row.hint}</span>}
                </li>
              </Fragment>
            );
          })}
        </ul>
        <div className="palette__foot" aria-hidden="true">
          <span>
            <kbd>↑↓</kbd> 이동
          </span>
          <span>
            <kbd>↵</kbd> 열기
          </span>
          <span>
            <kbd>esc</kbd> 닫기
          </span>
        </div>
      </div>
    </div>
  );
}
