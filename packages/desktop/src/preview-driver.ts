// 미리보기 드라이버 (PLAN D61): 게이트·넘기기·화면 캡처가 화면을 다시 보는
// 브라우저다. pane 이 화면에 있으면 캡처는 그 페이지를 그대로 찍고
// (PanePreviewDriver — 사용자와 같은 WebContents), 게이트·넘기기는 언제나
// 숨은 오프스크린 BrowserWindow 를 세운다(ElectronPreviewDriver) — 세션이
// 쓰던 화면을 다시 열면 재검증이 아니라 재방문이 된다.

import type {
  PreviewCapture,
  PreviewDriver,
  PreviewDriverFactory,
  PreviewOpenOptions,
  PreviewOpenResult,
  PreviewViewport,
} from "@colo-design/daemon/server";
import { BrowserWindow, type WebContents } from "electron";
import { VIEWPORT_METRICS } from "./emulation.js";
import type { PlannerPreviewView } from "./preview-view.js";

/**
 * 도구가 긴 변을 말하지 않을 때의 값, 그리고 인코딩 품질. 품질은 토큰 값을
 * 바꾸지 않는다 — 토큰은 픽셀 수로 매겨지고 품질은 와이어 바이트만 움직인다 —
 * 그래서 UI 의 얇은 글자가 살아남는 쪽으로 넉넉히 둔다.
 */
const CAPTURE_LONG_EDGE = 900;
const CAPTURE_QUALITY = 88;
/** 화면이 자리를 잡았는지 기다리는 한계 — 넘으면 못 잡았다고 말한다. */
const SETTLE_TIMEOUT_MS = 3000;
const SETTLE_POLL_MS = 100;

interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The CDP surface every preview driver shares: 캡처는 `Page.captureScreenshot`,
 * 콘솔은 `Runtime.consoleAPICalled`. What differs is whose webContents
 * answers — ElectronPreviewDriver owns a hidden offscreen window,
 * PanePreviewDriver drives the pane the user is looking at.
 */
abstract class CdpPreviewDriver implements PreviewDriver {
  protected readonly consoleHistory: Array<{ level: string; text: string }> = [];
  /**
   * 최근 200줄 까지 — pane 의 ring(preview-view.ts 의 20줄)과 같은 식의
   * 상한. 네 곳의 push 가 모두 여기를 거친다.
   */
  protected pushConsole(entry: { level: string; text: string }): void {
    this.consoleHistory.push(entry);
    if (this.consoleHistory.length > 200) {
      this.consoleHistory.splice(0, this.consoleHistory.length - 200);
    }
  }
  /** 이 대상에 걸린 에뮬레이션 — 같은 값을 두 번 걸지 않는다. */
  protected applied: { viewport: PreviewViewport; colorScheme: "light" | "dark" } | null = null;

  /** 대상이 살아 있고 디버거가 붙어 있게 한다 — 모든 명령의 첫걸음. */
  protected abstract ready(): Promise<void>;
  /** 명령이 향하는 webContents — 없으면 던진다. */
  protected abstract contents(): WebContents;
  /** 이 대상에 폭과 색 스킴을 건다. */
  protected abstract emulate(
    viewport: PreviewViewport,
    colorScheme: "light" | "dark",
  ): Promise<void>;
  abstract open(
    route: string,
    state: string | null,
    options?: PreviewOpenOptions,
  ): Promise<PreviewOpenResult>;
  abstract destroy(): Promise<void>;

  /** 실패한 요청만 줍는다 — 성공한 트래픽은 기록하지 않는다. */
  protected onDebuggerMessage(method: string, params: Record<string, unknown>): void {
    if (method === "Network.loadingFailed") {
      const text = typeof params.errorText === "string" ? params.errorText : "요청 실패";
      if (params.canceled === true) return;
      this.pushConsole({ level: "net", text });
      return;
    }
    if (method !== "Network.responseReceived") return;
    const response = params.response as { status?: number; url?: string } | undefined;
    const status = response?.status ?? 0;
    if (status < 400) return;
    this.pushConsole({ level: "net", text: `${status} ${response?.url ?? ""}`.trim() });
  }

  protected debugger(): Electron.Debugger {
    return this.contents().debugger;
  }

