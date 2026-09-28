import {
  type OnboardingFixKind,
  RELEASES_REPO,
  type UpdateCheckResult,
} from "@nova-design/protocol";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useInstallStep } from "../../hooks/use-install-step";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import type { Daemon } from "../../lib/daemon-client";
import { requestInvitePicker } from "../../lib/invite-bus";
import {
  type ChatSettings,
  type NoticeTiming,
  PICKER_THEMES,
  type PickerTheme,
  type Settings,
  switchProviderPatch,
} from "../../lib/settings";
import { DEV, L } from "../labels";
import { connectionCopy } from "../lib/connection-copy";
import { type CheckNote, shouldClearCheckNote, updateRowCopy } from "../lib/update-row";
import { hasNewerVersion } from "../lib/version";
import { CloseIcon } from "../onboarding/icons";
import { modalCloseMs, themePeekHalves } from "../onboarding/motion";
import { CheckIcon, Spin } from "../ui/icons";

/** 설정의 다섯 줄과 폴드(PLAN-UI U12) — `nav.openSettings` 가 연다. 문장은 전부
 *  labels(L · DEV)에서 오고, 저장은 옛 대화상자와 같은 길(테마 · 알림은 settings,
 *  프로바이더는 chat 의 patch, 자동 설치 · 작성 이름은 데몬의 machine 설정)을 쓴다. */
