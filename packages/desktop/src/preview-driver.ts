// Claude 의 미리보기 드라이버 (PLAN D61 · D63): 숨은 오프스크린
// BrowserWindow 가 세션의 colo-preview 도구가 노리는 브라우저다. CDP 가
// 캡처·접근성·입력을 담고, paint 는 PiP 프레임으로 기획자 창에 흐른다 —
// 그 싱크는 `plannerWindow` 하나뿐이다.

import type {
  PreviewAxNode,
  PreviewCapture,
  PreviewDriver,
  PreviewDriverFactory,
  PreviewOpenOptions,
  PreviewOpenResult,
  PreviewViewport,
} from "@colo-design/daemon/server";
import { BrowserWindow } from "electron";
import { VIEWPORT_METRICS } from "./emulation.js";

/** PiP 프레임 스로틀 (PLAN D63): 8fps. */
const PIP_FRAME_INTERVAL_MS = 125;
const PIP_LONG_EDGE = 640;
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
/** 접근성 트리에서 건너뛰지만 아이들은 살리는 역할. */
const AX_SKIP_ROLES: Record<string, true> = { InlineTextBox: true, IframePresentational: true };
/** 노드가 스스로 말하지 않는 것들 — 상태로 뽑아 올린다. */
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
/** `screen_press` 의 키 → CDP 키 이벤트. 화이트리스트는 도구가 지킨다. */
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

