import type { HandoffStatus } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import { RUNNING, stageLine } from "./DiffPanel";
import type { Daemon } from "./daemon-client";
import { CheckIcon, CloseIcon, ExternalLinkIcon, LinkIcon } from "./icons";
import { useModalFocus } from "./use-modal-focus";

/**
 * The three words the planner is allowed to know (PLAN D5). GitHub reports a
 * review verdict alongside the request's own state, and both arrive here as
 * `state`; `closed` is the one outcome with no word of its own.
 */
const HANDOFF_STATE_LABEL: Record<HandoffStatus["state"], string> = {
  open: "넘김",
  changes_requested: "변경 요청",
  merged: "반영됨",
  closed: "닫힘",
};

/**
 * 개발자에게 넘기기: the planner reads and edits what the developer will read
 * first, then hands the saved screens over. The title and body are proposed by
 * the shell and owned by the planner from the moment this opens — the panel
 * invents neither, and a field left blank lets the daemon's own proposal win.
 */
export function HandoffPanel({
  daemon,
  proposedTitle,
  proposedBody,
  sessionId,
  onOpenSettings,
  onClose,
}: {
  daemon: Daemon;
  proposedTitle: string;
  proposedBody: string;
  /** The live 화면 thread; a failing gate lands in it as Claude's next task. */
  sessionId: string | null;
  /** D90 ⓑ: pr 실패는 Claude 이 아닌 설정의 문제다 — 여기서 바로 연다. */
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(proposedTitle);
  const [body, setBody] = useState(proposedBody);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const diffStatus = daemon.diffStatus;
  const running = diffStatus !== null && RUNNING.includes(diffStatus.stage);
  const handedOff = diffStatus?.stage === "handed-off";
  const failed = diffStatus?.stage === "failed";
  const handoff = handedOff ? (diffStatus?.handoff ?? null) : null;

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      // A handoff in flight keeps its progress line: ESC only leaves when the
      // daemon is done telling the story.
      if (event.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [onClose, running]);

  /** Opening hands focus to the panel, so Tab and a screen reader start inside. */
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const hand = async () => {
    setError(null);
    try {
      await daemon.api.handoff({
        title: title.trim() || undefined,
        body: body.trim() || undefined,
        sessionId,
      });
    } catch (e) {
      // The dialog stays open on purpose: the reason is usually something the
      // planner can answer (a gate to fix, a token to renew) and then retry.
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the link itself is still one click away.
    }
  };

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal__panel modal__panel--handoff"
        role="dialog"
        aria-modal="true"
        aria-label="개발자에게 넘기기"
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="modal__head">
          <h2 className="modal__title">개발자에게 넘기기</h2>
          <button
            type="button"
            className="ghost"
            aria-label="개발자에게 넘기기 닫기"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="modal__body">
          <p className="hint">
            저장한 화면을 개발자가 받아 검토합니다. 제목과 내용은 개발자가 가장 먼저 읽는 부분이니,
            필요하면 고쳐 주세요.
          </p>

          {diffStatus && (
            <div
              className={
                handedOff ? "notice notice--info" : failed ? "notice notice--error" : "diff__stage"
              }
              role={handedOff || failed ? "status" : undefined}
            >
              <span className="notice__text">{stageLine(diffStatus)}</span>
              {running && <span className="spinner" />}
            </div>
          )}
          {failed && diffStatus?.gate === "pr" && (
            <div className="notice notice--error" data-testid="pr-failure">
              <span className="notice__text">
                레포 검사와 저장까지는 끝냈고, GitHub 풀 리퀘스트 만들기에서 멈췄습니다. 설정에서
                토큰과 레포 주소를 확인한 뒤 다시 넘길 수 있습니다.
              </span>
              <button type="button" className="ghost" onClick={onOpenSettings}>
                설정 열기
              </button>
            </div>
          )}
          {failed && diffStatus?.gate !== "pr" && diffStatus?.detail && (
            <details className="settings__fold">
              <summary>자세히</summary>
              <pre className="diff__fail">
                <code>{diffStatus.detail}</code>
              </pre>
            </details>
          )}

          {error && (
            <div className="notice notice--error">
              <span className="notice__text">{error}</span>
            </div>
          )}

          {handedOff ? (
            handoff && (
              <div className="handoff__done">
                <a className="preview__link" href={handoff.url} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon />
                  넘긴 내용 열기
                </a>
                <button
                  type="button"
                  className="ghost"
                  aria-label="개발자 링크 복사"
                  onClick={() => void copy(handoff.url)}
                >
                  {copied ? (
                    <>
                      <CheckIcon size={11} /> 복사됨
                    </>
                  ) : (
                    <>
                      <LinkIcon size={12} /> 링크 복사
                    </>
                  )}
                </button>
                <span className="handoff__state">{HANDOFF_STATE_LABEL[handoff.state]}</span>
              </div>
            )
          ) : (
            <>
              <label className="setting setting--wide handoff__field">
                <span className="setting__text">
                  <span className="setting__label">제목</span>
                  <span className="setting__hint">개발자가 목록에서 보는 한 줄입니다</span>
                </span>
                <span className="setting__control">
                  <input
                    value={title}
                    placeholder="예: 회원 관리 화면"
                    aria-label="넘길 제목"
                    disabled={running}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </span>
              </label>

              <label className="setting setting--wide handoff__field">
                <span className="setting__text">
                  <span className="setting__label">내용</span>
                  <span className="setting__hint">
                    무엇을 만들었고 무엇을 봐 주면 되는지. 비워 두면 자동으로 채워집니다
                  </span>
                </span>
                <span className="setting__control">
                  <textarea
                    className="handoff__body"
                    value={body}
                    placeholder="예: 기획서의 목록·빈 상태·오류 상태를 만들었습니다."
                    aria-label="넘길 내용"
                    disabled={running}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </span>
              </label>
            </>
          )}

          <div className="settings__row">
            {handedOff ? (
              <button type="button" className="primary" onClick={onClose}>
                닫기
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={running}
                  onClick={() => void hand()}
                >
                  {running ? "넘기는 중…" : "개발자에게 넘기기"}
                </button>
                <button type="button" className="ghost" disabled={running} onClick={onClose}>
                  취소
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
