import { useRef, useState } from "react";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import type { Daemon } from "../../lib/daemon-client";
import { CloseIcon, KeyIcon } from "../icons";
import { GITHUB_TOKEN_URL } from "../onboarding/GitHubTokenForm";
import { Tip } from "../shell/Tip";

/**
 * 토큰 만료 카드 — 데몬 자신의 GitHub 읽기가
 * 401 을 본 순간(status.githubAuthExpired) 열리고, 새 토큰의 게이트가 통과하면
 * 닫힌다. 저장 검토의 `push-auth` 실패 줄과 설정 연결 그룹이 같은 수정을
 * 제공하므로 이 카드는 그 자리를 대지 않는다 — 나머지 한 종(401)을 묻지 않고
 * 눈앞에 두는 일이 이 카드의 전부다.
 *
 * 셋을 구분해 말한다: 이 카드는 GitHub 토큰의 만료다. 게이트
 * 자체의 부재(토큰 없음)는 마법사·첫 화면의 토큰 단계가, 데몬 페어링 토큰의
 * 끊김은 연결 화면이 각자 말한다 — 푸터의 한 줄이 그 경계를 명시해 잘못된
 * 토큰을 붙여넣는 일을 막는다.
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

  useModalEscape(panel, onDismiss);

  // 거절돼도 초안은 살려 둔다 — 40 자 토큰의 오타 고치기가 이 카드가 존재하는
  // 이유의 절반이다(GitHubTokenForm 의 write-only 규칙과 같은 판정).
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
        aria-label="연결이 끊겼어요"
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal__head">
          <h2 className="modal__title">
            <span className="ic ic--warn">
              <KeyIcon />
            </span>
            연결이 끊겼어요
          </h2>
          <Tip label="나중에 바꾸기" side="left">
            <button type="button" className="ghost" aria-label="나중에 바꾸기" onClick={onDismiss}>
              <CloseIcon />
            </button>
          </Tip>
        </header>
        <div className="modal__body tokencard">
          <p className="tokencard__lede">
            GitHub 토큰이 만료됐거나 바뀌었어요. 새 토큰을 붙여넣으면 바로 이어서 작업할 수 있어요 —{" "}
            <strong>대화와 저장된 작업은 그대로 남아 있어요.</strong>
          </p>
          <div className="ghtoken__row">
            <span className="ic ic--quiet">
              <KeyIcon />
            </span>
            <input
              type="password"
              autoFocus
              value={draft}
              spellCheck={false}
              autoComplete="off"
              placeholder="새 GitHub 토큰 붙여넣기"
              aria-label="새 GitHub 개인 액세스 토큰"
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
            <a className="ghlink" href={GITHUB_TOKEN_URL} target="_blank" rel="noreferrer">
              토큰 만들기 ↗
            </a>
          </div>
          {error && (
            <div className="notice notice--error">
              <span className="notice__text">{error}</span>
            </div>
          )}
          <p className="hint tokencard__foot">
            토큰은 개발자에게 다시 받으면 됩니다. 앱 화면을 여는 연결 토큰(페어링)과는 별개예요.
          </p>
        </div>
      </div>
    </div>
  );
}
