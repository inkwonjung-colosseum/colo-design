import type { NovaDesignCommentTarget, NovaDesignPinsSync } from "@nova-design/protocol";
import { contextBridge, ipcRenderer } from "electron";

/**
 * 미리보기 뷰의 preload (PLAN D67 · D68 → D78 · D79; 재설계 C1·C3). Sandbox +
 * contextIsolation 아래 단일 파일로 살아야 한다 — 샌드박스 preload 의 require
 * 는 electron 과 몇 개 내장 모듈만 주므로, 요소 정체 조사(element-identity.ts)
 * 같은 순수 조각도 빌드가 이 파일에 끼워 넣는다(아래 declare 참조).
 *
 * 네 몫:
 * 1. 레포 브리지의 문 (D68): `window.novaDesign.post` — 핀 봉투가 나가는
 *    유일한 통로다(예전의 `nova-overlay:navigate` 역방향 문은 브리지의
 *    screens 계약이 폐지되며 함께 닫혔다).
 * 2. 핀 피커 오버레이 (재설계 C1·C9): 클릭은 요소 핀, 6px 넘는 드래그는
 *    영역 핀 — 봉투 하나씩이다. 초안·전송·영수증은 여기 없다(재설계 C3),
 *    크롬은 뷰가 찍는 순간에 채운다(재설계 C4). 핀 상태의 진실은 웹이 쥐고,
 *    웹의 전체 동기화(`nova-overlay:pins`)를 번호 배지로 투영한다 — 영역 핀은
 *    배지와 점선 테두리를 좌표(rect)로 다시 앵커한다. 봉투는 요소의
 *    HTML·스타일·a11y·속성 을 옵션으로 싣고, 클릭
 *    요소의 `data-nova-pick` 스탬프로 뷰가 main world 에서 React owner
 *    이름을 읽는다(fiber 는 이 isolated world 에서 보이지 않는다).
 */

// ---------------------------------------------------------------------------
// Element identity — the isolated world cannot see the page's
// React fiber expandos, so the component name is the tag,
// and the owner chain is the view's job (the `data-nova-pick` stamp + the
// main-world script). Everything else (own text, CSS path from the body,
// rect, html, styles, a11y, attrs) is plain DOM — and it all lives in
// element-identity.ts now, spliced into this file at build time (§3.E-1).
// ---------------------------------------------------------------------------

