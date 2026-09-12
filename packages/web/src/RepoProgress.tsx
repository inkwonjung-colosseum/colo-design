/**
 * The repo bring-up column's failure and wait UI (ex `ScreenPanel` head).
 *
 * The daemon NAMES a failure at the throw site (`RepoStatus.errorKind`,
 * PLAN D41); this module maps that name to the words and actions a planner
 * reads — text sniffing the old UI did broke silently whenever a daemon
 * message was reworded, so the kind is the only thing consulted.
 */
import { useState } from "react";
import type { RepoPhase, RepoStatus } from "@cds-design/protocol";
import { daemonLine } from "./format";
import { CheckIcon, CopyIcon, RestartIcon, SparkIcon } from "./icons";

const PHASE_LABEL: Record<RepoPhase, string> = {
  preparing: "Claude 가 레포를 살펴보고 연결을 준비하는 중",
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

interface Guidance {
  title: string;
  body: string;
  /** A command the planner can paste into a terminal, if one would fix this. */
  command?: string;
}

/**
 * Which failure this is. A dead preview server still leaves the screen worth
 * looking at, so it is answered inside the preview itself; everything else
 * takes over the 화면 column.
 */
export type ErrorKind = "auth" | "pnpm" | "preview" | "conflict" | "commands" | "unknown";

export function errorKindOf(repo: RepoStatus | null | undefined): ErrorKind {
  const kind = repo?.errorKind;
  if (kind === "registry-auth") return "auth";
  if (kind === "pnpm-missing") return "pnpm";
  if (kind === "conflict") return "conflict";
  if (kind === "commands") return "commands";
  if (kind === "preview") return "preview";
  if (!kind) {
    const detail = repo?.detail ?? null;
    if (detail?.includes("GitHub 패키지 인증")) return "auth";
    if (detail?.includes("pnpm이 없습니다")) return "pnpm";
    if (detail?.includes("미리보기")) return "preview";
    // A daemon older than the conflict kind still names the conflict in the
    // detail (D96); the diverged refusal says 갈라진 and must not match.
    if (detail?.includes("충돌이 남았습니다")) return "conflict";
  }
  return "unknown";
}

function guidanceFor(kind: ErrorKind, detail: string | null): Guidance {
  if (kind === "auth") {
    return {
      title: "GitHub 패키지 인증이 필요합니다",
      body: "연결 레포의 의존성을 사내 GitHub 패키지에서 받아옵니다. 설정의 개인 액세스 토큰(read:packages 권한)을 확인한 뒤 다시 시도해 주세요.",
      command: "pnpm config set //npm.pkg.github.com/:_authToken <PAT>",
    };
  }
  if (kind === "pnpm") {
    return {
      title: "pnpm이 설치되어 있지 않습니다",
      body: "연결 레포의 설치·미리보기에 pnpm이 필요합니다. 터미널에 아래 명령을 실행한 뒤 다시 시도해 주세요.",
      command: "corepack enable",
    };
  }
  if (kind === "conflict") {
    // D96: 다시 시도로는 같은 충돌을 도는 것이므로, 카드의 첫 동작은
    // Claude 요청이다. 본문은 데몬이 던진 그 상태의 말을 그대로 읽는다.
    return {
      title: "최신 변경과 충돌이 남았습니다",
      body:
        detail ??
        "저장하지 않은 변경과 개발자의 최신 변경이 겹쳤습니다. Claude에게 정리를 요청하면 대화에서 충돌을 정리합니다.",
    };
  }
  if (kind === "commands") {
    // The repo's own install · preview commands wait on one explicit yes —
    // the button below is the yes; the body is the daemon's own words.
    return {
      title: "명령 실행 승인이 필요합니다",
      body: detail ?? "이 레포가 정의한 설치 · 미리보기 명령의 실행을 허용하면 준비를 계속합니다.",
    };
  }
  return {
    title: "준비하지 못했습니다",
    body: detail ?? "원인을 알 수 없습니다. 다시 시도해 주세요.",
  };
}

export function ProgressPanel({
  phase,
  detail,
  errorKind,
  note,
  onRetry,
  onAskClaude,
  onApproveCommands,
  onOpenSettings,
}: {
  phase: RepoPhase;
  detail: string | null;
  errorKind: ErrorKind;
  /** 진행 표식 한 줄 — Claude 요청 뒤의 기다림을 읽는다(D96). */
  note?: string | null;
  onRetry: () => void;
  /** 충돌 오류의 첫 동작(D96): 정리를 Claude의 대화로 넘긴다. */
  onAskClaude?: () => void;
  /** 승인 오류의 첫 동작: 이 레포의 install · preview 명령 실행을 허용한다. */
  onApproveCommands?: () => void;
  onOpenSettings: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const failed = phase === "error";
  const guidance = failed ? guidanceFor(errorKind, detail) : null;
  const progressLine = daemonLine(detail);
  const needsSetup = phase === "missing";
  /** Where the wait sits on the rail; -1 for the setup and failure states. */
  const railIndex = PROGRESS_RAIL.findIndex((entry) => entry.phases.includes(phase));

  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the command is visible to retype anyway.
    }
  };

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
                  index < railIndex ? " progress__step--done" : index === railIndex ? " progress__step--now" : ""
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
              ? "설정에서 연결 레포 주소와 개인 액세스 토큰을 입력해 주세요."
              : "처음 한 번만 준비하면, 다음부터는 바로 시작합니다."}
        </p>
        {guidance?.command && (
          <pre className="progress__cmd">
            <code>{guidance.command}</code>
            <button type="button" className="ghost" onClick={() => void copy(guidance.command!)}>
              {copied ? (
                <>
                  <CheckIcon size={11} /> 복사됨
                </>
              ) : (
                <>
                  <CopyIcon size={12} /> 복사
                </>
              )}
            </button>
          </pre>
        )}
        {!failed && progressLine && <div className="progress__detail">{progressLine}</div>}
        {failed && note && <p className="progress__note">{note}</p>}
        {failed && (
          <div className="progress__actions">
            {errorKind === "conflict" && onAskClaude && (
              <button type="button" className="primary" onClick={onAskClaude}>
                <SparkIcon size={13} />
                Claude에게 해결 요청
              </button>
            )}
            {errorKind === "commands" && onApproveCommands && (
              <button type="button" className="primary" onClick={onApproveCommands}>
                실행 허용
              </button>
            )}
            <button
              type="button"
              className={
                (errorKind === "conflict" && onAskClaude) || (errorKind === "commands" && onApproveCommands)
                  ? "ghost"
                  : "primary"
              }
              onClick={onRetry}
            >
              <RestartIcon />
              다시 시도
            </button>
          </div>
        )}
        {!failed && needsSetup && (
          <button type="button" className="primary" onClick={onOpenSettings}>
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
