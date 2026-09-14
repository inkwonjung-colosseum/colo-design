import type {
  ColoDesignCommentsEnvelope,
  ColoDesignCommentTarget,
  ColoDesignNavigateEnvelope,
} from "@colo-design/protocol";
import { contextBridge, ipcRenderer } from "electron";

/**
 * 미리보기 뷰의 preload (PLAN D67 · D68 → D78 · D79). Sandbox +
 * contextIsolation 아래 단일 파일로 살아야 한다 — 샌드박스 preload 의 require
 * 는 electron 과 몇 개 내장 모듈만 주므로, 신원 조사 같은 순수 조각도 여기
 * 안에 인라인이다.
 *
 * 네 몫:
 * 1. 레포 브리지의 문 (D68): `window.coloDesign.post` — 브리지가
 *    `colo-design.screens` 를 올리는 길. `colo-overlay:navigate` 는 반대로
 *    메인이 주면 페이지의 window 로 돌려 보낸다(postMessage). DOM 이벤트는
 *    world 를 넘으므로 메인 월드의 브리지 리스너가 받는다.
 * 2. 코멘트 핀 오버레이 (D67 → D78): 기록된 핀은 웹이 내려 준 목록을 현재
 *    화면으로 걸러 늘 그린다 — 루트는 DOMContentLoaded 에 항상 붙고(D79),
 *    모드는 이제 핀만 찍는 좁은 뜻이다. 해결 · 다시 요청은 봉투로 올려 뷰가
 *    웹에 건넨다. 핀은 선언된 화면에만 찍히지 않는다 — `[data-screen]`
 *    래퍼가 없는 페이지는 그 경로가 화면 id 가 되어 같은 대화로 흘러간다.
 */

// ---------------------------------------------------------------------------
// Element identity (DESIGN §6, fiber-free) — the isolated world cannot see the
// page's React fiber expandos, so the component name is `data-component` or
// the tag. Everything else (own text, CSS path anchored on the [data-screen]
// wrapper — or the body when the page declares none — rect) is plain DOM.
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
  // Claude edits.
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

