import { useEffect, useState } from "react";
import { ConnectScreen } from "./ConnectScreen";
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

export default function App() {
  const [url, setUrl] = useState<string | null>(
    () => desktopDaemonUrl() ?? localStorage.getItem(URL_KEY),
  );
  // The planner view needs the whole connection, not a copy of each field.
  const daemon = useDaemon(url);
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
  };

  if (!url || daemon.connection === "error") {
    return <ConnectScreen onConnect={connect} error={daemon.connectionError} />;
  }

  return (
    <NextShell
      daemon={daemon}
      settings={settings}
      onChatChange={(patch) => updateSettings({ chat: { ...settings.chat, ...patch } })}
      onLayoutChange={(patch) => updateSettings({ layout: { ...settings.layout, ...patch } })}
      onRenameSession={(sessionId, title) =>
        updateSettings({ sessionTitles: { ...settings.sessionTitles, [sessionId]: title } })
      }
      onSettingsChange={updateSettings}
    />
  );
}
