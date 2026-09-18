import type {
  ContextUsage,
  DaemonStatus,
  EffortLevel,
  LostSend,
  PermissionMode,
  PlanUsage,
  SessionCommand,
  SessionSelectors,
} from "@colo-design/protocol";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Fold, useFoldNotice } from "../../components";
import type { PinAttachment, PinIntent } from "../../hooks/usePins";
import {
  EFFORT_LABEL,
  MODE_LABEL,
  MODE_MENU_HINT,
  modelOptions,
  modelRowOf,
  modelWords,
  SETTINGS_MODES,
} from "../../lib/chat-options";
import { composing } from "../../lib/ime";
import type { SendKey } from "../../lib/settings";
import {
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FileIcon,
  FolderIcon,
  GaugeIcon,
  GearIcon,
  PencilIcon,
  PlusIcon,
  ProviderIcon,
  ShieldOffIcon,
  ShieldPlainIcon,
  SparkIcon,
  StopIcon,
} from "../icons";
import { PinTray } from "../preview/PinTray";
import { Tip } from "../shell/Tip";
import { ContextRing } from "./ContextRing";
import { COMMAND_FALLBACK, COMMAND_LABEL, SelectorChip } from "./SelectorChip";
import { UsageChip } from "./UsageChip";

export interface Attachment {
  /** `image` rides as a vision block; `file` is inlined or staged by the daemon. */
  kind: "image" | "file";
  name: string;
  mediaType: string;
  /** base64, without the data-url prefix. */
  data: string;
  size: number;
}

/**
 * 툴바 칩 한 개의 재료 — SelectorChip 이 먹는 모양 그대로. 모델 칩만
 * 드릴다운(header·levelKey·alwaysSearch)을 입는다: 통합 메뉴의 프로바이더
 * 단계도 같은 SelectorChip 이 그린다.
 */
type Chip = {
  key: "model" | "effort" | "mode";
  label: string;
  icon: ReactNode;
  title: string;
  disabled: boolean;
  options: Array<{
    value: string | null;
    label: string;
    hint?: string;
    picked: boolean;
    disabled?: boolean;
  }>;
  header?: ReactNode;
  levelKey?: string;
  alwaysSearch?: boolean;
};

/**
 * 붙여넣은 그림의 긴 변 상한 — 비전 입력이 실질적으로 쓰는 한계(1568)에 맞춘다.
 * 수 MB 짜리 원본은 API 가 거절하고, 큰 base64 는 소켓 프레임과 대기열
 */
const PASTE_IMAGE_LONG_EDGE = 1568;

/** canvas 로 다시 인코드해도 의미가 보존되는 형식 — gif·svg 등은 건드리지 않는다. */
const RESIZABLE_IMAGE_TYPES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
};

/**
 * 첨부 한 건의 바이트 상한 — 대기열 저장소의 항목 예산(8MB)과 같은 값이다.
 * 그 너머의 파일은 첨부가 아니라 @ 멘션의 경로가 운반한다.
 */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image decode failed"));
    image.src = dataUrl;
  });
}

/**
 * 한 건을 첨부로 읽는다. 그림은 상한을 넘는 래스터를 같은 형식으로 줄이고,
 * 디코드·인코드가 안 되는 것(움짤·벡터·손상)은 원본 그대로 둔다 — 줄이기가
 * 그림을 바꿔버리는 쪽이 거절당하는 쪽보다 나쁘다. 그림이 아닌 파일은
 * 바이트 그대로다 — 데몬이 텍스트는 인라인으로, 나머지는 디스크로 나눈다.
 */
async function toAttachment(file: File): Promise<Attachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  const original: Attachment = {
    kind: file.type.startsWith("image/") ? "image" : "file",
    name: file.name || "pasted image",
    mediaType: file.type,
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    size: file.size,
  };
  if (!RESIZABLE_IMAGE_TYPES[file.type]) return original;
  try {
    const image = await decodeImage(dataUrl);
    const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
    if (!longEdge || longEdge <= PASTE_IMAGE_LONG_EDGE) return original;
    const scale = PASTE_IMAGE_LONG_EDGE / longEdge;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return original;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const encoded = canvas.toDataURL(file.type, 0.92);
    const data = encoded.slice(encoded.indexOf(",") + 1);
    return { ...original, data, size: Math.ceil(data.length * 0.75) };
  } catch {
    return original;
  }
}

/** The modes that act without asking — the ones the chip marks with a slash. */
const ASKS_NOTHING: PermissionMode[] = ["dontAsk", "bypassPermissions"];

