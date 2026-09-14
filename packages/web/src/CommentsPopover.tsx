import { useEffect, useRef } from "react";
import type { CommentItem } from "./daemon-client";
import { stateLabel, timeAgo } from "./format";
import { CloseIcon, CommentsIcon } from "./icons";
import { useModalFocus } from "./use-modal-focus";

/**
 * 코멘트 기록 (PLAN D57 → 자동 정리): the log of what the planner's pins
 * asked Claude. The send IS the delivery — a recorded comment leaves the
 * screen with its turn — so this list reads as history, not work to do.
 * Nothing to toggle, nothing to resend: another ask goes through the thread
 * like any other message. A row does lead somewhere, but only back to the
 * screen it was written on — a door, not a task.
 *
 * Reuses the 저장 기록 drawer's classes — same dialog, same rows, one visual
 * language for "things saved beside the work".
 */
export function CommentsPopover({
  open,
  items,
  error,
  native,
  titleFor,
  onOpen,
  onClose,
}: {
  open: boolean;
  /** The recorded comments; null while the first read is still out. */
  items: CommentItem[] | null;
  /** Why the last read failed, if it did. */
  error: string | null;
  /**
   * Whether the preview is the desktop's view — the only place the pin
   * overlay lives. The browser dev path has no pins, so advising
   * ⌥+클릭 there would point at a gesture that does nothing.
   */
  native?: boolean;
  /**
   * The title the repo declared for a screen id, or null when it declares it
   * no longer. A planner names screens by their titles, not their routes
   * (D38) — the same reason the pull request body writes them that way.
   */
  titleFor: (screen: string) => string | null;
  /** Take the planner to the screen this comment was written on. */
  onOpen: (item: CommentItem) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [open, onClose]);

  /** Opening hands focus to the panel, so Tab and a screen reader start inside. */
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, open);
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label="코멘트 기록"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="modal__head">
          <h2 className="modal__title">
            <span className="ic">
              <CommentsIcon />
            </span>{" "}
            코멘트 기록
          </h2>
          <button type="button" className="ghost" aria-label="코멘트 기록 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="modal__body">
          <p className="hint">
            {items === null
              ? "코멘트를 읽어 오는 중…"
              : native
                ? "미리보기에서 보낸 코멘트의 기록입니다. 다시 바라는 것이 있으면 대화에서 말씀해 주세요."
                : "미리보기에서 보낸 코멘트의 기록입니다."}
          </p>
          {items !== null && items.length === 0 && (
            <div className="menuempty">
              <span className="ic">
                <CommentsIcon />
              </span>
              <p className="hint">
                {native
                  ? "아직 기록된 코멘트가 없습니다. 미리보기에서 ⌥+클릭으로 요소를 찍어 보내면 여기에 쌓입니다."
                  : "아직 기록된 코멘트가 없습니다. 코멘트 핀은 데스크톱 앱의 미리보기에서 쓸 수 있습니다."}
              </p>
            </div>
          )}
          {items !== null && items.length > 0 && (
            <ul className="diff__files">
              {items.map((item) => {
                const name = titleFor(item.screen) ?? item.screen;
                return (
                  <li className="diff__file" key={item.id}>
                    {/* A button, but not a thing to DO: the row navigates back
                        to the screen the pin was placed on. The record stays
                        history — 자동 정리 leaves no resolve toggle and no
                        resend here. */}
                    <button
                      type="button"
                      className="diff__filerow diff__filerow--link"
                      aria-label={`${name} 화면 보기`}
                      onClick={() => onOpen(item)}
                    >
                      <span className="diff__path" title={item.text}>
                        {name} · {stateLabel(item.state)} · {item.elementText || "화면의 요소"}
                      </span>
                      <span className="diff__count">{timeAgo(Date.parse(item.at))}</span>
                    </button>
                    <p className="hint">{item.text || "(메모 없음)"}</p>
                  </li>
                );
              })}
            </ul>
          )}
          {error && (
            <div className="notice notice--error">
              <span className="notice__text">{error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
