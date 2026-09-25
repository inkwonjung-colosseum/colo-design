import type { OnboardingStep } from "@colo-design/protocol";
import { useEffect, useState } from "react";
import type { InviteImportController } from "../../hooks/use-invite-import";
import type { Daemon } from "../../lib/daemon-client";
import { L } from "../labels";
import { CheckIcon, Spin } from "../ui/icons";
import { AlertIcon, CloseIcon, UploadIcon } from "./icons";
import "./onboarding.css";

/**
 * 처음 한 번(PLAN-UI U11) — 마법사 대신 체크리스트 한 장. `도구 준비 · AI 연결 ·
 * 초대 파일` 세 항목이 스스로 채워지고, `시작하기` 버튼은 없다: 게이트가 모두
 * 지나가고 프로젝트가 생기면 셸(NextShell)이 저절로 작업 화면으로 넘어간다.
 * 판정 · 설치 진행 · 로그인은 데몬의 것(onboarding.check · install 진행기 ·
 * agent.login)을 그대로 읽고, 초대 파일은 셸이 둔 컨트롤러(use-invite-import)가
 * 맡는다 — 이 화면은 놓는 자리를 그릴 뿐이다.
 */
export function FirstRun({
  daemon,
  provider,
  invite,
  checking,
  onClose,
}: {
  daemon: Daemon;
  /** 설정이 고른 에이전트 — 로그인 명령이 에이전트마다 다르다. */
  provider: string;
  /** 셸의 가져오기 컨트롤러 — 상태와 행동의 주인. */
  invite: InviteImportController;
  /** 게이트 검사가 도는 중(첫 상태 · 프로바이더 불일치 재검사). */
  checking: boolean;
  /** 설정의 `다시 보기` 로 다시 열렸을 때만 있는 나가는 길. */
  onClose?: () => void;
}) {
  const steps = daemon.onboarding ?? [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const gitStep = byId.get("git") ?? null;
  const runtimeStep = byId.get("runtime") ?? null;
  const claudeStep = byId.get("claude") ?? null;

  // ── 도구 준비 — git · 런타임. 데몬이 함께 실어 오는 github 행은 이 판의
  //    일이 아니다(연결은 초대 파일이 맡는다).
  const toolSteps = [gitStep, runtimeStep].filter((step): step is OnboardingStep => step !== null);
  const toolsPass = toolSteps.length === 2 && toolSteps.every((step) => step.status === "pass");
  const toolsOpen = toolSteps.filter((step) => step.status !== "pass");

  // ── AI 연결 — 설치 진행기와 로그인 판이 데몬에 산다.
  const installing = daemon.install?.kind === "install-claude";
  const installFailed =
    daemon.installDone?.kind === "install-claude" && !daemon.installDone.ok
      ? daemon.installDone
      : null;
  const agentPass = claudeStep?.status === "pass";
  const loginLive = daemon.login !== null;
  const loginFailed = daemon.loginDone && !daemon.loginDone.ok ? daemon.loginDone.detail : null;
  const agentState: "pass" | "installing" | "login" | "blocked" | "idle" = agentPass
    ? "pass"
    : installing
      ? "installing"
      : loginLive
        ? "login"
        : installFailed
          ? "blocked"
          : "idle";
  const failureParts = installFailed ? splitInstallDetail(installFailed.detail) : null;

  // 설치가 끝나면 로그인이 저절로 이어진다(목업의 흐름) — 단, 한 번만. 사용자가
  // 필요할 때 누르는 `설치` 버튼과 달리 로그인은 브라우저를 여는 것뿐이라
  // 체크리스트의 "스스로 채워진다" 약속을 지키는 쪽으로 읽는다.
  const [loginStarted, setLoginStarted] = useState(false);
  useEffect(() => {
    if (loginStarted || loginLive || installing) return;
    if (claudeStep?.fix?.kind !== "login-claude") return;
    setLoginStarted(true);
    void daemon.api.onboardingFix("login-claude", provider).catch(() => undefined);
  }, [loginStarted, loginLive, installing, claudeStep, daemon.api, provider]);

  const runFix = (step: OnboardingStep) => {
    void daemon.api
      .onboardingFix(
        step.fix?.kind ?? "install-claude",
        step.fix?.kind === "login-claude" ? provider : undefined,
      )
      .catch(() => undefined);
  };

  // ── 초대 파일 — 첫 프로젝트가 생기면 끝난다.
  const projects = daemon.projects;
  const inviteImporting = invite.state.phase === "reading" || invite.state.phase === "applying";
  const [dropOver, setDropOver] = useState(false);

  // ── Codex — 건너뛰어도 되는 선택 줄.
  const codexMissing =
    daemon.status?.providers?.find((entry) => entry.id === "codex" && !entry.available) ?? null;
  const codexInstalling = daemon.install?.kind === "install-codex";
  const codexFailed =
    daemon.installDone?.kind === "install-codex" && !daemon.installDone.ok
      ? daemon.installDone
      : null;
  const [codexSkipped, setCodexSkipped] = useState(false);
  const codexState: "none" | "ask" | "installing" | "ok" | "skip" | "failed" = !codexMissing
    ? "none"
    : codexInstalling
      ? "installing"
      : daemon.installDone?.kind === "install-codex" && daemon.installDone.ok
        ? "ok"
        : codexSkipped
          ? "skip"
          : codexFailed
            ? "failed"
            : "ask";

  const sic = (state: "ok" | "run" | "act" | "wait") =>
    state === "ok" ? (
      <span className="nx-sic nx-sic--ok">
        <CheckIcon />
      </span>
    ) : state === "run" ? (
      <span className="nx-sic nx-sic--run">
        <Spin />
      </span>
    ) : state === "act" ? (
      <span className="nx-sic nx-sic--act" />
    ) : (
      <span className="nx-sic nx-sic--wait" />
    );

  const agentRight =
    agentState === "pass"
      ? L.onboarding.agentOk
      : agentState === "installing"
        ? L.onboarding.agentInstalling
        : agentState === "login"
          ? L.onboarding.agentLogin
          : agentState === "blocked"
            ? failureParts?.itLine
              ? L.onboarding.agentBlocked
              : L.onboarding.agentFailed
            : L.onboarding.agentIdle;

  const agentFix = claudeStep && claudeStep.status !== "pass" ? (claudeStep.fix ?? null) : null;
  const agentBusy = installing || loginLive || checking;

  return (
    <div className="nx nx-ob" data-testid="next-first-run">
      {onClose && (
        <button
          type="button"
          className="nx-ibtn nx-ob-close"
          aria-label={L.onboarding.close}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      )}
      <div className="nx-ob-inner">
        <div className="nx-ob-logo" aria-hidden="true">
          <img src="/colonova-icon.svg" alt="" width={36} height={36} />
        </div>
        <h1 className="nx-ob-title">{L.onboarding.title}</h1>
        <p className="nx-ob-sub">{L.onboarding.sub}</p>

        <ol className="nx-ob-steps">
          {/* 도구 준비 */}
          <li className={`nx-ob-step${toolsPass ? "" : " nx-ob-step--act"}`}>
            {sic(toolsPass ? "ok" : "run")}
            <div>
              <div className="nx-ob-t">
                {L.onboarding.tools}
                <span className="nx-ob-r">
                  {toolsPass ? L.vocab.toolsReady : L.onboarding.toolsChecking}
                </span>
              </div>
              {toolsOpen.map((step) => (
                <div key={step.id}>
                  <p className="nx-ob-d">{step.detail}</p>
                  {step.fix && (
                    <div className="nx-ob-acts">
                      {step.fix.href ? (
                        <a
                          className="nx-btn nx-btn--pri"
                          href={step.fix.href}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {step.fix.label}
                        </a>
                      ) : (
                        <button
                          type="button"
                          className="nx-btn nx-btn--pri"
                          onClick={() => runFix(step)}
                        >
                          {step.fix?.label}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </li>

          {/* AI 연결 */}
          <li
            className={`nx-ob-step${
              agentState === "idle"
                ? " nx-ob-step--wait"
                : agentState === "pass"
                  ? ""
                  : " nx-ob-step--act"
            }`}
          >
            {sic(
              agentState === "pass"
                ? "ok"
                : agentState === "idle"
                  ? "wait"
                  : agentState === "blocked"
                    ? "act"
                    : "run",
            )}
            <div>
              <div className="nx-ob-t">
                {L.onboarding.agent}
                <span className="nx-ob-r">{agentRight}</span>
              </div>

              {(agentState === "idle" || agentState === "installing") && (
                <p className="nx-ob-d">{L.onboarding.agentWhat}</p>
              )}

              {agentState === "installing" && daemon.install && (
                <>
                  <div className="nx-bar" aria-hidden="true">
                    <i />
                  </div>
                  <div className="nx-ob-log" role="status">
                    {daemon.install.line}
                  </div>
                </>
              )}

              {agentState === "blocked" && failureParts && (
                <>
                  <p className="nx-ob-d nx-ob-d--red">{failureParts.body}</p>
                  {failureParts.itLine && (
                    <div className="nx-codebox nx-codebox--wrap">{failureParts.itLine}</div>
                  )}
                  <div className="nx-ob-acts">
                    {failureParts.itLine && <CopyLine line={failureParts.itLine} />}
                    <button
                      type="button"
                      className="nx-btn"
                      disabled={agentBusy}
                      onClick={() =>
                        void daemon.api.onboardingFix("install-claude").catch(() => undefined)
                      }
                    >
                      {L.onboarding.retry}
                    </button>
                  </div>
                </>
              )}

              {agentState === "login" && daemon.login && (
                <>
                  <p className="nx-ob-d">{L.onboarding.loginBody}</p>
                  <div className="nx-ob-acts">
                    <button
                      type="button"
                      className="nx-btn nx-btn--pri"
                      onClick={() => window.open(daemon.login?.url, "_blank", "noopener")}
                    >
                      {L.onboarding.loginReopen}
                    </button>
                  </div>
                  <details className="nx-ob-fold">
                    <summary>{L.onboarding.loginFallback}</summary>
                    <p>{L.onboarding.loginFallbackBody}</p>
                    <div className="nx-codebox">{daemon.login.url}</div>
                    {daemon.login.wantsCode && <LoginCodeForm daemon={daemon} />}
                  </details>
                </>
              )}

              {/* 로그인이 실패로 끝났다 — 다시 여는 길. 진행판이 살아 있는 동안은 숨는다. */}
              {agentState === "idle" && loginFailed && !installFailed && (
                <>
                  <p className="nx-ob-d nx-ob-d--red">{loginFailed}</p>
                  {agentFix && (
                    <div className="nx-ob-acts">
                      <button
                        type="button"
                        className="nx-btn nx-btn--pri"
                        disabled={agentBusy}
                        onClick={() => claudeStep && runFix(claudeStep)}
                      >
                        {agentFix.label}
                      </button>
                    </div>
                  )}
                </>
              )}

              {/* 아직 시작 전 — 설치 · 로그인의 첫 걸음. 설치 실패 뒤의 같은 버튼은 다시 시도다. */}
              {agentState === "idle" && !loginFailed && agentFix && (
                <div className="nx-ob-acts">
                  <button
                    type="button"
                    className="nx-btn nx-btn--pri"
                    disabled={agentBusy}
                    onClick={() => claudeStep && runFix(claudeStep)}
                  >
                    {installFailed ? L.onboarding.retry : agentFix.label}
                  </button>
                </div>
              )}
            </div>
          </li>

          {/* 초대 파일 */}
          <li className={`nx-ob-step${projects.length > 0 ? "" : " nx-ob-step--act"}`}>
            {sic(projects.length > 0 ? "ok" : inviteImporting ? "run" : "act")}
            <div>
              <div className="nx-ob-t">
                {L.onboarding.invite}
                <span className="nx-ob-r">
                  {projects.length > 0
                    ? L.vocab.projectCount(projects.length)
                    : inviteImporting
                      ? L.onboarding.inviteOpening
                      : L.onboarding.inviteFrom}
                </span>
              </div>

              {projects.length === 0 && !inviteImporting && (
                <div
                  className={`nx-drop${dropOver ? " nx-drop--over" : ""}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDropOver(true);
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget === event.target) setDropOver(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDropOver(false);
                    // 초대 파일은 컨트롤러의 전역(capture) 드롭 리스너가 먼저 잡는다 —
                    // 여기까지 오는 드롭은 초대 파일이 아니고, 같은 오류 문장으로 답한다.
                    const file = event.dataTransfer.files[0];
                    if (file) invite.takeFile(file);
                  }}
                >
                  <UploadIcon />
                  <div>
                    <b>*.colo-invite</b> {L.onboarding.inviteDrop}
                  </div>
                  <button type="button" className="nx-btn" onClick={invite.openPicker}>
                    {L.onboarding.invitePick}
                  </button>
                </div>
              )}

              {invite.state.phase === "error" && (
                <p className="nx-ob-d nx-ob-d--red" role="alert">
                  {invite.state.error}
                </p>
              )}

              {projects.length > 0 && (
                <>
                  <div className="nx-ob-done">
                    {L.onboarding.inviteDone(projects.map((project) => project.name).join(" · "))}
                    <br />
                    {L.onboarding.inviteFirst(projects[0]?.name ?? "")}
                  </div>
                  <div className="nx-ob-warn">
                    <AlertIcon />
                    <span>{L.onboarding.inviteWarn}</span>
                  </div>
                </>
              )}
            </div>
          </li>
        </ol>

        {/* Codex — 건너뛰어도 되는 선택 줄 */}
        {codexState !== "none" && (
          <div className="nx-ob-opt">
            {codexState === "ok" ? (
              <>
                <CheckIcon />
                <span className="nx-grow">{L.onboarding.codexOk}</span>
              </>
            ) : codexState === "installing" ? (
              <>
                <Spin />
                <span className="nx-grow">{L.onboarding.codexInstalling}</span>
              </>
            ) : codexState === "skip" ? (
              <span className="nx-grow nx-muted">{L.onboarding.codexSkipped}</span>
            ) : (
              <>
                <span className="nx-grow">
                  {L.onboarding.codexAsk}
                  <small>{codexFailed ? codexFailed.detail : L.onboarding.codexAskSub}</small>
                </span>
                {codexState === "failed" && (
                  <button
                    type="button"
                    className="nx-btn"
                    disabled={installing}
                    onClick={() =>
                      void daemon.api.onboardingFix("install-codex").catch(() => undefined)
                    }
                  >
                    {L.onboarding.retry}
                  </button>
                )}
                {codexState === "ask" && (
                  <>
                    <button
                      type="button"
                      className="nx-btn"
                      onClick={() =>
                        void daemon.api.onboardingFix("install-codex").catch(() => undefined)
                      }
                    >
                      {L.onboarding.codexInstall}
                    </button>
                    <button
                      type="button"
                      className="nx-btn nx-btn--ghost"
                      onClick={() => setCodexSkipped(true)}
                    >
                      {L.onboarding.codexSkip}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * policy 실패의 detail 은 안내 문장과 IT 담당자용 복사 한 줄이 개행으로 이어진
 * 형태다(onboarding-gates 의 규칙 그대로) — 마지막 줄을 떼어 상자에 넣는다.
 * policy 가 아니면(네트워크 · 디스크 · 그 밖) 상자는 없다.
 */
function splitInstallDetail(detail: string): { body: string; itLine: string | null } {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length < 2) return { body: detail, itLine: null };
  const itLine = lines[lines.length - 1] ?? null;
  return { body: lines.slice(0, -1).join("\n"), itLine };
}

/** IT 담당자에게 보낼 문장 하나를 클립보드에 넣는 버튼 — 눌렀다는 답 한 번. */
function CopyLine({ line }: { line: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="nx-btn nx-btn--pri"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(line)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      {copied ? <CheckIcon /> : null}
      {copied ? L.onboarding.copied : L.onboarding.copyText}
    </button>
  );
}

/** 로그인 코드 붙여넣기 — 데몬이 자식의 stdin 으로 흘려 보낸다. */
function LoginCodeForm({ daemon }: { daemon: Daemon }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await daemon.api.agentLoginCode(code.trim());
      setCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="nx-row">
        <input
          type="password"
          value={code}
          spellCheck={false}
          autoComplete="off"
          placeholder={L.onboarding.loginCode}
          aria-label={L.onboarding.loginCode}
          disabled={busy}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && code.trim() && !busy) void send();
          }}
        />
        <button
          type="button"
          className="nx-btn"
          disabled={!code.trim() || busy}
          onClick={() => void send()}
        >
          {L.onboarding.confirm}
        </button>
      </div>
      {error && (
        <p className="nx-ob-d nx-ob-d--red" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
