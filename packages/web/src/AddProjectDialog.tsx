import { useEffect, useRef } from "react";
import type { Daemon } from "./daemon-client";
import { RepoPicker } from "./RepoPicker";
import { CloseIcon } from "./icons";

/**
 * 프로젝트 추가, for a planner who already has one (PLAN D16). The same
 * picker the empty workspace shows inline, in the dialog the header's
 * `+ 새 프로젝트` opens — one component, two places, so the second project
 * is added exactly the way the first one was.
 */
export function AddProjectDialog({
  daemon,
  onClose,
  onOpenSettings,
}: {
  daemon: Daemon;
  onClose: () => void;
  onOpenSettings?: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label="프로젝트 추가"
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal__head">
          <h2 className="modal__title">프로젝트 추가</h2>
          <button type="button" className="ghost" aria-label="프로젝트 추가 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="modal__body">
          <p className="hint">화면을 만들 레포를 고르세요.</p>
          <RepoPicker
            daemon={daemon}
            onCreated={onClose}
            {...(onOpenSettings ? { onOpenSettings } : {})}
          />
        </div>
      </div>
    </div>
  );
}
