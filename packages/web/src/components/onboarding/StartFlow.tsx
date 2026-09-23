import { useState } from "react";
import type { InviteImportController } from "../../hooks/use-invite-import";
import type { Daemon } from "../../lib/daemon-client";
import { GitHubTokenForm } from "./GitHubTokenForm";
import { InviteCard } from "./InviteCard";
import { RepoPicker } from "./RepoPicker";

/**
 * 프로젝트가 없을 때의 화면 전부 — 창을 통째로 쓰는 시작 화면. 주인공은 초대
 * 파일 하나다(P1-5): 개발자가 보낸 `*.colo-invite` 를 열거나 창에 끌어다 놓으면
 * 연결 코드 저장과 프로젝트 만들기가 한 장으로 끝난다. 파일의 읽기 · 적용 ·
 * 진행은 Shell 이 둔 컨트롤러(use-invite-import)가 맡고, 이 화면은 드롭 영역과
 * 카드(InviteCard)를 그릴 뿐이다. 초대장 없이 시작하는 길(토큰 붙여넣기 · 레포
 * 목록)은 개발 실행에만 접힌 예비 길로 남는다.
 */
export function StartFlow({
  daemon,
  invite,
}: {
  daemon: Daemon;
  /** Shell 의 가져오기 컨트롤러 — 상태와 행동의 주인. */
  invite: InviteImportController;
}) {
  const githubStep = daemon.onboarding?.find((step) => step.id === "github");
  const hasToken = githubStep?.status === "pass";
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`onboarding onboarding--start${dragOver ? " onboarding--drop" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        // 초대 파일은 컨트롤러의 전역(capture) 드롭 리스너가 먼저 잡는다 — 여기까지
        // 오는 드롭은 초대 파일이 아니고, 같은 오류 문장으로 답한다.
        const file = e.dataTransfer.files[0];
        if (file) invite.takeFile(file);
      }}
    >
      <header className="onboarding__head">
        <div className="onboarding__brand" aria-hidden="true">
          <img
            className="onboarding__mark"
            src="/colonova-icon.svg"
            alt=""
            width={36}
            height={36}
          />
        </div>
        <h1>Colo Design 시작하기</h1>
        <p className="hint">개발자에게 받은 초대 파일 하나로 시작합니다.</p>
      </header>

      {/* 초대 파일 가져오기(P1-5) — 카드가 살아 있는 동안 그 카드가 드롭 영역의
          자리를 대신한다. */}
      {invite.state.phase === "idle" ? (
        <>
          <div className="onboarding__dropzone" data-testid="invite-drop">
            <p className="onboarding__dropzone-title">초대 파일을 여기에 끌어다 놓으세요</p>
            <button type="button" className="primary" onClick={invite.openPicker}>
              초대 파일 열기
            </button>
          </div>
          <p className="hint">
            초대 파일이 없나요? 개발자에게 “Colo Design 초대 파일 보내 주세요”라고 요청하세요.
          </p>
        </>
      ) : (
        <InviteCard
          daemon={daemon}
          state={invite.state}
          onApply={invite.apply}
          onRetry={invite.retry}
          onClose={invite.close}
          onOpenPicker={invite.openPicker}
        />
      )}
      {dragOver && (
        <div className="onboarding__dropveil" aria-hidden="true">
          초대 파일을 여기에 놓으세요
        </div>
      )}

      {/* 개발 예비 길 — 실사용 첫 화면에는 없다. 개발 실행(daemon.status.dev)의
          선로 값으로만 펼치는 토큰 붙여넣기 · 레포 목록이다. 성공하면 나머지는
          초대 파일과 같은 길로 간다(Shell 이 작업대로 바꿔 낀다). */}
      {daemon.status?.dev === true && (
        <details className="onboarding__devfallback" data-testid="invite-dev-fallback">
          <summary>개발용 — 초대 파일 없이 시작</summary>
          <div className="onboarding__devfallback-body">
            {!hasToken && <GitHubTokenForm daemon={daemon} />}
            <RepoPicker daemon={daemon} />
          </div>
        </details>
      )}
    </div>
  );
}
