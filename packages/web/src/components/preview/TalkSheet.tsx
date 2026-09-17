import type { ReactNode } from "react";
import { ChevronDownIcon } from "../icons";
import { Tip } from "../shell/Tip";

/**
 * 크게 보기의 도킹 대화 시트 (preview.md §1-D). The shell is always mounted —
 * `children` (the whole ChatColumn) never leaves the tree, so the
 * transcript's scroll and the composer's draft survive every toggle. What
 * changes is only the frame around it:
 *
 * - 기본: the shell is invisible — a plain flex parent inside the chat
 *   column, no chrome of its own.
 * - 확장: the preview column takes the body's full width and the sheet
 *   docks at its bottom — a header, the conversation, and a fold button.
 *   Docked, not overlaid: the native WebContentsView draws above every DOM
 *   layer, so a sheet over the stage is impossible; docking shrinks the
 *   view's bounds honestly (ResizeObserver follows, as it always has).
 * - 확장 + 접힘: the body collapses to zero height — still mounted — and a
 *   pill strip (`이 화면에 말 걸기 ⌘.`) is the way back.
 */
export function TalkSheet({
  expanded,
  collapsed,
  onToggle,
  title,
  children,
}: {
  /** The workspace's 크게 보기 state. */
  expanded: boolean;
  /** 접힌 시트 — the body keeps its state at zero height. */
  collapsed: boolean;
  onToggle: () => void;
  /** The open thread's name in the sheet's header. */
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`talk${expanded ? " talk--docked" : ""}${expanded && collapsed ? " talk--collapsed" : ""}`}
    >
      {expanded && !collapsed && (
        <div className="talk__head">
          <span className="talk__title">{title}</span>
          <Tip label="대화 시트를 접습니다 (⌘.)" side="top" align="end">
            <button
              type="button"
              className="ghost talk__fold"
              aria-label="대화 시트 접기"
              onClick={onToggle}
            >
              <ChevronDownIcon />
            </button>
          </Tip>
        </div>
      )}
      <div className="talk__body">{children}</div>
      {expanded && collapsed && (
        <button type="button" className="talk__pill" onClick={onToggle}>
          이 화면에 말 걸기 <kbd>⌘.</kbd>
        </button>
      )}
    </div>
  );
}
