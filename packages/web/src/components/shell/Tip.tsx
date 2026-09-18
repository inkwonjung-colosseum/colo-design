/**
 * Tip — the one tooltip. A hover or focus on the wrapped element floats the
 * label beside it; nothing else is asked of the call site.
 *
 * The bubble is a portal on document.body, not a sibling: the surfaces that
 * need tips most — transcript rows in .scroll, tree rows in .tree, menu rows
 * in .selector__menu — all live inside overflow containers that would clip a
 * sibling span. position:fixed escapes them all, so one mechanism covers the
 * whole app instead of a native-title fallback wherever clipping bites.
 *
 * The bubble stays mounted while the label lives, so aria-describedby always
 * resolves (the ctx__tip rule). Placement is measured on show and re-measured
 * on scroll/resize — the only bookkeeping, and it can never drift from the
 * pointer because it is not the pointer's.
 *
 * What does NOT come here: a title that exists only to reveal truncated text
 * (queued__text, leaf names, diff paths) stays a native title — that is a
 * content reveal, not an explanation, and the OS already does it.
 *
 * Nor on the controls that already explain themselves: a universal glyph
 * (✕ 닫기, ⧉ 복사, ←→ 뒤로/앞으로, ⚙ 설정) or a button whose visible label
 * names it gets no bubble — aria-label carries the name, and a bubble that
 * repeats it is noise. A Tip earns its mount by adding what the control
 * cannot show: a locked reason, a consequence, a changed meaning, a shortcut.
 */

