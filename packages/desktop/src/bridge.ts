// The renderer bridge: update check/install, 폴더 열기, and the
// notification prefs the settings dialog edits. 자격 증명·토큰은 결코
// 건너가지 않는다 — 이 파일이 노출하는 전부가 preload 의 표면이다.
import { mkdirSync } from "node:fs";
import { COLO_DESIGN_DIR } from "@colo-design/daemon/environment";
import { ipcMain, shell } from "electron";
import type { PlannerNotices } from "./app-notify.js";
import type { SelfUpdates } from "./app-updates.js";
import { saveDesktopSettings } from "./desktop-settings.js";
import { normalizeNotificationPrefs } from "./notify-policy.js";

export interface BridgeDeps {
  updates: SelfUpdates;
  notices: PlannerNotices;
  /** 시험 알림의 클릭 행동 — 창을 앞으로. */
  focusMain(): void;
  /** Windows 토스트의 AUMID / mac 알림 설정 딥링크가 가리키는 번들 아이디. */
  bundleId: string;
  /** `~/.colo-design/logs` — 폴더 열기의 두 번째 대상. */
  logsDir: string;
  /** 알림 설정이 영속되는 desktop-settings.json 의 자리. */
  settingsPath(): string;
}

export function registerDesktopBridge(deps: BridgeDeps): void {
  const { updates, notices } = deps;

  ipcMain.handle("desktop:update-check", () => updates.check());
  ipcMain.handle("desktop:self-update", () => updates.install());

  // `폴더 열기`(PLAN D2[폴더 열기]): 숨긴 `~/.colo-design` 을 사용자가
  // 찾아 헤매지 않게 앱이 열어 준다.
  ipcMain.handle("desktop:open-home", async (_event, target?: "logs") => {
    // 로그 폴더는 첫 줄이 나가기 전엔 없을 수 있다 — 열어 주기 전에 만든다.
    if (target === "logs") {
      mkdirSync(deps.logsDir, { recursive: true });
      await shell.openPath(deps.logsDir);
      return { opened: deps.logsDir };
    }
    await shell.openPath(COLO_DESIGN_DIR);
    return { opened: COLO_DESIGN_DIR };
  });

  // 알림 설정(시점·소리) — 렌더러의 설정이 메인의 알림을 움직인다. 창이
  // 닫혀 있어도 정책이 살아 있도록 userData 에 영속한다.
  ipcMain.handle("desktop:notify-prefs", (_event, prefs: unknown) => {
    notices.prefs = normalizeNotificationPrefs(prefs);
    saveDesktopSettings(deps.settingsPath(), { notifications: notices.prefs });
    return { ok: true };
  });
  // 렌더러가 부팅 때 저장값을 묻는다 — 새 origin 의 기본값이 디스크를 덮지 않게.
  ipcMain.handle("desktop:notify-prefs:get", () => notices.prefs);

  ipcMain.handle("desktop:notify-test", () =>
    notices.show(
      "알림 시험",
      "실제 알림은 이렇게 도착합니다 — 소리 설정도 같이 적용됩니다.",
      deps.focusMain,
    ),
  );

  /**
   * OS 의 알림 허용 스위치로 데려간다. 앱은 그 스위치를 읽지도 바꾸지도 못한다:
   * mac 은 앱마다 한 번만 묻고, 그 답이 거부였으면 이후의 모든 알림은 조용히
   * 알림 센터 목록에만 쌓인다. 사람이 갈 수 있는 유일한 자리다.
   */
  ipcMain.handle("desktop:open-notification-settings", async () => {
    const target =
      process.platform === "darwin"
        ? `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${deps.bundleId}`
        : process.platform === "win32"
          ? "ms-settings:notifications"
          : null;
    if (!target) return { error: "이 시스템에는 알림 설정 화면이 없습니다." };
    try {
      await shell.openExternal(target);
      return { opened: target };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
