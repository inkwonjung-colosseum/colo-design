import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ColoDesignErrorEnvelope,
  ColoDesignPinEnvelope,
  ColoDesignPinsSync,
  PreviewTabMeta,
} from "@colo-design/protocol";
import { type BrowserWindow, ipcMain, shell, type WebContents, WebContentsView } from "electron";
import { VIEWPORT_METRICS } from "./emulation.js";

/**
 * 사용자의 미리보기 뷰 (PLAN D64 — D60 개봉; 인앱 브라우저 1단계로 탭 모델).
 * The planner's preview pane is the app's own browser view: a
 * `WebContentsView` laid over the web UI's stage slot, so the address ·
 * history · errors · the comment-pin overlay (D67, in the preload) are the
 * tool's, not the connected repo's.
 *
 * TABS, WITH THE STRIP'S METALIST SEPARATE FROM THE BODIES(§3 규칙 3).
 * `tabList` 는 스트립이 그리는 순서 있는 메타, `livePages` 는 WebContents 를
 * 쥔 몸통 — 최대 8개(`MAX_LIVE_TABS`), 넘치는 것부터 LRU 로 discard 한다
 * (WebContents 만 죽고 메타는 남는다). 화면에는 늘 한 탭: a project switch
 * parks the preview tab it leaves (hidden, alive, exactly where the planner
 * was) and shows the tab of the project it goes to. Coming back is a
 * repaint, never a reload; the daemon keeps the servers warm for the same
 * reason. Only the tab on screen speaks to the renderer; a parked tab keeps
 * its own facts for the return. kind 는 URL 이 정한다 — repo 레지스트리
 * origin 위면 `preview`(repo 오버레이가 무장), 그 밖의 http(s) 로밍이면 `web`.
 *
 * The view is ALWAYS above renderer DOM (D65) — `cover()` hides it behind a
 * captured freeze frame whenever a modal-like layer opens. 페이지가 스스로
 * 하는 이동은 http(s) 인지만 `will-navigate` 가 가드하고(`loadURL` 과 history
 * 는 이 이벤트를 끄지 않는다 — Electron docs), 어느 종류의 탭이 됐는지는
 * `did-navigate` 가 레지스트리로 다시 정한다.
 *
 * The repo bridge contract (D68) is `colo-design.navigate`: a pin's 화면
 * 이동이 이 한 봉투로 간다 — the screens envelope that once marked the
 * bridge `present` is gone, so navigate always rides a plain load.
 * `preview-claude` (D61, the offscreen Claude window) keeps its own partition.
 *
 * 재설계 C4 has the view crop each pin's element (`element.rect`) at pin
 * time — the envelope that reaches the web already carries the shot; D89
 * keeps the last 20 console lines for the 화면 보여 주기 turn.
 */

/** The in-view preload, compiled to CommonJS beside this module. */
const PREVIEW_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), "preview-preload.cjs");

/** 폭 toggle presets live beside the agent.s window — see emulation.ts. */

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

/** The origin of a url, or "" when it does not parse — never throws. */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
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
 * The one scheme a renderer-supplied origin may carry — a mount url or a
 * repo-allowed origin that is not http(s) (file:, a custom handler) is
 * refused before it can aim the view anywhere.
 */
function httpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget load: the rejection is already reported — the page's
 * `did-fail-load` handler owns the error banner, so the promise's only job
 * left is not crashing as an unhandled rejection.
 */
function navigate(contents: WebContents, url: string): void {
  void contents.loadURL(url).catch(() => undefined);
}

/**
 * OS 에 넘긴다 — pane 이 보여줄 수 없거나(슬롯이 없다) 보여주면 안 되는
 * 스킴(mailto: 같은 웹의 일상 동작)을 브라우저·메일 앱이 대신 연다.
 * file: 만은 웹 콘텐츠가 로컬 파일을 겨냥하지 못하도록 막는다.
 */
function openInOs(url: string): void {
  try {
    if (new URL(url).protocol === "file:") return;
    void shell.openExternal(url).catch(() => undefined);
  } catch {
    // 파싱이 안 되는 url 에는 열어줄 스킴도 없다
  }
}

/**
 * 이 pane 이 한 번에 살려 두는 탭 수 — 화면의 것과 뒤에 대기 중인 것까지.
 * 하나하나가 렌더러 프로세스라 이 cap 이 사이드바 클릭의 비용을 묶는다.
 * 넘치는 것은 LRU 로 버린다(discard) — WebContents 만 죽고 메타는 스트립에
 * 남아, 다시 활성화되면 lastUrl 로 되살아난다.
 */
const MAX_LIVE_TABS = 8;

/** 탭의 종류 — repo 가 선언한 origin 위면 `preview`, 그 밖의 http(s) 로밍이면 `web`. */
type PreviewKind = "preview" | "web";

/**
 * 스트립이 그리는 탭 한 칸. 계약의 `PreviewTabMeta` 에 파비콘 하나를 얹었다 —
 * §4-1 이 `page-favicon-updated` 를 탭 메타 갱신으로 돌리기 때문이다. 메타는
 * 뷰가 소유하고 WebContents 를 함께 보유하지 않는다(버려진 탭도 메타뿐).
 */
interface TabMeta extends PreviewTabMeta {
  /** 페이지가 마지막으로 말한 파비콘 — 스트립 장식. 계약 밖의 덧붙임. */
  favicon: string | null;
}

