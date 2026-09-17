/**
 * The repo bring-up column's failure and wait UI (ex `ScreenPanel` head).
 *
 * Which failure this is and what it says live in `repo-guidance` (pure, unit
 * tested); this module is the card that renders them.
 */

import type { RepoPhase } from "@colo-design/protocol";
import { CopyButton } from "../../components";
import { daemonLine } from "../../lib/format";
import { type ErrorKind, errorKindOf, guidanceFor } from "../../lib/repo-guidance";
import type { SettingsCategory } from "../dialogs/SettingsDialog";
import { RestartIcon, SparkIcon } from "../icons";

const PHASE_LABEL: Record<RepoPhase, string> = {
  missing: "연결 레포를 연결해 주세요",
  cloning: "연결 레포를 내려받는 중",
  pulling: "최신 변경을 받아오는 중",
  installing: "설치하는 중",
  starting: "미리보기를 띄우는 중",
  ready: "준비 완료",
  error: "준비하지 못했습니다",
};

const PROGRESS_RAIL: Array<{ id: string; label: string; phases: RepoPhase[] }> = [
  { id: "clone", label: "내려받기", phases: ["cloning", "pulling"] },
  { id: "install", label: "설치", phases: ["installing"] },
  { id: "preview", label: "미리보기", phases: ["starting"] },
];

export function ProgressPanel({
  phase,
  detail,
  errorKind,
  note,
  onRetry,
  onForceRestart,
  onAskAgent,
  onApproveCommands,
  onOpenSettings,
}: {
  phase: RepoPhase;
  detail: string | null;
  errorKind: ErrorKind;
  /** 진행 표식 한 줄 — AI 요청 뒤의 기다림을 읽는다. */
  note?: string | null;
  onRetry: () => void;
  /**
   * 포트 정리 실패 카드의 동작: 다시 시도는 정리를 한 번 더 시도한다 — 평범한
   * 충돌은 활성 프로젝트가 이겨 자동 정리되므로(사용자 결정), 이 카드는 그
   * 자동 정리가 실패한 경우만 만난다. 성공 경로는 사람 손이 필요 없다.
   */
  onForceRestart?: () => void;
  /**
   * 실패 카드의 첫 동작: 이 실패를 AI의 과제로 넘긴다. 어떤 종류가
   * 이 문을 여는지는 guidance 가 든 `agent` 가 정한다 — `commands`(사람의
   * 동의가 곧 해결)와 `preview`(미리보기 자리의 자체 버튼)만 뺀 전부다.
   */
  onAskAgent?: () => void;
  /** 승인 오류의 첫 동작: 이 레포의 install · preview 명령 실행을 허용한다. */
  onApproveCommands?: () => void;
  onOpenSettings: (category?: SettingsCategory) => void;
}) {
  const failed = phase === "error";
  const guidance = failed ? guidanceFor(errorKind, detail) : null;
  const progressLine = daemonLine(detail);
  const needsSetup = phase === "missing";
  /** Where the wait sits on the rail; -1 for the setup and failure states. */
  const railIndex = PROGRESS_RAIL.findIndex((entry) => entry.phases.includes(phase));
  const agentFirst = Boolean(guidance?.agent && onAskAgent);
  const primaryTaken =
    agentFirst ||
    (errorKind === "commands" && onApproveCommands) ||
    (errorKind === "port-busy" && onForceRestart);

  return (
    <div className={failed ? "progress progress--error" : "progress"}>
      <div className="progress__card">
        <div className="progress__head">
          {!failed && <span className="spinner" />}
          <h2>{guidance ? guidance.title : PHASE_LABEL[phase]}</h2>
        </div>
        {!failed && railIndex >= 0 && (
          <div className="progress__rail" aria-hidden="true">
            {PROGRESS_RAIL.map((entry, index) => (
              <span
                key={entry.id}
                className={`progress__step${
                  index < railIndex
                    ? " progress__step--done"
                    : index === railIndex
                      ? " progress__step--now"
                      : ""
                }`}
              >
                <span className="progress__dot">{index < railIndex ? "✓" : ""}</span>
                {entry.label}
              </span>
            ))}
          </div>
        )}
        <p className="progress__body">
          {guidance
            ? guidance.body
            : needsSetup
              ? "새 프로젝트로 연결 레포를 연결하고, 설정에서 개인 액세스 토큰을 입력해 주세요."
              : "처음 한 번만 준비하면, 다음부터는 바로 시작합니다."}
        </p>
        {guidance?.command && (
          <pre className="progress__cmd">
            <code>{guidance.command}</code>
            <CopyButton value={guidance.command} />
          </pre>
        )}
        {!failed && progressLine && <div className="progress__detail">{progressLine}</div>}
        {failed && note && <p className="progress__note">{note}</p>}
        {failed && (
          <div className="progress__actions">
            {agentFirst && (
              <button type="button" className="primary" onClick={onAskAgent}>
                <SparkIcon size={13} />
                AI에게 해결 요청
              </button>
            )}
            {errorKind === "commands" && onApproveCommands && (
              <button type="button" className="primary" onClick={onApproveCommands}>
                실행 허용
              </button>
            )}
            {errorKind === "port-busy" && onForceRestart && (
              <button
                type="button"
                className={agentFirst ? "ghost" : "primary"}
                onClick={onForceRestart}
              >
                <RestartIcon />
                다시 정리
              </button>
            )}
            <button type="button" className={primaryTaken ? "ghost" : "primary"} onClick={onRetry}>
              <RestartIcon />
              다시 시도
            </button>
            {/* The way out a non-developer actually has — hand the
                whole card, Korean lead and raw tail, to someone who can read
                it. The terminal it replaces never was their tool. */}
            {guidance && (
              <CopyButton
                value={
                  `Colo Design에서 이 화면이 준비되지 않았습니다.\n` +
                  `[${guidance.title}]\n${guidance.body}` +
                  (guidance.command ? `\n실행이 필요한 명령: ${guidance.command}` : "") +
                  (detail ? `\n\n--- 자세히 ---\n${detail}` : "")
                }
                label="이 안내를 개발자에게 보내기"
                icon={<SparkIcon size={12} />}
              />
            )}
          </div>
        )}
        {!failed && needsSetup && (
          <button type="button" className="primary" onClick={() => onOpenSettings("connection")}>
            설정 열기
          </button>
        )}
      </div>
      {/* The stage's own line: what this column becomes once the wait is over,
          so the empty room reads as an artboard at rest, not a broken pane. */}
      <p className="progress__after">준비가 끝나면 만든 화면이 이 자리에 뜹니다.</p>
    </div>
  );
}

export { type ErrorKind, errorKindOf };
