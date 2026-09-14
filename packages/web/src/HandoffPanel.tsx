import type { HandoffStatus } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "./components";
import { RUNNING, stageLine } from "./DiffPanel";
import type { Daemon } from "./daemon-client";
import { mergeHandoffBody } from "./handoff-draft";
import { CloseIcon, ExternalLinkIcon, FileIcon, HandoffIcon, LinkIcon, StepsIcon } from "./icons";
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
  const [drafting, setDrafting] = useState(false);
  /** Whether the text on screen is Claude's — said out loud under the fields. */
  const [drafted, setDrafted] = useState(false);
  /** Once the planner types, the draft stops landing in that field. */
  const titleTouched = useRef(false);
  const bodyTouched = useRef(false);
  const diffStatus = daemon.diffStatus;
  const running = diffStatus !== null && RUNNING.includes(diffStatus.stage);
  const handedOff = diffStatus?.stage === "handed-off";
  const failed = diffStatus?.stage === "failed";
  const handoff = handedOff ? (diffStatus?.handoff ?? null) : null;
  /**
   * The call rides the STABLE `api`, not the `daemon` prop: the client hands
   * out a fresh wrapper every render, and a websocket message landing while
   * this dialog is open would otherwise cancel an in-flight draft — a real
   * Claude turn — and ask it again from scratch.
   */
  const { api } = daemon;

  // 비개발자 넘기기: the dialog opens on the browser's proposal — the project
  // name and the declared screens — and asks the daemon for the sentences a
  // developer reads first. Empty answer (no CLI, timeout, refusal) leaves the
  // proposal exactly as it was, so the dialog is never worse than before.
  useEffect(() => {
    let cancelled = false;
    setDrafting(true);
    api
      .handoffDraft()
      .then((draft) => {
        if (cancelled || draft.source !== "claude") return;
        if (draft.title && !titleTouched.current) setTitle(draft.title);
        if (draft.body && !bodyTouched.current) setBody(mergeHandoffBody(draft.body, proposedBody));
        if (draft.title || draft.body) setDrafted(true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDrafting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, proposedBody]);
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
          <h2 className="modal__title">
            <span className="ic">
              <HandoffIcon />
            </span>{" "}
            개발자에게 넘기기
          </h2>
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
            필요하면 고쳐 주세요. 한 번 넘긴 사이클은 개발자가 반영한 뒤 되돌리기 기록이 지워지니,
            반영 전까지만 이 앱에서 되돌릴 수 있습니다.
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
                저장까지는 끝냈고, 개발자에게 넘기기에서 멈췄습니다. 설정에서 토큰과 레포 주소를
                확인한 뒤 다시 넘길 수 있습니다.
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
                <CopyButton value={handoff.url} label="링크 복사" icon={<LinkIcon size={12} />} />
                <span className="handoff__state">{HANDOFF_STATE_LABEL[handoff.state]}</span>
              </div>
            )
          ) : (
            <>
              {drafting && <p className="hint">개발자가 읽을 제목과 내용을 만드는 중…</p>}
              <label className="setting setting--wide handoff__field">
                <span className="setting__text">
                  <span className="setting__label">
                    <span className="ic ic--quiet ic--sm">
                      <FileIcon />
                    </span>{" "}
                    제목
                  </span>
                  <span className="setting__hint">개발자가 목록에서 보는 한 줄입니다</span>
                </span>
                <span className="setting__control">
                  <input
                    value={title}
                    placeholder="예: 회원 관리 화면"
                    aria-label="넘길 제목"
                    disabled={running}
                    onChange={(e) => {
                      titleTouched.current = true;
                      setTitle(e.target.value);
                    }}
                  />
                </span>
              </label>

              <label className="setting setting--wide handoff__field">
                <span className="setting__text">
                  <span className="setting__label">
                    <span className="ic ic--quiet ic--sm">
                      <StepsIcon />
                    </span>{" "}
                    내용
                  </span>
                  <span className="setting__hint">
                    무엇을 만들었고 무엇을 봐 주면 되는지. Claude가 저장한 내용을 읽고 먼저 채웁니다
                    — 고쳐 주세요
                  </span>
                </span>
                <span className="setting__control">
                  <textarea
                    className="handoff__body"
                    value={body}
                    placeholder="예: 기획서의 목록·빈 상태·오류 상태를 만들었습니다."
                    aria-label="넘길 내용"
                    disabled={running}
                    onChange={(e) => {
                      bodyTouched.current = true;
                      setBody(e.target.value);
                    }}
                  />
                </span>
              </label>
              {drafted && <p className="hint">제목과 내용은 Claude가 채웠습니다</p>}
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
                  <span className="ic">
                    <HandoffIcon />
                  </span>
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
