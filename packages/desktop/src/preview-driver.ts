// 미리보기 드라이버 (PLAN D61): 게이트·넘기기·화면 캡처가 화면을 다시 보는
// 브라우저다. 게이트·넘기기는 언제나 숨은 오프스크린 BrowserWindow 를 세운다
// (ElectronPreviewDriver) — 세션이 쓰던 화면을 다시 열면 재검증이 아니라
// 재방문이 된다. pane 이 화면에 있으면 화면 캡처는 그 탭을 그대로 찍는데
// (PaneCaptureDriver), 이제 그 경로는 에이전트의 PaneBrowserDriver 를 그대로
// 경유한다 — 탭마다 디버거를 붙이는 손은 하나뿐이어야 한다(§3 규칙 10).
//
// 인앱 브라우저 2단계(계획 §4-2): PaneBrowserDriver 는 사용자와 에이전트가
// 같은 탭을 쓰는 브라우저다. 07bd3bf 의 PanePreviewDriver 에서 접근성 트리
// (ref 세대)·ref 액션·actionability·settle 을 이식했고, 1단계 탭 모델 위에
// tabId 주소를 얹었다 — tabId 생략은 언제나 활성 탭이다.

import type {
  BrowserDriver,
  BrowserDriverFactory,
  PreviewAxNode,
  PreviewCapture,
  PreviewConsoleLine,
  PreviewDriver,
  PreviewDriverFactory,
  PreviewOpenOptions,
  PreviewOpenResult,
  PreviewViewport,
} from "@colo-design/daemon/server";
import type { PreviewTabMeta } from "@colo-design/protocol";
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
/** 탭별 콘솔 링의 상한 — 게이트 드라이버의 200줄과 같은 크기. */
const BROWSER_CONSOLE_RING = 200;

interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * The CDP surface the gate's preview driver uses: 캡처는 `Page.captureScreenshot`,
 * 콘솔은 `Runtime.consoleAPICalled`. The pane's own driving lives in
 * PaneBrowserDriver below — the gate's window stays the hidden one.
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

// ---------------------------------------------------------------------------
// 인앱 브라우저 (계획 §4-2): PaneBrowserDriver — 사용자와 에이전트가 같은 탭을
// 쓰는 브라우저. 아래 상수·함수·클래스의 뼈대는 07bd3bf 의 preview-driver.ts
// (PanePreviewDriver, ~907줄 판)에서 이식했다 — 그때의 pane 은 페이지 하나였고,
// 지금은 탭 모델(1단계) 위라 탭별 상태(TabState)와 tabId 주소가 덧붙었다.
// ---------------------------------------------------------------------------

/** 접근성 트리에서 건너뛰지만 아이들은 살리는 역할. (07bd3bf 이식) */
const AX_SKIP_ROLES: Record<string, true> = { InlineTextBox: true, IframePresentational: true };
/** 노드가 스스로 말하지 않는 것들 — 상태로 뽑아 올린다. (07bd3bf 이식) */
const AX_STATE_PROPERTIES: Record<string, true> = {
  disabled: true,
  checked: true,
  expanded: true,
  focused: true,
  required: true,
  selected: true,
  pressed: true,
  invalid: true,
  readonly: true,
};
/** `press` 의 키 → CDP 키 이벤트. 화이트리스트는 도구가 지킨다. (07bd3bf 이식) */
const PRESS_KEY_CODES: Record<string, { code: string; key: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", key: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", key: "Escape", vk: 27 },
  Tab: { code: "Tab", key: "Tab", vk: 9, text: "\t" },
  Backspace: { code: "Backspace", key: "Backspace", vk: 8 },
  Delete: { code: "Delete", key: "Delete", vk: 46 },
  Space: { code: "Space", key: " ", vk: 32, text: " " },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", vk: 39 },
};

