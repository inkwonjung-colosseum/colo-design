import { useEffect, useRef, useState } from "react";
import type { CommentItem } from "./daemon-client";
import { stateLabel, timeAgo } from "./format";
import { CloseIcon } from "./icons";
import { useModalFocus } from "./use-modal-focus";

/**
 * 코멘트 기록 (PLAN D57 → D78): every comment the planner's pins left behind.
 * 기록된 핀은 이제 화면 위에도 산다 — this popover is the list side: 미해결이
 * 기본이고, `해결된 것 보기` 를 켜면 해결된 행도 회색으로 함께 읽는다. A row
 * can go 미해결 ↔ 해결 and be sent to Claude again — the words ride the same
 * shell path the pins used, so the shell picks the thread.
 *
 * Reuses the 저장 기록 drawer's classes — same dialog, same rows, one visual
 * language for "things saved beside the work".
 */
export function CommentsPopover({
  open,
  items,
  error,
  busyId,
  onClose,
  onResolve,
  onResend,
}: {
  open: boolean;
  /** The recorded comments; null while the first read is still out. */
  items: CommentItem[] | null;
  /** Why the last read or write failed, if it did. */
  error: string | null;
  /** The row with a resolve toggle in flight, if any. */
  busyId?: string | null;
  onClose: () => void;
  /** Toggle a comment's 해결 state; the caller refreshes the list. */
  onResolve: (id: string, resolved: boolean) => void;
  /** Send one recorded comment to Claude again, on the working thread. */
  onResend: (item: CommentItem) => void;
}) {
  /** D78: 해결된 것 보기 — off by default, the list reads as work to do. */
  const [showResolved, setShowResolved] = useState(false);
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

  const unresolved = (items ?? []).filter((item) => !item.resolved).length;
  const resolvedCount = (items ?? []).length - unresolved;
  const shown = (items ?? []).filter((item) => showResolved || !item.resolved);

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
          <h2 className="modal__title">코멘트 기록</h2>
          <button type="button" className="ghost" aria-label="코멘트 기록 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="modal__body">
          <p className="hint">
            {items === null
              ? "코멘트를 읽어 오는 중…"
              : unresolved > 0
                ? `미해결 ${unresolved}건 — 기록된 핀은 미리보기 화면 위에도 남아 있습니다.`
                : "다 해결된 목록입니다. 미리보기에서 ⌥+클릭으로 새 코멘트를 보낼 수 있습니다."}
          </p>
          {resolvedCount > 0 && (
            <label className="comments__showresolved">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(event) => setShowResolved(event.target.checked)}
              />
              해결된 것 보기 ({resolvedCount})
            </label>
          )}
          {items !== null && items.length === 0 && (
            <p className="hint">
              아직 기록된 코멘트가 없습니다. 미리보기에서 ⌥+클릭으로 요소를 찍어 보내면 여기에
              쌓입니다.
            </p>
          )}
          {items !== null && shown.length > 0 && (
            <ul className="diff__files">
              {shown.map((item) => (
                <li
                  className={`diff__file${item.resolved ? " diff__file--resolved" : ""}`}
                  key={item.id}
                >
                  <div className="diff__filerow">
                    <span className="diff__path" title={item.text}>
                      {item.screen} · {stateLabel(item.state)} · {item.elementText || "화면의 요소"}
                    </span>
                    <span className="diff__count">{timeAgo(Date.parse(item.at))}</span>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busyId === item.id}
                      onClick={() => onResolve(item.id, !item.resolved)}
                    >
                      {item.resolved ? "미해결로" : "해결"}
                    </button>
                    {!item.resolved && (
                      <button
                        type="button"
                        className="ghost"
                        title="이 코멘트를 열려 있는 대화에서 Claude에게 다시 보냅니다"
                        onClick={() => onResend(item)}
                      >
                        다시 보내기
                      </button>
                    )}
                  </div>
                  <p className="hint">{item.text}</p>
                </li>
              ))}
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
