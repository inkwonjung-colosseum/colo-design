import { type ReactNode, useEffect, useRef } from "react";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import { CloseIcon, WarnIcon } from "../icons";

/**
 * The one confirm dialog. `window.confirm` 은 이 앱의
 * 어휘 · 테마 · cover 규칙(그릴 수 있는 층은 `.modal` 하나, 뷰는 그 아래로
 * 내려간다) 모두 밖이므로, 프로젝트 지우기 대화상자의 클래스를 그대로 빌려
 * 세 군데(변경 버리기 · 대화 삭제 · 접속 주소 지우기)가 같은 그릇을 쓴다.
 * Focus and Escape come with it, like every other `.modal` panel here.
 */
export function ConfirmDialog({
  title,
  body,
  hint,
  confirmLabel,
  cancelLabel = "취소",
  alt,
  onConfirm,
  onClose,
  children,
}: {
  /** The h2 and the screen reader's name — what the planner is deciding about. */
  title: string;
  /** The question. Strong the noun the decision is about, like the others do. */
  body: ReactNode;
  /** The one consequence line under the question. */
  hint?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /**
   * A second, non-destructive way out (the planner discovers
   * 치워두기 at the moment of throwing away) — a `primary` button between
   * 취소 and the destructive confirm. Absent elsewhere, unchanged layout.
   */
  alt?: { label: string; onAlt: () => void };
  onConfirm: () => void;
  onClose: () => void;
  /** Between question and buttons: a file list, a warning row. */
  children?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel);
  useModalEscape(panel, onClose);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  return (
    <div
      className="modal"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="modal__panel sidebar__remove"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal__head">
          <h2 className="modal__title">
            <span className="ic ic--danger">
              <WarnIcon />
            </span>
            {title}
          </h2>
          <button type="button" className="ghost" aria-label={`${title} 닫기`} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <p className="sidebar__removetext">{body}</p>
        {children}
        {hint && <p className="sidebar__removehint">{hint}</p>}
        <div className="sidebar__removebtns">
          <button type="button" className="ghost" onClick={onClose}>
            {cancelLabel}
          </button>
          {alt && (
            <button type="button" className="primary" onClick={alt.onAlt}>
              {alt.label}
            </button>
          )}
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
