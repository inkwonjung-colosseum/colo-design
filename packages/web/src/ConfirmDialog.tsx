import { type ReactNode, useEffect, useRef } from "react";
import { CloseIcon } from "./icons";
import { useModalFocus } from "./use-modal-focus";

/**
 * 결함③ (PLAN 0단계) — the one confirm dialog. `window.confirm` 은 이 앱의
 * 어휘 · 테마 · D65 cover 규칙(그릴 수 있는 층은 `.modal` 하나, 뷰는 그 아래로
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
  onConfirm: () => void;
  onClose: () => void;
  /** Between question and buttons: a file list, a warning row. */
  children?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel);
  useEffect(() => {
    panel.current?.focus();
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [onClose]);
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
          <h2 className="modal__title">{title}</h2>
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
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
