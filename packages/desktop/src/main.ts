import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { readFile, rm, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { COLO_DESIGN_DIR } from "@colo-design/daemon/environment";
import type { DaemonNotice, PreviewDriver, PreviewDriverFactory } from "@colo-design/daemon/server";
// 서브패스로 가져온다 — 루트 진입점은 CLI 라 가져오는 순간 실행된다.
import { DaemonServer } from "@colo-design/daemon/server";
import { checkForUpdate, RELEASES_FEED_URL, type UpdateCheckResult } from "@colo-design/protocol";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  net,
  safeStorage,
  screen,
  shell,
} from "electron";
import {
  buildSwapScript,
  parseSwapResult,
  planSelfUpdate,
  requireDiskSpace,
  verifyDownload,
} from "./mac-self-update.js";
import { buildMenuTemplate } from "./menu.js";
import { noticeCopy } from "./notices.js";
import { PlannerPreviewView, registerPreviewIpc } from "./preview-view.js";
import { SafeStorageCredentialStore } from "./safe-storage-store.js";

/**
 * Colo Design 데스크톱 앱의 메인 프로세스(DESIGN §7):
 * - 데몬을 in-process 로 호스팅한다 — 별도 Node 사이드카가 없다. 포트는
 *   임시 포트, 페어링 토큰은 실행마다 새로 만들어 url 로만 전달한다.
 * - 웹 UI 는 데몬이 직접 정적 서빙한다(webDist). 렌더러는
 *   http://127.0.0.1:<port>/?token=<token> 을 연다 — 연결 화면 없음.
 * - 자격 증명은 safeStorage 저장소를 데몬에 주입한다.
 * - 번들 런타임(포터블 node·pnpm, win 은 MinGit)이 resources 에 있으면
 *   COLO_DESIGN_EXTRA_PATH 로 데몬에 알려준다(repo.ts 가 PATH 앞에 붙인다).
 * - Claude 의 미리보기 창(PLAN D61 · D63)도 여기서 산다 — 숨은 오프스크린
 *   `BrowserWindow` 가 데몬의 `previewDriverFactory` 로 들어가고, paint 는
 *   PiP 프레임으로 렌더러에 흐른다.
 */

let mainWindow: BrowserWindow | null = null;
/** 알림 클릭이 창을 되살릴 수 있도록 — macOS 는 창이 없어도 앱이 산다. */
let appUrl: string | null = null;
/**
 * 창이 뒤에 있는 동안 도착한 기획자의 순간 수 — dock 배지로 세운다. mac 의
 * 개념이므로 다른 플랫폼은 paint 가 조용히 건너뛴다.
 */
let unreadNotices = 0;

/** 알림 클릭 → 그 대화 열기(리뷰 B7): 메인이 렌더러에 건네는 채널. */
const OPEN_SESSION_CHANNEL = "colodesign:open-session";
/** 창이 없었다가 다시 열린 경우 — 적재가 끝난 뒤 건네기 위해 세워 둔 세션. */
let pendingOpenSession: string | null = null;
/** 실행 중인 턴의 존재를 창 닫기 가드가 묻는 데 쓴다(리뷰 B3). */
let daemonServer: DaemonServer | null = null;

// ---------------------------------------------------------------------------
// 업데이트 (DESIGN §7) — 자동 확인 · 자가 교체 결과 보고
// ---------------------------------------------------------------------------

/** 자가 교체에 필요한 최소 여유 — zip + 풀린 번들 + 백업 사본의 상한. */
const UPDATE_MIN_FREE_BYTES = 1024 ** 3;
/** 자동 확인의 첫 시점 — 시작 작업(데몬·창)과 경합하지 않는다. */
const UPDATE_FIRST_CHECK_DELAY_MS = 15_000;
/** 자동 확인의 주기 — 하루 한 번. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 이미 알림을 띄운 버전 — 같은 버전으로 하루마다 다시 띄우지 않는다. */
let notifiedUpdateVersion: string | null = null;

/** 교체 스크립트가 결과를 남기는 파일 — 다음 실행이 읽고 지운다. */
function updateResultPath(): string {
  return join(app.getPath("userData"), "update-result.json");
}

// ---------------------------------------------------------------------------
// Claude 의 미리보기 드라이버 (PLAN D61 · D63)
// ---------------------------------------------------------------------------