/** (07bd3bf 이식) 요소를 화면 가운데로 올리고 그 시점의 뷰포트 rect 를 돌려주는 함수. */
const RECT_OF_SELF = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}`;

/**
 * (07bd3bf 이식) 누를 수 있는 rect 를 돌려주는 함수 — 누르기·입력·hover 가
 * 쓴다. 요소가 자리를 잡을 때까지(두 프레임 연속 같은 rect) 기다리고,
 * disabled·가려짐도 본다. 기다리는 이유: rect 하나만 보고 바로 쏘면
 * 애니메이션 중인 요소를 누르는 flaky click 이 된다. 2초 안에 못 누르면
 * 사유를 돌려준다 — 도구가 그 말을 그대로 모델에게 전한다.
 */
const ACTIONABLE_RECT_OF_SELF = `async function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return { error: "detached" };
  const deadline = Date.now() + 2000;
  let last = null;
  while (Date.now() < deadline) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      last = "invisible";
    } else if (el.disabled === true || el.getAttribute("aria-disabled") === "true") {
      last = "disabled";
    } else if (getComputedStyle(el).pointerEvents === "none") {
      last = "inert";
    } else {
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (top !== null && top !== el && !el.contains(top)) {
        last = "covered";
      } else {
        const settled = Promise.withResolvers();
        // A covered or hidden view never paints — rAF would wait forever and
        // the deadline would never be seen, so the frame pair races a timer.
        const rafTimer = setTimeout(() => settled.resolve(null), 500);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(rafTimer);
            const again = el.getBoundingClientRect();
            settled.resolve(
              again.x === r.x && again.y === r.y &&
              again.width === r.width && again.height === r.height);
          }));
        if (await settled.promise) {
          return { rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        }
        last = "moving";
      }
    }
    const pause = Promise.withResolvers();
    setTimeout(pause.resolve, 100);
    await pause.promise;
  }
  return { error: last ?? "invisible" };
}`;

/** evaluate 반환의 JSON 한도(계획 §4-2) — 모델의 눈 크기이자 실수의 폭탄 한도. */
const BROWSER_EVALUATE_JSON_LIMIT = 8 * 1024;
/** waitFor 의 기본 예산과 폭 (계획 §4-2: 폴링 100ms, 기본 5s). */
const BROWSER_WAIT_TIMEOUT_MS = 5000;
const BROWSER_WAIT_POLL_MS = 100;
/** 탭별 콘솔 링의 상한 — 게이트 드라이버의 200줄과 같은 식이다. */

/** url 의 origin — 파싱이 안 되면 "" (던지지 않는다). 뷰의 safeOrigin 과 같은 모양. */
function browserOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** http(s) 인가 — 에이전트의 브라우저가 열 수 있는 유일한 스킴. */
function browserHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** (07bd3bf 이식) Chromium 이 돌려주는 접근성 노드 — 쓰는 부분만 적는다. */
interface CdpAxNode {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  childIds?: string[];
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
}

/**
 * 한 탭에 대해 이 드라이버가 아는 것. `refs` 는 지금 세대의 ref → backend 노드
 * 번호(스냅샷이 비우고 다시 채우고, 이동이 지운다), `console` 은 붙어 있는
 * 동안 모은 링. `contents` 는 리스너가 걸려 있는 WebContents — 탭이 버려졌다
 * 되살아나면 같은 tabId 로 새 WebContents 가 태어나므로, 그때 리스너와 ref
 * 세대를 갈아엎는다. `handlers` 는 붙인 리스너들 — 뗄 때 같은 참조로 지운다.
 */
interface TabState {
  readonly refs: Map<string, number>;
  readonly console: PreviewConsoleLine[];
  contents: WebContents | null;
  handlers: {
    onDebuggerMessage: (event: Electron.Event, method: string, params: unknown) => void;
    onConsoleMessage: (
      details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
    ) => void;
    onDidNavigate: (event: Electron.Event, url: string) => void;
    onGone: () => void;
  } | null;
}

/**
 * 사용자가 보는 pane 의 탭을 그대로 drive 한다 — 에이전트와 사용자가 같은
 * WebContents 를 본다. 창을 만들지 않는다: 탭의 생성·전환·닫기는 전부 뷰의
 * 장치(openTab·activateTab·closeTab)를 빌린다. 디버거는 탭의 WebContents 마다
 * 붙였다가, 탭이 죽거나 드라이버가 끝나면 뗀다 — 사용자가 DevTools 를 열면
 * 붙임이 떨어지고, 다음 명령이 다시 붙는다. (07bd3bf PanePreviewDriver 계승)
 *
 * 주소는 ref 다 (PLAN D61): `snapshot` 이 걸어간 노드마다 `e12` 를 붙이고
 * backend 노드 번호를 기억한다. 다음 스냅샷과 이동이 세대를 갈아치우므로,
 * 낡은 ref 는 "다시 읽으십시오" 라는 오류가 된다 — 엉뚱한 곳을 누르는 일은
 * 없다. 액션 메서드는 성공의 답으로 새 스냅샷을 돌려준다 — 세대 갱신 겸용.
 */
class PaneBrowserDriver implements BrowserDriver {
  /** 탭별 상태 — 탭이 닫히면(또는 WebContents 가 죽으면) 비운다. */
  private readonly tabs = new Map<string, TabState>();

  constructor(private readonly pane: () => PlannerPreviewView | null) {}

  // ── 대상 해석과 붙임 ──────────────────────────────────────────

  /** pane 이 살아 있는 동안만 — 없으면 도구 오류다. 숨은 창 폴백은 이 계약에 없다. */
  private view(): PlannerPreviewView {
    const pane = this.pane();
    if (!pane) {
      throw new Error("미리보기 화면이 없습니다 — 화면이 보이는 상태에서 다시 시도하십시오.");
    }
    return pane;
  }

  /**
   * 명령이 향하는 탭 한 벌(id, WebContents, 상태). tabId 생략은 활성 탭이다
   * (계약). 다른 탭을 지명하면 먼저 화면에 세운다 — 공유 브라우저라 에이전트가
   * 보는 탭이 곧 사용자의 화면이다. 죽은 id 는 오류로 돌아간다. 붙임(디버거)
   * 은 모든 명령의 첫걸음 — 07bd3bf 의 ready() 가 그랬던 것처럼.
   */
  private async target(
    tabId?: string,
  ): Promise<{ tabId: string; contents: WebContents; state: TabState }> {
    const pane = this.view();
    const id = tabId ?? pane.getActiveTabId();
    if (id === null) {
      throw new Error("열려 있는 탭이 없습니다 — openTab 으로 먼저 탭을 여십시오.");
    }
    if (id !== pane.getActiveTabId()) {
      pane.activateTab(id);
      if (pane.getActiveTabId() !== id) throw new Error(`그런 탭이 없습니다: ${id}`);
    }
    const contents = pane.webContents();
    if (!contents) {
      throw new Error("미리보기 화면이 없습니다 — 화면이 보이는 상태에서 다시 시도하십시오.");
    }
    const state = this.stateOf(id, contents);
    await this.attach(contents);
    return { tabId: id, contents, state };
  }

  /**
   * 탭의 상태를 내용물에 맞춘다. 되살림(discard 후 activate)은 같은 tabId 로
   * 새 WebContents 를 낳는다 — 문서가 갈아엎어졌으니 리스너도 ref 세대도 새로
   * 단다.
   */
  private stateOf(tabId: string, contents: WebContents): TabState {
    let entry = this.tabs.get(tabId);
    if (!entry) {
      entry = { refs: new Map(), console: [], contents: null, handlers: null };
      this.tabs.set(tabId, entry);
    }
    const state: TabState = entry;
    if (state.contents === contents) return state;
    this.unbind(state);
    state.refs.clear();
    state.contents = contents;
    state.handlers = {
      onDebuggerMessage: (_event, method, params) =>
        this.handleDebuggerMessage(state, contents, method, params as Record<string, unknown>),
      onConsoleMessage: (details) =>
        this.noteConsole(state, { level: details.level, text: details.message }),
      // 이동은 ref 세대의 죽음이다 — 옛 문서의 backend 노드 번호가 새 문서를
      // 가리킬 수는 없다. 드라이버가 navigate 하든 사용자가 누르든 같은 길이다.
      onDidNavigate: () => state.refs.clear(),
      onGone: () => this.drop(tabId),
    };
    contents.debugger.on("message", state.handlers.onDebuggerMessage);
    contents.on("console-message", state.handlers.onConsoleMessage);
    contents.on("did-navigate", state.handlers.onDidNavigate);
    contents.once("destroyed", state.handlers.onGone);
    return state;
  }

  /**
   * 디버거를 붙인다 — 이미 붙어 있으면 아무것도 하지 않는다. 붙임의 소유자는
   * 이 드라이버 하나뿐이다(§3 규칙 10): preview.capture 도 이 인스턴스를
   * 경유하므로, 여기서 실패한다는 것은 사용자의 DevTools 가 열려 있다는
   * 뜻이다 — 도구가 그 말을 그대로 모델에게 전한다. (07bd3bf 이식)
   */
  private async attach(contents: WebContents): Promise<void> {
    if (contents.debugger.isAttached()) return;
    try {
      contents.debugger.attach("1.3");
    } catch {
      throw new Error(
        "화면의 DevTools 가 열려 있어 조작할 수 없습니다 — DevTools 를 닫으면 이어집니다.",
      );
    }
    // consoleAPICalled 은 Runtime 을, resolveNode 는 DOM 을, 실패한 요청은
    // Network 를, 다이얼로그는 Page 를 켜야 온다. 하나가 없어도 나머지는 산다.
    for (const domain of ["Runtime.enable", "DOM.enable", "Network.enable", "Page.enable"]) {
      await contents.debugger.sendCommand(domain, {}).catch(() => undefined);
    }
  }

  /** 디버거 이벤트의 갈래길 — 다이얼로그 처리와 실패한 네트워크 수집. */
  private handleDebuggerMessage(
    state: TabState,
    contents: WebContents,
    method: string,
    params: Record<string, unknown>,
  ): void {
    // 다이얼로그 자동 처리(계획 §4-2): alert 은 수락, confirm·prompt·
    // beforeunload 는 거절 — 아무도 대답하지 않으면 페이지가 영원히 멈춘다.
    // 대답은 콘솔에 보고해 모델이 읽을 수 있게 한다.
    if (method === "Page.javascriptDialogOpening") {
      const type = typeof params.type === "string" ? params.type : "alert";
      const message = typeof params.message === "string" ? params.message : "";
      const accept = type === "alert";
      void contents.debugger
        .sendCommand("Page.handleJavaScriptDialog", { accept })
        .catch(() => undefined);
      this.noteConsole(state, {
        level: "dialog",
        text: `${type}: ${message} — ${accept ? "수락" : "거절"}`,
      });
      return;
    }
    // (07bd3bf 이식) 실패한 요청만 줍는다 — 성공한 트래픽은 기록하지 않는다.
    if (method === "Network.loadingFailed") {
      const text = typeof params.errorText === "string" ? params.errorText : "요청 실패";
      if (params.canceled === true) return;
      this.noteConsole(state, { level: "net", text });
      return;
    }
    if (method !== "Network.responseReceived") return;
    const response = params.response as { status?: number; url?: string } | undefined;
    const status = response?.status ?? 0;
    if (status < 400) return;
    this.noteConsole(state, { level: "net", text: `${status} ${response?.url ?? ""}`.trim() });
  }

  /** 탭의 콘솔 링 한 줄 — 링은 200줄로 bound 된다(게이트 드라이버와 같은 상한). */
  private noteConsole(state: TabState, entry: PreviewConsoleLine): void {
    state.console.push(entry);
    if (state.console.length > BROWSER_CONSOLE_RING) {
      state.console.splice(0, state.console.length - BROWSER_CONSOLE_RING);
    }
  }

  /** 탭 상태를 통째로 버린다 — 탭이 닫혔거나 WebContents 가 죽었을 때. */
  private drop(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    this.unbind(state);
    this.tabs.delete(tabId);
  }

  /** 리스너만 내린다 — 콘솔·ref 는 살려 둔다(다음 붙임이 이어 쓴다). */
  private unbind(state: TabState): void {
    const contents = state.contents;
    const handlers = state.handlers;
    state.contents = null;
    state.handlers = null;
    if (!contents || contents.isDestroyed() || !handlers) return;
    try {
      contents.debugger.off("message", handlers.onDebuggerMessage);
    } catch {
      // 창이 닫히는 중이다 — 지울 게 없을 뿐이다.
    }
    contents.off("console-message", handlers.onConsoleMessage);
    contents.off("did-navigate", handlers.onDidNavigate);
    contents.off("destroyed", handlers.onGone);
  }

  /**
   * 디버거까지 뗀다 — 완전한 뒷정리(destroy) 또는 캡처의 뒷수습. 페이지는
   * 사용자의 것이라 그대로 둔다. (07bd3bf PanePreviewDriver.destroy 계승)
   */
  private release(tabId: string): void {
    const state = this.tabs.get(tabId);
    if (!state) return;
    const contents = state.contents;
    this.unbind(state);
    if (contents && !contents.isDestroyed() && contents.debugger.isAttached()) {
      try {
        contents.debugger.detach();
      } catch {
        // 이미 떨어져 나갔다 — 지울 게 없을 뿐이다.
      }
    }
  }

  // ── 탭 ───────────────────────────────────────────────────────

  async listTabs(): Promise<PreviewTabMeta[]> {
    return this.view().listTabs();
  }

  async getActiveTabId(): Promise<string | null> {
    return this.view().getActiveTabId();
  }

  async openTab(
    url: string,
    opts?: { background?: boolean },
  ): Promise<{ tabId: string; settled: boolean }> {
    if (!browserHttpUrl(url)) throw new Error(`http(s) 주소만 열 수 있습니다: ${url}`);
    const pane = this.view();
    const before = new Set(pane.listTabs().map((tab) => tab.id));
    const activeBefore = pane.getActiveTabId();
    // pane 의 openTab 이 판단한다 — repo origin 은 mount 경로로 위임(기존 탭
    // 재사용), 그 밖의 http(s) 는 새 web 탭, 슬롯이 없으면 OS 폴백(아래에서
    // 탭이 생기지 않았다는 것으로 잡힌다).
    pane.openTab(url);
    const after = pane.listTabs();
    const created = after.find((tab) => !before.has(tab.id));
    let tabId: string | null;
    if (created) {
      tabId = created.id;
    } else {
      // 새 탭이 없으면 기존 탭을 데워 쓴 경우(repo origin 은 mount 경로로
      // 위임된다)다 — 같은 origin 의 탭이 그 증거다.
      const origin = browserOrigin(url);
      tabId =
        after.find((tab) => tab.url !== null && browserOrigin(tab.url) === origin)?.id ?? null;
    }
    if (tabId === null) {
      // 슬롯이 없어 OS 로 넘겨졌거나 가드에 걸렸다 — 에이전트에게는 실패다.
      throw new Error(`탭을 열지 못했습니다: ${url}`);
    }
    if (opts?.background === true && activeBefore !== null && activeBefore !== tabId) {
      // 백그라운드 요청 — 열어 둔 탭을 다시 뒤로 보낸다. park 은 WebContents 를
      // 살려 두므로 탭은 숨은 채 로드를 끝낸다. 화면을 다녀온 사이 정산할 방법이
      // 없으므로 settled 은 false 로 답한다 — 다음 명령이 다시 본다.
      pane.activateTab(activeBefore);
      return { tabId, settled: false };
    }
    const dest = await this.target(tabId);
    return { tabId, settled: await this.settleOn(dest.contents, null) };
  }

  async closeTab(tabId?: string): Promise<void> {
    const pane = this.view();
    const id = tabId ?? pane.getActiveTabId();
    pane.closeTab(tabId);
    // 뷰가 WebContents 를 파기한다 — destroyed 리스너가 상태를 비우지만, 활성
    // 생략의 경우 어느 id 가 죽었는지 여기서 확실히 계산해 둔다.
    if (typeof id === "string") this.drop(id);
  }

  async activateTab(tabId: string): Promise<void> {
    const pane = this.view();
    pane.activateTab(tabId);
    if (pane.getActiveTabId() !== tabId) throw new Error(`그런 탭이 없습니다: ${tabId}`);
  }

  async cycleActiveTab(delta: -1 | 1): Promise<void> {
    this.view().cycleActiveTab(delta);
  }

  async navigate(url: string, tabId?: string): Promise<{ settled: boolean }> {
    if (!browserHttpUrl(url)) throw new Error(`http(s) 주소만 탐색할 수 있습니다: ${url}`);
    const dest = await this.target(tabId);
    try {
      await dest.contents.loadURL(url);
    } catch (error) {
      throw new Error(
        `화면을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { settled: await this.settleOn(dest.contents, null) };
  }

  async back(tabId?: string): Promise<void> {
    (await this.target(tabId)).contents.navigationHistory.goBack();
  }

  async forward(tabId?: string): Promise<void> {
    (await this.target(tabId)).contents.navigationHistory.goForward();
  }

  // ── 읽기 ─────────────────────────────────────────────────────

  async snapshot(tabId?: string): Promise<PreviewAxNode[]> {
    const dest = await this.target(tabId);
    return this.axTree(dest.contents, dest.state);
  }

  /**
   * (07bd3bf 이식) 접근성 트리를 계층 그대로 돌려주고, 그 자리에서 ref 를 새로
   * 발급한다 — 이 호출이 곧 ref 의 세대다. 이름 없는 구조 노드까지 그대로
   * 담고, 무엇을 접을지는 도구가 정한다.
   */
  private async axTree(contents: WebContents, state: TabState): Promise<PreviewAxNode[]> {
    const result = (await contents.debugger.sendCommand("Accessibility.getFullAXTree", {})) as {
      nodes?: CdpAxNode[];
    };
    const nodes = result.nodes ?? [];
    const byId = new Map<string, CdpAxNode>();
    const childOf = new Set<string>();
    for (const node of nodes) byId.set(node.nodeId, node);
    for (const node of nodes) for (const child of node.childIds ?? []) childOf.add(child);

    state.refs.clear();
    let minted = 0;
    const build = (ids: string[]): PreviewAxNode[] => {
      const out: PreviewAxNode[] = [];
      for (const id of ids) {
        const node = byId.get(id);
        if (!node) continue;
        const role = typeof node.role?.value === "string" ? node.role.value : "";
        const children = build(node.childIds ?? []);
        // 무시된 노드와 텍스트 조각은 자리만 차지한다 — 아이들만 올린다.
        if (node.ignored === true || AX_SKIP_ROLES[role] === true || role === "") {
          out.push(...children);
          continue;
        }
        const states: string[] = [];
        for (const property of node.properties ?? []) {
          if (!property.name || AX_STATE_PROPERTIES[property.name] !== true) continue;
          const value = property.value?.value;
          if (value === false || value === "false" || value === undefined) continue;
          states.push(value === true ? property.name : `${property.name}=${String(value)}`);
        }
        const rawValue = node.value?.value;
        const backendId = node.backendDOMNodeId;
        let ref = "";
        if (backendId !== undefined) {
          minted += 1;
          ref = `e${minted}`;
          state.refs.set(ref, backendId);
        }
        out.push({
          ref,
          role,
          name: typeof node.name?.value === "string" ? node.name.value.trim() : "",
          ...(rawValue === undefined || rawValue === "" ? {} : { value: String(rawValue) }),
          states,
          children,
        });
      }
      return out;
    };
    const roots = nodes.filter((node) => !childOf.has(node.nodeId)).map((node) => node.nodeId);
    return build(roots);
  }

  /**
   * (07bd3bf 이식) 한 번만 굽는다. 예전 판은 CDP 가 JPEG 로 구운 것을
   * `nativeImage` 로 풀어 줄이고 다시 JPEG 로 구웠다 — 같은 토큰을 내고 두
   * 세대의 압축 흔적을 받는 셈이었다. 축소는 `clip.scale` 로 컴포지터가 하고,
   * 인코딩은 그 자리에서 한 번이다. 형식은 WebP: 토큰은 픽셀 수로 매겨지니
   * 형식은 값을 바꾸지 않지만, JPEG 의 크로마 서브샘플링이 UI 의 얇은 색
   * 글자를 흐리게 만든다.
   */
  async screenshot(opts?: {
    tabId?: string;
    ref?: string;
    longEdge?: number;
  }): Promise<PreviewCapture> {
    const dest = await this.target(opts?.tabId);
    const longEdge = opts?.longEdge ?? CAPTURE_LONG_EDGE;
    const area = opts?.ref
      ? await this.rectOfRef(dest.contents, dest.state, opts.ref)
      : await this.viewportRect(dest.contents);
    const scale = Math.min(1, longEdge / Math.max(area.width, area.height));
    const result = (await dest.contents.debugger.sendCommand("Page.captureScreenshot", {
      format: "webp",
      quality: CAPTURE_QUALITY,
      clip: { x: area.x, y: area.y, width: area.width, height: area.height, scale },
      captureBeyondViewport: true,
    })) as { data?: string };
    if (!result?.data) throw new Error("미리보기 화면을 캡처하지 못했습니다");
    return { data: result.data, mediaType: "image/webp" };
  }

  /**
   * (07bd3bf 이식) 지금 보이는 만큼의 사각형. `clip` 은 페이지 좌표라서
   * 스크롤한 만큼을 더해야 한다 — 빼면 언제나 문서의 맨 위를 찍는다. 폭은
   * pane 의 것 — 사용자의 폭 토글과 같은 장치라 에이전트가 보는 화면이 곧
   * 사용자의 화면이다.
   */
  private async viewportRect(contents: WebContents): Promise<PreviewRect> {
    const metrics = (await contents.debugger.sendCommand("Page.getLayoutMetrics", {})) as {
      cssVisualViewport?: {
        pageX?: number;
        pageY?: number;
        clientWidth?: number;
        clientHeight?: number;
      };
    };
    const view = metrics.cssVisualViewport;
    const preset = VIEWPORT_METRICS.desktop;
    return {
      x: view?.pageX ?? 0,
      y: view?.pageY ?? 0,
      width: view?.clientWidth ?? preset.size[0],
      height: view?.clientHeight ?? preset.size[1],
    };
  }

  /** 탭이 말한 것들 — 붙어 있는 동안 모은다. 읽기가 붙임을 일으키지 않는다:
   *  한 번도 만진 적 없는 탭의 목록은 텅 비어 있다. (링은 200줄.) */
  async consoleLines(tabId?: string): Promise<PreviewConsoleLine[]> {
    const pane = this.view();
    const id = tabId ?? pane.getActiveTabId();
    if (id === null) return [];
    return [...(this.tabs.get(id)?.console ?? [])];
  }

  /**
   * 페이지의 세계에서 함수를 돌린다 — `fn` 은 함수 한 개의 소스다. 반환은 값으로
   * 돌아오며(비동기면 기다린다), JSON 8KB 를 넘는 답은 오류다(계획 §4-2) —
   * 잘린 덩어리를 모델이 읽게 하는 것보다 더 좁게 물어보게 하는 편이 낫다.
   */
  async evaluate(fn: string, tabId?: string): Promise<unknown> {
    const dest = await this.target(tabId);
    const result = (await dest.contents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(${fn})()`,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string; value?: unknown } };
    };
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception;
      throw new Error(
        `페이지의 함수가 던졌습니다: ${typeof detail?.value === "string" ? detail.value : (detail?.description ?? "알 수 없는 오류")}`,
      );
    }
    const value = result.result?.value;
    if (value === undefined || value === null) return value;
    let json: string;
    try {
      json = JSON.stringify(value) ?? "";
    } catch {
      throw new Error("반환값을 JSON 으로 만들 수 없습니다 — 값만 돌려주십시오.");
    }
    if (json.length > BROWSER_EVALUATE_JSON_LIMIT) {
      throw new Error(
        `반환값이 JSON ${BROWSER_EVALUATE_JSON_LIMIT}B 를 넘습니다 (${json.length}B) — 더 좁게 물으십시오.`,
      );
    }
    return value;
  }

  /**
   * 기다림 — text 는 본문 글자로, url 은 지금 주소의 앞부분으로 본다. 둘 다
   * 주어지면 둘 다를 본다. (계획 §4-2: 폴링 100ms, 기본 예산 5s.)
   */
  async waitFor(
    target: { text?: string; url?: string; ms?: number },
    tabId?: string,
  ): Promise<boolean> {
    const dest = await this.target(tabId);
    const budget =
      typeof target.ms === "number" && target.ms >= 0 ? target.ms : BROWSER_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + budget;
    const url = target.url;
    const textProbe =
      target.text === undefined
        ? null
        : `(function () {
            const body = document.body;
            return body !== null && body.innerText.indexOf(${JSON.stringify(target.text)}) !== -1;
          })()`;
    for (;;) {
      let ok = true;
      if (ok && url !== undefined) ok = dest.contents.getURL().startsWith(url);
      if (ok && textProbe !== null) {
        const result = (await dest.contents.debugger
          .sendCommand("Runtime.evaluate", { expression: textProbe, returnByValue: true })
          .catch(() => null)) as { result?: { value?: unknown } } | null;
        ok = result?.result?.value === true;
      }
      if (ok) return true;
      if (Date.now() >= deadline) return false;
      const poll = Promise.withResolvers<void>();
      setTimeout(poll.resolve, BROWSER_WAIT_POLL_MS);
      await poll.promise;
    }
  }

  // ── 액션 — 성공의 답은 언제나 새 스냅샷이다(계약: ref 세대 갱신 겸용) ────

  async click(target: { ref: string }, tabId?: string): Promise<PreviewAxNode[]> {
    const dest = await this.target(tabId);
    this.wake(dest.contents);
    await this.clickRect(
      dest.contents,
      await this.rectOfRef(dest.contents, dest.state, target.ref, true),
    );
    return this.axTree(dest.contents, dest.state);
  }

  async type(
    input: { ref: string; text: string; clear?: boolean },
    tabId?: string,
  ): Promise<PreviewAxNode[]> {
    const dest = await this.target(tabId);
    this.wake(dest.contents);
    const dbg = dest.contents.debugger;
    // 입력의 첫걸음은 클릭이다 — 포커스가 흐르는 유일한 자연스러운 길이다.
    await this.clickRect(
      dest.contents,
      await this.rectOfRef(dest.contents, dest.state, input.ref, true),
    );
    if (input.clear === true) {
      // (07bd3bf 이식) 있던 값을 지운다: 선택 후 덮어쓰기 — 프레임워크의
      // onChange 가 흐르는 유일한 길이다(값을 직접 넣으면 React 는 모른다).
      const modifiers = process.platform === "darwin" ? 4 : 2;
      for (const type of ["rawKeyDown", "keyUp"]) {
        await dbg.sendCommand("Input.dispatchKeyEvent", {
          type,
          modifiers,
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
        });
      }
    }
    await dbg.sendCommand("Input.insertText", { text: input.text });
    return this.axTree(dest.contents, dest.state);
  }

  async press(key: string, tabId?: string): Promise<PreviewAxNode[]> {
    const dest = await this.target(tabId);
    const mapped = PRESS_KEY_CODES[key];
    if (!mapped) throw new Error(`보낼 수 없는 키입니다: ${key}`);
    const dbg = dest.contents.debugger;
    await dbg.sendCommand("Input.dispatchKeyEvent", {
      type: mapped.text ? "keyDown" : "rawKeyDown",
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.vk,
      ...(mapped.text ? { text: mapped.text } : {}),
    });
    await dbg.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.vk,
    });
    return this.axTree(dest.contents, dest.state);
  }

  async scroll(target: { ref?: string; dy: number }, tabId?: string): Promise<PreviewAxNode[]> {
    const dest = await this.target(tabId);
    // (07bd3bf 이식) ref 만 주면 "보이게 해 달라"는 뜻이다 — rect 를 받는 것
    // 자체가 그 일이다.
    const rect = target.ref ? await this.rectOfRef(dest.contents, dest.state, target.ref) : null;
    if (target.dy !== 0) {
      await dest.contents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: rect ? rect.x + rect.width / 2 : VIEWPORT_METRICS.desktop.size[0] / 2,
        y: rect ? rect.y + rect.height / 2 : VIEWPORT_METRICS.desktop.size[1] / 2,
        deltaX: 0,
        deltaY: target.dy,
      });
    }
    return this.axTree(dest.contents, dest.state);
  }

  async hover(target: { ref: string }, tabId?: string): Promise<PreviewAxNode[]> {
    const dest = await this.target(tabId);
    const rect = await this.rectOfRef(dest.contents, dest.state, target.ref, true);
    await dest.contents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      button: "none",
    });
    return this.axTree(dest.contents, dest.state);
  }

  /**
   * `<select>` 의 값 바꾸기 — 마우스 이벤트의 목록 펼침은 OS 위젯이라 CDP 가
   * 못 만지므로, 네이티브 setter 로 값을 넣고 input·change 를 흘린다. 직접
   * 대입이 아니라 setter 를 거치는 이유는 type 의 clear 와 같다: React 의
   * onChange 는 setter 를 통해서만 흐른다.
   */
  async select(target: { ref: string; value: string }, tabId?: string): Promise<PreviewAxNode[]> {
    const dest = await this.target(tabId);
    this.wake(dest.contents);
    const backendNodeId = dest.state.refs.get(target.ref);
    if (backendNodeId === undefined) {
      throw new Error(
        `${target.ref} 는 지금 화면의 것이 아닙니다 — snapshot 으로 다시 읽으십시오.`,
      );
    }
    const objectId = await this.resolveNode(dest.contents, target.ref, backendNodeId);
    const result = (await dest.contents.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function (value) {
        let el = this.nodeType === 1 ? this : this.parentElement;
        // AX 노드는 select 안의 option·텍스트, 또는 Chromium 이 select 를
        // 그리는 UA shadow DOM 의 내부 div 를 가리킬 수 있다 — closest 는
        // shadow 경계를 못 넘으므로 getRootNode().host 까지 본다.
        if (!(el instanceof HTMLSelectElement)) {
          const root = el?.getRootNode?.();
          el = el?.closest?.("select")
            ?? (root instanceof ShadowRoot ? root.host : null)
            ?? (el instanceof HTMLLabelElement ? el.control : null);
        }
        if (!(el instanceof HTMLSelectElement)) return { error: "not-select", tag: this.nodeType + ":" + (this.tagName ?? this.nodeName ?? "?") };
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { picked: el.value };
      }`,
      arguments: [{ value: target.value }],
      returnByValue: true,
    })) as { result?: { value?: { error?: string; picked?: string; tag?: string } } };
    const value = result.result?.value;
    if (value?.error === "not-select") {
      throw new Error(`${target.ref} 은 select 요소가 아닙니다. (${value.tag ?? "?"})`);
    }
    if (value?.picked !== target.value) {
      // 값이 그대로면 그 option 이 없었다 — select 는 없는 값의 대입을 조용히
      // 무시한다. 조용한 성공은 모델이 값을 바꿨다고 믿게 만드므로 오류로 막는다.
      throw new Error(`${target.ref} 에 그런 option 이 없습니다: ${target.value}`);
    }
    return this.axTree(dest.contents, dest.state);
  }

  /**
   * 잡아 끌기 — 마우스 기반 드래그다. HTML5 drag&drop(dragstart)은 네이티브
   * 드래그 세션을 요구해 CDP 마우스 이벤트로는 흐르지 않는다(그 경로는 후속
   * 과제). 중간 점을 밟는 이유: 이동 이벤트가 흘러야 페이지가 드래그로 본다.
   */
  async drag(target: { fromRef: string; toRef: string }, tabId?: string): Promise<PreviewAxNode[]> {
    const dest = await this.target(tabId);
    this.wake(dest.contents);
    // 두 rect 를 먼저 받는다 — from 을 누른 뒤의 scrollIntoView 는 잡은 것을
    // 뜯어 낼 수 있다.
    const from = await this.rectOfRef(dest.contents, dest.state, target.fromRef, true);
    const to = await this.rectOfRef(dest.contents, dest.state, target.toRef, true);
    const dbg = dest.contents.debugger;
    const fx = from.x + from.width / 2;
    const fy = from.y + from.height / 2;
    const tx = to.x + to.width / 2;
    const ty = to.y + to.height / 2;
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: fx,
      y: fy,
      button: "none",
    });
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: fx,
      y: fy,
      button: "left",
      clickCount: 1,
    });
    const STEPS = 5;
    for (let step = 1; step <= STEPS; step += 1) {
      await dbg.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: fx + ((tx - fx) * step) / STEPS,
        y: fy + ((ty - fy) * step) / STEPS,
        button: "left",
      });
    }
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: tx,
      y: ty,
      button: "left",
      clickCount: 1,
    });
    return this.axTree(dest.contents, dest.state);
  }

  /** 모든 탭의 디버거를 뗀다 — 페이지는 사용자의 것이라 그대로 둔다. */
  async destroy(): Promise<void> {
    this.releaseAll();
  }

  // ── 내부 장치 ─────────────────────────────────────────────────

  /** pane 의 페이지는 이미 보이는 창이다 — 포커스만 넘긴다. (07bd3bf wake 계승) */
  private wake(contents: WebContents): void {
    contents.focus();
  }

  /** (07bd3bf 이식) rect 의 가운데를 한 번 누른다. */
  private async clickRect(contents: WebContents, rect: PreviewRect): Promise<void> {
    const dbg = contents.debugger;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    // 오프스크린 시절의 선례 — pane 에서는 이미 앞이라 no-op 이다.
    await dbg.sendCommand("Page.bringToFront", {}).catch(() => undefined);
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await dbg.sendCommand("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    }
  }

  /**
   * (07bd3bf 이식) ref 가 가리키는 요소를 화면 가운데로 올리고 뷰포트 rect 를
   * 받는다. 낡은 ref 는 여기서 걸린다 — 도구가 그 말을 그대로 모델에게 전한다.
   * `actionable` 이면(누르기·입력·hover) 요소가 자리 잡고 누를 수 있을 때까지
   * 기다린다; 스크롤·캡처는 보이기만 하면 되므로 한 번만 묻는다.
   */
  private async rectOfRef(
    contents: WebContents,
    state: TabState,
    ref: string,
    actionable = false,
  ): Promise<PreviewRect> {
    const backendNodeId = state.refs.get(ref);
    if (backendNodeId === undefined) {
      throw new Error(`${ref} 는 지금 화면의 것이 아닙니다 — snapshot 으로 다시 읽으십시오.`);
    }
    const objectId = await this.resolveNode(contents, ref, backendNodeId);
    const evaluated = (await contents.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: actionable ? ACTIONABLE_RECT_OF_SELF : RECT_OF_SELF,
      returnByValue: true,
      awaitPromise: actionable,
    })) as { result?: { value?: unknown } };
    // 두 함수의 반환 모양이 다르다: RECT_OF_SELF 는 rect 를, ACTIONABLE 은
    // { rect } 나 { error } 를 돌려준다.
    const value = evaluated.result?.value;
    let rect: PreviewRect | null = null;
    let reason: string | undefined;
    if (value !== null && typeof value === "object") {
      if ("error" in value && typeof value.error === "string") reason = value.error;
      const candidate = "rect" in value ? value.rect : value;
      if (
        candidate !== null &&
        typeof candidate === "object" &&
        "x" in candidate &&
        typeof candidate.x === "number" &&
        "y" in candidate &&
        typeof candidate.y === "number" &&
        "width" in candidate &&
        typeof candidate.width === "number" &&
        "height" in candidate &&
        typeof candidate.height === "number" &&
        candidate.width > 0 &&
        candidate.height > 0
      ) {
        rect = { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height };
      }
    }
    if (!rect) {
      const why =
        reason === "disabled"
          ? "비활성 상태입니다"
          : reason === "covered"
            ? "다른 요소에 가려져 있습니다"
            : reason === "inert"
              ? "pointer-events 가 꺼져 있습니다"
              : reason === "moving"
                ? "자리를 잡지 못했습니다"
                : "화면에 보이지 않습니다";
      throw new Error(`${ref} 는 지금 누를 수 없습니다 — ${why}.`);
    }
    return rect;
  }

  /** (07bd3bf 이식) ref 의 backend 노드를 살아 있는 객체로 풀어낸다. */
  private async resolveNode(
    contents: WebContents,
    ref: string,
    backendNodeId: number,
  ): Promise<string> {
    const resolved = (await contents.debugger.sendCommand("DOM.resolveNode", {
      backendNodeId,
    })) as { object?: { objectId?: string } };
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw new Error(`${ref} 를 화면에서 찾지 못했습니다 — snapshot 으로 다시 읽으십시오.`);
    }
    return objectId;
  }

  /**
   * (07bd3bf 이식) `loadURL` 이 끝난 것은 문서가 왔다는 뜻일 뿐이다: SPA 는 그
   * 뒤에 라우팅한다. 문서가 완전해지고, 표식(`data-state`)을 요청했으면 그것이
   * 나타날 때까지 기다린다 — 못 기다리면 false 다.
   */
  private async settleOn(contents: WebContents, marker: string | null): Promise<boolean> {
    const selector = marker ? `[data-state=${JSON.stringify(marker)}]` : null;
    const probe = `(function () {
      if (document.readyState !== "complete") return false;
      const sel = ${JSON.stringify(selector)};
      return sel === null ? true : !!document.querySelector(sel);
    })()`;
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = (await contents.debugger
        .sendCommand("Runtime.evaluate", { expression: probe, returnByValue: true })
        .catch(() => null)) as { result?: { value?: unknown } } | null;
      if (result?.result?.value === true) return true;
      const poll = Promise.withResolvers<void>();
      setTimeout(poll.resolve, SETTLE_POLL_MS);
      await poll.promise;
    }
    return false;
  }

  // ── 캡처 어댑터의 손잡이 (같은 모듈의 PaneCaptureDriver 만 부른다) ────────

  /** pane 이 살아 있으면 돌려준다 — 팩토리의 forPane 과 같은 판정이다. */
  paneNow(): PlannerPreviewView | null {
    const pane = this.pane();
    return pane !== null && pane.webContents() !== null ? pane : null;
  }

  /** 지금 활성 탭에 붙는다 — 붙어 있으면 아무것도 하지 않는다. */
  async attachActive(): Promise<void> {
    await this.target(undefined);
  }

  /** 활성 탭에서 문서·표식을 기다린다 — 붙어 있지 않으면 false 다. */
  async settleActive(marker: string | null): Promise<boolean> {
    const pane = this.view();
    const id = pane.getActiveTabId();
    const state = id === null ? undefined : this.tabs.get(id);
    const contents = state?.contents ?? null;
    if (!contents || contents.isDestroyed()) return false;
    return this.settleOn(contents, marker);
  }

  /**
   * 이 드라이버가 붙인 탭의 디버거를 전부 뗀다 — 캡처 뒤 페이지는 사용자의
   * 것이다. driveTo 가 활성 탭을 갈아탔을 수 있으므로 "활성 것만"이 아니라
   * 붙인 것 전부다.
   */
  releaseAll(): void {
    for (const tabId of [...this.tabs.keys()]) this.release(tabId);
  }
}

