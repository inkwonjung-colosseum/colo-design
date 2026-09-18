import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { COLO_DESIGN_DIR } from "@colo-design/daemon/environment";
import type { DaemonNotice } from "@colo-design/daemon/server";
// 서브패스로 가져온다 — 루트 진입점은 CLI 라 가져오는 순간 실행된다.
import { DaemonServer } from "@colo-design/daemon/server";
import { app, BrowserWindow, dialog, Menu, safeStorage, shell } from "electron";
import { PlannerNotices } from "./app-notify.js";
import { SelfUpdates } from "./app-updates.js";
import { registerDesktopBridge } from "./bridge.js";
import { loadNotificationPrefs, loadStoredPort, saveDesktopSettings } from "./desktop-settings.js";
import { buildMenuTemplate } from "./menu.js";
import { createBrowserDriverFactory, createPreviewDriverFactory } from "./preview-driver.js";
import { PlannerPreviewView, registerPreviewIpc } from "./preview-view.js";
import { SafeStorageCredentialStore } from "./safe-storage-store.js";
import { daemonUrl, guardNavigations, MainWindowHost, windowUrl } from "./windows.js";

// The preview-driver unit imports dist/main.js for this symbol — the seam
// predates the split, so the export stays on the entry module.
export { createBrowserDriverFactory, createPreviewDriverFactory } from "./preview-driver.js";

/**
 * Colo Design 데스크톱 앱의 메인 프로세스:
 * - 데몬을 in-process 로 호스팅한다 — 별도 Node 사이드카가 없다. 포트는
 *   임시 포트, 페어링 토큰은 실행마다 새로 만들어 url 로만 전달한다.
 * - 웹 UI 는 데몬이 직접 정적 서빙한다(webDist). 렌더러는
 *   http://127.0.0.1:<port>/?token=<token> 을 연다 — 연결 화면 없음.
 * - 자격 증명은 safeStorage 저장소를 데몬에 주입한다.
 * - 번들 런타임(포터블 node·pnpm, win 은 MinGit)이 resources 에 있으면
 *   COLO_DESIGN_EXTRA_PATH 로 데몬에 알려준다(repo-core.ts 가 PATH 앞에 붙인다).
 * - AI 의 미리보기 창(PLAN D61 · D63)은 preview-driver.ts 가 든다 —
 *   숨은 오프스크린 `BrowserWindow` 가 데몬의 `previewDriverFactory` 로
 *   들어가고, paint 는 PiP 프레임으로 렌더러에 흐른다.
 *
 * 이 파일은 조립만 남는다 — 창은 windows.ts, OS 알림·배지는 app-notify.ts,
 * 자가 교체는 app-updates.ts, 렌더러 다리는 bridge.ts 가 갖는다.
 */

/**
 * 앱 번들 아이디. 두 자리가 같은 문자열을 써야 한다 — Windows 토스트의 AUMID
 * (NSIS 바로 가기에 새겨진 appId)와 mac 알림 설정으로 가는 딥링크.
 */
const APP_BUNDLE_ID = "org.colo-design.desktop";

const LOGS_DIR = join(COLO_DESIGN_DIR, "logs");

// ---------------------------------------------------------------------------
// 데스크톱 설정 — desktop-settings.json 은 창이 없어도 메인이 알아야 하는 값
// (알림 정책, 설정 문서 P0#3)과 다음 실행이 그대로 잡아야 하는 값(데몬 포트)을
// 든다. 알림 정책 자체는 notify-policy 가 들고, 여기서는 읽고 쓰는 자리만 맡는다.
// ---------------------------------------------------------------------------

function desktopSettingsPath(): string {
  return join(app.getPath("userData"), "desktop-settings.json");
}

let daemonServer: DaemonServer | null = null;

/**
 * 리뷰 B3 + ⌘Q 의 구멍: 돌아가는 턴이 앱과 함께 조용히 죽지 않게 한 번
 * 묻는다. 비-mac 의 창 닫기(닫기=종료인 규칙)와 모든 플랫폼의 앱 종료(⌘Q ·
 * 메뉴)가 같은 질문을 공유한다 — mac 은 닫기가 창만 닫으므로 종료 경로에만
 * 묻는다. 한 번 확인한 종료는 이번 실행에서 다시 묻지 않는다.
 */
let stopUnderTurnAllowed = false;
let stopDialogOpen = false;