/**
 * 한 탭의 살아 있는 전부: 뷰와, 이 탭에 대해 pane 이 아는 것. `meta` 는
 * tabList 와 함께 보는 한 벌 — kind·title·url·discarded 는 여기서만 바꾸면
 * 스트립과 실제 페이지가 어긋나지 않는다.
 */
interface PreviewPage {
  /** 스트립 id("t1"…) — livePages 의 열쇠이자 명령의 대상. */
  readonly id: string;
  /** 스트립이 그리는 메타 — tabList 의 원소와 같은 객체다. */
  readonly meta: TabMeta;
  /**
   * 지금 머무는 origin. preview 탭은 마운트 origin 에 닿으면 고정되지만 web
   * 탭은 did-navigate 마다 다시 정해진다 — kind 도 그때 repo 레지스트리로
   * 재계산한다(§3 규칙 5).
   */
  origin: string;
  readonly view: WebContentsView;
  /** The server process the page was loaded from (RepoStatus.previewEpoch). */
  epoch: number | null;
  /** What the page is showing — a repeat mount or open must not reload. */
  mountedUrl: string | null;
  /** The last main-frame load failed, or the renderer died — a return reloads. */
  failed: boolean;
  /** The zoom the page is at (D85 ⓔ) — steps clamp into [0.5, 2]. */
  zoomFactor: number;
  /** D89: the last 20 console lines, for the 화면 보여 주기 turn. */
  readonly consoleLog: string[];
  /** When the page was last on screen — the cap ends the ones left longest ago. */
  shownAt: number;
  /**
   * 규칙 6: 이 탭이 마지막으로 마운트/활성화된 시점의 allowedOrigins. 뷰 전역
   * 값이 낡아 프로젝트 전환 뒤 parked 탭을 오분류하는 일을 탭 스냅샷이 막는다.
   */
  originSnapshot: string[];
}

export class PlannerPreviewView {
  /** WebContents 를 쥔 탭들 — tabId 가 열쇠. 버려진 탭은 여기서 빠지고 메타만 남는다. */
  private readonly livePages = new Map<string, PreviewPage>();
  /** 스트립의 순서 있는 메타 — livePages 와 짝을 이루는 이중 구조(§3 규칙 3). */
  private readonly tabList: TabMeta[] = [];
  /**
   * 화면에 올라와 있는 탭 — 곧 스트립의 활성 선택. null 은 pane 이 접힌 상태다
   * (카드가 서 있거나 마지막 탭이 닫혔다). park/discard 가 이 id 를 지우고
   * show() 가 다시 세운다 — "스트립의 활성"과 "실제로 보이는 탭"을 한 값이
   * 함께 말한다.
   */
  private activeTabId: string | null = null;
  /** 다음 스트립 id — "t1"부터. 닫힌 id 는 재활용하지 않는다. */
  private tabSeq = 0;
  /**
   * repo 레지스트리(§3 규칙 4·5): 마운트된 origin 과 그때의 epoch·뿌리 url.
   * kind 재계산, 중복 탭 금지, did-navigate 때의 epoch 정산이 전부 이 맵 하나를
   * 본다 — 마운트가 유일한 쓰는 곳이라 프로젝트가 바뀌면 저절로 다시 쓰인다.
   */
  private readonly mounts = new Map<string, { epoch: number | null; url: string }>();
  /** The slot's rect as the renderer last measured it — a page shown later takes it. */
  private bounds: Electron.Rectangle | null = null;
  private covered = false;
  /** The last 💬 state — a fresh load, or a returning page, is re-told it (D67). */
  private commentsOn = false;
  /** The web's last pin sync (재설계 C1) — a page that loads or returns is re-told it. */
  private lastPins: ColoDesignPinsSync | null = null;
  /** Resolved when the overlay acknowledges a capture hide/show (D87). */
  private captureAck: (() => void) | null = null;

  constructor(private readonly window: () => BrowserWindow | null) {}

  /**
   * Extra origins the repo allows (`colo-design.json` preview.origins),
   * refreshed by every mount — a project switch rewrites the list with the
   * page. Empty means the pane shows the preview server alone. 가드는 이 값을
   * 직접 읽지 않는다: 각 탭이 활성화 시점의 스냅샷을 따로 쥔다(규칙 6).
   */
  private allowedOrigins: string[] = [];

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
  mount(url: string, epoch: number | null, origins?: string[]): void {
    // Renderer-supplied, both: origins keep only http(s) entries, and a url
    // that is neither loopback nor http(s) never reaches the view.
    this.allowedOrigins = (origins ?? this.allowedOrigins).filter(httpUrl);
    if (!httpUrl(url)) return;
    const origin = new URL(url).origin;
    if (!loopbackHttp(url) && !this.allowedOrigins.includes(origin)) return;
    // 레지스트리에 올라간 순간부터 이 origin 은 repo 의 것 — 이후의 kind
    // 재계산과 중복 탭 금지가 이 한 줄 위에 선다(§3 규칙 4·5).
    this.mounts.set(origin, { epoch, url });
    // repo origin 은 탭 하나뿐이다: 있는 탭은 (버려진 메타라도) 데워 쓰고,
    // 없을 때만 만든다. driveTo·mount idempotency 가 이 유일성 위에 서 있다.
    const existing = this.findTabAtOrigin(origin);
    if (existing) {
      this.activateTab(existing.id);
      const page = this.livePages.get(existing.id);
      if (page) {
        page.meta.kind = "preview";
        this.refresh(page, url, epoch);
      }
      return;
    }
    const page = this.createTab(url, "preview", origin, epoch);
    this.activateTab(page.id);
    this.evictParked();
    this.load(page, url);
  }

