import { repoKey } from "@colo-design/protocol";
import { useState } from "react";
import type { InviteImportState } from "../../hooks/use-invite-import";
import type { Daemon } from "../../lib/daemon-client";

/**
 * 초대 파일 가져오기의 카드 — 확인 · 진행 · 결과를 그리는 공통 몸통. 시작 화면
 * (StartFlow)은 본문에 싣고, 작업 화면은 대화상자(InviteDialog) 안에 싣는다.
 * 상태와 행동은 컨트롤러(use-invite-import)가 쥐고 이 카드는 그림만 담는다.
 */
export function InviteCard({
  daemon,
  state,
  onApply,
  onRetry,
  onClose,
  onOpenPicker,
}: {
  daemon: Daemon;
  state: InviteImportState;
  /** 확인 카드의 "초대 받기" — 이름 칸 초안을 건네며 부른다. */
  onApply: (authorDraft: string) => void;
  onRetry: () => void;
  onClose: () => void;
  onOpenPicker: () => void;
}) {
  /** 이름 칸의 초안 — 초대장과 기계 어느 쪽도 이름을 정해 주지 않았을 때만 그려진다. */
  const [authorDraft, setAuthorDraft] = useState("");
  const savedAuthor = daemon.status?.authorName ?? null;

  if (state.phase === "idle") return null;

  if (state.phase === "reading") {
    return (
      <div className="onboarding__invite" data-testid="invite-card">
        <p className="onboarding__detail">초대 파일을 읽는 중…</p>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="onboarding__invite" data-testid="invite-card">
        <div className="notice notice--error">
          <span className="notice__text">{state.error}</span>
        </div>
        <div className="onboarding__fixrow">
          <button type="button" className="primary" onClick={onOpenPicker}>
            다른 파일 열기
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === "confirm") {
    const { invite, rows } = state;
    const anyApproved = rows.some((row) => row.project.approveCommands);
    return (
      <div className="onboarding__invite" data-testid="invite-card">
        <p className="onboarding__detail">
          초대 파일을 읽었습니다 — 프로젝트 {rows.length}개를 연결합니다.
        </p>
        <ul className="invitecard__rows">
          {rows.map((row) => (
            <li key={row.project.repoUrl} className="invitecard__row">
              <span className="invitecard__rowname">{row.project.name}</span>
              <span className="invitecard__rowrepo">{repoLabel(row.project.repoUrl)}</span>
              {row.action === "add" ? (
                <span className="invitecard__badge">새로 추가</span>
              ) : (
                <span className="invitecard__badge invitecard__badge--update">
                  이미 있음 · 기본 가지와 리뷰어만 맞춥니다({row.currentName})
                </span>
              )}
            </li>
          ))}
        </ul>
        {invite.readme && <p className="hint">{invite.readme}</p>}
        {anyApproved && (
          <p className="hint">이 레포의 설치 · 미리보기 명령 실행을 개발자가 미리 허용했습니다.</p>
        )}
        {/* 이름은 초대장이 정한다 — 정하지 않았을 때만, 그리고 이 기계에도 없을 때만 묻는다. */}
        {!invite.authorName && !savedAuthor && (
          <label className="onboarding__author" htmlFor="invite-author">
            <span className="onboarding__authorlabel">이 작업에 적을 이름 (선택)</span>
            <input
              id="invite-author"
              value={authorDraft}
              placeholder="예: 김기획"
              maxLength={80}
              onChange={(e) => setAuthorDraft(e.target.value)}
            />
          </label>
        )}
        <div className="onboarding__fixrow">
          <button type="button" className="primary" onClick={() => onApply(authorDraft)}>
            초대 받기
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            취소
          </button>
        </div>
        <p className="hint">
          연결이 끝나면 받은 파일을 지워 주세요 — 파일 안에는 당신의 연결 코드가 들어 있습니다.
        </p>
      </div>
    );
  }

  if (state.phase === "applying") {
    return (
      <div className="onboarding__invite" data-testid="invite-card">
        <p className="onboarding__detail">
          {state.rows.length}개 중 {state.done}개 연결됨…
        </p>
        <div className="onboarding__fixrow">
          <button type="button" className="primary" disabled>
            연결하는 중…
          </button>
        </div>
      </div>
    );
  }

  // done — 토큰이 거절됐으면 프로젝트는 하나도 건드리지 않은 상태다.
  const { result } = state;
  const failures = result.results.filter((entry) => !entry.ok);
  return (
    <div className="onboarding__invite" data-testid="invite-card">
      {result.tokenError ? (
        <div className="notice notice--error">
          <span className="notice__text">{result.tokenError}</span>
        </div>
      ) : (
        <p className="onboarding__detail">
          프로젝트 {result.results.length - failures.length}개를 연결했습니다.
        </p>
      )}
      {failures.length > 0 && (
        <ul className="invitecard__rows">
          {failures.map((entry) => (
            <li key={entry.row.project.repoUrl} className="invitecard__row">
              <span className="invitecard__rowname">{entry.row.project.name}</span>
              <span className="invitecard__rowwhy">{entry.error}</span>
            </li>
          ))}
        </ul>
      )}
      {result.reachWarnings.map((warning) => (
        <div key={warning} className="notice notice--warn">
          <span className="notice__text">{warning}</span>
        </div>
      ))}
      <div className="onboarding__fixrow">
        {result.tokenError ? (
          <button type="button" className="primary" onClick={onOpenPicker}>
            다른 파일 열기
          </button>
        ) : (
          failures.length > 0 && (
            <button type="button" className="primary" onClick={onRetry}>
              실패한 것 다시 시도
            </button>
          )
        )}
        <button type="button" className="ghost" onClick={onClose}>
          닫기
        </button>
      </div>
      <p className="hint">
        연결이 끝났으면 받은 파일을 지워 주세요 — 파일 안에는 당신의 연결 코드가 들어 있습니다.
      </p>
    </div>
  );
}

/** 행 머리의 레포 표기 — GitHub 주소는 owner/repo 두 조각으로, 아니면 키 그대로. */
function repoLabel(url: string): string {
  const key = repoKey(url);
  return key?.startsWith("github.com/") ? key.slice("github.com/".length) : (key ?? url);
}
