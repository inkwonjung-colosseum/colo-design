/**
 * The repo bring-up column's failure and wait UI (ex `ScreenPanel` head).
 *
 * Which failure this is and what it says live in `repo-guidance` (pure, unit
 * tested); this module is the card that renders them.
 */

import type { RepoPhase } from "@colo-design/protocol";
import { type ErrorKind, errorKindOf, guidanceFor } from "@colo-design/protocol";
import { type ReactNode, useState } from "react";
import { CopyButton } from "../../components";
import { daemonLine } from "../../lib/format";
import { isRepoPrepSeen } from "../../lib/settings";
import type { SettingsCategory } from "../dialogs/SettingsDialog";
import { GearIcon, RestartIcon, SparkIcon } from "../icons";

const PHASE_LABEL: Record<RepoPhase, string> = {
  missing: "연결 레포를 연결해 주세요",
  cloning: "연결 레포를 내려받는 중",
  pulling: "최신 변경을 받아오는 중",
  installing: "설치하는 중",
  starting: "미리보기를 띄우는 중",
  ready: "준비 완료",
  error: "준비하지 못했습니다",
};

/**
 * 준비의 세 단계 — 내려받기 → 설치 → 미리보기. 단계마다 카드 한 장이 서고,
 * 대기 카드의 hint 는 첫 준비의 교육 줄이다 (한 번 끝낸 기기에서는 이름만
 * 말한다 — isRepoPrepSeen).
 */
const STEPS: Array<{ id: string; label: string; hint: string | null; phases: RepoPhase[] }> = [
  { id: "clone", label: "내려받기", hint: null, phases: ["cloning", "pulling"] },
  { id: "install", label: "설치", hint: "내려받기가 끝나면 이어서 합니다", phases: ["installing"] },
  {
    id: "preview",
    label: "미리보기",
    hint: "준비가 끝나면 만든 화면이 이 자리에 뜹니다",
    phases: ["starting"],
  },
];

/**
 * 실패가 멈춘 단계 — 데몬이 던진 errorKind 가 그 자리를 가리킨다. `commands`
 * 는 클론 뒤 install · preview 명령의 승인 게이트라 설치 카드가 답하고,
 * 이름 없는 실패(unknown)는 어느 단계도 거짓으로 물들이지 않게 -1 이다.
 */
const ERROR_STEP: Partial<Record<ErrorKind, number>> = {
  clone: 0,
  conflict: 0,
  auth: 1,
  pnpm: 1,
  install: 1,
  commands: 1,
  preview: 2,
  "port-undetected": 2,
  "no-preview-command": 2,
};

