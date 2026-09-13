import { useEffect, useState } from "react";
import { CopyButton } from "./components";
import { useDaemon } from "./daemon-client";
import { GearIcon } from "./icons";
import { SettingsDialog } from "./SettingsDialog";
import { Shell } from "./Shell";
import { useSettings } from "./settings";

const URL_KEY = "colo-design.daemon-url";

/**
 * The desktop app loads this page from the daemon itself with the pairing
 * token in the query — no connect screen there. Browser users keep the
 * manual flow; the token url is not persisted (it is per-run).
 */
function desktopDaemonUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (!token) return null;
  return `ws://${window.location.host}?token=${encodeURIComponent(token)}`;
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
        title="설정"
        onClick={onOpenSettings}
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
            연결
          </button>
        </div>
      </div>

      {error && (
        <div className="notice notice--error">
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
  const { settings, update: updateSettings } = useSettings();

  // A 기획서 dropped outside the composer has no handler, and the browser
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
    localStorage.setItem(URL_KEY, next);
    setUrl(next);
    setSettingsOpen(false);
  };

  /** Drop the stored URL and go back to the connect screen. Nothing is deleted. */
  const forgetUrl = () => {
    localStorage.removeItem(URL_KEY);
    setUrl(null);
    setSettingsOpen(false);
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
    />
  ) : null;

  if (!url || daemon.connection === "error") {
    return (
      <>
        <ConnectScreen
          onConnect={connect}
          error={daemon.connectionError}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {settingsDialog}
      </>
    );
  }

  return (
    <>
      <Shell
        daemon={daemon}
        settings={settings}
        onChatChange={(patch) => updateSettings({ chat: { ...settings.chat, ...patch } })}
        onLayoutChange={(patch) => updateSettings({ layout: { ...settings.layout, ...patch } })}
        onRenameSession={(sessionId, title) =>
          updateSettings({
            sessionTitles: { ...settings.sessionTitles, [sessionId]: title },
          })
        }
        onOpenSettings={() => setSettingsOpen(true)}
        onboardingOpen={onboardingOpen}
        onOnboardingClose={() => setOnboardingOpen(false)}
      />
      {settingsDialog}
    </>
  );
}
