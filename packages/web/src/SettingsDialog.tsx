import { useEffect, useRef, useState } from "react";
import type { DaemonStatus, EffortLevel, PermissionMode } from "@drafthouse/protocol";
import { RELEASES_FEED_URL, checkForUpdate, type UpdateCheckResult } from "@drafthouse/protocol";
import type { Daemon } from "./daemon-client";
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
};

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
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
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
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
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

  /**
   * 수동 업데이트 확인(DESIGN §7): 데스크톱 다리가 있으면 그것으로,
   * 브라우저에서는 같은 공유 로직을 window.fetch 로 돌린다 — 로직은
   * @drafthouse/protocol 의 update 모듈 하나다.
   */
  const checkUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    try {
      const bridge = (window as { drafthouseDesktop?: { updateCheck: () => Promise<UpdateCheckResult> } })
        .drafthouseDesktop;
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
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingUpdate(false);
    }
  };

  // The repo url arrives asynchronously (repo.status); adopt it until the
  // planner edits the field, so reopening the dialog shows what is stored.
  const [repoUrlDraft, setRepoUrlDraft] = useState<string | null>(null);
  const [patDraft, setPatDraft] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  const [savingRepo, setSavingRepo] = useState(false);
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

  /** The PAT is write-only: it goes to the daemon and never comes back. */
  const saveRepo = async () => {
    setSavingRepo(true);
    setRepoError(null);
    try {
      await daemon.api.repoUpdate(repoUrl.trim() || null, patDraft.trim() || undefined);
      setPatDraft("");
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
              options={THEMES.map((theme) => ({ value: theme, label: THEME_LABEL[theme] }))}
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
                  label: option.hint ? `${option.label} — ${option.hint}` : option.label,
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
                  label: `${EFFORT_LABEL[level]} — ${EFFORT_HINT[level]}`,
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
                label: `${MODE_LABEL[mode]} — ${MODE_HINT[mode]}`,
              }))}
              onChange={(permissionMode) => onChatChange({ permissionMode })}
            />
            {settings.chat.permissionMode === "bypassPermissions" && (
              <div className="notice notice--warn">
                <span className="notice__text">
                  전부 맡기기는 확인 카드 없이 진행합니다. 자리를 비운 사이에도 화면 파일이
                  바뀔 수 있으니, 필요한 동안만 켜 두세요. 창을 다시 열면 물어보고 진행으로
                  돌아갑니다.
                </span>
              </div>
            )}
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
            <Switch
              label="기획을 삭제하기 전에 확인"
              hint="삭제하면 대화 기록이 이 컴퓨터에서 영구히 사라집니다"
              checked={settings.confirmBeforeDelete}
              onChange={(confirmBeforeDelete) => onChange({ confirmBeforeDelete })}
            />
          </section>

          <section className="settings__group">
            <h3 className="settings__groupTitle">연결 레포</h3>
            <Field
              wide
              label="레포 주소"
              hint={
                connected
                  ? daemon.repo?.patConfigured
                    ? "개인 액세스 토큰 설정됨"
                    : "git clone 주소(https://…). 비공개 레포면 토큰도 넣어 주세요"
                  : "데몬에 연결된 뒤 저장할 수 있습니다"
              }
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
            <Field
              wide
              label="개인 액세스 토큰(PAT)"
              hint={
                daemon.repo?.patConfigured
                  ? "설정됨 — 다시 입력하면 교체됩니다. 값은 데몬에만 저장됩니다"
                  : "값은 데몬에만 저장되고 다시 보여지지 않습니다"
              }
            >
              <input
                type="password"
                value={patDraft}
                placeholder={daemon.repo?.patConfigured ? "••••••••" : "ghp_…"}
                aria-label="연결 레포 개인 액세스 토큰"
                disabled={!connected}
                onChange={(e) => setPatDraft(e.target.value)}
              />
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
              <button type="button" disabled={checkingUpdate} onClick={() => void checkUpdate()}>
                {checkingUpdate ? "확인 중…" : "업데이트 확인"}
              </button>
              {update && (
                <span className="setting__hint">
                  {update.updateAvailable
                    ? `새 버전 ${update.version}${update.notes ? ` — ${update.notes}` : ""}`
                    : `최신 버전입니다 (${update.version})`}
                </span>
              )}
              {updateError && <span className="setting__hint">{updateError}</span>}
            </div>

            <details className="settings__fold">
              <summary>고급 · 연결 정보</summary>
              <Field
                wide
                label="접속 주소"
                hint={`연결 상태: ${connection}. 데몬을 켜면 이 주소를 출력합니다.`}
              >
                <span className="settings__url">
                  <input
                    value={url}
                    spellCheck={false}
                    placeholder="ws://127.0.0.1:7823?token=…"
                    aria-label="데몬 접속 주소"
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
                  onClick={() => {
                    if (
                      !window.confirm(
                        "저장된 접속 주소를 지울까요? 이 컴퓨터의 기획은 그대로 남지만, 데몬이 출력한 주소를 다시 붙여 넣어야 합니다.",
                      )
                    )
                      return;
                    onForgetUrl();
                  }}
                >
                  접속 주소 지우기
                </button>
                <span className="setting__hint">연결 화면으로 돌아갑니다. 기획은 삭제되지 않습니다.</span>
              </div>
            </details>
          </section>
        </div>
      </div>
    </div>
  );
}