/** 캡처의 원본 해상도 — 도구가 긴 변 900px 로 줄여 준다. */
const PREVIEW_WINDOW_SIZE = { width: 1280, height: 800 };
/** PiP 프레임 스로틀 (PLAN D63): 8fps. */
const PIP_FRAME_INTERVAL_MS = 125;
const PIP_LONG_EDGE = 640;

/**
 * 숨은 오프스크린 `BrowserWindow` 하나가 Claude 전용 브라우저다. 그리기는
 * `webContents.debugger`(CDP)에게 맡긴다: 캡처는 `Page.captureScreenshot`,
 * 접근성 트리는 `Accessibility.getFullAXTree`, 클릭은 `Runtime.evaluate` 로
 * 찾은 rect 위에 `Input.dispatchMouseEvent`. 창은 화면에 뜨지 않는다 —
 * 보이는 창은 기획자의 것뿐이다.
 */
class ElectronPreviewDriver implements PreviewDriver {
  private window: BrowserWindow | null = null;
  private readonly consoleHistory: Array<{ level: string; text: string }> = [];
  private lastFrameSent = 0;

  constructor(private readonly baseUrl: string) {}

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      show: false,
      ...PREVIEW_WINDOW_SIZE,
      webPreferences: {
        offscreen: true,
        partition: "preview-claude",
        sandbox: true,
        contextIsolation: true,
      },
    });
    const contents = window.webContents;
    contents.debugger.attach("1.3");
    // consoleAPICalled 은 Runtime 도메인을 켜야 흐른다.
    contents.debugger.sendCommand("Runtime.enable", {});
    // Electron 이 스스로 내주는 콘솔 이벤트가 제일 믿을 만하다(PLAN D69 와 같은
    // 형태) — 44 부터 첫 인자가 details { level: "info"|"warning"|"error"|"debug" }.
    contents.on("console-message", (details) => {
      this.consoleHistory.push({ level: details.level, text: details.message });
    });
    contents.on("paint", (_details, _rect, image) => {
      const now = Date.now();
      if (now - this.lastFrameSent < PIP_FRAME_INTERVAL_MS) return;
      this.lastFrameSent = now;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const size = image.getSize();
      const scale = Math.min(1, PIP_LONG_EDGE / Math.max(size.width, size.height));
      const shrunk = scale < 1 ? image.resize({ width: Math.round(size.width * scale) }) : image;
      mainWindow.webContents.send("colo-preview:frame", shrunk.toJPEG(60).toString("base64"));
    });
    this.window = window;
    return window;
  }

  async open(route: string, state: string | null): Promise<void> {
    const url = new URL(route, this.baseUrl);
    // A declared screen must stay inside the preview server — an absolute
    // route would carry this hidden window (and its debugger) to an origin
    // the repo picked. PlannerPreviewView.open checks the same thing.
    if (url.origin !== new URL(this.baseUrl).origin) return;
    if (state) url.searchParams.set("state", state);
    // 콘솔 기록은 화면 이동과 함께 리셋 — screen_console 의 기준점이다.
    this.consoleHistory.length = 0;
    const window = await this.ensureWindow();
    await window.webContents.loadURL(url.toString());
  }

  async screenshot(): Promise<string> {
    const window = await this.ensureWindow();
    const result = (await window.webContents.debugger.sendCommand("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
    })) as { data?: string };
    if (!result?.data) throw new Error("미리보기 화면을 캡처하지 못했습니다");
    const image = nativeImage.createFromBuffer(Buffer.from(result.data, "base64"));
    const size = image.getSize();
    const scale = 900 / Math.max(size.width, size.height);
    if (scale >= 1) return result.data;
    const longEdge = Math.round(900);
    const shortEdge = Math.round((size.width < size.height ? size.width : size.height) * scale);
    const resized =
      size.width < size.height
        ? image.resize({ width: shortEdge, height: longEdge })
        : image.resize({ width: longEdge, height: shortEdge });
    return resized.toJPEG(70).toString("base64");
  }

  async axTree(): Promise<string> {
    const window = await this.ensureWindow();
    const result = (await window.webContents.debugger.sendCommand(
      "Accessibility.getFullAXTree",
      {},
    )) as {
      nodes?: Array<{ role?: { type?: string }; name?: { value?: unknown } }>;
    };
    const lines = (result.nodes ?? [])
      .map((node) => [node.role?.type, node.name?.value].filter(Boolean).map(String).join(" "))
      .filter((line) => line.trim() !== "");
    return lines.slice(0, 200).join("\n");
  }

  async click(target: { text?: string; selector?: string }): Promise<void> {
    const window = await this.ensureWindow();
    // 오프스크린 창은 포커스가 없어 입력이 무시될 수 있다 — 먼저 창을 살린다.
    window.webContents.focus();
    // 요소를 찾아(CSS 거나 보이는 글자거나 — 글자면 가장 안쪽 것) 화면 한가운데로
    // 굴려 올린 뒤, 그 시점의 뷰포트 rect 를 돌려 받는다.
    const find = target.selector
      ? `(function () {
          const el = document.querySelector(${JSON.stringify(target.selector)});
          if (!el) return null;
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`
      : `(function () {
          const needle = ${JSON.stringify(target.text ?? "")};
          const all = Array.from(document.querySelectorAll("body *")).filter((el) =>
            (el.textContent || "").includes(needle));
          const el = all.find((candidate) =>
            !all.some((other) => other !== candidate && candidate.contains(other))) || null;
          if (!el) return null;
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`;
    const evaluate = () =>
      window.webContents.debugger.sendCommand("Runtime.evaluate", {
        expression: find,
        returnByValue: true,
      }) as Promise<{
        result?: {
          value?: { x: number; y: number; width: number; height: number };
        };
      }>;
    // 캡처 직후 등 컨텍스트가 갈아엎어지는 순간이 있다 — 한 번 더 물어본다.
    let result = await evaluate();
    if (!result?.result?.value) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      result = await evaluate();
    }
    const rect = result?.result?.value;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`화면에서 찾지 못했습니다: ${target.text ?? target.selector}`);
    }
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    // 오프스크린 페이지는 태어나자마자 뒷전이다 — 먼저 앞으로 끌어 올린다.
    await window.webContents.debugger.sendCommand("Page.bringToFront", {});
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async consoleLines(): Promise<Array<{ level: string; text: string }>> {
    return [...this.consoleHistory];
  }

  async destroy(): Promise<void> {
    const window = this.window;
    this.window = null;
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.debugger.detach();
    } catch {
      // 이미 떨어져 나갔거나 창이 닫히는 중이다 — 지울 게 없을 뿐이다.
    }
    window.destroy();
  }
}