function ownText(element: Element): string {
  let text = "";
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * 요소 정체 추출의 한 벌화 (PLAN-MCP §3.E-1) — 본체는 element-identity.ts 의
 * describeElementInPage 다. 샌드박스 preload 는 로컬 require 가 안 되므로
 * 빌드(scripts/build-preloads.mjs)가 그 함수를 이 파일의 꼬리에 이어 붙인다;
 * 여기는 선언만 둔다. 드라이버의 browser_inspect 도 같은 소스를
 * Runtime.callFunctionOn 으로 페이지(메인 월드)에서 돌린다. 아래 ownText 는
 * 호버 라벨이 쓰는 작은 복사다 — 봉투의 text 칸은 저 함수 몸의 같은 판정이
 * 낸다.
 */
declare function describeElementInPage(this: unknown, el?: unknown): NovaDesignCommentTarget | null;

/**
 * The screen the page is showing right now — the context every envelope
 * carries. The page IS its path: the route without the leading slash is the
 * screen id (`index` at the root), and the daemon stores that id verbatim
 * (2026-09-21 레포 마커 철거 — `[data-screen]` 은 더 읽지 않는다).
 */
function pageContext(): { screen: string } {
  const id = window.location.pathname.replace(/^\/+/, "");
  return { screen: id === "" ? "index" : id };
}

// ---------------------------------------------------------------------------
// 1. The repo bridge's door (D68)
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld("novaDesign", {
  post: (envelope: unknown) => ipcRenderer.send("nova-overlay:post", envelope),
});

// ---------------------------------------------------------------------------
// 2. The pin picker overlay (재설계 C1). All styling inline — the repo's
// classes are the repo's; pointer-events none on the root so the page stays
// live. The overlay owns NOTHING: a click posts one envelope and draws an
// optimistic badge, and the web's whole-list sync (`nova-overlay:pins`)
// redraws badges from the truth — another screen's pin draws none (재설계
// C5), sending and receipts live in the composer (재설계 C3).
//
// D79: the root mounts once at DOMContentLoaded and never leaves. The click
// capture intervenes only when the pin mode is on OR Alt is held — the
// page's own clicks stay alive, and ⌥+클릭 pinches a pin in any mode.
// ---------------------------------------------------------------------------

/** One drawn badge — the web's pin row, projected onto this page's element. */
interface Badge {
  id: string;
  /** Held only while drawn; the sync re-anchors by `path` when it dies.
      Null for a region pin — that one rides `rect` instead. */
  anchor: Element | null;
  /** Page coordinates (재설계 C9) — a region pin's anchor. */
  rect?: { x: number; y: number; width: number; height: number };
  number: number;
  /**
   * 고침 표시: live is the accent pin, sent the turn's
   * grey, done the settled 수정 마크 — solid green, it outlives its turn.
   */
  tone: "live" | "sent" | "done";
}

/** The overlay's one accent (the app's `--accent`, sent by the mode payload) —
    the fallback is today's red, worn only before the first payload lands. */
let accent = "#e05252";
/** The words the overlay speaks — all of them arrive by the mode payload; the
    preload cannot read the web's labels. Empty until then. */
const words: Record<string, string> = {};

/** The badge's one color per tone — done reads as settled, not as sent. The
    live tone follows the app's accent (`applySkin` moves it). */
const badgeColors: Record<Badge["tone"], string> = {
  live: "#e05252",
  sent: "#9ca3af",
  done: "#16a34a",
};

/** The accent at an alpha — a hex the app computed for us, or today's red. */
function accentAlpha(alpha: number): string {
  const hex = accent.startsWith("#") ? accent.slice(1) : "";
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (full.length !== 6 || /[^0-9a-f]/i.test(full)) return `rgba(224,82,82,${alpha})`;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const Z = "2147483000";
const root = document.createElement("div");
root.setAttribute("data-nova-design-overlay", "");
root.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${Z};font-family:system-ui,-apple-system,sans-serif;`;

/**
 * Where every toast lands: one stacking column that `renderOverlay` never
 * sweeps. `aria-live` says them out loud.
 */
const toasts = document.createElement("div");
toasts.setAttribute("role", "status");
toasts.setAttribute("aria-live", "polite");
toasts.style.cssText =
  "position:fixed;right:16px;bottom:64px;display:flex;flex-direction:column-reverse;align-items:flex-end;gap:6px;pointer-events:none;";
root.appendChild(toasts);

let mode = false;
/**
 * 도구가 화면에 손을 대는 동안만 참이 되는 깃발(`nova-overlay:agent`) —
 * pickingNow 의 맨 앞 관문이다. 브라우저 도구의 클릭은 화면을 확인하려는
 * 손길이지 사용자의 가리킴이 아니므로, 핀 모드가 켜져 있어도 그 클릭이
 * 핀으로 기록되거나 링크를 삼켜서는 안 된다 (베타 테스트 #2).
 */
let agentDriving = false;
let altHeld = false;
let badges: Badge[] = [];
let hover: HTMLDivElement | null = null;
let hoverTarget: Element | null = null;
/**
 * The hover box's name tag — the planner's words (the accent tab, the same
 * name the bubble and the tray row use) and, when an interactive element
 * carries no accessible name at all, the yellow 이름 없음 under it. Lives and
 * dies with `hover`.
 */
let hoverTag: {
  box: HTMLElement;
  label: HTMLElement;
  warn: HTMLElement;
} | null = null;

/** The tags a planner can pin asking "this does not say what it does" —
    the only ones where a missing accessible name is the pin's own story.
    The check follows `closest`, so a hover on an icon svg answers for the
    button it sits in. */
const INTERACTIVE_SELECTOR = "button, a, input, select, textarea";

/** The element's easy kind — the words a planner uses, not the tag a browser
    does. Everything the page builds out of boxes reads as one word. */
function kindWord(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "button") return words.kindButton ?? "";
  if (tag === "a") return words.kindLink ?? "";
  if (["img", "picture", "svg", "video", "canvas"].includes(tag)) return words.kindImage ?? "";
  if (tag === "input" || tag === "select" || tag === "textarea") return words.kindInput ?? "";
  return words.kindOther ?? "";
}

/**
 * The tag's one line: the name the pin bubble would show — own words, a
 * declared label, or the easy kind when the element says nothing. An
 * interactive element whose name is nowhere (no aria-label/title/alt, no own
 * words, no placeholder/value) also says 이름 없음: that gap is the one thing
 * a planner can pin and ask fixed in the same breath. The name is asked of
 * the nearest interactive element — the hover usually lands on the icon or
 * label inside it.
 */
function hoverName(element: Element): { name: string; unnamed: boolean } {
  const interactive = element.closest(INTERACTIVE_SELECTOR);
  let unnamed = false;
  if (interactive) {
    const it = interactive.tagName.toLowerCase();
    const named =
      ownText(interactive) !== "" ||
      interactive.getAttribute("aria-label") !== null ||
      interactive.getAttribute("title") !== null ||
      (it !== "input" && it !== "textarea" && interactive.getAttribute("alt") !== null) ||
      interactive.getAttribute("placeholder") !== null ||
      (it === "input" && interactive.getAttribute("value") !== null);
    unnamed = !named;
  }
  const raw =
    ownText(element) ||
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("placeholder") ||
    interactive?.getAttribute("aria-label") ||
    interactive?.getAttribute("title") ||
    (element.tagName.toLowerCase() === "img" ? element.getAttribute("alt") : null) ||
    kindWord(interactive ?? element) ||
    kindWord(element);
  const name = raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
  return { name, unnamed };
}
/** The region drag in flight (재설계 C9) — a picking press that may yet
    become a drag; null while no press is down. */
let drag: {
  /** The press point in page coordinates — the rect's scroll-invariant frame. */
  x: number;
  y: number;
  /** The same point in viewport coordinates — where the live box draws. */
  vx: number;
  vy: number;
  /** True once the move passed the 6px line — the press IS a drag now. */
  active: boolean;
  /** The translucent selection square, drawn while `active`. */
  box: HTMLElement | null;
} | null = null;
/** One shot: the click that trails a sent region drag (mouseup → click). */
let swallowClick = false;
let layoutStop: (() => void) | null = null;
let layoutTimer: number | null = null;
/** The one flash stopper — the ring and its timers clean themselves up. */
let flashStop: (() => void) | null = null;
/** Where the page remembers that the ⌥+클릭 hint has been said once. */
const HINT_SEEN = "nova-design.pin-hint";

function isOverlayUi(target: EventTarget | null): boolean {
  return target instanceof Node && root.contains(target);
}
/** The crosshair while picking — injected for the whole page except the
    overlay's own handles (a badge keeps its pointer cursor). */
let cursorStyle: HTMLStyleElement | null = null;
function setPickCursor(on: boolean): void {
  if (on === (cursorStyle !== null)) return;
  if (on) {
    cursorStyle = document.createElement("style");
    cursorStyle.textContent =
      "body,body *:not([data-nova-design-overlay] *){cursor:crosshair!important}";
    document.documentElement.appendChild(cursorStyle);
  } else {
    cursorStyle?.remove();
    cursorStyle = null;
  }
}

function setMode(on: boolean): void {
  mode = on;
  // D79: turning the mode off keeps the root and every badge — badges are
  // the web's pin list projected, not the mode's. Only the hover (a picking
  // affordance) is mode's.
  if (!on) {
    hover?.remove();
    hover = null;
    hoverTag = null;
    hoverTarget = null;
    stopHoverLoop();
  }
  setPickCursor(on || altHeld);
  if (!root.isConnected && document.body) document.body.appendChild(root);
  scheduleLayout();
}

// ---------------------------------------------------------------------------
// Layout — event-driven (D78), not a frame loop. Hover gets the rAF loop,
// and only while it exists (D79).
// ---------------------------------------------------------------------------

function scheduleLayout(): void {
  if (layoutTimer !== null) return;
  layoutTimer = window.setTimeout(() => {
    layoutTimer = null;
    layoutOverlay();
  }, 100);
}

function startHoverLoop(): void {
  if (layoutStop) return;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    layoutHover();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  layoutStop = () => {
    stopped = true;
    layoutStop = null;
  };
}

function stopHoverLoop(): void {
  layoutStop?.();
}

function layoutHover(): void {
  if (!hover || !hoverTarget) return;
  const rect = hoverTarget.getBoundingClientRect();
  Object.assign(hover.style, {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  // The tag hangs above the box, its bottom on the element's top edge — or
  // inside it when the element is against the top of the viewport. A tag
  // the planner cannot read is no tag.
  if (hoverTag) {
    const height = hoverTag.box.offsetHeight;
    hoverTag.box.style.top = rect.y >= height + 2 ? `${-height - 1}px` : "0px";
  }
}

/** Badges ride their held element — the element's top-right corner, pulled
    into the viewport just enough not to hang off the preview. */
function layoutOverlay(): void {
  layoutHover();
  for (const badge of badges) {
    const circle = root.querySelector<HTMLElement>(`[data-pin="${CSS.escape(badge.id)}"]`);
    if (!circle) continue;
    // A region badge anchors on page coordinates — scroll them back out to
    // reach the viewport (재설계 C9); the scroll/resize re-layout keeps it
    // honest while the page moves under it.
    if (badge.rect) {
      const left = badge.rect.x - window.scrollX;
      const top = badge.rect.y - window.scrollY;
      const box = root.querySelector<HTMLElement>(`[data-pin-box="${CSS.escape(badge.id)}"]`);
      if (box) {
        Object.assign(box.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${badge.rect.width}px`,
          height: `${badge.rect.height}px`,
          visibility: "visible",
        });
      }
      circle.style.visibility = "visible";
      circle.style.left = `${Math.round(Math.max(0, Math.min(window.innerWidth - 24, left + badge.rect.width - 12)))}px`;
      circle.style.top = `${Math.round(Math.max(0, Math.min(window.innerHeight - 24, top - 12)))}px`;
      continue;
    }
    if (!badge.anchor?.isConnected) {
      // The page moved under the badge; the next sync re-anchors by path.
      circle.style.visibility = "hidden";
      continue;
    }
    const rect = badge.anchor.getBoundingClientRect();
    const left = Math.max(0, Math.min(window.innerWidth - 24, rect.right - 12));
    const top = Math.max(0, Math.min(window.innerHeight - 24, rect.top - 12));
    circle.style.visibility = "visible";
    circle.style.left = `${Math.round(left)}px`;
    circle.style.top = `${Math.round(top)}px`;
  }
}

