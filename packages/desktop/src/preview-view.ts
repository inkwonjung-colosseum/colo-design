import { ipcMain, shell, WebContents, WebContentsView, BrowserWindow } from "electron";
import type { CdsDesignErrorEnvelope } from "@cds-design/protocol";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 기획자의 미리보기 뷰 (PLAN D64 — D60 개봉). The planner's preview pane is
 * the app's own browser view: a `WebContentsView` laid over the web UI's
 * stage slot, so the address · history · errors · the comment-pin overlay
 * (D67, in the preload) are the tool's, not the connected repo's.
 *
 * The view is ALWAYS above renderer DOM (D65) — `cover()` hides it behind a
 * captured freeze frame whenever a modal-like layer opens. Same-origin only
 * (D66): page-initiated navigations are policed by `will-navigate`
 * (`loadURL` and history steps never fire it — Electron docs), tool-initiated
 * `open()` by its own origin check.
 *
 * The repo bridge contract (D68) is `cds-design.screens` · `navigate`: when
 * the bridge is `present` a navigate rides the preload (no reload), otherwise
 * it falls back to `loadURL` — the screen still shows, only the list is empty.
 * `preview-claude` (D61, the offscreen Claude window) keeps its own partition.
 */

/** The in-view preload, compiled to CommonJS beside this module. */
const PREVIEW_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), "preview-preload.cjs");

/** Whether this load's repo bridge spoke (`unknown` until it does). */
type BridgeState = "unknown" | "present" | "stale";