/** What rode along with a lost send, as the row's small print — or null for words alone. */
function attachmentWords({ images, files }: { images: number; files: number }): string | null {
  const parts = [
    images > 0 ? `이미지 ${images}장` : null,
    files > 0 ? `파일 ${files}개` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The daemon's refusal sentence is Korean and carries the recovery — show it
 * rather than a second generic line; the fallback is
 * for a dead socket, which has no sentence.
 */
function failureWords(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? error.message
    : `${fallback} — 잠시 뒤 다시 시도해 주세요`;
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
 * plus the span to replace when one is chosen.
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

/** localStorage keys: a closed or crashed window no longer eats
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
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is string => typeof row === "string").slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

function saveHistory(rows: string[]): void {
  try {
    // localStorage, not sessionStorage: a reload must not take the walk back
    // through sent turns with it — the draft beside it already survives.
    localStorage.setItem(HISTORY_KEY, JSON.stringify(rows.slice(-HISTORY_MAX)));
  } catch {
    // Quota or private mode: losing the walk is tolerable, the draft is not.
  }
}

export function Composer({
  commands,
  disabled,
  disabledReason = null,
  draftKey,
  placeholder,
  usage,
  plans,
  onRefreshUsage,
  running,
  stopping = false,
  dropped = [],
  onTakeDropped,
  onDismissDropped,
  onDismissSuggestion,
  suggestion = null,
  tasks = [],
  onStopTask,
  registerAttach,
  sendKey,
  selector,
  onSetModel,
  onSetEffort,
  onSetPermissionMode,
  onSetMode,
  providers,
  onPickProvider,
  onOpenProviderSettings,
  onSend,
  onInterrupt,
  onFindFiles,
  pins = [],
  pinNumberStart = 1,
  focusPinId = null,
  onPinRemove,
  onPinNote,
  onPinFocus,
  onPinIntent,
  titleForScreen = () => null,
}: {
  disabled: boolean;
  /** 잠긴 이유 한 줄 — ChatColumn 이 연결 상태에서 읽어 내린다. 잠겨 있는데
      사유가 없으면 "지금은 보낼 수 없어요" 만 선다. */
  disabledReason?: string | null;
  /** Which conversation this field is the draft for; swapping keys swaps drafts. */
  draftKey: string;
  /** /command palette rows, straight from the CLI. */
  commands: SessionCommand[];
  placeholder: string;
  /** This thread's own context ring — the send row's budget, not the account's. */
  usage: ContextUsage | null;
  /**
   * Account-wide limits from the daemon, one reading per enabled provider —
   * the composer's own first. Shown even with no thread open; each reading
   * carries its account's resolved display name.
   */
  plans: Array<{ plan: PlanUsage; label: string | null }>;
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
   * 다음에 물어볼 만한 말 — 턴이 끝난 뒤 CLI 가 하나 예측한다.
   * 누르면 입력창에 들어가고, 계획자는 거기서 고쳐 보낸다. 자동으로 나가는
   * 말은 없다.
   */
  suggestion?: string | null;
  /** 칩을 썼거나 닫았다 — 어느 쪽이든 이 칩의 생은 거기서 끝난다. */
  onDismissSuggestion?: () => void;
  /** 지금 뒤에서 도는 작업들. */
  tasks?: Array<{ taskId: string; type: string; description: string }>;
  /** 그 작업 하나만 세운다 — 턴은 그대로 둔다. */
  onStopTask?: (taskId: string) => void;
  /**
   * Sends the room lost without delivering. They never reached the
   * transcript, so they stay above the field until restored or let go of.
   */
  dropped?: LostSend[];
  /**
   * 되살리기 on a lost send: the daemon hands the send back from its store,
   * bytes included when they survived the persist cap.
   */
  onTakeDropped?: (itemId: string) => Promise<{ text: string; attachments: Attachment[] } | null>;
  /** An undelivered send is restored into the field, or simply let go of. */
  onDismissDropped?: (itemId: string) => void;
  /** 대화 열 전체 드롭존이 컴포저의 첨부 손을 등록받는다. */
  registerAttach?: (fn: ((files: FileList | File[]) => void) | null) => void;
  /**
   * 모델·노력·권한 chips. Before a session exists these carry what the next
   * one will start with, so the planner can set the run up while the
   * workspace is still connecting.
   */
  selector: SessionSelectors;
  onSetModel: (model: string | null) => void;
  onSetEffort: (effort: EffortLevel | null) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
  /** The provider's own mode ids (ACP agents) — when `selector.modes` is set, the chip calls this instead. */
  onSetMode?: (mode: string) => void;
  /**
   * 통합 모델 메뉴의 프로바이더 단계 재료 — status.providers. 열려 있는 대화는
   * 태어난 프로바이더에 묶여 있으므로 이 재료는 세션이 없는 자리(다음 대화의
   * 준비 칩)에만 온다 — ChatColumn 이 그렇게만 건네준다. 한 개뿐인 목록은
   * 선택이 아니므로 그때는 메뉴의 ← 프로바이더 단계도 없다.
   */
  providers?: DaemonStatus["providers"];
  onPickProvider?: (id: string) => void;
  /**
   * 메뉴 헤더의 ⚙ — 설정의 프로바이더 방(설치·로그인·새 대화 목록)을 바로
   * 연다. 없으면 ⚙도 없다 — dev harness 가 건네지 않는 자리.
   */
  onOpenProviderSettings?: () => void;
  /** Which keypress sends; the other one inserts a newline. */
  sendKey: SendKey;
  /**
   * The pin attachments — the tray above the attachment chips
   * draws them. Optional: the dev harness renders the composer without pins.
   */
  pins?: PinAttachment[];
  /**
   * The first number the tray's rows wear: the badge order
   * counts the turn's grey ghosts first, so the tray must start after them —
   * one number, one pin, on every surface that wears numbers.
   */
  pinNumberStart?: number;
  /** 배지 클릭이 흔든 포커스 요청 — 그 핀 행의 메모 입력으로 간다. */
  focusPinId?: { id: string; nonce: number } | null;
  onPinRemove?: (id: string) => void;
  onPinNote?: (id: string, note: string) => void;
  /** 수정 ↔ 질문 칩 — the tray's toggle writes the pin's ask. */
  onPinIntent?: (id: string, intent: PinIntent) => void;
  onPinFocus?: (id: string) => void;
  /** 화면 id → 제목; PinTray 의 머리글과 행 표기가 읽는다. */
  titleForScreen?: (screen: string) => string | null;
  /** 문장과 첨부에 핀이 한 턴으로 합류한다. */
  onSend: (text: string, attachments: Attachment[], pins: PinAttachment[]) => void | Promise<void>;
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
  const rejected = useFoldNotice();
  /** 보내기·되돌리기 실패의 자리 — 첨부 안내(rejected)와 슬롯을 나눠 한 쪽이
      다른 쪽을 지우지 않게 한다. 새 입력·재시도·성공이 거둔다. */
  const sendError = useFoldNotice();
  /**
   * 상태 스트립의 접개 — 핀이 네 줄을 넘으면 접힌 채로 시작한다
   * (목록이 필드를 밑으로 누르지 않게). 머리 줄의 눈금이 한 번 눌리면
   * 그 선택이 자동 판정을 이긴다. null 은 아직 손이 안 닿았다는 말이다.
   */
  const [pinsFold, setPinsFold] = useState<boolean | null>(null);
  const pinsFolded = pinsFold ?? pins.length > 4;

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
    // The count rides along so a window that died mid-attach can
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
      rejected.show(`첨부 ${lostAttachments}개는 다시 붙여 주세요`);
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
    const accepted: File[] = [];
    const refused: string[] = [];
    for (const file of [...files]) {
      // 소켓 프레임과 대기열 저장소가 나눠 쓰는 건당 상한 — 그 너머의 파일은
      // 첨부가 아니라 경로로 가리키는 게 맞다(@ 멘션).
      if (file.size <= MAX_ATTACHMENT_BYTES) accepted.push(file);
      else refused.push(file.name);
    }
    if (refused.length > 0) {
      rejected.show(`${refused.join(", ")} — 8MB 를 넘는 파일은 붙일 수 없습니다.`);
    } else {
      rejected.clear();
    }
    if (accepted.length === 0) return;
    const read = await Promise.all(accepted.map((file) => toAttachment(file)));
    setEditor((prev) => ({
      text: prev.text,
      attachments: [...prev.attachments, ...read],
    }));
  };

  // 대화 열 전체 드롭존이 이 손을 빌린다 — 첨부의
  // 진실은 컴포저 한 곳에 있고, 드롭은 그 문을 넓힐 뿐이다.
  const attachFiles = useCallback(
    (files: FileList | File[]) => void readAttachments(files),
    // readAttachments 는 컴포넌트 스코프의 최신 클로저를 봐야 하므로 매 렌더
    // 갱신이 맞다 — 등록 쪽은 ref 로 받으므로 잦은 재등록 비용이 없다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rejected.show],
  );
  useEffect(() => {
    registerAttach?.(attachFiles);
    return () => registerAttach?.(null);
  }, [registerAttach, attachFiles]);

  // 보내기 진행 중 잠금: the field empties only
  // when the daemon accepts, so a second Enter while the first send is
  // still in flight would resend the same words — or, with no session yet,
  // open a second thread. The lock is the missing half of that rule; on failure it
  // opens again and the words are still there.
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);

  const submit = () => {
    if (sendingRef.current) return;
    const text = editor.text.trim();
    if (!text && editor.attachments.length === 0 && pins.length === 0) return;
    sendingRef.current = true;
    setSending(true);
    if (text) {
      // Consecutive duplicates collapse: retrying with Enter must not fill
      // the walk with a wall of identical rows.
      const rows = history.current;
      if (rows[rows.length - 1] !== text) rows.push(text);
      if (rows.length > HISTORY_MAX) rows.splice(0, rows.length - HISTORY_MAX);
      saveHistory(rows);
    }
    historyAt.current = null;
    // 재시도는 지난 실패 문구를 거둔다 — 새 시도가 낡은 사유와 함께 서지 않게.
    sendError.clear();
    // The field empties when the daemon has ACCEPTED the turn, not
    // when the button fired — a failed send leaves the words, attachments and
    // pins in place, with the reason in the warning strip. 핀의 비움은
    // 성공 뒤 markSent 의 몫이다.
    // 보내는 동안 탭이 바뀌면 필드는 이미 다른 대화의 초안이다 — 비우는
    // 것은 보낸 쪽의 초안만이다.
    const sentKey = draftKeyRef.current;
    // 보내기 시작 때의 필드 스냅샷 — 같은 초안의 성공 뒤 비움도 필드가 아직
    // 이 스냅샷 그대로일 때만이다. 보내는 동안 더 쓴 말·붙인 첨부는 살린다
    // (옆 초안의 규칙과 같다); 달라진 필드를 통째로 비워 날리던 결함.
    const sentEditor = editor;
    void Promise.resolve(onSend(text, editor.attachments, pins))
      .then(() => {
        if (draftKeyRef.current !== sentKey) {
          drafts.current.set(sentKey, EMPTY_EDITOR);
          saveDraft(sentKey, "");
          // sentKey 의 첨부 셈도 거둔다 — 남으면 그 대화를 다시 열 때
          // 사라진 첨부를 다시 붙이라는 거짓 알림이 선다.
          try {
            localStorage.removeItem(`${DRAFT_PREFIX}${sentKey}.attach`);
          } catch {
            // 비공개 모드 — 메모리 지도만 남는다.
          }
        }
        // 성공 뒤 비움은 한 규칙으로 담는다 — 지금 필드가 아직 보낸 스냅샷
        // 그대로면 비운다. 같은 자리에서의 성공이든, 새 작업실의 첫
        // 보내기(draftKey 가 new:* 에서 세션 id 로 바뀌고 자리 옮김 효과가
        // 보낸 말을 필드에 나른다)든 같다. 지도에서 새 키의 짝을 찾던 옛
        // 비움은 그 결함을 다시 만난다: 옮김이 setEditor 에 같은 객체를
        // 돌려 보내면 React 가 변화로 치지 않아 지도에 새 키의 흔적이
        // 아예 남지 않기 때문이다. 보낸 뒤 더 쓴 말·다른 대화의 초안은
        // 스냅샷과 달라 살린다.
        setEditor((prev) =>
          prev.text === sentEditor.text && prev.attachments === sentEditor.attachments
            ? EMPTY_EDITOR
            : prev,
        );
        setSuggestions([]);
        rejected.clear();
        sendError.clear();
      })
      .catch((e) => sendError.show(failureWords(e, "보내지 못했습니다")))
      .finally(() => {
        sendingRef.current = false;
        setSending(false);
      });
  };

  /** Caret parked at the end of the field, once React has written the new value. */
  const parkCaretAtEnd = () => {
    requestAnimationFrame(() => {
      const element = area.current;
      if (!element) return;
      const end = element.value.length;
      element.setSelectionRange(end, end);
    });
  };

  /** Swap the field's text for a recalled row, keeping the attachments, caret parked at the end. */
  const recall = (text: string) => {
    setEditor((prev) => ({ text, attachments: prev.attachments }));
    parkCaretAtEnd();
  };

  /**
   * 고쳐서 보내기 · 되살리기: a send comes back into the field ahead of
   * whatever is being drafted — both are the planner's words, so neither is
   * thrown away; a blank line keeps them apart for the edit.
   */
  const restore = (text: string, attachments: Attachment[]) => {
    historyAt.current = null;
    setEditor((prev) => ({
      text: prev.text.trim() ? `${text}\n\n${prev.text}` : text,
      attachments: [...attachments, ...prev.attachments],
    }));
    // 되살린 말은 새 입력이다 — 지난 보내기 실패 문구는 여기서 거둔다.
    sendError.clear();
    area.current?.focus();
    parkCaretAtEnd();
  };

  const takeDropped = (item: LostSend) => {
    if (!onTakeDropped) return;
    void onTakeDropped(item.id)
      .then((payload) => {
        if (!payload) return;
        restore(payload.text, payload.attachments);
        onDismissDropped?.(item.id);
      })
      .catch((e) => sendError.show(failureWords(e, "잃은 말을 되돌리지 못했습니다")));
  };

  const lostWords = (item: LostSend): string | null =>
    item.truncated ? "첨부는 다시 붙여야 합니다" : attachmentWords(item);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Composition keys pass straight through: Enter would send half a word
    // and the arrows would yank the IME's candidate list.
    if (composing(event)) return;
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
    // 도는 턴에는 보내기가 없다 — 중지가 끊는 손이고, 보내는 손은 턴이
    // 끝난 뒤에야 선다. Enter 는 그 사이 아무 일도 하지 않는다.
    if (running) return;
    submit();
  };

  // Chip labels come from the current row, so an aliased id still names the model.
  const modelRow = modelRowOf(selector.models, selector.model);
  // A model that ignores 노력 must not offer it; one whose row does not say
  // which levels it takes gets the full set.
  const effortLevels =
    modelRow?.supportedEffortLevels ?? (Object.keys(EFFORT_LABEL) as EffortLevel[]);
  const providerRows = providers ?? [];
  // 프로바이더 단계의 문이 열리는 조건 — 열린 대화는 태어난 프로바이더에
  // 묶여 있으므로 ChatColumn 이 세션이 없는 자리에만 providers 를 건네고,
  // 한 개뿐인 목록은 선택이 아니므로 둘 이상일 때만 단계가 온다.
  const canPickProvider = Boolean(providers && onPickProvider && providerRows.length > 1);
  const providerRow = providerRows.find((p) => p.id === selector.provider);
  const providerLabel = providerRow?.label ?? selector.provider ?? "프로바이더";
  // 통합 모델 메뉴의 단계 — 칩은 모델명을 입고, 메뉴 안 ← 로 프로바이더를
  // 고른다. 열림마다 모델 단계부터 (onToggle/onClose 에서 되돌린다).
  const [modelMenuLevel, setModelMenuLevel] = useState<"models" | "providers">("models");

  const chips: Chip[] = [
    {
      key: "model" as const,
      label: modelRow ? modelWords(modelRow).label : "모델 미선택",
      // The chip wears the connected provider's own mark — the spark reads as
      // Claude, so a Codex or omp thread must not wear it.
      icon: <ProviderIcon provider={selector.provider} size={13} />,
      title: "모델",
      // The list is the CLI's, and only a session (or an earlier one, cached)
      // can supply it. An empty list no longer shuts the chip: the 프로바이더
      // 단계는 살아 있어야 처음 프로바이더를 고를 수 있다 — the model slot is
      // the seeder's job (useSessions), not an 자동 row to pick back.
      disabled: selector.models.length === 0 && !canPickProvider,
      // 드릴다운 헤더: 모델 단계는 › 프로바이더(전환), 프로바이더 단계는
      // ← 모델. ⚙ 설정은 두 단계 모두에 선다 — 못 쓰는 프로바이더의 이유를
      // 읽는 자리가 곧 설정으로 가야 할 자리다. 헤더는 열려 있을 때만 그린다.
      header: (
        <div className="selector__headrow">
          {modelMenuLevel === "providers" ? (
            <button
              type="button"
              className="selector__back"
              onClick={() => setModelMenuLevel("models")}
            >
              <ChevronLeftIcon size={12} />
              모델
            </button>
          ) : canPickProvider ? (
            <button
              type="button"
              className="selector__drill"
              onClick={() => setModelMenuLevel("providers")}
              title="프로바이더 바꾸기"
            >
              <span className="selector__drillname">프로바이더</span>
              <span className="selector__drillval">{providerLabel}</span>
              <ChevronRightIcon size={12} />
            </button>
          ) : (
            <span className="selector__headtitle">{providerLabel}</span>
          )}
          {onOpenProviderSettings && (
            <button
              type="button"
              className="selector__gear"
              aria-label="프로바이더 설정"
              title="프로바이더 설정"
              onClick={() => {
                setMenu(null);
                setModelMenuLevel("models");
                onOpenProviderSettings();
              }}
            >
              <GearIcon size={13} />
            </button>
          )}
        </div>
      ),
      alwaysSearch: modelMenuLevel === "models",
      options:
        modelMenuLevel === "providers" && canPickProvider
          ? providerRows.map((p) => ({
              value: p.id,
              label: p.label,
              icon: <ProviderIcon provider={p.id} size={13} />,
              // 못 고르는 이유는 잘리는 한 줄이 아니라 행 아래 두 번째 줄로 —
              // "설치한…" 처럼 끊긴 말은 고르는 데 아무 도움이 안 된다.
              ...(p.available ? {} : { desc: p.reason ?? "이 기기에 없습니다." }),
              picked: p.id === selector.provider,
              disabled: !p.available,
            }))
          : modelOptions(selector.models, modelRow).map(({ value, label, hint, picked }) => ({
              value,
              label,
              // 공급자까지 붙은 id — omp 목록은 표시 이름이 겹치는 행을 구별하는
              // 유일한 단서다. 다른 칩의 행엔 없는 선택 사항.
              ...(hint ? { hint } : {}),
              picked,
            })),
    },
    {
      key: "effort" as const,
      label: selector.effort ? EFFORT_LABEL[selector.effort] : "생각 미선택",
      icon: <GaugeIcon />,
      title: "생각 시간",
      disabled: modelRow ? !modelRow.supportsEffort : false,
      options: effortLevels.map((level) => ({
        value: level,
        label: EFFORT_LABEL[level],
        picked: selector.effort === level,
      })),
    },
    {
      key: "mode" as const,
      // The provider's own mode rows (ACP agents) replace the Claude enum —
      // the chip lists what the driver actually offers.
      label: selector.modes
        ? (selector.modes.find((m) => m.id === (selector.mode ?? selector.permissionMode))?.label ??
          selector.mode ??
          selector.permissionMode)
        : MODE_LABEL[selector.permissionMode],
      // The one chip whose glyph says something the label does not: a struck
      // shield is a mode that asks nothing before it acts. A provider's own
      // rows carry the descriptor's tier; the Claude enum reads its list.
      icon: (() => {
        const row = selector.modes?.find(
          (m) => m.id === (selector.mode ?? selector.permissionMode),
        );
        const asksNothing = row
          ? row.tier === "dangerous"
          : ASKS_NOTHING.includes(selector.permissionMode);
        return asksNothing ? <ShieldOffIcon /> : <ShieldPlainIcon />;
      })(),
      title: "확인 방식",
      disabled: false,
      // A mode already set to Bypass still shows as this chip's label, so the
      // planner can read what they are on and step back down.
      options: selector.modes
        ? selector.modes.map((m) => ({
            value: m.id,
            label: m.label,
            picked: (selector.mode ?? selector.permissionMode) === m.id,
          }))
        : SETTINGS_MODES.map((mode) => ({
            value: mode,
            label: MODE_LABEL[mode],
            hint: MODE_MENU_HINT[mode],
            picked: selector.permissionMode === mode,
          })),
    },
  ];

  const pickChip = (key: "model" | "effort" | "mode", value: string | null) => {
    if (key === "model") onSetModel(value);
    else if (key === "effort") onSetEffort((value as EffortLevel | null) ?? null);
    else if (value && selector.modes && onSetMode) onSetMode(value);
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
      {/* The plan chip floats just off the input card's top-left corner —
          out of the toolbar below, where it crowded the send controls. A
          reading about the account, parked where the eye already sits. The
          conversation's own length is not an account reading: it rides the
          send row, beside the button it is a reason to press or not. */}
      <div className="composer__usage">
        <UsageChip plans={plans} onRefresh={onRefreshUsage} />
      </div>

      {/* 상태 밴드 — 카드 밖의 한 열. 대기·핀·작업·제안이 살아 있을 때만
          존재하고, 비면 아무것도 남지 않는 것이 이 층의 조용함이다. */}
      <div className="composer__status">
        {rejected.text && (
          <Fold closing={rejected.closing} onCollapsed={rejected.clear}>
            <div className="notice notice--warn">
              <span className="notice__text">{rejected.text}</span>
              <button
                type="button"
                className="notice__close"
                aria-label="첨부 안내 닫기"
                disabled={rejected.closing}
                onClick={rejected.close}
              >
                ×
              </button>
            </div>
          </Fold>
        )}
        {/* 보내기·되돌리기 실패는 첨부 안내와 다른 슬롯 — 한 쪽의 닫기·
            새 소식이 다른 쪽을 지우지 않는다(실사 결함: 첨부가 전송 실패
            문구를 지웠다). */}
        {sendError.text && (
          <Fold closing={sendError.closing} onCollapsed={sendError.clear}>
            <div className="notice notice--error">
              <span className="notice__text">{sendError.text}</span>
              <button
                type="button"
                className="notice__close"
                aria-label="오류 닫기"
                disabled={sendError.closing}
                onClick={sendError.close}
              >
                ×
              </button>
            </div>
          </Fold>
        )}
        {pins.length > 0 && (
          // 메모 입력의 Enter 는 전송이 아니라 본문으로 — capture 에서 입력창을
          // 데려 오고, 행의 onKeyDown 이 메모를 저장한 뒤 이벤트를 삼킨다.
          <div
            onKeyDownCapture={(event) => {
              if (composing(event)) return;
              if (event.key !== "Enter") return;
              if (!(event.target as HTMLElement).matches("input.pintray__note")) return;
              event.preventDefault();
              area.current?.focus();
            }}
          >
            <PinTray
              pins={pins}
              numberStart={pinNumberStart}
              focusPinId={focusPinId}
              onPinRemove={(id) => onPinRemove?.(id)}
              onPinNote={(id, note) => onPinNote?.(id, note)}
              onPinIntent={(id, intent) => onPinIntent?.(id, intent)}
              onPinFocus={(id) => onPinFocus?.(id)}
              titleFor={titleForScreen}
              fold={{ folded: pinsFolded, onToggle: () => setPinsFold(!pinsFolded) }}
            />
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
                  <span className="chip__thumb chip__thumb--file">
                    <FileIcon />
                  </span>
                )}
                {attachment.name}
                <Tip label={`${attachment.name} 첨부 취소`}>
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
                </Tip>
              </span>
            ))}
          </div>
        )}
        {/* 뒤에서 도는 작업: 턴이 끝나도 남아 있을 수 있으니 대기
          줄과 따로 산다. 각 줄의 버튼은 그 작업 하나만 세운다 — 중지 버튼은
          턴의 것이고 이것은 작업의 것이다. */}
        {tasks.length > 0 && (
          <div className="composer__tasks" role="status">
            <div className="queued__head">뒤에서 도는 작업 {tasks.length}건</div>
            <ul className="queued__list">
              {tasks.map((task) => (
                <li key={task.taskId} className="queued__row">
                  <span className="queued__text" title={task.description}>
                    {task.description || task.type}
                  </span>
                  {onStopTask && (
                    <Tip label="이 작업만 세웁니다 — 대화는 그대로 이어집니다">
                      <button
                        type="button"
                        className="ghost queued__action"
                        aria-label="이 작업만 중지"
                        onClick={() => onStopTask(task.taskId)}
                      >
                        <CloseIcon />
                      </button>
                    </Tip>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* The room's losses: sends the dead query never delivered. Never in the
          transcript, so they wait here — the words come back for a resend,
          the attachments must be picked again. */}
        {dropped.length > 0 && (
          <div className="composer__lost" role="alert">
            <div className="queued__head">
              전달되지 못한 말 {dropped.length}건 — 되살려 다시 보내 주세요
            </div>
            <ul className="queued__list">
              {dropped.map((item) => (
                <li key={item.id} className="queued__row">
                  <span className="queued__text" title={item.text}>
                    {item.text || "(첨부만)"}
                  </span>
                  {lostWords(item) && (
                    <span className="queued__meta">
                      <FileIcon size={11} /> {lostWords(item)}
                    </span>
                  )}
                  <Tip label="첨부까지 되돌려 집어넣습니다">
                    <button
                      type="button"
                      className="ghost queued__action"
                      aria-label="되살리기"
                      disabled={disabled}
                      onClick={() => takeDropped(item)}
                    >
                      <PencilIcon />
                    </button>
                  </Tip>
                  <Tip label="이 말을 지웁니다">
                    <button
                      type="button"
                      className="ghost queued__action"
                      aria-label="지우기"
                      onClick={() => onDismissDropped?.(item.id)}
                    >
                      <CloseIcon />
                    </button>
                  </Tip>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 다음 칩: 답이 끝난 자리에서 CLI 가 예측한 한 문장. 누르면
          입력창으로 들어갈 뿐 — 보내는 것은 언제나 사람이다. 쓰던 말이 있으면
          칩은 비켜선다(그 자리의 주인은 계획자의 문장이다). */}
        {suggestion && !running && !editor.text.trim() && (
          <div className="composer__next">
            <Tip label="이 말을 입력창에 넣습니다">
              <button
                type="button"
                className="composer__nextchip"
                disabled={disabled}
                onClick={() => {
                  restore(suggestion, []);
                  onDismissSuggestion?.();
                }}
              >
                <SparkIcon size={12} />
                {`다음: ${suggestion}`}
              </button>
            </Tip>
            <Tip label="제안 닫기">
              <button
                type="button"
                className="ghost composer__nextclose"
                aria-label="제안 닫기"
                onClick={() => onDismissSuggestion?.()}
              >
                <CloseIcon />
              </button>
            </Tip>
          </div>
        )}
      </div>

      {/* 입력 카드 — 컴포저의 유일한 카드. 말과 보내는 손만 산다.
          자동완성은 필드의 손위에 뜬다 — @ 를 친 곳에서 가까운 쪽이 답이다. */}
      <div className="composer__field">
        {suggestions.length > 0 && (
          <div className="autocomplete" role="listbox" id="composer-suggestions" ref={palette}>
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion.insert}
                id={`composer-suggestion-${index}`}
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
        <textarea
          ref={area}
          value={editor.text}
          placeholder={
            editor.attachments.length > 0
              ? "그림을 붙였습니다 — 어떻게 쓸지 한마디만 적어 주세요"
              : placeholder
          }
          aria-label="메시지"
          /* @/… 자동완성의 콤보박스 선언 — 목록은 위의 listbox, 하이라이트는
           activedescendant 가 가리킨다(팔레트·RepoPicker 와 같은 패턴). */
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={suggestions.length > 0}
          aria-controls={suggestions.length > 0 ? "composer-suggestions" : undefined}
          aria-activedescendant={
            suggestions.length > 0 ? `composer-suggestion-${highlight}` : undefined
          }
          disabled={disabled}
          rows={1}
          onChange={(e) => {
            // Typing is a decision: whatever row the walk sat on, these are
            // the planner's own words now.
            historyAt.current = null;
            // 새 입력이 시작되면 지난 보내기 실패 문구는 낡은 소식이다.
            sendError.clear();
            const text = e.target.value;
            setEditor((prev) => ({ text, attachments: prev.attachments }));
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) void readAttachments(files);
          }}
          onKeyDown={onKeyDown}
        />

        <div className="composer__sendrow">
          {running && (
            <Tip label={stopping ? "정리 중…" : "중지"}>
              <button
                type="button"
                className="toolbar__stop"
                aria-label={stopping ? "정리 중…" : "중지"}
                disabled={stopping}
                onClick={onInterrupt}
              >
                <StopIcon size={11} />
                {stopping ? "정리 중…" : null}
              </button>
            </Tip>
          )}
          {/* 도는 동안 보내는 손은 물러난다 — 중지만 남는다. 보내기는
            턴이 끝난 뒤에야 선다. */}
          {!running && (
            <button
              disabled={
                disabled ||
                sending ||
                (!editor.text.trim() && editor.attachments.length === 0 && pins.length === 0)
              }
              className="composer__send"
              aria-label="보내기"
              onClick={submit}
            >
              <ArrowUpIcon size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="toolbar">
        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void readAttachments(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="toolbar__attach"
          aria-label="첨부"
          disabled={disabled}
          onClick={() => filePicker.current?.click()}
        >
          <PlusIcon size={14} />
        </button>
        {chips.map((chip) => (
          <SelectorChip
            key={chip.key}
            label={chip.label}
            icon={chip.icon}
            tip={chip.title}
            disabled={chip.disabled}
            open={menu === chip.key}
            onToggle={() => {
              // 모델 메뉴는 닫힘마다 모델 단계로 되돌린다 — 다음 열림은
              // 늘 모델 목록부터 (Paseo의 모델 메뉴와 같은 걸음).
              if (chip.key === "model") setModelMenuLevel("models");
              setMenu(menu === chip.key ? null : chip.key);
            }}
            onClose={() => {
              if (chip.key === "model") setModelMenuLevel("models");
              setMenu(null);
            }}
            onPick={(value) => {
              // 프로바이더 단계의 고름은 메뉴를 닫지 않는다 — 고른 프로바이더의
              // 모델 목록이 이어서 보여야 고르기가 끊기지 않는다. 행은 언제
              // 이름이 있다 — null 은 모델 해제의 말이라 이 단계엔 없다.
              if (chip.key === "model" && modelMenuLevel === "providers") {
                if (value) {
                  onPickProvider?.(value);
                  setModelMenuLevel("models");
                }
                return;
              }
              pickChip(chip.key, value);
              setMenu(null);
            }}
            options={chip.options}
            header={chip.header}
            levelKey={chip.levelKey}
            alwaysSearch={chip.alwaysSearch}
          />
        ))}
        <div className="toolbar__end">
          <ContextRing usage={usage} />
          {/* 상태가 말할 것이 있을 때만 스트립 끝에 선다 — 도는 동안엔
              보내기가 물러난 이유를, 잠긴 동안엔 disabled 가 말하지 않는
              잠긴 이유를 이 줄이 말한다. */}
          {(disabled || running) && (
            <p className="composer__hint">
              {disabled
                ? `지금은 보낼 수 없어요${disabledReason ? ` — ${disabledReason}` : ""}`
                : "답변이 끝나면 보낼 수 있어요"}
            </p>
          )}
        </div>
      </div>
    </footer>
  );
}
