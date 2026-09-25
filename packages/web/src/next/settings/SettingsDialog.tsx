import {
  type OnboardingFixKind,
  RELEASES_REPO,
  type UpdateCheckResult,
} from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import type { Daemon } from "../../lib/daemon-client";
import { requestInvitePicker } from "../../lib/invite-bus";
import {
  type ChatSettings,
  type NoticeTiming,
  type Settings,
  switchProviderPatch,
} from "../../lib/settings";
import { DEV, L } from "../labels";
import { connectionCopy } from "../lib/connection-copy";
import { type CheckNote, shouldClearCheckNote, updateRowCopy } from "../lib/update-row";
import { hasNewerVersion } from "../lib/version";
import { CheckIcon, Spin } from "../ui/icons";

/** 설정의 네 줄과 폴드(PLAN-UI U12) — `nav.openSettings` 가 연다. 문장은 전부
 *  labels(L · DEV)에서 오고, 저장은 옛 대화상자와 같은 길(알림은 settings,
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
  const unusable = providers.filter(
    (provider) => !(provider.available && provider.loggedIn !== false),
  );
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel);
  useModalEscape(panel, onClose);
  useEffect(() => {
    panel.current?.focus();
  }, []);

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

  // ── 알림 — 저장은 옛 대화상자와 같은 곳(settings.notifications).
  const [noticeTest, setNoticeTest] = useState<string | null>(null);
  const sendTestNotice = async () => {
    setNoticeTest(null);
    const bridge = window.coloDesignDesktop;
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
    window.coloDesignDesktop && "openHome" in window.coloDesignDesktop
      ? window.coloDesignDesktop.openHome
      : undefined;
  const bridgeOpenNotificationSettings =
    window.coloDesignDesktop && "openNotificationSettings" in window.coloDesignDesktop
      ? window.coloDesignDesktop.openNotificationSettings
      : undefined;

  // ── 업데이트 — 앱은 데스크톱 다리가, AI 는 데몬의 확인 · 진행기가 맡는다.
  const desktop = window.coloDesignDesktop ?? null;
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
      const result = await window.coloDesignDesktop?.selfUpdate();
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
            <div>{daemon.install?.kind === `update-${id}` ? daemon.install.line : null}</div>
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
    <div className="nx-set-back">
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
          <button type="button" className="nx-ibtn" aria-label={L.settings.close} onClick={onClose}>
            ✕
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
              {unusable.length > 0 && (
                <details className="nx-sfold">
                  <summary>{L.settings.unavailable(unusable.length)}</summary>
                  {unusable.map((provider) => (
                    <div key={provider.id} className="nx-rcard">
                      <span className="nx-rt">
                        <b>{provider.label}</b>
                        <span>{provider.reason ?? L.settings.notInstalled}</span>
                      </span>
                      {(provider.id === "claude" || provider.id === "codex") &&
                        (daemon.install?.kind ===
                        (provider.id === "codex" ? "install-codex" : "install-claude") ? (
                          <span className="nx-snote">
                            {L.settings.installing(daemon.install.line)}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="nx-btn nx-btn--sm"
                            disabled={fixBusy !== null}
                            onClick={() => void installAgent(provider.id)}
                          >
                            {fixBusy === provider.id ? L.update.checking : L.settings.install}
                          </button>
                        ))}
                    </div>
                  ))}
                </details>
              )}
              {fixNotice && <p className="nx-snote">{fixNotice.text}</p>}
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
                          {appPhase === "installing" ? L.update.checking : L.update.runApp}
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
                      <span className="nx-snote">~/.colo-design</span>
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