import {
  type CSSProperties,
  cloneElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type TipSide = "top" | "bottom" | "left" | "right";
export type TipAlign = "start" | "center" | "end";

const GAP = 8;
const EDGE = 6;
const OPPOSITE: Record<TipSide, TipSide> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

export function Tip({
  label,
  side = "top",
  align = "center",
  className,
  bubbleClass,
  open = false,
  interactive = false,
  children,
}: {
  /** What the element does. Falsy renders the bare child — callers can gate
      a tip on state (an open menu, a running flag) without unwrapping. */
  label: ReactNode;
  side?: TipSide;
  /** Which end of the trigger the bubble hugs; center is the default. */
  align?: TipAlign;
  className?: string;
  /** Extra class on the bubble for a richer card (ctx__tip keeps its
      title+reading layout through this). */
  bubbleClass?: string;
  /** Pin the bubble open with no hover — the one-shot coach marks use it.
      While open the bubble takes pointer events so a 닫기 inside can be
      pressed (hover tips stay pointer-transparent). */
  open?: boolean;
  /** A hover card the pointer may enter: the bubble takes events and stays
      while it is hovered, so links and buttons inside can be used. Plain
      tips stay pointer-transparent and die on leave. */
  interactive?: boolean;
  children: ReactElement;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(false);
  const [at, setAt] = useState<CSSProperties>({ left: -9999, top: -9999 });
  // An interactive card survives the gap between trigger and bubble: the
  // leave only schedules a hide, and entering the bubble cancels it. Plain
  // tips keep the instant hide — nothing inside them can be reached anyway.
  // The ref and its cleanup live with the other hooks: the falsy-label
  // early return below means a Tip may render as the bare child, and a hook
  // past that return would break the render's hook count (React #300).
  const hideTimer = useRef<number | null>(null);
  const cancelHide = () => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  // Unmount with a hide still scheduled: drop it, or it fires on a dead
  // component. The local holds the stable ref so the cleanup needs no deps.
  useEffect(() => {
    const timer = hideTimer;
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, []);

  // A gated tip (an open menu flips label to undefined) unmounts the wrapper
  // that hides on leave/blur, so the hide never arrives. Forgetting `shown`
  // here keeps the label's return from replaying a hover that is long gone —
  // otherwise the bubble floated over the confirm dialog opened from that
  // very menu.
  useEffect(() => {
    if (!label) setShown(false);
  }, [label]);

  const place = () => {
    const host = anchor.current;
    const tip = bubble.current;
    if (!host || !tip) return;
    const r = host.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    // Flip to the opposite side when the requested one has no room.
    let s = side;
    if (s === "top" && r.top - GAP - h < EDGE) s = OPPOSITE[s];
    else if (s === "bottom" && r.bottom + GAP + h > innerHeight - EDGE) s = OPPOSITE[s];
    else if (s === "left" && r.left - GAP - w < EDGE) s = OPPOSITE[s];
    else if (s === "right" && r.right + GAP + w > innerWidth - EDGE) s = OPPOSITE[s];

    let left: number;
    let top: number;
    if (s === "top" || s === "bottom") {
      left =
        align === "start" ? r.left : align === "end" ? r.right - w : r.left + r.width / 2 - w / 2;
      top = s === "top" ? r.top - GAP - h : r.bottom + GAP;
    } else {
      top =
        align === "start" ? r.top : align === "end" ? r.bottom - h : r.top + r.height / 2 - h / 2;
      left = s === "left" ? r.left - GAP - w : r.right + GAP;
    }
    left = Math.max(EDGE, Math.min(left, innerWidth - w - EDGE));
    top = Math.max(EDGE, Math.min(top, innerHeight - h - EDGE));
    // No dep array on the effect below means place runs after every render —
    // bail on an unchanged rect or setAt would loop the component forever.
    setAt((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  };

  // Measure before paint: the bubble mounts parked off-screen and lands
  // already placed — no flash of a wrong position. No dep array: place is a
  // cheap rect read and a label swap while shown must re-measure anyway.
  useLayoutEffect(() => {
    if (shown || open) place();
  });

  // Falsy label renders the bare child — hooks above already ran, so this
  // early return is safe.
  if (!label) return children;

  const show = () => setShown(true);
  const hide = () => setShown(false);
  const scheduleHide = () => {
    if (!interactive) return hide();
    cancelHide();
    hideTimer.current = window.setTimeout(hide, 120);
  };
  // Focus leaving the trigger for a control inside the card is not a hide —
  // the bubble's own blur closes it once focus leaves the card entirely.
  const blurAnchor = (event: React.FocusEvent) => {
    if (interactive && bubble.current?.contains(event.relatedTarget as Node | null)) return;
    hide();
  };
  const blurBubble = (event: React.FocusEvent) => {
    if (!bubble.current?.contains(event.relatedTarget as Node | null)) hide();
  };

  const child = cloneElement(children, {
    "aria-describedby": [(children.props as Record<string, unknown>)["aria-describedby"], id]
      .filter(Boolean)
      .join(" "),
  } as Partial<unknown>);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: the span is only a hover/focus scope — the interactive child inside carries the semantics.
    <span
      ref={anchor}
      className={className ? `tip ${className}` : "tip"}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
      onFocus={show}
      onBlur={blurAnchor}
    >
      {child}
      {createPortal(
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: an interactive card takes the pointer so its rows are usable — role stays tooltip.
        <span
          ref={bubble}
          id={id}
          role="tooltip"
          className={
            bubbleClass
              ? `tip__bubble${shown || open ? " tip__bubble--shown" : ""} ${bubbleClass}`
              : `tip__bubble${shown || open ? " tip__bubble--shown" : ""}`
          }
          style={open || interactive ? { ...at, pointerEvents: "auto" } : at}
          onMouseEnter={interactive ? cancelHide : undefined}
          onMouseLeave={interactive ? scheduleHide : undefined}
          onBlur={interactive ? blurBubble : undefined}
        >
          {label}
        </span>,
        document.body,
      )}
      {(shown || open) && <TipFollow onMove={place} />}
    </span>
  );
}

/** Scroll or resize moves the anchor under a fixed bubble — re-measure. */
function TipFollow({ onMove }: { onMove: () => void }) {
  useLayoutEffect(() => {
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  });
  return null;
}
