import type {
  ColoDesignCommentTarget,
  ColoDesignNavigateEnvelope,
  ColoDesignPinsSync,
} from "@colo-design/protocol";
import { contextBridge, ipcRenderer } from "electron";

/**
 * 미리보기 뷰의 preload (PLAN D67 · D68 → D78 · D79; 재설계 C1·C3). Sandbox +
 * contextIsolation 아래 단일 파일로 살아야 한다 — 샌드박스 preload 의 require
 * 는 electron 과 몇 개 내장 모듈만 주므로, 신원 조사 같은 순수 조각도 여기
 * 안에 인라인이다.
 *
 * 네 몫:
 * 1. 레포 브리지의 문 (D68): `window.coloDesign.post` — 브리지가
 *    `colo-design.screens` 를 올리는 길. `colo-overlay:navigate` 는 반대로
 *    메인이 주면 페이지의 window 로 돌려 보낸다(postMessage). DOM 이벤트는
 *    world 를 넘으므로 메인 월드의 브리지 리스너가 받는다.
 * 2. 핀 피커 오버레이 (재설계 C1·C9): 클릭은 요소 핀, 6px 넘는 드래그는
 *    영역 핀 — 봉투 하나씩이다. 초안·전송·영수증은 여기 없다(재설계 C3),
 *    크롬은 뷰가 찍는 순간에 채운다(재설계 C4). 핀 상태의 진실은 웹이 쥐고,
 *    웹의 전체 동기화(`colo-overlay:pins`)를 번호 배지로 투영한다 — 영역 핀은
 *    배지와 점선 테두리를 좌표(rect)로 다시 앵커한다. 봉투는 요소의
 *    HTML·스타일·a11y·속성·`data-colo-src` 를 옵션으로 싣고(§4.2), 클릭
 *    요소의 `data-colo-pick` 스탬프로 뷰가 main world 에서 React owner
 *    이름을 읽는다(§4.3 — fiber 는 이 isolated world 에서 보이지 않는다).
 */

// ---------------------------------------------------------------------------
// Element identity (DESIGN §6) — the isolated world cannot see the page's
// React fiber expandos, so the component name is `data-component` or the tag,
// and the owner chain is the view's job (the `data-colo-pick` stamp + the
// main-world script, §4.3). Everything else (own text, CSS path anchored on
// the [data-screen] wrapper — or the body when the page declares none — rect,
// html, styles, a11y, attrs, source) is plain DOM.
// ---------------------------------------------------------------------------

function ownText(element: Element): string {
  let text = "";
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

function cssPath(element: Element, root: Element | null): string {
  const parts: string[] = [];
  for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    const siblings = Array.from(node.parentElement?.children ?? []).filter(
      (candidate) => candidate.tagName === node!.tagName,
    );
    const index = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : "";
    const id = node.id ? `#${node.id}` : "";
    parts.unshift(`${tag}${id}${index}`);
  }
  // A declared screen anchors on its wrapper — the spelling the log and the
  // fix turn re-match. A wrapper-less page anchors from the body: the path
  // is the only identity the page offers, and `body > …` reads the same DOM
  // the agent edits.
  if (root?.hasAttribute("data-screen")) {
    return [`div[data-screen="${root.getAttribute("data-screen")}"]`, ...parts].join(" > ");
  }
  return ["body", ...parts].join(" > ");
}

function roundRect(rect: DOMRect): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** 재설계 C9: the element's own HTML — the picker's own nodes stripped,
    1,500 characters and then an ellipsis. The element alone, no neighbors. */
function describeHtml(element: Element): string | undefined {
  try {
    const clone = element.cloneNode(true);
    if (!(clone instanceof Element)) return undefined;
    for (const node of clone.querySelectorAll("[data-colo-pick],[data-colo-design-overlay]")) {
      node.remove();
    }
    const html = clone.outerHTML;
    return html === "" ? undefined : html.length > 1500 ? `${html.slice(0, 1500)}…` : html;
  } catch {
    return undefined;
  }
}

/** 재설계 C9: a computed-style subset worth quoting — defaults and lone
    zeros dropped, a dozen keys at most. */
const STYLE_KEYS = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "padding",
  "margin",
  "border-radius",
  "display",
  "width",
  "height",
  "gap",
];

function describeStyles(element: Element): Record<string, string> | undefined {
  let styles: Record<string, string> | undefined;
  try {
    const computed = window.getComputedStyle(element);
    for (const key of STYLE_KEYS) {
      if (styles && Object.keys(styles).length >= 12) break;
      const value = computed.getPropertyValue(key).trim();
      if (value === "" || value === "none" || value === "normal" || value === "0px") continue;
      styles ??= {};
      styles[key] = value;
    }
  } catch {
    return undefined;
  }
  return styles;
}