  /**
   * `loadURL` 이 끝난 것은 문서가 왔다는 뜻일 뿐이다 (PLAN D61): SPA 는 그
   * 뒤에 라우팅하고 `?state=` 를 읽는다. 문서가 완전해지고, 상태를 요청했으면
   * 그 표식(`data-state`)이 나타날 때까지 기다린다 — 못 기다리면 false 다.
   */
  protected async settle(state: string | null): Promise<boolean> {
    const selector = state ? `[data-state=${JSON.stringify(state)}]` : null;
    const probe = `(function () {
      if (document.readyState !== "complete") return false;
      const sel = ${JSON.stringify(selector)};
      return sel === null ? true : !!document.querySelector(sel);
    })()`;
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = (await this.debugger()
        .sendCommand("Runtime.evaluate", { expression: probe, returnByValue: true })
        .catch(() => null)) as { result?: { value?: unknown } } | null;
      if (result?.result?.value === true) return true;
      const poll = Promise.withResolvers<void>();
      setTimeout(poll.resolve, SETTLE_POLL_MS);
      await poll.promise;
    }
    return false;
  }

  /**
   * 한 번만 굽는다. 예전 판은 CDP 가 JPEG 로 구운 것을 `nativeImage` 로 풀어
   * 줄이고 다시 JPEG 로 구웠다 — 같은 토큰을 내고 두 세대의 압축 흔적을 받는
   * 셈이었다. 축소는 `clip.scale` 로 컴포지터가 하고, 인코딩은 그 자리에서
   * 한 번이다. 형식은 WebP: 토큰은 픽셀 수로 매겨지니 형식은 값을 바꾸지
   * 않지만, JPEG 의 크로마 서브샘플링이 UI 의 얇은 색 글자를 흐리게 만든다.
   */
  async screenshot(options?: { longEdge?: number }): Promise<PreviewCapture> {
    await this.ready();
    const longEdge = options?.longEdge ?? CAPTURE_LONG_EDGE;
    const area = await this.viewportRect();
    const scale = Math.min(1, longEdge / Math.max(area.width, area.height));
    const result = (await this.debugger().sendCommand("Page.captureScreenshot", {
      format: "webp",
      quality: CAPTURE_QUALITY,
      clip: { x: area.x, y: area.y, width: area.width, height: area.height, scale },
      captureBeyondViewport: true,
    })) as { data?: string };
    if (!result?.data) throw new Error("미리보기 화면을 캡처하지 못했습니다");
    return { data: result.data, mediaType: "image/webp" };
  }

  /**
   * 지금 보이는 만큼의 사각형. `clip` 은 페이지 좌표라서 스크롤한 만큼을
   * 더해야 한다 — 빼면 언제나 문서의 맨 위를 찍는다.
   */
  private async viewportRect(): Promise<PreviewRect> {
    const metrics = (await this.debugger().sendCommand("Page.getLayoutMetrics", {})) as {
      cssVisualViewport?: {
        pageX?: number;
        pageY?: number;
        clientWidth?: number;
        clientHeight?: number;
      };
    };
    const view = metrics.cssVisualViewport;
    const preset = VIEWPORT_METRICS[this.applied?.viewport ?? "desktop"];
    return {
      x: view?.pageX ?? 0,
      y: view?.pageY ?? 0,
      width: view?.clientWidth ?? preset.size[0],
      height: view?.clientHeight ?? preset.size[1],
    };
  }

  async consoleLines(): Promise<Array<{ level: string; text: string }>> {
    return [...this.consoleHistory];
  }
}

/**
 * 숨은 오프스크린 `BrowserWindow` 하나가 AI 전용 브라우저다. 그리기는
 * `webContents.debugger`(CDP)에게 맡긴다: 캡처는 `Page.captureScreenshot`, 콘솔은 `Runtime.consoleAPICalled`. 창은 화면에
 * 뜨지 않는다 — 보이는 창은 사용자의 것뿐이다.
 */