// ---------------------------------------------------------------------------
// Input — the D79 gate. Clicks are intercepted only for the mode or Alt;
// hover highlighting is the mode's, or Alt's while it is held.
// ---------------------------------------------------------------------------

function pickingNow(event?: MouseEvent): boolean {
  // D79: the plan's gate is `mode || event.altKey` — the held-key flag is a
  // third OR for hover highlighting (which has no event in hand).
  if (agentDriving) return false;
  return mode || Boolean(event?.altKey) || altHeld;
}

document.addEventListener(
  "mouseover",
  (event) => {
    if (isOverlayUi(event.target)) return;
    // The event's own altKey rides every real mouseover regardless of who
    // holds keyboard focus (커미티 판정 2, 2026-09-14): after relayPin focuses
    // the composer the preview document stops seeing keydowns, so altHeld
    // alone would kill the highlight from the SECOND ⌥+hover on.
    if (!pickingNow(event)) return;
    // A drag owns the cursor — highlighting under a held press is noise.
    if (drag) return;
    const element = event.target instanceof Element ? event.target : null;
    // Any element can take a pin now, so the highlight follows everything.
    hoverTarget = element;
    if (!hoverTarget) {
      hover?.remove();
      hover = null;
      hoverTag = null;
      stopHoverLoop();
      return;
    }
    if (!hover) {
      hover = document.createElement("div");
      hover.setAttribute("data-nova-hover", "");
      hover.style.cssText = `position:fixed;outline:2px solid ${accent};outline-offset:1px;pointer-events:none;`;
      // The tag says what the pin would be called — the bubble's own name
      // words on the accent tab, and 이름 없음 under it when an interactive
      // element says nothing at all.
      const box = el(
        "div",
        "position:absolute;left:0;display:flex;flex-direction:column;align-items:flex-start;pointer-events:none;",
      );
      const label = el(
        "span",
        "color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;line-height:1.5;font-weight:600;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;",
      );
      const warn = el(
        "span",
        "background:rgba(17,17,17,.88);color:#fbbf24;border-radius:0 0 4px 4px;padding:1px 6px;font-size:10px;line-height:1.5;white-space:nowrap;",
        words.unnamed ?? "",
      );
      box.appendChild(label);
      box.appendChild(warn);
      hover.appendChild(box);
      hoverTag = { box, label, warn };
      root.appendChild(hover);
      startHoverLoop();
    }
    if (hoverTag && hoverTarget) {
      const { name, unnamed } = hoverName(hoverTarget);
      hoverTag.label.textContent = name;
      hoverTag.label.style.background = accent;
      hoverTag.label.style.borderRadius = unnamed ? "4px 4px 0 0" : "4px";
      hoverTag.warn.textContent = words.unnamed ?? "";
      hoverTag.warn.style.display = unnamed ? "" : "none";
    }
  },
  true,
);