/** 재설계 C9: the accessible identity the page declares — the role attribute
    only (implicit tag roles are the tag's own business) and the first name it
    spells out; a label wired up by association is out of reach here. */
function describeA11y(element: Element): ColoDesignCommentTarget["a11y"] | undefined {
  try {
    const role = element.getAttribute("role") ?? undefined;
    const name =
      element.getAttribute("aria-label") ??
      element.getAttribute("alt") ??
      element.getAttribute("title") ??
      undefined;
    if (!role && !name) return undefined;
    const a11y: { role?: string; name?: string } = {};
    if (role) a11y.role = role;
    if (name) a11y.name = name;
    return a11y;
  } catch {
    return undefined;
  }
}

/** 재설계 C9: the hooks a repo leaves for tests — the id, one test id, up to
    five class names. */
function describeAttrs(element: Element): ColoDesignCommentTarget["attrs"] | undefined {
  try {
    const id = element.id || undefined;
    const testId =
      element.getAttribute("data-testid") ?? element.getAttribute("data-test") ?? undefined;
    const classes = Array.from(element.classList).slice(0, 5);
    if (!id && !testId && classes.length === 0) return undefined;
    const attrs: { id?: string; testId?: string; classes?: string[] } = {};
    if (id) attrs.id = id;
    if (testId) attrs.testId = testId;
    if (classes.length > 0) attrs.classes = classes;
    return attrs;
  } catch {
    return undefined;
  }
}

function describeElement(element: Element | null): ColoDesignCommentTarget | null {
  if (!element) return null;
  const screenRoot = element.closest("[data-screen]");
  const target: ColoDesignCommentTarget = {
    component: element.getAttribute("data-component") ?? element.tagName.toLowerCase(),
    text: ownText(element),
    path: cssPath(element, screenRoot ?? document.body),
    rect: roundRect(element.getBoundingClientRect()),
  };
  // §4.2's enrichment — every field optional, a failure costs its field,
  // never the pin. `source` is an element pin's stamp only (§5).
  const html = describeHtml(element);
  if (html) target.html = html;
  const styles = describeStyles(element);
  if (styles) target.styles = styles;
  const a11y = describeA11y(element);
  if (a11y) target.a11y = a11y;
  const attrs = describeAttrs(element);
  if (attrs) target.attrs = attrs;
  const source = element.closest("[data-colo-src]")?.getAttribute("data-colo-src") ?? undefined;
  if (source) target.source = source;
  return target;
}

/**
 * The screen the page is showing right now — the context every envelope
 * carries. A declared page reads its wrapper. A wrapper-less page IS its
 * path — the route without the leading slash is the screen id (`index` at
 * the root), `default` its state — and the daemon stores that id verbatim.
 */
function pageContext(): { screen: string; state: string } {
  const current = currentScreenRoot();
  if (current) {
    return {
      screen: current.getAttribute("data-screen") ?? "",
      state: current.getAttribute("data-state") ?? "default",
    };
  }
  const id = window.location.pathname.replace(/^\/+/, "");
  return { screen: id === "" ? "index" : id, state: "default" };
}

function screenContext(element: Element): { screen: string; state: string } {
  const root = element.closest("[data-screen]");
  if (!root) return pageContext();
  return {
    screen: root.getAttribute("data-screen") ?? "",
    state: root.getAttribute("data-state") ?? "default",
  };
}

// ---------------------------------------------------------------------------
// 1. The repo bridge's door (D68)
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld("coloDesign", {
  post: (envelope: unknown) => ipcRenderer.send("colo-overlay:post", envelope),
});

ipcRenderer.on("colo-overlay:navigate", (_event, payload: { route?: unknown; state?: unknown }) => {
  if (typeof payload?.route !== "string") return;
  const envelope: ColoDesignNavigateEnvelope = {
    type: "colo-design.navigate",
    route: payload.route,
    state: typeof payload.state === "string" ? payload.state : null,
  };
  // Addressed to our own origin; the page's bridge listens on window.
  window.postMessage(envelope, window.location.origin);
});

// ---------------------------------------------------------------------------
// 2. The pin picker overlay (재설계 C1). All styling inline — the repo's
// classes are the repo's; pointer-events none on the root so the page stays
// live. The overlay owns NOTHING: a click posts one envelope and draws an
// optimistic badge, and the web's whole-list sync (`colo-overlay:pins`)
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
   * 고침 표시 (preview.md §1-C): live is the accent pin, sent the turn's
   * grey, done the settled 수정 마크 — solid green, it outlives its turn.
   */
  tone: "live" | "sent" | "done";
}

