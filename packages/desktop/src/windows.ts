// The planner's window: the one recipe every open path shares, the
// navigation fences that keep the tool inside its own origin, and the
// focus/reopen behaviour behind a notification click. Owns `window` and
// `url` — macOS keeps the app alive with no window, so both are nullable.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonServer } from "@colo-design/daemon/server";
import { app, BrowserWindow, dialog, screen, shell } from "electron";

const OPEN_SESSION_CHANNEL = "colodesign:open-session";
const OPEN_PROJECT_CHANNEL = "colodesign:open-project";

/** 렌더러 사망의 자동 재열기 상한(PLAN-CRASH-PROCESS 3.A 층 3 · P-4) — 10분 창에 2회. */
const RENDER_CRASH_WINDOW_MS = 10 * 60 * 1000;
const RENDER_CRASH_LIMIT = 2;

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
   * 창이 닫힐 때의 정리 — 첫 창과 reopen 이 만드는 창이 같은 몫을 받는다
   * (미리보기 페이지 주차·덮개 내리기). main.ts 가 한 번 단다.
   */
  onClosed: (() => void) | null = null;
  /**
   * 직전 렌더러 사망 기록(3.A 층 3) — 렌더러가 다음 부팅에 한 번 읽고 간다
   * (`desktop:last-renderer-crash` 다리). 읽히면 비운다.
   */
  private rendererCrash: { reason: string; at: number } | null = null;

  /** 부팅하는 렌더러에게 직전 사망을 건넨다 — 건넨 뒤에는 없던 일이 된다. */
  takeRendererCrash(): { reason: string; at: number } | null {
    const record = this.rendererCrash;
    this.rendererCrash = null;
    return record;
  }

  /**
   * 이 창의 렌더러가 죽거나 멈출 때(3.A 층 3 · P-4). 상태는 전부 데몬에
   * 있으니 회복은 다시 열기 하나다. 사망은 로그 + 자동 reload — 10분 창에
   * 상한을 넘으면 사람에게 묻는다(에이전트 되살리기의 "10분에 세 번" 과
   * 같은 결).
   */
  private watchRendererHealth(window: BrowserWindow): void {
    const contents = window.webContents;
    const crashes: number[] = [];
    // `responsive` 가 다이얼로그보다 먼저 오면 답을 무시한다 — 네이티브
    // 다이얼로그는 밖에서 닫을 수 없어서, 회복 뒤에 늦게 온 선택을 없던
    // 것으로 대신한다.
    let recovered = false;

    contents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit" || window.isDestroyed()) return;
      console.error("[renderer] gone", details.reason, details.exitCode);
      this.rendererCrash = { reason: details.reason, at: Date.now() };
      const at = Date.now();
      while (crashes.length > 0) {
        const oldest = crashes[0];
        if (oldest === undefined || at - oldest <= RENDER_CRASH_WINDOW_MS) break;
        crashes.shift();
      }
      crashes.push(at);
      if (crashes.length > RENDER_CRASH_LIMIT) {
        void dialog
          .showMessageBox({
            type: "warning",
            title: "화면이 계속 꺼져요",
            message: "화면이 10분 안에 여러 번 꺼졌어요. 다시 열면 대화와 작업은 그대로예요.",
            buttons: ["다시 열기", "끝내기"],
            defaultId: 0,
            cancelId: 0,
          })
          .then(({ response }) => {
            if (window.isDestroyed()) return;
            if (response === 0) window.webContents.reload();
            else app.quit();
          });
        return;
      }
      window.webContents.reload();
    });

    contents.on("unresponsive", () => {
      if (window.isDestroyed()) return;
      recovered = false;
      void dialog
        .showMessageBox({
          type: "question",
          title: "화면이 멈췄어요",
          message: "잠시 기다리면 저절로 돌아올 수 있어요.",
          buttons: ["기다리기", "다시 열기"],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          if (recovered || window.isDestroyed()) return;
          if (response === 1) window.webContents.reload();
        });
    });
    contents.on("responsive", () => {
      recovered = true;
    });
  }

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
        // 미리보기 무대(PreviewFrame)가 쓰는 <webview> — 이 창에만 켠다.
        // 게스트의 src·preload·파티션은 PlannerPreviewView의 펜스가 심판한다.
        webviewTag: true,
      },
    });
  }

  /** The host learns the window and the address it serves. */
  adopt(window: BrowserWindow, url: string): void {
    this.window = window;
    this.url = url;
    this.watchRendererHealth(window);
    window.on("closed", () => {
      if (this.window === window) this.window = null;
      this.onClosed?.();
    });
  }

  async reopen(): Promise<void> {
    const url = this.url;
    if (!url) return;
    const window = this.create();
    this.adopt(window, url);
    guardNavigations(window, new URL(url).origin);
    this.onCreated?.(window);
    // 데몬 포트가 죽어 loadURL 이 실패해도 호출자는 void 로 버린다 — 삼키지
    // 말고 기록해 두지 않으면 unhandled rejection 이 된다.
    await window.loadURL(url).catch((error: unknown) => {
      console.error("planner window load failed", error);
    });
    // 리뷰 B7: a notification clicked while no window existed — the renderer
    // was not mounted to hear the session id, so it rides after the load.
    if (this.pendingOpenSession) {
      const sessionId = this.pendingOpenSession;
      this.pendingOpenSession = null;
      setTimeout(() => {
        if (window.isDestroyed()) return;
        window.webContents.send(OPEN_SESSION_CHANNEL, sessionId);
      }, 1200);
    }
    if (this.pendingOpenProject) {
      const slug = this.pendingOpenProject;
      this.pendingOpenProject = null;
      setTimeout(() => {
        if (window.isDestroyed()) return;
        window.webContents.send(OPEN_PROJECT_CHANNEL, slug);
      }, 1200);
    }
  }

  /** 알림 클릭의 프로젝트 판본 — 창을 앞으로, 그 프로젝트로. */
  focusProject(slug: string): void {
    if (this.window) {
      const window = this.window;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      // focusMain 과 같은 경쟁 — 로드 중인 렌더러에는 리스너가 없으니
      // 보내도 새카맣게 사라진다. 로드가 끝난 뒤로 미룬다.
      if (window.webContents.isLoading()) {
        window.webContents.once("did-finish-load", () => {
          setTimeout(() => {
            if (window.isDestroyed()) return;
            window.webContents.send(OPEN_PROJECT_CHANNEL, slug);
          }, 1200);
        });
      } else {
        window.webContents.send(OPEN_PROJECT_CHANNEL, slug);
      }
    } else if (this.url) {
      this.pendingOpenProject = slug;
      void this.reopen();
    }
  }

  /** 알림 클릭의 공통 행동 — 창을 앞으로, 그 대화로. 창이 없으면 다시 연다. */
  focusMain(sessionId?: string): void {
    const window = this.window;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      if (sessionId) {
        // 막 만든 창(loadURL 진행 중)이나 죽었다 다시 로드 중인 렌더러에는
        // 리스너가 아직 없다 — 보내도 새카맣게 사라지니 로드가 끝난 뒤로 미룬다.
        if (window.webContents.isLoading()) {
          window.webContents.once("did-finish-load", () => {
            setTimeout(() => {
              if (window.isDestroyed()) return;
              window.webContents.send(OPEN_SESSION_CHANNEL, sessionId);
            }, 1200);
          });
        } else {
          window.webContents.send(OPEN_SESSION_CHANNEL, sessionId);
        }
      }
    } else if (this.url) {
      this.pendingOpenSession = sessionId ?? null;
      void this.reopen();
    }
  }
}
