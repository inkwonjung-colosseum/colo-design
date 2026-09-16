import { APP_SHORTCUTS, type AppShortcut } from "@colo-design/protocol";
import { useEffect, useRef } from "react";
import { useModalFocus } from "../../hooks/use-modal-focus";
import { CloseIcon, CommandIcon } from "../icons";
import { Tip } from "../shell/Tip";

/**
 * ⌘/ 단축키 시트 — 단축키의 목록은 언제나 열어 볼 수 있는 곳에 산다.
 * 행은 protocol 의 APP_SHORTCUTS, 데스크톱 앱 메뉴가 읽는 상수와 같은 한 벌이다.
 */

/**
 * ⌘⇧P — the workspace's own chord, not a menu accelerator, so
 * it lives here only: APP_SHORTCUTS 는 데스크톱 메뉴가 같이 읽는 상수다.
 */
const PIN_MODE_SHORTCUT: AppShortcut = { id: "pin-mode", label: "핀 모드", keys: "⌘⇧P" };

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
          <h2 className="modal__title">
            <span className="ic ic--quiet">
              <CommandIcon />
            </span>
            단축키
          </h2>
          <Tip label="단축키 닫기" side="left">
            <button type="button" className="ghost" aria-label="단축키 닫기" onClick={onClose}>
              <CloseIcon />
            </button>
          </Tip>
        </header>
        <div className="modal__body">
          <ul className="shortcuts__list">
            {APP_SHORTCUTS.flatMap((shortcut) =>
              // 핀 찍기(⌥+클릭) 곁에 핀 모드의 자리 — 같은 주제의 두 행이다.
              shortcut.id === "pin" ? [shortcut, PIN_MODE_SHORTCUT] : [shortcut],
            ).map((shortcut) => (
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