/**
 * 데몬에 주입되는 드라이버 공장. 데몬은 Electron 을 모른다 — 이 모듈만이
 * 창을 만들고, 세션마다 하나의 숨은 창이 생긴다(PLAN D61).
 */
export function createPreviewDriverFactory(): PreviewDriverFactory {
  return { for: (baseUrl) => new ElectronPreviewDriver(baseUrl) };
}

// The preview-driver unit imports this module inside its own Electron to
// reach createPreviewDriverFactory() — the daemon boot below belongs to the
// app entry only (PLAN D61).
if (process.env.COLO_DESIGN_DESKTOP_UNIT !== "1") {
  void app.whenReady().then(() => bootApp());
}

// The smoke suite points this at a throwaway folder: Playwright launches
// Electron without isolating userData, so the app would otherwise start with
// the developer's real credentials.json — the GitHub gate would pass and the
// "fresh machine lands on the wizard" check would hang on any machine that
// has logged in. setPath must precede every userData reader below.
if (process.env.COLO_DESIGN_DESKTOP_SMOKE) {
  app.setPath("userData", process.env.COLO_DESIGN_DESKTOP_SMOKE);
}

async function bootApp(): Promise<void> {
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
  if (extraPath) process.env.PATH = `${extraPath}:${process.env.PATH}`;

  const webDist = existsSync(join(app.getAppPath(), "web-dist"))
    ? join(app.getAppPath(), "web-dist")
    : undefined;

  const server = new DaemonServer({
    host: "127.0.0.1",
    port: 0, // ephemeral — the daemon picks a free port
    token,
    webDist,
    credentialStore: credentials,
    // Claude 의 미리보기 창 (PLAN D61): 세션에 colo-preview 도구를 단다.
    previewDriverFactory: createPreviewDriverFactory(),
    onNotice: notifyPlanner,
  });
  await server.start();
  daemonServer = server;
  const url = windowUrl(daemonUrl(server, token));
  appUrl = url;

  mainWindow = createMainWindow();
  // 기획자의 미리보기 뷰 (PLAN D64): 같은 창 위에 얹고, 렌더러의 다리를 단다.
  const plannerPreview = new PlannerPreviewView(() => mainWindow);
  registerPreviewIpc(plannerPreview);
  // 단축키는 메뉴가 소유한다 (PLAN D85 ⓒ): 보기 항목은 미리보기 뷰를 겨눈다 —
  // 기본 메뉴의 ⌘R · ⌘+ 가 도구 UI 를 건드리던 시절은 끝난다.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        preview: plannerPreview,
        gotoAddress: () =>
          mainWindow?.webContents.send("colo-preview:key", {
            key: "l",
            meta: true,
          }),
        openSettings: () =>
          mainWindow?.webContents.send("colo-preview:key", {
            key: ",",
            meta: true,
          }),
        newSession: () =>
          mainWindow?.webContents.send("colo-preview:key", {
            key: "t",
            meta: true,
          }),
        packaged: app.isPackaged,
      }),
    ),
  );
  // 새 창과 같은 창 네비게이션을 전부 가둔다 — guardNavigations 가 두 잠금을
  // 든다. 채팅의 링크도 window.open 을 지나 OS 브라우저로 나간다.
  guardNavigations(mainWindow, new URL(url).origin);
  // 데스크톱 스위트의 손잡이(desktop-comments.mjs 가 app.evaluate 로 닿는다).
  // main 의 globalThis 는 렌더러에서 보이지 않으니 제품 면에는 나오지 않는다.
  const suiteHandle = globalThis as Record<string, unknown>;
  suiteHandle.coloDesignPlannerPreview = plannerPreview;
  await mainWindow.loadURL(url);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  registerCloseGuard(mainWindow);

  registerDesktopBridge();
  void reportSwapResult();
  scheduleUpdateChecks();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void reopen(url);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("browser-window-focus", () => {
  unreadNotices = 0;
  paintBadge();
});

