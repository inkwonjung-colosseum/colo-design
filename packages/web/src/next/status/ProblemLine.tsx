import { useState } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { requestInvitePicker } from "../../lib/invite-bus";
import { AlertIcon, MailIcon, PlugIcon } from "../chat/icons";
import { L } from "../labels";
import { problemFor } from "../lib/problem";

/**
 * 문제 문장 한 줄(README「화면의 문제 문장은 셋이다」) — 상태 줄 바로 아래, 대화와
 * 미리보기에 걸친 한 줄(목업의 `.problem`). 셋째(`다시 연결이 필요해요`)만 사람의 손이 필요하고 버튼이 선다.
 * 문제 문장이 없으면 방금 가져온 초대 파일의 `파일 지우기 · 나중에` 줄(U11)이
 * 그 자리를 쓴다.
 */
export function ProblemLine({
  daemon,
  invitePath,
  onClearInvite,
  onToast,
}: {
  daemon: Daemon;
  /** 지울 수 있는 초대 파일의 자리 — 셸의 이동 상태가 쥔다. */
  invitePath: string | null;
  onClearInvite: () => void;
  onToast: (text: string) => void;
}) {
  const problem = problemFor(daemon.status, daemon.repo, L);
  const [login, setLogin] = useState<"idle" | "busy" | "started">("idle");

  if (problem) {
    const icon =
      problem.kind === "fixing" ? (
        <i className="nx-spin" aria-hidden="true" />
      ) : problem.kind === "notified" ? (
        <MailIcon />
      ) : (
        <PlugIcon />
      );
    return (
      <div className={`nx-problem nx-problem--${problem.kind}`} role="status">
        {icon}
        <b>{problem.title}</b>
        <span>{problem.body}</span>
        {problem.action === "invite" && (
          <button
            type="button"
            className="nx-btn nx-btn--sm nx-btn--pri"
            onClick={() => requestInvitePicker()}
          >
            {L.problem.openInvite}
          </button>
        )}
        {problem.action === "login" && (
          <button
            type="button"
            className="nx-btn nx-btn--sm nx-btn--pri"
            disabled={login === "busy"}
            onClick={() => {
              // 처음은 브라우저 로그인을 몰고, 그 뒤는 다시 확인이다.
              const first = login === "idle";
              setLogin("busy");
              void (first ? daemon.api.onboardingFix("login-claude") : daemon.api.refreshStatus())
                .then(() => setLogin("started"))
                .catch(() => setLogin(first ? "idle" : "started"));
            }}
          >
            {login === "busy"
              ? L.chat.checking
              : login === "started"
                ? L.chat.recheck
                : L.problem.loginInBrowser}
          </button>
        )}
      </div>
    );
  }

  if (!invitePath) return null;
  const discard = window.coloDesignDesktop?.invite?.discard;
  return (
    <div className="nx-problem nx-problem--notified" role="status">
      <AlertIcon />
      <b>{L.inviteCleanup.title}</b>
      <span>{L.inviteCleanup.body}</span>
      {discard && (
        <button
          type="button"
          className="nx-btn nx-btn--sm nx-btn--pri"
          onClick={() => {
            void discard(invitePath)
              .then(() => onToast(L.inviteCleanup.removed))
              .catch(() => onToast(L.inviteCleanup.removeFailed))
              .finally(onClearInvite);
          }}
        >
          {L.inviteCleanup.remove}
        </button>
      )}
      <button type="button" className="nx-btn nx-btn--sm nx-btn--ghost" onClick={onClearInvite}>
        {L.inviteCleanup.later}
      </button>
    </div>
  );
}
