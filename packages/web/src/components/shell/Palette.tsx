import type { ProjectSummary, ThreadSummary } from "@colo-design/protocol";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import { timeAgo } from "../../lib/format";
import { composing } from "../../lib/ime";
import { type HiddenThreads, visibleThreads } from "../../lib/thread-visibility";
import { L } from "../../next/labels";
import { Spin } from "../../next/ui/icons";
import { GearIcon, type PlusIcon, SearchIcon } from "../icons";
import { matchRange, rank } from "./palette-match";

/** The walk is grouped conversations → screens → projects → commands; a header
 * prints on each turn. The keys are the walk's own words — the printed header
 * comes from `L` (labels.ts), same words as the sidebar. */
type Group = "convs" | "screens" | "projects" | "commands";

/** The printed group headers — one per walk group, in the sidebar's words. */
const GROUP_LABEL: Record<Group, string> = {
  convs: L.sidebar.convs,
  screens: L.palette.screens,
  projects: L.sidebar.projects,
  commands: L.palette.commands,
};

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
    };

/**
 * One overlay the frame's every jump lives behind (⌘K): every project's
 * conversations newest first, the projects themselves, and the common
 * commands as chips under the list. The words are the sidebar's (labels.ts)
 * — the palette is the sidebar's index, not a second vocabulary.
 */