export function SettingsDialog({
  daemon,
  settings,
  onChatChange,
  onSettingsChange,
  onClose,
}: {
  daemon: Daemon;
  settings: Settings;
  onChatChange: (patch: Partial<ChatSettings>) => void;
  /** 알림 정책의 저장 — App 의 settings 상태가 유일한 원천이다. */
  onSettingsChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}) {
  const status = daemon.status;
  const providers = status?.providers ?? [];
  // 쓸 수 있는 AI — 설치되어 있고 로그인돼 있는 것만 카드로 선다(README B1).
  const usable = providers.filter((provider) => provider.available && provider.loggedIn !== false);
  // 설치는 됐지만 로그인이 없는 AI — 미설치와 갈라 읽는다(2026-09-28): 이 판을
  // 「설치되지 않았어요」로 말하면 설치 판별을 못 하는 것처럼 보였다.
  const needsLogin = providers.filter(
    (provider) => provider.available && provider.loggedIn === false,
  );
  const missing = providers.filter((provider) => !provider.available);
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel);
  useEffect(() => {
    panel.current?.focus();
  }, []);

  // 설치 · 업데이트 진행기의 날 줄은 화면에 내리지 않는다 — 단계 말만 선다.
  const installStep = useInstallStep(daemon.install?.line ?? null);
  const installStepWord =
    installStep === null ? L.settings.installBusy : L.onboarding.installSteps[installStep];

  // 닫히는 중 — 역방향 pop 이 끝나는 뒤에 물러난다(움직임을 끈 창은 곧바로).
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );
  const requestClose = () => {
    if (closing || closeTimer.current !== null) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
    if (modalCloseMs(reduced) === 0) {
      onClose();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      onClose();
    }, modalCloseMs(reduced));
  };
  useModalEscape(panel, requestClose);

  // 화살표 걸음 — 테마 카드 사이를 옮겨 가며 곧바로 그것을 고른다.
  const themeArrowStep = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    if (!forward && event.key !== "ArrowLeft" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const count = PICKER_THEMES.length;
    const at = Math.max(0, PICKER_THEMES.indexOf(settings.theme as PickerTheme));
    const nextIndex = (at + (forward ? 1 : -1) + count) % count;
    onSettingsChange({ theme: PICKER_THEMES[nextIndex] });
    const cards = event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role='radio']");
    cards[nextIndex]?.focus();
  };

  // ── AI — 설치가 끝나면 목록이 스스로 바뀌게: 옛 대화상자의 고침과 같은 길.
  const [fixBusy, setFixBusy] = useState<string | null>(null);
  const [fixNotice, setFixNotice] = useState<{ id: string; text: string } | null>(null);
  const installAgent = async (id: string) => {
    const kind: OnboardingFixKind = id === "codex" ? "install-codex" : "install-claude";
    setFixBusy(id);
    setFixNotice(null);
    try {
      const reply = (await daemon.api.onboardingFix(kind)) as { guidance?: unknown };
      if (reply && typeof reply === "object" && "guidance" in reply) {
        setFixNotice({ id, text: String(reply.guidance) });
      }
      await daemon.api.onboardingCheck(id);
    } catch (error) {
      setFixNotice({ id, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setFixBusy(null);
    }
    await daemon.api.refreshStatus();
  };

  /** 로그인 필요 행의 고침 — 데몬이 로그인을 대신 몰고, 주소와 끝은 방송으로 온다. */
  const loginAgent = async (id: string) => {
    const kind: OnboardingFixKind = id === "codex" ? "login-codex" : "login-claude";
    setFixBusy(id);
    setFixNotice(null);
    try {
      const reply = (await daemon.api.onboardingFix(kind)) as { guidance?: unknown };
      if (reply && typeof reply === "object" && "guidance" in reply) {
        setFixNotice({ id, text: String(reply.guidance) });
      }
    } catch (error) {
      setFixNotice({ id, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setFixBusy(null);
    }
  };
  // 로그인이 끝나면 목록이 스스로 바뀌게 — 상태를 다시 읽는다.
  useEffect(() => {
    if (daemon.loginDone?.ok) void daemon.api.refreshStatus();
  }, [daemon.loginDone, daemon.api]);

  // ── 알림 — 저장은 옛 대화상자와 같은 곳(settings.notifications).
  const [noticeTest, setNoticeTest] = useState<string | null>(null);
  const sendTestNotice = async () => {
    setNoticeTest(null);
    const bridge = window.novaDesignDesktop;
    if (bridge?.notifyTest) {
      const result = await bridge.notifyTest();
      setNoticeTest(
        result?.shown === false ? L.settings.testBlocked(result.error) : L.settings.testSent,
      );
      return;
    }
    if (typeof Notification === "undefined") return;
    try {
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission !== "granted") {
        setNoticeTest(L.settings.testBlocked());
        return;
      }
      new Notification(L.settings.testNotify, {
        body: L.settings.testNotifyBody,
        silent: !settings.notifications.sound,
      });
      setNoticeTest(L.settings.testSent);
    } catch {
      // 페이지에서 직접 띄우지 못하는 브라우저 — 조용히 끝낸다.
    }
  };

  // ── 연결 — 작성 이름은 데몬이 기억하고(machine.author.set), 연결 상태는
  // 만료 판정(githubAuthExpired · attention)이 말한다.
  const [authorDraft, setAuthorDraft] = useState(status?.authorName ?? "");
  const commitAuthor = () => {
    const next = authorDraft.trim();
    if (next === (status?.authorName ?? "")) return;
    void daemon.api.machineAuthorSet(next === "" ? null : next).catch(() => undefined);
  };
  const expired = status?.githubAuthExpired === true || status?.attention?.kind === "reconnect";
  // 연결 한 줄(U17) — 만료 예정을 데몬이 머리글에서 읽어 왔다면 남은 날을 말한다.
  const connection = connectionCopy(
    {
      expired,
      expiresAt: status?.githubTokenExpiresAt ?? null,
      projects: daemon.projects.length,
      noticeRoute: status?.noticeRoute ?? "none",
    },
    Date.now(),
    L,
  );
  const bridgeOpenHome =
    window.novaDesignDesktop && "openHome" in window.novaDesignDesktop
      ? window.novaDesignDesktop.openHome
      : undefined;
  const bridgeOpenNotificationSettings =
    window.novaDesignDesktop && "openNotificationSettings" in window.novaDesignDesktop
      ? window.novaDesignDesktop.openNotificationSettings
      : undefined;

  // ── 업데이트 — 앱은 데스크톱 다리가, AI 는 데몬의 확인 · 진행기가 맡는다.
  const desktop = window.novaDesignDesktop ?? null;
  const [appCheck, setAppCheck] = useState<UpdateCheckResult | null>(null);
  const [appPhase, setAppPhase] = useState<"idle" | "installing" | "prepared" | "deferred">("idle");
  const [appNote, setAppNote] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<{ id: string; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<CheckNote | null>(null);

  /** 버전을 아는(=깔려 있는) 에이전트 — 업데이트 줄과 `지금 확인`의 대상. */
  const installedAgents = (["claude", "codex"] as const).filter((id) =>
    providers.some((provider) => provider.id === id && provider.version),
  );
  const runAgentUpdate = (id: "claude" | "codex") => {
    setAgentError(null);
    void daemon.api
      .agentUpdate(id)
      .catch((error) =>
        setAgentError({ id, text: error instanceof Error ? error.message : String(error) }),
      );
  };
  const installApp = async () => {
    if (!appCheck?.url || !appCheck.sha256) return;
    setAppPhase("installing");
    setAppNote(null);
    try {
      const result = await window.novaDesignDesktop?.selfUpdate();
      if (result && typeof result === "object" && "error" in result && result.error) {
        throw new Error(String(result.error));
      }
      // 세션이 돌고 있으면 메인이 설치를 연기한다 — 이 문장이 그 약속을 보여준다.
      if (result && typeof result === "object" && "deferred" in result) {
        setAppPhase("deferred");
        return;
      }
      // 내려받기·검증이 끝나면 재시작 동의만 남는다 — 두 번째 누름이 그 동의다.
      if (result && typeof result === "object" && "prepared" in result) {
        setAppPhase("prepared");
        return;
      }
      setAppNote(L.update.appRestart);
    } catch (error) {
      setAppPhase("idle");
      setAppNote(error instanceof Error ? error.message : String(error));
    }
  };
  const checkNow = async () => {
    setChecking(true);
    setCheckNote(null);
    const jobs = installedAgents.map((id) =>
      daemon.api
        .agentUpdate(id, true)
        .then((reply) =>
          Boolean(
            reply.latestVersion &&
              hasNewerVersion(
                providers.find((entry) => entry.id === id)?.version,
                reply.latestVersion,
              ),
          ),
        )
        .catch(() => false),
    );
    if (desktop?.updateCheck) {
      jobs.push(
        desktop
          .updateCheck()
          .then((result) => {
            if (result && typeof result === "object" && "error" in result && result.error) {
              throw new Error(String(result.error));
            }
            setAppCheck(result);
            return result.updateAvailable;
          })
          .catch(() => false),
      );
    }
    const results = await Promise.all(jobs);
    const found = results.filter(Boolean).length;
    setCheckNote(
      found > 0
        ? { text: L.update.foundCount(found), found }
        : { text: L.update.allLatest, found: 0 },
    );
    setChecking(false);
  };

  // 확인 문장은 상태에서 저절로 늙는다(W5 · N7) — 「새 버전 N개」가 끝난 일을
  // 말하는 순간(업데이트 완료 · 새 버전이 더 없음) 제 자리를 비운다.
  useEffect(() => {
    if (shouldClearCheckNote(checkNote, status?.agentUpdates, providers)) setCheckNote(null);
  }, [checkNote, status?.agentUpdates, providers]);

  const autoUpdate = status?.agentAutoUpdate ?? true;
  const active = daemon.projects.find((project) => project.slug === daemon.activeSlug) ?? null;
  const canSelfUpdate = desktop?.platform === "darwin" || desktop?.platform === "win32";
  // 앱 줄의 판정 — 확인 전에는 모른다, 최신이면 피드의 버전이 곧 현재다.
  const appCopy = appCheck
    ? appCheck.updateAvailable
      ? null
      : updateRowCopy(
          { id: "app", version: appCheck.version, latestVersion: appCheck.version },
          L.update,
        )
    : null;

  const agentRow = (id: "claude" | "codex") => {
    const provider = providers.find((entry) => entry.id === id);
    const state = status?.agentUpdates?.[id];
    const copy = updateRowCopy(
      {
        id,
        version: provider?.version ?? null,
        latestVersion: provider?.latestVersion ?? null,
        ...(state ? { phase: state.phase, at: state.at } : {}),
        ...(state?.version ? { versionAfter: state.version } : {}),
        ...(state?.detail ? { detail: state.detail } : {}),
      },
      L.update,
    );
    return (
      <div key={id} className={`nx-upd-row${copy.state === "available" ? " nx-upd-row--new" : ""}`}>
        <span className="nx-un">{provider?.label ?? id}</span>
        <span className="nx-uv">
          {copy.version}
          {copy.state === "latest" && (
            <span className="nx-ok">
              <CheckIcon />
              {L.update.latest}
            </span>
          )}
          {copy.state === "latest" && copy.note && <span>· {copy.note}</span>}
          {copy.state === "failed" && copy.note && (
            <span className="nx-snote nx-snote--red">{copy.note}</span>
          )}
        </span>
        {copy.state === "pending" && <span className="nx-snote">{copy.note}</span>}
        {copy.action === "update" && (
          <button
            type="button"
            className="nx-btn nx-btn--sm nx-btn--pri"
            onClick={() => runAgentUpdate(id)}
          >
            {L.update.run}
          </button>
        )}
        {copy.action === "retry" && (
          <button type="button" className="nx-btn nx-btn--sm" onClick={() => runAgentUpdate(id)}>
            {L.update.retry}
          </button>
        )}
        {copy.state === "running" && (
          <div className="nx-prog">
            <div className="nx-upd-bar" />
            <div role="status">
              {daemon.install?.kind === `update-${id}` ? (
                <span key={installStepWord} className="nx-inst-word">
                  {installStepWord}
                </span>
              ) : null}
            </div>
          </div>
        )}
        {agentError?.id === id && (
          <div className="nx-prog">
            <span className="nx-snote nx-snote--red">{agentError.text}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    // 배경을 누르면 창이 물러난다 — 눌린 곳이 배경 자신일 때만(안의 창은 제외).
    // biome-ignore lint/a11y/noStaticElementInteractions: 배경 누름은 포인터의 길이다 — 키보드는 Esc 와 닫기 단추로 같은 곳에 닿는다.
    <div
      className={`nx-set-back${closing ? " nx-set-back--out" : ""}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={panel}
        className="nx-set"
        role="dialog"
        aria-modal="true"
        aria-label={L.settings.title}
        tabIndex={-1}
      >
        <div className="nx-set-hd">
          <h2>{L.settings.title}</h2>
          <button
            type="button"
            className="nx-ibtn"
            aria-label={L.settings.close}
            onClick={requestClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="nx-set-body">
          <section className="nx-srow">
            <div className="nx-sl">
              <b>{L.settings.ai}</b>
              <span>{L.settings.aiSub}</span>
            </div>
            <div className="nx-sr" role="radiogroup" aria-label={L.settings.ai}>
              {usable.map((provider) => (
                // biome-ignore lint/a11y/useSemanticElements: 카드 전체가 누르는 과녁이다 — 동그라미 입력칸 없이 radio 로 읽힌다(radiogroup 안).
                <button
                  key={provider.id}
                  type="button"
                  role="radio"
                  aria-checked={settings.chat.provider === provider.id}
                  className={`nx-rcard${settings.chat.provider === provider.id ? " nx-rcard--on" : ""}`}
                  onClick={() =>
                    settings.chat.provider === provider.id
                      ? undefined
                      : onChatChange(switchProviderPatch(settings.chat, provider.id))
                  }
                >
                  <span className="nx-rd" />
                  <span className="nx-rt">
                    <b>{provider.label}</b>
                    <span>{L.settings.loggedIn}</span>
                  </span>
                </button>
              ))}
              {(missing.length > 0 || needsLogin.length > 0) && (
                <details className="nx-sfold">
                  <summary>{L.settings.unavailable(missing.length + needsLogin.length)}</summary>
                  {missing.map((provider) => (
                    <div key={provider.id} className="nx-rcard">
                      <span className="nx-rt">
                        <b>{provider.label}</b>
                        <span>{provider.reason ?? L.settings.notInstalled}</span>
                      </span>
                      {(provider.id === "claude" || provider.id === "codex") &&
                        (daemon.install?.kind ===
                        (provider.id === "codex" ? "install-codex" : "install-claude") ? (
                          <span
                            key={installStepWord}
                            className="nx-snote nx-inst-word"
                            role="status"
                          >
                            {installStepWord}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="nx-btn nx-btn--sm"
                            disabled={fixBusy !== null}
                            onClick={() => void installAgent(provider.id)}
                          >
                            {fixBusy === provider.id ? L.settings.installBusy : L.settings.install}
                          </button>
                        ))}
                    </div>
                  ))}
                  {needsLogin.map((provider) => (
                    <div key={provider.id} className="nx-rcard">
                      <span className="nx-rt">
                        <b>{provider.label}</b>
                        <span>{provider.reason ?? L.settings.loginNeeded}</span>
                      </span>
                      {(provider.id === "claude" || provider.id === "codex") && (
                        <button
                          type="button"
                          className="nx-btn nx-btn--sm"
                          disabled={fixBusy !== null}
                          onClick={() => void loginAgent(provider.id)}
                        >
                          {fixBusy === provider.id ? L.settings.loginBusy : L.settings.login}
                        </button>
                      )}
                    </div>
                  ))}
                  {daemon.login && (
                    <div className="nx-prog nx-snote">
                      <button
                        type="button"
                        className="nx-btn nx-btn--sm"
                        onClick={() => window.open(daemon.login?.url, "_blank", "noopener")}
                      >
                        {L.settings.loginReopen}
                      </button>
                      {daemon.login.wantsCode && <AgentLoginCode daemon={daemon} />}
                    </div>
                  )}
                </details>
              )}
              {fixNotice && <p className="nx-snote">{fixNotice.text}</p>}
            </div>
          </section>

          <section className="nx-srow">
            <div className="nx-sl">
              <b>{L.settings.theme}</b>
              <span>{L.settings.themeSub}</span>
            </div>
            <div className="nx-sr">
              {/* 같은 일곱 선택 — 보이는 법만 카드로. 미리보기는 진짜 팔레트를 입은 조각이다. */}
              <div
                className="nx-theme-grid"
                role="radiogroup"
                aria-label={L.settings.theme}
                onKeyDown={(event) => themeArrowStep(event)}
              >
                {PICKER_THEMES.map((choice) => (
                  // biome-ignore lint/a11y/useSemanticElements: 카드 전체가 누르는 과녁이다 — AI 카드와 같은 모양(radiogroup 안).
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={settings.theme === choice}
                    className={`nx-rcard nx-theme-card${
                      settings.theme === choice ? " nx-rcard--on" : ""
                    }`}
                    onClick={() => onSettingsChange({ theme: choice })}
                  >
                    <span className="nx-theme-peek" aria-hidden="true">
                      {themePeekHalves(choice).map((half) => (
                        <i key={half} className="nx-peek-fill" data-theme={half}>
                          <i className="nx-peek-panel" />
                          <i className="nx-peek-dot" />
                          <i className="nx-peek-line" />
                        </i>
                      ))}
                    </span>
                    <span className="nx-rt">
                      <b>{L.settings.themeNames[choice]}</b>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="nx-srow">
            <div className="nx-sl">
              <b>{L.settings.notify}</b>
              <span>{L.settings.notifySub}</span>
            </div>
            <div className="nx-sr">
              <div className="nx-sline">
                <label htmlFor="nx-notify-done">{L.settings.notifyDone}</label>
                <select
                  id="nx-notify-done"
                  value={settings.notifications.done}
                  onChange={(event) =>
                    onSettingsChange({
                      notifications: {
                        ...settings.notifications,
                        done: event.target.value as NoticeTiming,
                      },
                    })
                  }
                >
                  <option value="off">{L.settings.notifyOff}</option>
                  <option value="long">{L.settings.notifyLong}</option>
                  <option value="all">{L.settings.notifyAll}</option>
                </select>
              </div>
              <div className="nx-sline">
                <span className="nx-slabel" id="nx-notify-sound">
                  {L.settings.sound}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.notifications.sound}
                  aria-labelledby="nx-notify-sound"
                  className={`nx-sw${settings.notifications.sound ? " nx-sw--on" : ""}`}
                  onClick={() =>
                    onSettingsChange({
                      notifications: {
                        ...settings.notifications,
                        sound: !settings.notifications.sound,
                      },
                    })
                  }
                />
              </div>
              <div className="nx-sline">
                <button
                  type="button"
                  className="nx-btn nx-btn--sm"
                  onClick={() => void sendTestNotice()}
                >
                  {L.settings.testNotify}
                </button>
                {bridgeOpenNotificationSettings && (
                  <button
                    type="button"
                    className="nx-btn nx-btn--sm nx-btn--ghost"
                    onClick={() => void bridgeOpenNotificationSettings()}
                  >
                    {L.settings.openSystemNotify}
                  </button>
                )}
              </div>
              {noticeTest && <p className="nx-snote">{noticeTest}</p>}
              <p className="nx-snote">{L.settings.testNotifyNote}</p>
            </div>
          </section>

          <section className="nx-srow">
            <div className="nx-sl">
              <b>{L.settings.connection}</b>
              <span>{L.settings.connectionSub}</span>
            </div>
            <div className="nx-sr">
              <div className="nx-sline">
                <label htmlFor="nx-author">{L.settings.authorName}</label>
                <input
                  id="nx-author"
                  type="text"
                  value={authorDraft}
                  onChange={(event) => setAuthorDraft(event.target.value)}
                  onBlur={commitAuthor}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitAuthor();
                  }}
                />
              </div>
              <div className="nx-sline">
                <span className="nx-slabel">{L.settings.connectionCode}</span>
                <span>
                  <span className={`nx-dot nx-dot--${connection.dot}`} /> {connection.text}
                </span>
              </div>
              <div className="nx-sline">
                <button
                  type="button"
                  className="nx-btn nx-btn--sm"
                  disabled={daemon.connection !== "open"}
                  onClick={() => {
                    // 고르기 창이 열리는 동안 설정은 물러난다 — 확인 카드가 이어받는다.
                    requestInvitePicker();
                    onClose();
                  }}
                >
                  {L.settings.openInvite}
                </button>
              </div>
            </div>
          </section>

          <section className="nx-srow">
            <div className="nx-sl">
              <b>{L.settings.update}</b>
              <span>{L.settings.updateSub}</span>
            </div>
            <div className="nx-sr">
              <div className="nx-upd">
                {desktop?.updateCheck && (
                  <div
                    className={`nx-upd-row${appCheck?.updateAvailable ? " nx-upd-row--new" : ""}`}
                  >
                    <span className="nx-un">{L.update.app}</span>
                    <span className="nx-uv">
                      {appCheck?.updateAvailable
                        ? L.update.appAvailable(appCheck.version)
                        : appCopy?.version}
                      {appCopy?.state === "latest" && (
                        <span className="nx-ok">
                          <CheckIcon />
                          {L.update.latest}
                        </span>
                      )}
                      {appPhase === "deferred" && (
                        <span className="nx-snote">{L.update.deferred}</span>
                      )}
                    </span>
                    {appCheck?.updateAvailable &&
                      (canSelfUpdate ? (
                        <button
                          type="button"
                          className="nx-btn nx-btn--sm nx-btn--pri"
                          disabled={appPhase === "installing"}
                          onClick={() => void installApp()}
                        >
                          {appPhase === "installing" ? L.update.appBusy : L.update.runApp}
                        </button>
                      ) : (
                        <a
                          className="nx-snote"
                          href={`https://github.com/${RELEASES_REPO}/releases/latest`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {L.update.releasesLink}
                        </a>
                      ))}
                    {appNote && (
                      <div className="nx-prog">
                        <span className="nx-snote nx-snote--red">{appNote}</span>
                      </div>
                    )}
                  </div>
                )}
                {agentRow("claude")}
                {installedAgents.includes("codex") && agentRow("codex")}
              </div>
              <div className="nx-sline">
                <span className="nx-slabel" id="nx-autoupd">
                  {L.update.autoLabel}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoUpdate}
                  aria-labelledby="nx-autoupd"
                  className={`nx-sw${autoUpdate ? " nx-sw--on" : ""}`}
                  onClick={() =>
                    void daemon.api.machineSet(undefined, !autoUpdate).catch((error) =>
                      setCheckNote({
                        text: error instanceof Error ? error.message : String(error),
                        found: 0,
                      }),
                    )
                  }
                />
                <span className="nx-snote">{L.update.autoNote}</span>
              </div>
              <p className="nx-snote">{L.update.useNextTime}</p>
              <div className="nx-sline">
                <button
                  type="button"
                  className="nx-btn nx-btn--sm"
                  disabled={checking}
                  onClick={() => void checkNow()}
                >
                  {checking ? (
                    <>
                      <Spin /> {L.update.checking}
                    </>
                  ) : (
                    L.update.checkNow
                  )}
                </button>
                {checkNote && <span className="nx-snote">{checkNote.text}</span>}
              </div>
            </div>
          </section>

          <section className="nx-srow">
            <div className="nx-sl">
              <b>{L.settings.developer}</b>
              <span>{L.settings.developerSub}</span>
            </div>
            <div className="nx-sr">
              <details className="nx-sfold">
                <summary>{L.settings.developerFold}</summary>
                <div className="nx-devbox">
                  <div className="nx-sline">
                    <span>{L.settings.toolFolder}</span>
                    {typeof bridgeOpenHome === "function" ? (
                      <button
                        type="button"
                        className="nx-btn nx-btn--sm"
                        onClick={() => void bridgeOpenHome()}
                      >
                        {L.settings.openFolder}
                      </button>
                    ) : (
                      <span className="nx-snote">~/.nova-design</span>
                    )}
                  </div>
                  <div className="nx-sline">
                    <span>{L.settings.dailyLog}</span>
                    {typeof bridgeOpenHome === "function" && (
                      <button
                        type="button"
                        className="nx-btn nx-btn--sm"
                        onClick={() => void bridgeOpenHome("logs")}
                      >
                        {L.settings.openLogFolder}
                      </button>
                    )}
                  </div>
                  <p className="nx-stbl">
                    {DEV.daemonLine(status?.protocolVersion ?? 0, daemon.connection === "open")}
                    <br />
                    {DEV.activeProject(active?.repoUrl ?? null, daemon.repo?.phase === "ready")}
                    <br />
                    {DEV.selfUpdateNote}
                  </p>
                </div>
              </details>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** 로그인 코드 붙여넣기 — 데몬이 로그인 자식의 stdin 으로 흘려 보낸다(온보딩의 것과 같은 길). */
function AgentLoginCode({ daemon }: { daemon: Daemon }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (code.trim() === "") return;
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
    <span className="nx-row">
      <input
        type="password"
        value={code}
        spellCheck={false}
        autoComplete="off"
        placeholder={L.settings.loginCode}
        aria-label={L.settings.loginCode}
        disabled={busy}
        onChange={(event) => setCode(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && code.trim() && !busy) void send();
        }}
      />
      <button
        type="button"
        className="nx-btn nx-btn--sm"
        disabled={!code.trim() || busy}
        onClick={() => void send()}
      >
        {busy ? L.settings.codeSending : L.settings.loginCodeSend}
      </button>
      {error && <span className="nx-snote nx-snote--red">{error}</span>}
    </span>
  );
}
