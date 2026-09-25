import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PinAttachment } from "../../hooks/usePins";
import { composing } from "../../lib/ime";
import { L } from "../labels";
import { bubblePlacement } from "../lib/preview-geometry";
import { TrashIcon } from "./icons";

/** `nx:pins:send` — 말풍선의 ⌘↵. 입력창(단계 2)이 지금의 글과 핀을 보낸다. */
export const PINS_SEND_EVENT = "nx:pins:send";

/** 핀 하나의 이름 — 컴포넌트 · testid · 글자 · 태그, 영역이면 `영역`. */
export function pinName(pin: PinAttachment): string {
  const element = pin.element;
  if (element.kind === "region") return L.pin.area;
  const owner = element.owners?.[0];
  const text = element.text.trim();
  return (
    owner ||
    element.attrs?.testId ||
    element.a11y?.name ||
    (text ? (text.length > 18 ? `${text.slice(0, 18)}…` : text) : "") ||
    element.component
  );
}

/**
 * 핀 말풍선(PLAN-UI U4) — 찍은 자리에 뜨는 메모 입력. 입력창 칩의 원격
 * 조작기다: 적는 글은 곧장 `pins.setNote` 로 가서 같은 번호의 칩에 비친다.
 * 게스트 안이 아니라 앱 쪽 층에 선다 — 한글 입력과 포커스가 웹뷰로 넘어가지 않게.
 *
 * ↵ 담기(글을 두고 닫는다) · ⌘↵ 지금 보내기 · 휴지통(이 핀 빼기) · esc(적은 글
 * 없이 닫는다 — 열기 전의 메모로 되돌린다). 자리는 연 순간 한 번 잡는다; 어긋날
 * 수 있는 사건(이동 · 배율 · 바깥 누름)에는 칸이 닫는다.
 */
export function PinBubble({
  pin,
  n,
  screenName,
  frame,
  zoom,
  box,
  narrow,
  onNote,
  onRemove,
  onClose,
  toast,
}: {
  pin: PinAttachment;
  n: number;
  screenName: string;
  /** 게스트 요소의 왼쪽 위(칸 기준). */
  frame: { left: number; top: number };
  zoom: number;
  box: { width: number; height: number };
  narrow: boolean;
  onNote: (note: string) => void;
  onRemove: () => void;
  onClose: () => void;
  toast: (text: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opened = useRef(pin.note);
  const [note, setNote] = useState(pin.note);
  const [place, setPlace] = useState<{ left: number; top: number; up: boolean } | null>(null);

  // 자리는 연 순간 한 번 — 말풍선의 실제 높이를 재고 나서.
  // biome-ignore lint/correctness/useExhaustiveDependencies: 연 순간의 좌표만 쓴다.
  useLayoutEffect(() => {
    const el = ref.current;
    setPlace(
      bubblePlacement({
        rect: pin.element.rect,
        frame,
        zoom,
        box,
        bubble: { width: el?.offsetWidth ?? 300, height: el?.offsetHeight ?? 110 },
      }),
    );
  }, []);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // 바깥을 누르거나 게스트가 포커스를 가져가면 닫는다(글은 이미 칩에 있다).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      close.current();
    };
    const onFocusIn = (event: FocusEvent) => {
      if ((event.target as HTMLElement | null)?.tagName === "WEBVIEW") close.current();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  const keep = () => {
    onClose();
    toast(narrow ? L.pin.keptNarrow(n) : L.pin.keptN(n));
  };
  const sendNow = () => {
    onClose();
    window.dispatchEvent(new CustomEvent(PINS_SEND_EVENT));
  };

  return (
    <div
      ref={ref}
      className={`nx-pinbub${place?.up ? " nx-pinbub--up" : ""}`}
      role="dialog"
      aria-label={L.pin.bubble}
      style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
    >
      <div className="nx-pinbub-h">
        <span className="nx-pnum">{n}</span>
        <b>{pinName(pin)}</b>
        <span>· {screenName}</span>
        <button
          type="button"
          className="nx-ibtn nx-ibtn--sm nx-r"
          title={L.pin.removePin}
          aria-label={L.pin.removePin}
          onClick={() => {
            onClose();
            onRemove();
            toast(L.pin.removed);
          }}
        >
          <TrashIcon />
        </button>
      </div>
      <input
        ref={input}
        value={note}
        placeholder={L.pin.bubblePlaceholder}
        aria-label={L.pin.bubblePlaceholder}
        onChange={(event) => {
          setNote(event.target.value);
          onNote(event.target.value);
        }}
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            sendNow();
          } else if (event.key === "Enter") {
            event.preventDefault();
            keep();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onNote(opened.current);
            onClose();
          }
        }}
      />
      <div className="nx-pinbub-f">
        <span>{L.pin.bubbleKeepHint}</span>
        <span className="nx-grow" />
        <button type="button" className="nx-btn nx-btn--sm" onClick={keep}>
          {L.pin.keep}
        </button>
        <button type="button" className="nx-btn nx-btn--sm nx-btn--pri" onClick={sendNow}>
          {L.pin.sendNow}
        </button>
      </div>
    </div>
  );
}
