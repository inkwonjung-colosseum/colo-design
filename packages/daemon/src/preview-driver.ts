/**
 * The preview driver contract (게이트 재배선 2026-09-17): the one window the
 * daemon borrows to LOOK at the connected repo's running app. Its consumers
 * are the screen gate (턴 끝 재검증), the handoff captures and the 화면
 * 캡처 — no agent tool surface remains; the desktop injects a factory, the
 * browser dev path injects nothing and a gate simply never fires.
 */

/** One screen the connected repo declares, as its overlay reports it. */
export interface PreviewScreenDeclaration {
  route: string;
  title: string;
  states: string[];
}

/** The widths a screen can be looked at in — the 폭 toggle's, shared. */
export type PreviewViewport = "mobile" | "tablet" | "desktop";

/** How the window is set up before a screen loads. */
export interface PreviewOpenOptions {
  viewport?: PreviewViewport;
  colorScheme?: "light" | "dark";
}

/**
 * What `open` answers. `settled` false means the page loaded but the screen's
 * own `data-state` marker never appeared — the check that follows may be of a
 * half-built screen, and the gate says so instead of pretending.
 */
export type PreviewOpenResult = { ok: true; settled: boolean } | { ok: false; reason: string };

/** One line of what the page said — console levels, plus `net`. */
export interface PreviewConsoleLine {
  level: string;
  text: string;
}

/**
 * One capture. The driver owns the encoder, so it says what the bytes are —
 * a caller that assumed a format would mislabel the picture (and the handoff
 * would commit it under the wrong extension).
 */
export interface PreviewCapture {
  /** base64, no data-url prefix. */
  data: string;
  mediaType: string;
}

/**
 * The one window the daemon looks through. Implemented by the desktop with
 * an offscreen `BrowserWindow` (or the on-screen pane); unit tests implement
 * it with a fake.
 */
export interface PreviewDriver {
  /** Show `<baseUrl><route>` (and `?state=` when a state is named). */
  open(
    route: string,
    state: string | null,
    options?: PreviewOpenOptions,
  ): Promise<PreviewOpenResult>;
  /**
   * One picture of the window, downscaled so its long edge is `longEdge`.
   * Scaling happens AT capture time — a re-encode after the fact bakes one
   * generation's artifacts into the next.
   */
  screenshot(options?: { longEdge?: number }): Promise<PreviewCapture>;
  /** Console and network trouble since the last `open`. */
  consoleLines(): Promise<PreviewConsoleLine[]>;
  destroy(): Promise<void>;
}

export interface PreviewDriverFactory {
  /**
   * `baseUrl` is the preview server; `allowedOrigins` are the extra origins
   * the repo declared (`colo-design.json` preview.origins) that this window
   * may also open. The pane's driver when one is on screen.
   */
  for(baseUrl: string, allowedOrigins?: string[]): PreviewDriver;
  /**
   * A driver for verification work (the screen gate, handoff captures) —
   * always an isolated window, never the pane the user is driving:
   * re-opening the user's own screen would steal their view.
   */
  forIsolated(baseUrl: string, allowedOrigins?: string[]): PreviewDriver;
}
