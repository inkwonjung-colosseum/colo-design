import type { DaemonStatus, OnboardingStep, OnboardingStepId } from "@colo-design/protocol";
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from "react";
import { useModalEscape } from "../../hooks/use-modal-focus";
import type { Daemon } from "../../lib/daemon-client";
import { BrainIcon, BranchIcon, CheckIcon, CloseIcon, KeyIcon, PlugIcon, WarnIcon } from "../icons";
import { GitHubTokenForm } from "./GitHubTokenForm";

/**
 * The first-run wizard: machine gates answered once — the agent
 * Code, git, Node·pnpm, the GitHub token — and then it is done. Which repo a
 * planner works on is NOT here: a project is added from the
 * workspace itself, where the clone's own progress is already on screen.
 *
 * One card is open at a time: the first step that is not a pass is the thing
 * a planner can act on right now, and everything before it collapses to a
 * single line. A `warn` (GitHub without a token) does not block: 시작하기
 * stays reachable.
 */
const STEP_ORDER: OnboardingStepId[] = ["claude", "git", "runtime", "github"];

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

/** claude 행의 설명 한 줄 패턴(:203-209)을 나머지 셋에도. */
const STEP_HINT: Record<OnboardingStepId, string> = {
  claude: "",
  git: "화면 작업을 저장하고 개발자에게 넘기는 데 쓰는 도구입니다 — 이 앱이 대신 다룹니다.",
  runtime: "앱 안에 들어 있습니다 — 없다고 나오면 앱 설치가 깨진 것입니다.",
  github:
    "작업을 개발자에게 넘기는 길입니다. 없어도 시작할 수 있습니다 — 공개 저장소로 작업합니다.",
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

export function Onboarding({
  daemon,
  provider = "claude",
  providers = [],
  checking = false,
  onProviderChange,
  onDone,
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
}) {
  const steps = daemon.onboarding ?? [];
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
  /** Re-opens the token form on a github line that already passed. */
  const [editingToken, setEditingToken] = useState(false);

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
  const isOpen = (id: OnboardingStepId) => id === firstOpen || (id === "github" && editingToken);

  // claude 행의 제목·부제는 에이전트를 따라간다: 목록의 label 이 있으면 그
  // 이름으로, 없으면 id 그대로(onboarding-gates.html og-step__nm/__sub).
  const providerLabel = providers.find((p) => p.id === provider)?.label ?? provider;

  // 실패한 에이전트 행에 고칠 fix 가 없을 때(설치된 다른 에이전트가 있다는
  // 뜻) — 고르게 바꿔 다시 검사게 한다. 목록은 이 데몬이 아는 에이전트들.
  const providerStep = byId.get("claude");
  const showProviderPick =
    providerStep?.status === "fail" && !providerStep.fix && providers.length > 0;
  const [pickedProvider, setPickedProvider] = useState(provider);
  useEffect(() => setPickedProvider(provider), [provider]);

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
        <p className="hint">이 컴퓨터에서 한 번만 확인하는 네 단계입니다.</p>
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

      {steps.length === 0 && !error && <p className="hint">단계를 확인하는 중…</p>}
      {error && (
        <div className="notice notice--error">
          <span className="notice__text">{error}</span>
        </div>
      )}

      <ol className="onboarding__steps">
        {STEP_ORDER.map((id) => {
          const step = byId.get(id);
          if (!step) return null;
          const open = isOpen(id);
          // claude 행만 에이전트를 따라간다 — 나머지 셋은 기계의 정적 문장.
          const title = id === "claude" ? `화면을 만드는 ${providerLabel}` : STEP_TITLE[id];
          const tool = id === "claude" ? provider : STEP_TOOL[id];
          const checkingRow = checkRunning && step.status !== "pass";
          return (
            <li
              key={id}
              className={`onboarding__step onboarding__step--${step.status}${open ? "" : " onboarding__step--line"}`}
              style={{ "--i": STEP_ORDER.indexOf(id) } as CSSProperties}
            >
              <div className="onboarding__stephead">
                <span className="ic ic--sm ic--quiet">{STEP_ICON[id]}</span>
                <span className={`onboarding__glyph onboarding__glyph--${step.status}`}>
                  {STATUS_ICON[step.status]}
                </span>
                <span className="onboarding__stepnum">{STEP_ORDER.indexOf(id) + 1}</span>
                <h2>{title}</h2>
                {/* 도구 이름은 부제다 — 알아야 하는 것은 무엇에 쓰는지다. */}
                <span className="onboarding__tool">{tool}</span>
                <span className={`onboarding__status onboarding__status--${step.status}`}>
                  {checkingRow ? "확인 중…" : STATUS_LABEL[step.status]}
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
                  구독)이 필요합니다. 로그인하면 터미널 창이 열립니다. macOS가 'Terminal이 이 앱을
                  제어하려고 합니다'라고 물으면 허용해 주세요.
                </p>
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

              {/* A passed token is still replaceable — expiry is the reason,
                  and it is the one thing this line can offer. */}
              {id === "github" && step.status === "pass" && !editingToken && (
                <div className="onboarding__fixrow">
                  <button type="button" className="ghost" onClick={() => setEditingToken(true)}>
                    토큰 바꾸기
                  </button>
                </div>
              )}

              {id === "github" && (open || editingToken) && (
                <>
                  <GitHubTokenForm daemon={daemon} onDone={() => setEditingToken(false)} />
                  {/* 누르는 곳이 앱 밖이라는 예고(onboarding-gates.html og-note) —
                      새 창이 열리는 놀람을 덜어 둔다. */}
                  <p className="onboarding__note">
                    토큰 입력은 GitHub에서 열립니다 — 브라우저로 이동합니다 ↗
                  </p>
                </>
              )}

              {/* `href` fixes are links, not commands (install-node): the
                  tool installs nothing on somebody's machine by itself. */}
              {step.fix && step.status !== "pass" && (
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
                        void run(step.fix!.kind, () => daemon.api.onboardingFix(step.fix!.kind))
                      }
                    >
                      {busyKind === step.fix.kind ? "실행 중…" : step.fix.label}
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
              {step.fix && step.status !== "pass" && notice?.step === step.fix.kind && (
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
      </ol>

      {!blocked && steps.length > 0 && (
        <div className="onboarding__done">
          <button type="button" className="primary onboarding__cta" onClick={onDone}>
            시작하기
          </button>
          {/* github 의 토큰뿐 남았을 때의 나중에(onboarding-gates.html) —
              없어도 시작할 수 있다는 안내의 회답이다. 막는 단계가 하나라도
              있으면 onClose 자체가 오지 않는다. */}
          {onClose &&
            steps.length > 0 &&
            steps.some((step) => step.id === "github" && step.status !== "pass") &&
            steps.every((step) => step.status === "pass" || step.id === "github") && (
              <button type="button" className="ghost" onClick={onClose}>
                나중에
              </button>
            )}
        </div>
      )}
    </div>
  );
}