/** What a 폭 toggle narrows to (PLAN D69 — real emulation, not CSS names). */
const EMULATION: Record<"mobile" | "tablet", { size: [number, number]; mobile: boolean; userAgent?: string }> = {
  mobile: {
    size: [390, 844],
    mobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  tablet: { size: [768, 1024], mobile: false },
};

/** The screens a page must stay inside — the preview server's own origin. */
function sameOrigin(url: string, origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export class PlannerPreviewView {
  private view: WebContentsView | null = null;
  private bridge: BridgeState = "unknown";
  private origin: string | null = null;
  private covered = false;
  /** The last 💬 state — a fresh page load is re-told it (D67). */
  private commentsOn = false;
  /** What this view is already showing — a repeat mount must not reload. */
  private mountedUrl: string | null = null;

  constructor(private readonly window: () => BrowserWindow | null) {}
  /**
   * Boots (or re-aims) the view at a serving preview url. IDEMPOTENT: the
   * renderer may re-run its mount effect (a repo status flap remounts the
   * pane) and a reload to the root would throw away where the planner had
   * navigated — the same url means the view is already right.
   */
  mount(url: string): void {
    this.origin = new URL(url).origin;
    const view = this.ensureView();
    if (this.mountedUrl === url) return;
    this.mountedUrl = url;
    void view.webContents.loadURL(url);
  }

  /** The live webContents — the desktop suite drives the overlay through it. */
  webContents(): WebContents | null {
    const contents = this.view?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }


  /** Tears the view down — project switch, or the preview server died. */
  unmount(): void {
    const view = this.view;
    this.view = null;
    this.origin = null;
    this.bridge = "unknown";
    this.covered = false;
    this.mountedUrl = null;
    if (!view) return;
    this.window()?.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.view?.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    });
  }

  /**
   * D65: hide behind a freeze frame. The capture happens BEFORE the hide —
   * a hidden view's `capturePage()` has nothing promised (Electron docs).
   */
  async cover(on: boolean): Promise<void> {
    const view = this.view;
    if (!view) return;
    if (on && !this.covered) {
      try {
        const image = await view.webContents.capturePage();
        if (!image.isEmpty()) this.send("cds-preview:freeze", image.toJPEG(70).toString("base64"));
      } catch {
        // A paint that never happened; the slot just shows the pane background.
      }
      view.setVisible(false);
      this.covered = true;
    } else if (!on && this.covered) {
      view.setVisible(true);
      this.covered = false;
    }
  }

  /** The address bar's word (D66): any path inside the preview origin. */
  open(path: string): void {
    if (!this.origin) return;
    let url: URL;
    try {
      url = new URL(path, this.origin);
    } catch {
      return;
    }
    if (url.origin !== this.origin) return;
    this.mountedUrl = url.toString();
    void this.ensureView().webContents.loadURL(url.toString());
  }

  /**
   * A declared screen (D66 · D68): through the repo bridge when it is present
   * — client routing, no reload — else a plain `loadURL` so the screen still
   * shows on a repo whose bridge has not spoken.
   */
  navigate(route: string, state: string | null): void {
    const contents = this.ensureView().webContents;
    if (this.bridge === "present") {
      contents.send("cds-overlay:navigate", { route, state });
      return;
    }
    if (!this.origin) return;
    const url = new URL(route, this.origin);
    if (state) url.searchParams.set("state", state);
    this.mountedUrl = url.toString();
    void contents.loadURL(url.toString());
  }

  history(delta: -1 | 1): void {
    const contents = this.webContents();
    if (!contents) return;
    if (delta < 0) contents.navigationHistory.goBack();
    else contents.navigationHistory.goForward();
  }

  reload(): void {
    this.webContents()?.reload();
  }

  commentsMode(on: boolean): void {
    this.commentsOn = on;
    this.webContents()?.send("cds-overlay:mode", { on });
  }

  emulate(width: "mobile" | "tablet" | null): void {
    const contents = this.webContents();
    if (!contents) return;
    if (!width) {
      contents.disableDeviceEmulation();
      return;
    }
    const preset = EMULATION[width];
    contents.enableDeviceEmulation({
      screenPosition: preset.mobile ? "mobile" : "desktop",
      screenSize: { width: preset.size[0], height: preset.size[1] },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 2,
      viewSize: { width: preset.size[0], height: preset.size[1] },
      scale: 1,
      ...(preset.userAgent ? { userAgent: preset.userAgent } : {}),
    });
  }

  // ------------------------------------------------------------------ internals

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        partition: "preview",
        sandbox: true,
        contextIsolation: true,
        preload: PREVIEW_PRELOAD,
      },
    });
    this.attach(view.webContents);
    const window = this.window();
    window?.contentView.addChildView(view);
    // A fresh view has no bounds until the renderer measures the slot.
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.view = view;
    return view;
  }

  private attach(contents: WebContents): void {
    // The pane is a viewer for this one dev server, never a browser (D66):
    // windows the page tries to open are denied, same-origin ones absorbed.
    contents.setWindowOpenHandler(({ url }) => {
      if (sameOrigin(url, this.origin)) void contents.loadURL(url);
      else void shell.openExternal(url);
      return { action: "deny" };
    });
    // Page-initiated main-frame navigation only — `loadURL` and history steps
    // never fire this (Electron docs), which is why `open()` checks itself.
    contents.on("will-navigate", (event, url) => {
      if (!sameOrigin(url, this.origin)) {
        event.preventDefault();
        void shell.openExternal(url);
      }
    });
    contents.on("did-navigate", (_event, url) => {
      this.bridge = "unknown";
      this.mountedUrl = url;
      this.send("cds-preview:bridge", { state: this.bridge });
      this.sendLocation(contents, url);
      // The overlay never announces itself; a fresh load is told the mode.
      if (this.commentsOn) contents.send("cds-overlay:mode", { on: true });
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      this.mountedUrl = url;
      this.sendLocation(contents, url);
    });
    contents.on("did-start-loading", () => this.send("cds-preview:loading", { on: true }));
    contents.on("did-stop-loading", () => this.send("cds-preview:loading", { on: false }));
    // D69: the pane's own ears — no repo hook. 44 의 형태: 첫 인자가 details
    // 이벤트다(level 은 "info"|"warning"|"error"|"debug").
    contents.on("console-message", (details) => {
      if (details.level !== "error") return;
      this.reportError(contents, "runtime", details.message);
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 ERR_ABORTED is a navigation superseding itself, not a failure.
      if (!isMainFrame || errorCode === -3) return;
      this.reportError(
        contents,
        "build",
        `${errorDescription ?? "화면을 불러오지 못했습니다"} (${errorCode})`,
        validatedURL,
      );
    });
    contents.on("render-process-gone", (_event, details) => {
      this.reportError(contents, "runtime", `미리보기 프로세스가 죽었습니다 (${details?.reason ?? "unknown"})`);
    });
    // D71: while the view holds focus the renderer DOM hears no keys — the
    // two the whole UI hangs on are forwarded and replayed as synthetic
    // keydowns (NativeHost), so the palette and 설정 still open.
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const forward =
        (input.meta && (input.key === "k" || input.key === "K" || input.key === ",")) ||
        input.key === "Escape";
      if (!forward) return;
      event.preventDefault();
      this.send("cds-preview:key", {
        key: input.key,
        meta: Boolean(input.meta),
        shift: Boolean(input.shift),
        alt: Boolean(input.alt),
        control: Boolean(input.control),
      });
    });
  }

  /**
   * One envelope from the preview preload (D68): screens (the repo bridge
   * speaking — marks it `present`), the pin bundle (D67), or the stale marker
   * an old `drafthouse.*` bridge trips. Registered once per app, not per
   * view, so re-mounting never stacks listeners.
   */
  onOverlayPost(payload: { type?: unknown }): void {
    const type = typeof payload?.type === "string" ? payload.type : "";
    if (type === "cds-design.screens") {
      this.bridge = "present";
      this.send("cds-preview:bridge", { state: this.bridge });
      this.send("cds-preview:screens", payload);
    } else if (type === "cds-design.comments") {
      this.send("cds-preview:comments", payload);
    } else if (type === "cds-design.stale") {
      this.bridge = "stale";
      this.send("cds-preview:bridge", { state: this.bridge });
    }
  }

  private reportError(contents: WebContents, kind: CdsDesignErrorEnvelope["kind"], message: string, at?: string): void {
    let route = "";
    let state = "default";
    try {
      const url = new URL(at ?? contents.getURL());
      route = url.pathname.replace(/^\//, "");
      state = url.searchParams.get("state") ?? "default";
    } catch {
      // A URL that will not parse has no screen to name; the message stands.
    }
    this.send("cds-preview:error", { type: "cds-design.error", kind, message, route, state });
  }

  private sendLocation(contents: WebContents, url: string): void {
    let path = "/";
    try {
      const parsed = new URL(url);
      path = `${parsed.pathname}${parsed.search}`;
    } catch {
      // Keep "/" — an unparseable url still deserves a back button state.
    }
    this.send("cds-preview:location", {
      path,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    });
  }

  private send(channel: string, payload: unknown): void {
    const window = this.window();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// IPC surface (§2 of the plan): renderer → main commands. The renderer's
// preload exposes these only when `preview.native` is true, so the browser
// path never calls them.
// ---------------------------------------------------------------------------

export function registerPreviewIpc(view: PlannerPreviewView): void {
  ipcMain.on("cds-overlay:post", (event, payload: { type?: unknown }) => {
    if (event.sender !== view.webContents()) return;
    view.onOverlayPost(payload);
  });
  ipcMain.handle("preview:mount", (_event, input: unknown) => {
    if (input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string") {
      view.mount((input as { url: string }).url);
    }
    return { ok: true };
  });
  ipcMain.handle("preview:unmount", () => {
    view.unmount();
    return { ok: true };
  });
  ipcMain.handle("preview:bounds", (_event, input: unknown) => {
    if (
      input &&
      typeof input === "object" &&
      ["x", "y", "width", "height"].every((key) => typeof input[key as keyof typeof input] === "number")
    ) {
      const rect = input as { x: number; y: number; width: number; height: number };
      view.setBounds(rect);
    }
    return { ok: true };
  });
  ipcMain.handle("preview:cover", (_event, input: { on?: boolean }) => {
    return view.cover(Boolean(input?.on)).then(() => ({ ok: true }));
  });
  ipcMain.handle("preview:open", (_event, input: { path?: string }) => {
    if (typeof input?.path === "string") view.open(input.path);
    return { ok: true };
  });
  ipcMain.handle("preview:navigate", (_event, input: { route?: string; state?: string | null }) => {
    if (typeof input?.route === "string") view.navigate(input.route, input.state ?? null);
    return { ok: true };
  });
  ipcMain.handle("preview:history", (_event, input: { delta?: number }) => {
    view.history((input?.delta ?? -1) < 0 ? -1 : 1);
    return { ok: true };
  });
  ipcMain.handle("preview:reload", () => {
    view.reload();
    return { ok: true };
  });
  ipcMain.handle("preview:comments-mode", (_event, input: { on?: boolean }) => {
    view.commentsMode(Boolean(input?.on));
    return { ok: true };
  });
  ipcMain.handle("preview:emulate", (_event, input: { width?: unknown }) => {
    const width = input?.width;
    view.emulate(width === "mobile" || width === "tablet" ? width : null);
    return { ok: true };
  });
}
