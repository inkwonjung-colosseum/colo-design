import { useEffect, useRef, useState } from "react";
import type {
  ContextUsage,
  EffortLevel,
  PermissionMode,
  PlanUsage,
  SessionCommand,
  SessionSelectors,
} from "@cds-design/protocol";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  FileIcon,
  FolderIcon,
  PaperclipIcon,
  StopIcon,
} from "./icons";
import {
  EFFORT_HINT,
  EFFORT_LABEL,
  MODE_HINT,
  MODE_LABEL,
  SETTINGS_MODES,
  modelOptions,
  modelRowOf,
  modelWords,
} from "./chat-options";
import type { SendKey } from "./settings";

export interface Attachment {
  /** Images ride inline with the turn; documents are saved to `specs/` by the daemon. */
  kind: "image" | "document";
  name: string;
  mediaType: string;
  /** base64, without the data-url prefix. */
  data: string;
  size: number;
}

/** What a planner may attach as a document. Claude's Read tool handles all three. */
const DOCUMENT_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
};

function documentType(name: string): string | null {
  const dot = name.lastIndexOf(".");
  // Browsers leave `type` empty for .md, so the extension decides.
  return dot === -1 ? null : (DOCUMENT_TYPES[name.slice(dot).toLowerCase()] ?? null);
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * "언제 끝나나" reads best as time left, and one unit is enough on a chip —
 * the exact clock time stays in the tooltip.
 */
function timeLeft(at: string | null): string | null {
  if (!at) return null;
  const minutes = Math.round((new Date(at).getTime() - Date.now()) / 60000);
  if (minutes <= 0) return null;
  if (minutes < 60) return `${minutes}분 남음`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 남음`;
  return `${Math.round(hours / 24)}일 남음`;
}

/**
 * The exact moment a spent window comes back, in the planner's own clock.
 * `timeLeft` answers "얼마나"; this answers "언제".
 */
function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
}

/** Popover note: how long is left, and when the window refills — one line. */
function resetNote(at: string | null | undefined): string {
  if (!at) return "";
  const left = timeLeft(at);
  return left ? `${left} · ${clockTime(at)}에 초기화` : `${clockTime(at)}에 초기화`;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

function tone(pct: number): "" | "warn" | "danger" {
  return pct >= 85 ? "danger" : pct >= 60 ? "warn" : "";
}

/**
 * Everything the planner spends, behind one chip (PLAN D10[설정 이동]).
 *
 * The chip's face reads the 5-hour window alone — percentage and countdown —
 * the budget that decides whether one more turn is a good idea. The weekly
 * window and the conversation length answer "얼마나 더 쓸 수 있나" one click
 * away, in the popover, whose state badge still reads the worst of them all.
 */
function UsageChip({
  plan,
  usage,
  onRefresh,
}: {
  plan: PlanUsage | null;
  usage: ContextUsage | null;
  onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);

  /**
   * One entry per budget. `raw` stays unclamped so "no reading yet" (null)
   * can keep saying nothing instead of claiming 0%.
   */
  const entries: Array<{
    label: string;
    raw: number | null;
    pct: number;
    resetsAt: string | null;
    note: string;
  }> = [];
  if (plan?.fiveHour) {
    entries.push({
      label: "5시간",
      raw: plan.fiveHour.utilization ?? null,
      pct: clamp(plan.fiveHour.utilization ?? 0),
      resetsAt: plan.fiveHour.resetsAt ?? null,
      note: resetNote(plan.fiveHour.resetsAt),
    });
  }
  if (plan?.sevenDay) {
    entries.push({
      label: "이번 주",
      raw: plan.sevenDay.utilization ?? null,
      pct: clamp(plan.sevenDay.utilization ?? 0),
      resetsAt: plan.sevenDay.resetsAt ?? null,
      note: resetNote(plan.sevenDay.resetsAt),
    });
  }
  if (usage) {
    const pct = clamp(usage.percentage);
    entries.push({
      label: "대화 길이",
      raw: usage.percentage,
      pct,
      resetsAt: null,
      note:
        pct >= 85
          ? "곧 앞부분을 잊습니다. 새 대화로 나누는 편이 좋아요"
          : pct >= 60
            ? "대화가 길어지고 있어요"
            : "",
    });
  }

  // The chip's face belongs to the 5-hour window — the one a planner checks
  // before one more turn — whatever the weekly number is doing. Its colour
  // follows that same number, so the arc and the reading never disagree.
  // The overall state ("거의 찼어요") keeps reading the worst budget, where
  // the full picture lives.
  const worst = entries.length > 0 ? entries.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
  const lead = entries.find((entry) => entry.label === "5시간") ?? entries[0] ?? null;
  const badge = lead ? tone(lead.pct) : "";
  const overall = worst ? tone(worst.pct) : "";
  const reading = lead
    ? [lead.raw != null ? `${lead.pct}%` : "", timeLeft(lead.resetsAt) ?? ""].filter(Boolean).join(" · ")
    : "";
  // Time left is computed from `now`, so a rendered countdown goes stale;
  // re-render on the half-minute while one is on screen.
  const counting = Boolean(lead?.resetsAt);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open && !counting) return;
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, [open, counting]);

  // Escape closes — the one dismissal a keyboard-only planner will try first,
  // and the one every chip next to this one already answers.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!lead || !worst) return null;

  // The ring gauges whatever the chip is reading, so the arc and the number
  // beside it can never disagree. The budgets it is not showing keep their
  // rows in the popover.
  const ringPct = lead.raw != null ? lead.pct : null;
  const ringLength = 2 * Math.PI * 7.5;

  return (
    <span className="selector">
      {open && (
        <button
          type="button"
          className="selector__backdrop"
          aria-label="사용량 닫기"
          onClick={() => setOpen(false)}
        />
      )}
      <button
        type="button"
        className={badge ? `usage__chip usage__chip--${badge}` : "usage__chip"}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          lead.resetsAt
            ? `${lead.label} 한도는 ${clockTime(lead.resetsAt)}에 다시 채워집니다`
            : "Claude를 얼마나 썼는지 봅니다"
        }
        onClick={() => {
          const next = !open;
          setOpen(next);
          // Opening asks about right now: a 5-hour window that reset since
          // the last turn deserves its fresh number, not the stale one.
          if (next) onRefresh?.();
        }}
      >
        <span className="usage__ring ring" aria-hidden>
          <svg viewBox="0 0 20 20" width={18} height={18}>
            <circle className="usage__ringtrack" cx="10" cy="10" r="7.5" />
            {ringPct !== null && (
              <circle
                className={
                  tone(ringPct) ? `usage__ringarc usage__ringarc--${tone(ringPct)}` : "usage__ringarc"
                }
                cx="10"
                cy="10"
                r="7.5"
                strokeDasharray={`${(ringPct / 100) * ringLength} ${ringLength}`}
                transform="rotate(-90 10 10)"
              />
            )}
          </svg>
        </span>
        {reading ? (
          <>
            {lead.label}
            <span className="usage__reading">{reading}</span>
          </>
        ) : (
          "사용량"
        )}
      </button>
      {open && (
        <span className="selector__menu usage__menu" role="dialog" aria-label="사용량">
          <span className="usage__head">
            <span className="usage__title">사용량</span>
            <span className={overall ? `usage__state usage__state--${overall}` : "usage__state"}>
              <i className="usage__statedot" aria-hidden />
              {worst.pct >= 85 ? "거의 찼어요" : worst.pct >= 60 ? "차오르는 중" : "여유로워요"}
            </span>
          </span>
          {entries.map((row) => (
            <span key={row.label} className="usage__metric">
              <span className="usage__metric-head">
                <span className="usage__label">{row.label}</span>
                <span
                  className={
                    tone(row.pct) ? `usage__pct usage__pct--${tone(row.pct)}` : "usage__pct"
                  }
                >
                  {row.pct}%
                </span>
              </span>
              <span className="usage__track">
                <span
                  className={tone(row.pct) ? `usage__fill usage__fill--${tone(row.pct)}` : "usage__fill"}
                  style={{ width: `${row.pct}%` }}
                />
                {/* A threshold the gauge has already passed is told by the
                    colour itself; only the ones still ahead earn a tick. */}
                {row.pct < 60 && <i className="usage__tick usage__tick--warn" aria-hidden />}
                {row.pct < 85 && <i className="usage__tick usage__tick--danger" aria-hidden />}
              </span>
              {row.note && <span className="usage__note">{row.note}</span>}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * The few commands a planner meets often enough to deserve Korean names.
 * Every command the CLI advertises shows — the terminal's `/`, translated
 * only where the translation earns its place.
 */
const COMMAND_LABEL: Record<string, { label: string; hint: string }> = {
  clear: { label: "대화 새로 시작", hint: "지금까지 대화를 지우고 처음부터 이야기해요" },
  compact: { label: "대화 정리", hint: "길어진 대화를 요약해서 이어가요" },
  usage: { label: "사용량 보기", hint: "5시간·주간 한도를 얼마나 썼는지 알려줘요" },
  context: { label: "대화 길이 보기", hint: "지금 대화가 얼마나 찼는지 알려줘요" },
};

/**
 * The palette reads the CLI, which answers only once a thread exists — and an
 * empty thread is exactly where a planner reaches for `/`. These four stand
 * in until a real answer lands, so the first keystroke still offers something
 * true.
 */
const COMMAND_FALLBACK: SessionCommand[] = Object.keys(COMMAND_LABEL).map((name) => ({
  name,
  description: "",
  argumentHint: "",
  aliases: [],
}));

/**
 * One Paseo-style selector chip with its dropdown. Options arrive pre-shaped;
 * picked rows carry a check, hints ride on the right.
 */
function SelectorChip({
  label,
  prefix,
  open,
  disabled,
  title,
  onToggle,
  onClose,
  onPick,
  options,
}: {
  label: string;
  /** The chip's domain in one word ("모델"), so two chips that both default
      to 자동 never read as one control drawn twice. */
  prefix?: string;
  open: boolean;
  disabled?: boolean;
  title?: string;
  onToggle: () => void;
  onClose: () => void;
  onPick: (value: string | null) => void;
  options: Array<{ value: string | null; label: string; hint?: string; picked: boolean }>;
}) {
  const chip = useRef<HTMLButtonElement>(null);

  // Escape closes — the one dismissal a keyboard-only planner will try first.
  // Focus returns to the chip, so the next Tab keeps going from where it was.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        chip.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <span className="selector">
      {open && <button type="button" className="selector__backdrop" aria-label="선택 닫기" onClick={onClose} />}
      <button
        ref={chip}
        type="button"
        className="selector__chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={onToggle}
      >
        {prefix && <span className="selector__chipprefix">{prefix} ·</span>}
        {label}
        <ChevronDownIcon size={10} />
      </button>
      {open && (
        <span className="selector__menu" role="listbox">
          {options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              role="option"
              aria-selected={option.picked}
              className="selector__row"
              onClick={() => onPick(option.value)}
            >
              <span className="selector__check">{option.picked ? <CheckIcon size={11} /> : null}</span>
              <span className="selector__label">{option.label}</span>
              {option.hint && <span className="selector__hint">{option.hint}</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}


// ---------------------------------------------------------------------------
// Autocomplete for @files
// ---------------------------------------------------------------------------

interface Suggestion {
  insert: string;
  label: string;
  /** Muted second column: a command's description, a file's folder. */
  hint?: string;
  kind: "file" | "dir" | "command";
}

/**
 * Work out whether the caret sits in a sigil token — `@` for files, `/` for
 * commands. Returns the token being typed so the caller can look up matches,
 * plus the span to replace when one is chosen. Attached documents land in
 * `specs/`, so `@specs/…` is how a planner points Claude back at one they
 * sent earlier.
 */
const MENTION_TOKEN = /(^|\s)@(\S*)$/;
const COMMAND_TOKEN = /(^|\s)\/(\S*)$/;

function activeToken(
  text: string,
  caret: number,
  pattern: RegExp,
): { query: string; from: number } | null {
  const at = pattern.exec(text.slice(0, caret));
  if (!at) return null;
  const query = at[2] ?? "";
  return { query, from: caret - query.length - 1 };
}

// ---------------------------------------------------------------------------
// Per-conversation drafts and send history
// ---------------------------------------------------------------------------

/** What the field holds for one conversation: the words and what is pinned to them. */
interface Editor {
  text: string;
  attachments: Attachment[];
}

const EMPTY_EDITOR: Editor = { text: "", attachments: [] };

/** localStorage keys (PLAN D43): a closed or crashed window no longer eats
 *  what the planner was mid-sentence writing. Per-origin, shared across
 *  tabs — a second window picking up the same draft is the desk it belongs to. */
const DRAFT_PREFIX = "cds-design.draft.";
const HISTORY_KEY = "cds-design.history";
/** A walk back through sent turns stops somewhere; 25 rows of peeking is plenty. */
const HISTORY_MAX = 25;

function storedDraft(key: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT_PREFIX + key, text);
    else localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    // Quota or private mode: the in-memory map still covers tab switches.
  }
}

function loadHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is string => typeof row === "string").slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

function saveHistory(rows: string[]): void {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(rows.slice(-HISTORY_MAX)));
  } catch {
    // Same story as the draft: losing the walk on a reload is tolerable.
  }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export function Composer({
  commands,
  disabled,
  draftKey,
  placeholder,
  usage,
  plan,
  onRefreshUsage,
  running,
  sendKey,
  selector,
  onSetModel,
  onSetEffort,
  onSetPermissionMode,
  onSend,
  onInterrupt,
  onFindFiles,
}: {
  disabled: boolean;
  /** Which conversation this field is the draft for; swapping keys swaps drafts. */
  draftKey: string;
  /** /command palette rows, straight from the CLI. */
  commands: SessionCommand[];
  placeholder: string;
  usage: ContextUsage | null;
  /** Account-wide limits from the daemon; shown even with no thread open. */
  plan: PlanUsage | null;
  /** Called when the usage popover opens, so the numbers are read now, not
      whenever the last turn happened to land. */
  onRefreshUsage?: () => void;
  running: boolean;
  /**
   * 모델·노력·권한 chips. Before a session exists these carry what the next
   * one will start with, so the planner can set the run up while the
   * workspace is still connecting.
   */
  selector: SessionSelectors;
  onSetModel: (model: string | null) => void;
  onSetEffort: (effort: EffortLevel | null) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
  /** Which keypress sends; the other one inserts a newline. */
  sendKey: SendKey;
  onSend: (text: string, attachments: Attachment[]) => void | Promise<void>;
  onInterrupt: () => void;
  onFindFiles: (query: string) => Promise<string[]>;
}) {
  const [editor, setEditor] = useState<Editor>(() => ({
    text: storedDraft(draftKey),
    attachments: [],
  }));
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [menu, setMenu] = useState<null | "model" | "effort" | "mode">(null);
  const [tokenSpan, setTokenSpan] = useState<{ from: number; to: number } | null>(null);
  /** Bumped when a pick moves the caret, so the token is read after the move. */
  const [caretTick, setCaretTick] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const palette = useRef<HTMLDivElement>(null);
  /** The live CLI's list, or the built-in stand-in while there is none. */
  const knownCommands = commands.length > 0 ? commands : COMMAND_FALLBACK;
  // Read through a ref: ChatColumn passes a fresh arrow every render, and a
  // dep on it would re-run the token effect after Escape's own clear —
  // re-detecting the `/` still under the caret and instantly reopening the
  // palette it was meant to dismiss.
  const findFiles = useRef(onFindFiles);
  findFiles.current = onFindFiles;
  const [highlight, setHighlight] = useState(0);
  const filePicker = useRef<HTMLInputElement>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  /**
   * A draft belongs to the conversation it was typed in, not to the field
   * (Paseo-style): leave a thread mid-sentence and the words are waiting when
   * the tab comes back, instead of sitting under a different thread.
   * sessionStorage keeps the text across a reload; attachments are
   * base64-heavy and stay session-local — a reload asks to re-pick them.
   */
  const drafts = useRef(new Map<string, Editor>());
  const draftKeyRef = useRef(draftKey);
  /** Sent turns, oldest first, for the shell-style ↑ walk. */
  const history = useRef<string[]>(loadHistory());
  /** Position in the walk; null while the planner writes their own words. */
  const historyAt = useRef<number | null>(null);
  /** What the walk stepped aside for — restored when ↓ walks off the newest row. */
  const recallDraft = useRef("");

  // One sync point: every field change lands in the map (for tab switches)
  // and sessionStorage (for a reload). The tab-switch effect below re-fires
  // this with a restored draft, which writes it back where it came from.
  useEffect(() => {
    drafts.current.set(draftKeyRef.current, editor);
    saveDraft(draftKeyRef.current, editor.text);
    // PLAN D43: the count rides along so a window that died mid-attach can
    // be told what to re-pick instead of silently losing them.
    try {
      localStorage.setItem(`${DRAFT_PREFIX}${draftKeyRef.current}.attach`, String(editor.attachments.length));
    } catch {
      // Same story as the words: private mode keeps the in-memory map only.
    }
  }, [editor]);

  // Grow the textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [editor.text]);

  // A tab click is intent to type: the field takes that thread's draft and
  // the caret. The map already holds every word — swapping is one read.
  // Words typed before a thread exists (the new:* bucket) belong to the
  // conversation being started, so the first thread opened from there
  // inherits them instead of blanking the field. A thread already holding
  // its own words never takes them.
  useEffect(() => {
    if (draftKeyRef.current === draftKey) return;
    const previous = draftKeyRef.current;
    const previousEditor = drafts.current.get(previous) ?? EMPTY_EDITOR;
    const incoming = drafts.current.get(draftKey);
    const pristine =
      (incoming?.text ?? storedDraft(draftKey)) === "" && (incoming?.attachments.length ?? 0) === 0;
    const carry =
      previous.startsWith("new:") && previousEditor.text !== "" && pristine ? previousEditor : null;
    if (carry) {
      drafts.current.delete(previous);
      saveDraft(previous, "");
    }
    draftKeyRef.current = draftKey;
    historyAt.current = null;
    const restored = carry ?? incoming ?? { text: storedDraft(draftKey), attachments: [] };
    let lostAttachments = 0;
    try {
      lostAttachments = Number(localStorage.getItem(`${DRAFT_PREFIX}${draftKey}.attach`) ?? 0);
    } catch {
      lostAttachments = 0;
    }
    if (restored.attachments.length === 0 && lostAttachments > 0) {
      setRejected(`첨부 ${lostAttachments}개는 다시 붙여 주세요`);
    }
    setEditor(restored);
    requestAnimationFrame(() => {
      const element = area.current;
      if (!element) return;
      element.focus();
      const end = element.value.length;
      element.setSelectionRange(end, end);
    });
  }, [draftKey]);

  // Recompute suggestions whenever the caret lands in an @ or / token.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const caret = element.selectionStart ?? editor.text.length;

    const command = activeToken(editor.text, caret, COMMAND_TOKEN);
    if (command) {
      setTokenSpan({ from: command.from, to: caret });
      setHighlight(0);
      // `/` alone lists every command the CLI offers — the palette scrolls.
      // Typing narrows to commands containing the text, matched against the
      // name, an alias, or the Korean label a planner knows a built-in by.
      const query = command.query.toLowerCase();
      setSuggestions(
        knownCommands
          .filter(({ name, aliases }) => {
            if (!query) return true;
            const label = COMMAND_LABEL[name]?.label.toLowerCase();
            return (
              name.toLowerCase().includes(query) ||
              aliases.some((alias) => alias.toLowerCase().includes(query)) ||
              (label !== undefined && label.includes(query))
            );
          })
          .map((entry) => {
            // The few known built-ins get a planner's words; everything else —
            // a skill, a plugin, the rest of the CLI — keeps its own name.
            const known = COMMAND_LABEL[entry.name];
            return {
              insert: `/${entry.name} `,
              label: known ? known.label : `/${entry.name}${entry.argumentHint ? ` ${entry.argumentHint}` : ""}`,
              hint: known ? known.hint : entry.description,
              kind: "command" as const,
            };
          }),
      );
      return;
    }

    const mention = activeToken(editor.text, caret, MENTION_TOKEN);
    if (!mention) {
      setSuggestions([]);
      setTokenSpan(null);
      return;
    }

    setTokenSpan({ from: mention.from, to: caret });
    setHighlight(0);

    let cancelled = false;
    void findFiles.current(mention.query).then((entries) => {
      if (cancelled) return;
      setSuggestions(
        entries.slice(0, 10).map((entry) => {
          const isFolder = entry.endsWith("/");
          const path = isFolder ? entry.slice(0, -1) : entry;
          const cut = path.lastIndexOf("/");
          return {
            // A folder is a step, not a choice: it keeps the token open on its
            // own contents. A file closes it with a space, ready for the next word.
            insert: isFolder ? `@${entry}` : `@${entry} `,
            label: path.slice(cut + 1),
            ...(cut === -1 ? {} : { hint: path.slice(0, cut) }),
            kind: isFolder ? ("dir" as const) : ("file" as const),
          };
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [editor.text, knownCommands, caretTick]);

  // The palette now lists every command, so the keyboard walk has to bring
  // its row into view instead of running off the bottom of the scroll.
  useEffect(() => {
    palette.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlight, suggestions]);

  const applySuggestion = (suggestion: Suggestion) => {
    if (!tokenSpan) return;
    const next = editor.text.slice(0, tokenSpan.from) + suggestion.insert + editor.text.slice(tokenSpan.to);
    setEditor((prev) => ({ text: next, attachments: prev.attachments }));
    if (suggestion.kind !== "dir") {
      setSuggestions([]);
      setTokenSpan(null);
    }
    requestAnimationFrame(() => {
      const element = area.current;
      if (!element) return;
      const caret = tokenSpan.from + suggestion.insert.length;
      element.focus();
      element.setSelectionRange(caret, caret);
      // The caret lands a frame after the draft does; drilling into a folder
      // needs the token recomputed against its final position.
      setCaretTick((tick) => tick + 1);
    });
  };

  const readAttachments = async (files: FileList | File[]) => {
    const accepted: Array<{ file: File; kind: Attachment["kind"]; mediaType: string }> = [];
    const refused: string[] = [];
    for (const file of [...files]) {
      const document = documentType(file.name);
      if (file.type.startsWith("image/")) {
        accepted.push({ file, kind: "image", mediaType: file.type });
      } else if (document) {
        accepted.push({ file, kind: "document", mediaType: document });
      } else {
        refused.push(file.name);
      }
    }
    setRejected(
      refused.length > 0
        ? `${refused.join(", ")} — 첨부할 수 없는 형식입니다. PDF로 내보내서 다시 첨부해 주세요.`
        : null,
    );
    if (accepted.length === 0) return;
    const read = await Promise.all(
      accepted.map(
        ({ file, kind, mediaType }) =>
          new Promise<Attachment>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(`could not read ${file.name}`));
            reader.onload = () => {
              const result = String(reader.result);
              resolve({
                kind,
                name: file.name || "pasted image",
                mediaType,
                data: result.slice(result.indexOf(",") + 1),
                size: file.size,
              });
            };
            reader.readAsDataURL(file);
          }),
      ),
    );
    setEditor((prev) => ({ text: prev.text, attachments: [...prev.attachments, ...read] }));
  };

  const submit = () => {
    const text = editor.text.trim();
    if (!text && editor.attachments.length === 0) return;
    if (text) {
      // Consecutive duplicates collapse: retrying with Enter must not fill
      // the walk with a wall of identical rows.
      const rows = history.current;
      if (rows[rows.length - 1] !== text) rows.push(text);
      if (rows.length > HISTORY_MAX) rows.splice(0, rows.length - HISTORY_MAX);
      saveHistory(rows);
    }
    historyAt.current = null;
    // PLAN D35: the field empties when the daemon has ACCEPTED the turn, not
    // when the button fired — a failed send leaves the words and attachments
    // in place, with the reason in the warning strip.
    void Promise.resolve(onSend(text, editor.attachments))
      .then(() => {
        setEditor(EMPTY_EDITOR);
        setSuggestions([]);
        setRejected(null);
      })
      .catch(() => {
        setRejected("보내지지 못했습니다 — 잠시 뒤 다시 시도해 주세요");
      });
  };

  /** Swap the field's text for a recalled row, keeping the attachments, caret parked at the end. */
  const recall = (text: string) => {
    setEditor((prev) => ({ text, attachments: prev.attachments }));
    requestAnimationFrame(() => {
      const element = area.current;
      if (!element) return;
      const end = element.value.length;
      element.setSelectionRange(end, end);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME owns every keydown until its composition ends — Enter commits
    // the hangul (isComposing, legacy keyCode 229), the arrows walk the
    // candidate window. Reacting to any of them would send half a word or
    // yank the candidate list, so composition keys pass straight through.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        const picked = suggestions[highlight];
        if (picked) applySuggestion(picked);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggestions([]);
        return;
      }
    }
    // Shell-style history on the bare arrows: from the very top of the field
    // — an empty one, or the caret parked at its first character — ↑ recalls
    // the last turn, and further ↑/↓ walk the rows while the message being
    // written steps aside until the walk passes it again. Anywhere else the
    // arrows belong to the caret, not the history. Editing exits the walk
    // with the recalled text in place — a starting point, not a fixture.
    if (event.key === "ArrowUp") {
      const rows = history.current;
      const at = historyAt.current;
      const atTop = area.current === null || area.current.selectionStart === 0;
      if (at === null && !atTop) return;
      if (rows.length === 0) return;
      event.preventDefault();
      const to = at === null ? rows.length - 1 : Math.max(0, at - 1);
      if (at === null) recallDraft.current = editor.text;
      historyAt.current = to;
      // In-bounds by construction — the length check and the clamp above —
      // so the guard is the array type's demand, not the logic's.
      const row = rows[to];
      if (row !== undefined) recall(row);
      return;
    }
    if (event.key === "ArrowDown" && historyAt.current !== null) {
      const rows = history.current;
      const next = historyAt.current + 1;
      event.preventDefault();
      if (next >= rows.length) {
        historyAt.current = null;
        recall(recallDraft.current);
      } else {
        historyAt.current = next;
        const row = rows[next];
        if (row !== undefined) recall(row);
      }
      return;
    }
    // Escape while peeking puts the half-typed message back.
    if (event.key === "Escape" && historyAt.current !== null) {
      event.preventDefault();
      historyAt.current = null;
      recall(recallDraft.current);
      return;
    }
    if (event.key !== "Enter") return;
    // With "enter", a bare Enter sends and Shift+Enter is a newline. With
    // "modEnter" it is the other way round, and the modifier is what sends.
    const sends = sendKey === "enter" ? !event.shiftKey : event.metaKey || event.ctrlKey;
    if (!sends) return;
    event.preventDefault();
    submit();
  };

  // Chip labels come from the current row, so an aliased id still names the model.
  const modelRow = modelRowOf(selector.models, selector.model);
  // A model that ignores 노력 must not offer it; one whose row does not say
  // which levels it takes gets the full set.
  const effortLevels =
    modelRow?.supportedEffortLevels ?? (Object.keys(EFFORT_LABEL) as EffortLevel[]);
  const chips = [
    {
      key: "model" as const,
      label: modelRow ? modelWords(modelRow).label : "자동",
      prefix: "모델",
      title: "답변 방식",
      // The list is the CLI's, and only a session (or an earlier one, cached)
      // can supply it. Until then the chip states the default and stays shut.
      disabled: selector.models.length === 0,
      options: [
        {
          value: null,
          label: "자동으로 고르기",
          hint: "Claude Code 기본값을 그대로 써요",
          picked: selector.model == null,
        },
        ...modelOptions(selector.models, modelRow),
      ],
    },
    {
      key: "effort" as const,
      label: selector.effort ? EFFORT_LABEL[selector.effort] : "자동",
      prefix: "생각",
      title: "생각 시간",
      disabled: modelRow ? !modelRow.supportsEffort : false,
      options: [
        { value: null, label: "자동", picked: selector.effort == null },
        ...effortLevels.map((level) => ({
          value: level,
          label: EFFORT_LABEL[level],
          hint: EFFORT_HINT[level],
          picked: selector.effort === level,
        })),
      ],
    },
    {
      key: "mode" as const,
      label: MODE_LABEL[selector.permissionMode],
      prefix: "확인",
      title: "확인 방식",
      disabled: false,
      // A mode already set to 전부 맡기기 still shows as this chip's label,
      // so the planner can read what they are on and step back down.
      options: SETTINGS_MODES.map((mode) => ({
        value: mode,
        label: MODE_LABEL[mode],
        hint: MODE_HINT[mode],
        picked: selector.permissionMode === mode,
      })),
    },
  ];

  const pickChip = (key: "model" | "effort" | "mode", value: string | null) => {
    if (key === "model") onSetModel(value);
    else if (key === "effort") onSetEffort((value as EffortLevel | null) ?? null);
    else if (value) onSetPermissionMode(value as PermissionMode);
  };


  return (
    <footer
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void readAttachments(e.dataTransfer.files);
      }}
    >
      {suggestions.length > 0 && (
        <div className="autocomplete" role="listbox" ref={palette}>
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.insert}
              type="button"
              role="option"
              aria-selected={index === highlight}
              className={index === highlight ? "autocomplete__row autocomplete__row--on" : "autocomplete__row"}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => applySuggestion(suggestion)}
            >
              {suggestion.kind !== "command" && (
                <span className="autocomplete__icon">
                  {suggestion.kind === "dir" ? <FolderIcon /> : <FileIcon />}
                </span>
              )}
              <span className="autocomplete__label">{suggestion.label}</span>
              {suggestion.hint && <span className="autocomplete__hint">{suggestion.hint}</span>}
            </button>
          ))}
        </div>
      )}

      {rejected && (
        <div className="notice notice--warn">
          <span className="notice__text">{rejected}</span>
          <button
            type="button"
            className="notice__close"
            aria-label="첨부 안내 닫기"
            onClick={() => setRejected(null)}
          >
            ×
          </button>
        </div>
      )}

      {editor.attachments.length > 0 && (
        <div className="chips">
          {editor.attachments.map((attachment, index) => (
            <span key={`${attachment.name}-${index}`} className="chip">
              {attachment.kind === "image" ? (
                <img
                  className="chip__thumb"
                  src={`data:${attachment.mediaType};base64,${attachment.data}`}
                  alt=""
                />
              ) : (
                <span className="chip__doc">문서</span>
              )}
              {attachment.name}
              {attachment.kind === "document" && (
                <span className="chip__size">{fileSize(attachment.size)}</span>
              )}
              <button
                type="button"
                className="ghost"
                aria-label={`${attachment.name} 첨부 취소`}
                onClick={() =>
                  setEditor((prev) => ({
                    text: prev.text,
                    attachments: prev.attachments.filter((_, i) => i !== index),
                  }))
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={area}
        value={editor.text}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        onChange={(e) => {
          // Typing is a decision: whatever row the walk sat on, these are
          // the planner's own words now.
          historyAt.current = null;
          const text = e.target.value;
          setEditor((prev) => ({ text, attachments: prev.attachments }));
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) void readAttachments(files);
        }}
        onKeyDown={onKeyDown}
      />

      <div className="toolbar">
        <input
          ref={filePicker}
          type="file"
          accept="image/*,.md,.txt,.pdf"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void readAttachments(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="toolbar__icon"
          title="기획서·이미지 첨부"
          aria-label="기획서 첨부"
          disabled={disabled}
          onClick={() => filePicker.current?.click()}
        >
          <PaperclipIcon />
        </button>
        {chips.map((chip) => (
          <SelectorChip
            key={chip.key}
            label={chip.label}
            prefix={chip.prefix}
            title={chip.title}
            disabled={chip.disabled}
            open={menu === chip.key}
            onToggle={() => setMenu(menu === chip.key ? null : chip.key)}
            onClose={() => setMenu(null)}
            onPick={(value) => {
              pickChip(chip.key, value);
              setMenu(null);
            }}
            options={chip.options}
          />
        ))}
        <div className="toolbar__end">
          <UsageChip plan={plan} usage={usage} onRefresh={onRefreshUsage} />
          {running ? (
            <button
              type="button"
              className="toolbar__stop"
              aria-label="중지"
              title="중지"
              onClick={onInterrupt}
            >
              <StopIcon size={11} />
            </button>
          ) : (
            <button
              type="button"
              className="composer__send"
              aria-label="보내기"
              disabled={disabled || (!editor.text.trim() && editor.attachments.length === 0)}
              onClick={submit}
              title={sendKey === "enter" ? "보내기 · Enter" : "보내기 · ⌘/Ctrl+Enter"}
            >
              <ArrowUpIcon size={15} />
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