/** 화면 작업 영역 크기 — 창을 열 때 고정 크기 대신 쓴다. */
function workAreaSize(): { width: number; height: number } {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return { width, height };
}

/**
 * 창의 네비게이션을 도구 안에 가둔다 (PLAN D85 ⓑ의 잠금 연장): window.open
 * 계열은 http(s) 를 OS 브라우저로 열고 그 외는 막는다 — 빈 Electron 자식
 * 창이 뜨고 도구의 preload 를 물려받는 일은 없다. 같은 창 네비게이션은
 * 도구 origin(데몬) 안의 이동만 허용한다: preload 는 네비게이션을 살아
 * 남으므로, 이 문이 없으면 채팅의 링크 하나가 창을 통째로 다른 origin 으로
 * 데려갈 수 있다.
 */
function guardNavigations(window: BrowserWindow, toolOrigin: string): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const { protocol } = new URL(url);
      if (protocol === "http:" || protocol === "https:") {
        void shell.openExternal(url);
      }
    } catch {
      // a url that will not parse has no protocol to allow
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    try {
      if (new URL(target).origin === toolOrigin) return;
    } catch {
      // unparseable targets fall through to the block below
    }
    event.preventDefault();
    try {
      const { protocol } = new URL(target);
      if (protocol === "http:" || protocol === "https:") {
        void shell.openExternal(target);
      }
    } catch {
      // nothing worth handing to the browser either
    }
  });
}

/**
 * The one window recipe, shared by boot and reopen: a window made without it
 * (the notification-click reopen used to build its own) has no preload, so
 * `coloDesignDesktop` never exists in it — the update bridge, 폴더 열기, the
 * native preview (pins, PiP, bounds) and open-session all die quietly, and
 * the title goes with them.
 */
function createMainWindow(): BrowserWindow {
  return new BrowserWindow({
    // 화면 작업 영역에 맞춘다 — 고정 크기는 큰 모니터에서 조그맣게 보인다.
    ...workAreaSize(),
    title: "Colo Design",
    autoHideMenuBar: true,
    webPreferences: {
      // 업데이트 확인 다리 — 이 preload 가 렌더러에 노출하는 전부다.
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
    },
  });
}
function daemonUrl(server: DaemonServer, token: string): string {
  // The daemon listens on an ephemeral port; ask it where it ended up.
  const address = server.address();
  return `http://${address.address === "::1" ? "127.0.0.1" : address.address}:${address.port}/?token=${token}`;
}