/**
 * preview.capture 의 pane 경로(게이트 재배선의 `for`)가 쓰는 어댑터 — 같은
 * PaneBrowserDriver 를 경유해 디버거 붙임을 한 곳에 묶는다(§3 규칙 10).
 * PanePreviewDriver 는 이 어댑터에 흡수됐다: 캡처는 이제 탐색·settle 을
 * 드라이버의 장치로 하고, 창은 세우지 않는다.
 */
class PaneCaptureDriver implements PreviewDriver {
  constructor(
    private readonly browser: PaneBrowserDriver,
    private readonly baseUrl: string,
    private readonly allowedOrigins: readonly string[],
  ) {}

  async open(route: string, state: string | null): Promise<PreviewOpenResult> {
    let url: URL;
    try {
      url = new URL(route, this.baseUrl);
    } catch {
      return { ok: false, reason: `route 를 주소로 읽을 수 없습니다: ${route}` };
    }
    // (07bd3bf 이식) A declared screen must stay inside the preview server (or
    // an origin the repo explicitly allowed) — an absolute route would
    // otherwise carry the pane (and its debugger) to an origin the repo
    // never picked.
    const baseOrigin = new URL(this.baseUrl).origin;
    if (url.origin !== baseOrigin && !this.allowedOrigins.includes(url.origin)) {
      return {
        ok: false,
        reason: `허용되지 않은 서버의 주소는 열지 않습니다: ${route} (${[baseOrigin, ...this.allowedOrigins].join(", ")} 안의 경로를 쓰십시오)`,
      };
    }
    if (state) url.searchParams.set("state", state);
    const pane = this.browser.paneNow();
    if (!pane) {
      return {
        ok: false,
        reason: "미리보기 화면이 없습니다 — 화면이 보이는 상태에서 다시 시도하십시오.",
      };
    }
    // 이동 전에 붙는다 — 콘솔 수집이 여기서 시작된다.
    await this.browser.attachActive();
    if (!(await pane.driveTo(url.toString()))) {
      return { ok: false, reason: `화면을 불러오지 못했습니다: ${url}` };
    }
    // driveTo 가 다른 origin 의 페이지를 올렸을 수 있다 — 새 페이지에 다시 붙는다.
    await this.browser.attachActive();
    return { ok: true, settled: await this.browser.settleActive(state) };
  }

