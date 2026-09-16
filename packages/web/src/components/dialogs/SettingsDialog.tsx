import type { DaemonStatus, EffortLevel, PermissionMode } from "@colo-design/protocol";
import { RELEASES_REPO, type UpdateCheckResult } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "../../hooks/use-modal-focus";
import {
  EFFORT_LABEL,
  modelOptions,
  modelRowOf,
  modeMenuLabel,
  SETTINGS_MODES,
} from "../../lib/chat-options";
import type { Daemon } from "../../lib/daemon-client";
import {
  type ChatSettings,
  loadModelCatalog,
  type MidTurnSend,
  type NoticeTiming,
  SCALE_LEVELS,
  type Scale,
  type SendKey,
  type Settings,
  THEMES,
  type ThemeChoice,
} from "../../lib/settings";
import {
  BellIcon,
  BrainIcon,
  CheckIcon,
  CloseIcon,
  InfoIcon,
  KeyIcon,
  LinkIcon,
  RefreshIcon,
  ThemeIcon,
} from "../icons";
import { GitHubTokenForm } from "../onboarding/GitHubTokenForm";
import { Tip } from "../shell/Tip";
import { ConfirmDialog } from "./ConfirmDialog";

/** Slowest last, so the picker reads as a dial rather than a set. */
const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

const THEME_LABEL: Record<ThemeChoice, string> = {
  /* "설정을 따름" is the picker's one sentence above the grid, so the tile
     can wear the short word — 9글자 라벨은 ✓ 와 함께 타일을 넘어갔다. */
  system: "시스템",
  dark: "어둡게",
  light: "밝게",
  sepia: "세피아",
  midnight: "미드나잇",
  contrast: "고대비",
  dracula: "드라큘라",
  solarized: "솔라라이즈드",
  catppuccin: "캣푸친",
  nord: "노르드",
  gruvbox: "그럽박스",
  tokyonight: "도쿄나이트",
  rosepine: "로즈파인",
  everforest: "에버포레스트",
  onedark: "원다크",
  github: "깃허브",
  monokai: "모노카이",
  latte: "캣푸친 라떼",
};

/** What "follow the OS" actually tracks, in one sentence at the picker. */
const SYSTEM_HINT = "OS 밝기를 따르고, 고대비를 요청하면 고대비 팔레트를 씁니다.";

const SEND_LABEL: Record<SendKey, string> = {
  enter: "Enter로 보내기, Shift+Enter는 줄바꿈",
  modEnter: "⌘/Ctrl+Enter로 보내기, Enter는 줄바꿈",
};

/** 실행 중 보내기: what a send means while a turn is still running. */
const MID_TURN_LABEL: Record<MidTurnSend, string> = {
  queue: "다음 턴에 보내기",
  interrupt: "끊고 보내기",
};