document.addEventListener(
  "click",
  (event) => {
    // A sent region drag ends in a click-shaped tail on the common ancestor;
    // the drag already posted its pin — swallow this one whatever the gate
    // says, or it would wait and eat the NEXT real click.
    if (swallowClick) {
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // ⌥+클릭 (D79): the Alt sign works in any mode, and the click never
    // reaches the page (capture-stage preventDefault — Chromium's
    // Alt+link = download dies here too).
    if (!pickingNow(event) || isOverlayUi(event.target)) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    const target = describeElementInPage(element);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    // One gesture, one envelope (재설계 C1 · C4): the rect rides as measured
    // NOW — the view crops this instant, not a send-moment re-measure — and
    // the web parks the pin as a composer attachment. The badge below is
    // optimistic; the web's sync redraws the truth (and the numbering).
    const pin = {
      id: crypto.randomUUID(),
      ...pageContext(),
      element: target,
    };
    // The view reads the React owner chain off this stamp in the main
    // world (fibers are invisible from this isolated world) and removes it —
    // the timer below is only this side's safety net.
    element.setAttribute("data-nova-pick", pin.id);
    window.setTimeout(() => {
      if (element.getAttribute("data-nova-pick") === pin.id) {
        element.removeAttribute("data-nova-pick");
      }
    }, 3000);
    ipcRenderer.send("nova-overlay:post", { type: "nova-design.pin", pin });
    freshPins.add(pin.id);
    badges = [...badges, { id: pin.id, anchor: element, number: badges.length + 1, tone: "live" }];
    renderOverlay();
    armPinsPoll();
  },
  true,
);

// ---------------------------------------------------------------------------
// Region drag (재설계 C9). While picking, a press that travels past 6px
// is a region, not a sloppy click: the mouseup posts the drag's envelope in
// scroll-invariant page coordinates, and the trailing click is swallowed.
// The root is pointer-events:none — the page's own elements receive every
// event — so the gate is document-level capture, and the selection/native
// drags die by preventDefault, not by CSS.
// ---------------------------------------------------------------------------

/** Past this many pixels a picking press is a drag. */
const DRAG_PX = 6;

document.addEventListener(
  "mousedown",
  (event) => {
    // A stale swallow (a region drag whose click never fired) dies here —
    // the next press is a new gesture, whatever it turns out to be.
    swallowClick = false;
    if (event.button !== 0 || !pickingNow(event) || isOverlayUi(event.target)) return;
    drag = {
      x: event.pageX,
      y: event.pageY,
      vx: event.clientX,
      vy: event.clientY,
      active: false,
      box: null,
    };
    // The press belongs to the picker now — a page selection or a native
    // image/link drag would fight the region.
    event.preventDefault();
  },
  true,
);

document.addEventListener(
  "mousemove",
  (event) => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(event.pageX - drag.x, event.pageY - drag.y) <= DRAG_PX) return;
      drag.active = true;
      // The drag takes the gesture over — hover highlighting steps aside.
      hover?.remove();
      hover = null;
      hoverTag = null;
      hoverTarget = null;
      stopHoverLoop();
      drag.box = el(
        "div",
        `position:fixed;border:1px dashed ${accent};background:${accentAlpha(0.12)};pointer-events:none;`,
      );
      root.appendChild(drag.box);
    }
    Object.assign(drag.box!.style, {
      left: `${Math.min(drag.vx, event.clientX)}px`,
      top: `${Math.min(drag.vy, event.clientY)}px`,
      width: `${Math.abs(event.clientX - drag.vx)}px`,
      height: `${Math.abs(event.clientY - drag.vy)}px`,
    });
    event.preventDefault();
  },
  true,
);