/** 요소를 화면 가운데로 올리고 그 시점의 뷰포트 rect 를 돌려주는 함수. */
const RECT_OF_SELF = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}`;

interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Chromium 이 돌려주는 접근성 노드 — 쓰는 부분만 적는다. */
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
 * 숨은 오프스크린 `BrowserWindow` 하나가 Claude 전용 브라우저다. 그리기는
 * `webContents.debugger`(CDP)에게 맡긴다: 캡처는 `Page.captureScreenshot`,
 * 접근성 트리는 `Accessibility.getFullAXTree`, 입력은 `Input.*`. 창은 화면에
 * 뜨지 않는다 — 보이는 창은 사용자의 것뿐이다.
 *
 * 주소는 ref 다 (PLAN D61): `axTree()` 가 걸어간 노드마다 `e12` 를 붙이고
 * backend 노드 번호를 기억한다. `open()` 과 다음 `axTree()` 가 세대를 갈아
 * 치우므로, 낡은 ref 는 "다시 읽으십시오" 라는 오류가 된다 — 엉뚱한 곳을
 * 누르는 일은 없다.
 */
class ElectronPreviewDriver implements PreviewDriver {
  private window: BrowserWindow | null = null;
  private readonly consoleHistory: Array<{ level: string; text: string }> = [];
  private lastFrameSent = 0;
  /** 지금 세대의 ref → backend 노드 번호. `open`·`axTree` 가 비운다. */
  private readonly refs = new Map<string, number>();
  /** 이 창에 걸린 에뮬레이션 — 같은 값을 두 번 걸지 않는다. */
  private applied: { viewport: PreviewViewport; colorScheme: "light" | "dark" } | null = null;
  /** 세우는 중인 창 — 동시 호출이 창 두 개를 만들지 않게. */
  private booting: Promise<BrowserWindow> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly plannerWindow: () => BrowserWindow | null,
  ) {}

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
      this.consoleHistory.push({ level: details.level, text: details.message });
    });
    contents.on("paint", (_details, _rect, image) => {
      const now = Date.now();
      if (now - this.lastFrameSent < PIP_FRAME_INTERVAL_MS) return;
      this.lastFrameSent = now;
      const planner = this.plannerWindow();
      if (!planner || planner.isDestroyed()) return;
      const size = image.getSize();
      const scale = Math.min(1, PIP_LONG_EDGE / Math.max(size.width, size.height));
      const shrunk = scale < 1 ? image.resize({ width: Math.round(size.width * scale) }) : image;
      planner.webContents.send("colo-preview:frame", shrunk.toJPEG(60).toString("base64"));
    });
    await contents.loadURL("about:blank").catch(() => undefined);
    // consoleAPICalled 은 Runtime 도메인을 켜야 흐르고, resolveNode 는 DOM,
    // 실패한 요청은 Network 를 켜야 온다. 하나가 없어도 나머지는 산다.
    for (const domain of ["Runtime.enable", "DOM.enable", "Network.enable"]) {
      await contents.debugger.sendCommand(domain, {}).catch(() => undefined);
    }
    this.window = window;
    return window;
  }

  /** 실패한 요청만 줍는다 — 성공한 트래픽은 기록하지 않는다. */
  private onDebuggerMessage(method: string, params: Record<string, unknown>): void {
    if (method === "Network.loadingFailed") {
      const text = typeof params.errorText === "string" ? params.errorText : "요청 실패";
      if (params.canceled === true) return;
      this.consoleHistory.push({ level: "net", text });
      return;
    }
    if (method !== "Network.responseReceived") return;
    const response = params.response as { status?: number; url?: string } | undefined;
    const status = response?.status ?? 0;
    if (status < 400) return;
    this.consoleHistory.push({ level: "net", text: `${status} ${response?.url ?? ""}`.trim() });
  }

  private debugger(): Electron.Debugger {
    const window = this.window;
    if (!window || window.isDestroyed()) throw new Error("미리보기 창이 닫혔습니다.");
    return window.webContents.debugger;
  }

  /**
   * 이 창에 폭과 색 스킴을 건다. 데스크톱 폭은 override 를 걷어내는 것이
   * 맞다 — 창의 제 크기가 데스크톱이다.
   */
  private async emulate(viewport: PreviewViewport, colorScheme: "light" | "dark"): Promise<void> {
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
    // A declared screen must stay inside the preview server — an absolute
    // route would carry this hidden window (and its debugger) to an origin
    // the repo picked. PlannerPreviewView.open checks the same thing.
    if (url.origin !== new URL(this.baseUrl).origin) {
      return {
        ok: false,
        reason: `미리보기 서버 밖의 주소는 열지 않습니다: ${route} (${new URL(this.baseUrl).origin} 안의 경로를 쓰십시오)`,
      };
    }
    if (state) url.searchParams.set("state", state);
    // 콘솔 기록과 ref 세대는 화면 이동과 함께 리셋된다.
    this.consoleHistory.length = 0;
    this.refs.clear();
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

  /**
   * `loadURL` 이 끝난 것은 문서가 왔다는 뜻일 뿐이다 (PLAN D61): SPA 는 그
   * 뒤에 라우팅하고 `?state=` 를 읽는다. 문서가 완전해지고, 상태를 요청했으면
   * 그 표식(`data-state`)이 나타날 때까지 기다린다 — 못 기다리면 false 다.
   */
  private async settle(state: string | null): Promise<boolean> {
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
  async screenshot(options?: { ref?: string; longEdge?: number }): Promise<PreviewCapture> {
    await this.ensureWindow();
    const longEdge = options?.longEdge ?? CAPTURE_LONG_EDGE;
    const area = options?.ref ? await this.rectOfRef(options.ref) : await this.viewportRect();
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

  /**
   * 접근성 트리를 계층 그대로 돌려주고, 그 자리에서 ref 를 새로 발급한다 —
   * 이 호출이 곧 ref 의 세대다. 이름 없는 구조 노드까지 그대로 담고, 무엇을
   * 접을지는 도구가 정한다 (`compact`).
   */
  async axTree(): Promise<PreviewAxNode[]> {
    await this.ensureWindow();
    const result = (await this.debugger().sendCommand("Accessibility.getFullAXTree", {})) as {
      nodes?: CdpAxNode[];
    };
    const nodes = result.nodes ?? [];
    const byId = new Map<string, CdpAxNode>();
    const childOf = new Set<string>();
    for (const node of nodes) byId.set(node.nodeId, node);
    for (const node of nodes) for (const child of node.childIds ?? []) childOf.add(child);

    this.refs.clear();
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
          this.refs.set(ref, backendId);
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
   * ref 가 가리키는 요소를 화면 가운데로 올리고 뷰포트 rect 를 받는다. 낡은
   * ref 는 여기서 걸린다 — 도구가 그 말을 그대로 모델에게 전한다.
   */
  private async rectOfRef(ref: string): Promise<PreviewRect> {
    const backendNodeId = this.refs.get(ref);
    if (backendNodeId === undefined) {
      throw new Error(`${ref} 는 지금 화면의 것이 아닙니다 — screen_read 로 다시 읽으십시오.`);
    }
    const dbg = this.debugger();
    const resolved = (await dbg.sendCommand("DOM.resolveNode", { backendNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw new Error(`${ref} 를 화면에서 찾지 못했습니다 — screen_read 로 다시 읽으십시오.`);
    }
    const evaluated = (await dbg.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: RECT_OF_SELF,
      returnByValue: true,
    })) as { result?: { value?: PreviewRect | null } };
    const rect = evaluated.result?.value ?? null;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`${ref} 는 화면에 보이지 않습니다.`);
    }
    return rect;
  }

  /** text·selector 로 찾는 옛 길 — ref 가 없을 때의 차선책이다. */
  private async rectOfQuery(target: { text?: string; selector?: string }): Promise<PreviewRect> {
    const find = target.selector
      ? `(function () {
          const el = document.querySelector(${JSON.stringify(target.selector)});
          if (!el) return null;
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return { rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        })()`
      : // 정확히 그 글자인 것이 먼저다 — "저장" 이 "저장 안 함" 을 누르면 안
        // 된다. 정확한 것이 여럿이면 고르지 않고 후보를 돌려준다.
        `(function () {
          const needle = ${JSON.stringify(target.text ?? "")};
          const all = Array.from(document.querySelectorAll("body *"));
          const innermost = (list) => list.filter((candidate) =>
            !list.some((other) => other !== candidate && candidate.contains(other)));
          const exact = innermost(all.filter((el) => (el.textContent || "").trim() === needle));
          const loose = innermost(all.filter((el) => (el.textContent || "").includes(needle)));
          const picked = exact.length > 0 ? exact : loose;
          if (picked.length === 0) return null;
          if (picked.length > 1) {
            return { ambiguous: picked.slice(0, 5).map((el) =>
              (el.tagName.toLowerCase() + ' "' + (el.textContent || "").trim().slice(0, 40) + '"')) };
          }
          const el = picked[0];
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return { rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        })()`;
    const evaluate = () =>
      this.debugger().sendCommand("Runtime.evaluate", {
        expression: find,
        returnByValue: true,
      }) as Promise<{
        result?: { value?: { rect?: PreviewRect; ambiguous?: string[] } | null };
      }>;
    // 캡처 직후 등 컨텍스트가 갈아엎어지는 순간이 있다 — 한 번 더 물어본다.
    let result = await evaluate();
    if (!result?.result?.value) {
      const settle = Promise.withResolvers<void>();
      setTimeout(settle.resolve, 120);
      await settle.promise;
      result = await evaluate();
    }
    const value = result?.result?.value;
    if (value?.ambiguous) {
      throw new Error(
        `"${target.text}" 에 맞는 것이 여럿입니다 — screen_read 의 ref 를 쓰십시오: ${value.ambiguous.join(", ")}`,
      );
    }
    const rect = value?.rect;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`화면에서 찾지 못했습니다: ${target.text ?? target.selector}`);
    }
    return rect;
  }

  private async clickRect(rect: PreviewRect): Promise<void> {
    const dbg = this.debugger();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    // 오프스크린 페이지는 태어나자마자 뒷전이다 — 먼저 앞으로 끌어 올린다.
    await dbg.sendCommand("Page.bringToFront", {});
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
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

  async click(target: { ref?: string; text?: string; selector?: string }): Promise<void> {
    const window = await this.ensureWindow();
    // 오프스크린 창은 포커스가 없어 입력이 무시될 수 있다 — 먼저 창을 살린다.
    window.webContents.focus();
    const rect = target.ref
      ? await this.rectOfRef(target.ref)
      : await this.rectOfQuery({
          ...(target.text ? { text: target.text } : {}),
          ...(target.selector ? { selector: target.selector } : {}),
        });
    await this.clickRect(rect);
  }

  async type(input: { ref?: string; text: string; clear?: boolean }): Promise<void> {
    const window = await this.ensureWindow();
    window.webContents.focus();
    if (input.ref) await this.clickRect(await this.rectOfRef(input.ref));
    const dbg = this.debugger();
    if (input.clear === true) {
      // 있던 값을 지운다: 선택 후 덮어쓰기 — 프레임워크의 onChange 가 흐르는
      // 유일한 길이다(값을 직접 넣으면 React 는 모른다).
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
  }

  async press(key: string): Promise<void> {
    await this.ensureWindow();
    const mapped = PRESS_KEY_CODES[key];
    if (!mapped) throw new Error(`보낼 수 없는 키입니다: ${key}`);
    const dbg = this.debugger();
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
  }

  async scroll(target: { ref?: string; dy: number }): Promise<void> {
    await this.ensureWindow();
    // ref 만 주면 "보이게 해 달라"는 뜻이다 — rect 를 받는 것 자체가 그 일이다.
    const rect = target.ref ? await this.rectOfRef(target.ref) : null;
    if (target.dy === 0) return;
    const dbg = this.debugger();
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: rect ? rect.x + rect.width / 2 : VIEWPORT_METRICS.desktop.size[0] / 2,
      y: rect ? rect.y + rect.height / 2 : VIEWPORT_METRICS.desktop.size[1] / 2,
      deltaX: 0,
      deltaY: target.dy,
    });
  }

  async hover(target: { ref: string }): Promise<void> {
    await this.ensureWindow();
    const rect = await this.rectOfRef(target.ref);
    await this.debugger().sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      button: "none",
    });
  }

  async consoleLines(): Promise<Array<{ level: string; text: string }>> {
    return [...this.consoleHistory];
  }

  async destroy(): Promise<void> {
    const window = this.window;
    this.window = null;
    this.refs.clear();
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
 * 데몬에 주입되는 드라이버 공장. 데몬은 Electron 을 모른다 — 이 모듈만이
 * 창을 만들고, 세션마다 하나의 숨은 창이 생긴다(PLAN D61).
 */
export function createPreviewDriverFactory(
  plannerWindow: () => BrowserWindow | null = () => null,
): PreviewDriverFactory {
  return { for: (baseUrl) => new ElectronPreviewDriver(baseUrl, plannerWindow) };
}
