import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { app, BrowserWindow, ipcMain, Notification, safeStorage, screen, shell } from "electron";
// 서브패스로 가져온다 — 루트 진입점은 CLI 라 가져오는 순간 실행된다.
import { DaemonServer } from "@cds-design/daemon/server";
import { RELEASES_FEED_URL, checkForUpdate } from "@cds-design/protocol";
import { CDS_DESIGN_DIR } from "@cds-design/daemon/environment";
import { SafeStorageCredentialStore } from "./safe-storage-store.js";
import { planSelfUpdate, verifyDownload } from "./mac-self-update.js";
import type { DaemonNotice } from "@cds-design/daemon/server";
import { noticeCopy } from "./notices.js";

/**
 * CDS Design 데스크톱 앱의 메인 프로세스(DESIGN §7):
 * - 데몬을 in-process 로 호스팅한다 — 별도 Node 사이드카가 없다. 포트는
 *   임시 포트, 페어링 토큰은 실행마다 새로 만들어 url 로만 전달한다.
 * - 웹 UI 는 데몬이 직접 정적 서빙한다(webDist). 렌더러는
 *   http://127.0.0.1:<port>/?token=<token> 을 연다 — 연결 화면 없음.
 * - 자격 증명은 safeStorage 저장소를 데몬에 주입한다.
 * - 번들 런타임(포터블 node·pnpm, win 은 MinGit)이 resources 에 있으면
 *   CDS_DESIGN_EXTRA_PATH 로 데몬에 알려준다(repo.ts 가 PATH 앞에 붙인다).
 */

let mainWindow: BrowserWindow | null = null;
/** 알림 클릭이 창을 되살릴 수 있도록 — macOS 는 창이 없어도 앱이 산다. */
let appUrl: string | null = null;
/**
 * 창이 뒤에 있는 동안 도착한 기획자의 순간 수 — dock 배지로 세운다. mac 의
 * 개념이므로 다른 플랫폼은 paint 가 조용히 건너뛴다.
 */
let unreadNotices = 0;

app.whenReady().then(async () => {
  const token = randomBytes(24).toString("hex");
  const credentials = new SafeStorageCredentialStore(
    safeStorage as never,
    join(app.getPath("userData"), "credentials.json"),
  );

  const resourcesBin = join(process.resourcesPath, "bin");
  const extraPath = existsSync(resourcesBin) ? resourcesBin : undefined;
  if (extraPath) process.env.CDS_DESIGN_EXTRA_PATH = extraPath;
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
    onNotice: notifyPlanner,
  });
  await server.start();
  const url = daemonUrl(server, token);
  appUrl = url;

  mainWindow = new BrowserWindow({
    // 화면 작업 영역에 맞춘다 — 고정 크기는 큰 모니터에서 조그맣게 보인다.
    ...workAreaSize(),
    title: "CDS Design",
    autoHideMenuBar: true,
    webPreferences: {
      // 업데이트 확인 다리 — 이 preload 가 렌더러에 노출하는 전부다.
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
    },
  });
  await mainWindow.loadURL(url);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  registerDesktopBridge();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void reopen(url);
  });
});

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

function daemonUrl(server: DaemonServer, token: string): string {
  // The daemon listens on an ephemeral port; ask it where it ended up.
  const address = server.address();
  return `http://${address.address === "::1" ? "127.0.0.1" : address.address}:${address.port}/?token=${token}`;
}

async function reopen(url: string): Promise<void> {
  mainWindow = new BrowserWindow({ ...workAreaSize(), autoHideMenuBar: true });
  await mainWindow.loadURL(url);
}

/**
 * 데몬이 건넨 기획자의 순간을 OS 알림으로 그린다. 창이 앞에 있으면 기획자가
 * 이미 보고 있는 것이므로 조용히 한다. 클릭은 창을 앞으로 — 세션 탭 고르기는
 * UI 의 몫이다.
 */
function notifyPlanner(notice: DaemonNotice): void {
  if (mainWindow?.isFocused()) return;
  unreadNotices += 1;
  paintBadge();
  const { title, body } = noticeCopy(notice);
  const notification = new Notification({ title, body });
  notification.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (appUrl) {
      void reopen(appUrl);
    }
  });
  notification.show();
}

/** 배지는 읽지 않은 순간의 수. 알림 클릭이 창을 앞으로 하면 focus 이벤트가 지운다. */
function paintBadge(): void {
  app.dock?.setBadge(unreadNotices > 0 ? String(unreadNotices) : "");
}

/**
 * 렌더러에 노출되는 다리: 업데이트 확인과 `폴더 열기`(PLAN D2). 숨긴
 * `~/.cds-design` 을 기획자가 찾아 헤매지 않게 앱이 열어 준다. 자격
 * 증명·토큰은 결코 건너가지 않는다.
 */
function registerDesktopBridge(): void {
  ipcMain.handle("desktop:update-check", async () => {
    const fetchLike = async (feedUrl: string) => {
      const response = await netFetch(feedUrl);
      return { ok: response.ok, status: response.status, json: await response.json() };
    };
    try {
      return await checkForUpdate(app.getVersion(), RELEASES_FEED_URL, fetchLike);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("desktop:mac-self-update", async (_event, input: { url: string; sha256: string }) => {
    // 실제 교체는 패키징된 앱에서만 — 개발 실행에서는 계획만 돌려준다.
    if (!app.isPackaged) {
      return {
        planned: planSelfUpdate({
          url: input.url,
          sha256: input.sha256,
          downloadsDir: app.getPath("downloads"),
          version: "0",
        }),
        guarded: "개발 실행에서는 교체를 실행하지 않습니다",
      };
    }
    const plan = planSelfUpdate({
      url: input.url,
      sha256: input.sha256,
      downloadsDir: app.getPath("downloads"),
      version: String(app.getVersion()),
    });
    void verifyDownload; // 실행 경로는 아래 자가교체 이야기에서 잇는다.
  });

  ipcMain.handle("desktop:open-home", async () => {
    await shell.openPath(CDS_DESIGN_DIR);
    return { opened: CDS_DESIGN_DIR };
  });
}

/** Electron net 모듈을 fetch 처럼 쓴다(프록시·인증서 정책을 앱이 따른다). */
async function netFetch(feedUrl: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const { net } = await import("electron");
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
  const statusCode = response.statusCode;
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    json: async () => JSON.parse(response.body),
  };
}
