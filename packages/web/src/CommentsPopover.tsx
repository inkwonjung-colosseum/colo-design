import { useEffect } from "react";
import type { CommentItem } from "./daemon-client";
import { stateLabel, timeAgo } from "./format";
import { CloseIcon } from "./icons";

/**
 * 코멘트 기록 (PLAN D57): every comment the planner's pins left behind, the
 * resolved ones still in the list. A row can go 미해결 ↔ 해결 and be sent to
 * Claude again — the words ride the same shell path the pins used, so the
 * shell picks the thread. The list itself lives with the caller: the badge
 * on the preview toolbar and the stepper's why line read the same data even
 * while this is closed.
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
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose]);

  if (!open) return null;

  const unresolved = (items ?? []).filter((item) => !item.resolved).length;

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__panel" role="dialog" aria-modal="true" aria-label="코멘트 기록">
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
                ? `미해결 ${unresolved}건 — 해결된 코멘트도 목록에 남습니다.`
                : "다 해결된 목록입니다. 미리보기에서 화면을 찍어 새 코멘트를 보낼 수 있습니다."}
          </p>
          {items !== null && items.length === 0 && (
            <p className="hint">
              아직 기록된 코멘트가 없습니다. 코멘트 모드를 켜고 미리보기의 요소를 찍어 보내면 여기에 쌓입니다.
            </p>
          )}
          {items !== null && items.length > 0 && (
            <ul className="diff__files">
              {items.map((item) => (
                <li className="diff__file" key={item.id}>
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
                    <button
                      type="button"
                      className="ghost"
                      title="이 코멘트를 열려 있는 대화에서 Claude에게 다시 보냅니다"
                      onClick={() => onResend(item)}
                    >
                      다시 보내기
                    </button>
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
