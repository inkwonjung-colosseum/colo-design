import { useEffect } from "react";
import type { Daemon } from "./daemon-client";
import { PageWorkspace } from "./PageWorkspace";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { Onboarding } from "./Onboarding";
import type { ChatSettings, Settings } from "./settings";
import { GearIcon } from "./icons";

/**
 * The frame around the workspace: project switcher, header, warnings, and the
 * onboarding gate.
 *
 * There is one workspace now (PLAN D1). The 기획/디자인 tabs that used to live
 * here were the daemon's two cwds showing through — a planner works on one
 * 기획서 at a time, not on one half of the tool at a time, and `PageWorkspace`
 * is that page.
 */
export function Shell({
  daemon,
  settings,
  onChatChange,
  onOpenSettings,
  onboardingOpen,
  onOpenOnboarding,
  onOnboardingClose,
}: {
  daemon: Daemon;
  settings: Settings;
  /** 설정 owns how Claude answers (PLAN D10); the workspace starts threads on it. */
  onChatChange: (patch: Partial<ChatSettings>) => void;
  onOpenSettings: () => void;
  /** Forces the first-run wizard open (SettingsDialog's 다시 보기). */
  onboardingOpen: boolean;
  /** Opens that same wizard from the empty page tree. */
  onOpenOnboarding: () => void;
  onOnboardingClose: () => void;
}) {
  const { connection, status, api } = daemon;

  useEffect(() => {
    if (connection !== "open") return;
    void api.confluenceStatus().catch(() => undefined);
    void api.onboardingCheck().catch(() => undefined);
  }, [connection, api]);

  // Every gate has to pass (warns carry their own fix) before the workspace
  // opens. An UNANSWERED check blocks too: the checks run real commands and
  // take a second or two, and treating "not yet known" as "fine" flashed the
  // whole workspace at a planner who has not configured anything, then yanked
  // it away. The wizard renders its own 확인하는 중 while it waits.
  const onboardingBlocked =
    daemon.onboarding === null || daemon.onboarding.some((step) => step.status === "fail");
  // The daemon knows why it cannot work — no CLI, not signed in, no pnpm — and
  // the planner cannot read a terminal to find out.
  const warnings = status?.warnings ?? [];

  if (onboardingBlocked || onboardingOpen) {
    return (
      <div className="planner planner--onboarding">
        <Onboarding daemon={daemon} onDone={onOnboardingClose} />
      </div>
    );
  }

  return (
    <div className="planner">
      <header className="planner__header">
        <span className="brand-name">Drafthouse</span>
        <ProjectSwitcher daemon={daemon} onNewProject={onOpenOnboarding} />
        <span className="planner__spacer" />
        {/* The header used to read "데몬: 연결됨 · https://github.com/…" — the
            name of a program the planner never starts, beside a git url they
            never type (PLAN D13). What is left is the only part that changes
            what they should do: whether the tool can work right now. Both the
            address and the repo live in 설정 → 문제 해결. */}
        {connection !== "open" && (
          <span className="hint" title="연결이 끊기면 대화와 저장이 잠시 멈춥니다">
            연결하는 중…
          </span>
        )}
        <button
          type="button"
          className="ghost"
          aria-label="설정"
          title="설정"
          onClick={onOpenSettings}
        >
          <GearIcon />
        </button>
      </header>

      {warnings.length > 0 && (
        <div className="planner__warnings">
          {warnings.map((warning) => (
            <div key={warning} className="notice notice--warn">
              <span className="notice__text">{warning}</span>
            </div>
          ))}
        </div>
      )}

      <div className="planner__body">
        <PageWorkspace
          daemon={daemon}
          settings={settings}
          onChatChange={onChatChange}
          onOpenSettings={onOpenSettings}
          onOpenOnboarding={onOpenOnboarding}
        />
      </div>
    </div>
  );
}
