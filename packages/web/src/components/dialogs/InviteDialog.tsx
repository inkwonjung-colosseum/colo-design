import { useRef } from "react";
import type { InviteImportController } from "../../hooks/use-invite-import";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import type { Daemon } from "../../lib/daemon-client";
import { CloseIcon, KeyIcon } from "../icons";
import { InviteCard } from "../onboarding/InviteCard";
import { Tip } from "../shell/Tip";

/**
 * 작업 화면 위에 뜨는 초대 파일 대화상자 — 창에 초대 파일을 떨어뜨리거나 설정의
 * "초대 파일 열기"로 열린다. 몸통은 시작 화면과 같은 InviteCard 다(확인 · 진행 ·
 * 결과를 그리는 공통 카드). 적용이 도는 동안에는 Escape · 바깥 클릭으로 닫히지
 * 않는다 — 끝을 봐야 하는 진행을 잃게 하지 않기 위해서.
 */
export function InviteDialog({
  daemon,
  controller,
}: {
  daemon: Daemon;
  controller: InviteImportController;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel);
  const { state } = controller;
  // 닫기가 허락되는 상태에서만 Escape 를 단다(useModalEscape 는 닫힘 함수가
  // 없으면 아무것도 하지 않는다).
  const dismissible = state.phase !== "applying";
  useModalEscape(panel, dismissible ? controller.close : () => {});
  if (state.phase === "idle") return null;

  return (
    <div
      className="modal"
      onMouseDown={(e) => e.target === e.currentTarget && dismissible && controller.close()}
    >
      <div
        className="modal__panel modal__panel--invite"
        role="dialog"
        aria-modal="true"
        aria-label="초대 파일"
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal__head">
          <h2 className="modal__title">
            <span className="ic ic--quiet">
              <KeyIcon />
            </span>
            초대 파일
          </h2>
          {dismissible && (
            <Tip label="닫기" side="left">
              <button type="button" className="ghost" aria-label="닫기" onClick={controller.close}>
                <CloseIcon />
              </button>
            </Tip>
          )}
        </header>
        <div className="modal__body">
          <InviteCard
            daemon={daemon}
            state={state}
            onApply={controller.apply}
            onRetry={controller.retry}
            onClose={controller.close}
            onOpenPicker={controller.openPicker}
          />
        </div>
      </div>
    </div>
  );
}
