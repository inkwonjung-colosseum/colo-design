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

let mode = false;
let altHeld = false;
let busy = false;
let drafts: DraftPin[] = [];
let hover: HTMLDivElement | null = null;
let hoverTarget: Element | null = null;
let nextId = 1;
/** The pathname the open drafts were pinned on — a SPA move that carries no
    attribute change (래퍼 없는 페이지의 이동) would leave them lying. */
let draftsPath: string | null = null;
let layoutStop: (() => void) | null = null;
let layoutTimer: number | null = null;

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
  if (hover && hoverTarget) {
    const rect = hoverTarget.getBoundingClientRect();
    Object.assign(hover.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }
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
      stopHoverLoop();
      return;
    }
    if (!hover) {
      hover = document.createElement("div");
      hover.setAttribute("data-colo-hover", "");
      hover.style.cssText =
        "position:fixed;outline:2px solid #e05252;outline-offset:1px;pointer-events:none;";
      root.appendChild(hover);
      startHoverLoop();
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
    // A SPA route change no attribute carries: the open drafts would lie
    // about where they were pinned, so they go the way the data-screen
    // watcher clears them (D67).
    if (drafts.length > 0 && draftsPath !== window.location.pathname) {
      const gone = drafts.length;
      drafts = [];
      toast(`화면이 바뀌어 보내지 않은 핀 ${gone}개를 지웠습니다.`);
    }
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
    hoverTarget = null;
    stopHoverLoop();
  }
}
document.addEventListener("keydown", (event) => {
  if (event.altKey) setAlt(true);
});
document.addEventListener("keyup", (event) => {
  if (!event.altKey) setAlt(false);
});
window.addEventListener("blur", () => setAlt(false));

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
    if (child !== hover) child.remove();
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
        "max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:10px;color:#666;",
        pin.element.component,
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
}

/**
 * The draft editor (D80): the comment box and three buttons — ⏎ 보내기 sends
 * THIS pin alone at once, 담아 두기 parks it as a draft, 지우기 drops it.
 */
function draftEditor(pin: DraftPin, number: number): HTMLElement {
  const editor = el(
    "div",
    "pointer-events:auto;display:flex;flex-direction:column;gap:6px;background:#fff;border:1px solid #d4d4d4;border-radius:8px;padding:8px;width:288px;box-shadow:0 6px 20px rgba(0,0,0,.2);",
  );
  const head = el(
    "div",
    "font-size:11px;font-weight:700;color:#b91c1c;",
    `${number} · ${pin.element.component}`,
  );
  editor.appendChild(head);
  const input = document.createElement("textarea");
  input.rows = 2;
  input.value = pin.comment;
  input.setAttribute("aria-label", `핀 ${number} 코멘트`);
  input.placeholder = "이 요소에 바라는 점을 적어 주세요";
  input.style.cssText =
    "resize:none;border:1px solid #d4d4d4;border-radius:6px;padding:6px;font-size:13px;font-family:inherit;";
  input.addEventListener("input", () => {
    pin.comment = input.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendDrafts([pin]);
    }
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
    "담아 두기",
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

/** One (⏎ 보내기) or many (the bar): the envelope goes out, the drafts go. */
function sendDrafts(pins: DraftPin[]): void {
  const ready = pins.filter((pin) => pin.comment.trim() !== "");
  if (ready.length === 0) return;
  const first = ready[0]!.context;
  const envelope: ColoDesignCommentsEnvelope = {
    type: "colo-design.comments",
    screen: first.screen,
    state: first.state,
    items: ready.map((pin) => ({
      element: pin.element,
      comment: pin.comment.trim(),
    })),
  };
  ipcRenderer.send("colo-overlay:post", envelope);
  toast(
    busy
      ? "보냈습니다 — Claude 가 일하는 중, 끝나면 이어서 봅니다"
      : `수정 요청 ${ready.length}건을 보냈습니다.`,
  );
  drafts = drafts.filter((pin) => !ready.includes(pin));
  renderOverlay();
}

function toast(text: string): void {
  const note = el(
    "div",
    "position:fixed;right:16px;bottom:64px;background:#fff;color:#1a1a1a;border:1px solid #d4d4d4;border-radius:8px;padding:8px 12px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.2);",
    text,
  );
  root.appendChild(note);
  setTimeout(() => note.remove(), 2500);
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
};
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
