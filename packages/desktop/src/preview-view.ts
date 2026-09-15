import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ColoDesignErrorEnvelope,
  ColoDesignPinEnvelope,
  ColoDesignPinsSync,
  ColoDesignScreen,
  ColoDesignScreensEnvelope,
} from "@colo-design/protocol";
import { type BrowserWindow, ipcMain, shell, type WebContents, WebContentsView } from "electron";
import { VIEWPORT_METRICS } from "./emulation.js";

/**
 * 사용자의 미리보기 뷰 (PLAN D64 — D60 개봉). The planner's preview pane is
 * the app's own browser view: a `WebContentsView` laid over the web UI's
 * stage slot, so the address · history · errors · the comment-pin overlay
 * (D67, in the preload) are the tool's, not the connected repo's.
 *
 * ONE PAGE PER PREVIEW SERVER, KEPT. A project switch parks the page it
 * leaves (hidden, alive, exactly where the planner was) and shows the page
 * of the project it goes to — kept from an earlier visit, or created and
 * loaded once. Coming back is a repaint, never a reload; the daemon keeps
 * the servers warm for the same reason. Only the page on screen speaks to
 * the renderer; a parked page keeps its own facts for the return.
 *
 * The view is ALWAYS above renderer DOM (D65) — `cover()` hides it behind a
 * captured freeze frame whenever a modal-like layer opens. Same-origin only
 * (D66): page-initiated navigations are policed by `will-navigate`
 * (`loadURL` and history steps never fire it — Electron docs), tool-initiated
 * `open()` by its own origin check.
 *
 * The repo bridge contract (D68) is `colo-design.screens` · `navigate`: when
 * the bridge is `present` a navigate rides the preload (no reload), otherwise
 * it falls back to `loadURL` — the screen still shows, only the list is empty.
 * `preview-claude` (D61, the offscreen Claude window) keeps its own partition.
 *
 * 재설계 C4 has the view crop each pin's element (`element.rect`) at pin
 * time — the envelope that reaches the web already carries the shot; D89
 * keeps the last 20 console lines for the 화면 보여 주기 turn.
 */

/** The in-view preload, compiled to CommonJS beside this module. */
const PREVIEW_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), "preview-preload.cjs");

/** Whether this load's repo bridge spoke (`unknown` until it does). */
type BridgeState = "unknown" | "present";

/** 폭 toggle presets live beside Claude's window — see emulation.ts. */

/** 재설계 C4's crop: 긴 변 600px. (The ≤6 cap is the web submit's to hold.) */
const SHOT_LONG_SIDE = 600;
/** D89's full-frame budget: 한 장, 긴 변 1200px. */
const SNAPSHOT_LONG_SIDE = 1200;
/** How long a hidden-overlay ack may take before the capture runs anyway. */
const CAPTURE_ACK_MS = 400;

/**
 * 재설계 §4.3: the pinned element's React owner chain, read in the page's
 * main world — the isolated preload cannot see fiber expandos. A constant
 * function; the call site interpolates the pin id as a JSON string literal —
 * and only after the UUID gate, so nothing else ever reaches the code string.
 * The `data-colo-pick` stamp comes off in the script's finally; a non-React
 * or production page answers null and the pin travels without owners.
 */
const OWNER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_SCRIPT = `(id) => {
  const el = document.querySelector('[data-colo-pick="' + id + '"]');
  if (!el) return null;
  try {
    let fiber = null;
    for (const key of Object.keys(el)) {
      if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
        fiber = el[key];
        break;
      }
    }
    const names = [];
    for (
      let owner = fiber && fiber._debugOwner;
      owner && names.length < 3;
      owner = owner._debugOwner
    ) {
      const name = owner.type && (owner.type.displayName || owner.type.name);
      if (typeof name === "string" && name !== "") names.push(name);
    }
    return names.length > 0 ? names : null;
  } finally {
    el.removeAttribute("data-colo-pick");
  }
}`;

/** Downscale so the LONG side is `max`, keeping the aspect. No upscale. */
function fitInside(image: Electron.NativeImage, max: number): Electron.NativeImage {
  const { width, height } = image.getSize();
  const long = Math.max(width, height);
  if (long <= max || long === 0) return image;
  return width >= height ? image.resize({ width: max }) : image.resize({ height: max });
}