  async screenshot(options?: { longEdge?: number }): Promise<PreviewCapture> {
    return this.browser.screenshot({ longEdge: options?.longEdge });
  }

  async consoleLines(): Promise<PreviewConsoleLine[]> {
    return this.browser.consoleLines();
  }

  /** 캡처 뒤엔 디버거만 뗀다 — 페이지는 사용자의 것이라 그대로 둔다. */
  async destroy(): Promise<void> {
    this.browser.releaseAll();
  }
}

/**
 * 데몬에 주입되는 드라이버 공장. 데몬은 Electron 을 모른다 — 이 모듈만이
 * 창을 만든다. 게이트·넘기기의 재검증은 세션이 쓰던 화면과 무관한 숨은 창에서
 * 돈다(`forIsolated`) — 같은 인스턴스를 다시 열면 세션의 콘솔 기록과 ref
 * 세대가 오염된다. `for`(preview.capture)는 pane 이 있으면 에이전트의
 * PaneBrowserDriver 를 그대로 경유한다(§3 규칙 10) — 탭마다 디버거를 붙이는
 * 손은 하나뿐이다. pane 이 접혀 있으면 예전처럼 숨은 창이 대신 찍는다.
 * `browserDrivers` 를 안 넘기는 옛 호출자는 그 자리에서 공장 하나를 세운다 —
 * 그 공장의 드라이버가 그 pane 의 유일한 붙임 소유자다.
 */