/** The one three-step choice every 크기 knob offers. */
const SCALE_OPTIONS: { value: Scale; label: string }[] = SCALE_LEVELS.map((level) => ({
  value: level,
  label: level === "small" ? "작게" : level === "normal" ? "보통" : "크게",
}));

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  /** Put the control on its own line, for anything wider than a picker. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={wide ? "setting setting--wide" : "setting"}>
      <span className="setting__text">
        <span className="setting__label">{label}</span>
        {hint && <span className="setting__hint">{hint}</span>}
      </span>
      <span className="setting__control">{children}</span>
    </label>
  );
}

function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: Array<{ value: T; label: string; hint?: string }>;
  onChange: (value: T) => void;
}) {
  /** The menu carries the choice's name; the description reads below the
      row, where a full sentence fits and nothing truncates mid-thought. */
  const activeHint = options.find((option) => option.value === value)?.hint ?? hint;
  return (
    <Field label={label} {...(activeHint ? { hint: activeHint } : {})}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Switch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="switch__track" aria-hidden="true">
          <span className="switch__knob" />
        </span>
      </span>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Theme gallery — 18 palettes chosen by their colour, not by their name.
// ---------------------------------------------------------------------------

/**
 * One tile's miniature: the app's four bones — rail, head, body, accent
 * button — drawn from the palette variables. The tile's wrapper carries
 * `data-theme`, so the same markup paints itself in whichever palette the
 * tile sells; nothing here knows a colour.
 */
function ThemeArt() {
  return (
    <span className="tg" aria-hidden="true">
      <span className="tg__rail">
        <i />
        <i />
        <i />
      </span>
      <span className="tg__main">
        <span className="tg__head" />
        <span className="tg__line" />
        <span className="tg__line tg__line--short" />
        <span className="tg__btn" />
      </span>
    </span>
  );
}

function ThemeGallery({
  value,
  onChange,
}: {
  value: ThemeChoice;
  onChange: (theme: ThemeChoice) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  /**
   * 라디오그룹의 키보드 규칙: Tab 은 그룹에 한 번만 멈추고(선택된 타일),
   * 화살표가 안에서 옮긴다 — 옮기는 것이 곧 고르는 것(APG radio).
   * 18개 타일이 전부 Tab 스톱이면 다른 설정까지 18번을 걸어야 했다.
   */
  const move = (from: number, dir: 1 | -1) => {
    const to = (from + dir + THEMES.length) % THEMES.length;
    const theme = THEMES[to];
    if (!theme) return;
    onChange(theme);
    grid.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[to]?.focus();
  };
  return (
    <div className="themegrid" role="radiogroup" aria-label="테마" ref={grid}>
      {THEMES.map((theme, index) => (
        <button
          key={theme}
          type="button"
          role="radio"
          aria-checked={theme === value}
          tabIndex={theme === value ? 0 : -1}
          className="themegrid__tile"
          data-testid={`theme-${theme}`}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(index, 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(index, -1);
            }
          }}
          onClick={() => onChange(theme)}
        >
          <span className="themegrid__art" {...(theme === "system" ? {} : { "data-theme": theme })}>
            {theme === "system" ? (
              /* system 은 두 얼굴이 한 타일: 어두운 절과 밝은 절. */
              <>
                <span className="themegrid__half" data-theme="dark">
                  <ThemeArt />
                </span>
                <span className="themegrid__half" data-theme="light">
                  <ThemeArt />
                </span>
              </>
            ) : (
              <ThemeArt />
            )}
          </span>
          <span className="themegrid__name">
            {THEME_LABEL[theme]}
            {theme === value && <CheckIcon size={11} />}
          </span>
        </button>
      ))}
    </div>
  );
}

