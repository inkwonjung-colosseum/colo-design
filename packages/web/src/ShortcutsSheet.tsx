import { APP_SHORTCUTS } from "@colo-design/protocol";
import { useEffect, useRef } from "react";
import { CloseIcon } from "./icons";
import { useModalFocus } from "./use-modal-focus";

/**
 * ⌘/ 단축키 시트 (PLAN D92) — 단축키의 목록은 언제나 열어 볼 수 있는 곳에 산다.
 * 행은 protocol 의 APP_SHORTCUTS, 데스크톱 앱 메뉴가 읽는 상수와 같은 한 벌이다.
 */
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [open, onClose]);

  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, open);
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal__panel shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="단축키"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="modal__head">
          <h2 className="modal__title">단축키</h2>
          <button type="button" className="ghost" aria-label="단축키 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="modal__body">
          <ul className="shortcuts__list">
            {APP_SHORTCUTS.map((shortcut) => (
              <li key={shortcut.id} className="shortcuts__row">
                <span className="shortcuts__label">{shortcut.label}</span>
                <kbd className="shortcuts__keys">{shortcut.keys}</kbd>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