/**
 * The part of a pin's element the pane can actually photograph: its rect
 * (CSS pixels, as the overlay measured it) intersected with the viewport.
 * The planner pins, scrolls, and only then sends — so a rect may hang off
 * any edge by the time the capture runs, and `capturePage` on a box that
 * leaves the frame answers with an empty or half-blank image. Clamping x/y
 * alone fixes the top-left only; the right and bottom need the viewport.
 * No overlap at all → no crop, and D87's rule holds: the pin travels
 * text-only rather than carrying a broken thumbnail.
 */
function cropRect(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number } | null,
): Electron.Rectangle | null {
  const left = Math.round(rect.x);
  const top = Math.round(rect.y);
  const right = left + Math.min(Math.round(rect.width), 4000);
  const bottom = top + Math.min(Math.round(rect.height), 4000);
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  const width = (viewport ? Math.min(right, Math.round(viewport.width)) : right) - x;
  const height = (viewport ? Math.min(bottom, Math.round(viewport.height)) : bottom) - y;
  return width >= 1 && height >= 1 ? { x, y, width, height } : null;
}

/** The screens a page must stay inside — the preview server's own origin. */
function sameOrigin(url: string, origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The only origins this view may ever show: the daemon's loopback preview
 * servers. The renderer names urls, this decides — a compromised renderer
 * must not aim the overlay at file:// or a foreign origin and snapshot it.
 */
function loopbackHttp(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === "http:" &&
      (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/**
 * Repo content never gets to hand the OS a scheme — only the web's two.
 * Same rule as the main window's guardNavigations; a dev-server page that
 * opens help:// or a custom handler is a page the planner never asked for.
 */
function openExternalHttp(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:") void shell.openExternal(url);
  } catch {
    // a url that will not parse has no protocol to allow
  }
}

/**
 * The pages this pane keeps alive at once — the one on screen and the parked
 * ones behind it. Each is a renderer process of its own: the cap bounds what
 * clicking through the sidebar costs. Matches the daemon's warm-preview cap.
 */
const MAX_PAGES = 3;

/**
 * One preview server's page, kept for as long as the planner may come back
 * to it: the view, and everything the pane knows about THIS page.
 */
interface PreviewPage {
  /** The preview server's origin — the one origin this page may show (D66). */
  readonly origin: string;
  readonly view: WebContentsView;
  /** The server process the page was loaded from (RepoStatus.previewEpoch). */
  epoch: number | null;
  bridge: BridgeState;
  /** What the page is showing — a repeat mount or open must not reload. */
  mountedUrl: string | null;
  /** The last main-frame load failed, or the renderer died — a return reloads. */
  failed: boolean;
  /** The zoom the page is at (D85 ⓔ) — steps clamp into [0.5, 2]. */
  zoomFactor: number;
  /** D89: the last 20 console lines, for the 화면 보여 주기 turn. */
  readonly consoleLog: string[];
  /** The last screens envelope its bridge posted (D68) — replayed on a return. */
  screens: ColoDesignScreensEnvelope | null;
  /** When the page was last on screen — the cap ends the ones left longest ago. */
  shownAt: number;
}

export class PlannerPreviewView {
  /** Every page kept alive, by preview origin — the one on screen included. */
  private readonly pages = new Map<string, PreviewPage>();
  /** The page on screen; null while the slot is gone (a card took its place). */
  private page: PreviewPage | null = null;
  /** The slot's rect as the renderer last measured it — a page shown later takes it. */
  private bounds: Electron.Rectangle | null = null;
  private covered = false;
  /** The last 💬 state — a fresh load, or a returning page, is re-told it (D67). */
  private commentsOn = false;
  /** The web's last pin sync (재설계 C1) — a page that loads or returns is re-told it. */
  private lastPins: ColoDesignPinsSync | null = null;
  /** Resolved when the overlay acknowledges a capture hide/show (D87). */
  private captureAck: (() => void) | null = null;

  /**
   * `onScreens` is the daemon's copy of the declaration list (PLAN D61): the
   * tool's `screen_list` reads it, and the daemon has no page of its own to
   * hear the bridge from. Only the page on screen reports — the list means
   * "the app the planner is looking at", the same thing the renderer shows.
   */
  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly onScreens?: (screens: ColoDesignScreen[]) => void,
  ) {}

  /**
   * Puts the page for a serving preview url on screen. A page the pane kept
   * from an earlier visit comes back exactly where the planner left it — no
   * load, the switch costs a repaint. A page the pane has not met is created
   * and loaded once. Either way `epoch` names the server process behind the
   * url: a page loaded under an earlier one is stale (the server restarted,
   * or the port fence handed the port to another project) and reloads.
   * IDEMPOTENT for the page on screen: the renderer may re-run its mount
   * effect (a repo status flap remounts the pane), and a reload to the root
   * would throw away where the planner had navigated.
   */
  mount(url: string, epoch: number | null): void {
    if (!loopbackHttp(url)) return;
    const origin = new URL(url).origin;
    const current = this.page;
    if (current && current.origin === origin && this.attached(current)) {
      this.refresh(current, url, epoch);
      return;
    }
    if (current) this.park(current);
    const kept = this.pages.get(origin);
    if (kept && !kept.view.webContents.isDestroyed()) {
      this.show(kept);
      this.refresh(kept, url, epoch);
      return;
    }
    if (kept) this.pages.delete(origin);
    const page = this.createPage(origin, epoch);
    this.pages.set(origin, page);
    this.show(page);
    this.evictParked();
    this.load(page, url);
  }

  /**
   * A page on screen against the server that answers now. A moved epoch is a
   * different process — the app behind the port may be another project's,
   * so the page starts over at the root; a failed last load (the server was
   * down, the renderer died) retries where it was. Otherwise the page is
   * already right and nothing loads.
   */
  private refresh(page: PreviewPage, url: string, epoch: number | null): void {
    const moved = epoch !== null && page.epoch !== null && page.epoch !== epoch;
    if (epoch !== null) page.epoch = epoch;
    if (moved) {
      page.failed = false;
      page.mountedUrl = url;
      void page.view.webContents.loadURL(url);
    } else if (page.failed) {
      page.failed = false;
      void page.view.webContents.loadURL(page.mountedUrl ?? url);
    }
  }

  /** The live webContents of the page on screen — the desktop suite drives the overlay through it. */
  webContents(): WebContents | null {
    const contents = this.page?.view.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  /**
   * Takes the page off screen — the slot is gone (a project switch, a card in
   * the pane's place, the server died). The page stays alive, parked, for
   * the planner's return; only the cap or its own death ends it.
   */
  unmount(): void {
    if (this.page) this.park(this.page);
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    };
    this.page?.view.setBounds(this.bounds);
  }

  /**
   * D65: hide the view, THEN photograph it. The hide is synchronous — the
   * view draws above every renderer pixel, so every millisecond spent
   * awaiting a capture is a millisecond the planner's modal is covered by
   * the stage (measured: an overlap on all 120 opens of a soak, up to
   * 751ms while a page was loading). The freeze frame is decoration and
   * rides behind: a hidden view answers `capturePage()` with its last
   * composited frame, and where it does not, the slot shows the pane
   * background under the scrim — a cost that is cosmetic, one-sided and
   * gone at the next cover. The old order paid for that decoration with
   * the correctness of the layer above it.
   *
   * Every call APPLIES. The renderer asserts the layer state it can see
   * and this obeys — no dedupe guard, so an assertion that never landed is
   * repaired by the next one instead of being taken for the truth.
   * Covered is a fact about the pane, not a page: a page shown while a
   * modal is open comes up hidden (`show`) and appears when it closes.
   */
  cover(on: boolean): void {
    const edge = on && !this.covered;
    this.covered = on;
    const page = this.page;
    if (!page || page.view.webContents.isDestroyed()) return;
    page.view.setVisible(!on);
    // One capture per false→true edge — a re-assertion is not a new modal.
    if (edge) void this.freeze(page);
  }

  /**
   * The slot's freeze frame (D65) — best-effort by contract: a capture that
   * fails, comes back empty, or lands after the modal closed or another
   * page took the screen is dropped rather than painted as this one.
   */
  private async freeze(page: PreviewPage): Promise<void> {
    try {
      const image = await page.view.webContents.capturePage();
      if (image.isEmpty() || !this.covered || this.page !== page) return;
      this.send("colo-preview:freeze", image.toJPEG(70).toString("base64"));
    } catch {
      // A paint that never happened; the slot shows the pane background.
    }
  }

  /** The address bar's word (D66): any path inside the preview origin. */
  open(path: string): void {
    const page = this.page;
    if (!page) return;
    let url: URL;
    try {
      url = new URL(path, page.origin);
    } catch {
      return;
    }
    if (url.origin !== page.origin) return;
    this.load(page, url.toString());
  }

  /**
   * A declared screen (D66 · D68): through the repo bridge when it is present
   * — client routing, no reload — else a plain load so the screen still
   * shows on a repo whose bridge has not spoken.
   */
  navigate(route: string, state: string | null): void {
    const page = this.page;
    if (!page) return;
    if (page.bridge === "present") {
      page.view.webContents.send("colo-overlay:navigate", { route, state });
      return;
    }
    let url: URL;
    try {
      url = new URL(route, page.origin);
    } catch {
      return;
    }
    // open() refuses off-origin urls; a declared screen must not slip past
    // that by carrying an absolute route — the repo owns the screens list.
    if (url.origin !== page.origin) return;
    if (state) url.searchParams.set("state", state);
    this.load(page, url.toString());
  }

  /**
   * Loads a url the page is not already at. The same address asked again (a
   * re-submitted bar, an ask re-riding a remount) is a no-op, not a reload —
   * 새로 고침 is the one word for that.
   */
  private load(page: PreviewPage, url: string): void {
    if (page.mountedUrl === url && !page.failed) return;
    page.mountedUrl = url;
    page.failed = false;
    void page.view.webContents.loadURL(url);
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

  /** D85 ⓐ: 로딩 중 새로 고침 버튼의 두 번째 클릭 — 중단. */
  stop(): void {
    this.webContents()?.stop();
  }

  /**
   * D85 ⓔ: 배율은 눈, 에뮬레이션은 장치 — 독립이다. 되알림(`colo-preview:zoom`)
   * 이 필요한 건 메뉴가 먼저 바꾸면 렌더러가 모르기 때문이다.
   */
  zoomIn(): void {
    this.setZoom((this.page?.zoomFactor ?? 1) + 0.2);
  }

  zoomOut(): void {
    this.setZoom((this.page?.zoomFactor ?? 1) - 0.2);
  }

  zoomReset(): void {
    this.setZoom(1);
  }

  private setZoom(factor: number): void {
    const page = this.page;
    if (!page || page.view.webContents.isDestroyed()) return;
    const clamped = Math.min(2, Math.max(0.5, factor));
    page.view.webContents.setZoomFactor(clamped);
    page.zoomFactor = clamped;
    this.send("colo-preview:zoom", { factor: clamped });
  }

  /** The preview origin on screen — the main window's popup gate. */
  getOrigin(): string | null {
    return this.page?.origin ?? null;
  }

  commentsMode(on: boolean): void {
    this.commentsOn = on;
    this.webContents()?.send("colo-overlay:mode", { on });
  }

  /**
   * 재설계 C1: the web's whole pin list is the truth — remember it so a page
   * that loads or comes back from a park is re-told it, and project it onto
   * the overlay (the badges redraw from this).
   */
  syncPins(sync: ColoDesignPinsSync): void {
    this.lastPins = sync;
    this.webContents()?.send("colo-overlay:pins", sync);
  }

  /** 재설계 C1: the web's chip click — the matching badge on the page flashes. */
  pinFlash(id: string): void {
    this.webContents()?.send("colo-overlay:flash", { id });
  }

  /**
   * D87's three-beat: hide the overlay (the pins and bubbles must not ride
   * the crop), run the captures, show it again. The ack is the preload's two
   * rAFs; a missing one only means the pins photobomb — never a hang.
   */
  private async withOverlayHidden(work: () => Promise<void>): Promise<void> {
    const contents = this.webContents();
    if (!contents) return;
    this.send("colo-overlay:capture", { on: true });
    await new Promise<void>((ok) => {
      const timer = setTimeout(ok, CAPTURE_ACK_MS);
      this.captureAck = () => {
        clearTimeout(timer);
        this.captureAck = null;
        ok();
      };
    });
    try {
      await work();
    } finally {
      this.send("colo-overlay:capture", { on: false });
    }
  }

  /** The overlay's ack for a capture hide/show. */
  onCaptureDone(): void {
    this.captureAck?.();
  }

  /**
   * The page's visible box in CSS pixels — the frame a pin's `element.rect`
   * (a getBoundingClientRect) was measured against. The view's bounds are
   * device-independent pixels; a zoomed page (D85 ⓔ) shows fewer CSS pixels
   * in the same box, so the factor divides back out. Null while the pane has
   * no page or no size yet — then a crop is taken on trust, as before.
   */
  private viewportCss(): { width: number; height: number } | null {
    const page = this.page;
    if (!page) return null;
    const bounds = page.view.getBounds();
    const factor = page.zoomFactor > 0 ? page.zoomFactor : 1;
    const width = bounds.width / factor;
    const height = bounds.height / factor;
    return width >= 1 && height >= 1 ? { width, height } : null;
  }

  /**
   * 재설계 C4: the crop happens at pin time — the rect the overlay measured
   * is where the element is NOW, one shot per pin (긴 변 600px, JPEG q70).
   * A failed crop costs only the thumbnail; the pin always gets through.
   */
  private async relayPin(payload: ColoDesignPinEnvelope): Promise<void> {
    try {
      await this.withOverlayHidden(async () => {
        const contents = this.webContents();
        if (!contents) return;
        // §4.3 first — the order against the crop is free, but the stamp
        // must come off (the script's own finally sees to it) either way.
        try {
          if (OWNER_UUID.test(payload.pin.id)) {
            const owners = (await contents.executeJavaScript(
              `(${OWNER_SCRIPT})(${JSON.stringify(payload.pin.id)})`,
              true,
            )) as string[] | null;
            if (
              Array.isArray(owners) &&
              owners.length > 0 &&
              owners.every((name) => typeof name === "string")
            ) {
              payload.pin.element.owners = owners;
            }
          }
        } catch {
          // Not a React page (or a production build): no chain, no error.
        }
        const crop = cropRect(payload.pin.element.rect, this.viewportCss());
        // Wholly off screen (scrolled past, or beside the frame): no photo.
        if (!crop) return;
        try {
          const image = await contents.capturePage(crop);
          if (image.isEmpty()) return;
          payload.pin.shot = {
            mediaType: "image/jpeg",
            data: fitInside(image, SHOT_LONG_SIDE).toJPEG(70).toString("base64"),
          };
        } catch {
          // The page moved under the rect; this pin travels text-only.
        }
      });
    } finally {
      this.send("colo-preview:pin", payload);
      // The gesture ends here: focus returns to the composer, so the
      // planner keeps talking without reaching for the mouse (재설계 C4).
      this.window()?.webContents.focus();
    }
  }

  /**
   * D89: everything the 화면 보여 주기 turn needs in one call — the whole
   * frame (긴 변 1200px, JPEG q70, overlay hidden) and the recent console.
   */
  async snapshot(): Promise<{ jpeg: string | null; console: string[] }> {
    const result: { jpeg: string | null; console: string[] } = {
      jpeg: null,
      console: [...(this.page?.consoleLog ?? [])],
    };
    const contents = this.webContents();
    if (!contents) return result;
    try {
      await this.withOverlayHidden(async () => {
        const image = await contents.capturePage();
        if (!image.isEmpty()) {
          result.jpeg = fitInside(image, SNAPSHOT_LONG_SIDE).toJPEG(70).toString("base64");
        }
      });
    } catch {
      // A frame that would not sit still; the console lines still go.
    }
    return result;
  }

  emulate(width: "mobile" | "tablet" | null): void {
    const contents = this.webContents();
    if (!contents) return;
    if (!width) {
      contents.disableDeviceEmulation();
      return;
    }
    const preset = VIEWPORT_METRICS[width];
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

  /**
   * One envelope from a page's preload (D68): screens (the repo bridge
   * speaking — marks THAT page's bridge `present`) or a pin (재설계 C1).
   * Registered once per app, not per page, so pages coming and going never
   * stack listeners. A parked page's envelope updates its own facts and
   * stops there — the renderer hears only the page on screen.
   */
  onOverlayPost(sender: WebContents, payload: { type?: unknown }): void {
    const page = this.pageOf(sender);
    if (!page) return;
    const type = typeof payload?.type === "string" ? payload.type : "";
    if (type === "colo-design.screens") {
      // The bridge's own shape (D68): narrowed once here, and a bridge that
      // posted no array is a bridge with nothing to declare.
      const envelope = payload as ColoDesignScreensEnvelope;
      const screens = Array.isArray(envelope.screens) ? envelope.screens : [];
      page.bridge = "present";
      page.screens = { type: "colo-design.screens", screens };
      if (this.page === page) {
        this.send("colo-preview:screens", page.screens);
        this.onScreens?.(screens);
      }
    } else if (type === "colo-design.pin" && this.page === page) {
      // 재설계 C4: the crop rides in before the web hears anything.
      void this.relayPin(payload as ColoDesignPinEnvelope);
    } else if (type === "colo-design.pin-focus" && this.page === page) {
      this.send("colo-preview:pin-focus", payload);
    }
  }

  // ------------------------------------------------------------------ internals

  private pageOf(sender: WebContents): PreviewPage | null {
    for (const page of this.pages.values()) {
      if (page.view.webContents === sender) return page;
    }
    return null;
  }

  /** A page is born parked: no bounds, not visible, not yet in the window. */
  private createPage(origin: string, epoch: number | null): PreviewPage {
    const view = new WebContentsView({
      webPreferences: {
        partition: "preview",
        sandbox: true,
        contextIsolation: true,
        preload: PREVIEW_PRELOAD,
      },
    });
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    const page: PreviewPage = {
      origin,
      view,
      epoch,
      bridge: "unknown",
      mountedUrl: null,
      failed: false,
      zoomFactor: 1,
      consoleLog: [],
      screens: null,
      shownAt: 0,
    };
    this.attach(page);
    return page;
  }

  /**
   * Puts a page on screen: topmost in the window (`addChildView` reorders a
   * child it already holds), sized to the slot, visible unless a modal
   * covers the pane. The overlay is re-told the mode (D67) and the last pin
   * sync (재설계 C1) it may have missed while parked, and the renderer's
   * picture of the pane — where it is, its screens, whether it loads, its
   * zoom — is replayed from this page's facts.
   */
  private show(page: PreviewPage): void {
    this.page = page;
    page.shownAt = Date.now();
    const window = this.window();
    if (window && !window.isDestroyed()) window.contentView.addChildView(page.view);
    if (this.bounds) page.view.setBounds(this.bounds);
    page.view.setVisible(!this.covered);
    const contents = page.view.webContents;
    contents.send("colo-overlay:mode", { on: this.commentsOn });
    if (this.lastPins) contents.send("colo-overlay:pins", this.lastPins);
    this.sendLocation(page);
    const screens = page.screens ?? { type: "colo-design.screens" as const, screens: [] };
    this.send("colo-preview:screens", screens);
    this.onScreens?.(screens.screens);
    this.send("colo-preview:loading", { on: contents.isLoading() });
    this.send("colo-preview:zoom", { factor: page.zoomFactor });
  }

  /**
   * Whether a page is alive AND a child of the window on screen now. The
   * pane outlives the window — on mac ⌘W destroys it and the dock icon
   * builds another — so `this.page` can belong to a contentView that is
   * gone. `show()` is the only place that attaches a view, so a mount
   * taking the fast path on an orphan would leave the slot empty for the
   * rest of the run.
   */
  private attached(page: PreviewPage): boolean {
    if (page.view.webContents.isDestroyed()) return false;
    const window = this.window();
    if (!window || window.isDestroyed()) return false;
    return window.contentView.children.includes(page.view);
  }

  /** Takes a page off screen but keeps it: hidden, its facts its own. */
  private park(page: PreviewPage): void {
    // A page whose window was destroyed took its webContents with it —
    // hiding that view throws, and this runs on the way out of a closed
    // window.
    if (!page.view.webContents.isDestroyed()) page.view.setVisible(false);
    if (this.page === page) this.page = null;
  }

  /** Beyond the cap, the parked pages the planner left longest ago end. */
  private evictParked(): void {
    const parked = [...this.pages.values()]
      .filter((page) => page !== this.page)
      .sort((a, b) => b.shownAt - a.shownAt);
    for (const page of parked.slice(MAX_PAGES - 1)) this.destroy(page);
  }

  private destroy(page: PreviewPage): void {
    this.pages.delete(page.origin);
    if (this.page === page) this.page = null;
    const window = this.window();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(page.view);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  }

  /**
   * A page's own ears, for its whole life. Every handler updates the page's
   * facts; only the page on screen relays them to the renderer — a parked
   * page reloading itself must not move the address bar or raise a banner
   * over the project the planner is looking at.
   */
  private attach(page: PreviewPage): void {
    const contents = page.view.webContents;
    // The pane is a viewer for this one dev server, never a browser (D66):
    // windows the page tries to open are denied, same-origin ones absorbed.
    contents.setWindowOpenHandler(({ url }) => {
      if (sameOrigin(url, page.origin)) void contents.loadURL(url);
      else openExternalHttp(url);
      return { action: "deny" };
    });
    // Page-initiated main-frame navigation only — `loadURL` and history steps
    // never fire this (Electron docs), which is why `open()` checks itself.
    contents.on("will-navigate", (event, url) => {
      if (!sameOrigin(url, page.origin)) {
        event.preventDefault();
        openExternalHttp(url);
      }
    });
    contents.on("did-navigate", (_event, url) => {
      // A fresh load's bridge has not spoken yet: the screens it knew go
      // with the old document, until the new one declares its own.
      page.bridge = "unknown";
      page.screens = null;
      page.mountedUrl = url;
      page.failed = false;
      if (this.page !== page) return;
      this.sendLocation(page);
      // The overlay never announces itself; a fresh load is re-told
      // everything it needs — the mode (D67), the last pin sync (재설계 C1).
      if (this.commentsOn) contents.send("colo-overlay:mode", { on: true });
      if (this.lastPins) contents.send("colo-overlay:pins", this.lastPins);
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      page.mountedUrl = url;
      if (this.page !== page) return;
      this.sendLocation(page);
      // A SPA move swaps the screen without a load; replaying the sync lets
      // the overlay refilter its badges at once (재설계 C5) — the web's
      // onLocation resend confirms with the fresh list.
      if (this.lastPins) contents.send("colo-overlay:pins", this.lastPins);
    });
    contents.on("did-start-loading", () => {
      if (this.page === page) this.send("colo-preview:loading", { on: true });
    });
    contents.on("did-stop-loading", () => {
      if (this.page === page) this.send("colo-preview:loading", { on: false });
    });
    // D69: the pane's own ears — no repo hook. 44 의 형태: 첫 인자가 details
    // 이벤트다(level 은 "info"|"warning"|"error"|"debug"). D89: every line
    // lands in the ring buffer first — the 화면 보여 주기 turn quotes it.
    contents.on("console-message", (details) => {
      const line = `[${details.level}] ${details.message}`.slice(0, 500);
      page.consoleLog.push(line);
      if (page.consoleLog.length > 20) page.consoleLog.splice(0, page.consoleLog.length - 20);
      if (details.level !== "error" || this.page !== page) return;
      this.reportError(page, "runtime", details.message);
    });
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // -3 ERR_ABORTED is a navigation superseding itself, not a failure.
        if (!isMainFrame || errorCode === -3) return;
        page.failed = true;
        if (this.page !== page) return;
        this.reportError(
          page,
          "build",
          `${errorDescription ?? "화면을 불러오지 못했습니다"} (${errorCode})`,
          validatedURL,
        );
      },
    );
    contents.on("render-process-gone", (_event, details) => {
      page.failed = true;
      if (this.page !== page) return;
      this.reportError(
        page,
        "runtime",
        `미리보기 프로세스가 죽었습니다 (${details?.reason ?? "unknown"})`,
      );
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
      this.send("colo-preview:key", {
        key: input.key,
        meta: Boolean(input.meta),
        shift: Boolean(input.shift),
        alt: Boolean(input.alt),
        control: Boolean(input.control),
      });
    });
  }

  private reportError(
    page: PreviewPage,
    kind: ColoDesignErrorEnvelope["kind"],
    message: string,
    at?: string,
  ): void {
    let route = "";
    let state = "default";
    try {
      const url = new URL(at ?? page.view.webContents.getURL());
      route = url.pathname.replace(/^\//, "");
      state = url.searchParams.get("state") ?? "default";
    } catch {
      // A URL that will not parse has no screen to name; the message stands.
    }
    this.send("colo-preview:error", {
      type: "colo-design.error",
      kind,
      message,
      route,
      state,
    });
  }

  private sendLocation(page: PreviewPage): void {
    const contents = page.view.webContents;
    let path = "/";
    try {
      const parsed = new URL(contents.getURL());
      path = `${parsed.pathname}${parsed.search}`;
    } catch {
      // Keep "/" — an unparseable url still deserves a back button state.
    }
    this.send("colo-preview:location", {
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
  // Routed by sender: a parked page's bridge may speak (its own reload) and
  // must reach its own page's facts, never the renderer.
  ipcMain.on("colo-overlay:post", (event, payload: { type?: unknown }) => {
    view.onOverlayPost(event.sender, payload);
  });
  ipcMain.on("colo-overlay:capture-done", (event) => {
    if (event.sender !== view.webContents()) return;
    view.onCaptureDone();
  });
  ipcMain.handle("preview:mount", (_event, input: unknown) => {
    if (!input || typeof input !== "object" || !("url" in input) || typeof input.url !== "string") {
      return { ok: true };
    }
    const epoch = "epoch" in input && typeof input.epoch === "number" ? input.epoch : null;
    view.mount(input.url, epoch);
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
      ["x", "y", "width", "height"].every(
        (key) => typeof input[key as keyof typeof input] === "number",
      )
    ) {
      const rect = input as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      view.setBounds(rect);
    }
    return { ok: true };
  });
  // The assertion is applied before this returns (the capture rides behind),
  // so the renderer's ack means "the view is already hidden" — that contract
  // is what lets the web side treat a resolved call as confirmed state.
  ipcMain.handle("preview:cover", (_event, input: { on?: boolean }) => {
    view.cover(Boolean(input?.on));
    return { ok: true };
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
  ipcMain.handle("preview:stop", () => {
    view.stop();
    return { ok: true };
  });
  ipcMain.handle("preview:zoom", (_event, input: { kind?: string }) => {
    if (input?.kind === "in") view.zoomIn();
    else if (input?.kind === "out") view.zoomOut();
    else view.zoomReset();
    return { ok: true };
  });
  ipcMain.handle("preview:comments-mode", (_event, input: { on?: boolean }) => {
    view.commentsMode(Boolean(input?.on));
    return { ok: true };
  });
  // 재설계 C1: the web pushes the whole pin list; the overlay's badges are
  // its projection. Idempotent — the web resends it on every change and
  // after a page load.
  ipcMain.handle("preview:pins", (_event, sync: ColoDesignPinsSync) => {
    view.syncPins(sync);
    return { ok: true };
  });
  ipcMain.handle("preview:pin-flash", (_event, input: { id?: unknown }) => {
    if (typeof input?.id === "string") view.pinFlash(input.id);
    return { ok: true };
  });
  ipcMain.handle("preview:snapshot", () => view.snapshot());
  ipcMain.handle("preview:emulate", (_event, input: { width?: unknown }) => {
    const width = input?.width;
    view.emulate(width === "mobile" || width === "tablet" ? width : null);
    return { ok: true };
  });
}