document.addEventListener(
  "mouseup",
  (event) => {
    if (!drag) return;
    const press = drag;
    drag = null;
    press.box?.remove();
    // A click, not a drag — the click gate above does its usual element pin.
    if (!press.active) return;
    swallowClick = true;
    // The browser fires the trailing click within a beat; a click that never
    // comes (release outside the page) must not eat the planner's NEXT pin —
    // the flag expires on its own.
    window.setTimeout(() => {
      swallowClick = false;
    }, 250);
    // Page coordinates, scroll deliberately left in (재설계 C9): the badge
    // re-anchors on scroll and the web redraws the same numbers. The viewport
    // twin (`rectView`) rides along for the app's bubble — a region pin has
    // no element to re-measure, and the page box would place the bubble off
    // by the scroll.
    const rect = {
      x: Math.round(Math.min(press.x, event.pageX)),
      y: Math.round(Math.min(press.y, event.pageY)),
      width: Math.round(Math.abs(event.pageX - press.x)),
      height: Math.round(Math.abs(event.pageY - press.y)),
    };
    const rectView = {
      x: Math.round(Math.min(press.x, event.pageX) - window.scrollX),
      y: Math.round(Math.min(press.y, event.pageY) - window.scrollY),
      width: rect.width,
      height: rect.height,
    };
    const pin = {
      id: crypto.randomUUID(),
      ...pageContext(),
      element: {
        kind: "region",
        component: words.region ?? "",
        text: "",
        path: "",
        rect,
        rectView,
      },
    };
    ipcRenderer.send("nova-overlay:post", { type: "nova-design.pin", pin });
    // The optimistic badge draws the region the moment the press lifts — the
    // web's sync (the truth, and the numbering) lands a beat later.
    freshPins.add(pin.id);
    badges = [
      ...badges,
      { id: pin.id, anchor: null, rect, number: badges.length + 1, tone: "live" },
    ];
    renderOverlay();
    armPinsPoll();
  },
  true,
);

// A drag in flight owns the gesture end to end — no selection starting, no
// native drag; focus loss kills it where no mouseup will ever come.
document.addEventListener(
  "dragstart",
  (event) => {
    if (drag) event.preventDefault();
  },
  true,
);
document.addEventListener(
  "selectstart",
  (event) => {
    if (drag) event.preventDefault();
  },
  true,
);
window.addEventListener("blur", () => {
  if (!drag) return;
  drag.box?.remove();
  drag = null;
});

// Alt hovering outside the mode: keydown/keyup, blur clears (D79).
function setAlt(on: boolean): void {
  if (altHeld === on) return;
  altHeld = on;
  setPickCursor(mode || on);
  if (!on) {
    hover?.remove();
    hover = null;
    hoverTag = null;
    hoverTarget = null;
    stopHoverLoop();
  }
}
document.addEventListener("keydown", (event) => {
  // Option is a mac text key as much as a modifier: held over the overlay's
  // own UI it is the planner reaching a badge, not aiming at the page.
  if (event.altKey && !isOverlayUi(event.target)) setAlt(true);
});
document.addEventListener("keyup", (event) => {
  if (!event.altKey) setAlt(false);
});
window.addEventListener("blur", () => setAlt(false));
// 뒤로/앞으로: the sync refilters badges against the screen the page shows
// now (재설계 C5) — relayout keeps the rest honest meanwhile.
window.addEventListener("popstate", scheduleLayout);
// A badge rides its held element — when the page moves under it, the badge
// has to follow (scroll and resize re-layout below do the same job).
const anchorWatch = new MutationObserver(() => scheduleLayout());
document.addEventListener("scroll", scheduleLayout, true);
window.addEventListener("resize", scheduleLayout);

function el(tag: string, style: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The drawn half of a badge — the number circle and, for a region, the
    dashed box. Kept by pin id across syncs: only what changed moves (number ·
    tone · color), what vanished fades out. This is what lets a badge carry
    animation and hover at all — an element rebuilt every sync could not. */
const badgeEls = new Map<string, { circle: HTMLButtonElement; box?: HTMLDivElement }>();

/** The pins this document just made — a click or a region drag. Only these
    are greeted (pop · ripple · flash); a sync that first shows an older pin
    stands it quietly, or every reload and return would cheer at once. */
const freshPins = new Set<string>();

/** The page asked for less motion — the guest honors its own ear; the
    preload has none. Every move below asks this first. */
function reducedMotion(): boolean {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function badgeLabel(badge: Badge): string {
  return (
    `${words.badge ?? ""} ${badge.number}${
      badge.tone === "sent"
        ? ` ${words.badgeSent ?? ""}`
        : badge.tone === "done"
          ? ` ${words.badgeDone ?? ""}`
          : ""
    }`.trim() || String(badge.number)
  );
}

function makeBadgeCircle(badge: Badge): HTMLButtonElement {
  const circle = el(
    "button",
    `pointer-events:auto;position:fixed;width:24px;height:24px;padding:0;border:2px solid #fff;border-radius:999px;background:${badgeColors[badge.tone]};color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);`,
    String(badge.number),
  ) as HTMLButtonElement;
  circle.dataset.pin = badge.id;
  circle.setAttribute("aria-label", badgeLabel(badge));
  // The badge is a handle: clicking it asks the web to focus the pin's
  // row in the composer — its memo field.
  circle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    ipcRenderer.send("nova-overlay:post", { type: "nova-design.pin-focus", id: badge.id });
  });
  return circle;
}

/** A region badge's dashed box (재설계 C9) — page coordinates, positioned by
    layoutOverlay on every scroll. */
function makeBadgeBox(badge: Badge): HTMLDivElement {
  const box = el(
    "div",
    `position:fixed;border:1px dashed ${badgeColors[badge.tone]};pointer-events:none;`,
  ) as HTMLDivElement;
  box.dataset.pinBox = badge.id;
  return box;
}
/** What a sync can change about a badge that already stands: its number, its
    tone's color, its spoken label. Nothing here re-creates an element. */
