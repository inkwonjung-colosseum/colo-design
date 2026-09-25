import { useEffect, useState } from "react";
import type { InviteImportState } from "../../hooks/use-invite-import";
import type { Daemon } from "../../lib/daemon-client";
import { L } from "../labels";
import { inviteRowsCopy } from "../lib/invite-rows";
import { AlertIcon, CloseIcon } from "./icons";
import "./onboarding.css";

/**
 * 초대 파일 가져오기의 확인판(U11) — 첫 실행과 다시 받기가 같은 몸통을 쓴다.
 * 셸(NextShell)이 창 어디에 떨어뜨린 파일 · 설정의 열기 · 문제 문장의 안내를
 * 모두 컨트롤러(use-invite-import)로 모으고, 이 판은 그 상태를 줄 세운다:
 * 읽는 중 → 확인(새로 · 바뀜 · 그대로) → 적용 → 결과. 상태와 행동의 주인은
 * 컨트롤러다 — 이 판은 그림만 담는다(옛 InviteCard 와 같은 계약).
 */
export function InviteConfirm({
  daemon,
  state,
  onApply,
  onRetry,
  onClose,
  onOpenPicker,
  onDiscarded,
}: {
  daemon: Daemon;
  state: InviteImportState;
  /** 확인판의 `가져오기` — 이름 칸 초안과, `지금 열기` 를 누른 행의 주소를 함께. */
  onApply: (authorDraft: string, openRepoUrl?: string) => void;
  onRetry: () => void;
  onClose: () => void;
  onOpenPicker: () => void;
  /** 사용자가 이 판에서 파일을 지웠다 — 셸이 `파일 지우기` 줄을 세우지 않는다. */
  onDiscarded: () => void;
}) {
  const [authorDraft, setAuthorDraft] = useState("");
  const [discardState, setDiscardState] = useState<"idle" | "done" | "failed">("idle");

  // 새 확인판이 열리면 지난 판의 흔적을 지운다.
  useEffect(() => {
    if (state.phase === "confirm") {
      setDiscardState("idle");
    }
  }, [state.phase]);

  // Escape 도 나가는 길이다 — 적용이 도는 동안과 팔레트가 위에 떠 있는 동안은 물러선다.
  useEffect(() => {
    if (state.phase === "idle" || state.phase === "applying") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".palette")) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.phase, onClose]);

  if (state.phase === "idle") return null;

  return (
    <div className="nx nx-modal-host">
      <div className="nx-modal-back" role="presentation">
        <div className="nx-modal" role="dialog" aria-modal="true" aria-label={L.invite.title}>
          <div className="nx-mhd">
            <h2>{L.invite.title}</h2>
            {state.phase !== "applying" && (
              <button
                type="button"
                className="nx-ibtn"
                aria-label={L.onboarding.close}
                onClick={onClose}
              >
                <CloseIcon />
              </button>
            )}
          </div>
          <div className="nx-mbody">
            {state.phase === "reading" && <p className="nx-snote">{L.onboarding.inviteOpening}</p>}

            {state.phase === "error" && (
              <>
                <p className="nx-snote nx-ob-d--red" role="alert">
                  {state.error}
                </p>
                <div className="nx-mfoot">
                  <button type="button" className="nx-btn" onClick={onOpenPicker}>
                    {L.invite.otherFile}
                  </button>
                  <button type="button" className="nx-btn nx-btn--ghost" onClick={onClose}>
                    {L.onboarding.close}
                  </button>
                </div>
              </>
            )}

            {state.phase === "confirm" && (
              <ConfirmBody
                daemon={daemon}
                state={state}
                authorDraft={authorDraft}
                discardState={discardState}
                onAuthorDraft={setAuthorDraft}
                onApply={onApply}
                onDiscard={(path) => {
                  void window.coloDesignDesktop?.invite?.discard(path).then(
                    () => {
                      setDiscardState("done");
                      onDiscarded();
                    },
                    () => setDiscardState("failed"),
                  );
                }}
              />
            )}

            {state.phase === "applying" && (
              <>
                <div className="nx-bar" aria-hidden="true">
                  <i />
                </div>
                <p className="nx-snote" role="status">
                  {L.invite.progressing(state.done, state.rows.length)}
                </p>
              </>
            )}

            {state.phase === "done" && (
              <DoneBody daemon={daemon} state={state} onRetry={onRetry} onClose={onClose} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfirmBody({
  daemon,
  state,
  authorDraft,
  discardState,
  onAuthorDraft,
  onApply,
  onDiscard,
}: {
  daemon: Daemon;
  state: Extract<InviteImportState, { phase: "confirm" }>;
  authorDraft: string;
  discardState: "idle" | "done" | "failed";
  onAuthorDraft: (value: string) => void;
  onApply: (authorDraft: string, openRepoUrl?: string) => void;
  onDiscard: (path: string) => void;
}) {
  const copy = inviteRowsCopy(state.rows, L, daemon.projects);
  const added = copy.rows.filter((row) => row.action === "add");
  const updated = copy.rows.filter((row) => row.action === "update");
  const kept = copy.rows.filter((row) => row.action === "keep");
  // 머리 줄의 잇는 수 — 지금 있는 프로젝트에 새로 오는 수만 더한다(바뀜 · 그대로는 셈이 아니라 값).
  const reachTotal = daemon.projects.length + added.length;
  const attention = daemon.repo?.attention ?? daemon.status?.attention ?? null;
  const reconnected = attention?.kind === "reconnect" && attention.what === "github";
  const savedAuthor = daemon.status?.authorName ?? null;
  const askAuthor = !state.invite.authorName && !savedAuthor;
  const discardable = Boolean(state.path && window.coloDesignDesktop?.invite?.discard);

  return (
    <>
      <div className="nx-inv-head">
        <span className="nx-dot nx-dot--green" aria-hidden="true" />
        <span>
          {reconnected ? L.invite.reconnected : L.invite.renewed} {L.invite.reaches(reachTotal)}
        </span>
      </div>

      {added.length > 0 && (
        <>
          <div className="nx-inv-h">{L.invite.added(added.length)}</div>
          <div className="nx-inv-list">
            {added.map((row) => (
              <div key={row.repoUrl} className="nx-inv-row nx-inv-row--new">
                <div className="nx-grow">
                  <b>{row.name}</b>
                  <small>{row.sub}</small>
                </div>
                <button
                  type="button"
                  className="nx-btn nx-btn--pri"
                  onClick={() => onApply(authorDraft, row.repoUrl)}
                >
                  {L.invite.openNow}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {updated.length > 0 && (
        <>
          <div className="nx-inv-h">{L.invite.updated(updated.length)}</div>
          <div className="nx-inv-list">
            {updated.map((row) => (
              <div key={row.repoUrl} className="nx-inv-row">
                <div className="nx-grow">
                  <b>{row.line}</b>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {copy.nothingChanged && <p className="nx-snote">{L.invite.nothingChanged}</p>}

      {kept.length > 0 && (
        <>
          <div className="nx-inv-h">{L.invite.kept(kept.length)}</div>
          <p className="nx-snote">
            {kept.map((row) => row.name).join(" · ")} — {L.invite.keptNote}
          </p>
        </>
      )}
      <p className="nx-snote">{L.invite.mine}</p>

      {state.invite.readme && <p className="nx-snote">{state.invite.readme}</p>}

      {askAuthor && (
        <div className="nx-inv-author">
          <label htmlFor="nx-invite-author">{L.invite.authorLabel}</label>
          <input
            id="nx-invite-author"
            value={authorDraft}
            maxLength={80}
            onChange={(event) => onAuthorDraft(event.target.value)}
          />
        </div>
      )}

      <div className="nx-inv-warn">
        <AlertIcon />
        <span className="nx-grow">
          {discardState === "failed" ? `${L.invite.warn} ${L.invite.deleteFailed}` : L.invite.warn}
        </span>
        {discardable && state.path && (
          <button
            type="button"
            className="nx-btn"
            disabled={discardState !== "idle"}
            onClick={() => onDiscard(state.path as string)}
          >
            {discardState === "done" ? L.invite.deleted : L.invite.deleteFile}
          </button>
        )}
      </div>

      <div className="nx-mfoot">
        <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onApply(authorDraft)}>
          {L.invite.cancel}
        </button>
        <button type="button" className="nx-btn nx-btn--pri" onClick={() => onApply(authorDraft)}>
          {L.invite.apply}
        </button>
      </div>
    </>
  );
}

function DoneBody({
  daemon,
  state,
  onRetry,
  onClose,
}: {
  daemon: Daemon;
  state: Extract<InviteImportState, { phase: "done" }>;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { result } = state;
  const failures = result.results.filter((entry) => !entry.ok);

  // 연결 코드가 거절됐으면 프로젝트는 하나도 건드리지 않은 상태다.
  if (result.tokenError) {
    return (
      <>
        <p className="nx-snote nx-ob-d--red" role="alert">
          {result.tokenError}
        </p>
        <div className="nx-mfoot">
          <button type="button" className="nx-btn" onClick={onClose}>
            {L.onboarding.close}
          </button>
        </div>
      </>
    );
  }

  if (failures.length > 0) {
    return (
      <>
        {failures.map((entry) => (
          <p key={entry.row.project.repoUrl} className="nx-snote nx-ob-d--red" role="alert">
            {entry.row.project.name} — {entry.error}
          </p>
        ))}
        <div className="nx-mfoot">
          <button type="button" className="nx-btn nx-btn--ghost" onClick={onClose}>
            {L.onboarding.close}
          </button>
          <button type="button" className="nx-btn nx-btn--pri" onClick={onRetry}>
            {L.vocab.retry}
          </button>
        </div>
      </>
    );
  }

  const added = state.result.results.filter((entry) => entry.row.action === "add").length;
  return (
    <>
      <div className="nx-inv-head">
        <span className="nx-dot nx-dot--green" aria-hidden="true" />
        <span>
          {L.invite.renewed} {L.invite.reaches(daemon.projects.length)}
        </span>
      </div>
      {added > 0 && <p className="nx-snote">{L.invite.addedNote}</p>}
      {result.reachWarnings.map((warning) => (
        <p key={warning} className="nx-snote nx-ob-d--red" role="alert">
          {warning}
        </p>
      ))}
      <div className="nx-mfoot">
        <button type="button" className="nx-btn nx-btn--pri" onClick={onClose}>
          {L.invite.ok}
        </button>
      </div>
    </>
  );
}
