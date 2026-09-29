import {
  type OnboardingFixKind,
  RELEASES_REPO,
  type UpdateCheckResult,
} from "@nova-design/protocol";
import { type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from "react";
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
import { ProviderMark } from "../chat/icons";
import { DEV, L } from "../labels";
import { connectionCopy } from "../lib/connection-copy";
import { keyHint } from "../lib/key-hint";
import { type CheckNote, shouldClearCheckNote, updateRowCopy } from "../lib/update-row";
import { hasNewerVersion } from "../lib/version";
import { CloseIcon } from "../onboarding/icons";
import { modalCloseMs } from "../onboarding/motion";
import { CheckIcon, Spin } from "../ui/icons";
import {
  AiPageIcon,
  ConnectPageIcon,
  DevPageIcon,
  NotifyPageIcon,
  ThemePageIcon,
  UpdatePageIcon,
} from "./icons";
import { radioArrowStep, rovingTab, SGroup, SRow, Switch, ThemePeek } from "./parts";

/** 설정의 쪽 — 왼쪽 목록의 차례가 이 순서고, 개발자용은 맨 아래에 따로 선다. */
type Page = "ai" | "theme" | "notify" | "connection" | "update" | "developer";

const PAGES: readonly Page[] = ["ai", "theme", "notify", "connection", "update", "developer"];

const PAGE_TITLE: Record<Page, string> = {
  ai: L.settings.ai,
  theme: L.settings.theme,
  notify: L.settings.notify,
  connection: L.settings.connection,
  update: L.settings.update,
  developer: L.settings.developer,
};

const PAGE_SUB: Record<Page, string> = {
  ai: L.settings.aiSub,
  theme: L.settings.themeSub,
  notify: L.settings.notifySub,
  connection: L.settings.connectionSub,
  update: L.settings.updateSub,
  developer: L.settings.developerSub,
};

const PAGE_ICON: Record<Page, () => ReactElement> = {
  ai: AiPageIcon,
  theme: ThemePageIcon,
  notify: NotifyPageIcon,
  connection: ConnectPageIcon,
  update: UpdatePageIcon,
  developer: DevPageIcon,
};

/** 알림 시점의 세 갈래 — 데스크톱 메인의 알림 정책과 같은 값(`NoticeTiming`)이다. */
const NOTICE_CHOICES: ReadonlyArray<{ value: NoticeTiming; label: string }> = [
  { value: "off", label: L.settings.notifyOff },
  { value: "long", label: L.settings.notifyLong },
  { value: "all", label: L.settings.notifyAll },
];

/** 설정의 여섯 쪽과 왼쪽 목록(PLAN-UI U12) — `nav.openSettings` 가 연다. 문장은 전부
 *  labels(L · DEV)에서 오고, 저장은 옛 대화상자와 같은 길(테마 · 알림은 settings,
 *  프로바이더는 chat 의 patch, 자동 설치 · 작성 이름은 데몬의 machine 설정)을 쓴다.
 *  쪽은 모두 그려 둔 채 하나만 보인다 — 쪽을 옮겨도 설치 · 로그인 · 확인 중인 일이 끊기지 않게. */
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
  // 열 때 초점은 고른 쪽의 탭에 둔다 — 패널에 두면 목록의 ↑↓ 가 아무 일도 하지 않는다.
  useEffect(() => {
    const tab = panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    (tab ?? panel.current)?.focus();
  }, []);

  // 사이드바 바퀴의 점과 같은 판정 — 점이 켜진 채 열면 업데이트 쪽이 먼저 보인다.
  const agentUpdateReady = providers.some(
    (provider) => provider.available && hasNewerVersion(provider.version, provider.latestVersion),
  );
  const [page, setPage] = useState<Page>(() => (agentUpdateReady ? "update" : "ai"));
  // 쪽이 바뀐 뒤부터만 등장 움직임을 준다 — 열릴 때는 창의 pop 하나로 충분하다.
  const [switched, setSwitched] = useState(false);
  const selectPage = (next: Page) => {
    if (next === page) return;
    setSwitched(true);
    setPage(next);
  };

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
    // 이름 칸에서 치던 글은 blur 없이 닫혀도(Esc) 잃지 않는다 — 다른 설정처럼 바로 적용된다.
    commitAuthor();
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

  // 왼쪽 목록의 화살표 걸음 — 옮겨 가며 곧바로 그 쪽을 연다(탭 순서에는 고른 쪽 하나만 선다).
  const railKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = PAGES.indexOf(page);
    let next: number;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (at + 1) % PAGES.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      next = (at - 1 + PAGES.length) % PAGES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = PAGES.length - 1;
    else return;
    event.preventDefault();
    const target = PAGES[next];
    if (target) selectPage(target);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]?.focus();
  };

  // ── 테마 — 일곱 카드 사이를 화살표로 옮겨 가며 곧바로 고른다.
  const themeAt = PICKER_THEMES.indexOf(settings.theme as PickerTheme);

  // ── AI — 설치가 끝나면 목록이 스스로 바뀌게: 옛 대화상자의 고침과 같은 길.
  const usableAt = usable.findIndex((provider) => provider.id === settings.chat.provider);
  const pickProvider = (provider: (typeof usable)[number] | undefined) => {
    if (!provider || settings.chat.provider === provider.id) return;
    onChatChange(switchProviderPatch(settings.chat, provider.id));
  };
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
  const noticeAt = NOTICE_CHOICES.findIndex(
    (choice) => choice.value === settings.notifications.done,
  );
  const pickNotice = (value: NoticeTiming | undefined) => {
    if (value) onSettingsChange({ notifications: { ...settings.notifications, done: value } });
  };

  // ── 연결 — 작성 이름은 데몬이 기억하고(machine.author.set), 연결 상태는
  // 만료 판정(githubAuthExpired · attention)이 말한다.
  const [authorDraft, setAuthorDraft] = useState(status?.authorName ?? "");
  const commitAuthor = () => {
    const next = authorDraft.trim();
    // 칸도 저장된 값과 같게 — 공백만 친 칸이 「저장됨」처럼 남지 않게.
    if (next !== authorDraft) setAuthorDraft(next);
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
  // 앱 줄은 열자마자 조용히 채운다 — `지금 확인` 을 누르기 전에는 이름만 덩그러니 서 있었다.
  const [appProbe, setAppProbe] = useState<"pending" | "done" | "failed">("pending");
  const [appPhase, setAppPhase] = useState<"idle" | "installing" | "prepared" | "deferred">("idle");
  const [appNote, setAppNote] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<{ id: string; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<CheckNote | null>(null);

  useEffect(() => {
    if (!desktop?.updateCheck) return;
    let live = true;
    desktop
      .updateCheck()
      .then((result) => {
        if (result && typeof result === "object" && "error" in result && result.error) {
          throw new Error(String(result.error));
        }
        if (!live) return;
        setAppCheck(result);
        setAppProbe("done");
      })
      .catch(() => {
        if (live) setAppProbe("failed");
      });
    return () => {
      live = false;
    };
  }, [desktop]);

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
            setAppProbe("done");
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

  /** 왼쪽 목록의 점 — 눈여겨볼 일이 있는 쪽에만 선다(사이드바 바퀴의 점과 같은 뜻). */
  const badgeOf = (id: Page): "accent" | "amber" | "red" | null => {
    if (id === "update") return agentUpdateReady || appCheck?.updateAvailable ? "accent" : null;
    if (id === "connection") return connection.dot === "green" ? null : connection.dot;
    return null;
  };

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
      <div key={id} className={`nx-urow${copy.state === "available" ? " nx-urow--new" : ""}`}>
        <span className="nx-pmk nx-pmk--sm">
          <ProviderMark provider={id} />
        </span>
        <span className="nx-urow-body">
          <b className="nx-un">{provider?.label ?? id}</b>
          <span className="nx-uv">
            {copy.version || "—"}
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

  const openDeveloperFolder = typeof bridgeOpenHome === "function" ? bridgeOpenHome : null;

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
        <div className="nx-set-rail">
          <h2 className="nx-set-title">{L.settings.title}</h2>
          <div
            className="nx-set-tabs"
            role="tablist"
            aria-orientation="vertical"
            aria-label={L.settings.title}
            onKeyDown={railKeys}
          >
            {PAGES.map((id) => {
              const Icon = PAGE_ICON[id];
              const badge = badgeOf(id);
              // 점의 이유 — 새 버전인지, 연결이 곧 끝나는지, 끝났는지를 낭독과 툴팁이 말한다.
              const badgeText = !badge
                ? null
                : id === "update"
                  ? L.settings.attentionUpdate
                  : badge === "red"
                    ? L.settings.attentionExpired
                    : L.settings.attentionSoon;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`nx-set-tab-${id}`}
                  title={badgeText ?? undefined}
                  aria-selected={page === id}
                  aria-controls={`nx-set-page-${id}`}
                  tabIndex={page === id ? 0 : -1}
                  className={`nx-set-tab${page === id ? " nx-set-tab--on" : ""}${
                    id === "developer" ? " nx-set-tab--dev" : ""
                  }`}
                  onClick={() => selectPage(id)}
                >
                  <Icon />
                  <span>{PAGE_TITLE[id]}</span>
                  {badge && (
                    <>
                      <i className={`nx-set-badge nx-set-badge--${badge}`} aria-hidden="true" />
                      <span className="nx-vh">{badgeText}</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className={`nx-set-pane${switched ? " nx-set-pane--switched" : ""}`}>
          <div className="nx-set-hd">
            <div key={page} className="nx-set-hd-txt">
              <h3>{PAGE_TITLE[page]}</h3>
              <p>{PAGE_SUB[page]}</p>
            </div>
            {page === "update" && (
              <div className="nx-set-hd-act">
                {checkNote && (
                  <span className="nx-snote" role="status">
                    {checkNote.text}
                  </span>
                )}
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
              </div>
            )}
            <button
              type="button"
              className="nx-ibtn"
              aria-label={L.settings.close}
              onClick={requestClose}
            >
              <CloseIcon />
            </button>
          </div>

          <div
            className="nx-set-page"
            role="tabpanel"
            id="nx-set-page-ai"
            aria-labelledby="nx-set-tab-ai"
            hidden={page !== "ai"}
          >
            {/* 쓸 수 있는 AI 는 카드 — 고르면 다음 새 대화부터 그 AI 가 쓰인다. */}
            {usable.length > 0 && (
              <div
                className="nx-sgrid"
                role="radiogroup"
                aria-label={L.settings.ai}
                onKeyDown={(event) =>
                  radioArrowStep(event, usableAt, usable.length, (index) =>
                    pickProvider(usable[index]),
                  )
                }
              >
                {usable.map((provider, index) => (
                  // biome-ignore lint/a11y/useSemanticElements: 카드 전체가 누르는 과녁이다 — 동그라미 입력칸 없이 radio 로 읽힌다(radiogroup 안).
                  <button
                    key={provider.id}
                    type="button"
                    role="radio"
                    aria-checked={settings.chat.provider === provider.id}
                    tabIndex={rovingTab(index, usableAt)}
                    className={`nx-ptile${settings.chat.provider === provider.id ? " nx-ptile--on" : ""}`}
                    onClick={() => pickProvider(provider)}
                  >
                    <span className="nx-pmk">
                      <ProviderMark provider={provider.id} />
                    </span>
                    <span className="nx-ptxt">
                      <b>{provider.label}</b>
                      <span>
                        <i className="nx-dot nx-dot--green" />
                        {L.settings.loggedIn}
                      </span>
                    </span>
                    <span className="nx-rd" aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
            {/* 아직 못 쓰는 AI 도 같은 격자에 흐린 카드로 선다 — 접힘 속에 「쓸 수 없는」으로 숨기면 고장 난
                것처럼 읽히고 이 쪽이 휑하다. 카드 안의 단추가 다음 걸음(설치 · 로그인)이다. */}
            {(missing.length > 0 || needsLogin.length > 0) && (
              <div className="nx-sgrid">
                {missing.map((provider) => (
                  <div key={provider.id} className="nx-ptile nx-ptile--off">
                    <span className="nx-pmk">
                      <ProviderMark provider={provider.id} />
                    </span>
                    <span className="nx-ptxt">
                      <b>{provider.label}</b>
                      <span>{provider.reason ?? L.settings.notInstalled}</span>
                    </span>
                    {(provider.id === "claude" || provider.id === "codex") &&
                      (daemon.install?.kind ===
                      (provider.id === "codex" ? "install-codex" : "install-claude") ? (
                        <span key={installStepWord} className="nx-snote nx-inst-word" role="status">
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
                  <div key={provider.id} className="nx-ptile nx-ptile--off">
                    <span className="nx-pmk">
                      <ProviderMark provider={provider.id} />
                    </span>
                    <span className="nx-ptxt">
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
              </div>
            )}
            {daemon.login && (
              <div className="nx-slogin">
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
            {fixNotice && <p className="nx-snote">{fixNotice.text}</p>}
          </div>

          <div
            className="nx-set-page"
            role="tabpanel"
            id="nx-set-page-theme"
            aria-labelledby="nx-set-tab-theme"
            hidden={page !== "theme"}
          >
            {/* 같은 일곱 선택 — 보이는 법만 카드로. 미리보기는 진짜 팔레트를 입은 작은 앱 창이다. */}
            <div
              className="nx-tgrid"
              role="radiogroup"
              aria-label={L.settings.theme}
              onKeyDown={(event) =>
                radioArrowStep(event, themeAt, PICKER_THEMES.length, (index) => {
                  const choice = PICKER_THEMES[index];
                  if (choice) onSettingsChange({ theme: choice });
                })
              }
            >
              {PICKER_THEMES.map((choice, index) => (
                // biome-ignore lint/a11y/useSemanticElements: 카드 전체가 누르는 과녁이다 — AI 카드와 같은 모양(radiogroup 안).
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={settings.theme === choice}
                  tabIndex={rovingTab(index, themeAt)}
                  className={`nx-tcard${settings.theme === choice ? " nx-tcard--on" : ""}`}
                  onClick={() => onSettingsChange({ theme: choice })}
                >
                  <ThemePeek choice={choice} />
                  <span className="nx-tname">
                    <b>{L.settings.themeNames[choice]}</b>
                    {settings.theme === choice && <CheckIcon />}
                  </span>
                </button>
              ))}
            </div>
            {/* 글자가 작으면 앱 전체를 키운다 — 단축키뿐이라 어디에도 안 보였다. 새 조작 없이 알리기만 한다. */}
            <SGroup>
              <SRow title={L.settings.zoom} sub={keyHint(L.settings.zoomSub)} />
            </SGroup>
          </div>

          <div
            className="nx-set-page"
            role="tabpanel"
            id="nx-set-page-notify"
            aria-labelledby="nx-set-tab-notify"
            hidden={page !== "notify"}
          >
            <SGroup>
              <SRow title={L.settings.notifyDone} id="nx-notify-done">
                <div
                  className="nx-sseg"
                  role="radiogroup"
                  aria-labelledby="nx-notify-done"
                  onKeyDown={(event) =>
                    radioArrowStep(event, noticeAt, NOTICE_CHOICES.length, (index) =>
                      pickNotice(NOTICE_CHOICES[index]?.value),
                    )
                  }
                >
                  {NOTICE_CHOICES.map((choice, index) => (
                    // biome-ignore lint/a11y/useSemanticElements: 세 칸이 한 덩어리로 읽히는 분절 단추다 — 동그라미 입력칸 없이 radio 로 읽힌다(radiogroup 안).
                    <button
                      key={choice.value}
                      type="button"
                      role="radio"
                      aria-checked={settings.notifications.done === choice.value}
                      tabIndex={rovingTab(index, noticeAt)}
                      className="nx-sseg-opt"
                      onClick={() => pickNotice(choice.value)}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </SRow>
              <SRow title={L.settings.sound} id="nx-notify-sound">
                <Switch
                  on={settings.notifications.sound}
                  labelledBy="nx-notify-sound"
                  onChange={(sound) =>
                    onSettingsChange({ notifications: { ...settings.notifications, sound } })
                  }
                />
              </SRow>
              <SRow
                title={L.settings.testRow}
                sub={
                  <>
                    {L.settings.testNotifyNote}
                    {bridgeOpenNotificationSettings && (
                      <button
                        type="button"
                        className="nx-slink"
                        onClick={() => void bridgeOpenNotificationSettings()}
                      >
                        {L.settings.openSystemNotify}
                      </button>
                    )}
                  </>
                }
              >
                {noticeTest && (
                  <span
                    className={`nx-snote nx-stest${noticeTest === L.settings.testSent ? " nx-stest--ok" : " nx-snote--red"}`}
                    role="status"
                  >
                    {noticeTest === L.settings.testSent && <CheckIcon />}
                    {noticeTest}
                  </span>
                )}
                <button
                  type="button"
                  className="nx-btn nx-btn--sm"
                  onClick={() => void sendTestNotice()}
                >
                  {L.settings.testNotify}
                </button>
              </SRow>
            </SGroup>
          </div>

          <div
            className="nx-set-page"
            role="tabpanel"
            id="nx-set-page-connection"
            aria-labelledby="nx-set-tab-connection"
            hidden={page !== "connection"}
          >
            <SGroup>
              <SRow
                title={L.settings.authorName}
                sub={L.settings.authorNameSub}
                htmlFor="nx-author"
              >
                <input
                  id="nx-author"
                  className="nx-sinput"
                  type="text"
                  value={authorDraft}
                  onChange={(event) => setAuthorDraft(event.target.value)}
                  onBlur={commitAuthor}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitAuthor();
                  }}
                />
              </SRow>
              <SRow title={L.settings.connectionCode}>
                <span className={`nx-schip nx-schip--${connection.dot}`}>
                  <i className={`nx-dot nx-dot--${connection.dot}`} />
                  {connection.text}
                </span>
              </SRow>
              <SRow title={L.settings.inviteRow} sub={L.settings.inviteRowSub}>
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
              </SRow>
            </SGroup>
          </div>

          <div
            className="nx-set-page"
            role="tabpanel"
            id="nx-set-page-update"
            aria-labelledby="nx-set-tab-update"
            hidden={page !== "update"}
          >
            <SGroup>
              {desktop?.updateCheck && (
                <div className={`nx-urow${appCheck?.updateAvailable ? " nx-urow--new" : ""}`}>
                  <span className="nx-pmk nx-pmk--sm">
                    <img src="/colonova-icon.svg" alt="" width={18} height={18} />
                  </span>
                  <span className="nx-urow-body">
                    <b className="nx-un">{L.update.app}</b>
                    <span className="nx-uv">
                      {appCheck ? (
                        appCheck.updateAvailable ? (
                          L.update.appAvailable(appCheck.version)
                        ) : (
                          appCopy?.version
                        )
                      ) : appProbe === "failed" ? (
                        "—"
                      ) : (
                        <>
                          <Spin /> {L.update.checking}
                        </>
                      )}
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
            </SGroup>
            <p className="nx-snote nx-sfoot">{L.update.useNextTime}</p>
            <SGroup>
              <SRow title={L.update.autoLabel} sub={L.update.autoNote} id="nx-autoupd">
                <Switch
                  on={autoUpdate}
                  labelledBy="nx-autoupd"
                  onChange={(next) =>
                    void daemon.api.machineSet(undefined, next).catch((error) =>
                      setCheckNote({
                        text: error instanceof Error ? error.message : String(error),
                        found: 0,
                      }),
                    )
                  }
                />
              </SRow>
            </SGroup>
          </div>

          <div
            className="nx-set-page"
            role="tabpanel"
            id="nx-set-page-developer"
            aria-labelledby="nx-set-tab-developer"
            hidden={page !== "developer"}
          >
            <SGroup>
              <SRow title={L.settings.toolFolder}>
                {openDeveloperFolder ? (
                  <button
                    type="button"
                    className="nx-btn nx-btn--sm"
                    onClick={() => void openDeveloperFolder()}
                  >
                    {L.settings.openFolder}
                  </button>
                ) : (
                  <span className="nx-snote">~/.nova-design</span>
                )}
              </SRow>
              <SRow title={L.settings.dailyLog}>
                {openDeveloperFolder && (
                  <button
                    type="button"
                    className="nx-btn nx-btn--sm"
                    onClick={() => void openDeveloperFolder("logs")}
                  >
                    {L.settings.openLogFolder}
                  </button>
                )}
              </SRow>
            </SGroup>
            <p className="nx-stbl">
              {DEV.daemonLine(status?.protocolVersion ?? 0, daemon.connection === "open")}
              <br />
              {DEV.activeProject(active?.repoUrl ?? null, daemon.repo?.phase === "ready")}
              <br />
              {DEV.selfUpdateNote}
            </p>
          </div>
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