function describeElement(element: Element | null): ColoDesignCommentTarget | null {
  if (!element) return null;
  const screenRoot = element.closest("[data-screen]");
  return {
    component: element.getAttribute("data-component") ?? element.tagName.toLowerCase(),
    text: ownText(element),
    path: cssPath(element, screenRoot ?? document.body),
    rect: roundRect(element.getBoundingClientRect()),
  };
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
// 2. The comment-pin overlay (D67 → D79 · D80). All styling inline —
// the repo's classes are the repo's; pointer-events none on the root so the
// page stays live.
//
// 자동 정리: a pin's life ends at the send. The overlay holds DRAFTS only —
// the envelope goes out, the drafts go with it (`sendDrafts`), and whatever
// comes next is a new ask through the thread. There is no recorded-pin list
// to draw, resolve or re-request any more.
//
// D79: the root mounts once at DOMContentLoaded and never leaves. The click
// capture intervenes only when the pin mode is on OR Alt is held — so the
// page's own clicks, modals and navigation stay alive, and ⌥+클릭 pinches a
// draft pin in any mode. `setMode(false)` clears neither the root nor the
// drafts; only the page-wide hover and the hint line are mode's.
// ---------------------------------------------------------------------------

interface DraftPin {
  id: number;
  /** Held only for DRAFTS: they die with the screen (D67), so they are short-lived. */
  anchor: Element;
  element: ColoDesignCommentTarget;
  context: { screen: string; state: string };
  comment: string;
  editing: boolean;
}

const Z = "2147483000";
const root = document.createElement("div");
root.setAttribute("data-colo-design-overlay", "");
root.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${Z};font-family:system-ui,-apple-system,sans-serif;`;

/**
 * Where every toast lands: one stacking column that `renderOverlay` never
 * sweeps. Toasts used to be plain root children written just before a
 * re-render, so the send's own confirmation was wiped the same tick it was
 * made and the planner saw nothing. `aria-live` says them out loud.
 */
const toasts = document.createElement("div");
toasts.setAttribute("role", "status");
toasts.setAttribute("aria-live", "polite");
toasts.style.cssText =
  "position:fixed;right:16px;bottom:64px;display:flex;flex-direction:column-reverse;align-items:flex-end;gap:6px;pointer-events:none;";
root.appendChild(toasts);

let mode = false;
let altHeld = false;
let busy = false;
let drafts: DraftPin[] = [];
let hover: HTMLDivElement | null = null;
let hoverTarget: Element | null = null;
/** The hover box's name tab — lives and dies with `hover`. */
let hoverLabel: HTMLElement | null = null;
let nextId = 1;
/** The pathname the open drafts were pinned on — a SPA move that carries no
    attribute change (래퍼 없는 페이지의 이동) would leave them lying. */
let draftsPath: string | null = null;
let layoutStop: (() => void) | null = null;
let layoutTimer: number | null = null;
/**
 * The sends still waiting for the web's receipt (D35), by batch id: the pins
 * are off the screen but not yet gone, so a turn the daemon refused can put
 * them back with their words. `note` is the 보내는 중 toast this send owns.
 */
const pending = new Map<string, { pins: DraftPin[]; note: HTMLElement; timer: number }>();
let nextBatch = 1;
/** How long a send may go unanswered before its pins are counted as gone. */
const SENT_ACK_MS = 10_000;
/** Where the page remembers that the ⌥+클릭 hint has been said once. */
const HINT_SEEN = "colo-design.pin-hint";
/** The draft editor grows with the words, up to this many pixels. */
const EDITOR_MAX_HEIGHT = 120;

function isOverlayUi(target: EventTarget | null): boolean {
  return target instanceof Node && root.contains(target);
}

function currentScreenRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-screen]");
}

function setMode(on: boolean): void {
  mode = on;
  // D79: turning the mode off keeps the root and every draft — drafts live
  // in memory and die with the screen, not with the toggle. Only the hover
  // (a picking affordance) and the hint line are mode's.
  if (!on) {
    hover?.remove();
    hover = null;
    hoverTarget = null;
    stopHoverLoop();
  }
  if (!root.isConnected && document.body) document.body.appendChild(root);
  scheduleLayout();
}

function setBusy(on: boolean): void {
  busy = on;
}

// ---------------------------------------------------------------------------
// Layout — event-driven (D78), not a frame loop. Hover gets the rAF loop,
// and only while it exists (D79).
// ---------------------------------------------------------------------------

function scheduleLayout(): void {
  if (layoutTimer !== null) return;
  layoutTimer = window.setTimeout(() => {
    layoutTimer = null;
    pruneDrafts();
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
  // The tab sits above the box, or inside it when the box is against the
  // top of the viewport — a label the planner cannot read is no label.
  if (hoverLabel) hoverLabel.style.top = rect.y >= 18 ? "-18px" : "0px";
}

/**
 * The anchor point goes in, the whole column comes out clamped inside the
 * viewport — the editor and the bubble are ~300px wide, so a pin near the
 * right or bottom edge has to pull the column back in, not let it hang off
 * the preview (the view clips at its own bounds).
 */
function placeColumn(column: HTMLElement, x: number, y: number): void {
  const margin = 8;
  const left = Math.min(
    Math.max(x, margin),
    Math.max(margin, window.innerWidth - margin - column.offsetWidth),
  );
  const top = Math.min(
    Math.max(y, margin),
    Math.max(margin, window.innerHeight - margin - column.offsetHeight),
  );
  column.style.left = `${Math.round(left)}px`;
  column.style.top = `${Math.round(top)}px`;
}

/** Draft chips ride their held element. */
function layoutOverlay(): void {
  layoutHover();
  for (const pin of drafts) {
    const chip = root.querySelector<HTMLElement>(`[data-pin="${pin.id}"]`);
    if (!chip) continue;
    const rect = pin.anchor.getBoundingClientRect();
    placeColumn(
      chip,
      Math.min(Math.max(rect.x + rect.width - 20, rect.x), rect.x + rect.width),
      Math.max(rect.y - 10, 8),
    );
  }
}

/**
 * The same rule the attribute watcher enforces (D67), for the moves it
 * cannot see. `screenWatch` only fires when a SURVIVING wrapper rewrites its
 * `data-screen`/`data-state`; a router that swaps the wrapper for another
 * one changes no attribute, and the drafts would sit on a screen that is no
 * longer there — pinned to detached elements, drawn at the viewport's
 * corner, and sent naming the screen they left.
 */
function pruneDrafts(): void {
  if (drafts.length === 0) return;
  const moved = draftsPath !== null && draftsPath !== window.location.pathname;
  const kept = moved ? [] : drafts.filter((pin) => pin.anchor.isConnected);
  if (kept.length === drafts.length) return;
  const gone = drafts.length - kept.length;
  drafts = kept;
  renderOverlay();
  toast(`화면이 바뀌어 보내지 않은 핀 ${gone}개를 지웠습니다.`);
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
    if (!pickingNow()) return;
    const element = event.target instanceof Element ? event.target : null;
    // Any element can take a pin now, so the highlight follows everything.
    hoverTarget = element;
    if (!hoverTarget) {
      hover?.remove();
      hover = null;
      hoverLabel = null;
      stopHoverLoop();
      return;
    }
    if (!hover) {
      hover = document.createElement("div");
      hover.setAttribute("data-colo-hover", "");
      hover.style.cssText =
        "position:fixed;outline:2px solid #e05252;outline-offset:1px;pointer-events:none;";
      // What the click would actually take: the same words the chip and the
      // transcript card use. Any element can take a pin (D79), so aiming at
      // a table row means guessing between the cell, the row and the table
      // unless the highlight says which one is under the cursor.
      hoverLabel = el(
        "span",
        "position:absolute;left:0;background:#e05252;color:#fff;border-radius:4px 4px 0 0;padding:1px 6px;font-size:10px;line-height:1.5;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;",
      );
      hover.appendChild(hoverLabel);
      root.appendChild(hover);
      startHoverLoop();
    }
    if (hoverLabel) {
      hoverLabel.textContent =
        ownText(hoverTarget) ||
        hoverTarget.getAttribute("data-component") ||
        hoverTarget.tagName.toLowerCase();
    }
  },
  true,
);

document.addEventListener(
  "click",
  (event) => {
    // ⌥+클릭 (D79): the Alt sign works in any mode, and the click never
    // reaches the page (capture-stage preventDefault — Chromium's
    // Alt+link = download dies here too).
    if (!pickingNow(event) || isOverlayUi(event.target)) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    const target = describeElement(element);
    const context = screenContext(element);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    // A SPA route change no attribute carries, and a screen wrapper swapped
    // for another one: either way the open drafts would lie about where they
    // were pinned, so they go the way the data-screen watcher clears them
    // (D67).
    pruneDrafts();
    // One editor at a time: the pin just clicked is the one being written,
    // so a written neighbour folds to its bubble and an empty one — an
    // editor opened and abandoned — was never a request to keep.
    drafts = drafts.filter((pin) => !pin.editing || pin.comment.trim() !== "");
    for (const pin of drafts) pin.editing = false;
    drafts = [
      ...drafts,
      {
        id: nextId++,
        anchor: element,
        element: target,
        context,
        comment: "",
        editing: true,
      },
    ];
    draftsPath = window.location.pathname;
    renderOverlay();
  },
  true,
);

// Alt hovering outside the mode: keydown/keyup, blur clears (D79).
function setAlt(on: boolean): void {
  if (altHeld === on) return;
  altHeld = on;
  if (!on) {
    hover?.remove();
    hover = null;
    hoverLabel = null;
    hoverTarget = null;
    stopHoverLoop();
  }
}
document.addEventListener("keydown", (event) => {
  // Option is a mac text key as much as a modifier: held inside the draft
  // editor it is typing a character, not aiming at the page. Highlighting
  // the element behind the editor there — and arming the click that pins
  // it — would fight the planner mid-word.
  if (event.altKey && !isOverlayUi(event.target)) setAlt(true);
});
document.addEventListener("keyup", (event) => {
  if (!event.altKey) setAlt(false);
});
window.addEventListener("blur", () => setAlt(false));
// 뒤로/앞으로 로 화면이 바뀌어도 보내지 않은 핀은 남으면 안 된다 (D67).
window.addEventListener("popstate", scheduleLayout);
// A click that lands outside the overlay is the planner's attention moving
// on: a written editor folds to its bubble so the page is readable again.
// An empty one stays — it is the pin they just made, not one they left.
document.addEventListener(
  "mousedown",
  (event) => {
    if (isOverlayUi(event.target)) return;
    const open = drafts.filter((pin) => pin.editing && pin.comment.trim() !== "");
    if (open.length === 0) return;
    for (const pin of open) pin.editing = false;
    renderOverlay();
  },
  true,
);

// 화면이 바뀌면 미전송 핀은 지운다 (D67) — 핀이 다른 화면에 남으면 거짓말이다.
const screenWatch = new MutationObserver(() => {
  if (drafts.length > 0) {
    const gone = drafts.length;
    drafts = [];
    renderOverlay();
    toast(`화면이 바뀌어 보내지 않은 핀 ${gone}개를 지웠습니다.`);
  }
});

// A draft's chip rides its held element — when the page moves under it, the
// chip has to follow (scroll and resize re-layout below do the same job).
const anchorWatch = new MutationObserver(() => scheduleLayout());
document.addEventListener("scroll", scheduleLayout, true);
window.addEventListener("resize", scheduleLayout);

function el(tag: string, style: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const BUTTON_BASE =
  "pointer-events:auto;border:0;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;";

function renderOverlay(): void {
  for (const child of [...root.childNodes]) {
    if (child !== hover && child !== toasts) child.remove();
  }

  let number = 0;

  // --- drafts: the red pin, the editor with the D80 buttons ----------------
  for (const pin of drafts) {
    number += 1;
    const wrap = el(
      "div",
      "position:fixed;pointer-events:none;display:flex;flex-direction:column;align-items:flex-start;gap:4px;",
    );
    wrap.dataset.pin = String(pin.id);

    const chip = el(
      "div",
      "pointer-events:auto;display:flex;align-items:center;gap:6px;background:#fff;color:#1a1a1a;border:1px solid #d4d4d4;border-radius:999px;padding:2px 6px 2px 8px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.18);",
    );
    chip.appendChild(el("span", "font-weight:700;color:#b91c1c;", String(number)));
    chip.appendChild(
      el(
        "span",
        // The element's own text is what the planner clicked and recognises;
        // its name is the fallback nobody should normally read — the same
        // rule the transcript card's rows follow.
        "max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#666;",
        pin.element.text || pin.element.component,
      ),
    );
    const remove = el(
      "button",
      `${BUTTON_BASE}background:none;color:#888;padding:0 4px;font-size:13px;`,
      "×",
    );
    remove.setAttribute("aria-label", `핀 ${number} 삭제`);
    remove.addEventListener("click", () => {
      drafts = drafts.filter((entry) => entry.id !== pin.id);
      renderOverlay();
    });
    chip.appendChild(remove);
    wrap.appendChild(chip);

    if (pin.editing) {
      wrap.appendChild(draftEditor(pin, number));
    } else if (pin.comment) {
      const bubble = el(
        "button",
        "pointer-events:auto;max-width:288px;text-align:left;background:#fff;border:1px solid #f3c1c1;border-left:3px solid #e05252;border-radius:8px;padding:5px 8px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,.15);",
        pin.comment,
      );
      bubble.addEventListener("click", () => {
        pin.editing = true;
        renderOverlay();
      });
      wrap.appendChild(bubble);
    }
    root.appendChild(wrap);
  }

  // --- the send bar (left here; the D80 ⏎ 보내기 carries one) -------------
  const ready = drafts.filter((pin) => pin.comment.trim() !== "");
  const bar = el(
    "div",
    "position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;gap:8px;",
  );
  if (ready.length > 0) {
    const send = el(
      "button",
      `${BUTTON_BASE}background:#e05252;color:#fff;padding:8px 16px;box-shadow:0 6px 20px rgba(0,0,0,.25);`,
      `수정 요청 ${ready.length}건 보내기`,
    );
    send.addEventListener("click", () => {
      sendDrafts(ready);
    });
    bar.appendChild(send);
  }
  if (mode) {
    const hintRow = el(
      "div",
      "pointer-events:none;background:rgba(26,26,26,.85);color:#fff;border-radius:999px;padding:4px 12px;font-size:11.5px;",
      "핀만 찍는 모드 — 클릭이 화면에 전달되지 않습니다 · ⌥+클릭은 언제든 핀을 찍습니다",
    );
    bar.appendChild(hintRow);
  }
  root.appendChild(bar);
  layoutOverlay();

  // The open editor is where the planner is about to type (D80) — only one
  // is ever open, and landing in it is the difference between one gesture
  // and two. `preventScroll`: the page must not jump under a pin that is
  // already in view.
  const input = root.querySelector("textarea");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, EDITOR_MAX_HEIGHT)}px`;
  if (document.activeElement === input) return;
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * The draft editor (D80): the comment box and three buttons — ⏎ 보내기 sends
 * THIS pin alone at once, 접기 leaves it parked as a bubble, 지우기 drops it.
 * Esc does whichever of the last two the words call for.
 */
function draftEditor(pin: DraftPin, number: number): HTMLElement {
  const editor = el(
    "div",
    "pointer-events:auto;display:flex;flex-direction:column;gap:6px;background:#fff;border:1px solid #d4d4d4;border-radius:8px;padding:8px;width:288px;box-shadow:0 6px 20px rgba(0,0,0,.2);",
  );
  const head = el(
    "div",
    "font-size:11px;font-weight:700;color:#b91c1c;",
    `${number} · ${pin.element.text || pin.element.component}`,
  );
  editor.appendChild(head);
  const input = document.createElement("textarea");
  input.rows = 2;
  input.value = pin.comment;
  input.setAttribute("aria-label", `핀 ${number} 코멘트`);
  input.placeholder = "이 요소에 바라는 점을 적어 주세요";
  input.style.cssText =
    "resize:none;overflow-y:auto;border:1px solid #d4d4d4;border-radius:6px;padding:6px;font-size:13px;font-family:inherit;";
  input.addEventListener("input", () => {
    pin.comment = input.value;
    // The box follows the words to the editor's own ceiling: a request three
    // lines long should not be read through a two-line slot.
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, EDITOR_MAX_HEIGHT)}px`;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendDrafts([pin]);
      return;
    }
    if (event.key !== "Escape") return;
    // The keyboard's way out (the page behind must not read the key as its
    // own close): written words park as a bubble, an empty editor was never
    // a request.
    event.preventDefault();
    event.stopPropagation();
    pin.comment = input.value;
    if (pin.comment.trim() === "") drafts = drafts.filter((entry) => entry.id !== pin.id);
    else pin.editing = false;
    renderOverlay();
  });
  editor.appendChild(input);
  const row = el("div", "display:flex;gap:6px;align-items:center;justify-content:flex-end;");
  const clear = el("button", `${BUTTON_BASE}background:none;color:#888;`, "지우기");
  clear.addEventListener("click", () => {
    drafts = drafts.filter((entry) => entry.id !== pin.id);
    renderOverlay();
  });
  const park = el(
    "button",
    `${BUTTON_BASE}background:none;color:#555;border:1px solid #d4d4d4;`,
    "접기",
  );
  park.addEventListener("click", () => {
    pin.comment = input.value;
    pin.editing = false;
    renderOverlay();
  });
  const send = el("button", `${BUTTON_BASE}background:#e05252;color:#fff;`, "⏎ 보내기");
  send.addEventListener("click", () => {
    pin.comment = input.value;
    sendDrafts([pin]);
  });
  row.appendChild(clear);
  row.appendChild(park);
  row.appendChild(send);
  editor.appendChild(row);
  return editor;
}