/**
 * 창이 실제로 열 주소. 보통은 데몬 자신이지만, 개발 실행의 HMR 경로
 * (`pnpm dev:desktop` → scripts/dev.mjs --hmr)에서는 vite 개발 서버를 연다 —
 * 웹을 한 줄 고칠 때마다 전체 빌드를 다시 돌리지 않기 위해서다. 데몬은
 * 그대로 in-process 이므로 ws 를 어디에 걸어야 하는지 `daemon` 질의로
 * 건넨다(App.tsx 가 읽는다). 패키징된 앱은 환경 변수를 보지 않는다 —
 * 창이 다른 origin 을 여는 문은 개발에만 존재한다.
 */
function windowUrl(daemon: string): string {
  const devServer = app.isPackaged ? undefined : process.env.COLO_DESIGN_DEV_SERVER;
  if (!devServer) return daemon;
  const source = new URL(daemon);
  const target = new URL(devServer);
  target.searchParams.set("token", source.searchParams.get("token") ?? "");
  target.searchParams.set("daemon", source.host);
  return target.toString();
}

async function reopen(url: string): Promise<void> {
  mainWindow = createMainWindow();
  guardNavigations(mainWindow, new URL(url).origin);
  registerCloseGuard(mainWindow);
  await mainWindow.loadURL(url);
  // 리뷰 B7: a notification clicked while no window existed — the renderer
  // was not mounted to hear the session id, so it rides after the load.
  if (pendingOpenSession) {
    const sessionId = pendingOpenSession;
    pendingOpenSession = null;
    setTimeout(() => mainWindow?.webContents.send(OPEN_SESSION_CHANNEL, sessionId), 1200);
  }
}

/**
 * 데몬이 건넨 기획자의 순간을 OS 알림으로 그린다. 창이 앞에 있으면 기획자가
 * 이미 보고 있는 것이므로 조용히 한다. 클릭은 창을 앞으로, 그리고 그 대화로 —
 * 세션 아이디를 렌더러에 건네 열려는 대화를 알린다(리뷰 B7).
 */
function notifyPlanner(notice: DaemonNotice): void {
  if (mainWindow?.isFocused()) return;
  unreadNotices += 1;
  paintBadge();
  const { title, body } = noticeCopy(notice);
  showAppNotification(title, body, () => focusMainWindow(notice.sessionId));
}

/** 알림 클릭의 공통 행동 — 창을 앞으로, 그 대화로. 창이 없으면 다시 연다. */
function focusMainWindow(sessionId?: string): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (sessionId) mainWindow.webContents.send(OPEN_SESSION_CHANNEL, sessionId);
  } else if (appUrl) {
    pendingOpenSession = sessionId ?? null;
    void reopen(appUrl);
  }
}

/**
 * 리뷰 B3: 창 닫기가 곧 종료인 플랫폼에서는 돌고 있는 턴이 창과 함께 조용히
 * 죽었다 — mac 은 살고 windows 는 죽는 규칙은 기획자가 배울 수 없는 규칙이다.
 * 일이 돌고 있는 동안에는 한 번 묻고, 확인한 닫기만 지난다. mac 의 닫기는
 * 창만 닫으므로 가드가 애초에 없다.
 */
function registerCloseGuard(window: BrowserWindow): void {
  let allowed = false;
  window.on("close", (event) => {
    if (allowed || process.platform === "darwin") return;
    if (!daemonServer?.anySessionBusy()) return;
    event.preventDefault();
    void dialog
      .showMessageBox(window, {
        type: "question",
        title: "작업이 진행 중입니다",
        message: "Claude가 작업 중입니다. 창을 닫으면 이 작업은 멈춥니다.",
        buttons: ["그만둡니다", "취소"],
        defaultId: 1,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          allowed = true;
          window.close();
        }
      });
  });
}

/** OS 알림 — 클릭 행동을 골라 단다(기획자 순간과 업데이트 알림이 함께 쓴다). */
function showAppNotification(title: string, body: string, onClick: () => void): void {
  const notification = new Notification({ title, body });
  notification.on("click", onClick);
  notification.show();
}

