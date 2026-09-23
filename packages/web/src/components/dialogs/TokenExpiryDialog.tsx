import { useRef, useState } from "react";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import type { Daemon } from "../../lib/daemon-client";
import { requestInvitePicker } from "../../lib/invite-bus";
import { CloseIcon, KeyIcon } from "../icons";
import { Tip } from "../shell/Tip";

/**
 * 연결 코드 만료 카드 — 데몬 자신의 GitHub 읽기가 401 을 본
 * 순간(status.githubAuthExpired) 열리고, 새 코드의 게이트가 통과하면 닫힌다.
 *
 * 수정의 길은 초대 파일이다: 개발자에게 새 초대장을 받아 이 창에 끌어다 놓거나
 * 아래 버튼으로 연다(통로가 Shell 의 가져오기 컨트롤러로 넘긴다). 붙여넣기 칸은
 * 개발 실행에서만 남는다 — 코드 그 자체를 다루는 말은 개발자의 어휘다.
 */
export function TokenExpiryDialog({
  daemon,
  onDismiss,
}: {
  daemon: Daemon;
  /** 나가는 길 — 이 만료 국면 동안만 닫는다. 회복 뒤 새 401 은 다시 연다. */
  onDismiss: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 붙여넣기 칸은 개발 실행에서만 — 실사용의 길은 초대 파일이다.
  const devMachine = daemon.status?.dev === true;
  useModalEscape(panel, onDismiss);

  // 거절돼도 초안은 살려 둔다 — 코드의 오타 고치기가 이 칸이 존재하는 이유의
  // 절반이다(GitHubTokenForm 의 write-only 규칙과 같은 판정). 개발 실행의 몫이다.
  const reconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      // The reply is the recomputed gate, so a refused token arrives as a
      // failed step, not as a thrown request.
      const step = await daemon.api.githubTokenSet(draft.trim());
      if (step.status !== "pass") setError(step.detail);
      else onDismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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
          {devMachine && (
            <>
              <div className="ghtoken__row">
                <span className="ic ic--quiet">
                  <KeyIcon />
                </span>
                <input
                  type="password"
                  value={draft}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="새 연결 코드 붙여넣기"
                  aria-label="새 GitHub 연결 코드"
                  disabled={busy}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && draft.trim() && !busy) void reconnect();
                  }}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={!draft.trim() || busy}
                  onClick={() => void reconnect()}
                >
                  {busy ? "다시 연결하는 중…" : "다시 연결"}
                </button>
              </div>
              {error && (
                <div className="notice notice--error">
                  <span className="notice__text">{error}</span>
                </div>
              )}
            </>
          )}
          <p className="hint tokencard__foot">새 초대 파일은 개발자에게 요청하세요.</p>
        </div>
      </div>
    </div>
  );
}