/**
 * One (⏎ 보내기) or many (the bar): the envelope goes out and the pins wait
 * for the web's receipt (D35). They leave the screen at once — the planner
 * must see the work go — but they are HELD until `settle`, because a turn
 * the daemon refused has to stay retryable and pins nobody can see are not.
 */
function sendDrafts(pins: DraftPin[]): void {
  const ready = pins.filter((pin) => pin.comment.trim() !== "");
  if (ready.length === 0) return;
  const first = ready[0]!.context;
  const batch = String(nextBatch++);
  const envelope: ColoDesignCommentsEnvelope = {
    type: "colo-design.comments",
    batch,
    screen: first.screen,
    state: first.state,
    items: ready.map((pin) => ({
      // Re-read, not replayed: the rect rides along for the view's crop
      // (D87), so it has to be where the element is NOW. A pin written and
      // then scrolled past would otherwise photograph whatever moved into
      // its old slot on the viewport.
      element: describeElement(pin.anchor) ?? pin.element,
      comment: pin.comment.trim(),
    })),
  };
  ipcRenderer.send("colo-overlay:post", envelope);
  drafts = drafts.filter((pin) => !ready.includes(pin));
  pending.set(batch, {
    pins: ready,
    note: toast("보내는 중…", { hold: true }),
    timer: window.setTimeout(() => settle(batch, true, 0, ready.length), SENT_ACK_MS),
  });
  renderOverlay();
}