/** The badge's one color per tone — done reads as settled, not as sent. */
const BADGE_COLORS: Record<Badge["tone"], string> = {
  live: "#e05252",
  sent: "#9ca3af",
  done: "#16a34a",
};

const Z = "2147483000";
const root = document.createElement("div");
root.setAttribute("data-colo-design-overlay", "");
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
let altHeld = false;
let badges: Badge[] = [];
let hover: HTMLDivElement | null = null;
let hoverTarget: Element | null = null;
/**
 * The hover box's name tag — a stacked column over the element: the
 * planner's words (the red tab, the same words the tray row and the card
 * use) and the element's own facts under it (kind · component · size, and
 * 이름 없음 when an interactive element carries no accessible name). Lives
 * and dies with `hover`.
 */
let hoverTag: {
  box: HTMLElement;
  label: HTMLElement;
  meta: HTMLElement;
  warn: HTMLElement;
} | null = null;

/** The tags a planner can pin asking "this does not say what it does" —
    the only ones where a missing accessible name is the pin's own story.
    The check follows `closest`, so a hover on an icon svg answers for the
    button it sits in. */
const INTERACTIVE_SELECTOR = "button, a, input, select, textarea";

/**
 * The meta line: the facts a DevTools tooltip would quote, minus the class
 * noise — utility classes tell a planner nothing and the agent reads them
 * from the pin's HTML anyway. An interactive element whose name is nowhere
 * (no aria-label/title/alt, no own words, no placeholder/value) says
 * 이름 없음: that gap is the one thing a planner can pin and ask fixed in
 * the same breath. The name is asked of the nearest interactive element —
 * the hover usually lands on the icon or label inside it.
 */
function hoverMeta(element: Element): { text: string; unnamed: boolean } {
  const tag = element.tagName.toLowerCase();
  const rect = element.getBoundingClientRect();
  const parts = [tag];
  const component = element.getAttribute("data-component");
  if (component && component !== tag) parts.push(component);
  parts.push(`${Math.round(rect.width)}×${Math.round(rect.height)}`);
  let unnamed = false;
  const interactive = element.closest(INTERACTIVE_SELECTOR);
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
  return { text: parts.join(" · "), unnamed };
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
/** The 600ms flash ring (칩 클릭 → 배지 깜빡임, 재설계 C1). */
let flashRing: HTMLElement | null = null;
let flashStop: (() => void) | null = null;
/** Where the page remembers that the ⌥+클릭 hint has been said once. */
const HINT_SEEN = "colo-design.pin-hint";

function isOverlayUi(target: EventTarget | null): boolean {
  return target instanceof Node && root.contains(target);
}

function currentScreenRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-screen]");
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
      hover.setAttribute("data-colo-hover", "");
      hover.style.cssText =
        "position:fixed;outline:2px solid #e05252;outline-offset:1px;pointer-events:none;";
      // The tag is a column, not one tab: the planner's words on top, the
      // element's facts under them — aiming at a table row means guessing
      // between the cell, the row and the table unless both lines say which
      // one is under the cursor. The meta strip reads like the badge it will
      // become: dark, monospace, small.
      const box = el(
        "div",
        "position:absolute;left:0;display:flex;flex-direction:column;align-items:flex-start;pointer-events:none;",
      );
      const label = el(
        "span",
        "background:#e05252;color:#fff;border-radius:4px 4px 0 0;padding:1px 6px;font-size:10px;line-height:1.5;font-weight:600;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;",
      );
      const meta = el(
        "span",
        "background:rgba(17,17,17,.88);color:rgba(255,255,255,.78);border-radius:0;padding:1px 6px;font-size:10px;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;",
      );
      const warn = el(
        "span",
        "background:rgba(17,17,17,.88);color:#fbbf24;border-radius:0 0 4px 4px;padding:1px 6px;font-size:10px;line-height:1.5;white-space:nowrap;",
        "이름 없음",
      );
      box.appendChild(label);
      box.appendChild(meta);
      box.appendChild(warn);
      hover.appendChild(box);
      hoverTag = { box, label, meta, warn };
      root.appendChild(hover);
      startHoverLoop();
    }
    if (hoverTag && hoverTarget) {
      hoverTag.label.textContent =
        ownText(hoverTarget) ||
        hoverTarget.getAttribute("data-component") ||
        hoverTarget.tagName.toLowerCase();
      const { text, unnamed } = hoverMeta(hoverTarget);
      hoverTag.meta.textContent = text;
      hoverTag.meta.style.borderRadius = unnamed ? "0" : "0 0 4px 4px";
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
    const target = describeElement(element);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    // One gesture, one envelope (재설계 C1 · C4): the rect rides as measured
    // NOW — the view crops this instant, not a send-moment re-measure — and
    // the web parks the pin as a composer attachment. The badge below is
    // optimistic; the web's sync redraws the truth (and the numbering).
    const pin = { id: crypto.randomUUID(), ...screenContext(element), element: target };
    // §4.3: the view reads the React owner chain off this stamp in the main
    // world (fibers are invisible from this isolated world) and removes it —
    // the timer below is only this side's safety net.
    element.setAttribute("data-colo-pick", pin.id);
    window.setTimeout(() => {
      if (element.getAttribute("data-colo-pick") === pin.id) {
        element.removeAttribute("data-colo-pick");
      }
    }, 3000);
    ipcRenderer.send("colo-overlay:post", { type: "colo-design.pin", pin });
    badges = [...badges, { id: pin.id, anchor: element, number: badges.length + 1, tone: "live" }];
    renderOverlay();
  },
  true,
);

