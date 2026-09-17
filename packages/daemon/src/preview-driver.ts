/**
 * The preview driver contract (게이트 재배선 2026-09-17): the one window the
 * daemon borrows to LOOK at the connected repo's running app. Its consumers
 * are the screen gate (턴 끝 재검증), the handoff captures and the 화면
 * 캡처 — the desktop injects a factory, the browser dev path injects nothing
 * and a gate simply never fires. 인앱 브라우저 2단계(계획 §4-2)부터 이 모듈은
 * 두 번째 계약 — 에이전트가 pane 탭을 만지는 `BrowserDriver` — 도 선언한다.
 */
import type { PreviewTabMeta } from "@colo-design/protocol";

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

/** One line of what the page said — console levels, plus `net` and `dialog`. */
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

// ---------------------------------------------------------------------------
// 인앱 브라우저 (계획 §4-2): 에이전트와 사용자가 같은 탭을 쓰는 드라이버
// 계약. 게이트용 `PreviewDriver` 가 화면을 "본다" 면, 이쪽은 "만진다" —
// 접근성 스냅샷과 ref 액션. 07bd3bf 의 화면 도구(PreviewAxNode · ref 세대 ·
// 액션 뒤 스냅샷)가 모태이며, 1단계의 탭 모델 위에 tabId 주소를 얹었다.
// 구현은 데스크톱(PaneBrowserDriver)만 한다 — 데몬은 Electron 을 모른다.
// ---------------------------------------------------------------------------

/**
 * 접근성 트리 한 노드 (07bd3bf 계승). `ref`(`e12`)는 한 스냅샷 세대 안에서만
 * 산다 — 액션과 다음 스냅샷이 세대를 갈아치우므로, 낡은 ref 는 "다시 읽으라"
 * 는 오류가 된다. 엉뚱한 곳을 누르는 일을 세대가 막는다.
 */
export interface PreviewAxNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states: string[];
  children: PreviewAxNode[];
}

/** The browser the agent shares with the user. `tabId` 생략은 언제나 활성 탭. */
export interface BrowserDriver {
  listTabs(): Promise<PreviewTabMeta[]>;
  getActiveTabId(): Promise<string | null>;
  openTab(
    url: string,
    opts?: { background?: boolean },
  ): Promise<{ tabId: string; settled: boolean }>;
  closeTab(tabId?: string): Promise<void>;
  activateTab(tabId: string): Promise<void>;
  cycleActiveTab(delta: -1 | 1): Promise<void>;
  navigate(url: string, tabId?: string): Promise<{ settled: boolean }>;
  back(tabId?: string): Promise<void>;
  forward(tabId?: string): Promise<void>;
  snapshot(tabId?: string): Promise<PreviewAxNode[]>;
  screenshot(opts?: { tabId?: string; ref?: string; longEdge?: number }): Promise<PreviewCapture>;
  click(target: { ref: string }, tabId?: string): Promise<PreviewAxNode[]>;
  type(
    input: { ref: string; text: string; clear?: boolean },
    tabId?: string,
  ): Promise<PreviewAxNode[]>;
  press(key: string, tabId?: string): Promise<PreviewAxNode[]>;
  scroll(target: { ref?: string; dy: number }, tabId?: string): Promise<PreviewAxNode[]>;
  hover(target: { ref: string }, tabId?: string): Promise<PreviewAxNode[]>;
  select(target: { ref: string; value: string }, tabId?: string): Promise<PreviewAxNode[]>;
  drag(target: { fromRef: string; toRef: string }, tabId?: string): Promise<PreviewAxNode[]>;
  consoleLines(tabId?: string): Promise<PreviewConsoleLine[]>;
  evaluate(fn: string, tabId?: string): Promise<unknown>;
  waitFor(target: { text?: string; url?: string; ms?: number }, tabId?: string): Promise<boolean>;
  destroy(): Promise<void>;
}

export interface BrowserDriverFactory {
  /**
   * pane 이 화면에 있으면 그 브라우저 드라이버, 없으면 null — 숨은 창 폴백은
   * 없다. 에이전트의 브라우저 도구는 사용자가 보는 탭만 drive 한다; 사용자가
   * 없는 화면을 몰래 여는 것은 공유 브라우저의 약속을 깬다.
   */
  forPane(): BrowserDriver | null;
}
