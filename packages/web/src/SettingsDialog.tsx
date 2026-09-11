import { useEffect, useRef, useState } from "react";
import type { DaemonStatus, EffortLevel, PermissionMode } from "@cds-design/protocol";
import {
  RELEASES_FEED_URL,
  RELEASES_REPO,
  checkForUpdate,
  type UpdateCheckResult,
} from "@cds-design/protocol";
import type { Daemon } from "./daemon-client";
import { GitHubTokenForm } from "./GitHubTokenForm";
import { ConfirmDialog } from "./ConfirmDialog";
import { CloseIcon } from "./icons";
import {
  EFFORT_HINT,
  EFFORT_LABEL,
  MODE_HINT,
  MODE_LABEL,
  SETTINGS_MODES,
  modelOptions,
  modelRowOf,
} from "./chat-options";
import {
  THEMES,
  loadModelCatalog,
  type ChatSettings,
  type SendKey,
  type Settings,
  type ThemeChoice,
} from "./settings";

/** Slowest last, so the picker reads as a dial rather than a set. */
const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "시스템 설정을 따름",
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
// Dialog
// ---------------------------------------------------------------------------

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
  /** The 대화 group edits these; they reach the live thread too (PLAN D10). */
  onChatChange: (patch: Partial<ChatSettings>) => void;
  daemonUrl: string | null;
  status: DaemonStatus | null;
  connection: string;
  /** The connected repo's url/PAT live daemon-side; the dialog only edits them. */
  daemon: Daemon;
  /** Opens the first-run wizard again (DESIGN §8 checks). */
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
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  /** 내려받기·검증이 끝나 종료 직전임을 알리는 안내 — 성공 경로의 한 줄. */
  const [updateStarted, setUpdateStarted] = useState<string | null>(null);

  /**
   * `폴더 열기`(PLAN D2) — the desktop bridge opens ~/.cds-design in the OS
   * file manager; the browser path has no bridge and shows the path instead.
   * The preload script is the boundary that decides the shape, so reading it
   * once through a named accessor with an `in` guard is the checked route.
   */
  const bridgeOpenHome =
    window.cdsDesignDesktop && "openHome" in window.cdsDesignDesktop
      ? window.cdsDesignDesktop.openHome
      : undefined;
  /**
   * 수동 업데이트 확인(DESIGN §7): 데스크톱 다리가 있으면 그것으로,
   * 브라우저에서는 같은 공유 로직을 window.fetch 로 돌린다 — 로직은
   * @cds-design/protocol 의 update 모듈 하나다.
   */
  const checkUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    try {
      const bridge = window.cdsDesignDesktop;
      if (bridge) {
        const result = await bridge.updateCheck();
        if ("error" in result && result.error) throw new Error(String(result.error));
        setUpdate(result);
      } else {
        setUpdate(
          await checkForUpdate("0.1.0", RELEASES_FEED_URL, async (feedUrl) => {
            const response = await fetch(feedUrl);
            return { ok: response.ok, status: response.status, json: await response.json() };
          }),
        );
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // The browser's network failure lands here verbatim; a planner cannot
      // act on "Failed to fetch" but can on what to check.
      setUpdateError(
        /failed to fetch|networkerror|load failed/i.test(raw)
          ? "업데이트 서버에 연결하지 못했습니다 — 인터넷 연결을 확인하고 다시 시도해 주세요."
          : raw,
      );
    } finally {
      setCheckingUpdate(false);
    }
  };

  /**
   * mac 자가 교체(DESIGN §7): 새 버전이 확인되면 내려받고 sha256 검증한 뒤
   * 앱이 스스로 종료·교체·재실행한다. 브라우저는 다리가 없어 릴리스 페이지로
   * 안내한다 — 설치는 데스크톱의 특권.
   */
  const installUpdate = async () => {
    if (!update?.url || !update.sha256) return;
    setInstallingUpdate(true);
    setUpdateError(null);
    setUpdateStarted(null);
    try {
      const result = await window.cdsDesignDesktop?.macSelfUpdate({
        url: update.url,
        sha256: update.sha256,
      });
      if (result && typeof result === "object" && "error" in result && result.error) {
        throw new Error(String(result.error));
      }
      setUpdateStarted("검증이 끝났습니다 — 앱이 저절로 닫히고 새 버전으로 다시 열립니다.");
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallingUpdate(false);
    }
  };

  // The repo url arrives asynchronously (repo.status); adopt it until the
  // planner edits the field, so reopening the dialog shows what is stored.
  const [repoUrlDraft, setRepoUrlDraft] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [savingRepo, setSavingRepo] = useState(false);
  /** 접속 주소 지우기의 확인 — this app's dialog, not window.confirm (결함③). */
  const [forgetConfirm, setForgetConfirm] = useState(false);
  /** The GitHub group's 토큰 바꾸기 toggle: detail row ↔ the form. */
  const [editingToken, setEditingToken] = useState(false);
  const connected = daemon.connection === "open";
  const repoUrl = repoUrlDraft ?? daemon.repo?.url ?? "";

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
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
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal__head">
          <h2 className="modal__title">설정</h2>
          <button type="button" className="ghost" aria-label="설정 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="modal__body">
          <section className="settings__group">
            <h3 className="settings__groupTitle">화면</h3>
            <Choice<ThemeChoice>
              label="테마"
              value={settings.theme}
              options={THEMES.map((theme) => ({
                value: theme,
                label: THEME_LABEL[theme],
                ...(theme === "system" ? { hint: SYSTEM_HINT } : {}),
              }))}
              onChange={(theme) => onChange({ theme })}
            />
          </section>

          {/* Where the three composer chips went (PLAN D10). A planner
              describing a screen should not be choosing a model to do it with;
              the choice is real, so it is kept, but it is kept here. */}
          <section className="settings__group">
            <h3 className="settings__groupTitle">대화</h3>
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
                  hint: EFFORT_HINT[level],
                })),
              ]}
              onChange={(effort) =>
                onChatChange({ effort: (effort as EffortLevel) || null })
              }
            />
            <Choice<PermissionMode>
              label="확인 방식"
              hint="Claude가 화면을 바꾸기 전에 물어볼지 정합니다"
              value={settings.chat.permissionMode}
              options={SETTINGS_MODES.map((mode) => ({
                value: mode,
                label: MODE_LABEL[mode],
                hint: MODE_HINT[mode],
              }))}
              onChange={(permissionMode) => onChatChange({ permissionMode })}
            />
            {settings.chat.permissionMode === "bypassPermissions" && (
              <div className="notice notice--warn">
                <span className="notice__text">
                  전부 맡기기는 확인 카드 없이 진행합니다. 자리를 비운 사이에도 화면 파일이
                  바뀔 수 있으니, 물어보고 진행이 필요하면 확인 방식을 바꾸세요.
                </span>
              </div>
            )}
            {/* Claude 가 화면을 보는 일(PLAN D61·D63). previewTools 는
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
          </section>

          <section className="settings__group">
            <h3 className="settings__groupTitle">동작</h3>
            <Choice<SendKey>
              label="보내기 키"
              value={settings.sendKey}
              options={(["enter", "modEnter"] as SendKey[]).map((key) => ({
                value: key,
                label: SEND_LABEL[key],
              }))}
              onChange={(sendKey) => onChange({ sendKey })}
            />
          </section>

          <section className="settings__group">
            <h3 className="settings__groupTitle">GitHub</h3>
            {daemon.onboarding?.find((step) => step.id === "github")?.status === "pass" &&
            !editingToken ? (
              <Field
                wide
                label="계정"
                hint="토큰은 이 컴퓨터에만 저장되고 다시 보여지지 않습니다"
              >
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
            <h3 className="settings__groupTitle">연결 레포</h3>
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

          {/* Everything a planner only ever needs when something is broken
              (PLAN D13). It used to sit open under the heading 데몬, which is
              a word for the program, not for the problem. */}
          <section className="settings__group">
            <h3 className="settings__groupTitle">문제 해결</h3>
            <div className="settings__row">
              <button type="button" onClick={onOpenOnboarding}>
                처음 설정 다시 보기
              </button>
              {typeof bridgeOpenHome === "function" && (
                <button type="button" onClick={() => void bridgeOpenHome()}>
                  폴더 열기
                </button>
              )}
              <span className="setting__hint">
                {bridgeOpenHome
                  ? "클론과 설정이 있는 곳입니다. 여기 파일을 직접 고치지 마세요 — 화면은 대화로, 저장은 버튼으로."
                  : "~/.cds-design — 클론과 설정이 있는 곳입니다. 여기 파일을 직접 고치지 마세요."}
              </span>
              <button type="button" disabled={checkingUpdate} onClick={() => void checkUpdate()}>
                {checkingUpdate ? "확인 중…" : "업데이트 확인"}
              </button>
              {update && (
                <>
                  <span className="setting__hint">
                    {update.updateAvailable
                      ? `새 버전 ${update.version}${update.notes ? ` — ${update.notes}` : ""}`
                      : `최신 버전입니다 (${update.version})`}
                  </span>
                  {update.updateAvailable &&
                    (window.cdsDesignDesktop ? (
                      update.url &&
                      update.sha256 && (
                        <button
                          type="button"
                          disabled={installingUpdate}
                          onClick={() => void installUpdate()}
                        >
                          {installingUpdate ? "준비 중…" : "업데이트 설치"}
                        </button>
                      )
                    ) : (
                      <a
                        className="setting__hint"
                        href={`https://github.com/${RELEASES_REPO}/releases`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        릴리스 페이지에서 내려받기
                      </a>
                    ))}
                </>
              )}
              {updateStarted && <span className="setting__hint">{updateStarted}</span>}
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
                <button
                  type="button"
                  className="danger"
                  onClick={() => setForgetConfirm(true)}
                >
                  접속 주소 지우기
                </button>
                <span className="setting__hint">연결 화면으로 돌아갑니다. 기획은 삭제되지 않습니다.</span>
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