class ElectronPreviewDriver extends CdpPreviewDriver {
  private window: BrowserWindow | null = null;
  /** 세우는 중인 창 — 동시 호출이 창 두 개를 만들지 않게. */
  private booting: Promise<BrowserWindow> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly allowedOrigins: readonly string[] = [],
  ) {
    super();
  }

  /**
   * 창을 한 번만 세운다. 동시에 부르면 같은 부팅을 기다린다 — 창 두 개가
   * 생기면 ref 세대가 갈라진다.
   */
  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.booting ??= this.bootWindow().finally(() => {
      this.booting = null;
    });
    return this.booting;
  }

  protected async ready(): Promise<void> {
    await this.ensureWindow();
  }

  protected contents(): WebContents {
    const window = this.window;
    if (!window || window.isDestroyed()) throw new Error("미리보기 창이 닫혔습니다.");
    return window.webContents;
  }

  /**
   * 오프스크린 창은 첫 로드 전까지 렌더러가 없다 — 그 사이에 보낸
   * `Runtime`·`DOM`·`Network`·`Emulation` 명령은 **돌아오지 않는다**. 그래서
   * 창은 `about:blank` 로 먼저 태어나고, 도메인을 켠 뒤에야 도구의 손에
   * 넘어간다. 이 순서가 아니면 첫 `screen_open` 이 영원히 매달린다.
   */
  private async bootWindow(): Promise<BrowserWindow> {
    const window = new BrowserWindow({
      show: false,
      width: VIEWPORT_METRICS.desktop.size[0],
      height: VIEWPORT_METRICS.desktop.size[1],
      webPreferences: {
        offscreen: true,
        partition: "preview-claude",
        sandbox: true,
        contextIsolation: true,
      },
    });
    const contents = window.webContents;
    contents.debugger.attach("1.3");
    // 실패한 요청은 콘솔에 남지 않는다 — 빈 화면의 절반이 여기서 온다 (D61).
    contents.debugger.on("message", (_event, method, params) => {
      this.onDebuggerMessage(method, params as Record<string, unknown>);
    });
    // Electron 이 스스로 내주는 콘솔 이벤트가 제일 믿을 만하다(PLAN D69 와 같은
    // 형태) — 44 부터 첫 인자가 details { level: "info"|"warning"|"error"|"debug" }.
    contents.on("console-message", (details) => {
      this.pushConsole({ level: details.level, text: details.message });
    });
    await contents.loadURL("about:blank").catch(() => undefined);
    // consoleAPICalled 은 Runtime 도메인을 켜야 흐르고, resolveNode 는 DOM,
    // 실패한 요청은 Network 를 켜야 온다. 하나가 없어도 나머지는 산다.
    for (const domain of ["Runtime.enable", "Network.enable"]) {
      await contents.debugger.sendCommand(domain, {}).catch(() => undefined);
    }
    this.window = window;
    return window;
  }

  /**
   * 이 창에 폭과 색 스킴을 건다. 데스크톱 폭은 override 를 걷어내는 것이
   * 맞다 — 창의 제 크기가 데스크톱이다.
   */
  protected async emulate(viewport: PreviewViewport, colorScheme: "light" | "dark"): Promise<void> {
    if (this.applied?.viewport === viewport && this.applied.colorScheme === colorScheme) return;
    const dbg = this.debugger();
    const preset = VIEWPORT_METRICS[viewport];
    if (viewport === "desktop") {
      await dbg.sendCommand("Emulation.clearDeviceMetricsOverride", {}).catch(() => undefined);
    } else {
      await dbg.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: preset.size[0],
        height: preset.size[1],
        deviceScaleFactor: 2,
        mobile: preset.mobile,
      });
    }
    await dbg
      .sendCommand("Emulation.setUserAgentOverride", {
        userAgent: preset.userAgent ?? this.window?.webContents.getUserAgent() ?? "",
      })
      .catch(() => undefined);
    await dbg
      .sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: colorScheme }],
      })
      .catch(() => undefined);
    this.applied = { viewport, colorScheme };
  }

  async open(
    route: string,
    state: string | null,
    options?: PreviewOpenOptions,
  ): Promise<PreviewOpenResult> {
    let url: URL;
    try {
      url = new URL(route, this.baseUrl);
    } catch {
      return { ok: false, reason: `route 를 주소로 읽을 수 없습니다: ${route}` };
    }
    // A declared screen must stay inside the preview server (or an origin the
    // repo explicitly allowed) — an absolute route would otherwise carry this
    // hidden window (and its debugger) to an origin the repo never picked.
    // PlannerPreviewView.open checks the same thing.
    const baseOrigin = new URL(this.baseUrl).origin;
    if (url.origin !== baseOrigin && !this.allowedOrigins.includes(url.origin)) {
      return {
        ok: false,
        reason: `허용되지 않은 서버의 주소는 열지 않습니다: ${route} (${[baseOrigin, ...this.allowedOrigins].join(", ")} 안의 경로를 쓰십시오)`,
      };
    }
    if (state) url.searchParams.set("state", state);
    // 콘솔 기록과 ref 세대는 화면 이동과 함께 리셋된다.
    this.consoleHistory.length = 0;
    const window = await this.ensureWindow();
    await this.emulate(options?.viewport ?? "desktop", options?.colorScheme ?? "light");
    try {
      await window.webContents.loadURL(url.toString());
    } catch (error) {
      return {
        ok: false,
        reason: `화면을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { ok: true, settled: await this.settle(state) };
  }

  async destroy(): Promise<void> {
    const window = this.window;
    this.window = null;
    this.applied = null;
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
 * 사용자가 보는 pane 의 페이지를 그대로 drive 한다 — 에이전트와 사용자가
 * 같은 WebContents 를 본다. 창을 만들지 않는다: `driveTo` 가 pane 에게
 * 맡기면 pane 이 같은 origin 의 페이지를 재사용하거나 허용된 origin 의 새
 * 페이지를 올린다. 디버거는 페이지마다 붙였다가, 페이지가 바뀌거나 세션이
 * 끝나면 뗀다 — 사용자가 DevTools 를 열면 디버거가 떨어지고, 다음 명령이
 * 다시 붙는다.
 */
class PanePreviewDriver extends CdpPreviewDriver {
  /** 디버거가 붙어 있는 페이지 — 페이지가 바뀌면 다시 붙는다. */
  private attachedTo: WebContents | null = null;
  /**
   * The listeners `ready` hangs on the page — stored so `detachFrom` can
   * take them off. A re-attach (DevTools opened and closed) used to stack a
   * fresh `message` closure and a second `console-message` on each pass.
   */
  private readonly onDebuggerEvent = (_event: Electron.Event, method: string, params: unknown) => {
    this.onDebuggerMessage(method, params as Record<string, unknown>);
  };
  private onDestroyed: (() => void) | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly pane: () => PlannerPreviewView | null,
    private readonly allowedOrigins: readonly string[] = [],
  ) {
    super();
  }

  /**
   * pane 의 지금 페이지에 디버거를 붙인다. 페이지가 바뀌었거나(다른 origin
   * 으로 mount) 디버거가 떨어졌으면(사용자가 DevTools 를 열었다 닫음) 새로
   * 붙는다 — 붙인 뒤 도메인을 켜야 명령이 돌아온다.
   */
  protected async ready(): Promise<void> {
    const contents = this.pane()?.webContents() ?? null;
    if (!contents || contents.isDestroyed()) {
      throw new Error("미리보기 화면이 없습니다 — 화면이 보이는 상태에서 다시 시도하십시오.");
    }
    if (this.attachedTo === contents && contents.debugger.isAttached()) return;
    if (this.attachedTo && this.attachedTo !== contents) this.detachFrom(this.attachedTo);
    try {
      contents.debugger.attach("1.3");
    } catch {
      throw new Error(
        "화면의 DevTools 가 열려 있어 조작할 수 없습니다 — DevTools 를 닫으면 이어집니다.",
      );
    }
    contents.debugger.on("message", this.onDebuggerEvent);
    contents.on("console-message", this.onConsoleMessage);
    if (this.onDestroyed) contents.off("destroyed", this.onDestroyed);
    this.onDestroyed = () => {
      if (this.attachedTo === contents) this.attachedTo = null;
    };
    contents.once("destroyed", this.onDestroyed);
    for (const domain of ["Runtime.enable", "Network.enable"]) {
      await contents.debugger.sendCommand(domain, {}).catch(() => undefined);
    }
    this.attachedTo = contents;
    // 새 페이지는 에뮬레이션을 모른다 — 다음 open 이 다시 건다.
    this.applied = null;
  }

  protected contents(): WebContents {
    const contents = this.attachedTo;
    if (!contents || contents.isDestroyed()) {
      throw new Error("미리보기 화면이 없습니다 — 화면이 보이는 상태에서 다시 시도하십시오.");
    }
    return contents;
  }

  /**
   * 폭은 pane 의 에뮬레이션을 쓴다 — 사용자의 폭 토글과 같은 장치라서
   * 에이전트가 연 화면이 곧 사용자가 보는 화면이다. 색 스킴은 pane 이 모르는
   * 축이라 CDP 로 직접 건다.
   */
  protected async emulate(viewport: PreviewViewport, colorScheme: "light" | "dark"): Promise<void> {
    if (this.applied?.viewport === viewport && this.applied.colorScheme === colorScheme) return;
    this.pane()?.emulate(viewport === "desktop" ? null : viewport);
    await this.debugger()
      .sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: colorScheme }],
      })
      .catch(() => undefined);
    this.applied = { viewport, colorScheme };
  }

  async open(
    route: string,
    state: string | null,
    options?: PreviewOpenOptions,
  ): Promise<PreviewOpenResult> {
    let url: URL;
    try {
      url = new URL(route, this.baseUrl);
    } catch {
      return { ok: false, reason: `route 를 주소로 읽을 수 없습니다: ${route}` };
    }
    const baseOrigin = new URL(this.baseUrl).origin;
    if (url.origin !== baseOrigin && !this.allowedOrigins.includes(url.origin)) {
      return {
        ok: false,
        reason: `허용되지 않은 서버의 주소는 열지 않습니다: ${route} (${[baseOrigin, ...this.allowedOrigins].join(", ")} 안의 경로를 쓰십시오)`,
      };
    }
    if (state) url.searchParams.set("state", state);
    // 콘솔 기록과 ref 세대는 화면 이동과 함께 리셋된다.
    this.consoleHistory.length = 0;
    const pane = this.pane();
    if (!pane) {
      return {
        ok: false,
        reason: "미리보기 화면이 없습니다 — 화면이 보이는 상태에서 다시 시도하십시오.",
      };
    }
    await this.ready();
    await this.emulate(options?.viewport ?? "desktop", options?.colorScheme ?? "light");
    if (!(await pane.driveTo(url.toString()))) {
      return { ok: false, reason: `화면을 불러오지 못했습니다: ${url}` };
    }
    // driveTo 가 다른 origin 의 페이지를 올렸을 수 있다 — 새 페이지에 붙고
    // 에뮬레이션도 새 페이지에 건다.
    await this.ready();
    await this.emulate(options?.viewport ?? "desktop", options?.colorScheme ?? "light");
    return { ok: true, settled: await this.settle(state) };
  }

  private readonly onConsoleMessage = (
    details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
  ): void => {
    this.pushConsole({ level: details.level, text: details.message });
  };

  private detachFrom(contents: WebContents): void {
    try {
      contents.debugger.detach();
    } catch {
      // 이미 떨어져 나갔다 — 지울 게 없을 뿐이다.
    }
    contents.debugger.off("message", this.onDebuggerEvent);
    contents.off("console-message", this.onConsoleMessage);
    if (this.onDestroyed) contents.off("destroyed", this.onDestroyed);
    this.onDestroyed = null;
  }

  /** 세션이 끝나면 디버거만 뗀다 — 페이지는 사용자의 것이라 그대로 둔다. */
  async destroy(): Promise<void> {
    const contents = this.attachedTo;
    this.attachedTo = null;
    this.applied = null;
    if (contents && !contents.isDestroyed()) this.detachFrom(contents);
  }
}

/**
 * 데몬에 주입되는 드라이버 공장. 데몬은 Electron 을 모른다 — 이 모듈만이
 * 창을 만든다. 세션의 도구는 pane 을 drive 하고(`for`), 게이트·넘기기의
 * 재검증은 세션이 쓰던 화면과 무관한 숨은 창에서 돈다(`forIsolated`) —
 * 같은 인스턴스를 다시 열면 세션의 콘솔 기록과 ref 세대가 오염된다.
 */
export function createPreviewDriverFactory(
  pane: () => PlannerPreviewView | null = () => null,
): PreviewDriverFactory {
  return {
    for: (baseUrl, allowedOrigins = []) =>
      pane()?.webContents()
        ? new PanePreviewDriver(baseUrl, pane, allowedOrigins)
        : new ElectronPreviewDriver(baseUrl, allowedOrigins),
    forIsolated: (baseUrl, allowedOrigins = []) =>
      new ElectronPreviewDriver(baseUrl, allowedOrigins),
  };
}
