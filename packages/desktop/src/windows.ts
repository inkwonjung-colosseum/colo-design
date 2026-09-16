// The planner's window: the one recipe every open path shares, the
// navigation fences that keep the tool inside its own origin, and the
// focus/reopen behaviour behind a notification click. Owns `window` and
// `url` — macOS keeps the app alive with no window, so both are nullable.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonServer } from "@colo-design/daemon/server";
import { app, BrowserWindow, screen, shell } from "electron";

const OPEN_SESSION_CHANNEL = "colodesign:open-session";
const OPEN_PROJECT_CHANNEL = "colodesign:open-project";

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
export function guardNavigations(window: BrowserWindow, toolOrigin: string): void {
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

export function daemonUrl(server: DaemonServer, token: string): string {
  // 저장 포트거나 폴백이거나 — 실제로 잡힌 자리를 묻는다.
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
export function windowUrl(daemon: string): string {
  const devServer = app.isPackaged ? undefined : process.env.COLO_DESIGN_DEV_SERVER;
  if (!devServer) return daemon;
  const source = new URL(daemon);
  const target = new URL(devServer);
  target.searchParams.set("token", source.searchParams.get("token") ?? "");
  target.searchParams.set("daemon", source.host);
  return target.toString();
}

export class MainWindowHost {
  /** The one planner window, or null while none exists (mac keeps running). */
  window: BrowserWindow | null = null;
  /** 알림 클릭이 창을 되살릴 수 있도록 — macOS 는 창이 없어도 앱이 산다. */
  url: string | null = null;
  /** 창이 없을 때 도착한 "열 대화" — reopen 이 렌더러를 띄운 뒤 건넨다. */
  private pendingOpenSession: string | null = null;
  private pendingOpenProject: string | null = null;
  /**
   * Every window gets this — the close guard that asks before killing a
   * turn. main.ts wires it once; reopen'd windows need it as much as the
   * first one did.
   */
  onCreated: ((window: BrowserWindow) => void) | null = null;

  /**
   * The one window recipe, shared by boot and reopen: a window made without it
   * (the notification-click reopen used to build its own) has no preload, so
   * `coloDesignDesktop` never exists in it — the update bridge, 폴더 열기, the
   * native preview (pins, PiP, bounds) and open-session all die quietly, and
   * the title goes with them.
   */
  create(): BrowserWindow {
    // 창의 바닥: 접힌 레일(44) + 미리보기 바닥(340) + 대화 바닥(320) + 여백.
    // 이 밑으로는 그리드가 대화 열을 0까지 짜낸다(minmax(0,1fr)) — 대화는 이
    // 앱의 몸통이니 창이 대신 멈춘다. 작은 작업 영역(Sidecar·분할 화면)이
    // 바닥보다 좁으면 그 화면에 맞춘다 — 못 미치는 창보다는 잘린 창이 낫다.
    const workArea = workAreaSize();
    return new BrowserWindow({
      // 화면 작업 영역에 맞춘다 — 고정 크기는 큰 모니터에서 조그맣게 보인다.
      ...workArea,
      minWidth: Math.min(760, workArea.width),
      minHeight: Math.min(560, workArea.height),
      title: "Colo Design",
      autoHideMenuBar: true,
      webPreferences: {
        // 업데이트 확인 다리 — 이 preload 가 렌더러에 노출하는 전부다.
        preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      },
    });
  }

  /** The host learns the window and the address it serves. */
  adopt(window: BrowserWindow, url: string): void {
    this.window = window;
    this.url = url;
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
  }

  async reopen(): Promise<void> {
    const url = this.url;
    if (!url) return;
    const window = this.create();
    this.adopt(window, url);
    guardNavigations(window, new URL(url).origin);
    this.onCreated?.(window);
    await window.loadURL(url);
    // 리뷰 B7: a notification clicked while no window existed — the renderer
    // was not mounted to hear the session id, so it rides after the load.
    if (this.pendingOpenSession) {
      const sessionId = this.pendingOpenSession;
      this.pendingOpenSession = null;
      setTimeout(() => window.webContents.send(OPEN_SESSION_CHANNEL, sessionId), 1200);
    }
    if (this.pendingOpenProject) {
      const slug = this.pendingOpenProject;
      this.pendingOpenProject = null;
      setTimeout(() => window.webContents.send(OPEN_PROJECT_CHANNEL, slug), 1200);
    }
  }

  /** 알림 클릭의 프로젝트 판본 — 창을 앞으로, 그 프로젝트로. */
  focusProject(slug: string): void {
    if (this.window) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      this.window.webContents.send(OPEN_PROJECT_CHANNEL, slug);
    } else if (this.url) {
      this.pendingOpenProject = slug;
      void this.reopen();
    }
  }

  /** 알림 클릭의 공통 행동 — 창을 앞으로, 그 대화로. 창이 없으면 다시 연다. */
  focusMain(sessionId?: string): void {
    if (this.window) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      if (sessionId) this.window.webContents.send(OPEN_SESSION_CHANNEL, sessionId);
    } else if (this.url) {
      this.pendingOpenSession = sessionId ?? null;
      void this.reopen();
    }
  }
}