function syncBadgeDom(
  badge: Badge,
  holder: { circle: HTMLButtonElement; box?: HTMLDivElement },
): void {
  holder.circle.textContent = String(badge.number);
  holder.circle.style.background = badgeColors[badge.tone];
  holder.circle.setAttribute("aria-label", badgeLabel(badge));
  if (holder.box) holder.box.style.borderColor = badgeColors[badge.tone];
}

/** The pinned point in viewport coordinates — where a ripple begins. */
function badgePoint(badge: Badge): { x: number; y: number } | null {
  if (badge.rect) {
    return {
      x: badge.rect.x - window.scrollX + badge.rect.width / 2,
      y: badge.rect.y - window.scrollY + badge.rect.height / 2,
    };
  }
  const rect = badge.anchor?.getBoundingClientRect();
  return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
}

/** One ripple from the pinned point — the pin landing in water. */
function rippleAt(x: number, y: number): void {
  const ring = el(
    "div",
    `position:fixed;left:${Math.round(x - 9)}px;top:${Math.round(y - 9)}px;width:18px;height:18px;border:2px solid ${accent};border-radius:50%;pointer-events:none;`,
  );
  root.appendChild(ring);
  const gone = ring.animate(
    [
      { transform: "scale(0.5)", opacity: 0.9 },
      { transform: "scale(3.6)", opacity: 0 },
    ],
    { duration: 380, easing: "cubic-bezier(.2,.7,.3,1)" },
  );
  gone.onfinish = () => ring.remove();
  // 안전망 — 애니메이션이 끝을 못 알리는 세계에서도 물결은 지워진다.
  window.setTimeout(() => {
    if (ring.isConnected) ring.remove();
  }, 600);
}

/** A pin's greeting, once per id: the badge springs in, a ripple runs from
    the pinned point, and the flash ring passes over the element once. The
    sync that follows updates the same element in place, so the greeting
    never repeats for one pin. */
function greetNewBadge(badge: Badge, circle: HTMLButtonElement): void {
  if (reducedMotion()) {
    flashPin(badge.id, { scroll: false });
    return;
  }
  circle.animate(
    [
      { transform: "scale(0.4)" },
      { transform: "scale(1.12)", offset: 0.7 },
      { transform: "scale(1)" },
    ],
    { duration: 180, easing: "cubic-bezier(.2,.8,.3,1)" },
  );
  const point = badgePoint(badge);
  if (point) rippleAt(point.x, point.y);
  flashPin(badge.id, { scroll: false });
}

/** A badge leaving the list — a short fade, then gone. Sent pins ride this
    on their way out; a pin that comes right back draws a fresh circle. */
function retireBadge(holder: { circle: HTMLButtonElement; box?: HTMLDivElement }): void {
  const circle = holder.circle;
  const box = holder.box;
  circle.style.pointerEvents = "none";
  if (reducedMotion()) {
    circle.remove();
    box?.remove();
    return;
  }
  const out = [{ opacity: 1 }, { opacity: 0 }];
  circle.animate(out, { duration: 160, easing: "ease-out" }).onfinish = () => circle.remove();
  const boxGone = box?.animate(out, { duration: 160, easing: "ease-out" });
  if (boxGone) boxGone.onfinish = () => box?.remove();
  window.setTimeout(() => {
    if (circle.isConnected) circle.remove();
    if (box?.isConnected) box.remove();
  }, 400);
}

function renderOverlay(): void {
  const seen = new Set<string>();
  for (const badge of badges) {
    seen.add(badge.id);
    const holder = badgeEls.get(badge.id);
    if (!holder) {
      const fresh: { circle: HTMLButtonElement; box?: HTMLDivElement } = {
        circle: makeBadgeCircle(badge),
      };
      if (badge.rect) {
        fresh.box = makeBadgeBox(badge);
        root.appendChild(fresh.box);
      }
      root.appendChild(fresh.circle);
      badgeEls.set(badge.id, fresh);
      // The greeting belongs to a pin this document just made — a sync's
      // first sight of an older pin stands it quietly.
      if (freshPins.delete(badge.id)) greetNewBadge(badge, fresh.circle);
      continue;
    }
    syncBadgeDom(badge, holder);
  }
  for (const [id, holder] of badgeEls) {
    if (seen.has(id)) continue;
    badgeEls.delete(id);
    retireBadge(holder);
  }
  layoutOverlay();
}

/** A sync pin's rect is an anchor only when it is four finite numbers. */
function readRect(
  value: NovaDesignPinsSync["pins"][number]["rect"],
): { x: number; y: number; width: number; height: number } | null {
  if (!value) return null;
  const { x, y, width, height } = value;
  const ok =
    Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height);
  return ok ? { x, y, width, height } : null;
}

/**
 * The web's whole pin list (재설계 C1) — the truth; the drawn badges are
 * its diff (same id updates in place, vanished ids fade out).
 * Only THIS screen's pins draw badges (재설계 C5); the number is the mark
 * registry's `n` when the web sends one, else the row's place in the list.
 *
 * 도착은 두 갈래로 듣는다: ipcRenderer 채널과, main이 게스트 안에서
 * 발사하는 CustomEvent("nova-pins-sync"). 한 핀을 찍고 나면(실측, Electron
 * 44 webview) 그 문서의 main→게스트 ipcRenderer 전달이 조용히 죽는다 —
 * CustomEvent 갈래가 그 뒤를 잇는다(main→게스트 executeJavaScript 는
 * 살아 있다).
 */