export function SettingsDialog({
  settings,
  onChange,
  onChatChange,
  daemonUrl,
  status,
  connection,
  daemon,
  onOpenOnboarding,
  onReconnect,
  onForgetUrl,
  onClose,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** The 대화 group edits these; they reach the live thread too. */
  onChatChange: (patch: Partial<ChatSettings>) => void;
  daemonUrl: string | null;
  status: DaemonStatus | null;
  connection: string;
  /** The connected repo's url/PAT live daemon-side; the dialog only edits them. */
  daemon: Daemon;
  /** Opens the first-run wizard again. */
  onOpenOnboarding: () => void;
  onReconnect: (url: string) => void;
  onForgetUrl: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(daemonUrl ?? "");
  /**
   * Only a live session can be asked for the model list, so the cache is what
   * lets 설정 offer real names before a thread is open — the daemon's own copy
   * is the fallback for a browser that has never had one.
   */
  const models = loadModelCatalog().length > 0 ? loadModelCatalog() : (status?.models ?? []);
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel);
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  /** 세션이 돌고 있어 설치가 연기됐음을 알리는 한 줄. */
  const [updateDeferred, setUpdateDeferred] = useState<string | null>(null);
  /** 내려받기·검증이 끝나 종료 직전임을 알리는 안내 — 성공 경로의 한 줄. */
  const [updateStarted, setUpdateStarted] = useState<string | null>(null);
  /**
   * 시험 알림의 답 한 줄. 알림이 안 온다는 신고의 절반은 OS 가 이 앱의 알림을
   * 막고 있는 경우인데, 그 사실은 어디에도 나타나지 않았다 — 시험 버튼은
   * 언제나 조용히 성공했다. 이제는 OS 가 거절하면 이유를, 받아 갔으면 "그래도
   * 배너가 없으면 OS 설정을 보라"는 다음 걸음을 말한다.
   */
  const [noticeTest, setNoticeTest] = useState<string | null>(null);

  /**
   * 업데이트 문단은 데스크톱 앱 안에서만 산다 — 브라우저엔 '이 앱의 버전'이
   * 없어 비교가 성립하지 않는다. 다리의 platform 이 설치 문단을 고른다: mac·
   * Windows 는 앱이 스스로 갈아입고, 나머지는 릴리스 페이지로 안내한다. 이
   * 플랫폼의 에셋이 피드에 있는지는 update.url·update.sha256 이 말해 준다 —
   * 메인이 이 플랫폼 몫으로 이미 골라 돌려준 한 쌍이다.
   */
  const desktop = window.coloDesignDesktop ?? null;
  const canSelfUpdate = desktop?.platform === "darwin" || desktop?.platform === "win32";

  /**
   * `폴더 열기` — the desktop bridge opens ~/.colo-design in the OS
   * file manager; the browser path has no bridge and shows the path instead.
   * The preload script is the boundary that decides the shape, so reading it
   * once through a named accessor with an `in` guard is the checked route.
   */
  const bridgeOpenHome =
    window.coloDesignDesktop && "openHome" in window.coloDesignDesktop
      ? window.coloDesignDesktop.openHome
      : undefined;
  /**
   * `시스템 알림 설정 열기` — 같은 규칙(`in` 가드로 한 번만 읽는다). 브라우저
   * 경로에는 없다: 거기서는 사이트 권한이라 주소창의 자물쇠가 그 자리다.
   */
  const bridgeOpenNotificationSettings =
    window.coloDesignDesktop && "openNotificationSettings" in window.coloDesignDesktop
      ? window.coloDesignDesktop.openNotificationSettings
      : undefined;
  /**
   * 수동 업데이트 확인: 데스크톱 다리로만 묻는다 — 확인은
   * 메인 프로세스가 피드에서 읽고, 렌더러는 결과를 보여주기만 한다.
   */
  const checkUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    setUpdateDeferred(null);
    try {
      const result = await desktop?.updateCheck();
      if (!result) return;
      if ("error" in result && result.error) throw new Error(String(result.error));
      setUpdate(result);
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingUpdate(false);
    }
  };

  /**
   * 자가 교체: 새 버전이 확인되면 내려받고 sha256 검증한 뒤 앱이
   * 스스로 종료·교체·재실행한다 — mac 은 번들을 갈아 치우고, Windows 는 설치
   * 프로그램을 무인으로 돌린다. 무엇을 내려받을지는 메인이 피드에서 다시
   * 읽는다 — 렌더러는 요청만 보낸다.
   */
  const installUpdate = async () => {
    if (!update?.url || !update.sha256) return;
    setInstallingUpdate(true);
    setUpdateError(null);
    setUpdateStarted(null);
    setUpdateDeferred(null);
    try {
      const result = await window.coloDesignDesktop?.selfUpdate();
      if (result && typeof result === "object" && "error" in result && result.error) {
        throw new Error(String(result.error));
      }
      // 세션이 돌고 있으면 메인이 설치를 연기한다 — 이 문단이 그 약속을
      // 보여준다. 모든 대화가 내려앉는 순간 알림과 함께 설치된다.
      if (result && typeof result === "object" && "deferred" in result) {
        setUpdateDeferred(
          `작업이 끝나는 대로 ${result.version} 설치를 시작합니다 — 돌아가는 대화가 끊기지 않도록 기다리는 중입니다.`,
        );
        return;
      }
      setUpdateStarted("검증이 끝났습니다 — 앱이 저절로 닫히고 새 버전으로 다시 열립니다.");
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallingUpdate(false);
    }
  };
  /** 테스트 알림 — 데스크톱은 메인이, 브라우저는 이 자리에서 보낸다. */
  const sendTestNotice = async () => {
    setNoticeTest(null);
    const bridge = window.coloDesignDesktop;
    if (bridge?.notifyTest) {
      const result = await bridge.notifyTest();
      setNoticeTest(
        result?.shown === false
          ? `이 컴퓨터의 OS 가 알림을 거절했습니다 — ${result.error ?? "이유를 알려주지 않았습니다"}`
          : "보냈습니다. 배너가 보이지 않으면 OS 가 이 앱의 알림을 꺼 둔 것입니다 — 아래 버튼으로 켜 주세요.",
      );
      return;
    }
    if (typeof Notification === "undefined") {
      setNoticeTest("이 브라우저는 알림을 지원하지 않습니다.");
      return;
    }
    try {
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission !== "granted") {
        setNoticeTest(
          "브라우저가 이 사이트의 알림을 허용하지 않았습니다 — 주소창의 자물쇠에서 켭니다.",
        );
        return;
      }
      new Notification("알림 시험", {
        body: "실제 알림은 이렇게 도착합니다.",
        silent: !settings.notifications.sound,
      });
      setNoticeTest("보냈습니다.");
    } catch {
      // 서비스 워커 없이는 생성을 막는 브라우저가 있다 — 그 사실을 말해 준다.
      setNoticeTest("이 브라우저는 페이지에서 직접 알림을 띄우지 못합니다.");
    }
  };

  // The repo url arrives asynchronously (repo.status); adopt it until the
  // planner edits the field, so reopening the dialog shows what is stored.
  const [repoUrlDraft, setRepoUrlDraft] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [savingRepo, setSavingRepo] = useState(false);
  /** 접속 주소 지우기의 확인 — this app's dialog, not window.confirm. */
  const [forgetConfirm, setForgetConfirm] = useState(false);
  /** The GitHub group's 토큰 바꾸기 toggle: detail row ↔ the form. */
  const [editingToken, setEditingToken] = useState(false);
  const connected = daemon.connection === "open";
  const repoUrl = repoUrlDraft ?? daemon.repo?.url ?? "";

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [onClose]);

  // Move focus into the dialog so Escape and Tab act on it rather than on the
  // page behind it.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  const urlChanged = url.trim().length > 0 && url.trim() !== (daemonUrl ?? "");
  /** The url is the only repo-side secret-free field; the token lives in the GitHub group. */
  const saveRepo = async () => {
    setSavingRepo(true);
    setRepoError(null);
    try {
      await daemon.api.repoUpdate(repoUrl.trim() || null);
    } catch (e) {
      setRepoError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingRepo(false);
    }
  };

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal__panel modal__panel--settings"
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal__head">
          <h2 className="modal__title">설정</h2>
          <Tip label="설정 닫기" side="left">
            <button type="button" className="ghost" aria-label="설정 닫기" onClick={onClose}>
              <CloseIcon />
            </button>
          </Tip>
        </header>

        <div className="modal__body">
          <section className="settings__group">
            <h3 className="settings__groupTitle">
              <span className="ic ic--sm ic--quiet">
                <ThemeIcon />
              </span>
              화면
            </h3>
            <div className="setting setting--wide">
              <span className="setting__text">
                <span className="setting__label">테마</span>
                <span className="setting__hint">{SYSTEM_HINT}</span>
              </span>
              <ThemeGallery value={settings.theme} onChange={(theme) => onChange({ theme })} />
            </div>
            <Choice<Scale>
              label="인터페이스 크기"
              hint="탐색·컨트롤·레이블에 적용됩니다"
              value={settings.uiScale}
              options={SCALE_OPTIONS}
              onChange={(uiScale) => onChange({ uiScale })}
            />
            <Choice<Scale>
              label="콘텐츠 크기"
              hint="채팅 본문과 렌더링된 문서에 적용됩니다"
              value={settings.contentScale}
              options={SCALE_OPTIONS}
              onChange={(contentScale) => onChange({ contentScale })}
            />
            <Choice<Scale>
              label="코드 크기"
              hint="명령·diff·출력 같은 기계 텍스트에 적용됩니다"
              value={settings.codeScale}
              options={SCALE_OPTIONS}
              onChange={(codeScale) => onChange({ codeScale })}
            />
          </section>

          {/* Where the three composer chips went. A planner
              describing a screen should not be choosing a model to do it with;
              the choice is real, so it is kept, but it is kept here. */}
          <section className="settings__group">
            <h3 className="settings__groupTitle">
              <span className="ic ic--sm ic--quiet">
                <BrainIcon />
              </span>
              대화
            </h3>
            <Choice<string>
              label="답변 방식"
              hint={
                models.length > 0
                  ? "어떤 Claude가 답할지 고릅니다"
                  : "대화를 한 번 시작하면 고를 수 있는 목록이 채워집니다"
              }
              value={settings.chat.model ?? ""}
              options={[
                { value: "", label: "자동 (Claude Code 기본값)" },
                ...modelOptions(models, modelRowOf(models, settings.chat.model)).map((option) => ({
                  value: option.value ?? "",
                  label: option.label,
                  ...(option.hint ? { hint: option.hint } : {}),
                })),
              ]}
              onChange={(model) => onChatChange({ model: model || null })}
            />
            <Choice<string>
              label="생각 시간"
              hint="오래 생각할수록 꼼꼼하고, 그만큼 느립니다"
              value={settings.chat.effort ?? ""}
              options={[
                { value: "", label: "자동" },
                ...EFFORT_ORDER.map((level) => ({
                  value: level,
                  label: EFFORT_LABEL[level],
                })),
              ]}
              onChange={(effort) => onChatChange({ effort: (effort as EffortLevel) || null })}
            />
            <Choice<PermissionMode>
              label="확인 방식"
              hint="Claude가 화면을 바꾸기 전에 물어볼지 정합니다 — 화면 파일 편집은 확인 방식과 관계없이 자동으로 적용되고, 명령 실행만 물어봅니다"
              value={settings.chat.permissionMode}
              options={SETTINGS_MODES.map((mode) => ({
                value: mode,
                label: modeMenuLabel(mode),
              }))}
              onChange={(permissionMode) => onChatChange({ permissionMode })}
            />
            {settings.chat.permissionMode === "acceptEdits" && (
              <div className="notice notice--warn">
                <span className="notice__text">
                  Accept Edits는 화면 파일 편집뿐 아니라 CLI가 안전하다고 본 명령까지 묻지 않고
                  실행합니다. 편집만 조용하면 되면 Default를 고르세요.
                </span>
              </div>
            )}
            {settings.chat.permissionMode === "bypassPermissions" && (
              <div className="notice notice--warn">
                <span className="notice__text">
                  Bypass는 확인 카드 없이 진행합니다. 자리를 비운 사이에도 화면 파일이 바뀔 수
                  있으니, 물어볼 필요가 있으면 확인 방식을 Default로 바꾸세요.
                </span>
              </div>
            )}
            {/* Claude 가 화면을 보는 일. previewTools 는
                session.create 의 선택이라 열려 있는 대화에는 적용되지
                않는다 — 새 대화부터다. */}
            <Switch
              label="Claude가 화면을 직접 확인"
              hint="새로 시작하는 대화부터 적용됩니다. 열려 있는 대화는 그대로입니다"
              checked={settings.chat.previewTools}
              onChange={(previewTools) => onChatChange({ previewTools })}
            />
            <Switch
              label="Claude가 보는 화면 표시"
              hint="Claude가 화면을 확인하는 동안 미리보기 구석에 작게 보여 줍니다"
              checked={settings.chat.showPip}
              onChange={(showPip) => onChatChange({ showPip })}
            />
            {/* 따라가기: the turn's end moves the preview to the
                screen Claude last opened — unless the planner moved it
                themselves during the turn, which only toasts instead. */}
            <Switch
              label="턴이 끝나면 Claude가 본 화면으로"
              hint="고친 화면을 직접 찾지 않도록, Claude가 마지막으로 연 화면을 보여 줍니다"
              checked={settings.chat.followClaude}
              onChange={(followClaude) => onChatChange({ followClaude })}
            />
            {/* 대화에 남길 기록 두 스위치: "작업·생각 과정" 은
                기계의 작업 로그를 여는 구현자용 스위치다 — 매일 만지는 행이
                아니니 기본은 접는다. 열어도 행의 말과 동작은 그대로다. */}
            <details className="settings__fold">
              <summary>고급 · 대화에 남길 작업 기록</summary>
              {/* 작업 과정 보기: 기본은 꺼짐이다 — 생각 과정과 같은 이유다.
                  사용자가 읽어야 하는 것은 답이고, 도구 호출 묶음이 답과 답
                  사이마다 끼면 대화가 기계의 작업 기록처럼 읽힌다. 읽고 싶은
                  사람에게는 여기서 돌려준다. 계획 카드와 캡처 카드는 이
                  스위치와 무관하게 언제나 자리를 지킨다. */}
              <Switch
                label="작업 과정 보기"
                hint="Claude가 화면을 만들며 거친 작업 — 파일 작업과 검사 — 를 대화에 접힌 채로 남깁니다"
                checked={settings.chat.showTools}
                onChange={(showTools) => onChatChange({ showTools })}
              />
              {/* 생각 과정 보기: 기본은 꺼짐이다. 사용자가 읽어야 하는 것은
                  답이고, 답을 만드는 동안의 속말이 답과 답 사이마다 끼면
                  대화가 기계의 기록처럼 읽힌다. 읽고 싶은 사람에게는 여기서
                  돌려준다 — 켜면 접힌 채로 다시 자리를 잡는다. */}
              <Switch
                label="생각 과정 보기"
                hint="Claude가 답을 만들며 한 생각을 대화에 접힌 채로 남깁니다"
                checked={settings.chat.showThinking}
                onChange={(showThinking) => onChatChange({ showThinking })}
              />
            </details>
          </section>

          <section className="settings__group">
            <h3 className="settings__groupTitle">
              <span className="ic ic--sm ic--quiet">
                <InfoIcon />
              </span>
              동작
            </h3>
            <Choice<SendKey>
              label="보내기 키"
              value={settings.sendKey}
              options={(["enter", "modEnter"] as SendKey[]).map((key) => ({
                value: key,
                label: SEND_LABEL[key],
              }))}
              onChange={(sendKey) => onChange({ sendKey })}
            />
            <Choice<MidTurnSend>
              label="실행 중 보내기"
              value={settings.midTurnSend}
              options={[
                {
                  value: "queue",
                  label: MID_TURN_LABEL.queue,
                  hint: "실행 중 보낸 말은 지금 답변이 끝난 뒤 다음 답변으로 전달됩니다",
                },
                {
                  value: "interrupt",
                  label: MID_TURN_LABEL.interrupt,
                  hint: "실행 중 보내면 지금 답변을 멈추고 그 말로 새 답변을 시작합니다",
                },
              ]}
              onChange={(midTurnSend) => onChange({ midTurnSend })}
            />
          </section>

          {/* 알림: 시점 3상태와 소리, 그리고 시험 한 장.
              확인 요청·중단·게이트 실패는 시점과 무관하게 언제나 온다는
              것을 힌트가 한 줄로 말한다. */}
          <section className="settings__group">
            <h3 className="settings__groupTitle">
              <span className="ic ic--sm ic--quiet">
                <BellIcon />
              </span>
              알림
            </h3>
            <Choice<NoticeTiming>
              label="완료 알림"
              value={settings.notifications.done}
              options={[
                { value: "off", label: "끔", hint: "완료 알림은 받지 않습니다" },
                {
                  value: "long",
                  label: "오래 걸린 턴만",
                  hint: "1분 넘게 걸린 작업이 끝났을 때만 알립니다",
                },
                { value: "all", label: "모든 턴", hint: "모든 작업이 끝날 때마다 알립니다" },
              ]}
              onChange={(done) => onChange({ notifications: { ...settings.notifications, done } })}
            />
            <Switch
              label="알림 소리"
              hint="알림이 도착할 때 소리를 냅니다"
              checked={settings.notifications.sound}
              onChange={(sound) =>
                onChange({ notifications: { ...settings.notifications, sound } })
              }
            />
            <Field
              label="테스트"
              hint={
                noticeTest ??
                "확인 요청·중단은 이 설정과 관계없이 언제나 옵니다. 알림 허용 여부는 OS 가 앱마다 한 번만 묻습니다 — 한 번 거절된 뒤에는 OS 설정에서만 켤 수 있습니다."
              }
            >
              <button type="button" onClick={() => void sendTestNotice()}>
                테스트 알림 보내기
              </button>
              {bridgeOpenNotificationSettings && (
                <button type="button" onClick={() => void bridgeOpenNotificationSettings()}>
                  시스템 알림 설정 열기
                </button>
              )}
            </Field>
          </section>

          <section className="settings__group">
            <h3 className="settings__groupTitle">
              <span className="ic ic--sm ic--quiet">
                <KeyIcon />
              </span>
              GitHub
            </h3>
            {daemon.onboarding?.find((step) => step.id === "github")?.status === "pass" &&
            !editingToken ? (
              <Field wide label="계정" hint="토큰은 이 컴퓨터에만 저장되고 다시 보여지지 않습니다">
                <span className="settings__url">
                  <span className="settings__account">
                    {daemon.onboarding?.find((step) => step.id === "github")?.detail}
                  </span>
                  <button
                    type="button"
                    className="primary"
                    disabled={!connected}
                    onClick={() => setEditingToken(true)}
                  >
                    토큰 바꾸기
                  </button>
                </span>
              </Field>
            ) : (
              <GitHubTokenForm
                daemon={daemon}
                onDone={() => setEditingToken(false)}
                disabled={!connected}
              />
            )}
          </section>

          <section className="settings__group">
            <h3 className="settings__groupTitle">
              <span className="ic ic--sm ic--quiet">
                <LinkIcon />
              </span>
              연결 레포
            </h3>
            <Field
              wide
              label="레포 주소"
              hint={connected ? "git clone 주소(https://…)" : "연결된 뒤 저장할 수 있습니다"}
            >
              <span className="settings__url">
                <input
                  value={repoUrl}
                  spellCheck={false}
                  placeholder="https://github.com/<조직>/<레포>.git"
                  aria-label="연결 레포 주소"
                  disabled={!connected}
                  onChange={(e) => setRepoUrlDraft(e.target.value)}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={!connected || savingRepo}
                  onClick={() => void saveRepo()}
                >
                  {savingRepo ? "저장 중…" : "저장"}
                </button>
              </span>
            </Field>
            {repoError && (
              <div className="notice notice--error">
                <span className="notice__text">{repoError}</span>
              </div>
            )}
          </section>

          {/* Everything a planner only ever needs when something is broken.
              It used to sit open under the heading 데몬, which is
              a word for the program, not for the problem. */}
          <section className="settings__group">
            <h3 className="settings__groupTitle">
              <span className="ic ic--sm ic--quiet">
                <RefreshIcon />
              </span>
              문제 해결
            </h3>
            <div className="settings__row">
              <button type="button" onClick={onOpenOnboarding}>
                처음 설정 다시 보기
              </button>
              {typeof bridgeOpenHome === "function" && (
                <button type="button" onClick={() => void bridgeOpenHome()}>
                  폴더 열기
                </button>
              )}
              {typeof bridgeOpenHome === "function" && (
                <button type="button" onClick={() => void bridgeOpenHome("logs")}>
                  로그 폴더 열기
                </button>
              )}
              <span className="setting__hint">
                {bridgeOpenHome
                  ? "클론과 설정이 있는 곳입니다. 여기 파일을 직접 고치지 마세요 — 화면은 대화로, 저장은 버튼으로."
                  : "~/.colo-design — 클론과 설정이 있는 곳입니다. 여기 파일을 직접 고치지 마세요."}
              </span>
              {desktop && (
                <button type="button" disabled={checkingUpdate} onClick={() => void checkUpdate()}>
                  {checkingUpdate ? "확인 중…" : "업데이트 확인"}
                </button>
              )}
              {desktop && update && (
                <>
                  <span className="setting__hint">
                    {update.updateAvailable
                      ? `새 버전 ${update.version}${update.notes ? ` — ${update.notes}` : ""}`
                      : `최신 버전입니다 (${update.version})`}
                  </span>
                  {update.updateAvailable &&
                    update.url &&
                    update.sha256 &&
                    (canSelfUpdate ? (
                      <button
                        type="button"
                        disabled={installingUpdate}
                        onClick={() => void installUpdate()}
                      >
                        {installingUpdate ? "준비 중…" : "업데이트 설치"}
                      </button>
                    ) : (
                      <a
                        className="setting__hint"
                        href={`https://github.com/${RELEASES_REPO}/releases/latest`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        릴리스 페이지에서 설치 파일 내려받기
                      </a>
                    ))}
                </>
              )}
              {updateStarted && <span className="setting__hint">{updateStarted}</span>}
              {updateDeferred && <span className="setting__hint">{updateDeferred}</span>}
              {updateError && <span className="setting__hint">{updateError}</span>}
            </div>

            <details className="settings__fold">
              <summary>고급 · 연결 정보</summary>
              <Field
                wide
                label="접속 주소"
                hint={`연결 상태: ${connection}. 앱을 다시 열면 이 주소가 채워집니다.`}
              >
                <span className="settings__url">
                  <input
                    value={url}
                    spellCheck={false}
                    placeholder="ws://127.0.0.1:7823?token=…"
                    aria-label="접속 주소"
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && urlChanged && onReconnect(url.trim())}
                  />
                  <button
                    type="button"
                    className="primary"
                    disabled={!urlChanged}
                    onClick={() => onReconnect(url.trim())}
                  >
                    다시 연결
                  </button>
                </span>
              </Field>

              {status && (
                <dl className="settings__facts">
                  <div>
                    <dt>운영체제</dt>
                    <dd>{status.platform}</dd>
                  </div>
                  <div>
                    <dt>Claude Code</dt>
                    <dd>{status.claudeVersion ?? "찾지 못함"}</dd>
                  </div>
                  <div>
                    <dt>로그인</dt>
                    <dd>
                      {status.loggedIn
                        ? [status.email, status.subscriptionType ?? status.authMethod]
                            .filter(Boolean)
                            .join(" · ") || "로그인됨"
                        : "로그인 안 됨"}
                    </dd>
                  </div>
                  <div>
                    <dt>pnpm</dt>
                    <dd>{status.pnpmAvailable ? "사용 가능" : "없음"}</dd>
                  </div>
                  <div>
                    <dt>실행 중인 기획</dt>
                    <dd>{status.liveSessions}</dd>
                  </div>
                  <div>
                    <dt>프로토콜</dt>
                    <dd>v{status.protocolVersion}</dd>
                  </div>
                </dl>
              )}

              <div className="settings__row">
                <button type="button" className="danger" onClick={() => setForgetConfirm(true)}>
                  접속 주소 지우기
                </button>
                <span className="setting__hint">
                  연결 화면으로 돌아갑니다. 기획은 삭제되지 않습니다.
                </span>
              </div>
            </details>
          </section>
        </div>
      </div>
      {forgetConfirm && (
        <ConfirmDialog
          title="접속 주소 지우기"
          body={<>저장된 접속 주소를 지울까요?</>}
          hint="이 컴퓨터의 기획은 그대로 남지만, 앱이 만든 접속 주소를 다시 붙여 넣어야 합니다."
          confirmLabel="지우기"
          onConfirm={() => {
            setForgetConfirm(false);
            onForgetUrl();
          }}
          onClose={() => setForgetConfirm(false)}
        />
      )}
    </div>
  );
}
