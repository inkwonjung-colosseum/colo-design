import { useEffect, useRef } from "react";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import type { Daemon } from "../../lib/daemon-client";
import { CloseIcon, FolderPlusIcon } from "../icons";
import { RepoPicker } from "../onboarding/RepoPicker";

/**
 * 프로젝트 추가, for a planner who already has one. The same
 * picker the empty workspace shows inline, in the dialog the header's
 * `+ 새 프로젝트` opens — one component, two places, so the second project
 * is added exactly the way the first one was.
 */
export function AddProjectDialog({ daemon, onClose }: { daemon: Daemon; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel);

  useModalEscape(panel, onClose);

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
          <h2 className="modal__title">
            <span className="ic">
              <FolderPlusIcon />
            </span>
            프로젝트 추가
          </h2>
          <button type="button" className="ghost" aria-label="프로젝트 추가 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="modal__body">
          <p className="hint">화면을 만들 레포를 고르세요.</p>
          <RepoPicker daemon={daemon} onCreated={onClose} />
        </div>
      </div>
    </div>
  );
}