function applyPinsSync(sync: NovaDesignPinsSync | undefined | null): void {
  const here = pageContext();
  const rows = Array.isArray(sync?.pins) ? sync.pins : [];
  badges = rows.flatMap((pin, index): Badge[] => {
    // A badge belongs to the screen it was pinned on(커미티 차단 4 계승):
    // the same CSS path on another screen is a different view — the tray row
    // keeps saying its own screen and the badge must not contradict it from
    // another screen's page.
    if (pin.screen !== here.screen) return [];
    // (2026-09-21 레포 마커 철거 — screen 이 항상 경로 신원이므로 위의
    // 화면 비교가 곧 페이지 비교다. 별도의 pagePath 근거는 없다.)
    // 고침 표시: the registry's `n` is the badge's number —
    // the list index is only the fallback for a web that predates it.
    const number = typeof pin.n === "number" ? pin.n : index + 1;
    const tone: Badge["tone"] =
      pin.tone === "done" || pin.tone === "sent" || pin.tone === "live"
        ? pin.tone
        : pin.sent
          ? "sent"
          : "live";
    // 화면 마크: no element, no rect — the badge docks on the page's own
    // corner(2026-09-21 레포 마커 철거 — 닻은 body 다).
    if (pin.screenMark) {
      const frame = document.body;
      return [{ id: pin.id, anchor: frame, number, tone }];
    }
    // A region pin (빈 path, 재설계 C9) has no element to find — its rect in
    // page coordinates IS the anchor; without a usable rect there is nothing
    // to draw, same as an element whose path no longer parses.
    if (pin.path === "") {
      const rect = readRect(pin.rect);
      return rect ? [{ id: pin.id, anchor: null, rect, number, tone }] : [];
    }
    // A live anchor beats the path — the element may have moved since the
    // web last heard of it. A path the changed page no longer parses draws
    // no badge either: the row still lives in the composer.
    let anchor =
      badges.find((badge) => badge.id === pin.id && badge.anchor?.isConnected)?.anchor ?? null;
    if (!anchor) {
      try {
        anchor = document.querySelector(pin.path);
      } catch {
        // An unparseable path is no anchor.
      }
    }
    return anchor ? [{ id: pin.id, anchor, number, tone }] : [];
  });
  renderOverlay();
  armPinsPoll();
}

ipcRenderer.on("nova-overlay:pins", (_event, sync: NovaDesignPinsSync) => applyPinsSync(sync));

/**
 * 스윕의 폴백(ⓒ): 핀을 찍고 난 뒤(실측, Electron 44 webview) 그 문서의
 * main→게스트 전달이 조용히 죽는다 — 위 채널이 도착하지 못한 채 배지가
 * 화면에 남는다. 게스트→main invoke 는 살아 있으므로(핀 post가 그 증거),
 * 배지가 남아 있는 동안 진실(lastPins)을 당겨온다. 도착한 위 채널과 같은
 * 값을 다시 그릴 뿐 — 잉여지만 무해하다.
 */
let pinsPollTimer: number | null = null;
function armPinsPoll(): void {
  if (pinsPollTimer !== null || badges.length === 0) return;
  const tick = () => {
    pinsPollTimer = null;
    if (badges.length === 0) return;
    void ipcRenderer
      .invoke("nova-overlay:pins-poll")
      .then((sync) => {
        applyPinsSync(sync as NovaDesignPinsSync);
      })
      .catch(() => undefined);
    window.setTimeout(armPinsPoll, 600);
  };
  pinsPollTimer = window.setTimeout(tick, 600);
}

/** 칩 클릭 → 배지 (재설계 C1): 화면 밖의 핀이면 먼저 그 화면으로 스크롤해
 * 들어간 뒤(영역 핀은 그 상자로), 고리와 배지 빛이 두 번 맥동하며 "여기"를
 * 눈으로 찾게 한다. 찍는 순간의 인사(greetNewBadge)도 이 고리를 쓴다.
 */