export function ProgressPanel({
  phase,
  detail,
  errorKind,
  note,
  connectionLost = false,
  onRetry,
  onApproveCommands,
  callDeveloper,
  onOpenSettings,
}: {
  phase: RepoPhase;
  detail: string | null;
  errorKind: ErrorKind;
  /** 진행 표식 한 줄 — AI 요청 뒤의 기다림을 읽는다. */
  note?: string | null;
  /** 데몬과의 연결이 끊긴 동안 — 경고 카드가 단계 위에 얹히고 스택은 흐려진다. */
  connectionLost?: boolean;
  onRetry: () => void;
  /** 승인 오류의 첫 동작: 이 레포의 install · preview 명령 실행을 허용한다. */
  onApproveCommands?: () => void;
  /**
   * 막다른 자리의 마지막 손(P3-3) — `개발자 부르기`. 이 판은 슬랙도 프로젝트
   * 이름도 모르므로 노드를 통째로 받는다(부르는 쪽이 CallDeveloper 를 짓는다).
   */
  callDeveloper?: ReactNode;
  onOpenSettings: (category?: SettingsCategory) => void;
}) {
  const failed = phase === "error";
  const guidance = failed ? guidanceFor(errorKind, detail) : null;
  const progressLine = daemonLine(detail);
  const needsSetup = phase === "missing";
  /** Where the wait stands among the steps; -1 for the setup state. */
  const stepIndex = STEPS.findIndex((entry) => entry.phases.includes(phase));
  /** Which step the failure stopped on; -1 when the daemon could not name it. */
  const failedIndex = failed ? (ERROR_STEP[errorKind] ?? -1) : -1;
  // 대기 카드의 힌트 줄은 첫 준비의 교육용 — 마운트 시점의 기록만 본다.
  const [showHints] = useState(() => !isRepoPrepSeen());
  // D4: 실패를 AI에게 넘기는 일은 도구가 이미 했다(데몬의 자동 분기) — 카드의
  // 첫 동작은 그 사실을 읽는 한 줄이고, 남는 버튼은 다시 시도뿐이다.
  const agentBriefed = Boolean(guidance?.agent);
  const primaryTaken = errorKind === "commands" && onApproveCommands;

  const actions = guidance ? (
    <div className="progress__actions">
      {agentBriefed && (
        <p className="progress__note" role="status">
          도구가 이 문제를 AI에게 맡겼어요 — 대화에서 고치고 있어요
        </p>
      )}
      {errorKind === "commands" && onApproveCommands && (
        <button type="button" className="primary" onClick={onApproveCommands}>
          준비 시작
        </button>
      )}
      <button type="button" className={primaryTaken ? "ghost" : "primary"} onClick={onRetry}>
        <RestartIcon />
        다시 시도
      </button>
      {/* The way out a non-developer actually has — hand the
          whole card, Korean lead and raw tail, to someone who can read
          it. P3-3: 이제 그 길은 두 갈래다 — 개발자의 슬랙으로 바로 보내는
          `개발자 부르기`(연결돼 있을 때)와, 어디든 붙여넣을 수 있는 복사. */}
      {callDeveloper}
      <CopyButton
        value={
          `Colo Design에서 이 화면이 준비되지 않았습니다.\n` +
          `[${guidance.title}]\n${guidance.body}` +
          (guidance.command ? `\n실행이 필요한 명령: ${guidance.command}` : "") +
          (detail ? `\n\n--- 자세히 ---\n${detail}` : "")
        }
        label="안내 복사"
        icon={<SparkIcon size={12} />}
      />
    </div>
  ) : null;

  return (
    <div className={failed ? "progress progress--error" : "progress"}>
      <div className="progress__col">
        {connectionLost && (
          <div className="progress__step progress__step--warn" role="status">
            <span className="progress__stepicon">
              <RestartIcon />
            </span>
            <div className="progress__stepmain">
              <div className="progress__stepname">다시 연결하는 중…</div>
              <div className="progress__stepline">연결이 끊기면 대화와 저장이 잠시 멈춥니다</div>
            </div>
          </div>
        )}
        <div className="progress__head">
          <h2>{guidance ? guidance.title : PHASE_LABEL[phase]}</h2>
        </div>
        {stepIndex >= 0 || failedIndex >= 0 ? (
          <div
            className={
              connectionLost ? "progress__steps progress__steps--stale" : "progress__steps"
            }
          >
            {STEPS.map((entry, index) => {
              const state = failed
                ? index < failedIndex
                  ? "done"
                  : index === failedIndex
                    ? "err"
                    : "todo"
                : index < stepIndex
                  ? "done"
                  : index === stepIndex
                    ? "now"
                    : "todo";
              return (
                <div
                  key={entry.id}
                  className={`progress__step${state === "todo" ? "" : ` progress__step--${state}`}`}
                >
                  <span className="progress__stepicon">
                    {state === "done" ? (
                      "✓"
                    ) : state === "now" ? (
                      <span className="spinner" />
                    ) : state === "err" ? (
                      "!"
                    ) : (
                      index + 1
                    )}
                  </span>
                  <div className="progress__stepmain">
                    <div className="progress__stepname">{entry.label}</div>
                    {state === "now" && progressLine && (
                      <div className="progress__stepline progress__stepline--mono">
                        {progressLine}
                      </div>
                    )}
                    {/* 대기 카드의 힌트는 진행 중에만 — 실패 카드 옆에서
                        교육 줄은 잡음이다. */}
                    {!failed && state === "todo" && showHints && entry.hint && (
                      <div className="progress__stepline">{entry.hint}</div>
                    )}
                    {state === "err" && guidance && (
                      <>
                        <p className="progress__note">{guidance.body}</p>
                        {guidance.command && (
                          <pre className="progress__cmd">
                            <code>{guidance.command}</code>
                            <CopyButton value={guidance.command} />
                          </pre>
                        )}
                        {note && <p className="progress__note">{note}</p>}
                        {actions}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* 단계가 없는 상태 — 연결 전(missing)과 이름 없는 실패는 카드 한 장이
             말한다. 어느 단계도 거짓으로 물들이지 않는다. */
          <div className={failed ? "progress__step progress__step--err" : "progress__step"}>
            <span className="progress__stepicon">{failed ? "!" : <GearIcon />}</span>
            <div className="progress__stepmain">
              <div className="progress__stepname">{needsSetup ? "연결 레포 연결" : "준비"}</div>
              <p className="progress__note">
                {guidance
                  ? guidance.body
                  : needsSetup
                    ? "개발자에게 받은 초대 파일을 다시 놓아 주세요."
                    : "처음 한 번만 준비하면, 다음부터는 바로 시작합니다."}
              </p>
              {guidance?.command && (
                <pre className="progress__cmd">
                  <code>{guidance.command}</code>
                  <CopyButton value={guidance.command} />
                </pre>
              )}
              {failed && note && <p className="progress__note">{note}</p>}
              {failed ? (
                actions
              ) : needsSetup ? (
                <div className="progress__actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onOpenSettings("connection")}
                  >
                    설정 열기
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}
        {!failed && !needsSetup && (
          /* The stage's own line: what this column becomes once the wait is
             over, so the empty room reads as an artboard at rest. */
          <p className="progress__after">처음 한 번만 준비하면, 다음부터는 바로 시작합니다.</p>
        )}
      </div>
    </div>
  );
}

export { type ErrorKind, errorKindOf };
