import type { ProjectSummary, ThreadSummary } from "@nova-design/protocol";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import { timeAgo } from "../../lib/format";
import { composing } from "../../lib/ime";
import { type HiddenThreads, visibleThreads } from "../../lib/thread-visibility";
import { L } from "../../next/labels";
import { keyHint } from "../../next/lib/key-hint";
import { projectNote } from "../../next/lib/project-note";
import {
  GearIcon,
  HomeIcon,
  KeyDownIcon,
  KeyEnterIcon,
  KeyUpIcon,
  PlusIcon,
  SearchIcon,
  Spin,
} from "../../next/ui/icons";
import { matchRange, rank, stepWalk } from "./palette-match";

/** A jump in the list proper: a conversation (any project's) or a project to
 * switch to. The walk prints conversations first, then projects; a header
 * prints where the kind turns — its words come from `L` (labels.ts), same as
 * the sidebar's. */
type Row =
  | {
      kind: "session";
      key: string;
      label: string;
      /** The sidebar's state mark: a turn on, a question up. */
      mark: "live" | "ask" | null;
      /** The conversation the planner is looking at right now. */
      now: boolean;
      /** Right of the title: the state word or how long ago the conversation
          moved — plus the project's name when the frame-wide walk reaches
          into another project. */
      hint: string;
      run: () => void | Promise<void>;
    }
  | {
      kind: "project";
      key: string;
      label: string;
      hint: string;
      run: () => void | Promise<void>;
    };

/** A chip under the list: a command the frame answers wherever the planner is. */
interface Command {
  key: string;
  label: string;
  /** What it does, for the hover title. */
  hint: string;
  /** The shortcut that reaches the same place, printed inside the chip. */
  keys: string | null;
  Icon: typeof PlusIcon;
  run: () => void;
}

/**
 * One overlay the frame's every jump lives behind (⌘K): every project's
 * conversations newest first, the projects themselves, and the common
 * commands as chips under the list. The words are the sidebar's (labels.ts)
 * — the palette is the sidebar's index, not a second vocabulary.
 *
 * It is its own `.nx` root (`palette.css`): the shell's tokens and reset
 * reach it, and the app root's grid and clipping do not. Focus never leaves
 * the search field — the walk is `aria-activedescendant` over one line that
 * runs from the rows into the chips, so Enter answers whatever is lit and
 * typing keeps working after an arrow key went too far.
 */