function flashPin(id: string, options: { scroll: boolean }): void {
  const badge = badges.find((entry) => entry.id === id);
  const circle = root.querySelector<HTMLElement>(`[data-pin="${CSS.escape(id)}"]`);
  if (!badge && !circle) return;
  flashStop?.();
  const smooth = !reducedMotion();
  if (options.scroll && badge) {
    if (badge.anchor?.isConnected) {
      badge.anchor.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    } else if (badge.rect) {
      window.scrollTo({
        top: Math.max(0, badge.rect.y + badge.rect.height / 2 - window.innerHeight / 2),
        left: Math.max(0, badge.rect.x + badge.rect.width / 2 - window.innerWidth / 2),
        behavior: smooth ? "smooth" : "auto",
      });
    }
  }
  const ring = el(
    "div",
    `position:fixed;outline:3px solid ${accent};outline-offset:2px;border-radius:2px;pointer-events:none;`,
  );
  root.appendChild(ring);
  const beat = 320;
  const before = circle?.getAttribute("style") ?? "";
  if (smooth) {
    const shadow = "0 2px 8px rgba(0,0,0,.25)";
    circle?.animate(
      [
        { boxShadow: shadow },
        { boxShadow: `${shadow}, 0 0 0 6px ${accentAlpha(0.5)}` },
        { boxShadow: shadow },
      ],
      { duration: beat, iterations: 2, easing: "ease-out" },
    );
    ring.animate([{ opacity: 0.25 }, { opacity: 1 }, { opacity: 0.25 }], {
      duration: beat,
      iterations: 2,
      easing: "ease-out",
    });
  } else {
    // 동작을 줄이는 세계에서는 맥동 대신 고정된 빛이 600ms 서 있다.
    if (circle) circle.setAttribute("style", `${before}box-shadow:0 0 0 5px ${accentAlpha(0.45)};`);
  }
  const tick = () => {
    if (!ring.isConnected) return;
    if (badge?.anchor?.isConnected) {
      const rect = badge.anchor.getBoundingClientRect();
      Object.assign(ring.style, {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    } else if (badge?.rect) {
      Object.assign(ring.style, {
        left: `${badge.rect.x - window.scrollX}px`,
        top: `${badge.rect.y - window.scrollY}px`,
        width: `${badge.rect.width}px`,
        height: `${badge.rect.height}px`,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const stop = () => {
    if (flashStop !== stop) return;
    flashStop = null;
    ring.remove();
    if (circle) circle.setAttribute("style", before);
  };
  flashStop = stop;
  window.setTimeout(stop, smooth ? beat * 2 + 40 : 600);
}

ipcRenderer.on("nova-overlay:flash", (_event, payload: { id?: unknown }) => {
  if (typeof payload?.id !== "string") return;
  flashPin(payload.id, { scroll: true });
});

/** A line in the toast column. `hold` keeps it until its sender removes it. */
function toast(text: string, options?: { hold?: boolean }): HTMLElement {
  const note = el(
    "div",
    "background:#fff;color:#1a1a1a;border:1px solid #d4d4d4;border-radius:8px;padding:8px 12px;font-size:12px;max-width:320px;box-shadow:0 6px 20px rgba(0,0,0,.2);",
    text,
  );
  toasts.appendChild(note);
  if (!options?.hold) setTimeout(() => note.remove(), 2500);
  return note;
}

// ---------------------------------------------------------------------------
// Inbound — the view's words. Mode (narrowed, D79) and the capture
// three-beat (D87: hide → the view shoots → back).
// ---------------------------------------------------------------------------

ipcRenderer.on(
  "nova-overlay:mode",
  (_event, payload: { on?: boolean; skin?: { accent?: unknown; words?: unknown } }) => {
    const skin = payload?.skin;
    // The app's words and accent — the preload cannot read the web's labels,
    // so the mode payload is the one road they travel. Whatever arrived is
    // kept; a live badge already drawn picks the new accent up on the next
    // render (the next sync or mode boot repaints them; a scroll only moves).
    if (skin && typeof skin === "object") {
      if (typeof skin.accent === "string" && skin.accent !== "") {
        accent = skin.accent;
        badgeColors.live = accent;
      }
      if (skin.words && typeof skin.words === "object") {
        for (const [key, word] of Object.entries(skin.words)) {
          if (typeof word === "string") words[key] = word;
        }
      }
    }
    const on = Boolean(payload?.on);
    maybeHint();
    const boot = () => {
      setMode(on);
      renderOverlay();
    };
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  },
);

// 도구의 손길 깃발 — 보내기(main)와 그 다음 입력 dispatch 사이의 순서를
// 보장하는 것이 임무의 전부라, 답(ack)만 하면 끝난다.
ipcRenderer.on("nova-overlay:agent", (_event, payload: { on?: boolean }) => {
  const on = Boolean(payload?.on);
  agentDriving = on;
  if (on) {
    // 도구의 손길이 어울리지 않는 것들 — 하이라이트는 잡기(circle)의 안내다.
    hover?.remove();
    hover = null;
    hoverTag = null;
    hoverTarget = null;
    stopHoverLoop();
  }
  ipcRenderer.send("nova-overlay:agent-ack");
});

ipcRenderer.on("nova-overlay:capture", (_event, payload: { on?: boolean }) => {
  const on = Boolean(payload?.on);
  const boot = () => {
    // Hidden FIRST, then two frames: the same tick would shoot the pins in
    // (틀리기 쉬운 자리 — the capture waits for the paint).
    root.style.visibility = on ? "hidden" : "";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => ipcRenderer.send("nova-overlay:capture-done")),
    );
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
});

/** The ⌥+클릭 hint, said once per repo — deferred until the app's words
    arrive (the mode payload), so the sentence lives in the app's labels. */
let hintDone = false;
function maybeHint(): void {
  if (hintDone || !words.hint) return;
  hintDone = true;
  // ⌥+클릭 is the whole entry to the feature (D79) and nothing on the page
  // announces it — the hint line only exists while the pin mode is on, which
  // is the one state a planner who has not found it will never be in. Said
  // once per repo, by the page's own storage; a machine that cannot store it
  // simply hears it again.
  try {
    if (!window.localStorage.getItem(HINT_SEEN)) {
      window.localStorage.setItem(HINT_SEEN, "1");
      const note = toast(words.hint, { hold: true });
      setTimeout(() => note.remove(), 6000);
    }
  } catch {
    // Storage denied (a sandboxed page, a blocked origin): no hint, no harm.
  }
}

// D79: the root mounts once the document exists, always — and the watcher
// attaches THERE, not at preload eval: the documentElement can still be
// missing while the page parses, and an observer that never attached
// silently let badges drift off their elements.
const boot = () => {
  if (!root.isConnected && document.body) document.body.appendChild(root);
  const html = document.documentElement;
  if (html) anchorWatch.observe(html, { childList: true, subtree: true });
  scheduleLayout();
  maybeHint();
};
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
