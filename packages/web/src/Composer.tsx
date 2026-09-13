import type {
  ContextUsage,
  EffortLevel,
  PermissionMode,
  PlanUsage,
  SessionCommand,
  SessionSelectors,
} from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import {
  EFFORT_HINT,
  EFFORT_LABEL,
  MODE_HINT,
  MODE_LABEL,
  modelOptions,
  modelRowOf,
  modelWords,
  SETTINGS_MODES,
} from "./chat-options";
import { ArrowUpIcon, FileIcon, FolderIcon, PaperclipIcon, StopIcon } from "./icons";
import { COMMAND_FALLBACK, COMMAND_LABEL, SelectorChip } from "./SelectorChip";
import type { SendKey } from "./settings";
import { UsageChip } from "./UsageChip";

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
const DRAFT_PREFIX = "colo-design.draft.";
const HISTORY_KEY = "colo-design.history";
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
  stopping = false,
  queued = 0,
  seed,
  sendKey,
  selector,
  planArmed = false,
  onTogglePlanArmed,
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
   * 중지를 누른 뒤 턴이 실제로 멈추기까지의 짧은 창 — 클릭이 무시된 것처럼
   * 보이지 않게 버튼이 "정리 중…" 이 된다 (실사 결함).
   */
  stopping?: boolean;
  /**
   * 다음 턴에 밀려 있는 건수 (PLAN D86). Running 중 보낸 send 가 세어 있고,
   * 턴이 끝나면 0 — the one-line `다음 턴에 보냅니다` above the field.
   */
  queued?: number;
  /**
   * 고쳐서 다시 보내기 (PLAN D95): the planner's own words re-enter the
   * field for an edit. The nonce re-applies the same text on repeat clicks.
   */
  seed?: { text: string; nonce: number };
  /**
   * 모델·노력·권한 chips. Before a session exists these carry what the next
   * one will start with, so the planner can set the run up while the
   * workspace is still connecting.
   */
  selector: SessionSelectors;
  /**
   * 계획 먼저 (이번 턴 한정): armed 인 채 보내면 그 턴만 계획 자세로
   * 들어간다 — 첫 답변이 '만들 것' 카드로 오고 승인 후 착수한다. 대화의
   * 권한 선택이 이미 계획이면 칩은 의미가 없다(늘 계획이므로).
   */
  planArmed?: boolean;
  onTogglePlanArmed?: () => void;
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
  const [tokenSpan, setTokenSpan] = useState<{
    from: number;
    to: number;
  } | null>(null);
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
      localStorage.setItem(
        `${DRAFT_PREFIX}${draftKeyRef.current}.attach`,
        String(editor.attachments.length),
      );
    } catch {
      // Same story as the words: private mode keeps the in-memory map only.
    }
  }, [editor]);

  // 되감기의 씨앗 (PLAN D95): every click re-writes the field — the planner
  // edits there and sends by the usual key.
  const seedNonce = useRef(-1);
  useEffect(() => {
    if (!seed || seed.nonce === seedNonce.current) return;
    seedNonce.current = seed.nonce;
    if (seed.text.trim() === "") return;
    setEditor((prev) => ({ text: seed.text, attachments: prev.attachments }));
    area.current?.focus();
  }, [seed]);

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
              label: known
                ? known.label
                : `/${entry.name}${entry.argumentHint ? ` ${entry.argumentHint}` : ""}`,
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
    const next =
      editor.text.slice(0, tokenSpan.from) + suggestion.insert + editor.text.slice(tokenSpan.to);
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
    const accepted: Array<{
      file: File;
      kind: Attachment["kind"];
      mediaType: string;
    }> = [];
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
    setEditor((prev) => ({
      text: prev.text,
      attachments: [...prev.attachments, ...read],
    }));
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
    // ⌥Enter (PLAN D86): 끊고 보내기 — interrupt the running turn, then send
    // what was typed. The plain send paths are untouched.
    if (event.altKey) {
      event.preventDefault();
      if (running) onInterrupt();
      submit();
      return;
    }
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
      title: "확인 방식 — 화면 파일 편집은 자동으로 적용되고, 명령 실행만 물어봅니다",
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
      {/* The spend chip floats just off the input card's top-left corner —
          out of the toolbar below, where it crowded the send controls. A
          reading about the account, parked where the eye already sits. */}
      <div className="composer__usage">
        <UsageChip plan={plan} usage={usage} onRefresh={onRefreshUsage} />
      </div>
      {suggestions.length > 0 && (
        <div className="autocomplete" role="listbox" ref={palette}>
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.insert}
              type="button"
              role="option"
              aria-selected={index === highlight}
              className={
                index === highlight
                  ? "autocomplete__row autocomplete__row--on"
                  : "autocomplete__row"
              }
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
            // biome-ignore lint/suspicious/noArrayIndexKey: 같은 이름의 첨부가 둘일 수 있어 index 로만 식별한다 — 목록은 뒤에만 붙는다.
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

      {/* 대기 줄 (PLAN D86): what a mid-turn send means — one line above the
          field, gone the moment the turn settles. */}
      {running && queued > 0 && (
        <div className="composer__queued" role="status">
          다음 턴에 보냅니다 · {queued}건 대기
        </div>
      )}

      <textarea
        ref={area}
        value={editor.text}
        placeholder={placeholder}
        aria-label="메시지"
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
        {selector.permissionMode !== "plan" && onTogglePlanArmed && !running && (
          <button
            type="button"
            className={planArmed ? "toolbar__plan toolbar__plan--armed" : "toolbar__plan"}
            aria-pressed={planArmed}
            title={
              planArmed
                ? "이번 답변은 먼저 만들 것을 승인받고 시작합니다 — 다시 누르면 그대로 보냅니다"
                : "이번 답변만 먼저 무엇을 만들지 승인받고 시작합니다"
            }
            disabled={disabled}
            onClick={onTogglePlanArmed}
          >
            계획 먼저
          </button>
        )}
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
          {running ? (
            <button
              type="button"
              className="toolbar__stop"
              aria-label={stopping ? "정리 중…" : "중지"}
              title={stopping ? "정리 중…" : "중지"}
              disabled={stopping}
              onClick={onInterrupt}
            >
              <StopIcon size={11} />
              {stopping ? "정리 중…" : null}
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
