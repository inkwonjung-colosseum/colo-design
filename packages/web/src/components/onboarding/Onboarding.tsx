import type {
  AgentInstallKind,
  DaemonStatus,
  OnboardingStep,
  OnboardingStepId,
} from "@colo-design/protocol";
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from "react";
import { useModalEscape } from "../../hooks/use-modal-focus";
import type { Daemon } from "../../lib/daemon-client";
import { BrainIcon, BranchIcon, CheckIcon, CloseIcon, KeyIcon, PlugIcon, WarnIcon } from "../icons";

/**
 * The first-run wizard: machine gates answered once — the agent
 * Code, git, Node·pnpm — and then it is done. Which repo a planner works on
 * is NOT here: the first project comes from an invite file on the start
 * screen (StartFlow), and later ones from a fresh invite file the developer
 * sends again.
 *
 * Passed gates are not rows: they collapse into one summary line, so the
 * wizard shows only what a planner can still act on — one open card at a
 * time, and everything passed is scanned past in a breath.
 */
const STEP_ORDER: OnboardingStepId[] = ["claude", "git", "runtime"];

const STEP_TITLE: Record<OnboardingStepId, string> = {
  // 제목은 쓸모가 먼저다 — 도구 이름은 조용한 부제로
  // 내려간다(claude 행이 이미 사람 말 설명을 가진 것의 확장). 기획자가 평생
  // 생각할 일 없는 런타임(Node · pnpm)은 "앱에 포함"이 본체다.
  // claude 행은 에이전트를 따라 바뀐다(아래 providerLabel).
  claude: "화면을 만드는 AI",
  git: "작업을 보관할 준비",
  runtime: "앱 실행 준비",
  github: "개발자에게 넘길 준비",
};

/** The tool behind each gate — the stephead's quiet subtitle. claude 행은
 *  에이전트의 id 를 부제로 내려보낸다(onboarding-gates.html og-step__sub). */
const STEP_TOOL: Record<OnboardingStepId, string> = {
  claude: "claude",
  git: "git",
  runtime: "앱에 포함",
  github: "GitHub",
};
/** 요약 줄의 짧은 이름 — claude 행은 고른 에이전트의 라벨(providerLabel)로 읽는다. */
const SHORT_TITLE: Record<OnboardingStepId, string> = {
  claude: "",
  git: "git",
  runtime: "런타임",
  github: "GitHub",
};

/** claude 행의 설명 한 줄 패턴(:203-209)을 나머지 셋에도. */
const STEP_HINT: Record<OnboardingStepId, string> = {
  claude: "",
  git: "화면 작업을 보관하고 개발자에게 제출하는 데 쓰는 도구입니다 — 이 앱이 대신 다룹니다.",
  runtime: "앱 안에 들어 있습니다 — 없다고 나오면 앱 설치가 깨진 것입니다.",
  github: "",
};

/** Each gate status's glyph — the seat already carries its tone colour. */
const STATUS_ICON: Record<OnboardingStep["status"], ReactElement> = {
  pass: <CheckIcon />,
  warn: <WarnIcon />,
  fail: <CloseIcon />,
};

const STATUS_LABEL: Record<OnboardingStep["status"], string> = {
  pass: "통과",
  warn: "주의",
  fail: "실패",
};

/** Each gate row's subject — the quiet tile that names what the row is about. */
const STEP_ICON: Record<OnboardingStepId, ReactElement> = {
  claude: <BrainIcon />,
  git: <BranchIcon />,
  runtime: <PlugIcon />,
  github: <KeyIcon />,
};

/** claude 행의 설치 종류 — 고른 프로바이더를 따른다(3단계). */
function installKindFor(provider: string): AgentInstallKind {
  return provider === "codex" ? "install-codex" : "install-claude";
}

/**
 * policy 실패의 detail 은 안내 문장과 IT 담당자용 복사 한 줄이 개행으로 이어진
 * 1단계의 형식 그대로다 — 가장 단순하게, 마지막 줄을 떼어 클립보드 문장으로
 * 쓴다. policy 가 아니면 null(붙일 문장이 없다).
 */