// ---------------------------------------------------------------------------
// Region drag (재설계 §4.1·C9). While picking, a press that travels past 6px
// is a region, not a sloppy click: the mouseup posts the drag's envelope in
// scroll-invariant page coordinates, and the trailing click is swallowed.
// The root is pointer-events:none — the page's own elements receive every
// event — so the gate is document-level capture, and the selection/native
// drags die by preventDefault, not by CSS.
// ---------------------------------------------------------------------------

/** Past this many pixels a picking press is a drag (재설계 §4.1). */
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
        "position:fixed;border:1px dashed #e05252;background:rgba(224,82,82,.12);pointer-events:none;",
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
    const under =
      event.target instanceof Element && !isOverlayUi(event.target) ? event.target : null;
    // Page coordinates, scroll deliberately left in (재설계 C9): the badge
    // re-anchors on scroll and the web redraws the same numbers.
    const rect = {
      x: Math.round(Math.min(press.x, event.pageX)),
      y: Math.round(Math.min(press.y, event.pageY)),
      width: Math.round(Math.abs(event.pageX - press.x)),
      height: Math.round(Math.abs(event.pageY - press.y)),
    };
    const pin = {
      id: crypto.randomUUID(),
      ...(under ? screenContext(under) : pageContext()),
      element: { kind: "region", component: "영역", text: "", path: "", rect },
    };
    ipcRenderer.send("colo-overlay:post", { type: "colo-design.pin", pin });
    renderOverlay();
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

function renderOverlay(): void {
  for (const child of [...root.childNodes]) {
    if (child === hover || child === toasts || child === flashRing) continue;
    child.remove();
  }

  // --- badges: the web's pin list, one 24px number per element -------------
  for (const badge of badges) {
    // A region badge gets its dashed border box (재설계 C9) — page
    // coordinates, positioned by layoutOverlay on every scroll.
    if (badge.rect) {
      const box = el(
        "div",
        `position:fixed;border:1px dashed ${BADGE_COLORS[badge.tone]};pointer-events:none;`,
      );
      box.dataset.pinBox = badge.id;
      root.appendChild(box);
    }
    const circle = el(
      "button",
      `pointer-events:auto;position:fixed;width:24px;height:24px;padding:0;border:2px solid #fff;border-radius:999px;background:${BADGE_COLORS[badge.tone]};color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);`,
      String(badge.number),
    );
    circle.dataset.pin = badge.id;
    circle.setAttribute(
      "aria-label",
      `핀 ${badge.number}${badge.tone === "sent" ? " (보냄)" : badge.tone === "done" ? " (고침)" : ""}`,
    );
    // The badge is a handle: clicking it asks the web to focus the pin's
    // row in the composer — its memo field.
    circle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      ipcRenderer.send("colo-overlay:post", { type: "colo-design.pin-focus", id: badge.id });
    });
    root.appendChild(circle);
  }
  layoutOverlay();
}

/** A sync pin's rect is an anchor only when it is four finite numbers. */
function readRect(
  value: ColoDesignPinsSync["pins"][number]["rect"],
): { x: number; y: number; width: number; height: number } | null {
  if (!value) return null;
  const { x, y, width, height } = value;
  const ok =
    Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height);
  return ok ? { x, y, width, height } : null;
}