const host = new MainWindowHost();
const notices = new PlannerNotices(host);
const updates = new SelfUpdates({
  notify: (title, body, onClick) => notices.show(title, body, onClick),
  focusMain: () => host.focusMain(),
  sessionsBusy: () => daemonServer?.anySessionBusy() ?? false,
  allowQuit: () => {
    stopUnderTurnAllowed = true;
  },
});
// reopen 이 만드는 창도 첫 창과 같은 닫기 가드를 단다.
host.onCreated = registerCloseGuard;

/**
 * 같은 userData 를 두 데몬이 쓰는 경쟁을 막는다 — 독립 데몬이 daemon.json 의
 * /health 로 세우던 이중 실행 가드의 앱 판본. 두 번째 실행은 첫째의 창으로
 * 합쳐진다. 테스트 실행(단위 임포트 · 격리 userData 스모크)은 잠그지 않는다
 * — 병렬 레인이 같은 앱을 동시에 띄운다.
 */
const underTest =
  process.env.COLO_DESIGN_DESKTOP_UNIT === "1" || Boolean(process.env.COLO_DESIGN_DESKTOP_SMOKE);
if (underTest || app.requestSingleInstanceLock()) {
  app.on("second-instance", () => host.focusMain());
  // The preview-driver unit imports this module inside its own Electron to
  // reach createPreviewDriverFactory() — the daemon boot below belongs to the
  // app entry only (PLAN D61).
  if (process.env.COLO_DESIGN_DESKTOP_UNIT !== "1") {
    void app
      .whenReady()
      .then(() => bootApp())
      .catch((error: unknown) => {
        // 준비 중 폭발한 오류는 창도 오류 상자도 없이 조용히 사라진다 —
        // 잡아서 보여주고 끝낸다.
        dialog.showErrorBox(
          "Colo Design",
          `시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        );
        app.quit();
      });
  }
} else {
  // 두 번째 인스턴스 — 첫째에 합쳐지고 여기서 끝난다.
  app.quit();
}

// The smoke suite points this at a throwaway folder: Playwright launches
// Electron without isolating userData, so the app would otherwise start with
// the developer's real credentials.json — the GitHub gate would pass and the
// "fresh machine lands on the wizard" check would hang on any machine that
// has logged in. setPath must precede every userData reader below.
if (process.env.COLO_DESIGN_DESKTOP_SMOKE) {
  app.setPath("userData", process.env.COLO_DESIGN_DESKTOP_SMOKE);
}

/**
 * 저장 포트로 먼저 뜨고, 그 자리가 점유돼 있으면 임시 포트로 물러난다.
 * 점유(EADDRINUSE)가 아닌 실패는 그대로 던진다 — bootApp 이 오류 상자로 바꾼다.
 */
async function startDaemonServer(
  makeServer: (port: number) => DaemonServer,
  storedPort: number | null,
): Promise<DaemonServer> {
  let server = makeServer(storedPort ?? 0);
  try {
    await server.start();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || storedPort === null) {
      throw error;
    }
    server = makeServer(0);
    await server.start();
  }
  return server;
}

async function bootApp(): Promise<void> {
  // Windows 토스트 알림은 시작 메뉴 바로 가기의 AUMID 로 귀속된다. NSIS 템플릿은
  // 바로 가기에 appId 를 새기므로 같은 문자열을 여기서 직접 건다 — Squirrel 이
  // 하던 자동 맞춤이 NSIS 에는 없고, 어긋난 채 띄운 알림은 Windows 가 조용히
  // 유실시킨다. mac·linux 에서는 이 호출이 아무 일도 하지 않는다.
  app.setAppUserModelId(APP_BUNDLE_ID);
  notices.prefs = loadNotificationPrefs(desktopSettingsPath());
  const token = randomBytes(24).toString("hex");
  const credentials = new SafeStorageCredentialStore(
    safeStorage as never,
    join(app.getPath("userData"), "credentials.json"),
  );

  const resourcesBin = join(process.resourcesPath, "bin");
  const extraPath = existsSync(resourcesBin) ? resourcesBin : undefined;
  if (extraPath) process.env.COLO_DESIGN_EXTRA_PATH = extraPath;
  // 데스크톱 앱이 데몬을 감싸므로 데몬의 자식들도 이 프로세스의 PATH 를
  // 물려받는다 — 번들 런타임을 앞에 두고 시작한다.
  // 구분자는 플랫폼 것을 쓴다 — win32 에서 `:` 로 붙이면 첫 PATH 항목이 깨진다.
  if (extraPath) process.env.PATH = `${extraPath}${delimiter}${process.env.PATH}`;

  const webDist = existsSync(join(app.getAppPath(), "web-dist"))
    ? join(app.getAppPath(), "web-dist")
    : undefined;

  // AI 의 미리보기 (PLAN D61): 세션 도구는 pane 의 페이지를 drive 하고,
  // 창은 모두 이 파일이 만든다 — pane 을 찾는 getter 를 넘기면
  // 드라이버는 Electron 을 몰라도 된다 (PLAN D61).
  const browserDrivers = createBrowserDriverFactory(() => plannerPreview);
  const previewDriverFactory = createPreviewDriverFactory(() => plannerPreview, browserDrivers);
  const onNotice = (notice: DaemonNotice) => {
    notices.notifyPlanner(notice);
    // 연기된 업데이트가 있으면 이 전이가 "모두 내려앉음"이었는지 본다.
    void updates.maybeRunDeferred();
  };
  const makeServer = (port: number) =>
    new DaemonServer({
      host: "127.0.0.1",
      port,
      token,
      webDist,
      credentialStore: credentials,
      previewDriverFactory,
      browserDriverFactory: browserDrivers,
      onNotice,
    });

  /**
   * 지난 실행이 저장한 포트로 먼저 뜬다 — 저장 포트가 점유돼 있으면 임시
   * 포트로 물러나고, 실제로 잡힌 포트를 다시 저장해 다음 실행이 같은 자리로
   * 수렴하게 한다.
   */
  const storedPort = loadStoredPort(desktopSettingsPath());
  let server: DaemonServer;
  try {
    server = await startDaemonServer(makeServer, storedPort);
  } catch (error) {
    // 데몬이 뜨지 못하면 창을 띄워도 빈 화면이다 — 원인과 기록 폴더를 알리고
    // 끝낸다. showErrorBox 는 닫힐 때까지 막는 대화상자라 exit 이 뒤에서 기다린다.
    // 기록 폴더는 bridge 의 desktop:open-home("logs") 이 여는 것과 같은 자리다.
    if (!underTest) {
      const reason = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox(
        "Colo Design을 시작하지 못했습니다",
        `원인: ${reason}\n\n자세한 기록은 이 폴더에 있습니다:\n${LOGS_DIR}`,
      );
    }
    app.exit(1);
    return;
  }
  const boundPort = server.address().port;
  if (boundPort !== storedPort) saveDesktopSettings(desktopSettingsPath(), { port: boundPort });
  daemonServer = server;
  const url = windowUrl(daemonUrl(server, token));

  const window = host.create();
  host.adopt(window, url);
  // 사용자의 미리보기 (PLAN D64 → webview): 렌더러의 <webview> 게스트를
  // 클레임하는 주인이다 — 펜스와 클레임을 창의 webContents에 건다.
  const plannerPreview = new PlannerPreviewView(() => host.window);
  registerPreviewIpc(plannerPreview);
  plannerPreview.attachWindow(window);
  // reopen 이 만드는 창도 같은 닫기 가드·같은 펜스를 단다.
  host.onCreated = (created) => {
    registerCloseGuard(created);
    plannerPreview.attachWindow(created);
  };
  // 단축키는 메뉴가 소유한다 (PLAN D85 ⓒ): 보기 항목은 미리보기 뷰를 겨눈다 —
  // 기본 메뉴의 ⌘R · ⌘+ 가 도구 UI 를 건드리던 시절은 끝난다.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        preview: {
          reload: () => plannerPreview.reload(),
          history: (delta) => plannerPreview.history(delta),
          zoomIn: () => plannerPreview.zoomIn(),
          zoomOut: () => plannerPreview.zoomOut(),
          zoomReset: () => plannerPreview.zoomReset(),
        },
        gotoAddress: () =>
          host.window?.webContents.send("colo-preview:key", {
            key: "l",
            meta: true,
          }),
        openSettings: () =>
          host.window?.webContents.send("colo-preview:key", {
            key: ",",
            meta: true,
          }),
        newSession: () =>
          host.window?.webContents.send("colo-preview:key", {
            key: "t",
            meta: true,
          }),
        // 도움말의 `기록 폴더 열기` — bridge 의 desktop:open-home("logs") 이
        // 여는 것과 같은 폴더를 메인이 직접 연다(렌더러가 죽어 있어도 닿는다).
        openLogs: () => {
          mkdirSync(LOGS_DIR, { recursive: true });
          void shell.openPath(LOGS_DIR);
        },
        packaged: app.isPackaged,
      }),
    ),
  );
  // 새 창과 같은 창 네비게이션을 전부 가둔다 — guardNavigations 가 두 잠금을
  // 든다. 채팅의 링크도 window.open 을 지나 OS 브라우저로 나간다 — 설정
  // `앱에서 링크 열기`가 켜진 클릭만 렌더러가 preview:open-external 로 돌린다.
  guardNavigations(window, new URL(url).origin);
  // 데스크톱 스위트의 손잡이(desktop-comments.mjs 가 app.evaluate 로 닿는다).
  // main 의 globalThis 는 렌더러에서 보이지 않으니 제품 면에는 나오지 않는다.
  const suiteHandle = globalThis as Record<string, unknown>;
  suiteHandle.coloDesignPlannerPreview = plannerPreview;
  await window.loadURL(url);
  // The pane outlives the window — on mac ⌘W destroys it and the dock
  // icon builds another (createWindow's closure follows `host.window`).
  // Its guests die with the old window and the registry forgets them
  // (`destroyed`), so all the new page needs is the park itself.
  // host 가 들고 reopen 이 만드는 창에도 같은 정리가 닿는다.
  host.onClosed = () => {
    plannerPreview.unmount();
  };
  registerCloseGuard(window);

  registerDesktopBridge({
    updates,
    notices,
    focusMain: () => host.focusMain(),
    bundleId: APP_BUNDLE_ID,
    logsDir: LOGS_DIR,
    settingsPath: desktopSettingsPath,
  });
  void updates.reportSwapResult();
  updates.schedule();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void host.reopen();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("browser-window-focus", () => {
  notices.markRead();
});

function guardStopUnderTurn(event: { preventDefault(): void }, proceed: () => void): void {
  if (stopUnderTurnAllowed || !daemonServer?.anySessionBusy()) return;
  // 다이얼로그가 이미 떠 있는 두 번째 종료 시도도 막는다 — 통과시키면 확인
  // 없이 실행 중인 턴을 죽이는 뒷문이 된다.
  if (stopDialogOpen) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  stopDialogOpen = true;
  void dialog
    .showMessageBox({
      type: "question",
      title: "작업이 진행 중입니다",
      message: "AI가 작업 중입니다. 지금 끝내면 이 작업은 멈춥니다.",
      buttons: ["그만두고 끝내기", "취소"],
      defaultId: 1,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) {
        stopUnderTurnAllowed = true;
        proceed();
      }
    })
    .finally(() => {
      stopDialogOpen = false;
    });
}

function registerCloseGuard(window: BrowserWindow): void {
  window.on("close", (event) => {
    if (process.platform === "darwin") return;
    guardStopUnderTurn(event, () => window.close());
  });
}

/** ⌘Q · 메뉴의 종료 — mac 의 창 닫기가 여기 오지 않으므로 플랫폼 무관 단다. */
app.on("before-quit", (event) => {
  guardStopUnderTurn(event, () => app.quit());
});

/**
 * 종료가 데몬을 데리고 나간다. 앱은 데몬을 제 프로세스 안에서 키우는데,
 * 미리보기 서버는 그 데몬이 띄운 별개의 프로세스다 — 아무도 `stop()` 을
 * 부르지 않으면 앱이 사라진 뒤에도 그 서버들이 포트를 쥔 채 남는다(테스트
 * 기계에서 하루치 실행이 수백 개를 남긴 것이 그 증거였다). `will-quit` 은
 * 창이 다 닫힌 뒤, 프로세스가 끝나기 직전이다: 한 번만 막아 세우고,
 * 정리가 끝나면 스스로 다시 나간다.
 */
let daemonStopped = false;
app.on("will-quit", (event) => {
  if (daemonStopped || !daemonServer) return;
  event.preventDefault();
  void daemonServer.stop().finally(() => {
    daemonStopped = true;
    app.quit();
  });
});
