import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ColoDesignErrorEnvelope,
  ColoDesignPinEnvelope,
  ColoDesignPinsSync,
} from "@colo-design/protocol";
import { type BrowserWindow, ipcMain, nativeImage, shell, type WebContents } from "electron";
import { VIEWPORT_METRICS } from "./emulation.js";

/**
 * 사용자의 미리보기 (PLAN D64 → webview 전환). The planner's preview pane is
 * the connected repo's app, hosted in a `<webview>` element the web UI owns
 * (PreviewFrame) — so the address · history · errors · the comment-pin
 * overlay (D67, in the preload) are the tool's, and every planner layer
 * (modals, popovers) draws above the pane as ordinary DOM.
 *
 * 이 프로세스는 요소를 만들지 않는다. 렌더러가 `<webview src>`를 만들고,
 * 여기서는 `did-attach-webview`로 게스트를 클레임해 페이지 레지스트리에
 * 세운 뒤 오늘과 같은 리레이(위치·오류·콘솔·핀)와 드라이버 표면을 쥔다.
 * 요소의 보이기·숨기기·수명은 렌더러의 몫 — `MAX_LIVE_PAGES`의 park 상한도
 * PreviewFrame이 진다. 펜스(`will-attach-webview`)가 렌더러가 겨눌 수 있는
 * 주소를 loopback 미리보기로 가두고, preload·파티션·보안 등급을 강제한다.
 *
 * ONE PAGE PER PROJECT. `pages` 는 마운트 origin 을 열쇠로 게스트를 쥔다 —
 * 프로젝트 전환은 요소를 가리는 것일 뿐 게스트는 살아 있고, 돌아오는 것은
 * repaint 이지 reload 가 아니다.
 *
 * 링크의 나라는 탭이 아니라 그 페이지 안에서 논다: 외부 http(s) 로의 이동은
 * 제자리에서 일어나고 kind 가 `web` 으로 바뀐다 — 뒤로 가기가 프로젝트로
 * 돌아오는 길이다. 프로젝트가 하나도 마운트되지 않았을 때 에이전트·링크가
 * 여는 페이지는 `loose` 하나뿐 — 렌더러에 `colo-preview:host`로 요소를
 * 부탁하고, 요소가 사라지면(닫기·전환) `destroyed`로 잊는다.
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
 * The pinned element's React owner chain, read in the page's
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
 * `did-fail-load` handler owns the error report, so the promise's only job
 * left is not crashing as an unhandled rejection.
 */
function navigate(contents: WebContents, url: string): void {
  void contents.loadURL(url).catch(() => undefined);
}

/**
 * OS 에 넘긴다 — pane 이 보여주지 못하는 스킴(슬롯이 없거나 웹의 일상
 * 동작인 mailto)을 브라우저·메일 앱이 대신 연다. 화이트리스트다: OS 에
 * 등록된 임의 핸들러(smb·vnc 같은)로 웹 콘텐츠가 손을 뻗지 못하게 하고,
 * file: 은 처음부터 없다.
 */
function openInOs(url: string): void {
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== "https:" && protocol !== "http:" && protocol !== "mailto:") return;
    void shell.openExternal(url).catch(() => undefined);
  } catch {
    // 파싱이 안 되는 url 에는 열어줄 스킴도 없다
  }
}

/** 페이지의 종류 — repo origin 위면 `preview`(오버레이 무장), 그 밖의 http(s) 로밍이면 `web`. */
type PreviewKind = "preview" | "web";

/**
 * 한 페이지의 살아 있는 전부: 뷰와, 이 페이지에 대해 pane 이 아는 것.
 * `home` 은 이 페이지를 세운 마운트 origin — 로밍으로 `origin` 이 바뀌어도
 * `home` 은 pages 의 열쇠 그대로다. loose 페이지(프로젝트 없이 열린 것)는
 * home 이 null 이고 화면을 떠나면 파기된다.
 */
interface PreviewPage {
  /** 이 페이지를 세운 마운트 origin — pages 의 열쇠. loose 페이지는 null 이었다가 repo origin 에 착지하면 입양된다. */
  home: string | null;
  /**
   * 지금 머무는 origin — did-navigate 마다 다시 정해지고 kind 도 그때
   * 레지스트리로 재계산한다. 로밍 중이면 home 과 어긋난다.
   */
  origin: string;
  /** repo origin 위면 `preview`, 그 밖이면 `web` — 오버레이 무장의 자리를 대신한다. */
  kind: PreviewKind;
  /** PreviewFrame이 만든 `<webview>`의 게스트 — did-attach-webview 로 클레임한 것. */
  contents: WebContents;
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
}

export class PlannerPreviewView {
  /**
   * 프로젝트 페이지들 — 마운트 origin 이 열쇠. origin 당 페이지 하나라
   * 중복 금지·kind 재계산·park/복귀가 전부 이 맵 위에 선다.
   */
  private readonly pages = new Map<string, PreviewPage>();
  /**
   * 프로젝트 없이 열린 페이지 — 에이전트의 navigate 나 `앱에서 링크 열기`가
   * 마운트된 프로젝트 없이 부를 때의 유일한 몸통. 요소는 렌더러에
   * `colo-preview:host`로 부탁하고, 요소가 사라지면(닫기·무대 철거)
   * `destroyed`가 이 참조를 지운다.
   */
  private loose: PreviewPage | null = null;
  /**
   * 화면에 올라와 있는 페이지. null 은 pane 이 접힌 상태다(카드가 서 있거나
   * 아직 아무것도 마운트되지 않았다). park/파기가 이 참조를 지우고 show() 가
   * 다시 세운다.
   */
  private activePage: PreviewPage | null = null;
  /**
   * repo 레지스트리: 마운트된 origin 과 그때의 epoch·뿌리 url. kind 재계산과
   * did-navigate 때의 epoch 정산이 이 맵을 본다 — 마운트가 유일한 쓰는 곳이라
   * 프로젝트가 바뀌면 저절로 다시 쓰인다.
   */
  private readonly mounts = new Map<string, { epoch: number | null; url: string }>();
  /**
   * 렌더러(PreviewFrame)가 지금 보여 달라고 말한 origin — 클레임(did-attach)
   * 이 늦게 올 때를 위한 약속. mount 가 쓰고 클레임이 소비한다.
   */
  private wantedOrigin: string | null = null;
  /**
   * 활성 페이지 없이 링크·에이전트가 열어 달라 한 주소 — 렌더러에 loose
   * 요소를 부탁해 두고, 그 게스트가 붙으면 이 주소로 세운다.
   */
  private pendingLooseUrl: string | null = null;
  /**
   * 렌더러가 미리보기 무대를 그릴 수 있는지 — PreviewFrame이 mount/unmount로
   * 말한다. 거짓이면 링크·외부 열기가 OS 브라우저로 넘어간다(옛 bounds 0 판정).
   */
  private hostReady = false;