/**
 * The web's whole pin list (재설계 C1) — the truth, redrawn from scratch.
 * Only THIS screen's pins draw badges (재설계 C5); the number is the mark
 * registry's `n` when the web sends one, else the row's place in the list.
 */
ipcRenderer.on("colo-overlay:pins", (_event, sync: ColoDesignPinsSync) => {
  const here = pageContext();
  const rows = Array.isArray(sync?.pins) ? sync.pins : [];
  badges = rows.flatMap((pin, index): Badge[] => {
    // A badge belongs to the screen AND state it was pinned on (§3.10 ⓕ,
    // 커미티 차단 4): the same CSS path on the error state is a different
    // view — the tray row keeps saying `회원 목록 · 기본` and the badge must
    // not contradict it from another state's page.
    if (pin.screen !== here.screen || pin.state !== here.state) return [];
    // 고침 표시 (preview.md §1-C): the registry's `n` is the badge's number —
    // the list index is only the fallback for a web that predates it.
    const number = typeof pin.n === "number" ? pin.n : index + 1;
    const tone: Badge["tone"] =
      pin.tone === "done" || pin.tone === "sent" || pin.tone === "live"
        ? pin.tone
        : pin.sent
          ? "sent"
          : "live";
    // 화면 마크: no element, no rect — the badge docks on the screen frame's
    // own corner. A page with no [data-screen] wrapper has no frame to dock
    // on; the mark still lives in the registry.
    if (pin.screenMark) {
      const frame = currentScreenRoot();
      return frame ? [{ id: pin.id, anchor: frame, number, tone }] : [];
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
});

/**
 * 칩 클릭 → 배지 (재설계 C1): a 600ms ring over the element and a glow on
 * the badge — "여기"를 눈으로 찾게 한다.
 */
ipcRenderer.on("colo-overlay:flash", (_event, payload: { id?: unknown }) => {
  if (typeof payload?.id !== "string") return;
  const badge = badges.find((entry) => entry.id === payload.id);
  const circle = root.querySelector<HTMLElement>(`[data-pin="${CSS.escape(payload.id)}"]`);
  if (!badge && !circle) return;
  flashStop?.();
  const ring = el(
    "div",
    "position:fixed;outline:3px solid #e05252;outline-offset:2px;border-radius:2px;pointer-events:none;",
  );
  root.appendChild(ring);
  flashRing = ring;
  const glow = "box-shadow:0 0 0 5px rgba(224,82,82,.45);";
  const before = circle?.getAttribute("style") ?? "";
  if (circle) circle.setAttribute("style", `${before}${glow}`);
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
    flashRing = null;
    ring.remove();
    if (circle) circle.setAttribute("style", before);
  };
  flashStop = stop;
  window.setTimeout(stop, 600);
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

ipcRenderer.on("colo-overlay:mode", (_event, payload: { on?: boolean }) => {
  const on = Boolean(payload?.on);
  const boot = () => {
    setMode(on);
    renderOverlay();
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
});

ipcRenderer.on("colo-overlay:capture", (_event, payload: { on?: boolean }) => {
  const on = Boolean(payload?.on);
  const boot = () => {
    // Hidden FIRST, then two frames: the same tick would shoot the pins in
    // (PLAN §9 틀리기 쉬운 자리 — the capture waits for the paint).
    root.style.visibility = on ? "hidden" : "";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => ipcRenderer.send("colo-overlay:capture-done")),
    );
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
});

// D79: the root mounts once the document exists, always — and the watcher
// attaches THERE, not at preload eval: the documentElement can still be
// missing while the page parses, and an observer that never attached
// silently let badges drift off their elements.
const boot = () => {
  if (!root.isConnected && document.body) document.body.appendChild(root);
  const html = document.documentElement;
  if (html) anchorWatch.observe(html, { childList: true, subtree: true });
  scheduleLayout();
  // ⌥+클릭 is the whole entry to the feature (D79) and nothing on the page
  // announces it — the hint line only exists while the pin mode is on, which
  // is the one state a planner who has not found it will never be in. Said
  // once per repo, by the page's own storage; a machine that cannot store it
  // simply hears it again.
  try {
    if (!window.localStorage.getItem(HINT_SEEN)) {
      window.localStorage.setItem(HINT_SEEN, "1");
      const note = toast(
        "요소를 ⌥+클릭하면 핀이 찍혀 입력창에 붙습니다. 여러 개 찍고 한 번에 말하세요.",
        { hold: true },
      );
      setTimeout(() => note.remove(), 6000);
    }
  } catch {
    // Storage denied (a sandboxed page, a blocked origin): no hint, no harm.
  }
};
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
