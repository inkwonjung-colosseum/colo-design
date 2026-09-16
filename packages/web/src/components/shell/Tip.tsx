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
 */

import {
  type CSSProperties,
  cloneElement,
  type ReactElement,
  type ReactNode,
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
  children: ReactElement;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(false);
  const [at, setAt] = useState<CSSProperties>({ left: -9999, top: -9999 });

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
    if (shown) place();
  });

  // Falsy label renders the bare child — hooks above already ran, so this
  // early return is safe.
  if (!label) return children;

  const show = () => setShown(true);
  const hide = () => setShown(false);

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
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {child}
      {createPortal(
        <span
          ref={bubble}
          id={id}
          role="tooltip"
          className={
            bubbleClass
              ? `tip__bubble${shown ? " tip__bubble--shown" : ""} ${bubbleClass}`
              : `tip__bubble${shown ? " tip__bubble--shown" : ""}`
          }
          style={at}
        >
          {label}
        </span>,
        document.body,
      )}
      {shown && <TipFollow onMove={place} />}
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
