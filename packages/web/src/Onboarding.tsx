import { useState, type CSSProperties } from "react";
import type { OnboardingStep, OnboardingStepId } from "@cds-design/protocol";
import type { Daemon } from "./daemon-client";
import { GitHubTokenForm } from "./GitHubTokenForm";

/**
 * The first-run wizard (DESIGN §8): machine gates answered once — Claude
 * Code, git, Node·pnpm, the GitHub token — and then it is done. Which repo a
 * planner works on is NOT here (PLAN D4/D25): a project is added from the
 * workspace itself, where the clone's own progress is already on screen.
 *
 * One card is open at a time: the first step that is not a pass is the thing
 * a planner can act on right now, and everything before it collapses to a
 * single line. A `warn` (GitHub without a token) does not block: 시작하기
 * stays reachable.
 */
const STEP_ORDER: OnboardingStepId[] = ["claude", "git", "runtime", "github"];

const STEP_TITLE: Record<OnboardingStepId, string> = {
  claude: "Claude Code",
  git: "git",
  runtime: "Node · pnpm",
  github: "GitHub",
};


const STATUS_GLYPH: Record<OnboardingStep["status"], string> = {
  pass: "✓",
  warn: "!",
  fail: "✗",
};

const STATUS_LABEL: Record<OnboardingStep["status"], string> = {
  pass: "통과",
  warn: "주의",
  fail: "실패",
};

export function Onboarding({
  daemon,
  onDone,
}: {
  daemon: Daemon;
  /** Called when every blocking step passed (the workspace may open). */
  onDone: () => void;
}) {
  const steps = daemon.onboarding ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Re-opens the token form on a github line that already passed. */
  const [editingToken, setEditingToken] = useState(false);

  const byId = new Map(steps.map((step) => [step.id, step]));
  const blocked = steps.some((step) => step.status === "fail");
  const busyKind = busy ?? null;

  // The check is NOT run here. `Shell` runs it on connect and this wizard is
  // its child, so a second effect meant every gate ran twice per open.

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
      await daemon.api.onboardingCheck();
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

  return (
    <div className="onboarding">
      <header className="onboarding__head">
        <div className="onboarding__brand" aria-hidden="true">
          <span className="onboarding__mark" />
        </div>
        <h1>CDS Design 시작하기</h1>
        <p className="hint">이 컴퓨터에서 한 번만 확인하는 네 단계입니다.</p>
      </header>

      {/* The gates answered so far, as one quiet fill — motion makes the
          machine's progress legible without a word. */}
      {steps.length > 0 && (
        <div className="onboarding__meter" aria-hidden="true">
          <span
            className="onboarding__meterfill"
            style={{ width: `${(steps.filter((step) => step.status === "pass").length / steps.length) * 100}%` }}
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
          return (
            <li
              key={id}
              className={`onboarding__step onboarding__step--${step.status}${open ? "" : " onboarding__step--line"}`}
              style={{ "--i": STEP_ORDER.indexOf(id) } as CSSProperties}
            >
              <div className="onboarding__stephead">
                <span className={`onboarding__glyph onboarding__glyph--${step.status}`}>
                  {STATUS_GLYPH[step.status]}
                </span>
                <span className="onboarding__stepnum">{STEP_ORDER.indexOf(id) + 1}</span>
                <h2>{STEP_TITLE[id]}</h2>
                <span className={`onboarding__status onboarding__status--${step.status}`}>
                  {STATUS_LABEL[step.status]}
                </span>
              </div>
              <p className="onboarding__detail">{step.detail}</p>

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
                <GitHubTokenForm daemon={daemon} onDone={() => setEditingToken(false)} />
              )}

              {/* `href` fixes are links, not commands (install-node): the
                  tool installs nothing on somebody's machine by itself. */}
              {step.fix && step.status !== "pass" && (
                <div className="onboarding__fixrow">
                  {step.fix.href ? (
                    <a className="primary ghlink" href={step.fix.href} target="_blank" rel="noreferrer">
                      {step.fix.label}
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      disabled={busyKind !== null}
                      onClick={() => void run(step.fix!.kind, () => daemon.api.onboardingFix(step.fix!.kind))}
                    >
                      {busyKind === step.fix.kind ? "실행 중…" : step.fix.label}
                    </button>
                  )}
                  {/* Anything the planner does outside the app — an installer,
                      a login — ends with the same question: 다시 확인. */}
                  <button
                    type="button"
                    className="ghost"
                    disabled={busyKind !== null}
                    onClick={() => void run("recheck", () => daemon.api.onboardingCheck())}
                  >
                    다시 확인
                  </button>
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
        </div>
      )}
    </div>
  );
}