/**
 * The receipt for one batch (D35 · D87): the words landed, or they did not
 * and the pins come back where their elements still are. `shots` is how many
 * crops really rode along — fewer than the pins means the rest travelled as
 * text, which the planner would otherwise never learn.
 */
function settle(batch: string, ok: boolean, shots: number, items: number): void {
  const held = pending.get(batch);
  if (!held) return;
  pending.delete(batch);
  window.clearTimeout(held.timer);
  held.note.remove();
  const count = items || held.pins.length;
  if (ok) {
    const short = shots > 0 && shots < count ? ` 이미지는 ${shots}개까지만 실렸습니다.` : "";
    toast(
      busy
        ? `보냈습니다 — Claude 가 일하는 중, 끝나면 이어서 봅니다.${short}`
        : `수정 요청 ${count}건을 보냈습니다.${short}`,
    );
    return;
  }
  const back = held.pins.filter((pin) => pin.anchor.isConnected);
  drafts = [...drafts, ...back];
  renderOverlay();
  toast(
    back.length > 0
      ? `보내지 못했습니다 — 핀 ${back.length}개를 되돌렸습니다. 대화의 오류를 확인해 주세요.`
      : "보내지 못했습니다 — 대화의 오류를 확인해 주세요.",
  );
}

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
// Inbound — the view's words. Mode (narrowed, D79), busy (D86), and the
// capture three-beat (D87: hide → the view shoots → back).
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

