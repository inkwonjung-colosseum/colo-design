import type {
  ContextUsage,
  DaemonStatus,
  EffortLevel,
  LostSend,
  PlanUsage,
  QueuedSend,
  SessionCommand,
  SessionSelectors,
} from "@colo-design/protocol";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Fold, useFoldNotice } from "../../components";
import type { PinAttachment } from "../../hooks/usePins";
import { EFFORT_HINT, EFFORT_LABEL, modelOptions, modelRowOf } from "../../lib/chat-options";
import { composing } from "../../lib/ime";
import { isInviteFile, offerInviteFile } from "../../lib/invite-bus";
import type { SendKey } from "../../lib/settings";
import {
  ArrowUpIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  FileIcon,
  FolderIcon,
  GearIcon,
  PencilIcon,
  PlusIcon,
  ProviderIcon,
  SparkIcon,
  StopIcon,
} from "../icons";
import { PinTray } from "../preview/PinTray";
import { StateBanner } from "../StateBanner";
import { Tip } from "../shell/Tip";
import { COMMAND_FALLBACK, COMMAND_LABEL } from "./command-names";

/**
 * 슬래시 목록이 없는 세계의 빈 목록 — **모듈 상수**여야 한다. 렌더마다 새
 * `[]` 를 만들면 그것을 dep 으로 읽는 토큰 효과가 매 렌더 다시 돌고,
 * 그 효과가 setState 를 하므로 렌더가 끝나지 않는다(실측: 컴포저가 통째로
 * 죽었다).
 */
const NO_COMMANDS: SessionCommand[] = [];

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
/**
 * 가득 참의 문턱(결함 5) — 링이 물러난 지금(B2) 이 문장이 창의 붉은 톤을
 * 대신 읽는다. 85%: 한 턴을 더 쌓으면 창의 첫머리가 요약으로 눌릴 수 있는
 * 지점부터 새 대화의 길을 알려 준다.
 */
