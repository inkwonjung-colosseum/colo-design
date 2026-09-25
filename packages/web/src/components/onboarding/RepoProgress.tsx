/**
 * The repo bring-up column's failure and wait UI (ex `ScreenPanel` head).
 *
 * Which failure this is and what it says live in `repo-guidance` (pure, unit
 * tested); this module is the card that renders them.
 */

import type { RepoPhase } from "@colo-design/protocol";
import { type ErrorKind, errorKindOf, guidanceFor } from "@colo-design/protocol";
import { useState } from "react";
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

/**
 * AI 가 맡은 실패 아래에 서는 한 줄 — 고침 턴이 도는 중이든 끝났든 참인
 * 말이다(끝난 턴의 설명은 대화에 있고, 고침 턴이 답을 내면 데몬이 준비를 다시
 * 돌린다 — D4 의 recoveryResync).
 */
const AI_NOTE = "무엇이 막혔는지는 AI가 대화에서 살펴봐요 — 고치고 나면 준비가 저절로 다시 돌아요.";

export function ProgressPanel({
  phase,
  detail,
  errorKind,
  note,
  connectionLost = false,
  aiWorking = false,
  onRetry,
  onApproveCommands,
  onOpenSettings,
}: {
  phase: RepoPhase;
  detail: string | null;
  errorKind: ErrorKind;
  /** 진행 표식 한 줄 — AI 요청 뒤의 기다림을 읽는다. */
  note?: string | null;
  /** 데몬과의 연결이 끊긴 동안 — 경고 카드가 단계 위에 얹히고 스택은 흐려진다. */
  connectionLost?: boolean;
  /** 이 프로젝트에서 AI 의 턴이 도는 중 — 맡긴 실패를 지금 고치고 있는지. */
  aiWorking?: boolean;
  onRetry: () => void;
  /** 승인 오류의 첫 동작: 이 레포의 install · preview 명령 실행을 허용한다. */
  onApproveCommands?: () => void;
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
  // 연결 레포의 실패는 사람에게 올리지 않는다(2026-09-23): 데몬(D4)이 사람의
  // 클릭 없이 이미 AI 에게 넘겼으므로, 판은 오류 문장 · 명령 · 복사 대신 "AI 가
  // 고치는 중" 만 말한다. 원래 카드로 서는 것은 사람의 동의가 필요한 첫
  // 실행(commands — agent 가 없는 유일한 종류)뿐이다.
  const aiHandled = Boolean(guidance?.agent);
  const alarm = failed && !aiHandled;
  const primaryTaken = errorKind === "commands" && onApproveCommands;

  const actions = guidance ? (
    <div className="progress__actions">
      {errorKind === "commands" && onApproveCommands && (
        <button type="button" className="primary" onClick={onApproveCommands}>
          준비 시작
        </button>
      )}
      {/* 고침 턴이 답을 내면 데몬이 스스로 다시 돌린다 — 이 버튼은 그 길이
          막혔을 때(고침 턴이 넘어짐)의 조용한 손잡이다. */}
      <button
        type="button"
        className={primaryTaken || aiHandled ? "ghost" : "primary"}
        onClick={onRetry}
      >
        <RestartIcon />
        다시 시도
      </button>
    </div>
  ) : null;
  const aiGlyph = aiWorking ? <span className="spinner" /> : <SparkIcon size={12} />;

  return (
    <div className={alarm ? "progress progress--error" : "progress"}>
      <div className="progress__col">
        {connectionLost && (
          <div className="progress__step progress__step--warn" role="status">
            <span className="progress__stepicon">
              <RestartIcon />
            </span>
            <div className="progress__stepmain">
              <div className="progress__stepname">다시 연결하는 중…</div>
              <div className="progress__stepline">연결이 끊기면 대화와 보관이 잠시 멈춥니다</div>
            </div>
          </div>
        )}
        <div className="progress__head">
          <h2>
            {aiHandled
              ? aiWorking
                ? "AI가 막힌 곳을 고치고 있어요"
                : "막힌 곳을 AI에게 맡겼어요"
              : guidance
                ? guidance.title
                : PHASE_LABEL[phase]}
          </h2>
        </div>
        {stepIndex >= 0 || failedIndex >= 0 ? (
          <div
            className={
              connectionLost ? "progress__steps progress__steps--stale" : "progress__steps"
            }
          >
            {STEPS.map((entry, index) => {
              // `fix` — AI 가 맡은 실패의 단계. 오류의 빨강이 아니라 진행의 색을
              // 입는다(사람이 읽을 것은 "고치는 중" 뿐이다).
              const state = failed
                ? index < failedIndex
                  ? "done"
                  : index === failedIndex
                    ? aiHandled
                      ? "fix"
                      : "err"
                    : "todo"
                : index < stepIndex
                  ? "done"
                  : index === stepIndex
                    ? "now"
                    : "todo";
              const tone = state === "fix" ? "now" : state;
              return (
                <div
                  key={entry.id}
                  className={`progress__step${tone === "todo" ? "" : ` progress__step--${tone}`}`}
                >
                  <span className="progress__stepicon">
                    {state === "done" ? (
                      "✓"
                    ) : state === "now" ? (
                      <span className="spinner" />
                    ) : state === "fix" ? (
                      aiGlyph
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
                    {state === "fix" && (
                      <>
                        <p className="progress__note">{AI_NOTE}</p>
                        {note && <p className="progress__note">{note}</p>}
                        {actions}
                      </>
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
          <div
            className={
              aiHandled
                ? "progress__step progress__step--now"
                : failed
                  ? "progress__step progress__step--err"
                  : "progress__step"
            }
          >
            <span className="progress__stepicon">
              {aiHandled ? aiGlyph : failed ? "!" : <GearIcon />}
            </span>
            <div className="progress__stepmain">
              <div className="progress__stepname">{needsSetup ? "연결 레포 연결" : "준비"}</div>
              <p className="progress__note">
                {aiHandled
                  ? AI_NOTE
                  : guidance
                    ? guidance.body
                    : needsSetup
                      ? "개발자에게 받은 초대 파일을 다시 놓아 주세요."
                      : "처음 한 번만 준비하면, 다음부터는 바로 시작합니다."}
              </p>
              {!aiHandled && guidance?.command && (
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
