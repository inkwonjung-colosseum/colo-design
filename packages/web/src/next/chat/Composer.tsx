import { type ReactNode, useEffect, useRef, useState } from "react";
import type { PinAttachment } from "../../hooks/usePins";
import type { Sessions } from "../../hooks/useSessions";
import type { Attachment } from "../../lib/attachment";
import { modelRowOf } from "../../lib/chat-options";
import type { Daemon } from "../../lib/daemon-client";
import { koreanNoticeWords } from "../../lib/error-words";
import { composing } from "../../lib/ime";
import { isInviteFile, offerInviteFile } from "../../lib/invite-bus";
import { L } from "../labels";
import { sizeText } from "../lib/thread";
import { BoltIcon, ClipIcon, FileIcon, ImageIcon, PinIcon, StopIcon, UpIcon, XIcon } from "./icons";
import { ModelChip } from "./ModelChip";

/** 첨부 한 건의 상한 — 대기열 저장소의 항목 예산(8MB)과 같다(옛 입력창과 같은 값). */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** 붙인 그림의 긴 변 상한 — 비전 입력이 실제로 쓰는 한계. */
const IMAGE_LONG_EDGE = 1568;
const RESIZABLE: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/webp": true,
};
/** 입력창의 초안은 옛 입력창과 같은 열쇠를 쓴다 — 두 셸이 같은 대화의 같은 초안을 본다. */
const DRAFT_PREFIX = "colo-design.draft.";

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
    // 비공개 모드 — 메모리의 지도만 남는다.
  }
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("decode"));
    image.src = src;
  });
}

/**
 * 파일 한 건을 첨부로 — 큰 래스터 그림은 같은 형식으로 줄이고, 줄일 수 없는
 * 것(움짤 · 벡터 · 손상)은 원본 그대로 둔다. 그림이 아닌 파일은 바이트 그대로다.
 */