export function Palette({
  titleForThread,
  activeSessionId,
  projects,
  hiddenThreads,
  activeSlug,
  projectSlug = null,
  onOpenThread,
  onCreateSession,
  onOpenHome,
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
  /** 홈으로 — 사이드바의 `홈` 행과 같은 걸음. */
  onOpenHome: () => void;
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
  // The list is cut at the fold — say so, or a header stranded at the edge reads
  // as a mistake. True only while there is more below.
  const [more, setMore] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Esc 닫기는 입력칸의 onKeyDown 에 갇혀 있지 않다 (실사 결함): 클릭이 포커스를
  // 입력칸 밖으로 옮겨도 팔레트는 닫혀야 한다. 위에 대화상자가 떠 있으면 그쪽의
  // 몫이다 — 최상단 규칙이 그린다.
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
            key: `${project.slug}:${thread.id}`,
            label,
            // 사이드바가 그리는 표식만 — 도는 것과 답을 기다리는 것.
            mark: thread.state === "running" ? "live" : thread.state === "awaiting" ? "ask" : null,
            now,
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
          key: project.slug,
          label: project.name,
          // 그룹 머리(`프로젝트`)를 되풀이하지 않고, 사이드바의 다른 프로젝트 줄이
          // 말하는 그 한마디(만드는 중 · 답을 기다려요 N · 반영됐어요 …)를 싣는다.
          hint: projectNote(project, L).text,
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
    // Conversations lead, then projects; inside one, the better match leads,
    // and equal ranks keep the timeline — the sort is stable, so the recency
    // key only decides where ranks tie (a query-less walk, mostly).
    const order = { session: 0, project: 1 } as const;
    return out
      .sort(
        (a, b) => order[a.row.kind] - order[b.row.kind] || a.rank - b.rank || a.recency - b.recency,
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

  // The chips — every command the frame answers, off the list proper so the
  // list keeps its scroll (오버레이 목업 05) yet on the same walk: the arrows
  // pass from the last row into them and Enter runs the lit one. 상태 확인은
  // 없다(단계 10): 감독자가 확인한다. A query narrows them like any row; an
  // empty one keeps the rest in reach.
  const commands = useMemo(() => {
    const all: Command[] = [
      // 사이드바의 세 걸음(새 대화 · 홈 · 설정)은 여기서도 닿는다 — 「홈」을 쳐도 빈손이 아니게.
      {
        key: "new",
        label: L.sidebar.newConv,
        hint: L.palette.newConvHint,
        keys: keyHint("⌘T"),
        Icon: PlusIcon,
        run: onCreateSession,
      },
      {
        key: "home",
        label: L.sidebar.home,
        hint: L.palette.homeHint,
        keys: null,
        Icon: HomeIcon,
        run: onOpenHome,
      },
      {
        key: "settings",
        label: L.sidebar.settings,
        hint: L.palette.settingsHint,
        keys: keyHint("⌘,"),
        Icon: GearIcon,
        run: onOpenSettings,
      },
    ];
    return all.filter((command) => rank(query, command.label) >= 0);
  }, [query, onCreateSession, onOpenHome, onOpenSettings]);

  // One line, rows first and the chips after — a shrinking list must not keep
  // a highlight past its end.
  const total = rows.length + commands.length;
  const index = Math.min(highlight, Math.max(0, total - 1));
  const optionId = (at: number) => `nx-pal-opt-${at}`;
  // Nothing to show at all says so — but a typed word that a chip answers must
  // not read 「맞는 것이 없어요」 above the very chip that matches.
  const hasWord = query.trim() !== "";
  const empty = rows.length === 0 && !(hasWord && commands.length > 0);
  const showsList = rows.length > 0 || empty;

  const syncMore = useCallback(() => {
    const list = listRef.current;
    setMore(list !== null && list.scrollTop + list.clientHeight < list.scrollHeight - 2);
  }, []);
  // Rows come and go with every keystroke, so the fold is read after each render
  // (a same-value set bails out); the window's height moves it too — the panel
  // yields to a short window — and the observer catches that.
  useLayoutEffect(syncMore);
  useEffect(() => {
    const list = listRef.current;
    if (!list || !showsList) return;
    const watch = new ResizeObserver(syncMore);
    watch.observe(list);
    return () => watch.disconnect();
  }, [syncMore, showsList]);

  // A row the pointer lit is already under the pointer — only the keyboard's walk
  // (and a fresh result set) may move the list, or hovering near the fold would
  // creep it along under the hand.
  const byPointer = useRef(false);
  const light = (at: number) => {
    if (at === index) return;
    byPointer.current = true;
    setHighlight(at);
  };

  useEffect(() => {
    if (byPointer.current) {
      byPointer.current = false;
      return;
    }
    const list = listRef.current;
    if (!list || index >= rows.length) return;
    // The first row sits under its group header — bring the header back too.
    if (index === 0) list.scrollTop = 0;
    else list.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, rows.length]);

  const runRow = (row: Row) => {
    setError(null);
    void row.run();
  };
  const runCommand = (command: Command) => {
    setError(null);
    command.run();
    onClose();
  };
  const runLit = () => {
    if (index < rows.length) {
      const row = rows[index];
      if (row) runRow(row);
    } else {
      const command = commands[index - rows.length];
      if (command) runCommand(command);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Composition keys pass straight through: Enter would run a half-typed
    // search and the arrows would yank the IME's candidate list.
    if (composing(event)) return;
    const step = stepWalk(event.key, index, rows.length, commands.length);
    if (step !== null) {
      event.preventDefault();
      setHighlight(step);
    } else if (event.key === "Enter" && total > 0) {
      event.preventDefault();
      runLit();
    }
    // Esc is not answered here: `useModalEscape` hears it on the document and
    // closes only the topmost layer. Closing from the field first would unmount
    // the palette before the document phase, and the dialog beneath it would
    // then find itself topmost — one keypress, two layers gone.
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: the scrim is a pointer-only dismiss — Esc (useModalEscape) is the keyboard's way out.
    <div
      className="nx nx-pal"
      // The scrim closes it; a press anywhere else inside must not pull focus out
      // of the search field — the walk and the typing both live there. The field
      // itself keeps its own mousedown (caret, selection).
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
        else if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      <div
        className="nx-pal-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={projectSlug ? L.palette.findInProject : L.palette.find}
      >
        <div className="nx-pal-search">
          <SearchIcon />
          <input
            ref={searchRef}
            className="nx-pal-input"
            value={query}
            placeholder={projectSlug ? L.palette.findInProject : L.palette.find}
            aria-label={projectSlug ? L.palette.findInProject : L.palette.find}
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="nx-pal-list"
            aria-activedescendant={total > 0 ? optionId(index) : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {error && (
          <p className="nx-pal-error" role="alert">
            {error}
          </p>
        )}
        <div className="nx-pal-box" id="nx-pal-list" role="listbox" aria-label={L.palette.find}>
          {showsList && (
            <ul
              className="nx-pal-list"
              role="presentation"
              ref={listRef}
              data-more={more}
              onScroll={syncMore}
            >
              {empty && (
                <li className="nx-pal-empty" role="presentation">
                  <SearchIcon />
                  <span>
                    {hasWord
                      ? L.palette.noMatch(query.trim())
                      : projectSlug
                        ? L.palette.noConvsInProject
                        : L.palette.noConvs}
                  </span>
                </li>
              )}
              {rows.map((row, i) => {
                const header =
                  i === 0 || rows[i - 1]?.kind !== row.kind
                    ? row.kind === "project"
                      ? L.sidebar.projects
                      : scopedName
                        ? L.palette.projectConvs(scopedName)
                        : hasWord
                          ? L.sidebar.convs
                          : L.palette.recentConvs
                    : null;
                // The typed letters, inked where they landed — only the contiguous
                // match has a shape to hold (matchRange scatters to null).
                const range = matchRange(query, row.label);
                const on = row.kind === "session" && row.now;
                return (
                  <Fragment key={row.kind + row.key}>
                    {header && (
                      <li className="nx-pal-group" role="presentation">
                        {header}
                      </li>
                    )}
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: a combobox option — the field owns the keyboard (aria-activedescendant), the row answers the pointer. */}
                    <li
                      id={optionId(i)}
                      data-index={i}
                      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: same listbox — options are rows.
                      role="option"
                      aria-selected={i === index}
                      className={`nx-pal-row${i === index ? " nx-pal-row--on" : ""}${on ? " nx-pal-row--now" : ""}`}
                      /* move, not enter — a pointer merely resting on the list
                         must not steal the walk from the keyboard's arrows */
                      onMouseMove={() => light(i)}
                      onClick={() => runRow(row)}
                    >
                      <span className="nx-pal-t">
                        <span className="nx-pal-tt">
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
                        {/* After the title, like the sidebar's row — every title
                            starts on the same edge whatever mark it wears. */}
                        {row.kind === "session" && row.mark === "live" && <Spin />}
                        {row.kind === "session" && row.mark === "ask" && (
                          <i className="nx-dot nx-dot--amber" aria-hidden="true" />
                        )}
                      </span>
                      {row.hint && <span className="nx-pal-hint">{row.hint}</span>}
                    </li>
                  </Fragment>
                );
              })}
            </ul>
          )}
          {commands.length > 0 && (
            // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own box and legend — this only names the chips' group inside the listbox.
            <div className="nx-pal-cmds" role="group" aria-label={L.palette.commands}>
              {commands.map((command, c) => {
                const at = rows.length + c;
                const Icon = command.Icon;
                return (
                  <button
                    key={command.key}
                    type="button"
                    id={optionId(at)}
                    data-index={at}
                    role="option"
                    aria-selected={at === index}
                    // The field holds the focus and the arrows do the walking —
                    // a chip in the tab order would only be a second way in.
                    tabIndex={-1}
                    className={`nx-pal-chip${at === index ? " nx-pal-chip--on" : ""}`}
                    title={command.hint}
                    onMouseMove={() => light(at)}
                    onClick={() => runCommand(command)}
                  >
                    <Icon />
                    {command.label}
                    {command.keys && <kbd>{command.keys}</kbd>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="nx-pal-foot" aria-hidden="true">
          <span>
            <kbd>
              <KeyUpIcon />
              <KeyDownIcon />
            </kbd>
            {L.palette.move}
          </span>
          <span>
            <kbd>
              <KeyEnterIcon />
            </kbd>
            {L.palette.open}
          </span>
          <span>
            <kbd>esc</kbd>
            {L.palette.close}
          </span>
        </div>
      </div>
    </div>
  );
}
