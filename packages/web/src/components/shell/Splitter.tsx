import type { ReactNode } from "react";

/**
 * The one draggable column boundary. Drawn over the 1px border the
 * adjacent columns already paint. A separator, not a button: pointer drag for
 * the mouse, ←/→ in 24px steps for the keyboard, double-click back to the
 * default. `active` is the drag in flight — the only time the boundary shows
 * a line of its own.
 *
 * `side` says which column the width belongs to and therefore which way the
 * boundary hangs off it: the preview sits on the right (the boundary pinned
 * `right: width`, drag leftward to widen); the sidebar sits on the left —
 * mirrored, so the arrow pointing where the boundary actually moves is the
 * one that widens.
 */
export function Splitter({
  side,
  width,
  bounds,
  label,
  active,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onNudge,
  onReset,
}: {
  side: "left" | "right";
  width: number;
  bounds: { readonly min: number; readonly max: number };
  label: string;
  active: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  /** Nudge the column by px; positive means the drag direction (widen). */
  onNudge: (delta: number) => void;
  onReset: () => void;
}): ReactNode {
  return (
    <div
      className={`planner__split planner__split--${side === "right" ? "preview" : "sidebar"}${active ? " planner__split--drag" : ""}`}
      style={side === "right" ? { right: width } : { left: width }}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      aria-valuetext={`${width}픽셀`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          // Each side widens toward its own outer edge: the preview's boundary
          // travels left, the sidebar's travels right.
          const widens = side === "right" ? "ArrowLeft" : "ArrowRight";
          onNudge(event.key === widens ? 24 : -24);
          event.preventDefault();
        }
      }}
      onDoubleClick={onReset}
    />
  );
}