export function Palette({
  titleForThread,
  activeSessionId,
  projects,
  hiddenThreads,
  activeSlug,
  projectSlug = null,
  onOpenThread,
  onActivateProject,
  onOpenSettings,
  onClose,
}: {
  /** The name a thread wears: the planner's rename, else the daemon's title. */
  titleForThread: (thread: ThreadSummary) => string;
  activeSessionId: string | null;
  projects: ProjectSummary[];
  /** 낙관 삭제가 이미 거둔 행 — 사이드바·홈과 같은 규칙이 팔레트에도
      산다. 숨김을 모르면 지운 대화가 ⌘K 걸음에 되살아난다. */
  hiddenThreads: HiddenThreads;
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
  onOpenSettings: () => void;
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
  const actionsRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Esc 닫기는 입력칸의 onKeyDown 에 갇혀 있지 않다 (실사 결함): 화살표로
  // 목록을 걷다 포커스가 입력칸을 벗어나도 팔레트는 닫혀야 한다. 위에
  // 대화상자가 떠 있으면 그쪽의 몫이다 — 최상단 규칙이 그린다.
  useModalEscape(panelRef, onClose);

  const rows: Row[] = useMemo(() => {
    const out: Array<{ row: Row; rank: number; recency: number }> = [];
    // Every project's conversations — or, when the palette was
    // opened for one project (the tree's 더 보기 row), that project's alone.
    const scope = projectSlug ? projects.filter((entry) => entry.slug === projectSlug) : projects;
    for (const project of scope) {
      // 낙관 삭제의 숨김을 같은 규칙으로 거둔다 — 데몬 목록이 아직 따라오지
      // 않아도 지워진 대화가 걸음에 남지 않게.
      for (const thread of visibleThreads(project.threads, hiddenThreads, project.slug)) {
        const label = titleForThread(thread);
        const at = rank(query, label);
        if (at < 0) continue;
        const now = project.slug === activeSlug && thread.id === activeSessionId;
        // Recency is the palette's first axis (오버레이 목업 05): the list
        // reads newest first, across projects too — one timeline, not one
        // pile per project. Unparseable clocks keep the daemon's order.
        const stamp = Date.parse(thread.updatedAt);
        // The right side reads like the sidebar's row: the state word and
        // the clock together (만드는 중 · 4분 전), the bare clock when the
        // conversation is quiet — plus the project's name where the
        // frame-wide walk reaches into another project.
        const clock = Number.isNaN(stamp) ? "" : timeAgo(stamp);
        const state =
          thread.state === "running"
            ? clock
              ? `${L.journey.making} · ${clock}`
              : L.journey.making
            : thread.state === "awaiting"
              ? L.sidebar.waitingAnswer
              : clock;
        const hint = now
          ? L.palette.nowOpen
          : [projectSlug || project.slug === activeSlug ? null : project.name, state]
              .filter(Boolean)
              .join(" · ");
        out.push({
          rank: at,
          recency: Number.isNaN(stamp) ? 0 : -stamp,
          row: {
            kind: "session",
            group: "convs",
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
      const at = rank(query, project.name);
      if (projectSlug || project.slug === activeSlug || at < 0) continue;
      out.push({
        rank: at,
        recency: 0,
        row: {
          kind: "project",
          group: "projects",
          key: project.slug,
          label: project.name,
          hint: L.sidebar.projects,
          run: async () => {
            try {
              await onActivateProject(project.slug);
              onClose();
            } catch {
              setError(L.palette.moveFailed);
            }
          },
        },
      });
    }
    // Groups keep their walk order; inside one, the better match leads, and
    // equal ranks keep the timeline — the sort is stable, so the recency key
    // only decides where ranks tie (a query-less walk, mostly).
    const order: Record<Group, number> = { convs: 0, screens: 1, projects: 2, commands: 3 };
    return out
      .sort(
        (a, b) =>
          order[a.row.group] - order[b.row.group] || a.rank - b.rank || a.recency - b.recency,
      )
      .map((entry) => entry.row);
  }, [
    projects,
    hiddenThreads,
    activeSlug,
    activeSessionId,
    projectSlug,
    query,
    titleForThread,
    onOpenThread,
    onActivateProject,
    onClose,
  ]);

  // The chips — every command the frame answers, off the list proper so
  // the ↑↓ walk stays inside the conversations (오버레이 목업 05). 상태 확인은
  // 없다(단계 10): 감독자가 확인한다. A query narrows them like any row; an
  // empty one keeps the rest in reach.
  const chips = useMemo(() => {
    const commands: Array<{ label: string; hint: string; icon: typeof PlusIcon; run: () => void }> =
      [
        {
          label: L.sidebar.settings,
          hint: L.palette.settingsHint,
          icon: GearIcon,
          run: () => onOpenSettings(),
        },
      ];
    return commands.filter((command) => rank(query, command.label) >= 0);
  }, [query, onOpenSettings]);

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
      if (index >= rows.length - 1) {
        // The walk's last step hands off to the chips — real buttons, so
        // Enter and Tab keep working once focus crosses. ArrowUp on the
        // first chip steps back into the list.
        actionsRef.current?.querySelector("button")?.focus();
      } else {
        setHighlight(index + 1);
      }
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
            placeholder={projectSlug ? L.palette.findInProject : L.palette.find}
            aria-label={projectSlug ? L.palette.findInProject : L.palette.find}
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
                  ? L.palette.noMatch(query.trim())
                  : projectSlug
                    ? L.palette.noConvsInProject
                    : L.palette.noConvs}
              </span>
            </li>
          )}
          {rows.map((row, i) => {
            const header =
              i === 0 || rows[i - 1]?.group !== row.group
                ? row.group === "convs"
                  ? scopedName
                    ? L.palette.projectConvs(scopedName)
                    : query.trim()
                      ? L.sidebar.convs
                      : L.palette.recentConvs
                  : GROUP_LABEL[row.group]
                : null;
            const Icon = row.kind === "action" ? row.icon : null;
            // The typed letters, inked where they landed — only the contiguous
            // match has a shape to hold (matchRange scatters to null).
            const range = matchRange(query, row.label);
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
                  /* move, not enter — a pointer merely resting on the list
                     must not steal the walk from the keyboard's arrows */
                  onMouseMove={() => setHighlight(i)}
                  onClick={() => run(row)}
                >
                  {row.kind === "session" && row.dot === "live" && <Spin />}
                  {row.kind === "session" && row.dot !== null && row.dot !== "live" && (
                    <span className={`dot dot--${row.dot}`} aria-hidden="true" />
                  )}
                  {Icon && (
                    <span className="palette__icon">
                      <Icon />
                    </span>
                  )}
                  <span className="palette__label">
                    {range ? (
                      <>
                        {row.label.slice(0, range[0])}
                        <mark>{row.label.slice(range[0], range[1])}</mark>
                        {row.label.slice(range[1])}
                      </>
                    ) : (
                      row.label
                    )}
                  </span>
                  {row.hint && <span className="palette__hint">{row.hint}</span>}
                </li>
              </Fragment>
            );
          })}
        </ul>
        {chips.length > 0 && (
          <div
            className="palette__actions"
            ref={actionsRef}
            // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: the row is the chip walk's ArrowUp 구간 — the buttons inside carry the semantics.
            onKeyDown={(event) => {
              // ArrowUp on the first chip walks back into the list's last
              // row; on the others it belongs to nothing, so pass.
              if (event.key !== "ArrowUp" || event.target !== event.currentTarget.firstChild) {
                return;
              }
              event.preventDefault();
              setHighlight(Math.max(0, rows.length - 1));
              searchRef.current?.focus();
            }}
          >
            {chips.map((chip) => {
              const Icon = chip.icon;
              return (
                <button
                  key={chip.label}
                  type="button"
                  className="chip"
                  title={chip.hint}
                  onClick={() => {
                    setError(null);
                    chip.run();
                    onClose();
                  }}
                >
                  <Icon />
                  {chip.label}
                </button>
              );
            })}
          </div>
        )}
        <div className="palette__foot" aria-hidden="true">
          <span>
            <kbd>↑↓</kbd> {L.palette.move}
          </span>
          <span>
            <kbd>↵</kbd> {L.palette.open}
          </span>
          <span>
            <kbd>esc</kbd> {L.palette.close}
          </span>
        </div>
      </div>
    </div>
  );
}
