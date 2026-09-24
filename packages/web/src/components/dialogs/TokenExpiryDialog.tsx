import { useRef } from "react";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import { requestInvitePicker } from "../../lib/invite-bus";
import { CloseIcon, KeyIcon } from "../icons";
import { Tip } from "../shell/Tip";

/**
 * 연결 코드 만료 카드 — 데몬 자신의 GitHub 읽기가 401 을 본
 * 순간(status.githubAuthExpired) 열리고, 새 코드의 게이트가 통과하면 닫힌다.
 *
 * 수정의 길은 초대 파일뿐이다: 개발자에게 새 초대장을 받아 이 창에 끌어다 놓거나
 * 아래 버튼으로 연다(통로가 Shell 의 가져오기 컨트롤러로 넘긴다).
 */
export function TokenExpiryDialog({
  onDismiss,
}: {
  /** 나가는 길 — 이 만료 국면 동안만 닫는다. 회복 뒤 새 401 은 다시 연다. */
  onDismiss: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel);
  useModalEscape(panel, onDismiss);

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onDismiss()}>
      <div
        className="modal__panel modal__panel--token"
        role="alertdialog"
        aria-modal="true"
        aria-label="GitHub 연결이 만료됐어요"
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal__head">
          <h2 className="modal__title">
            <span className="ic ic--warn">
              <KeyIcon />
            </span>
            GitHub 연결이 만료됐어요
          </h2>
          <Tip label="나중에 바꾸기" side="left">
            <button type="button" className="ghost" aria-label="나중에 바꾸기" onClick={onDismiss}>
              <CloseIcon />
            </button>
          </Tip>
        </header>
        <div className="modal__body tokencard">
          <p className="tokencard__lede">
            개발자에게 받은 연결 코드가 만료됐거나 바뀌었어요. 개발자에게 새 초대 파일을 받아 이
            창에 끌어다 놓거나 아래 버튼으로 여세요 —{" "}
            <strong>대화와 저장된 작업은 그대로 남아 있어요.</strong>
          </p>
          <div className="onboarding__fixrow">
            <button
              type="button"
              className="primary"
              onClick={() => {
                // 고르기 창을 연 뒤 이 카드는 물러난다 — 가져오기의 확인 카드가 이어받는다.
                requestInvitePicker();
                onDismiss();
              }}
            >
              초대 파일 열기
            </button>
          </div>
          <p className="hint tokencard__foot">새 초대 파일은 개발자에게 요청하세요.</p>
        </div>
      </div>
    </div>
  );
}
