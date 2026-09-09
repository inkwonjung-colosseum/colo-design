import { useEffect, useRef, useState } from "react";
import type {
  ContextUsage,
  EffortLevel,
  PermissionMode,
  PlanUsage,
  SessionCommand,
  SessionSelectors,
} from "@drafthouse/protocol";
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
  COMPOSER_MODES,
  DEFAULT_PERMISSION_MODE,
  EFFORT_HINT,
  EFFORT_LABEL,
  MODE_HINT,
  MODE_LABEL,
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

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

function tone(pct: number): "" | "warn" | "danger" {
  return pct >= 85 ? "danger" : pct >= 60 ? "warn" : "";
}

/**
 * Everything the planner spends, behind one chip (PLAN D10).
 *
 * Three numbers used to sit in the composer at once: two plan windows as their
 * own row, and the context ring beside the send button. All three answer the
 * same question — "얼마나 더 쓸 수 있나" — and none of them changes what a
 * planner does next, so they belong one click away rather than on the surface.
 * The dot carries the only part worth interrupting for: whichever of them is
 * closest to running out.
 */
function UsageChip({ plan, usage }: { plan: PlanUsage | null; usage: ContextUsage | null }) {
  const [open, setOpen] = useState(false);
  // Time left is computed from `now`, so a rendered countdown goes stale;
  // re-render on the half-minute while the popover is showing one.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const rows: Array<{ label: string; pct: number; note: string }> = [];
  if (plan?.fiveHour) {
    rows.push({
      label: "5시간",
      pct: clamp(plan.fiveHour.utilization ?? 0),
      note: timeLeft(plan.fiveHour.resetsAt) ?? "",
    });
  }
  if (plan?.sevenDay) {
    rows.push({
      label: "이번 주",
      pct: clamp(plan.sevenDay.utilization ?? 0),
      note: timeLeft(plan.sevenDay.resetsAt) ?? "",
    });
  }
  if (usage) {
    const pct = clamp(usage.percentage);
    rows.push({
      label: "대화 길이",
      pct,
      note:
        pct >= 85
          ? "곧 앞부분을 잊습니다. 새 대화로 나누는 편이 좋아요"
          : pct >= 60
            ? "대화가 길어지고 있어요"
            : "",
    });
  }
  if (rows.length === 0) return null;

  const worst = Math.max(...rows.map((row) => row.pct));
  const badge = tone(worst);

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
        title="Claude를 얼마나 썼는지 봅니다"
        onClick={() => setOpen(!open)}
      >
        <span className={badge ? `usage__dot usage__dot--${badge}` : "usage__dot"} />
        사용량
      </button>
      {open && (
        <span className="selector__menu usage__menu" role="dialog" aria-label="사용량">
          {rows.map((row) => (
            <span key={row.label} className="usage__row">
              <span className="usage__label">{row.label}</span>
              <span className="usage__bar">
                <span
                  className={tone(row.pct) ? `usage__fill usage__fill--${tone(row.pct)}` : "usage__fill"}
                  style={{ width: `${row.pct}%` }}
                />
              </span>
              <span className="usage__pct">{row.pct}%</span>
              {row.note && <span className="usage__note">{row.note}</span>}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * `/`-commands worth offering, in a planner's words. Everything else the CLI
 * advertises is developer or terminal plumbing and stays hidden.
 */
const COMMAND_LABEL: Record<string, { label: string; hint: string }> = {
  clear: { label: "대화 새로 시작", hint: "지금까지 대화를 지우고 처음부터 이야기해요" },
  compact: { label: "대화 정리", hint: "길어진 대화를 요약해서 이어가요" },
  usage: { label: "사용량 보기", hint: "5시간·주간 한도를 얼마나 썼는지 알려줘요" },
  context: { label: "대화 길이 보기", hint: "지금 대화가 얼마나 찼는지 알려줘요" },
};

/** Built-ins that only mean something at a terminal. */
const COMMAND_HIDDEN: Record<string, true> = {
  agents: true,
  bug: true,
  config: true,
  "connect-ide": true,
  doctor: true,
  export: true,
  feedback: true,
  hooks: true,
  ide: true,
  init: true,
  "install-github-app": true,
  login: true,
  logout: true,
  mcp: true,
  memory: true,
  model: true,
  "output-style": true,
  permissions: true,
  "pr-comments": true,
  "privacy-settings": true,
  "release-notes": true,
  resume: true,
  review: true,
  statusline: true,
  status: true,
  "terminal-setup": true,
  todos: true,
  upgrade: true,
  vim: true,
};

/**
 * One Paseo-style selector chip with its dropdown. Options arrive pre-shaped;
 * picked rows carry a check, hints ride on the right.
 */
function SelectorChip({
  label,
  open,
  disabled,
  title,
  onToggle,
  onClose,
  onPick,
  options,
}: {
  label: string;
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

interface OptionGroup {
  key: "model" | "effort" | "mode";
  label: string;
  title: string;
  disabled: boolean;
  options: Array<{ value: string | null; label: string; hint?: string; picked: boolean }>;
}

/**
 * The way back to the defaults, shown only when this conversation has left
 * them (PLAN D10).
 *
 * Three plain selects rather than three nested dropdowns: a popover whose rows
 * open more popovers has to arbitrate two backdrops and two Escape handlers,
 * and this is a panel a planner opens twice a month. Native selects also give
 * the keyboard and the screen reader behaviour for free.
 */
function AdvancedChip({
  label,
  groups,
  open,
  onOpen,
  onPick,
}: {
  label: string;
  groups: OptionGroup[];
  open: boolean;
  onOpen: (open: boolean) => void;
  onPick: (key: "model" | "effort" | "mode", value: string | null) => void;
}) {
  const chip = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onOpen(false);
      chip.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpen]);

  return (
    <span className="selector" data-testid="off-default">
      {open && (
        <button
          type="button"
          className="selector__backdrop"
          aria-label="대화 설정 닫기"
          onClick={() => onOpen(false)}
        />
      )}
      <button
        ref={chip}
        type="button"
        className="selector__chip selector__chip--off"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`이 대화는 기본 설정이 아닙니다 · ${groups
          .map((group) => `${group.title}: ${group.label}`)
          .join(" · ")}`}
        onClick={() => onOpen(!open)}
      >
        ⋯ {label}
      </button>
      {open && (
        <span className="selector__menu advanced" role="dialog" aria-label="이 대화의 설정">
          <span className="advanced__lead">
            이 대화에만 적용됩니다. 늘 쓸 값은 설정에서 정합니다.
          </span>
          {groups.map((group) => (
            <label key={group.key} className="advanced__row">
              <span className="advanced__label">{group.title}</span>
              <select
                value={group.options.find((option) => option.picked)?.value ?? ""}
                disabled={group.disabled}
                onChange={(event) => onPick(group.key, event.target.value || null)}
              >
                {group.options.map((option) => (
                  <option key={String(option.value)} value={option.value ?? ""}>
                    {option.label}
                    {option.hint ? ` — ${option.hint}` : ""}
                  </option>
                ))}
              </select>
            </label>
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
// Composer
// ---------------------------------------------------------------------------

export interface ComposerQuote {
  title: string;
  heading: string | null;
  text: string;
}

export function Composer({
  commands,
  disabled,
  placeholder,
  usage,
  plan,
  running,
  sendKey,
  quote,
  selector,
  onSetModel,
  onSetEffort,
  onSetPermissionMode,
  onDismissQuote,
  brief,
  onDismissBrief,
  onSend,
  onInterrupt,
  onFindFiles,
  initialText,
  onInitialTextConsumed,
}: {
  disabled: boolean;
  /** /command palette rows, straight from the CLI. */
  commands: SessionCommand[];
  placeholder: string;
  usage: ContextUsage | null;
  /** Account-wide limits from the daemon; shown even with no thread open. */
  plan: PlanUsage | null;
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
  /** A quote dragged out of the planning editor rides along as a chip. */
  quote?: ComposerQuote | null;
  onDismissQuote?: () => void;
  /**
   * The 기획서 this thread was opened on. Shown as a chip and attached to the
   * turn by the shell on send — the planner never types, reads or edits the
   * mirror path it stands for (PLAN D9).
   */
  brief?: { title: string; path: string } | null;
  onDismissBrief?: () => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onInterrupt: () => void;
  onFindFiles: (query: string) => Promise<string[]>;
  /**
   * A draft handed in from outside — the 기획→디자인 handoff writes the first
   * turn for the planner to read and send themselves. Never sends on its own;
   * `nonce` is what makes a repeat of the same text land again.
   */
  initialText?: { text: string; nonce: number } | null;
  onInitialTextConsumed?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [menu, setMenu] = useState(false);
  const [tokenSpan, setTokenSpan] = useState<{ from: number; to: number } | null>(null);
  /** Bumped when a pick moves the caret, so the token is read after the move. */
  const [caretTick, setCaretTick] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const [highlight, setHighlight] = useState(0);
  const filePicker = useRef<HTMLInputElement>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  /** The last handed-in draft this composer took, so a re-render never re-takes it. */
  const takenNonce = useRef<number | null>(null);

  // A handed-in draft fills the box and takes focus; the planner reads it and
  // presses send. Anything already typed is replaced, which is what a fresh
  // handoff means.
  useEffect(() => {
    if (!initialText || takenNonce.current === initialText.nonce) return;
    takenNonce.current = initialText.nonce;
    setDraft(initialText.text);
    const caret = initialText.text.length;
    requestAnimationFrame(() => {
      const element = area.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
    onInitialTextConsumed?.();
  }, [initialText, onInitialTextConsumed]);

  // Grow the textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [draft]);

  // Recompute suggestions whenever the caret lands in an @ or / token.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const caret = element.selectionStart ?? draft.length;

    const command = activeToken(draft, caret, COMMAND_TOKEN);
    if (command) {
      setTokenSpan({ from: command.from, to: caret });
      setHighlight(0);
      const typed = command.query;
      setSuggestions(
        commands
          .filter(
            ({ name, aliases }) =>
              !COMMAND_HIDDEN[name] &&
              (!typed ||
                name.startsWith(typed) ||
                aliases.some((alias) => alias.startsWith(typed))),
          )
          .slice(0, 10)
          .map((entry) => {
            // Built-ins get a planner's words; a team's own skill keeps its own.
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

    const mention = activeToken(draft, caret, MENTION_TOKEN);
    if (!mention) {
      setSuggestions([]);
      setTokenSpan(null);
      return;
    }

    setTokenSpan({ from: mention.from, to: caret });
    setHighlight(0);

    let cancelled = false;
    void onFindFiles(mention.query).then((entries) => {
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
  }, [draft, onFindFiles, commands, caretTick]);

  const applySuggestion = (suggestion: Suggestion) => {
    if (!tokenSpan) return;
    const next = draft.slice(0, tokenSpan.from) + suggestion.insert + draft.slice(tokenSpan.to);
    setDraft(next);
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
    setAttachments((prev) => [...prev, ...read]);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    onSend(text, attachments);
    setDraft("");
    setAttachments([]);
    setSuggestions([]);
    setRejected(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      label: selector.effort ? `생각 ${EFFORT_LABEL[selector.effort]}` : "생각 시간",
      title: "얼마나 오래 생각할지",
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
      title: "확인 방식",
      disabled: false,
      // 전부 맡기기 is 설정's to offer, not the composer's — see COMPOSER_MODES.
      // A mode already set to it still shows as this chip's label, so the
      // planner can read what they are on and step back down.
      options: COMPOSER_MODES.map((mode) => ({
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

  /**
   * Whether this conversation is running on anything other than the defaults
   * (PLAN D10).
   *
   * The three chips used to sit in the composer permanently, which put a model
   * picker in front of someone whose job is to describe a screen. They live in
   * 설정 now. What survives here is the honest half: when a conversation is NOT
   * on the defaults, say so and offer the way back — a planner who set 전부
   * 맡기기 last week should not have to guess why Claude stopped asking.
   */
  const offDefault =
    selector.model !== null ||
    selector.effort !== null ||
    selector.permissionMode !== DEFAULT_PERMISSION_MODE;
  // Which deviation to name, riskiest first: how much Claude may do without
  // asking matters more than which model is answering.
  const offDefaultLabel =
    selector.permissionMode !== DEFAULT_PERMISSION_MODE
      ? MODE_LABEL[selector.permissionMode]
      : modelRow && selector.model !== null
        ? modelWords(modelRow).label
        : selector.effort
          ? `생각 ${EFFORT_LABEL[selector.effort]}`
          : "기본값 아님";

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
        <div className="autocomplete" role="listbox">
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

      {(quote || brief) && (
        <div className="chips">
          {brief && (
            <span className="chip chip--brief" data-testid="brief-chip">
              <span className="chip__doc">기획서</span>
              {brief.title}
              <button
                type="button"
                aria-label="기획서 떼기"
                title="이 기획서를 참고하지 않고 보냅니다"
                className="chip__dismiss"
                onClick={() => onDismissBrief?.()}
              >
                ×
              </button>
            </span>
          )}
          {quote && (
            <span className="chip chip--quote" data-testid="quote-chip">
              <span className="chip__doc">인용</span>
              {quote.title}
              {quote.heading ? ` · ${quote.heading}` : ""}
              <button
                type="button"
                aria-label="인용 지우기"
                className="chip__dismiss"
                onClick={() => onDismissQuote?.()}
              >
                ×
              </button>
            </span>
          )}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="chips">
          {attachments.map((attachment, index) => (
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
                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={area}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        onChange={(e) => setDraft(e.target.value)}
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
        {offDefault && (
          <AdvancedChip
            label={offDefaultLabel}
            groups={chips}
            open={menu}
            onOpen={setMenu}
            onPick={pickChip}
          />
        )}

        <span className="toolbar__spacer" />

        <UsageChip plan={plan} usage={usage} />

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
            disabled={disabled || (!draft.trim() && attachments.length === 0)}
            onClick={submit}
            title={sendKey === "enter" ? "보내기 · Enter" : "보내기 · ⌘/Ctrl+Enter"}
          >
            <ArrowUpIcon size={15} />
          </button>
        )}
      </div>
    </footer>
  );
}
