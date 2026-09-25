import { useEffect, useState } from "react";
import { CopyButton } from "./components";
import { type SettingsCategory, SettingsDialog } from "./components/dialogs/SettingsDialog";
import { GearIcon, PlugIcon, WarnIcon } from "./components/icons";
import { Shell } from "./components/shell/Shell";
import { useDaemon } from "./lib/daemon-client";
import { normalizeNotificationSettings, useSettings } from "./lib/settings";
import { NextShell } from "./next/NextShell";

const URL_KEY = "colo-design.daemon-url";

/**
 * The desktop app loads this page from the daemon itself with the pairing
 * token in the query — no connect screen there. Browser users keep the
 * manual flow; the token url is not persisted (it is per-run).
 *
 * 데스크톱의 HMR 개발 실행(`pnpm dev:desktop`)에서는 페이지가 vite 에서
 * 오고 데몬은 다른 포트에 있다 — 그때만 데스크톱이 `daemon` 으로 데몬의
 * host 를 건넨다. 없으면 페이지를 준 곳이 곧 데몬이다.
 */
function desktopDaemonUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (!token) return null;
  const host = params.get("daemon") ?? window.location.host;
  return `ws://${host}?token=${encodeURIComponent(token)}`;
}

function ConnectScreen({
  onConnect,
  error,
  onOpenSettings,
}: {
  onConnect: (url: string) => void;
  error: string | null;
  onOpenSettings: () => void;
}) {
  const [value, setValue] = useState("");

  return (
    <div className="connect">
      <button
        type="button"
        className="connect__settings ghost"
        aria-label="설정"
        onClick={() => onOpenSettings()}
      >
        <GearIcon size={15} />
      </button>
      <h1>
        <span className="brand-name">Colo Design</span>
      </h1>
      <p>
        이 컴퓨터에서 데몬을 켠 다음, 데몬이 출력한 주소를 붙여 넣어 주세요. 데몬은 이미 로그인해 둔
        Claude Code를 그대로 사용하므로, 본인 구독으로 실행됩니다.
      </p>

      <div className="connect__step">
        <span className="connect__stepnum">1</span>
        <pre className="connect__cmd">
          <code>pnpm dev:daemon</code>
          <CopyButton value="pnpm dev:daemon" />
        </pre>
      </div>
      <div className="connect__step connect__step--fill">
        <span className="connect__stepnum">2</span>
        <div className="connect__inputrow">
          <input
            autoFocus
            value={value}
            placeholder="ws://127.0.0.1:7823?token=…"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && onConnect(value.trim())}
          />
          <button
            type="button"
            className="primary"
            disabled={!value.trim()}
            onClick={() => onConnect(value.trim())}
          >
            <span className="ic">
              <PlugIcon />
            </span>
            연결
          </button>
        </div>
      </div>

      {error && (
        <div className="notice notice--error">
          <span className="ic ic--sm ic--danger">
            <WarnIcon />
          </span>
          <span className="notice__text">{error}</span>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [url, setUrl] = useState<string | null>(
    () => desktopDaemonUrl() ?? localStorage.getItem(URL_KEY),
  );
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // The planner view needs the whole connection, not a copy of each field.
  const daemon = useDaemon(url);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** `설정 열기`가 들고 온 칸 — 다이얼로그는 그 방부터 연다. */
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory | null>(null);
  const { settings, update: updateSettings } = useSettings();

  // 알림 정책의 진실은 메인의 desktop-settings.json 이다 — 창이 닫혀 있을
  // 때도 정책이 살아 있어야 하기 때문이다. 새 origin 으로 떠 localStorage 가
  // 비어 있을 때 렌더러의 기본값이 저장값을 덮지 않게, 부팅에는 메인의 값을
  // 먼저 받아 설정에 맞추고 그 뒤 사용자의 변경만 되밀어 넣는다.
  const [notifyPrefsReady, setNotifyPrefsReady] = useState(false);
  useEffect(() => {
    const bridge = window.coloDesignDesktop;
    if (!bridge?.getNotificationPrefs) {
      setNotifyPrefsReady(true);
      return;
    }
    let disposed = false;
    bridge
      .getNotificationPrefs()
      .then((prefs) => {
        if (disposed) return;
        updateSettings({ notifications: normalizeNotificationSettings(prefs) });
        setNotifyPrefsReady(true);
      })
      .catch(() => {
        // 읽기가 실패했으면 메인의 정책을 아직 모른다 — 여기서 준비로 표시하는
        // 순간 아래 효과가 렌더러 기본값을 desktop-settings.json 에 되밀어 넣는다.
        // 문은 잠긴 채로 둔다. 모르는 정책을 쓰는 것은 정책을 지우는 것이다.
      });
    return () => {
      disposed = true;
    };
  }, [updateSettings]);
  useEffect(() => {
    if (!notifyPrefsReady) return;
    void window.coloDesignDesktop?.setNotificationPrefs?.(settings.notifications);
  }, [settings.notifications, notifyPrefsReady]);

  // A file dropped outside the composer has no handler, and the browser
  // answers a dropped file by navigating this window to the file — the whole
  // tool reads as gone. The drop is refused app-wide; the composer keeps its
  // own handler, which runs first on the way down and attaches the file.
  useEffect(() => {
    const refuse = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", refuse);
    window.addEventListener("drop", refuse);
    return () => {
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("drop", refuse);
    };
  }, []);

  const connect = (next: string) => {
    try {
      localStorage.setItem(URL_KEY, next);
    } catch {
      // Storage can be unavailable (private mode) — the session still
      // connects; only the reload loses the remembered url.
    }
    setUrl(next);
    setSettingsOpen(false);
  };

  /** Drop the stored URL and go back to the connect screen. Nothing is deleted. */
  const forgetUrl = () => {
    try {
      localStorage.removeItem(URL_KEY);
    } catch {
      // Same story — the in-memory url is dropped either way.
    }
    setUrl(null);
    setSettingsOpen(false);
  };

  /** 설정을 여는 모든 손이 지나는 문 — 칸을 들고 오면 그 방부터 연다. */
  const openSettings = (category?: SettingsCategory) => {
    setSettingsCategory(category ?? null);
    setSettingsOpen(true);
  };

  const settingsDialog = settingsOpen ? (
    <SettingsDialog
      settings={settings}
      onChange={updateSettings}
      onChatChange={(patch) => updateSettings({ chat: { ...settings.chat, ...patch } })}
      daemonUrl={url}
      status={daemon.status}
      connection={daemon.connection}
      daemon={daemon}
      onOpenOnboarding={() => {
        setOnboardingOpen(true);
        setSettingsOpen(false);
      }}
      onReconnect={connect}
      onForgetUrl={forgetUrl}
      onClose={() => setSettingsOpen(false)}
      initialCategory={settingsCategory ?? undefined}
    />
  ) : null;

  if (!url || daemon.connection === "error") {
    return (
      <>
        <ConnectScreen
          onConnect={connect}
          error={daemon.connectionError}
          onOpenSettings={openSettings}
        />
        {settingsDialog}
      </>
    );
  }

  // 병행 셸(PLAN-UI 4 · P4): 개발 실행에서만 `?shell=next` 가 새 셸을 연다.
  // 새 셸만 설정의 저장 손(단계 6)을 받는다 — 옛 셸의 설정은 App 이 직접 그린다.
  const nextShell =
    daemon.status?.dev && new URLSearchParams(window.location.search).get("shell") === "next";
  const shellProps = {
    daemon,
    settings,
    onChatChange: (patch: Partial<typeof settings.chat>) =>
      updateSettings({ chat: { ...settings.chat, ...patch } }),
    onLayoutChange: (patch: Partial<typeof settings.layout>) =>
      updateSettings({ layout: { ...settings.layout, ...patch } }),
    onRenameSession: (sessionId: string, title: string) =>
      updateSettings({
        sessionTitles: { ...settings.sessionTitles, [sessionId]: title },
      }),
    onOpenSettings: openSettings,
    onboardingOpen,
    onOnboardingClose: () => setOnboardingOpen(false),
  } satisfies Parameters<typeof Shell>[0];

  return (
    <>
      {nextShell ? (
        <NextShell {...shellProps} onSettingsChange={updateSettings} />
      ) : (
        <Shell {...shellProps} />
      )}
      {settingsDialog}
    </>
  );
}