export function createPreviewDriverFactory(
  pane: () => PlannerPreviewView | null = () => null,
  browserDrivers: BrowserDriverFactory = createBrowserDriverFactory(pane),
): PreviewDriverFactory {
  return {
    for: (baseUrl, allowedOrigins = []) => {
      const browser = browserDrivers.forPane();
      if (browser instanceof PaneBrowserDriver) {
        return new PaneCaptureDriver(browser, baseUrl, allowedOrigins);
      }
      return new ElectronPreviewDriver(baseUrl, allowedOrigins);
    },
    forIsolated: (baseUrl, allowedOrigins = []) =>
      new ElectronPreviewDriver(baseUrl, allowedOrigins),
  };
}

/**
 * 데몬에 주입되는 브라우저 공장(계획 §4-2). 같은 pane 에는 같은 드라이버 —
 * 인스턴스가 둘로 갈라지면 같은 탭에 디버거를 두 번 붙이는 일이 된다(§3
 * 규칙 10). pane 이 없으면 null 을 답한다 — 숨은 창 폴백은 이 계약에 없다.
 */
export function createBrowserDriverFactory(
  pane: () => PlannerPreviewView | null = () => null,
): BrowserDriverFactory {
  let driver: PaneBrowserDriver | null = null;
  return {
    forPane() {
      if (!pane()?.webContents()) return null;
      driver ??= new PaneBrowserDriver(pane);
      return driver;
    },
  };
}