async function toAttachment(file: File): Promise<Attachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(file.name));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  const original: Attachment = {
    kind: file.type.startsWith("image/") ? "image" : "file",
    name: file.name || "image.png",
    mediaType: file.type || "application/octet-stream",
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    size: file.size,
  };
  if (!RESIZABLE[file.type]) return original;
  try {
    const image = await decodeImage(dataUrl);
    const edge = Math.max(image.naturalWidth, image.naturalHeight);
    if (!edge || edge <= IMAGE_LONG_EDGE) return original;
    const scale = IMAGE_LONG_EDGE / edge;
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

/** 첨부 한 건의 열쇠 — 같은 이름의 파일을 두 번 붙여도 칩이 섞이지 않게. */
const attachKeys = new WeakMap<Attachment, string>();
let attachSeq = 0;
function attachKey(att: Attachment): string {
  let key = attachKeys.get(att);
  if (!key) {
    attachSeq += 1;
    key = `att-${attachSeq}`;
    attachKeys.set(att, key);
  }
  return key;
}

interface Editor {
  text: string;
  attachments: Attachment[];
}

const EMPTY: Editor = { text: "", attachments: [] };

/** 핀 칩의 이름 — 요소의 글자, 없으면 컴포넌트 이름, 영역이면 `영역`. */
function pinLabel(pin: PinAttachment): string {
  if (pin.element.kind === "region") return L.pin.area;
  return pin.element.text || pin.element.component || pin.screen;
}

export interface ComposerHandle {
  /** 파일 여러 개를 첨부로 — 대화 칸 전체의 끌어다 놓기가 빌린다. */
  attach: (files: FileList | File[]) => void;
}

/**
 * 입력창(PLAN-UI 단계 2) — 대화 칸과 홈이 함께 쓴다. 글 · 핀 칩(메모를 여기서도
 * 고친다) · 첨부(그림 · 문서, 한 건 8MB — 초대 파일은 첨부하지 않고 가져오기로
 * 넘긴다) · 도구 줄(첨부 · 찍기(좁은 창만) · 설정 칩 · 빠르게 · 보내기).
 *
 * 보내기의 실제 일은 부르는 쪽(`onSend`)이 한다 — 대화 칸은 핀을 한 턴으로
 * 묶어 `sessions.submit`, 홈은 새 대화를 열어 보낸다. 입력창은 받아들여졌을
 * 때만 비운다: 거절되면 말과 첨부와 핀이 그대로 남고 이유가 한 줄 선다.
 */
export function Composer({
  daemon,
  sessions,
  variant,
  draftKey,
  placeholder,
  pins = [],
  pinNumberStart = 1,
  onPinNote,
  onPinRemove,
  onPinFocus,
  narrow = false,
  onPinMode,
  leading,
  disabledProviders,
  lockReason = null,
  running = false,
  onStop,
  stopping = false,
  prefill = null,
  listenPinsSend = false,
  registerHandle,
  onSend,
}: {
  daemon: Daemon;
  sessions: Sessions;
  variant: "thread" | "home";
  /** 어느 대화의 초안인가 — 열쇠가 바뀌면 초안도 바뀐다. */
  draftKey: string;
  placeholder: string;
  pins?: PinAttachment[];
  /** 첫 칩의 번호 — 도는 답이 들고 간 회색 배지들 다음부터(옛 입력창과 같다). */
  pinNumberStart?: number;
  onPinNote?: (id: string, note: string) => void;
  onPinRemove?: (id: string) => void;
  onPinFocus?: (id: string) => void;
  narrow?: boolean;
  /** 좁은 창의 `찍기` — 넓은 창은 미리보기 막대의 것 하나(U16). */
  onPinMode?: () => void;
  /** 도구 줄 맨 앞(홈의 프로젝트 칩). */
  leading?: ReactNode;
  disabledProviders?: string[];
  /** 보낼 수 없는 이유 — 있으면 잠근다(연결이 끊겼을 때). */
  lockReason?: string | null;
  running?: boolean;
  onStop?: () => void;
  stopping?: boolean;
  /** 밖에서 채워 넣는 말(고쳐서 다시 보내기) — `nonce` 가 오르면 한 번 집는다. */
  prefill?: { text: string; nonce: number } | null;
  /** 말풍선의 `지금 보내기`(`nx:pins:send`)를 이 입력창이 받는다 — 대화 칸만. */
  listenPinsSend?: boolean;
  registerHandle?: (handle: ComposerHandle | null) => void;
  /** `screens` — 미리보기가 담아 준 화면(AI에게 이 화면 보여 주기) — 게이트가 다시 열어 본다. */
  onSend: (
    text: string,
    attachments: Attachment[],
    pins: PinAttachment[],
    screens: Array<{ screen: string }>,
  ) => Promise<void>;
}) {
  const [editor, setEditor] = useState<Editor>(() => ({
    text: storedDraft(draftKey),
    attachments: [],
  }));
  const [notice, setNotice] = useState<{ tone: "warn" | "danger"; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const drafts = useRef(new Map<string, Editor>());
  const keyRef = useRef(draftKey);

  // 바뀔 때마다 지도(대화 전환)와 저장소(새로 고침)에 적는다.
  useEffect(() => {
    drafts.current.set(keyRef.current, editor);
    saveDraft(keyRef.current, editor.text);
  }, [editor]);

  // 글에 맞춰 자란다 — CSS 의 max-height 까지.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 글이 바뀔 때마다 높이를 다시 잰다.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [editor.text]);

  // 대화를 옮기면 그 대화의 초안으로. 대화가 태어나기 전(new:*)에 쓴 말은 그
  // 대화의 것이므로, 새 대화가 비어 있으면 넘겨받는다(옛 입력창과 같은 규칙).
  useEffect(() => {
    if (keyRef.current === draftKey) return;
    const previous = keyRef.current;
    const prevEditor = drafts.current.get(previous) ?? EMPTY;
    const incoming = drafts.current.get(draftKey);
    const pristine =
      (incoming?.text ?? storedDraft(draftKey)) === "" && (incoming?.attachments.length ?? 0) === 0;
    const carry = previous.startsWith("new:") && prevEditor.text !== "" && pristine;
    if (carry) {
      drafts.current.delete(previous);
      saveDraft(previous, "");
    }
    keyRef.current = draftKey;
    setEditor(carry ? prevEditor : (incoming ?? { text: storedDraft(draftKey), attachments: [] }));
    setNotice(null);
  }, [draftKey]);

  // 고쳐서 다시 보내기 — 그 말이 입력창에 들어오고 커서가 끝에 선다.
  const prefillSeen = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || prefill.nonce === prefillSeen.current) return;
    prefillSeen.current = prefill.nonce;
    setEditor((prev) => ({ text: prefill.text, attachments: prev.attachments }));
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [prefill]);

  const readFiles = async (files: FileList | File[]) => {
    const accepted: File[] = [];
    const refused: string[] = [];
    for (const file of [...files]) {
      // 초대 파일은 첨부가 아니라 가져오기다 — 앱에 하나뿐인 통로로 넘긴다.
      if (isInviteFile(file)) {
        offerInviteFile(file);
        continue;
      }
      if (file.size <= MAX_ATTACHMENT_BYTES) accepted.push(file);
      else refused.push(file.name);
    }
    setNotice(
      refused.length > 0 ? { tone: "warn", text: L.composer.tooBig(refused.join(", ")) } : null,
    );
    if (accepted.length === 0) return;
    const read = await Promise.all(accepted.map((file) => toAttachment(file)));
    setEditor((prev) => ({ text: prev.text, attachments: [...prev.attachments, ...read] }));
  };
  const readRef = useRef(readFiles);
  readRef.current = readFiles;
  useEffect(() => {
    registerHandle?.({ attach: (files) => void readRef.current(files) });
    return () => registerHandle?.(null);
  }, [registerHandle]);

  const locked = lockReason !== null;
  const hasContent = editor.text.trim() !== "" || editor.attachments.length > 0 || pins.length > 0;

  const submit = () => {
    if (sendingRef.current || locked) return;
    const text = editor.text.trim();
    if (!text && editor.attachments.length === 0 && pins.length === 0) return;
    sendingRef.current = true;
    setSending(true);
    setNotice(null);
    const sentKey = keyRef.current;
    const sentEditor = editor;
    const sentScreens = shownScreens.current;
    shownScreens.current = [];
    void onSend(text, editor.attachments, pins, sentScreens)
      .then(() => {
        // 보내는 동안 다른 대화로 옮겼으면 비우는 것은 보낸 쪽의 초안뿐이다.
        if (keyRef.current !== sentKey) {
          drafts.current.set(sentKey, EMPTY);
          saveDraft(sentKey, "");
        }
        // 보내는 동안 더 쓴 말은 살린다 — 필드가 보낸 그대로일 때만 비운다.
        setEditor((prev) =>
          prev.text === sentEditor.text && prev.attachments === sentEditor.attachments
            ? EMPTY
            : prev,
        );
      })
      .catch((error: unknown) => {
        shownScreens.current = [...sentScreens, ...shownScreens.current];
        // 데몬의 거절 문장은 한국어이고 고치는 길을 싣는다 — 있으면 그대로, 없으면 한 줄.
        const raw = error instanceof Error ? (error.message.split("\n")[0] ?? "").trim() : "";
        setNotice({ tone: "danger", text: koreanNoticeWords(raw) ? raw : L.chat.sendFailed });
      })
      .finally(() => {
        sendingRef.current = false;
        setSending(false);
      });
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // 미리보기의 `AI에게 이 화면 보여 주기`(단계 3) — 담아 준 그림을 첨부로 받는다. 받았다고
  // 알리면(preventDefault) 미리보기는 스스로 보내지 않는다. 화면은 다음 보내기에 실린다.
  const shownScreens = useRef<Array<{ screen: string }>>([]);
  useEffect(() => {
    if (!listenPinsSend) return;
    const onAttach = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          attachments?: Array<Partial<Attachment> & { mediaType: string; data: string }>;
          screen?: string;
        }>
      ).detail;
      const incoming = (detail?.attachments ?? []).filter((att) => att?.data && att.mediaType);
      if (incoming.length === 0) return;
      event.preventDefault();
      const read: Attachment[] = incoming.map((att) => ({
        kind: att.kind ?? (att.mediaType.startsWith("image/") ? "image" : "file"),
        name: att.name || "screen.png",
        mediaType: att.mediaType,
        data: att.data,
        size: att.size ?? Math.ceil(att.data.length * 0.75),
      }));
      setEditor((prev) => ({ text: prev.text, attachments: [...prev.attachments, ...read] }));
      if (detail?.screen)
        shownScreens.current = [...shownScreens.current, { screen: detail.screen }];
      area.current?.focus();
    };
    window.addEventListener("nx:composer:attach", onAttach);
    return () => window.removeEventListener("nx:composer:attach", onAttach);
  }, [listenPinsSend]);

  // 말풍선의 `지금 보내기`(단계 3) — 지금 글과 핀을 한 턴으로. 보내기를 누른 것과 같은 길.
  useEffect(() => {
    if (!listenPinsSend) return;
    const onSendNow = () => submitRef.current();
    window.addEventListener("nx:pins:send", onSendNow);
    return () => window.removeEventListener("nx:pins:send", onSendNow);
  }, [listenPinsSend]);

  // 빠르게 — 데몬이 받아들인 자세를 따른다. 누르면 부탁하고, 선택자를 다시 읽어
  // 그 답으로 선다(요금제가 막으면 제자리). 다음 정산의 선택자가 오면 그것이 이긴다.
  const activeId = sessions.activeId;
  const modelRow = modelRowOf(sessions.selector.models, sessions.selector.model);
  const fastShown =
    variant === "thread" && activeId !== null && modelRow?.supportsFastMode === true;
  const [fastAck, setFastAck] = useState<{ sessionId: string; on: boolean } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 선택자를 새로 읽으면(정산 · 모델 바꿈) 데몬의 답이 이긴다.
  useEffect(() => {
    setFastAck(null);
  }, [sessions.selector]);
  const fastOn =
    fastAck && fastAck.sessionId === activeId ? fastAck.on : sessions.selector.fastMode === true;
  const [fastBusy, setFastBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);
  const toggleFast = () => {
    if (!activeId || fastBusy) return;
    setFastBusy(true);
    const want = !fastOn;
    void daemon.api
      .setFastMode(activeId, want)
      .then(() => daemon.api.selectors(activeId))
      .then((next) => {
        const on = next.fastMode === true;
        setFastAck({ sessionId: activeId, on });
        setNotice(null);
        if (on === want) setToast(on ? L.composer.fastOn : L.composer.fastOff);
      })
      .catch(() => setFastAck({ sessionId: activeId, on: fastOn }))
      .finally(() => setFastBusy(false));
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 조합 중인 Enter 는 한글의 마침이다 — 반쯤 쓴 말을 보내지 않는다.
    if (composing(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const showStop = running && !hasContent && onStop !== undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 홈의 입력창이 파일을 놓는 자리다 — 드롭은 포인터의 일이고, 키보드는 첨부 단추로 닿는다.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: 위와 같다.
    <div
      className={`nx-composer${variant === "home" ? " nx-composer--home" : ""}`}
      // 대화 칸은 칸 전체가 놓는 자리다(ChatColumn) — 홈만 입력창 자신이 받는다.
      onDragOver={variant === "home" ? (event) => event.preventDefault() : undefined}
      onDrop={
        variant === "home"
          ? (event) => {
              event.preventDefault();
              if (event.dataTransfer.files.length > 0) void readFiles(event.dataTransfer.files);
            }
          : undefined
      }
    >
      {pins.length > 0 && (
        <div className="nx-pinrows">
          {pins.map((pin, index) => (
            <div key={pin.id} className="nx-pinrow">
              <span className="nx-pnum">{pinNumberStart + index}</span>
              <button
                type="button"
                className="nx-pin-lab"
                title={L.chat.pinFlash}
                onClick={() => onPinFocus?.(pin.id)}
              >
                {pinLabel(pin)}
              </button>
              <input
                value={pin.note}
                placeholder={L.composer.pinNote}
                aria-label={L.composer.pinNote}
                onChange={(event) => onPinNote?.(pin.id, event.target.value)}
                onKeyDown={(event) => {
                  if (composing(event)) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    area.current?.focus();
                  }
                }}
              />
              <button
                type="button"
                className="nx-ibtn nx-ibtn--sm"
                title={L.composer.pinRemove}
                aria-label={L.composer.pinRemove}
                onClick={() => onPinRemove?.(pin.id)}
              >
                <XIcon />
              </button>
            </div>
          ))}
        </div>
      )}
      {editor.attachments.length > 0 && (
        <div className="nx-atts">
          {editor.attachments.map((att, index) => (
            <span key={attachKey(att)} className="nx-att">
              <span className="nx-att-ic">
                {att.kind === "image" ? (
                  <img src={`data:${att.mediaType};base64,${att.data}`} alt="" />
                ) : (
                  <FileIcon />
                )}
              </span>
              <span className="nx-att-n">
                <b>{att.name}</b>
                <span>{sizeText(att.size)}</span>
              </span>
              <button
                type="button"
                className="nx-ibtn nx-ibtn--sm"
                title={L.chat.attachRemove}
                aria-label={L.chat.attachRemove}
                onClick={() =>
                  setEditor((prev) => ({
                    text: prev.text,
                    attachments: prev.attachments.filter((_, at) => at !== index),
                  }))
                }
              >
                <XIcon />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={area}
        rows={variant === "home" ? 2 : 1}
        value={editor.text}
        placeholder={placeholder}
        onChange={(event) => setEditor((prev) => ({ ...prev, text: event.target.value }))}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length === 0) return;
          event.preventDefault();
          void readFiles(files);
        }}
      />
      {(notice || lockReason || toast) && (
        <div
          className={`nx-cmp-note nx-cmp-note--${lockReason || notice?.tone === "danger" ? "danger" : notice ? "warn" : "ok"}`}
          role="status"
        >
          {lockReason ?? notice?.text ?? toast}
        </div>
      )}
      <div className="nx-cmp-tools">
        {leading}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void readFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="nx-tbtn"
          title={L.composer.attach}
          aria-label={L.composer.attach}
          onClick={() => picker.current?.click()}
        >
          {editor.attachments.some((att) => att.kind === "image") ? <ImageIcon /> : <ClipIcon />}
        </button>
        {narrow && onPinMode && (
          <button type="button" className="nx-tbtn" title={L.composer.pinTip} onClick={onPinMode}>
            <PinIcon />
            <span>{L.composer.pin}</span>
          </button>
        )}
        <div className="nx-grow" />
        <ModelChip daemon={daemon} sessions={sessions} disabledProviders={disabledProviders} />
        {fastShown && (
          <button
            type="button"
            className={`nx-tbtn${fastOn ? " nx-tbtn--on" : ""}`}
            title={L.composer.fastTip}
            aria-pressed={fastOn}
            disabled={fastBusy}
            onClick={toggleFast}
          >
            <BoltIcon />
            <span>{L.composer.fast}</span>
          </button>
        )}
        {showStop ? (
          <button
            type="button"
            className="nx-send nx-send--stop"
            title={stopping ? L.chat.stopping : L.composer.stop}
            aria-label={stopping ? L.chat.stopping : L.composer.stop}
            disabled={stopping}
            onClick={onStop}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="nx-send"
            title={L.composer.send}
            aria-label={L.composer.send}
            disabled={!hasContent || sending || locked}
            onClick={submit}
          >
            <UpIcon />
          </button>
        )}
      </div>
    </div>
  );
}