  /** The last 💬 state — a fresh load, or a returning page, is re-told it (D67). */
  private commentsOn = false;
  /** 무대의 폭 에뮬레이션 — 활성 페이지가 바뀌어도 무대의 선택이므로 activate 가 다시 입힌다. */
  private emulateWidth: "mobile" | "tablet" | null = null;
  /** The web's last pin sync (재설계 C1) — a page that loads or returns is re-told it. */
  private lastPins: ColoDesignPinsSync | null = null;
  /** Resolved when the overlay acknowledges a capture hide/show (D87). */
  private captureAck: (() => void) | null = null;

  constructor(private readonly window: () => BrowserWindow | null) {}

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
    // A url that is neither loopback nor http(s) never reaches the view.
    if (!loopbackHttp(url)) return;
    const origin = new URL(url).origin;
    // 레지스트리에 올라간 순간부터 이 origin 은 repo 의 것 — 이후의 kind
    // 재계산이 이 한 줄 위에 선다.
    this.mounts.set(origin, { epoch, url });
    this.wantedOrigin = origin;
    // 프로젝트 mount 는 대기 중인 loose 요청을 대신한다.
    this.pendingLooseUrl = null;
    // repo origin 은 페이지 하나뿐이다: 있는 페이지는 데워 쓰고, 없을 때만
    // 만든다. driveTo·mount idempotency 가 이 유일성 위에 서 있다. 로밍으로
    // home 과 다른 origin 에 서 있는 페이지도 그 origin 의 것으로 찾는다 —
    // 아니면 같은 origin 의 페이지가 둘로 갈라진다.
    const existing = this.pages.get(origin) ?? this.pageAt(origin);
    if (existing) {
      // loose 페이지가 repo origin 에 걸어 들어왔다 — 프로젝트 페이지로
      // 입양한다(park·복귀가 이제 이 페이지를 살려 둔다).
      if (existing.home === null) {
        existing.home = origin;
        this.pages.set(origin, existing);
        this.loose = null;
      }
      // 입양 직후의 kind — did-navigate 은 이미 지나갔다. origin 이 마운트되기
      // 전에 먼저 도착한 페이지는 kind 이 "web" 인 채였고, 다시 로드되기 전엔
      // 재계산이 없다. 제 집 origin 이 레지스트리에 오른 지금 그 위에 서 있으면
      // repo 의 페이지다(오버레이 무장의 자리).
      if (
        this.mounts.has(existing.home) &&
        existing.origin === existing.home &&
        existing.kind !== "preview"
      ) {
        existing.kind = "preview";
        // 이미 화면의 페이지면 show 의 재무장을 못 받는다 — 지금 다시 말한다.
        if (this.activePage === existing) {
          const contents = existing.contents;
          contents.send("colo-overlay:mode", { on: this.commentsOn });
          this.sendPins(contents, this.lastPins ?? { pins: [] });
        }
      }
      this.activate(existing);
      this.refresh(existing, url, epoch);
      return;
    }
    // 요소는 PreviewFrame이 url prop으로 만들고, 클레임(did-attach)이 오면
    // wantedOrigin 으로 활성화된다. 붙기 전까지는 지난 페이지의 릴레이가 새
    // 프로젝트의 주소창에 흘러 들지 않게 활성 참조를 내린다(옛 park의 자리).
    this.wantedOrigin = origin;
    if (this.activePage?.home !== origin) {
      this.activePage = null;
      this.send("colo-preview:location", null);
    }
  }

  /** 지금 그 origin 에 서 있는 페이지 — 로밍한 것까지 잡는다. */
  private pageAt(origin: string): PreviewPage | null {
    for (const page of this.pages.values()) {
      if (page.origin === origin) return page;
    }
    if (this.loose?.origin === origin) return this.loose;
    return null;
  }

  /**
   * A page on screen against the server that answers now. A moved epoch is a
   * different process — the app behind the port may be another project's,
   * so the page starts over at the root; a failed last load (the server was
   * down, the renderer died) retries where it was. Otherwise the page is
   * already right and nothing loads. 페이지 단위로 정산된다 — 옆 페이지의
   * epoch 은 이 판정에 못 끼난다.
   *
   * 로밍 중인 페이지(origin ≠ home)도 그 자리에 둔다 — mount 는 "이
   * 프로젝트를 보여 달라"는 말이지 "뿌리로 돌아가라"는 말이 아니다. 돌아오는
   * 길은 페이지의 history(뒤로 가기)다. 다만 epoch 이동은 예외다: 서버가
   * 갈아끼워진 로밍 자리는 낡았으므로 뿌리로 다시 시작한다.
   */
  private refresh(page: PreviewPage, url: string, epoch: number | null): void {
    const moved = epoch !== null && page.epoch !== null && page.epoch !== epoch;
    if (epoch !== null) page.epoch = epoch;
    if (moved) {
      page.failed = false;
      page.mountedUrl = url;
      navigate(page.contents, url);
    } else if (page.failed) {
      page.failed = false;
      navigate(page.contents, page.mountedUrl ?? url);
    }
  }

  /**
   * A link the planner clicked (설정 `앱에서 링크 열기`), a popup the agent
   * opened, or the driver's navigate. repo 레지스트리의 origin 이면 mount
   * 경로에 위임한다 — 그 프로젝트의 페이지가 앞으로 온다. 그 밖의 http(s) 는
   * 화면의 페이지를 제자리에서 이동시키고(로밍), 페이지가 하나도 없으면
   * loose 페이지를 세운다. 슬롯이 없으면(카드가 서 있으면) pane 이 그릴 면이
   * 없으므로 OS 브라우저가 대신 본다.
   */
  openTab(url: string): void {
    if (!httpUrl(url)) return;
    // 무대가 접혀 있으면(PreviewFrame이 없으면) pane 이 그릴 면이 없으므로
    // OS 브라우저가 대신 본다 — 옛 bounds 0 판정의 자리.
    if (!this.hostReady) {
      openInOs(url);
      return;
    }
    const origin = new URL(url).origin;
    if (this.mounts.has(origin)) {
      // repo origin 은 그 프로젝트의 페이지로 간다 — 단, mount 는 epoch 이동만
      // 다시 읽으므로 요청한 경로가 페이지의 지금 주소와 다르면 명시적으로
      // 데려간다. 에이전트의 navigate("…/settings") 가 "/" 에 머무는 사고를
      // 막는다.
      this.mount(url, null);
      // mount 은 pageAt 까지 뒤져 온 페이지를 새 열쇠로 옮기지 않는다 — 입양은
      // loose 페이지의 몫이고, 프로젝트 페이지는 로밍해도 pages 의 열쇠가 제
      // home 이다. 화면의 페이지를 직접 찾아야 보상 이동이 닿는다. mount 는
      // 같은 주소의 재요청을 no-op 로 본다 — 요청한 경로가 페이지의 목표
      // 주소와 다르면 명시적으로 데려간다. 에이전트의 navigate("…/settings")
      // 가 "/" 에 머무는 사고를 막는다.
      const page = this.pages.get(origin) ?? this.pageAt(origin);
      if (page && page.mountedUrl !== url) {
        page.mountedUrl = url;
        navigate(page.contents, url);
      }
      return;
    }
    if (this.activePage) {
      this.load(this.activePage, url);
      return;
    }
    // 활성 페이지가 없다 — loose 요소를 렌더러에 부탁하고, 게스트가 붙으면
    // 이 주소로 세운다(클레임 경로).
    this.pendingLooseUrl = url;
    this.send("colo-preview:host", { url });
  }

  /**
   * Takes the pane off screen — the slot is gone (a project switch, a card in
   * the pane's place, the server died). park 은 프로젝트 페이지일 때만:
   * 사용자가 있던 곳이 프로젝트 화면일 때만 '그대로 돌아옴'을 약속한다.
   * loose 페이지는 버린다 — 링크의 나라는 WebContents 를 놓아준다.
   */
  unmount(): void {
    // wanted 원망은 활성 참조와 무관하게 늘 지운다 — 비어 있는 무대 위의
    // 오래된 원망이 다음 클레임을 잘못 활성화하는 일을 막는다.
    this.wantedOrigin = null;
    const page = this.activePage;
    if (!page) return;
    if (page.home !== null) {
      // park — 요소는 PreviewFrame이 살려 둔다(게스트도 살아 있다). 활성
      // 참조와 원망(wanted)만 내린다.
      this.activePage = null;
      this.wantedOrigin = null;
      // pane 이 빈 화면이 됐다는 말 — 주소창·뒤로/앞으로 칩이 지난 페이지의
      // 것을 들고 있지 않게 지운다.
      this.send("colo-preview:location", null);
      return;
    }
    // loose — 닫기를 렌더러에 부탁한다. 요소가 철거되면 destroyed가 잊는다.
    this.send("colo-preview:close", { url: page.contents.getURL() });
    this.forget(page);
  }

  /**
   * pane 가 화면을 그릴 자리가 있는지 — openTab 은 이 판정이 거짓일 때 OS
   * 브라우저에 넘긴다. 에이전트 브라우저의 navigate 은 그 폴백에 맡기지
   * 않으려고 먼저 이 한 말을 본다. 요소가 DOM 위에 살므로(모달도 그 위에
   * 그려진다) 무대의 존재가 곧 호스팅 가능이다 — PreviewFrame이 mount
   * 여부로 말한다.
   */
  hasBounds(): boolean {
    return this.hostReady;
  }

  /** PreviewFrame의 마운트 보고 — openTab의 OS 브라우저 폴백 판정 재료. */
  setHostReady(on: boolean): void {
    this.hostReady = on;
  }

  /**
   * 화면의 지금 페이지가 연결 레포의 것인지 — home origin 위에 서 있으면
   * 참, 사용자가 링크를 타고 밖으로 나가 로밍 중이면 거짓이다. 에이전트
   * 브라우저의 민감 op(evaluate·screenshot·snapshot)가 레포 바깥을 겨눌 때
   * 권한 카드로 가는 판정 재료다(BrowserDriver.isRepoSurface 계약).
   */
  isRepoSurface(): boolean {
    const page = this.activePage;
    return page !== null && page.home !== null && page.origin === page.home;
  }

  /**
   * The address bar's word — 화면의 페이지가 옮는다. 같은 origin 이면 그
   * 페이지 안에서, 로밍 중이거나 loose 페이지면 http(s) 어디든 그 자리에서
   * 논다. 프로젝트 페이지가 home 에 있는 동안의 건너편은 둘로 갈린다:
   * repo 레지스트리(또는 이번 프로젝트가 허용한) origin 이면 mount 경로로,
   * 그 밖의 전체 URL 은 제자리 로밍이다.
   */
  open(path: string): void {
    const page = this.activePage;
    if (!page) return;
    let url: URL;
    try {
      url = new URL(path, page.home ?? page.origin);
    } catch {
      return;
    }
    if (url.origin === page.origin) {
      this.load(page, url.toString());
      return;
    }
    if (!httpUrl(url.toString())) return;
    if (page.home === null || page.origin !== page.home) {
      // 로밍 중이거나 프로젝트 없이 떠 있는 페이지 — 주소창은 브라우저처럼
      // 제자리에서 갈아탄다.
      this.load(page, url.toString());
      return;
    }
    if (this.mounts.has(url.origin)) {
      this.mount(url.toString(), null);
      // mount 은 같은 주소의 재요청을 no-op 로 본다 — 요청한 경로가 그
      // 프로젝트 페이지의 지금 주소와 다르면 명시적으로 데려간다(openTab 과
      // 같은 보상). 로밍한 프로젝트 페이지는 pages 의 열쇠(home)가 여기
      // origin 과 어긋나므로 pageAt 까지 뒤져 실제 페이지를 찾는다 — 못
      // 찾으면 보상 이동이 통째로 빠지고 주소창이 가리킨 경로가 사라진다.
      const target = this.pages.get(url.origin) ?? this.pageAt(url.origin);
      if (target && target.mountedUrl !== url.toString()) {
        target.mountedUrl = url.toString();
        navigate(target.contents, url.toString());
      }
      return;
    }
    // 프로젝트 페이지의 외출 — 같은 페이지가 링크의 나라를 걷는다. 뒤로
    // 가기가 돌아오는 길이다.
    this.load(page, url.toString());
  }

  /**
   * A pin's 화면 이동 (D66): a plain load — the screens envelope that once
   * marked the bridge `present` is gone, so client routing is too. 주소창과
   * 달리 여기서 로밍하지 않는다: 이 말은 repo 의 것이라 프로젝트 페이지의
   * home origin 위에서만 논다 — 페이지가 외출 중이면 home 으로 되돌아오는
   * 것이 곧 그 화면으로 가는 길이다.
   */
  navigate(route: string): void {
    const page = this.activePage;
    if (!page || page.home === null) return;
    let url: URL;
    try {
      url = new URL(route, page.home);
    } catch {
      return;
    }
    // A pin's route must not slip past open()'s guard by carrying an
    // absolute route — the pin plays on the project page's home origin only.
    if (url.origin !== page.home) return;
    this.load(page, url.toString());
  }

  /**
   * The agent's navigation (PaneBrowserDriver): a real load, awaited — never
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
    const page = this.activePage;
    if (!page) return false;
    if (parsed.origin !== page.origin) {
      // The agent's drive pulls the pane back to the project — mount refits
      // the page for the preview origin. loose 페이지는 loopback(다른
      // 프로젝트의 서버 포함)까지 받는다 — 링크를 타고 온 페이지가 에이전트의
      // drive 로 repo 쪽으로 걸어 들어오는 길이다. repo 페이지가 로밍한 뒤엔
      // 제 집(origin)과 레지스트리(mounts)에 등록된 origin 이 돌아오는 길이다.
      const allowed =
        page.home === null
          ? loopbackHttp(url)
          : parsed.origin === page.home || this.mounts.has(parsed.origin);
      if (!allowed) return false;
      this.mount(url, null);
      const mounted = this.activePage;
      if (!mounted) return false;
      const contents = mounted.contents;
      // mount 은 같은 주소의 재요청을 no-op 로 본다 — 요청한 경로가 페이지의
      // 지금 주소와 다르면 openTab 처럼 명시적으로 데려간다. 로밍 중 붙들린
      // 프로젝트 페이지(origin 이 아직 목적지가 아니다)와 앞으로 데워진
      // 대기 페이지(다른 경로에 서 있다)가 이 한 갈래로 목적지에 닿는다.
      if (mounted.home !== null && mounted.mountedUrl !== url) {
        mounted.mountedUrl = url;
        mounted.failed = false;
        try {
          await contents.loadURL(url);
          return true;
        } catch {
          mounted.failed = true;
          return false;
        }
      }
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
      await page.contents.loadURL(url);
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
    page.failed = false;
    navigate(page.contents, url);
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
    this.setZoom((this.activePage?.zoomFactor ?? 1) + 0.2);
  }

  zoomOut(): void {
    this.setZoom((this.activePage?.zoomFactor ?? 1) - 0.2);
  }

  zoomReset(): void {
    this.setZoom(1);
  }

  private setZoom(factor: number): void {
    const page = this.activePage;
    if (!page || page.contents.isDestroyed()) return;
    const clamped = Math.min(2, Math.max(0.5, factor));
    page.contents.setZoomFactor(clamped);
    page.zoomFactor = clamped;
    this.send("colo-preview:zoom", { factor: clamped });
  }

  /** The preview origin on screen — the main window's popup gate. */
  getOrigin(): string | null {
    return this.activePage?.origin ?? null;
  }

  /** The live webContents of the page on screen — the desktop suite drives the overlay through it. */
  webContents(): WebContents | null {
    const contents = this.activePage?.contents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  /**
   * 데스크톱 스위트의 손잡이(desktop-switch·desktop-comments 가 app.evaluate 로
   * 읽는다) — 화면의 페이지 한 장이 곧 옛 `page` 다.
   */
  get page(): PreviewPage | null {
    return this.activePage;
  }

  commentsMode(on: boolean): void {
    this.commentsOn = on;
    // 오버레이는 repo 의 말 — 로밍 중인 페이지에는 닿지 않는다(kind 가
    // external 의 자리를 대신한다). 다시 preview 로 돌아오면 show/did-navigate
    // 가 재무장한다.
    if (this.activePage?.kind !== "preview") return;
    this.webContents()?.send("colo-overlay:mode", { on });
  }

  /**
   * 재설계 C1: the web's whole pin list is the truth — remember it so a page
   * that loads or comes back from a park is re-told it, and project it onto
   * the overlay (the badges redraw from this).
   */
  syncPins(sync: ColoDesignPinsSync): void {
    this.lastPins = sync;
    if (this.activePage?.kind !== "preview") return;
    if (this.webContents()) this.sendPins(this.webContents() as WebContents, sync);
  }

  /** 재설계 C1: the web's chip click — the matching badge on the page flashes. */
  pinFlash(id: string): void {
    if (this.activePage?.kind !== "preview") return;
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

  /**
   * 핀 동기화를 게스트에 보낸다. 이 채널은 핀을 찍기 전까지는 잘 도는데,
   * 한 핀 주기가 지나면(실측, Electron 44 webview) 그 문서의 main→게스트
   * 전달이 조용히 죽는다 — 스윕은 오버레이의 pins-poll 폴백이 잇는다
   * (게스트→main invoke 는 살아 있다).
   */
  private sendPins(contents: WebContents, sync: ColoDesignPinsSync): void {
    try {
      contents.send("colo-overlay:pins", sync);
    } catch {
      // A dead contents reports nothing — the overlay's poll pulls the truth.
    }
  }

  /**
   * 오버레이의 pins-poll 답 — 이 게스트가 repo 페이지일 때만 진실을 준다.
   * 로밍 중인 페이지에게 스윕 진실을 주면 남의 핀을 지운다.
   */
  pinsFor(sender: WebContents): ColoDesignPinsSync {
    const page = this.pageOf(sender);
    return page !== null && page.kind === "preview"
      ? (this.lastPins ?? { pins: [] })
      : { pins: [] };
  }

  /** The overlay's ack for a capture hide/show. */
  onCaptureDone(): void {
    this.captureAck?.();
  }

  /**
   * The page's visible box in CSS pixels — the frame a pin's `element.rect`
   * (a getBoundingClientRect) was measured against. The guest's own
   * innerWidth/innerHeight IS that frame, in the page's CSS pixels — 배율
   * (D85 ⓔ)도 에뮬레이션 폭도 이미 반영된 값이라 나눌 것도 없다. Null while
   * the pane has no page or the read fails — then a crop is taken on trust,
   * as before.
   */
  private async viewportCss(): Promise<{ width: number; height: number } | null> {
    const page = this.activePage;
    if (!page || page.contents.isDestroyed()) return null;
    try {
      const view = (await page.contents.executeJavaScript(
        "({ w: window.innerWidth, h: window.innerHeight })",
        true,
      )) as { w?: unknown; h?: unknown } | null;
      if (typeof view?.w !== "number" || typeof view?.h !== "number") return null;
      return view.w >= 1 && view.h >= 1 ? { width: view.w, height: view.h } : null;
    } catch {
      // 읽지 못한 만큼만 잃는다 — 크롭은 없는 것보다 낫다.
      return null;
    }
  }

  /**
   * 게스트 문서의 한 조각을 찍는다 — 플래너 창 capturePage 로. 게스트
   * `capturePage(clip)`는 (Electron 44 실측) 호출 뒤 main→게스트 `send`
   * 전달을 조용히 끊어 버린다 — 핀 스윕이 그 피해자다. 플래너 창은 보통
   * 창이라 capturePage 가 검증돼 있고, 웹뷰 요소는 그 합성에 포함된다
   * (스파이크 W3 픽셀 실측). 좌표는 CSS px (DIP) — 에뮬레이션 폭일 때는
   * 슬롯 폭 / 뷰포트 폭의 배율로 되돌린다.
   */
  private async captureViaWindow(
    crop: { x: number; y: number; width: number; height: number },
    viewport: { width: number; height: number } | null,
  ): Promise<Electron.NativeImage> {
    const window = this.window();
    if (!window || window.isDestroyed()) return nativeImage.createEmpty();
    const slot = (await window.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector("[data-testid=preview-slot]");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
    )) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    if (
      !slot ||
      typeof slot.x !== "number" ||
      typeof slot.y !== "number" ||
      typeof slot.width !== "number" ||
      typeof slot.height !== "number"
    ) {
      return nativeImage.createEmpty();
    }
    // 슬롯보다 큰 크기는 슬롯 전체(풀프레임)를 뜻한다.
    const full = crop.width >= slot.width && crop.height >= slot.height;
    const scale = viewport && viewport.width >= 1 ? Math.min(4, slot.width / viewport.width) : 1;
    const rect = full
      ? {
          x: Math.round(slot.x),
          y: Math.round(slot.y),
          width: Math.max(1, Math.round(slot.width)),
          height: Math.max(1, Math.round(slot.height)),
        }
      : {
          x: Math.round(slot.x + crop.x * scale),
          y: Math.round(slot.y + crop.y * scale),
          width: Math.max(1, Math.round(crop.width * scale)),
          height: Math.max(1, Math.round(crop.height * scale)),
        };
    return window.webContents.capturePage(rect);
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
        // The owner stamp first — the order against the crop is free, but the stamp
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
        const viewport = await this.viewportCss();
        const crop = cropRect(rect, viewport);
        // Wholly off screen (scrolled past, or beside the frame): no photo.
        if (!crop) return;
        try {
          const image = await this.captureViaWindow(crop, viewport);
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
      console: [...(this.activePage?.consoleLog ?? [])],
    };
    const contents = this.webContents();
    if (!contents) return result;
    try {
      await this.withOverlayHidden(async () => {
        // 게스트 capturePage 는 쓰지 않는다(전달 끊김, captureViaWindow 비고) —
        // 플래너 창으로 슬롯 전체를 찍는다.
        const image = await this.captureViaWindow(
          { x: 0, y: 0, width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER },
          await this.viewportCss(),
        );
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
    this.emulateWidth = width;
    const page = this.activePage;
    if (page) this.applyEmulation(page);
  }

  /**
   * 무대의 폭을 게스트에 입힌다 — activate 가 페이지마다 다시 부르므로
   * 프로젝트를 오가도 에뮬레이션은 무대의 선택을 따른다(이전에는 활성
   * 페이지에만 걸려, 돌아온 페이지가 낡은 뷰포트를 쥐었다).
   */
  private applyEmulation(page: PreviewPage): void {
    const contents = page.contents;
    if (contents.isDestroyed()) return;
    const width = this.emulateWidth;
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
    // loose 페이지도 preload 를 함께 실어 다니지만 bridge 는 repo 의 것이
    // 아니다: 링크 너머 페이지의 "pin" 은 통째로 버린다(kind 가 external 의
    // 자리를 대신한다).
    if (page?.kind !== "preview") return;
    const type = typeof payload?.type === "string" ? payload.type : "";
    if (type === "colo-design.pin" && this.activePage === page) {
      // 에이전트 입력 동안의 "핀"은 그 클릭이 삼킨 흔적일 뿐 사용자의 말이
      // 아니다 — 오버레이 깃발(col·overlay:agent)의 누수 대비 안전망이다
      // (베타 테스트 #2).
      if (this.agentInputDepth > 0) return;
      // inside is logged, never an unhandled rejection.
      void this.relayPin(payload as ColoDesignPinEnvelope).catch((error) => {
        console.error("preview pin relay failed", error);
      });
    } else if (type === "colo-design.pin-focus" && this.activePage === page) {
      this.send("colo-preview:pin-focus", payload);
    }
  }

  /**
   * 에이전트 입력의 깊이 — 브라우저 도구가 화면에 손을 대는 op(click · type
   * · drag …)의 동안만 0 이 아니다. 그 동안 오려내는 것은 둘: 오버레이의
   * 핀 캡처(preload 의 `colo-overlay:agent` 깃발)와, 여기서 새어 나오는 핀
   * 봉투(onOverlayPost 의 drop). 도구의 클릭은 화면을 확인하려는 손길이지
   * 사용자의 가리킴이 아니므로, 핀 모드가 켜져 있어도 그 클릭이 사용자의
   * 핀으로 쌓이는 일이 없어야 한다 (베타 테스트 #2).
   */
  private agentInputDepth = 0;
  private agentInputAcks = new Set<(sender: WebContents) => void>();

  async beginAgentInput(): Promise<void> {
    this.agentInputDepth += 1;
    await this.sendAgentInputState(true);
  }

  async endAgentInput(): Promise<void> {
    if (this.agentInputDepth === 0) return;
    this.agentInputDepth -= 1;
    await this.sendAgentInputState(false);
  }

  /** preload 의 준비 답 — 보내기와 그 다음 입력 dispatch 사이의 순서를
      지키는 유일한 근거라, sender 만 확인하고 넓게 푼다. */
  onAgentInputAck(sender: WebContents): void {
    for (const waiter of this.agentInputAcks) waiter(sender);
  }

  private async sendAgentInputState(on: boolean): Promise<void> {
    const contents = this.webContents();
    if (!contents) return;
    const delivered = Promise.withResolvers<void>();
    const waiter = (sender: WebContents) => {
      if (sender === contents) delivered.resolve();
    };
    this.agentInputAcks.add(waiter);
    contents.send("colo-overlay:agent", { on });
    // 게스트가 죽어 있으면 답도 없다 — op 가 멈추는 것보다 낫다, 유예 뒤에는
    // 답이 없어도 간다.
    const timer = setTimeout(() => delivered.resolve(), 500);
    try {
      await delivered.promise;
    } finally {
      clearTimeout(timer);
      this.agentInputAcks.delete(waiter);
    }
  }

  // ------------------------------------------------------------------ internals

  /** sender → 페이지. 파기된 페이지의 sender 는 죽었으므로 산 것만 돌면 그만이다. */
  private pageOf(sender: WebContents): PreviewPage | null {
    for (const page of this.pages.values()) {
      if (page.contents === sender) return page;
    }
    if (this.loose?.contents === sender) return this.loose;
    return null;
  }

  /**
   * 플래너 창을 이 미리보기에 물린다 — `webviewTag` 창 설정은 windows.ts 가
   * 이미 켰다. 여기서는 펜스(`will-attach-webview`)와 클레임
   * (`did-attach-webview`)을 창의 webContents에 건다. ⌘W로 창이 닫혔다 다시
   * 열리면 호출자가 다시 건다 — 게스트도 창과 함께 죽으니 레지스트리는
   * `destroyed`로 스스로 비운다.
   */
  attachWindow(window: BrowserWindow): void {
    const host = window.webContents;
    /** will-attach → did-attach 짝짓기 — 생성 순서(FIFO). 펜스가 거절한
     * 게스트는 did-attach가 아예 오지 않는다(스파이크 W4 실측). */
    const attachSrcQueue: string[] = [];
    // 렌더러가 겨눌 수 있는 주소를 loopback 미리보기로 가둔다 — 웹 UI가
    // 침해당해도 임의 origin·임의 preload의 게스트가 생기지 않는다.
    host.on("will-attach-webview", (event, webPreferences, params) => {
      if (params.src === undefined || !loopbackHttp(params.src)) {
        event.preventDefault();
        return;
      }
      // preload·파티션·보안 등급은 이 프로세스가 정한다 — 렌더러가 넘긴
      // 값은 무시한다. 파티션은 preview·web 모두가 같이 쓰는 단일 공유
      // 세션(오늘과 동일): 재시작에도 임의 사이트의 로그인이 살아 있다.
      webPreferences.preload = PREVIEW_PRELOAD;
      webPreferences.partition = "persist:preview";
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      attachSrcQueue.push(params.src);
    });
    host.on("did-attach-webview", (_event, guest) => {
      const src = attachSrcQueue.shift();
      if (src === undefined) return;
      this.claim(guest, src);
    });
  }

  /**
   * 붙어 온 게스트를 페이지로 세운다. 요소의 src가 열쇠다 — 마운트 레지스트리
   * 에 있으면 프로젝트 페이지, 없으면 loose. wantedOrigin·pendingLooseUrl 이
   * 가리키던 것이면 지금이 활성화 시점이다.
   */
  private claim(guest: WebContents, src: string): void {
    const origin = safeOrigin(src) || src;
    const mounted = this.mounts.get(origin);
    let page = this.pageAt(origin);
    if (page) {
      // 같은 origin의 요소가 다시 태어났다(개발 모드의 재마운트) — 새 게스트로 갈아탄다.
      // 옛 게스트는 요소가 철거되며 스스로 정리되고, 그 destroyed는 아래 가드(식별
      // 비교)가 이 페이지를 건드리지 못하게 한다. 리스너는 새 게스트에 다시 건다 —
      // 거둔 채 두면 팝업 핸들러·이동 가드·콘솔·키 전달이 전부 없는 몸통이 된다.
      page.contents = guest;
      this.attach(page);
      if (mounted && page.home === null) {
        page.home = origin;
        this.pages.set(origin, page);
        this.loose = null;
      }
    } else {
      page = {
        home: mounted ? origin : null,
        origin,
        kind: mounted ? "preview" : "web",
        contents: guest,
        epoch: mounted?.epoch ?? null,
        mountedUrl: src,
        failed: false,
        zoomFactor: 1,
        consoleLog: [],
        shownAt: 0,
      };
      if (page.home !== null) this.pages.set(origin, page);
      else this.loose = page;
      this.attach(page);
    }
    guest.once("destroyed", () => {
      // 요소 재생성으로 갈아탄 게스트 — 이 페이지의 몸이 아니면 잊지 않는다.
      if (page.contents !== guest) return;
      this.forget(page);
    });
    // 활성 대정렬 — 프로젝트 페이지는 mount가 원한 origin일 때, loose는
    // 활성 페이지 없이 부탁해 둔 바로 그 주소일 때 활성화된다.
    const wantedLoose = page.home === null && this.pendingLooseUrl === src;
    const wantedProject = page.home !== null && this.wantedOrigin === origin;
    if (wantedLoose || wantedProject) {
      this.pendingLooseUrl = null;
      this.activate(page);
    }
  }

  /**
   * 게스트가 죽었다(요소 철거·요소 재생성) — 레지스트리에서 잊는다. 화면의
   * 페이지였다면 pane이 빈 화면이 됐다는 말도 함께 간다.
   */
  private forget(page: PreviewPage): void {
    if (page.home !== null && this.pages.get(page.home) === page) this.pages.delete(page.home);
    if (this.loose === page) this.loose = null;
    if (this.activePage === page) {
      this.activePage = null;
      // 주소창·뒤로/앞으로 칩이 지난 페이지의 것을 들고 있지 않게 지운다.
      this.send("colo-preview:location", null);
    }
  }

  /**
   * 화면의 페이지를 바꾼다 — 요소의 보이기는 PreviewFrame이 이미 정했으므로
   * 여기서는 활성 참조와 오버레이 재무장·릴레이만 정렬한다. The overlay is
   * re-told the mode (D67) and the last pin sync (재설계 C1) it may have
   * missed while parked, and the renderer's picture of the pane — where it
   * is, whether it loads, its zoom — is replayed from this page's facts.
   */
  private activate(page: PreviewPage): void {
    this.activePage = page;
    page.shownAt = Date.now();
    const contents = page.contents;
    const preview = page.kind === "preview";
    // 무대의 폭 에뮬레이션은 페이지가 아니라 무대의 선택 — 돌아온 페이지에
    // 다시 입힌다(데스크톱이면 남은 에뮬레이션을 벗긴다).
    this.applyEmulation(page);
    // The repo overlay stays out of roamed pages: comments mode off, and
    // an empty pin list sweeps any badge a repo page left drawn.
    contents.send("colo-overlay:mode", { on: this.commentsOn && preview });
    this.sendPins(contents, preview ? (this.lastPins ?? { pins: [] }) : { pins: [] });
    this.sendLocation(page);
    this.send("colo-preview:loading", { on: contents.isLoading() });
    this.send("colo-preview:zoom", { factor: page.zoomFactor });
  }

  /**
   * A page's own ears, for its whole life. Every handler updates the page's
   * facts; only the page on screen relays them to the renderer — a parked
   * page reloading itself must not move the address bar or raise a banner
   * over the project the planner is looking at.
   */
  private attach(page: PreviewPage): void {
    const contents = page.contents;
    // 팝업은 pane 을 넘기지 않는다 — 페이지 하나가 화면의 전부라 window.open
    // 이 프로젝트 화면을 삼키는 일은 없다. http(s) 는 OS 브라우저가, 그 밖의
    // 스킴도 OS 가 본다.
    contents.setWindowOpenHandler(({ url }) => {
      openInOs(url);
      return { action: "deny" };
    });

    // will-navigate 는 http(s) 가드만 남는다. 어느 origin 으로의 이동이든 그
    // 자리에서 하게 두고, 그 판이 어떤 종류의 페이지인지는 did-navigate 가
    // 레지스트리로 다시 정한다.
    contents.on("will-navigate", (event, url) => {
      if (!httpUrl(url)) event.preventDefault();
    });
    contents.on("did-navigate", (_event, url) => {
      page.mountedUrl = url;
      page.failed = false;
      // ① kind 재계산 — URL 이 결정한다. repo origin 에 착지하면 preview 로,
      // 링크를 타고 나가면 web 으로.
      const origin = safeOrigin(url);
      if (origin !== "") {
        page.origin = origin;
        page.kind = this.mounts.has(origin) ? "preview" : "web";
      }
      if (this.activePage !== page) return;
      this.sendLocation(page);
      // ② 오버레이 재무장 — the overlay never announces itself; a fresh load
      // is re-told everything it needs. preview 페이지는 모드와 마지막 핀 동기,
      // 로밍 중인 페이지는 모드 off 와 빈 핀 스윕(앞 문서가 남긴 배지를 지운다).
      if (page.kind === "preview") {
        contents.send("colo-overlay:mode", { on: this.commentsOn });
        this.sendPins(contents, this.lastPins ?? { pins: [] });
        // ③ 페이지가 낡은 epoch 위에 서 있으면 그 뿌리로 다시 시작한다 —
        // 포트가 다른 프로젝트에 넘어갔을 수 있다. 재로드의 did-navigate 가
        // 다시 여기로 와 재무장한다.
        const mount = this.mounts.get(page.origin);
        if (mount && mount.epoch !== null && page.epoch !== null && page.epoch !== mount.epoch) {
          this.refresh(page, mount.url, mount.epoch);
        }
      } else {
        contents.send("colo-overlay:mode", { on: false });
        this.sendPins(contents, { pins: [] });
      }
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      page.mountedUrl = url;
      if (this.activePage !== page) return;
      this.sendLocation(page);
      // A SPA move swaps the screen without a load; replaying the sync lets
      // the overlay refilter its badges at once (재설계 C5) — the web's
      // onLocation resend confirms with the fresh list. kind 재계산은 필요
      // 없다(origin 은 안 바뀐다) — 핀 리플레이만 kind 가드로 통과한다.
      if (page.kind !== "preview") return;
      if (this.lastPins) this.sendPins(contents, this.lastPins);
    });
    contents.on("did-start-loading", () => {
      if (this.activePage === page) this.send("colo-preview:loading", { on: true });
    });
    contents.on("did-stop-loading", () => {
      if (this.activePage === page) this.send("colo-preview:loading", { on: false });
    });
    // D69: the pane's own ears — no repo hook. 44 의 형태: 첫 인자가 details
    // 이벤트다(level 은 "info"|"warning"|"error"|"debug"). D89: every line
    // lands in the ring buffer first — the 화면 보여 주기 turn quotes it.
    contents.on("console-message", (details) => {
      const line = `[${details.level}] ${details.message}`.slice(0, 500);
      page.consoleLog.push(line);
      if (page.consoleLog.length > 20) page.consoleLog.splice(0, page.consoleLog.length - 20);
      if (details.level !== "error" || this.activePage !== page) return;
      this.reportError(page, "runtime", details.message);
    });
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // -3 ERR_ABORTED is a navigation superseding itself, not a failure.
        if (!isMainFrame || errorCode === -3) return;
        page.failed = true;
        if (this.activePage !== page) return;
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
      if (this.activePage !== page) return;
      this.reportError(
        page,
        "runtime",
        `미리보기 프로세스가 죽었습니다 (${details?.reason ?? "unknown"})`,
      );
    });
    // D71: while the view holds focus the renderer DOM hears no keys — the
    // chords the web keymap owns (PageWorkspace: 팔레트 ⌘K, 설정 ⌘,, 저장 ⌘S,
    // 바로 가기 ⌘/, 핀 모드 ⌘⇧P) are forwarded and replayed as synthetic
    // keydowns (PreviewFrame), so the features stay reachable. control is
    // Windows/Linux's ⌘ slot — the gate treats it as the same modifier, or
    // the palette chord never leaves the pane there.
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const mod = Boolean(input.meta) || Boolean(input.control);
      const forward =
        input.key === "Escape" ||
        (mod &&
          (input.key === "k" ||
            input.key === "K" ||
            input.key === "," ||
            input.key === "/" ||
            input.key === "s" ||
            input.key === "S" ||
            ((input.key === "p" || input.key === "P") && Boolean(input.shift))));
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
    try {
      const url = new URL(at ?? page.contents.getURL());
      route = url.pathname.replace(/^\//, "");
    } catch {
      // A URL that will not parse has no screen to name; the message stands.
    }
    this.send("colo-preview:error", {
      type: "colo-design.error",
      kind,
      message,
      route,
    });
  }

  private sendLocation(page: PreviewPage): void {
    const contents = page.contents;
    let path = "/";
    let url = "";
    try {
      const parsed = new URL(contents.getURL());
      path = `${parsed.pathname}${parsed.search}`;
      url = parsed.toString();
    } catch {
      // Keep "/" — an unparseable url still deserves a back button state.
    }
    // loose 페이지가 막 태어났을 때의 주소는 about:blank 다 — 주소창엔 빈 칸이
    // 어울린다.
    if (url === "about:blank") path = "/";
    this.send("colo-preview:location", {
      /** preview 인지 web 인지 — external 불리어의 자리를 대신한다. */
      kind: page.kind,
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
// IPC surface: renderer → main commands. The renderer's
// preload exposes these only when `preview.native` is true, so the browser
// path never calls them.
// ---------------------------------------------------------------------------

export function registerPreviewIpc(view: PlannerPreviewView): void {
  // Routed by sender: a parked page's bridge may speak (its own reload) and
  // must reach its own page's facts, never the renderer.
  ipcMain.on("colo-overlay:post", (event, payload: { type?: unknown }) => {
    view.onOverlayPost(event.sender, payload);
  });
  ipcMain.on("colo-overlay:agent-ack", (event) => {
    view.onAgentInputAck(event.sender);
  });
  ipcMain.on("colo-overlay:capture-done", (event) => {
    if (event.sender !== view.webContents()) return;
    view.onCaptureDone();
  });
  // 오버레이의 스윕 폴백(ⓒ) — 배지가 남아 있는 동안 진실을 당겨간다.
  ipcMain.handle("colo-overlay:pins-poll", (event) => view.pinsFor(event.sender));
  ipcMain.handle("preview:mount", (_event, input: unknown) => {
    if (!input || typeof input !== "object" || !("url" in input) || typeof input.url !== "string") {
      return { ok: true };
    }
    // structured clone 은 NaN 을 그대로 건넨다 — typeof 숫자여도 스탯 체크
    // (NaN !== NaN) 가 늘 참이 되어 마운트마다 재적재 무한 고리에 빠진다.
    const epoch =
      "epoch" in input && typeof input.epoch === "number" && Number.isFinite(input.epoch)
        ? input.epoch
        : null;
    view.mount(input.url, epoch);
    return { ok: true };
  });
  ipcMain.handle("preview:unmount", () => {
    view.unmount();
    return { ok: true };
  });
  // PreviewFrame이 무대를 쥐고 있음을 알린다 — 거짓이면 링크·외부 열기가 OS
  // 브라우저로 넘어간다(옛 bounds 0 판정의 자리).
  ipcMain.handle("preview:host-ready", (_event, input: { on?: boolean }) => {
    view.setHostReady(Boolean(input?.on));
    return { ok: true };
  });
  ipcMain.handle("preview:open", (_event, input: { path?: string }) => {
    if (typeof input?.path === "string") view.open(input.path);
    return { ok: true };
  });
  // A link the planner clicked (설정 `앱에서 링크 열기`): openTab 이 판한다 —
  // repo origin 이면 그 프로젝트의 페이지로, 그 밖의 http(s) 는 화면의 페이지를
  // 제자리에서 이동, 슬롯이 없으면 OS 브라우저. the view decides, the renderer
  // only asks.
  ipcMain.handle("preview:open-external", (_event, input: { url?: unknown }) => {
    if (typeof input?.url === "string") view.openTab(input.url);
    return { ok: true };
  });
  ipcMain.handle("preview:navigate", (_event, input: { route?: string }) => {
    if (typeof input?.route === "string") view.navigate(input.route);
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