ipcRenderer.on("colo-overlay:busy", (_event, payload: { on?: boolean }) => {
  setBusy(Boolean(payload?.on));
});

/** 전송 영수증 (D35): the web's word on whether the batch reached the thread. */
ipcRenderer.on(
  "colo-overlay:sent",
  (_event, payload: { batch?: unknown; ok?: unknown; shots?: unknown; items?: unknown }) => {
    if (typeof payload?.batch !== "string") return;
    settle(
      payload.batch,
      payload.ok === true,
      typeof payload.shots === "number" ? payload.shots : 0,
      typeof payload.items === "number" ? payload.items : 0,
    );
  },
);

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

// D79: the root mounts once the document exists, always — and the watchers
// attach THERE, not at preload eval: the documentElement can still be missing
// while the page parses, and an observer that never attached silently let
// drafts lie about their screen (D67 — found by the comments suite).
const boot = () => {
  if (!root.isConnected && document.body) document.body.appendChild(root);
  const html = document.documentElement;
  if (html) {
    screenWatch.observe(html, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-screen", "data-state"],
    });
    anchorWatch.observe(html, { childList: true, subtree: true });
  }
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
        "화면의 요소에 ⌥+클릭하면 핀을 찍어 Claude 에게 수정을 요청할 수 있습니다.",
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