/**
 * 자동 업데이트 확인(DESIGN §7): 앱이 살아 있는 동안 하루 한 번 조용히 피드를
 * 묻는다. 새 버전이 있으면 알림을 띄워 설정까지 찾아가게 하지 않는다 — 버전마다
 * 한 번만. 실패는 언제나 조용히: 자동으로 떠드는 오류는 없고 다음 확인이 다시
 * 온다. 개발 실행은 피드를 묻지 않는다.
 */
function scheduleUpdateChecks(): void {
  if (!app.isPackaged) return;
  const check = async () => {
    try {
      const feed = await checkForUpdate(app.getVersion(), RELEASES_FEED_URL, netFetch);
      if (!feed.updateAvailable || feed.version === notifiedUpdateVersion) return;
      notifiedUpdateVersion = feed.version;
      showAppNotification(
        "새 버전이 있습니다",
        `Colo Design ${feed.version} — 설정 → 문제 해결의 업데이트 확인에서 설치할 수 있습니다.`,
        focusMainWindow,
      );
    } catch {
      // 자동 확인의 실패는 조용히 넘어간다 — 수동 확인 버튼이 오류를 보여준다.
    }
  };
  setTimeout(() => void check(), UPDATE_FIRST_CHECK_DELAY_MS);
  setInterval(() => void check(), UPDATE_CHECK_INTERVAL_MS);
}

/**
 * 지난 번 자가 교체의 결과를 보고한다: 교체 스크립트는 앱이 죽은 뒤에 돌기
 * 때문에 성공·실패를 말할 창이 없다. 다음 실행(=지금)이 결과 파일을 읽어
 * 알림으로 대신 말하고 지운다. 성공은 현재 버전과 일치할 때만 — 어긋나면 오래
 * 된 흔적이니 조용히 지운다. 실패의 클릭은 로그 파일을 연다.
 */
async function reportSwapResult(): Promise<void> {
  const path = updateResultPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return; // 결과 파일이 없으면 보고할 교체가 없었다
  }
  await rm(path, { force: true });
  const result = parseSwapResult(raw);
  if (!result) return;
  if (result.outcome === "done") {
    if (result.version !== app.getVersion()) return;
    showAppNotification(
      "업데이트 완료",
      `Colo Design ${result.version}으로 갈아입었습니다.`,
      focusMainWindow,
    );
    return;
  }
  showAppNotification(
    "업데이트하지 못했습니다",
    `${result.reason ?? "알 수 없는 실패"} — 클릭하면 기록을 보여줍니다.`,
    () => {
      void shell.openPath(result.logPath);
    },
  );
}

/** 배지는 읽지 않은 순간의 수. 알림 클릭이 창을 앞으로 하면 focus 이벤트가 지운다. */
function paintBadge(): void {
  app.dock?.setBadge(unreadNotices > 0 ? String(unreadNotices) : "");
}

/**
 * 렌더러에 노출되는 다리: 업데이트 확인과 `폴더 열기`(PLAN D2[폴더 열기]). 숨긴
 * `~/.colo-design` 을 기획자가 찾아 헤매지 않게 앱이 열어 준다. 자격
 * 증명·토큰은 결코 건너가지 않는다.
 */