const CONTEXT_FULL_PCT = 85;

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
  queue = [],
  onRemoveQueued,
  onSendQueuedNow,
  dropped = [],
  onTakeDropped,
  onDismissDropped,
  onDismissSuggestion,
  suggestion = null,
  tasks = [],
  onStopTask,
  registerAttach,
  registerResend,
  dev = false,
  sendKey,
  selector,
  onSetModel,
  onSetEffort,
  providers,
  onPickProvider,
  nextProvider,
  providerLocked = false,
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
  /** This thread's own context reading — the send row's budget, not the account's. */
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
   * 다음 턴에 보낼 말들 — 데몬의 대기 줄, 오래된 것부터. 도는 턴에 온 말은
   * 기록에 들어간 적이 없으므로(에코는 전달 순간에 온다) 입력창 위의 이
   * 목록이 그 말들의 유일한 자리다.
   */
  queue?: QueuedSend[];
  /** 고쳐서 보내기 — 기다리는 말 하나를 통째로 입력창에 되돌린다. */
  onRemoveQueued?: (itemId: string) => Promise<{
    text: string;
    attachments: Attachment[];
    pins?: Array<{ screen: string }>;
  } | null>;
  /** 지금 보내기 — 도는 턴을 끊고 이 말을 먼저 보낼다. */
  onSendQueuedNow?: (itemId: string) => Promise<void>;
  /**
   * Sends the room lost without delivering. They never reached the
   * transcript, so they stay above the field until restored or let go of.
   */
  dropped?: LostSend[];
  /**
   * 되살리기 on a lost send: the daemon hands the send back from its store,
   * bytes included when they survived the persist cap.
   */
  onTakeDropped?: (itemId: string) => Promise<{
    text: string;
    attachments: Attachment[];
    pins?: Array<{ screen: string }>;
  } | null>;
  /** An undelivered send is restored into the field, or simply let go of. */
  onDismissDropped?: (itemId: string) => void;
  /** 대화 열 전체 드롭존이 컴포저의 첨부 손을 등록받는다. */
  registerAttach?: (fn: ((files: FileList | File[]) => void) | null) => void;
  /** 테이프의 `고쳐서 다시 보내기`(요청 버블·중단 카드)가 컴포저의
      restore 손을 등록받는다 — 말의 진실은 컴포저 한 곳에 있다. */
  registerResend?: (fn: ((text: string) => void) | null) => void;
  /**
   * 개발 실행인가(`DaemonStatus.dev`) — `/` 슬래시 자동완성은 여기서만 선다.
   * `import.meta.env.DEV` 로 대신할 수 없다: 패키징된 Electron 의 웹 번들은
   * production 빌드라 그 값이 언제나 false 다(P0-2 의 논거).
   */
  dev?: boolean;
  /**
   * 모델·노력·권한 chips. Before a session exists these carry what the next
   * one will start with, so the planner can set the run up while the
   * workspace is still connecting.
   */
  selector: SessionSelectors;
  onSetModel: (model: string | null) => void;
  onSetEffort: (effort: EffortLevel | null) => void;
  /**
   * 통합 모델 메뉴의 프로바이더 단계 재료 — status.providers. 열려 있는
   * 대화에서도 온다: 뿌리 카드의 프로바이더 행은 언제나 서야 누가(프로바이더)
   * 돌지 열어 보기 전에 안다. 고름이 스레드를 바꾸지는 않는다 — 그 말은
   * `providerLocked` 와 단계의 노트가 한다.
   */
  providers?: DaemonStatus["providers"];
  onPickProvider?: (id: string) => void;
  /**
   * 다음 새 대화가 어느 프로바이더로 시작할지 — 설정의 고름(`pickProvider`가
   * 쓴 값). 프로바이더 행의 값과 단계의 표식이 이 쪽을 읽는다: 열린 대화는
   * `selector.provider`(태어난 프로바이더)를 유지하므로, 행이 그쪽을 읽으면
   * 고른 뒤에도 아무 변화가 없는 것처럼 보인다. 건네지지 않은 자리(하네스)는
   * 지금 선택자의 프로바이더로 그 자리를 임대한다.
   */
  nextProvider?: string;
  /**
   * 열린 대화가 있는지 — 스레드는 태어난 프로바이더에 묶이므로, 이 깃발이
   * 서면 프로바이더 단계는 고름의 범위(다음 새 대화)를 한 줄로 말하고,
   * 고른 뒤 모델 단계로 옮겨 다니지 않는다(그 목록은 열린 대화의 것).
   */
  providerLocked?: boolean;
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
  onPinFocus?: (id: string) => void;
  /** 화면 id → 제목; PinTray 의 머리글과 행 표기가 읽는다. */
  titleForScreen?: (screen: string) => string | null;
  /** 문장과 첨부에 핀이 한 턴으로 합류한다. */
  /**
   * `screens` 는 트레이의 핀이 아닌 화면 입력이다 — 방에서 꺼낸(고쳐서
   * 보내기) · 되살린 말이 가리키던 화면들. 핀과 달리 그릴도 요소도 없고
   * 화면 확인 게이트의 입력으로만 산다(감사 C4).
   */
  onSend: (
    text: string,
    attachments: Attachment[],
    pins: PinAttachment[],
    screens?: Array<{ screen: string }>,
  ) => void | Promise<void>;
  onInterrupt: () => void;
  onFindFiles: (query: string) => Promise<string[]>;
}) {
  const [editor, setEditor] = useState<Editor>(() => ({
    text: storedDraft(draftKey),
    attachments: [],
  }));
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [tokenSpan, setTokenSpan] = useState<{
    from: number;
    to: number;
  } | null>(null);
  /** Bumped when a pick moves the caret, so the token is read after the move. */
  const [caretTick, setCaretTick] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const palette = useRef<HTMLDivElement>(null);
  /**
   * The live CLI's list, or the built-in stand-in while there is none.
   *
   * P3-4: 실사용 앱에서는 비어 있다. `/` 자동완성은 CLI 의 슬래시 명령을 그대로
   * 옮긴 것이고, 그 목록은 이 도구의 어휘가 아니라 터미널의 어휘다 —
   * `/compact` · `/context` 는 비개발자가 고를 자리가 아니며, 고르면 무슨 일이
   * 일어나는지도 화면 어디에도 없다. 개발 실행(`DaemonStatus.dev`)에서만 선다.
   * ⌘K 팔레트는 그대로다 — 대화·프로젝트 전환은 사용자에게 쓸모가 있다.
   */
  const knownCommands = dev ? (commands.length > 0 ? commands : COMMAND_FALLBACK) : NO_COMMANDS;
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

  // 결함 5(실사 2026-09-20): 이 대화의 컨텍스트 읽기가 문턱을 넘으면 입력창
  // 위에 새 대화의 길을 한 줄로 알려 준다. 보내기는 막지 않는다 — 막힌
  // 보내기가 늦은 안내보다 나쁘고, 이 대화가 최선일 수도 있다.
  const contextFull = usage !== null && Math.round(usage.percentage) >= CONTEXT_FULL_PCT;

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
      // 초대 파일은 첨부가 아니라 가져오기다 — 통로(invite-bus)로 넘겨 창에
      // 열린다. 끌어다 놓기 · 붙여넣기 · 첨부 버튼이 모두 이 한 곳을 지난다.
      if (isInviteFile(file)) {
        offerInviteFile(file);
        continue;
      }
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
  /**
   * 방에서 꺼낸 · 되살린 말이 가리키던 화면들 — 다음 보내기에 실려 나간다.
   * 트레이의 핀과 섞지 않는다: 그쪽은 그림·요소를 든 핀이고, 이것은
   * 게이트가 다시 열어 볼 주소만이다.
   */
  const restoredPins = useRef<Array<{ screen: string }> | null>(null);

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
    // 방에서 돌아온 말의 화면들 — 이 보내기와 함께 나가고 거기서 소모된다.
    const sentScreens = restoredPins.current;
    restoredPins.current = null;
    void Promise.resolve(onSend(text, editor.attachments, pins, sentScreens ?? undefined))
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
  const restore = (text: string, attachments: Attachment[], pins?: Array<{ screen: string }>) => {
    historyAt.current = null;
    setEditor((prev) => ({
      text: prev.text.trim() ? `${text}\n\n${prev.text}` : text,
      attachments: [...attachments, ...prev.attachments],
    }));
    // 그 말이 가리킨 화면은 화면 확인 게이트의 입력이다 — 글자만 돌려주고
    // 핀을 버리면 다시 보낸 턴은 아무도 검증하지 않은 채 끝난다(감사 C4).
    if (pins?.length) restoredPins.current = pins;
    // 되살린 말은 새 입력이다 — 지난 보내기 실패 문구는 여기서 거둔다.
    sendError.clear();
    area.current?.focus();
    parkCaretAtEnd();
  };

  /** 테이프의 고쳐서 다시 보내기가 빌리는 손 — 말의 복귀는 restore 한 곳이다. */
  const resend = useCallback(
    (text: string) => restore(text, []),
    // restore 는 컴포넌트 스코프의 최신 클로저를 봐야 하므로 매 렌더 갱신이
    // 맞다 — 등록 쪽은 ref 로 받으므로 잦은 재등록 비용이 없다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    registerResend?.(resend);
    return () => registerResend?.(null);
  }, [registerResend, resend]);

  /**
   * 잃은 말의 자동 복귀 (PLAN L12) — 버튼 없이, 입력창이 비어 있을 때 가장
   * 최근 것을 골라 돌려놓는다. 이미 시도한 것은 다시 건드리지 않는다(빈 손의
   * takeDropped 가 같은 말을 반복하지 않게). 칸이 비어 있지 않으면 기다린다 —
   * effect 가 입력 바뀔 때마다 다시 본다.
   */
  const droppedTried = useRef(new Set<string>());
  const takeDropped = (item: LostSend) => {
    if (!onTakeDropped) return;
    droppedTried.current.add(item.id);
    void onTakeDropped(item.id)
      .then((payload) => {
        if (!payload) return;
        restore(payload.text, payload.attachments, payload.pins);
        rejected.show("보내지 못한 말을 입력창에 돌려 두었어요");
        onDismissDropped?.(item.id);
      })
      .catch(() => undefined);
  };
  const droppedWaiting =
    dropped.length > 0 &&
    editor.text.trim() === "" &&
    editor.attachments.length === 0 &&
    dropped.some((item) => !droppedTried.current.has(item.id));
  useEffect(() => {
    if (!droppedWaiting) return;
    const item = [...dropped]
      .reverse()
      .find((candidate) => !droppedTried.current.has(candidate.id));
    if (item) takeDropped(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedWaiting]);

  /**
   * 고쳐서 보내기 — 기다리는 말 하나를 방에서 통째로 꺼내 입력창에 되돌린다.
   * 되살리기와 같은 손: 데몬의 방이 진실이므로 목록은 방송이 거둔다.
   */
  const removeQueued = (item: QueuedSend) => {
    if (!onRemoveQueued) return;
    void onRemoveQueued(item.id)
      .then((payload) => {
        if (!payload) return;
        restore(payload.text, payload.attachments, payload.pins);
      })
      .catch((e) => sendError.show(failureWords(e, "기다리는 말을 꺼내지 못했습니다")));
  };

  const sendQueuedNow = (item: QueuedSend) => {
    if (!onSendQueuedNow) return;
    void onSendQueuedNow(item.id).catch((e) =>
      sendError.show(failureWords(e, "이 말을 먼저 보내지 못했습니다")),
    );
  };

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
    // 도는 턴에도 보내기는 산다 — 데몬이 정한 길(설정의 '턴 도중
    // 보내기')로 간다: 대기 줄이면 다음 턴에, 바로 실어 보내기면 그 자리에서
    // 반영된다. 중지는 여전히 끊는 손이고, Enter 는 보내는 손이다.
    submit();
  };

  // Chip labels come from the current row, so an aliased id still names the model.
  const modelRow = modelRowOf(selector.models, selector.model);
  // A model that ignores 노력 must not offer it; one whose row does not say
  // which levels it takes gets the full set.
  const effortLevels =
    modelRow?.supportedEffortLevels ?? (Object.keys(EFFORT_LABEL) as EffortLevel[]);
  const providerRows = providers ?? [];
  // 프로바이더 단계의 문 — 쓸 수 있는(설치·로그인이 다 된) 프로바이더가 둘
  // 이상일 때만 연다(B1): 선택지가 하나 이하면 고를 것도 없고, 그 근거를
  // 읽게 하는 행도 소음이다. 스레드에 묶인 고름의 범위는 단계의 노트가 말한다.
  const usableProviders = providerRows.filter((p) => p.available && p.loggedIn !== false);
  const canPickProvider = Boolean(providers && onPickProvider && usableProviders.length >= 2);
  // 프로바이더 행·단계가 읽는 값 — 다음 새 대화의 프로바이더다. 열린 대화는
  // `selector.provider` 를 유지하므로 두 값이 갈라지고, 행은 갈라진 쪽
  // (고름)을 따라간다: 고른 뒤에도 행이 움직이지 않으면 고름이 먹었다는
  // 근거가 화면에 없다.
  const pickedProvider = nextProvider ?? selector.provider ?? null;
  const pickedProviderRow = providerRows.find((p) => p.id === pickedProvider);
  const pickedProviderLabel = pickedProviderRow?.label ?? pickedProvider ?? "프로바이더";
  const providerRow = providerRows.find((p) => p.id === selector.provider);
  const providerLabel = providerRow?.label ?? selector.provider ?? "프로바이더";
  // 대화 설정 메뉴의 단계 — 모델·생각 시간을 한 판에 다 펼치지
  // 않고, 뿌리에서 좁혀 든다. 뿌리는 둘의 지금값을 한 줄씩 입고, 고른 설정의
  // 단계에서만 그 행들이 열린다. 모델 단계 안의 ← 프로바이더 걸음은 그대로
  // 이어진다. 열림마다 뿌리부터 — 닫혀 있던 단계를 기억하면 칩의 요약과
  // 메뉴가 다른 층을 가리키게 된다.
  const [menuStep, setMenuStep] = useState<"root" | "models" | "providers" | "effort">("root");
  // 프로바이더 단계로 든 걸음 — 뿌리 카드에서 든 것과 모델 머리의 단추에서
  // 든 것이 다시 물러나는 곳이 다르다(뿌리 / 모델). ← 는 든 길을 되돌린다.
  const [providerFrom, setProviderFrom] = useState<"root" | "models">("root");
  // 더 보기 팝오버(E′) — 모델·생각 칩이 사는 자리. 도는 답은 도크가 아니라
  // 표면의 문제다: 자주 손대지 않는 것은 아래로, 이유는 언제 읽히게.
  const [moreOpen, setMoreOpen] = useState(false);
  // Escape 닫힘 — 초점은 되돌리지 못해도 다음 Tab이 어긋나지 않게 닫힌다
  // (칩 규약과 같은 걸음).
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMoreOpen(false);
        setMenuStep("root");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  // 통합 설정 칩 — 모델·생각 시간이 칩 한 개의 요약으로 읽힌다(뿌리
  // 카드와 같은 순서: 무엇으로 · 얼마나 생각). 확인 방식은 칩의 셋째
  // 말이었으나 이제 대화가 언제나 바로 진행으로 돈다(2026-09-23) — 고를
  // 것이 없어진 말은 요약에서도 물러났다.
  const modelLabel = modelOptions(selector.models, modelRow).find((o) => o.picked)?.label ?? null;
  const settingsLabel = [modelLabel, selector.effort ? EFFORT_LABEL[selector.effort] : null]
    .filter(Boolean)
    .join(" · ");

  // 뿌리 카드의 한 줄 읽기 — 값 옆에 값의 뜻을 한국어로 입힌다. CLI 단어를
  // 번역하지는 않는다(칩·보내는 값은 CLI 의 말): 읽는 줄이 뜻을 담당한다.
  const modelDesc = modelRow?.description || "어떤 AI가 답할지 고릅니다";
  const effortDesc = selector.effort
    ? EFFORT_HINT[selector.effort]
    : "답하기 전에 얼마나 생각할지 정합니다";

  const pickChip = (key: "model" | "effort", value: string | null) => {
    if (key === "model") onSetModel(value);
    else onSetEffort((value as EffortLevel | null) ?? null);
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
        {/* 결함 5(실사 2026-09-20): 가득 찬 대화의 한 줄 — 입력 카드의
            손위에 선다. 읽기가 문턱을 넘는 동안만 살고, 닫는 손잡이가 없는
            것은 상태의 말이지 새 소식이 아니기 때문이다. */}
        {contextFull && (
          <p className="composer__ctxfull" role="status" data-testid="ctx-full">
            대화가 길어졌어요 — 새 대화에서 이어가면 더 빨라요
          </p>
        )}
        {rejected.text && (
          <Fold closing={rejected.closing} onCollapsed={rejected.clear}>
            <StateBanner
              tone="warn"
              role="status"
              title={rejected.text}
              closeLabel="첨부 안내 닫기"
              onClose={rejected.close}
            />
          </Fold>
        )}
        {/* 보내기·되돌리기 실패는 첨부 안내와 다른 슬롯 — 한 쪽의 닫기·
            새 소식이 다른 쪽을 지우지 않는다(실사 결함: 첨부가 전송 실패
            문구를 지웠다). */}
        {sendError.text && (
          <Fold closing={sendError.closing} onCollapsed={sendError.clear}>
            <StateBanner
              tone="danger"
              role="alert"
              title={sendError.text}
              closeLabel="오류 닫기"
              onClose={sendError.close}
            />
          </Fold>
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

        {/* 다음 턴에 보내기 (PLAN D86): 도는 턴에 온 말은 데몬의 방에서 기다린다.
          기록에는 아직 없으므로(에코는 전달 순간에 온다) 이 목록이 그 말의
          유일한 자리다 — 이것이 없으면 사람은 자기 요청이 어디로 갔는지 알 길이
          없다(감사 C3). 두 버튼은 데몬이 이미 가진 손잡이다: 통째로 꺼내기와
          도는 턴을 끊고 먼저 보내기. */}
        {queue.length > 0 && (
          <div className="composer__queued" role="status" data-testid="queued-panel">
            <div className="queued__head">다음 턴에 보낼 말 {queue.length}건</div>
            <ul className="queued__list">
              {queue.map((item) => (
                <li key={item.id} className="queued__row">
                  <span className="queued__text" title={item.text}>
                    {item.text || "(첨부만)"}
                  </span>
                  {attachmentWords(item) && (
                    <span className="queued__meta">{attachmentWords(item)}</span>
                  )}
                  {onSendQueuedNow && (
                    <Tip label="도는 턴을 중지하고 이 말을 먼저 보냅니다">
                      <button
                        type="button"
                        className="ghost queued__action"
                        aria-label="지금 보내기"
                        onClick={() => sendQueuedNow(item)}
                      >
                        <ArrowUpIcon size={12} />
                      </button>
                    </Tip>
                  )}
                  {onRemoveQueued && (
                    <Tip label="이 말을 꺼내 입력창으로 되돌립니다">
                      <button
                        type="button"
                        className="ghost queued__action"
                        aria-label="고쳐서 보내기"
                        onClick={() => removeQueued(item)}
                      >
                        <PencilIcon />
                      </button>
                    </Tip>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 잃은 말은 패널이 아니라 입력창으로 돌아온다 (PLAN L12): 가장 최근
          것의 글과 첨부가 비어 있는 칸에 저절로 놓이고, 한 줄 안내가 잠깐
          스친다. 칸이 비어 있지 않으면 기다린다 — 버튼은 없다. */}

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
        {/* 핀 트레이 — 상태 밴드에서 입력 카드 안으로(E′). 트레이는 "지금 보낼
            것"이므로 말이 사는 자리와 같은 카드에 산다. 메모 입력의 Enter 는
            전송이 아니라 본문으로 — capture 에서 입력창을 데려 오고, 행의
            onKeyDown 이 메모를 저장한 뒤 이벤트를 삼킨다. */}
        {pins.length > 0 && (
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
              onPinFocus={(id) => onPinFocus?.(id)}
              titleFor={titleForScreen}
              fold={{ folded: pinsFolded, onToggle: () => setPinsFold(!pinsFolded) }}
            />
          </div>
        )}
        <textarea
          ref={area}
          value={editor.text}
          placeholder={
            editor.attachments.length > 0
              ? editor.attachments.some((a) => a.kind === "image")
                ? "그림을 붙였습니다 — 어떻게 쓸지 한마디만 적어 주세요"
                : "파일을 붙였습니다 — 어떻게 쓸지 한마디만 적어 주세요"
              : placeholder
          }
          aria-label="메시지"
          /* @/… 자동완성의 콤보박스 선언 — 목록은 위의 listbox, 하이라이트는
           activedescendant 가 가리킨다(팔레트와 같은 패턴). */
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
          {/* 도는 동안에도 보내는 손은 옆에 선다 — 도는 턴에 온 말은 설정의
            '턴 도중 보내기' 길(대기 줄 · 바로 실어 보내기)로 간다. */}
          <button
            type="button"
            disabled={
              disabled ||
              sending ||
              (!editor.text.trim() && editor.attachments.length === 0 && pins.length === 0)
            }
            className="composer__send"
            aria-label={sending ? "보내는 중…" : "보내기"}
            aria-busy={sending || undefined}
            onClick={submit}
          >
            {sending ? <span className="spinner" /> : <ArrowUpIcon size={15} />}
          </button>
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
        {/* 설정은 칩 하나 — 요약(방식 · 모델 · 생각)을 입고, 팝오버는 한
            번에 한 설정만 연다. 뿌리에서 셋의 지금값이 읽히고, 고른 줄이
            그 설정의 단계로 좁혀 든다 — 숨김이 암흑이 되지 않게. */}
        <span className="selector">
          {moreOpen && (
            <button
              type="button"
              className="selector__backdrop"
              aria-label="더 보기 닫기"
              onClick={() => setMoreOpen(false)}
            />
          )}
          <Tip label={moreOpen ? undefined : "모델 · 생각 시간"} side="bottom">
            <button
              type="button"
              className="selector__chip"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              onClick={() => {
                if (!moreOpen) setMenuStep("root");
                setMoreOpen(!moreOpen);
              }}
            >
              <span className="selector__chipicon">
                <SparkIcon />
              </span>
              <span className="selector__chiplabel">{settingsLabel}</span>
              <ChevronDownIcon size={10} />
            </button>
          </Tip>
          {moreOpen && (
            <span className="selector__menu" role="dialog" aria-label="대화 설정">
              {menuStep === "root" ? (
                <>
                  {/* 뿌리 단계 — 세 설정의 지금값을 카드로 입는다. 카드는
                      이름과 값만이 아니라 값의 뜻을 한국어 한 줄로 함께
                      읽는다: 값을 모르는 사람도 지금 설정이 무엇을 하는지
                      열어 보기 전에 안다. 줄 순서가 곧 고르는 순서다 —
                      누가(프로바이더) · 무엇으로(모델) · 얼마나 생각할지
                      (생각 시간). 행에서 값을 고르면 다음 걸음으로 이어지고,
                      마지막 걸음인 생각 시간을 고르면 비로소 닫힌다. 확인
                      방식은 없다 — 모든 대화가 바로 진행으로 돈다. */}
                  {canPickProvider && (
                    <button
                      type="button"
                      className="selector__drill"
                      title="프로바이더 바꾸기"
                      onClick={() => {
                        setProviderFrom("root");
                        setMenuStep("providers");
                      }}
                    >
                      <span className="selector__drillicon" aria-hidden="true">
                        <ProviderIcon provider={pickedProvider} size={13} />
                      </span>
                      <span className="selector__drillbody">
                        <span className="selector__drilltop">
                          <span className="selector__drillname">프로바이더</span>
                          <span className="selector__drillval">{pickedProviderLabel}</span>
                        </span>
                        <span className="selector__drilldesc">
                          새 대화를 어떤 AI 에이전트로 시작할지 고릅니다
                        </span>
                      </span>
                      <ChevronRightIcon size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="selector__drill"
                    title="모델 바꾸기"
                    onClick={() => setMenuStep("models")}
                  >
                    <span
                      className="selector__drillicon selector__drillicon--accent"
                      aria-hidden="true"
                    >
                      <BrainIcon />
                    </span>
                    <span className="selector__drillbody">
                      <span className="selector__drilltop">
                        <span className="selector__drillname">모델</span>
                        <span className="selector__drillval">{modelLabel ?? "모델 미선택"}</span>
                      </span>
                      <span className="selector__drilldesc">{modelDesc}</span>
                    </span>
                    <ChevronRightIcon size={12} />
                  </button>
                  <button
                    type="button"
                    className="selector__drill"
                    title="생각 시간 정하기"
                    onClick={() => setMenuStep("effort")}
                  >
                    <span className="selector__drillicon" aria-hidden="true">
                      <ClockIcon />
                    </span>
                    <span className="selector__drillbody">
                      <span className="selector__drilltop">
                        <span className="selector__drillname">생각 시간</span>
                        <span className="selector__drillval">
                          {selector.effort ? EFFORT_LABEL[selector.effort] : "생각 미선택"}
                        </span>
                      </span>
                      <span className="selector__drilldesc">{effortDesc}</span>
                    </span>
                    <ChevronRightIcon size={12} />
                  </button>
                </>
              ) : menuStep === "effort" ? (
                <>
                  <div className="selector__head">
                    <div className="selector__headrow">
                      <button
                        type="button"
                        className="selector__back"
                        onClick={() => setMenuStep("root")}
                      >
                        <ChevronLeftIcon size={12} />
                        설정
                      </button>
                    </div>
                  </div>
                  {modelRow && !modelRow.supportsEffort ? (
                    <span className="selector__moreempty">
                      이 모델은 생각 시간을 정할 수 없어요
                    </span>
                  ) : (
                    <>
                      {/* 저울눈금 설명 — 미터의 점이 많아지는 쪽이 오래
                          생각한다는 것을 행 밖의 한 줄로 먼저 말한다. */}
                      <span className="selector__note">
                        칸이 채워질수록 더 오래, 더 깊게 생각합니다
                      </span>
                      {effortLevels.map((level, index) => (
                        <button
                          key={level}
                          type="button"
                          className={`selector__row selector__row--desc${
                            selector.effort === level ? " selector__row--on" : ""
                          }`}
                          onClick={() => {
                            pickChip("effort", level);
                            // 생각 시간이 마지막 걸음이다 — 고르면 닫는다.
                            setMoreOpen(false);
                          }}
                        >
                          <span className="selector__check">
                            {selector.effort === level ? <CheckIcon size={11} /> : null}
                          </span>
                          <span className="selector__text">
                            <span className="selector__label">{EFFORT_LABEL[level]}</span>
                            <span className="selector__desc">{EFFORT_HINT[level]}</span>
                          </span>
                          <span className="selector__meter" aria-hidden="true">
                            {effortLevels.map((mark, dot) => (
                              <span
                                key={mark}
                                className={`selector__meterdot${dot <= index ? " selector__meterdot--on" : ""}`}
                              />
                            ))}
                          </span>
                        </button>
                      ))}
                    </>
                  )}
                </>
              ) : (
                <>
                  {/* 모델 단계 — 프로바이더 걸음은 이 단계 안에서 더 파인다
                      (머리의 프로바이더 단추). 프로바이더 단계의 ← 는 든
                      길(뿌리 카드 / 모델 머리)을 되돌린다. */}
                  <div className="selector__head">
                    <div className="selector__headrow">
                      {menuStep === "providers" && canPickProvider ? (
                        <button
                          type="button"
                          className="selector__back"
                          onClick={() => setMenuStep(providerFrom)}
                        >
                          <ChevronLeftIcon size={12} />
                          {providerFrom === "models" ? "모델" : "설정"}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="selector__back"
                            onClick={() => setMenuStep("root")}
                          >
                            <ChevronLeftIcon size={12} />
                            설정
                          </button>
                          {canPickProvider ? (
                            <button
                              type="button"
                              className="selector__provbtn"
                              title="프로바이더 바꾸기"
                              onClick={() => {
                                setProviderFrom("models");
                                setMenuStep("providers");
                              }}
                            >
                              <ProviderIcon provider={pickedProvider} size={12} />
                              <span className="selector__provname">{pickedProviderLabel}</span>
                              <ChevronRightIcon size={11} />
                            </button>
                          ) : (
                            <span className="selector__headtitle">{providerLabel}</span>
                          )}
                        </>
                      )}
                      {canPickProvider && onOpenProviderSettings && (
                        <button
                          type="button"
                          className="selector__gear"
                          aria-label="프로바이더 설정"
                          title="프로바이더 설정"
                          onClick={() => {
                            setMoreOpen(false);
                            setMenuStep("root");
                            onOpenProviderSettings();
                          }}
                        >
                          <GearIcon size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  {/* 고름의 범위 — 스레드는 태어난 프로바이더에 묶인다. 열린
                      대화가 있는 자리의 프로바이더 단계는 그 한 줄을 먼저
                      읽혀야 고름이 스레드를 바꾸는 오해를 남기지 않는다. */}
                  {menuStep === "providers" && providerLocked && (
                    <span className="selector__note">
                      열린 대화는 지금 에이전트를 유지합니다 — 고른 프로바이더는 다음 새 대화부터
                      씁니다
                    </span>
                  )}
                  {(() => {
                    /** 모델·프로바이더 단계의 행 — 두 단계가 같은 옷을 입고
                     *  같은 손으로 그려진다(아이콘·설명은 있는 행만 입고,
                     *  없는 행은 이름 한 줄). */
                    const rows: Array<{
                      value: string | null;
                      label: string;
                      icon?: ReactNode;
                      desc?: string;
                      picked: boolean;
                      disabled?: boolean;
                    }> =
                      menuStep === "providers" && canPickProvider
                        ? providerRows.map((p) => ({
                            value: p.id as string | null,
                            label: p.label,
                            icon: (<ProviderIcon provider={p.id} size={13} />) as ReactNode,
                            desc: !p.available
                              ? (p.reason ?? "이 기기에 없습니다.")
                              : p.loggedIn === false
                                ? "로그인하면 새 대화에서 쓸 수 있습니다"
                                : undefined,
                            picked: p.id === pickedProvider,
                            disabled: !p.available,
                          }))
                        : modelOptions(selector.models, modelRow).map(
                            ({ value, label, hint, picked }) => ({
                              value: value as string | null,
                              label,
                              desc: hint || undefined,
                              picked,
                            }),
                          );
                    return rows.map((option) => (
                      <button
                        key={String(option.value)}
                        type="button"
                        disabled={option.disabled}
                        className={`selector__row${option.picked ? " selector__row--on" : ""}${
                          option.desc ? " selector__row--desc" : ""
                        }`}
                        title={option.desc || undefined}
                        onClick={() => {
                          if (menuStep === "providers" && canPickProvider) {
                            // 프로바이더 고름은 메뉴를 닫지 않는다 — 이어서
                            // 모델 목록을 보여 주는 것이 칩의 걸음이다. 단,
                            // 열린 대화의 프로바이더와 갈라진 고름(다음 새
                            // 대화의 것)은 모델 단계의 재료가 아니므로 뿌리로
                            // 돌려 놓는다 — 행의 값이 바뀐 것이 바로 흔적이다.
                            if (option.value) {
                              onPickProvider?.(option.value);
                              setMenuStep(
                                providerLocked && option.value !== selector.provider
                                  ? "root"
                                  : "models",
                              );
                            }
                            return;
                          }
                          pickChip("model", option.value);
                          // 다음 걸음 — 고른 모델이 생각 시간을 못 정하면
                          // 그 걸음은 없으므로 여기서 닫는다.
                          const pickedRow = selector.models.find(
                            (m) => m.value === option.value || m.resolvedModel === option.value,
                          );
                          if (pickedRow?.supportsEffort === false) setMoreOpen(false);
                          else setMenuStep("effort");
                        }}
                      >
                        <span className="selector__check">
                          {option.picked ? <CheckIcon size={11} /> : null}
                        </span>
                        {option.icon ? (
                          <span className="selector__rowicon" aria-hidden="true">
                            {option.icon}
                          </span>
                        ) : null}
                        {option.desc ? (
                          <span className="selector__text">
                            <span className="selector__label">{option.label}</span>
                            <span className="selector__desc">{option.desc}</span>
                          </span>
                        ) : (
                          <span className="selector__label">{option.label}</span>
                        )}
                      </button>
                    ));
                  })()}
                  {menuStep === "models" && selector.models.length === 0 && !canPickProvider && (
                    <span className="selector__moreempty">
                      연결된 에이전트가 아직 모델 목록을 주지 않았어요
                    </span>
                  )}
                </>
              )}
            </span>
          )}
        </span>
        <div className="toolbar__end">
          {/* 잠긴 동안엔 disabled 가 말하지 않는 잠긴 이유를 이 줄이 말한다.
              도는 동안엔 아무것도 선지 않는다. */}
          {disabled && (
            <p className="composer__hint">
              {`지금은 보낼 수 없어요${disabledReason ? ` — ${disabledReason}` : ""}`}
            </p>
          )}
        </div>
      </div>
    </footer>
  );
}