  /**
   * A page on screen against the server that answers now. A moved epoch is a
   * different process — the app behind the port may be another project's,
   * so the page starts over at the root; a failed last load (the server was
   * down, the renderer died) retries where it was. Otherwise the page is
   * already right and nothing loads. 탭 단위로 정산된다 — 옆 탭의 epoch 은
   * 이 판정에 못 끼난다.
   */
  private refresh(page: PreviewPage, url: string, epoch: number | null): void {
    const moved = epoch !== null && page.epoch !== null && page.epoch !== epoch;
    if (epoch !== null) page.epoch = epoch;
    if (moved) {
      page.failed = false;
      page.mountedUrl = url;
      page.meta.url = url;
      navigate(page.view.webContents, url);
    } else if (page.failed) {
      page.failed = false;
      navigate(page.view.webContents, page.mountedUrl ?? url);
    }
  }

  /**
   * A link the planner clicked (설정 `앱에서 링크 열기`) or a popup a page
   * raised. repo 레지스트리의 origin 이면 mount 경로에 위임한다 — 중복 탭 없이
   * 기존 탭이 activate+refresh 된다(규칙 4). 그 밖의 http(s) 는 항상 새 web 탭,
   * 포그라운드로. 슬롯이 없으면(카드가 서 있으면) pane 이 그릴 면이 없으므로
   * OS 브라우저가 대신 본다.
   */
  openTab(url: string): void {
    if (!httpUrl(url)) return;
    const bounds = this.bounds;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      openInOs(url);
      return;
    }
    if (this.isRepoOrigin(new URL(url).origin)) {
      this.mount(url, null);
      return;
    }
    this.newTab(url);
  }

  /** ⌘T·popup·주소창의 새 탭 — web 으로 태어나 스트립 끝에, 포그라운드로 선다. */
  newTab(url?: string): void {
    const target = url && httpUrl(url) ? url : null;
    const page = this.createTab(target, "web", target ? safeOrigin(target) : "about:blank", null);
    this.activateTab(page.id);
    this.evictParked();
    if (target) this.load(page, target);
  }

  /** 스트립의 그 탭을 화면에 세운다 — 버려진 탭이면 lastUrl 로 되살린다. */
  activateTab(tabId: string): void {
    const meta = this.tabList.find((tab) => tab.id === tabId);
    if (!meta) return;
    let page = this.livePages.get(tabId) ?? null;
    if (!page) {
      page = this.resurrect(meta);
      // 버려진 탭의 재로드(§3 규칙 3): 마지막 주소로 돌아간다. 버려진 동안의
      // epoch 은 메타에 없으므로 레지스트리의 것을 새로 받는 것이 곧 epoch 검사다
      // — 서버가 다시 시작했어도 이 판은 그 사실을 받으며 시작한다.
      const mount = this.mounts.get(page.origin);
      const url = page.meta.url ?? mount?.url ?? `${page.origin}/`;
      this.refresh(page, url, mount ? mount.epoch : null);
      this.load(page, url);
    }
    // 규칙 6: 활성화되는 시점의 스냅샷 — 이미 활성인 탭도 다시 마운트되며
    // 허용 목록이 바뀌었을 수 있으니 조건 없이 다시 찍는다.
    page.originSnapshot = [...this.allowedOrigins];
    if (meta.id === this.activeTabId && this.attached(page)) return;
    this.show(page);
  }

  /**
   * 탭 닫기 — discard 와 다르다: WebContents 파기에 메타 제거까지. 생략하면
   * 활성 탭. 마지막 탭이 닫히면 pane 은 앉을 자리를 잃는다(unmount 상태).
   * 활성을 닫았을 때의 새 활성은 스트립의 관례를 따른다 — 오른쪽, 끝이면 왼쪽.
   */
  closeTab(tabId?: string): void {
    const id = tabId ?? this.activeTabId;
    if (!id) return;
    const index = this.tabList.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    // discard 가 활성을 지우기 전에 기억한다 — 활성을 닫았을 때만 이웃이 뒤를
    // 잇는다. 접힌 pane 에서 뒤편 탭을 닫는 일이 화면을 세우면 안 된다.
    const closingActive = this.activeTabId === id;
    const page = this.livePages.get(id) ?? null;
    if (page) this.discard(page);
    this.tabList.splice(index, 1);
    if (this.tabList.length === 0) {
      this.activeTabId = null;
      this.sendTabs();
      return;
    }
    if (closingActive) {
      const next = this.tabList[Math.min(index, this.tabList.length - 1)];
      if (next) this.activateTab(next.id);
      return;
    }
    this.sendTabs();
  }

  /**
   * ⌘⇧[ / ⌘⇧] 의 몸통 — 스트립에서 앞뒤 탭으로, 끝에서는 돌아 간다. 접힌
   * pane 은 건드리지 않는다: 메뉴 가속키는 pane 밖에서도 불린다.
   */
  cycleActiveTab(delta: -1 | 1): void {
    if (this.tabList.length < 2 || this.activeTabId === null) return;
    const index = this.tabList.findIndex((tab) => tab.id === this.activeTabId);
    const next = this.tabList[(index + delta + this.tabList.length) % this.tabList.length];
    if (next) this.activateTab(next.id);
  }

  /** 스트립이 그리는 목록 그대로 — 사본을 내준다(호출자가 못 고치게). */
  listTabs(): PreviewTabMeta[] {
    return this.tabList.map((tab) => ({ ...tab }));
  }

  /** 지금 화면의 탭 id — `preview:tabs` 응답의 절반이다. */
  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  /** The live webContents of the page on screen — the desktop suite drives the overlay through it. */
  webContents(): WebContents | null {
    const contents = this.active()?.view.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  /** 화면의 탭 — activeTabId 로 livePages 를 조회하는 헬퍼(this.page 의 후임). */
  private active(): PreviewPage | null {
    return this.activeTabId ? (this.livePages.get(this.activeTabId) ?? null) : null;
  }

  /**
   * 레지스트리에 오른 origin, 또는 지금 preview 탭이 머무는 origin — repo 의
   * 것으로 인정한다(규칙 4). kind 재계산과 openTab 의 위임 판정이 함께 쓴다.
   * `except` 는 지금 판정 중인 탭 자신 — origin 을 먼저 채워 놓고 부르면
   * 스스로를 근거로 자기 새 origin 을 repo 것으로 인정하는 자기 부합에 빠진다.
   */
  private isRepoOrigin(origin: string, except?: PreviewPage): boolean {
    if (this.mounts.has(origin)) return true;
    for (const page of this.livePages.values()) {
      if (page === except) continue;
      if (page.meta.kind === "preview" && page.origin === origin) return true;
    }
    return false;
  }

  /**
   * 규칙 4: repo origin 은 탭 하나. 산 탭을 먼저, 없으면 버려진 메타를 —
   * activateTab 이 버려진 탭을 되살리므로 호출자는 id 만 받아 쓴다.
   */
  private findTabAtOrigin(origin: string): TabMeta | null {
    for (const page of this.livePages.values()) {
      if (page.origin === origin) return page.meta;
    }
    for (const tab of this.tabList) {
      if (tab.discarded && tab.url && safeOrigin(tab.url) === origin) return tab;
    }
    return null;
  }

  /**
   * Takes the pane off screen — the slot is gone (a project switch, a card in
   * the pane's place, the server died). park 은 활성이 preview 탭일 때만:
   * 사용자가 있던 곳이 프로젝트 화면일 때만 '그대로 돌아옴'을 약속한다.
   * 활성이 web 탭이면 버린다(discard) — 링크의 나라는 메타만 스트립에 남기고
   * WebContents 는 놓아준다. 뒤에 대기 중이던 탭들은 애초에 화면 밖이다.
   */
  unmount(): void {
    const page = this.active();
    if (!page) return;
    if (page.meta.kind === "preview") this.park(page);
    else this.discard(page);
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    };
    this.active()?.view.setBounds(this.bounds);
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
    const page = this.active();
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
      if (image.isEmpty() || !this.covered || this.activeTabId !== page.id) return;
      this.send("colo-preview:freeze", image.toJPEG(70).toString("base64"));
    } catch {
      // A paint that never happened; the slot shows the pane background.
    }
  }
  /**
   * The address bar's word (규칙 9) — the ACTIVE tab carries it. 같은 origin
   * 이면 그 탭 안에서, 활성이 web 탭이면 http(s) 어디든 그 탭 안에서 논다.
   * 활성이 preview 탭일 때의 건너편은 둘로 갈린다: repo 레지스트리(또는 이번
   * 프로젝트가 허용한) origin 이면 mount 경로로, 그 밖의 전체 URL 은 새 web 탭.
   */
  open(path: string): void {
    const page = this.active();
    if (!page) return;
    let url: URL;
    try {
      url = new URL(path, page.origin);
    } catch {
      return;
    }
    if (url.origin === page.origin) {
      this.load(page, url.toString());
      return;
    }
    if (!httpUrl(url.toString())) return;
    if (page.meta.kind === "web") {
      // web 탭은 이미 링크의 나라 — 주소창도 같은 탭에서 갈아탄다.
      this.load(page, url.toString());
      return;
    }
    if (this.isRepoOrigin(url.origin) || this.allowedOrigins.includes(url.origin)) {
      this.mount(url.toString(), null);
      return;
    }
    this.newTab(url.toString());
  }

  /**
   * A pin's 화면 이동 (D66): a plain load — the screens envelope that once
   * marked the bridge `present` is gone, so client routing is too. 주소창과
   * 달리 여기서 새 탭을 만들지 않는다: 이 말은 repo 의 것이라 repo 의 origin
   * 밖으로 나가지 않는다.
   */
  navigate(route: string, state: string | null): void {
    const page = this.active();
    if (!page) return;
    let url: URL;
    try {
      url = new URL(route, page.origin);
    } catch {
      return;
    }
    // open() refuses off-origin urls; a pin's route must not slip past that
    // by carrying an absolute route. A repo-allowed origin is the one
    // exception: it mounts as its own page.
    if (url.origin !== page.origin) {
      if (this.allowedOrigins.includes(url.origin)) {
        this.mount(url.toString(), null, this.allowedOrigins);
      }
      return;
    }
    if (state) url.searchParams.set("state", state);
    this.load(page, url.toString());
  }
  /**
   * The agent's navigation (PanePreviewDriver): a real load, awaited — never
   * the bridge's client routing, because the driver needs a document it can
   * wait on. A repo-allowed foreign origin mounts as its own page, same as
   * `open`. Returns false when the load failed or the url is not allowed.
   */
  async driveTo(url: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const page = this.active();
    if (!page) return false;
    if (parsed.origin !== page.origin) {
      // A link page is on screen: the agent's drive pulls the pane back to
      // the project — mount refits the page for the preview origin. web 탭은
      // loopback(다른 프로젝트의 서버 포함)까지 받는다 — 링크를 타고 온 탭이
      // 에이전트의 drive 로 repo 쪽으로 걸어 들어오는 길이다.
      const allowed =
        page.meta.kind === "web"
          ? loopbackHttp(url) || this.allowedOrigins.includes(parsed.origin)
          : this.allowedOrigins.includes(parsed.origin);
      if (!allowed) return false;
      this.mount(url, null, this.allowedOrigins);
      const mounted = this.active();
      if (!mounted || mounted.origin !== parsed.origin) return false;
      const contents = mounted.view.webContents;
      if (!contents.isLoading()) return !mounted.failed;
      return await new Promise<boolean>((resolve) => {
        const onFinish = () => settle(true);
        const onFail = (
          _event: Electron.Event,
          errorCode: number,
          _errorDescription: string,
          _validatedURL: string,
          isMainFrame: boolean,
        ) => {
          // The permanent handler's filter: a subframe's failure, or a
          // navigation superseding itself (-3 ERR_ABORTED), is not this
          // load's verdict — `once` would drop the listener on either.
          if (!isMainFrame || errorCode === -3) return;
          settle(false);
        };
        const settle = (ok: boolean) => {
          clearTimeout(timer);
          contents.off("did-finish-load", onFinish);
          contents.off("did-fail-load", onFail);
          resolve(ok);
        };
        const timer = setTimeout(() => settle(false), 30_000);
        contents.once("did-finish-load", onFinish);
        contents.on("did-fail-load", onFail);
      });
    }
    page.mountedUrl = url;
    page.failed = false;
    try {
      await page.view.webContents.loadURL(url);
      return true;
    } catch {
      page.failed = true;
      return false;
    }
  }

  /**
   * Loads a url the page is not already at. The same address asked again (a
   * re-submitted bar, an ask re-riding a remount) is a no-op, not a reload —
   * 새로 고침 is the one word for that.
   */
  private load(page: PreviewPage, url: string): void {
    if (page.mountedUrl === url && !page.failed) return;
    page.mountedUrl = url;
    page.meta.url = url;
    page.failed = false;
    navigate(page.view.webContents, url);
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
    this.setZoom((this.active()?.zoomFactor ?? 1) + 0.2);
  }

  zoomOut(): void {
    this.setZoom((this.active()?.zoomFactor ?? 1) - 0.2);
  }

  zoomReset(): void {
    this.setZoom(1);
  }

  private setZoom(factor: number): void {
    const page = this.active();
    if (!page || page.view.webContents.isDestroyed()) return;
    const clamped = Math.min(2, Math.max(0.5, factor));
    page.view.webContents.setZoomFactor(clamped);
    page.zoomFactor = clamped;
    this.send("colo-preview:zoom", { factor: clamped });
  }

  /** The preview origin on screen — the main window's popup gate. */
  getOrigin(): string | null {
    return this.active()?.origin ?? null;
  }

  commentsMode(on: boolean): void {
    this.commentsOn = on;
    // 오버레이는 repo 의 말 — web 탭에는 닿지 않는다(kind 가 external 의 자리를
    // 대신한다). 다시 preview 탭이 활성되면 show/did-navigate 가 재무장한다.
    if (this.active()?.meta.kind !== "preview") return;
    this.webContents()?.send("colo-overlay:mode", { on });
  }

  /**
   * 재설계 C1: the web's whole pin list is the truth — remember it so a page
   * that loads or comes back from a park is re-told it, and project it onto
   * the overlay (the badges redraw from this).
   */
  syncPins(sync: ColoDesignPinsSync): void {
    this.lastPins = sync;
    if (this.active()?.meta.kind !== "preview") return;
    this.webContents()?.send("colo-overlay:pins", sync);
  }

  /** 재설계 C1: the web's chip click — the matching badge on the page flashes. */
  pinFlash(id: string): void {
    if (this.active()?.meta.kind !== "preview") return;
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
    contents.send("colo-overlay:capture", { on: true });
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
      contents.send("colo-overlay:capture", { on: false });
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
    const page = this.active();
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
        // Region pins record PAGE coordinates (scroll left in, 재설계 C9) —
        // the crop clamps against viewport space, so the scroll comes out.
        let rect = payload.pin.element.rect;
        if (payload.pin.element.kind === "region") {
          try {
            const scroll = (await contents.executeJavaScript(
              "({ x: window.scrollX, y: window.scrollY })",
              true,
            )) as { x?: unknown; y?: unknown } | null;
            if (typeof scroll?.x === "number" && typeof scroll?.y === "number") {
              rect = { ...rect, x: rect.x - scroll.x, y: rect.y - scroll.y };
            }
          } catch {
            // No scroll read → the recorded rect stands; a miss crops wrong,
            // never crashes.
          }
        }
        const crop = cropRect(rect, this.viewportCss());
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
      console: [...(this.active()?.consoleLog ?? [])],
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
   * One envelope from a page's preload (D68): a pin (재설계 C1).
   * Registered once per app, not per page, so pages coming and going never
   * stack listeners. A parked page's envelope updates its own facts and
   * stops there — the renderer hears only the page on screen.
   */
  onOverlayPost(sender: WebContents, payload: { type?: unknown }): void {
    const page = this.pageOf(sender);
    // web 탭도 preload 를 함께 실어 다니지만 bridge 는 repo 의 것이 아니다:
    // 링크 너머 페이지의 "pin" 은 통째로 버린다(kind 가 external 의 자리를
    // 대신한다).
    if (!page || page.meta.kind !== "preview") return;
    const type = typeof payload?.type === "string" ? payload.type : "";
    if (type === "colo-design.pin" && this.activeTabId === page.id) {
      // inside is logged, never an unhandled rejection.
      void this.relayPin(payload as ColoDesignPinEnvelope).catch((error) => {
        console.error("preview pin relay failed", error);
      });
    } else if (type === "colo-design.pin-focus" && this.activeTabId === page.id) {
      this.send("colo-preview:pin-focus", payload);
    }
  }

  // ------------------------------------------------------------------ internals

  /** sender → 탭. 버려진 탭의 sender 는 죽었으므로 산 탭만 돌면 그만이다. */
  private pageOf(sender: WebContents): PreviewPage | null {
    for (const page of this.livePages.values()) {
      if (page.view.webContents === sender) return page;
    }
    return null;
  }

  /**
   * 탭의 몸통을 짓는다 — WebContentsView 와 PreviewPage. 메타는 이미 있는
   * 것을 받는다(새 탭이면 createTab 이, 되살림이면 resurrect 가 쥔다).
   * partition 은 이제 "persist:preview" 다: 예전엔 접두 없는 "preview" 라서
   * in-memory 세션이었고 재시작마다 로그인이 증발했다. persist 전환의 목적은
   * 임의 사이트의 로그인이 탭과 함께 남는 것(§3 규칙 2) — 파티션은 preview·web
   * 탭이 같이 쓴다.
   */
  private buildPage(meta: TabMeta, origin: string, epoch: number | null): PreviewPage {
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:preview",
        sandbox: true,
        contextIsolation: true,
        preload: PREVIEW_PRELOAD,
      },
    });
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    const page: PreviewPage = {
      id: meta.id,
      meta,
      origin,
      view,
      epoch,
      mountedUrl: null,
      failed: false,
      zoomFactor: 1,
      consoleLog: [],
      shownAt: 0,
      originSnapshot: [...this.allowedOrigins],
    };
    // 등록이 곧 산 것이다 — active()·pageOf·evictParked 가 livePages 로 탭을
    // 찾는다. 이 한 줄이 빠지면 cover() 가 화면의 탭을 못 찾아 네이티브 뷰가
    // 모달 위에 계속 그려진다(D65 의 규칙이 무너진 채로).
    this.livePages.set(meta.id, page);
    // 되살림도 여기를 지난다 — 버려진 메타는 몸통이 다시 섰으면 산 것이다.
    meta.discarded = false;
    this.attach(page);
    return page;
  }

  /** 새 탭 — 스트립 끝에 메타를 세우고 몸통을 짓는다. */
  private createTab(
    url: string | null,
    kind: PreviewKind,
    origin: string,
    epoch: number | null,
  ): PreviewPage {
    const meta: TabMeta = {
      id: `t${++this.tabSeq}`,
      kind,
      title: "새 탭",
      url,
      discarded: false,
      favicon: null,
    };
    this.tabList.push(meta);
    return this.buildPage(meta, origin, epoch);
  }

  /**
   * 버려진 탭의 되살림 — createPage + lastUrl 재로드의 절반. 몸통만 새로 짓고
   * 주소 재로드는 activateTab 이 이어서 한다(레지스트리 epoch 을 받으면서).
   * kind 는 버려진 그때의 값이 아니라 지금 레지스트리로 다시 정한다: 프로젝트가
   * 바뀌어 낡은 preview 탭이 web 이 될 수 있다(규칙 6의 스냅샷 취지).
   */
  private resurrect(meta: TabMeta): PreviewPage {
    const origin = meta.url ? safeOrigin(meta.url) : "about:blank";
    const mount = origin === "about:blank" ? null : (this.mounts.get(origin) ?? null);
    return this.buildPage(meta, origin, mount ? mount.epoch : null);
  }

  /**
   * Puts a page on screen: topmost in the window (`addChildView` reorders a
   * child it already holds), sized to the slot, visible unless a modal
   * covers the pane. 먼저 서 있던 탭은 park 해 두고 — 화면에는 늘 한 탭.
   * The overlay is re-told the mode (D67) and the last pin sync (재설계 C1)
   * it may have missed while parked, and the renderer's picture of the pane
   * — where it is, its screens, whether it loads, its zoom — is replayed
   * from this page's facts. 스트립 이벤트는 activateTab 이 따로 푼다.
   */
  private show(page: PreviewPage): void {
    const previous = this.active();
    if (previous && previous !== page) this.park(previous);
    this.activeTabId = page.id;
    page.shownAt = Date.now();
    const window = this.window();
    if (window && !window.isDestroyed()) window.contentView.addChildView(page.view);
    if (this.bounds) page.view.setBounds(this.bounds);
    page.view.setVisible(!this.covered);
    const contents = page.view.webContents;
    const preview = page.meta.kind === "preview";
    // The repo overlay stays out of web tabs: comments mode off, and
    // an empty pin list sweeps any badge a repo page left drawn.
    contents.send("colo-overlay:mode", { on: this.commentsOn && preview });
    contents.send("colo-overlay:pins", preview ? (this.lastPins ?? { pins: [] }) : { pins: [] });
    this.sendLocation(page);
    this.send("colo-preview:loading", { on: contents.isLoading() });
    this.send("colo-preview:zoom", { factor: page.zoomFactor });
  }

  /**
   * Whether a page is alive AND a child of the window on screen now. The
   * pane outlives the window — on mac ⌘W destroys it and the dock icon
   * builds another — so the active tab can belong to a contentView that is
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

  /** 화면에서 내리되 살려 둔다: 숨기고, 활성 선택도 함께 내린다. */
  private park(page: PreviewPage): void {
    // A page whose window was destroyed took its webContents with it —
    // the view is already gone, so only the selection moves.
    page.view.setVisible(false);
    if (this.activeTabId === page.id) this.activeTabId = null;
  }

  /**
   * WebContents 파기, 메타 생존(§3 규칙 3) — evict 와 unmount 시의 web 탭이
   * 이 길을 간다. 스트립에는 버려진 탭으로 남아 재활성화 때 lastUrl 로 돌아온다.
   */
  private discard(page: PreviewPage): void {
    this.livePages.delete(page.id);
    page.meta.discarded = true;
    if (this.activeTabId === page.id) this.activeTabId = null;
    const window = this.window();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(page.view);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  }

  /**
   * Cap 을 넘으면 마지막으로 봤지 오래된 parked 탭부터 버린다 — 버린다는 것은
   * destroy(메타까지)가 아니라 discard(WebContents 만)다. 메타는 스트립에
   * 남으니 되살릴 수 있고, 창이 닫혀 전 탭이 사라져도 같은 길로 자연 흡수된다.
   */
  private evictParked(): void {
    const parked = [...this.livePages.values()]
      .filter((page) => page.id !== this.activeTabId)
      .sort((a, b) => b.shownAt - a.shownAt);
    for (const page of parked.slice(MAX_LIVE_TABS - 1)) this.discard(page);
  }

  /**
   * A page's own ears, for its whole life. Every handler updates the page's
   * facts; only the page on screen relays them to the renderer — a parked
   * page reloading itself must not move the address bar or raise a banner
   * over the project the planner is looking at. 스트립 사실(title·favicon·
   * kind)은 예외로, 어느 탭이든 그대로 스트립에 푼다 — 뒷편 탭의 제목도
   * 스트립이 그려야 한다.
   */
  private attach(page: PreviewPage): void {
    const contents = page.view.webContents;
    // 팝업은 이제 전부 탭(§4-1): http(s) 면 openTab — repo origin 은 mount
    // 경로로 위임돼 중복 탭이 없고, 그 밖은 새 web 탭이 포그라운드로 선다.
    // 그 밖의 스킴은 pane 이 띄우지 않고 OS 에 넘긴다.
    contents.setWindowOpenHandler(({ url }) => {
      if (httpUrl(url)) this.openTab(url);
      else openInOs(url);
      return { action: "deny" };
    });

    // will-navigate 는 http(s) 가드만 남는다(§3 규칙 5). 어느 origin 으로의
    // 이동이든 그 자리에서 하게 두고, 그 판이 어떤 종류의 탭인지는
    // did-navigate 가 레지스트리로 다시 정한다 — 분기는 삭제됐다.
    contents.on("will-navigate", (event, url) => {
      if (!httpUrl(url)) event.preventDefault();
    });
    contents.on("did-navigate", (_event, url) => {
      page.mountedUrl = url;
      page.meta.url = url;
      page.failed = false;
      // ① kind 재계산 — URL 이 결정한다(§3 규칙 5). web 탭이 repo origin 에
      // 착지하면 preview 로, preview 탭이 링크를 타고 나가면 web 으로.
      const origin = safeOrigin(url);
      if (origin !== "") {
        page.origin = origin;
        page.meta.kind = this.isRepoOrigin(origin, page) ? "preview" : "web";
      }
      this.sendTabs();
      if (this.activeTabId !== page.id) return;
      this.sendLocation(page);
      // ② 오버레이 재무장 — the overlay never announces itself; a fresh load
      // is re-told everything it needs. preview 탭은 모드와 마지막 핀 동기,
      // web 탭은 모드 off 와 빈 핀 스윕(앞 문서가 남긴 배지를 지운다).
      if (page.meta.kind === "preview") {
        contents.send("colo-overlay:mode", { on: this.commentsOn });
        contents.send("colo-overlay:pins", this.lastPins ?? { pins: [] });
        // ③ preview 탭이 낡은 epoch 위에 서 있으면 그 뿌리로 다시 시작한다 —
        // 포트가 다른 프로젝트에 넘어갔을 수 있다. 재로드의 did-navigate 가
        // 다시 여기로 와 재무장한다.
        const mount = this.mounts.get(page.origin);
        if (mount && mount.epoch !== null && page.epoch !== null && page.epoch !== mount.epoch) {
          this.refresh(page, mount.url, mount.epoch);
        }
      } else {
        contents.send("colo-overlay:mode", { on: false });
        contents.send("colo-overlay:pins", { pins: [] });
      }
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      page.mountedUrl = url;
      page.meta.url = url;
      if (this.activeTabId !== page.id) return;
      this.sendLocation(page);
      // A SPA move swaps the screen without a load; replaying the sync lets
      // the overlay refilter its badges at once (재설계 C5) — the web's
      // onLocation resend confirms with the fresh list. kind 재계산은 필요
      // 없다(origin 은 안 바뀐다) — 핀 리플레이만 kind 가드로 통과한다.
      if (page.meta.kind !== "preview") return;
      if (this.lastPins) contents.send("colo-overlay:pins", this.lastPins);
    });
    // 스트립 사실 — 화면 밖 탭의 것도 그대로 푼다.
    contents.on("page-title-updated", (_event, title) => {
      page.meta.title = title;
      this.sendTabs();
    });
    contents.on("page-favicon-updated", (_event, icons) => {
      page.meta.favicon = icons.length > 0 ? (icons[icons.length - 1] ?? null) : null;
      this.sendTabs();
    });
    contents.on("did-start-loading", () => {
      if (this.activeTabId === page.id) this.send("colo-preview:loading", { on: true });
    });
    contents.on("did-stop-loading", () => {
      if (this.activeTabId === page.id) this.send("colo-preview:loading", { on: false });
    });
    // D69: the pane's own ears — no repo hook. 44 의 형태: 첫 인자가 details
    // 이벤트다(level 은 "info"|"warning"|"error"|"debug"). D89: every line
    // lands in the ring buffer first — the 화면 보여 주기 turn quotes it.
    contents.on("console-message", (details) => {
      const line = `[${details.level}] ${details.message}`.slice(0, 500);
      page.consoleLog.push(line);
      if (page.consoleLog.length > 20) page.consoleLog.splice(0, page.consoleLog.length - 20);
      if (details.level !== "error" || this.activeTabId !== page.id) return;
      this.reportError(page, "runtime", details.message);
    });
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // -3 ERR_ABORTED is a navigation superseding itself, not a failure.
        if (!isMainFrame || errorCode === -3) return;
        page.failed = true;
        if (this.activeTabId !== page.id) return;
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
      if (this.activeTabId !== page.id) return;
      this.reportError(
        page,
        "runtime",
        `미리보기 프로세스가 죽었습니다 (${details?.reason ?? "unknown"})`,
      );
    });
    // D71: while the view holds focus the renderer DOM hears no keys — the
    // two the whole UI hangs on are forwarded and replayed as synthetic
    // keydowns (NativeHost), so the palette and 설정 still open. 탭 단축키는
    // 그 위에서 이 판이 먼저 쪼개 가진다(§3 규칙 8): 뷰 포커스 동안 ⌘T 는 새
    // 탭, ⌘W 는 탭 닫기 — 메뉴(새 대화·창 닫기)로는 흘려보내지 않는다. 탭이
    // 하나뿐인 ⌘W 는 가로채지 않아 창 닫기가 본래 뜻으로 통한다.
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const plainMeta = Boolean(input.meta) && !input.shift && !input.alt && !input.control;
      if (plainMeta && (input.key === "t" || input.key === "T")) {
        event.preventDefault();
        this.newTab();
        return;
      }
      if (plainMeta && (input.key === "w" || input.key === "W") && this.livePages.size >= 2) {
        event.preventDefault();
        this.closeTab();
        return;
      }
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

  /** 스트립의 사실 한 벌 — 탭이 만들어지고 닫히고 자랄 때마다 웹으로 푼다. */
  private sendTabs(): void {
    this.send("colo-preview:tabs", {
      tabs: this.listTabs(),
      activeTabId: this.activeTabId,
    });
  }

  private sendLocation(page: PreviewPage): void {
    const contents = page.view.webContents;
    let path = "/";
    let url = "";
    try {
      const parsed = new URL(contents.getURL());
      path = `${parsed.pathname}${parsed.search}`;
      url = parsed.toString();
    } catch {
      // Keep "/" — an unparseable url still deserves a back button state.
    }
    // ⌘T 로 태어난 탭의 주소는 about:blank 다 — 주소창엔 빈 칸이 어울린다.
    if (url === "about:blank") path = "/";
    this.send("colo-preview:location", {
      /** 어느 탭의 말인지 — 웹은 활성 탭의 것만 주소창에 비춘다(1단계 웹 쪽). */
      tabId: page.id,
      /** preview 인지 web 인지 — external 불리어의 자리를 대신한다. */
      kind: page.meta.kind,
      path,
      url,
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
    const origins =
      "origins" in input && Array.isArray(input.origins)
        ? input.origins.filter(
            (origin): origin is string => typeof origin === "string" && httpUrl(origin),
          )
        : [];
    view.mount(input.url, epoch, origins);
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
  // A link the planner clicked (설정 `앱에서 링크 열기`): openTab 이 판한다 —
  // repo origin 이면 mount 경로로 위임, 그 밖의 http(s) 는 새 web 탭, 슬롯이
  // 없으면 OS 브라우저. the view decides, the renderer only asks.
  ipcMain.handle("preview:open-external", (_event, input: { url?: unknown }) => {
    if (typeof input?.url === "string") view.openTab(input.url);
    return { ok: true };
  });
  // 탭 스트립의 명령 4종(§4-1) — 스트립의 현재 사실과, 만들기·고르기·닫기.
  // tabId 생략은 활성 탭을 뜻한다(규칙 11의 취지: 생략=active).
  ipcMain.handle("preview:tabs", () => ({
    tabs: view.listTabs(),
    activeTabId: view.getActiveTabId(),
  }));
  ipcMain.handle("preview:tab-new", (_event, input: { url?: unknown }) => {
    view.newTab(typeof input?.url === "string" ? input.url : undefined);
    return { ok: true };
  });
  ipcMain.handle("preview:tab-activate", (_event, input: { tabId?: unknown }) => {
    if (typeof input?.tabId === "string") view.activateTab(input.tabId);
    return { ok: true };
  });
  ipcMain.handle("preview:tab-close", (_event, input: { tabId?: unknown }) => {
    view.closeTab(typeof input?.tabId === "string" ? input.tabId : undefined);
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