function registerDesktopBridge(): void {
  ipcMain.handle("desktop:update-check", async () => {
    try {
      return await checkForUpdate(app.getVersion(), RELEASES_FEED_URL, netFetch);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("desktop:mac-self-update", async () => {
    // 무엇을 내려받고 무엇으로 검증할지는 피드가 정한다 — 렌더러가 건넨
    // url·sha256 은 받지 않는다. 이 다리는 침해된 렌더러가 앱을 제 zip 으로
    // 바꾸는 통로가 되어서는 안 된다: 요청은 요청일 뿐, 출처는 피드다.
    let feed: UpdateCheckResult;
    try {
      feed = await checkForUpdate(app.getVersion(), RELEASES_FEED_URL, netFetch);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (!feed.updateAvailable || !feed.url || !feed.sha256) {
      return {
        error: "설치할 업데이트가 확인되지 않았습니다 — 업데이트 확인을 다시 눌러 주세요.",
      };
    }
    // 실제 교체는 패키징된 앱에서만 — 개발 실행에서는 계획만 돌려준다.
    if (!app.isPackaged) {
      return {
        planned: planSelfUpdate({
          url: feed.url,
          sha256: feed.sha256,
          downloadsDir: app.getPath("downloads"),
          version: "0",
        }),
        guarded: "개발 실행에서는 교체를 실행하지 않습니다",
      };
    }
    if (process.platform !== "darwin") {
      return {
        error:
          "자가 업데이트는 macOS 에서만 동작합니다 — Windows 는 릴리스 페이지의 설치 파일로 갈아입으세요.",
      };
    }
    // DMG 안에서 실행 중이면 교체 대상이 읽기 전용 볼륨이다 — 헛돌고 롤백으로
    // 끝나기 전에 막고 옮기라고 먼저 말한다.
    if (process.execPath.startsWith("/Volumes/")) {
      return {
        error:
          "앱이 디스크 이미지(DMG)에서 실행 중입니다 — 응용 프로그램 폴더로 옮긴 뒤 다시 시도해 주세요.",
      };
    }
    // 교체 대상은 지금 이 실행 파일이 사는 번들 — /Applications 고정이 아니라
    // 어디에서 실행했든 그 자리를 바꾼다.
    const bundle = dirname(dirname(dirname(process.execPath)));
    const plan = planSelfUpdate({
      url: feed.url,
      sha256: feed.sha256,
      downloadsDir: app.getPath("downloads"),
      version: app.getVersion(),
      targetApp: basename(bundle).endsWith(".app") ? bundle : undefined,
    });
    try {
      // 만석은 sha256 이 잡지 못한다 — 내려받기 전에 두 볼륨(내려받기·교체
      // 대상)의 여유를 먼저 본다.
      await requireDiskSpace({
        path: app.getPath("downloads"),
        minBytes: UPDATE_MIN_FREE_BYTES,
        statfs: (target) => statfs(target),
      });
      await requireDiskSpace({
        path: dirname(plan.targetApp),
        minBytes: UPDATE_MIN_FREE_BYTES,
        statfs: (target) => statfs(target),
      });
      await downloadFile(feed.url, plan.downloadPath);
      await verifyDownload(plan.downloadPath, plan.expectedSha256);
      const logPath = join(app.getPath("temp"), "colo-design-update.log");
      const scriptPath = join(app.getPath("temp"), `colo-design-update-${app.getVersion()}.sh`);
      await writeFile(
        scriptPath,
        buildSwapScript({
          plan,
          pid: process.pid,
          logPath,
          resultPath: updateResultPath(),
          version: app.getVersion(),
        }),
        {
          mode: 0o755,
        },
      );
      // 응답이 렌더러에 닿은 뒤에 종료한다 — 화면이 "곧 닫힙니다"를 볼 시간.
      spawn("/bin/bash", [scriptPath], {
        detached: true,
        stdio: "ignore",
      }).unref();
      setTimeout(() => app.quit(), 500);
      return {
        started: true,
        downloadPath: plan.downloadPath,
        steps: plan.steps,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("desktop:open-home", async () => {
    await shell.openPath(COLO_DESIGN_DIR);
    return { opened: COLO_DESIGN_DIR };
  });
}

/** Electron net 모듈을 fetch 처럼 쓴다(프록시·인증서 정책을 앱이 따른다). */
async function netFetch(
  feedUrl: string,
): Promise<{ ok: boolean; status: number; json?: Record<string, unknown> }> {
  const request = net.request(feedUrl);
  const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    let body = "";
    request.on("response", (incoming) => {
      incoming.on("data", (chunk: Buffer) => (body += String(chunk)));
      incoming.on("end", () => resolve({ statusCode: incoming.statusCode, body }));
    });
    request.once("error", reject);
    request.end();
  });
  // json 은 파싱된 값이다(FetchLike 계약). 몸통이 JSON 이 아니면 undefined 로
  // 둔다 — fetchLatest 의 "형식이 올바르지 않습니다" 가 그 모양을 말하게.
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  const statusCode = response.statusCode;
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    json,
  };
}
/** zip 내려받기 — net.fetch 로 받아 파일로 흘려보낸다(큰 zip 도 메모리에 올리지 않는다). */
async function downloadFile(url: string, destPath: string): Promise<void> {
  // 릴리스 에셋 → CDN 넘겨주기는 net 이 기본으로 따라간다.
  const response = await net.fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`업데이트 파일을 내려받지 못했습니다 (HTTP ${response.status})`);
  }
  // Electron 의 body 는 DOM 계열 ReadableStream — Node 스트림으로 다리를 놓는다.
  const body = Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
  await pipeline(body, createWriteStream(destPath));
}