function policyCopyLine(detail: string): string | null {
  if (!detail.includes("IT 담당자에게 보내 주세요")) return null;
  return detail.split("\n").at(-1) ?? null;
}

/** IT 담당자에게 보낼 문장 하나를 클립보드에 넣는 버튼 — 눌렀다는 답 한 번. */
function CopySentenceButton({ line }: { line: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(line)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2500);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? "복사했어요" : "문장 복사"}
    </button>
  );
}

/** 로그인 코드 붙여넣기(P1-1) — 데몬이 자식의 stdin 으로 흘려 보낸다. */
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
    <div className="ghtoken__row onboarding__logincode">
      <input
        type="password"
        value={code}
        spellCheck={false}
        autoComplete="off"
        placeholder="브라우저에 나온 코드 붙여넣기"
        aria-label="로그인 코드"
        disabled={busy}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && code.trim() && !busy) void send();
        }}
      />
      <button
        type="button"
        className="primary"
        disabled={!code.trim() || busy}
        onClick={() => void send()}
      >
        {busy ? "보내는 중…" : "코드 보내기"}
      </button>
      {error && (
        <div className="notice notice--error">
          <span className="notice__text">{error}</span>
        </div>
      )}
    </div>
  );
}

export function Onboarding({
  daemon,
  provider = "claude",
  providers = [],
  checking = false,
  onProviderChange,
  onDone,
  inviteNotice = null,
  onClose,
}: {
  daemon: Daemon;
  /** 설정에서 고른 에이전트 — the claude gate checks this one's driver. */
  provider?: string;
  /** status.providers — the step title's label and the switch picker's rows. */
  providers?: DaemonStatus["providers"];
  /** Shell's provider-mismatch recheck is in flight — this card's busy 외의 검사. */
  checking?: boolean;
  /** Switching the agent: settings.chat 의 패치를 Shell 이 걸고, 그 effect 가 다시 검사한다. */
  onProviderChange?: (id: string) => void;
  /** Called when every blocking step passed (the workspace may open). */
  onDone: () => void;
  /**
   * 막는 단계가 없을 때만 주어지는 나가는 길 — 설정에서 다시 연 마법사나
   * 경고만 남은 첫 실행이, 고르지 않으면 못 나가는 함정이 되지 않게 한다.
   */
  onClose?: () => void;
  /** 마법사가 떠 있는 동안 놓인 초대 파일 — 받았다는 한 줄(또는 오류 문장). */
  inviteNotice?: { tone: "info" | "error"; text: string } | null;
}) {
  // 데몬은 여전히 github 게이트도 보내지만 화면은 쓰지 않는다 — 첫 화면이 초대
  // 파일로 서 있으므로 그 행이 설 자리가 없다(연결 코드 관리는 설정과 토큰
  // 만료 대화상자가 맡는다).
  const steps = (daemon.onboarding ?? []).filter((step) => STEP_ORDER.includes(step.id));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The fix's own words. The daemon answers every fix with `{started, guidance}` —
      on macOS the installer opens no window and drops its stdio, so this sentence
      is the ONLY feedback a press produces. Dropping it made the button look dead.
      `step` 은 그 말이 어떤 행의 것인지 기억한다 — 그렇지 않으면 고침이 있는
      실패 행마다 같은 안내가 반복해서 선다. */
  const [notice, setNotice] = useState<{
    step: string;
    started: boolean;
    guidance: string;
  } | null>(null);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const blocked = steps.some((step) => step.status === "fail");
  const busyKind = busy ?? null;
  /** 확인 중 — 이 카드 밖(Shell 의 불일치 재검사)과 안(다시 확인)의 검사. */
  const checkRunning = checking || busy === "recheck";

  // The check is NOT run here. `Shell` runs it on connect and this wizard is
  // its child, so a second effect meant every gate ran twice per open.

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const reply = (await action()) as unknown;
      if (
        reply !== null &&
        typeof reply === "object" &&
        "guidance" in reply &&
        typeof reply.guidance === "string"
      ) {
        setNotice({
          step: label,
          started: !("started" in reply) || reply.started !== false,
          guidance: reply.guidance,
        });
      }
      await daemon.api.onboardingCheck(provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** The one step a planner can act on right now — everything else is a line. */
  const firstOpen =
    steps.find((step) => step.status === "fail")?.id ??
    steps.find((step) => step.status === "warn")?.id ??
    null;
  const isOpen = (id: OnboardingStepId) => id === firstOpen;

  // claude 행의 제목·부제는 에이전트를 따라간다: 목록의 label 이 있으면 그
  // 이름으로, 없으면 id 그대로(onboarding-gates.html og-step__nm/__sub).
  const providerLabel = providers.find((p) => p.id === provider)?.label ?? provider;
  // AI 행의 설치 상태(3단계): 데몬이 이 종류의 설치를 지켜보고 있는 동안 버튼은
  // 물러나고 진행 줄이 그 자리를 지킨다. 실패의 detail 은 곧 이 행의 안내 문장.
  const rowInstallKind = installKindFor(provider);
  const rowInstalling = daemon.install?.kind === rowInstallKind;
  const rowInstallFailed =
    daemon.installDone?.kind === rowInstallKind && !daemon.installDone.ok
      ? daemon.installDone
      : null;

  // 통과한 게이트는 행이 아니라 요약 한 줄이다 — 남는 행은 사용자가 지금 할
  // 수 있는 일뿐이고, 번호도 남은 행 안에서 매긴다(1, 3처럼 비지 않게).
  const passedSteps: OnboardingStep[] = [];
  const openSteps: OnboardingStep[] = [];
  for (const id of STEP_ORDER) {
    const step = byId.get(id);
    if (!step) continue;
    (step.status === "pass" ? passedSteps : openSteps).push(step);
  }
  // 선택 행: Codex(3단계) — 이 데몬이 codex 를 알지만 아직 못 쓸 때만 선다.
  // blocked · 미터 · 자동 진행 판정에는 들어가지 않는다(별도 렌더일 뿐).
  const codexMissing = providers.find((p) => p.id === "codex" && !p.available) ?? null;
  const codexInstalling = daemon.install?.kind === "install-codex";
  const codexFailed =
    daemon.installDone?.kind === "install-codex" && !daemon.installDone.ok
      ? daemon.installDone
      : null;

  // 실패한 에이전트 행에 고칠 fix 가 없을 때(설치된 다른 에이전트가 있다는
  // 뜻) — 고르게 바꿔 다시 검사게 한다. 목록은 이 데몬이 아는 에이전트들.
  const providerStep = byId.get("claude");
  const showProviderPick =
    providerStep?.status === "fail" && !providerStep.fix && providers.length > 0;
  const [pickedProvider, setPickedProvider] = useState(provider);
  useEffect(() => setPickedProvider(provider), [provider]);

  // 설치가 끝나면(성공·실패 모두) 시작 안내는 제 몫을 다했다 — 실패 문장
  // 아래 "설치를 시작했습니다" 가 두 번 안내로 남지 않게 한다(검수 3단계).
  useEffect(() => {
    const done = daemon.installDone;
    if (!done) return;
    setNotice((prev) => (prev && prev.step === done.kind ? null : prev));
  }, [daemon.installDone]);

  // 다른 모달과 같은 몸통: Escape 도 나가는 길이다. 막는 단계가 있는 동안은
  // onClose 자체가 오지 않으므로 여기서는 그냥 단다. 위에 대화상자가 떠
  // 있으면 최상단 규칙이 그쪽에 준다.
  const rootRef = useRef<HTMLDivElement>(null);
  useModalEscape(rootRef, onClose ?? (() => {}), onClose !== undefined);

  return (
    <div className="onboarding" ref={rootRef}>
      {onClose && (
        <button
          type="button"
          className="ghost onboarding__close"
          aria-label="시작하기 닫기"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      )}
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
        <p className="hint">이 컴퓨터에서 한 번만 확인하는 세 단계입니다.</p>
      </header>

      {/* The gates answered so far, as one quiet fill — motion makes the
          machine's progress legible without a word. */}
      {steps.length > 0 && (
        <div className="onboarding__meter" aria-hidden="true">
          <span
            className="onboarding__meterfill"
            style={{
              width: `${(steps.filter((step) => step.status === "pass").length / steps.length) * 100}%`,
            }}
          />
        </div>
      )}

      {/* 마법사가 떠 있는 동안 놓인 초대 파일 — 드롭 리스너는 Shell 이 이미
          받았고, 마법사가 닫히면 시작 화면이 확인 카드를 그대로 이어 보여
          준다(StartFlow). 여기는 그 사실의 한 줄이다. */}
      {inviteNotice && (
        <div
          className={`notice ${inviteNotice.tone === "error" ? "notice--error" : "notice--info"}`}
          role="status"
        >
          <span className="notice__text">{inviteNotice.text}</span>
        </div>
      )}

      {steps.length === 0 && !error && <p className="hint">단계를 확인하는 중…</p>}
      {error && (
        <div className="notice notice--error">
          <span className="notice__text">{error}</span>
        </div>
      )}

      <ol className="onboarding__steps">
        {/* 통과한 것들의 요약 한 줄 — 통과한 단계가 없으면 이 줄도 없다. */}
        {passedSteps.length > 0 && (
          <li className="onboarding__summary">
            <span className="onboarding__glyph onboarding__glyph--pass">
              <CheckIcon />
            </span>
            <span className="onboarding__summarytext">
              {passedSteps
                .map((step) => (step.id === "claude" ? providerLabel : SHORT_TITLE[step.id]))
                .join(" · ")}{" "}
              준비됨
            </span>
          </li>
        )}
        {openSteps.map((step, rowIndex) => {
          const id = step.id;
          const open = isOpen(id);
          // claude 행만 에이전트를 따라간다 — 나머지 셋은 기계의 정적 문장.
          const title = id === "claude" ? `화면을 만드는 ${providerLabel}` : STEP_TITLE[id];
          const tool = id === "claude" ? provider : STEP_TOOL[id];
          const checkingRow = checkRunning && step.status !== "pass";
          return (
            <li
              key={id}
              className={`onboarding__step onboarding__step--${step.status}${open ? "" : " onboarding__step--line"}`}
              style={{ "--i": rowIndex } as CSSProperties}
            >
              <div className="onboarding__stephead">
                <span className="ic ic--sm ic--quiet">{STEP_ICON[id]}</span>
                <span className={`onboarding__glyph onboarding__glyph--${step.status}`}>
                  {STATUS_ICON[step.status]}
                </span>
                <span className="onboarding__stepnum">{rowIndex + 1}</span>
                <h2>{title}</h2>
                {/* 도구 이름은 부제다 — 알아야 하는 것은 무엇에 쓰는지다. */}
                <span className="onboarding__tool">{tool}</span>
                <span className={`onboarding__status onboarding__status--${step.status}`}>
                  {id === "claude" && rowInstalling
                    ? "설치하는 중…"
                    : id === "claude" && daemon.login
                      ? "로그인하는 중…"
                      : checkingRow
                        ? "확인 중…"
                        : STATUS_LABEL[step.status]}
                </span>
              </div>
              <p className="onboarding__detail">{step.detail}</p>
              {open && step.status !== "pass" && STEP_HINT[id] !== "" && (
                <p className="hint">{STEP_HINT[id]}</p>
              )}

              {/* What this step is, before any button (실사 이후): the first
                  gate asks a non-developer for a CLI they have never heard of,
                  on an account somebody pays for, and opens a Terminal they
                  did not expect. 이 문장은 claude(Claude Code)의 몫이다 —
                  다른 에이전트의 설치·로그인 안내는 데몬의 detail 이 말한다. */}
              {id === "claude" && open && step.status !== "pass" && provider === "claude" && (
                <p className="hint">
                  화면을 만드는 Claude의 도구입니다 — 설치와 로그인에는 본인의 Claude 계정(유료
                  구독)이 필요합니다.
                </p>
              )}

              {/* 설치 진행(3단계): 버튼 대신 진행 줄 한 줄 — 데몬이 내놓는 마지막
                  의미 있는 줄이 그 자리를 지킨다. PATH 문단이나 반복 줄은 오지
                  않는다(진행기가 이미 걸렀다). */}
              {id === "claude" && rowInstalling && (
                <p className="onboarding__installline">설치하는 중… {daemon.install?.line}</p>
              )}
              {id === "claude" && !rowInstalling && rowInstallFailed && (
                <div className="notice notice--error" role="status">
                  <span className="notice__text">
                    {policyCopyLine(rowInstallFailed.detail) ?? rowInstallFailed.detail}
                  </span>
                </div>
              )}
              {id === "claude" &&
                !rowInstalling &&
                policyCopyLine(rowInstallFailed?.detail ?? "") && (
                  <div className="onboarding__copyrow">
                    <p className="onboarding__copyquote">
                      {policyCopyLine(rowInstallFailed?.detail ?? "")}
                    </p>
                    <CopySentenceButton
                      line={policyCopyLine(rowInstallFailed?.detail ?? "") ?? ""}
                    />
                  </div>
                )}

              {/* 터미널 없는 로그인(P1-1): 기본은 한 줄 — "저절로 넘어갑니다"가
                  할 일의 전부다. 주소와 코드 칸은 "브라우저가 열리지 않았나요?"
                  안에 접혀 있다 — wantsCode 와 상관없이 기본은 닫힌다(Claude CLI
                  는 콜백 대기 중에도 코드 프롬프트를 늘 찍으므로 펼침은 사실상
                  항상이었다). 사용자가 열 때만 열린다. */}
              {id === "claude" && open && step.status !== "pass" && daemon.login && (
                <div className="onboarding__login">
                  <p className="hint">
                    브라우저에서 로그인 창이 열렸어요 — 로그인을 마치면 저절로 넘어갑니다.
                  </p>
                  <details className="onboarding__loginhelp">
                    <summary>브라우저가 열리지 않았나요?</summary>
                    <p className="hint">
                      <a
                        className="ghlink"
                        href={daemon.login.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        이 주소
                      </a>
                      로 직접 여세요.
                    </p>
                    {daemon.login.wantsCode && <LoginCodeForm daemon={daemon} />}
                  </details>
                </div>
              )}
              {id === "claude" && open && daemon.loginDone && !daemon.loginDone.ok && (
                <div className="notice notice--error" role="status">
                  <span className="notice__text">{daemon.loginDone.detail}</span>
                </div>
              )}

              {/* 실패했지만 고칠 fix 가 없는 에이전트 행: 설치된 다른
                  에이전트로 갈아타는 길이다. 고른 뒤 다시 확인 — Shell 의
                  effect 가 설정을 바꾸고 그 에이전트의 검사를 다시 건다. */}
              {id === "claude" && showProviderPick && open && (
                <div className="onboarding__pick">
                  <select
                    aria-label="에이전트 고르기"
                    value={pickedProvider}
                    disabled={checkRunning}
                    onChange={(e) => setPickedProvider(e.target.value)}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.available}>
                        {`${p.label}${p.available ? "" : " — 설치 필요"}`}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="ghost"
                    disabled={checkRunning}
                    onClick={() => {
                      if (pickedProvider !== provider && onProviderChange) {
                        onProviderChange(pickedProvider);
                        return;
                      }
                      // run 은 마지막에 검사를 한 번 더 돌린다 — 행동으로도
                      // 검사를 넘기면 같은 게이트가 두 번 돈다. 재확인은
                      // 행동 없이 run 의 마지막 검사 한 번에 맡긴다.
                      void run("recheck", () => Promise.resolve());
                    }}
                  >
                    {checkRunning ? "확인 중…" : "다시 확인"}
                  </button>
                </div>
              )}

              {/* `href` fixes are links, not commands (install-node): the
                  tool installs nothing on somebody's machine by itself.
                  설치가 데몬의 진행기 안에 있거나 로그인이 파이프로 살아 있는
                  동안에는 통째로 숨는다 — 진행 줄과 로그인 판이 그 자리를
                  지킨다(3단계). */}
              {step.fix &&
                step.status !== "pass" &&
                !(id === "claude" && (rowInstalling || daemon.login)) && (
                  <div className="onboarding__fixrow">
                    {step.fix.href ? (
                      <a
                        className="primary ghlink"
                        href={step.fix.href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {step.fix.label}
                      </a>
                    ) : (
                      <button
                        type="button"
                        className="primary"
                        disabled={busyKind !== null || checking}
                        onClick={() =>
                          void run(step.fix!.kind, () =>
                            daemon.api.onboardingFix(
                              step.fix!.kind,
                              // 로그인은 에이전트마다 제 명령이 있다(loginCommand).
                              step.fix!.kind === "login-claude" ? provider : undefined,
                            ),
                          )
                        }
                      >
                        {busyKind === step.fix.kind
                          ? "실행 중…"
                          : // 설치가 실패한 뒤의 같은 버튼은 다시 시도다(3단계).
                            id === "claude" && rowInstallFailed
                            ? "다시 시도"
                            : step.fix.label}
                      </button>
                    )}
                    {/* Anything the planner does outside the app — an installer,
                      a login — ends with the same question: 다시 확인. */}
                    <button
                      type="button"
                      className="ghost"
                      disabled={busyKind !== null || checking}
                      // run 이 마지막에 검사를 돌린다 — 행동 자리에도 검사를
                      // 넘기면 같은 게이트가 두 번 돈다.
                      onClick={() => void run("recheck", () => Promise.resolve())}
                    >
                      {busyKind === "recheck" ? "확인 중…" : "다시 확인"}
                    </button>
                  </div>
                )}
              {step.fix &&
                step.status !== "pass" &&
                !(id === "claude" && (rowInstalling || daemon.login)) &&
                notice?.step === step.fix.kind && (
                  <div
                    className={`notice ${notice.started ? "notice--info" : "notice--error"}`}
                    role="status"
                  >
                    <span className="notice__text">{notice.guidance}</span>
                  </div>
                )}
            </li>
          );
        })}
        {/* 선택 행: Codex(3단계) — 필수 행들 아래, 건너뛰어도 되는 한 줄.
            설치 중·실패 표시는 AI 행과 같은 방식(진행 줄 · notice · 다시 시도). */}
        {codexMissing && (
          <li className="onboarding__step onboarding__step--optional">
            <div className="onboarding__stephead">
              <span className="ic ic--sm ic--quiet">
                <BrainIcon />
              </span>
              <h2>Codex (선택)</h2>
              <span className="onboarding__status">
                {codexInstalling ? "설치하는 중…" : "선택"}
              </span>
            </div>
            <p className="onboarding__detail">
              다른 AI 로 화면을 만들고 싶을 때만 필요해요. 건너뛰어도 됩니다.
            </p>
            {codexInstalling ? (
              <p className="onboarding__installline">설치하는 중… {daemon.install?.line}</p>
            ) : (
              <div className="onboarding__fixrow">
                <button
                  type="button"
                  className="primary"
                  disabled={busyKind !== null || checking}
                  onClick={() =>
                    void run("install-codex", () => daemon.api.onboardingFix("install-codex"))
                  }
                >
                  {busyKind === "install-codex" ? "실행 중…" : codexFailed ? "다시 시도" : "설치"}
                </button>
              </div>
            )}
            {codexFailed && !codexInstalling && (
              <div className="notice notice--error" role="status">
                <span className="notice__text">
                  {policyCopyLine(codexFailed.detail) ?? codexFailed.detail}
                </span>
              </div>
            )}
            {codexFailed && !codexInstalling && policyCopyLine(codexFailed.detail) && (
              <div className="onboarding__copyrow">
                <p className="onboarding__copyquote">{policyCopyLine(codexFailed.detail)}</p>
                <CopySentenceButton line={policyCopyLine(codexFailed.detail) ?? ""} />
              </div>
            )}
          </li>
        )}
      </ol>

      {!blocked && steps.length > 0 && (
        <div className="onboarding__done">
          <button type="button" className="primary onboarding__cta" onClick={onDone}>
            시작하기
          </button>
        </div>
      )}
    </div>
  );
}
