import type {
  ColoDesignCommentsEnvelope,
  ColoDesignCommentTarget,
  ColoDesignNavigateEnvelope,
  CommentItem,
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
 * 2. 코멘트 핀 오버레이 (D67 → D78): 기록된 핀은 웹이 내려 준 목록을
 *    `[data-screen]`·`[data-state]` 로 걸러 늘 그린다 — 루트는 DOMContentLoaded
 *    에 항상 붙고(D79), 모드는 이제 핀만 찍는 좁은 뜻이다. 해결 · 다시 요청은
 *    봉투로 올려 뷰가 웹에 건넨다.
 */

// ---------------------------------------------------------------------------
// Element identity (DESIGN §6, fiber-free) — the isolated world cannot see the
// page's React fiber expandos, so the component name is `data-component` or
// the tag. Everything else (own text, CSS path from the [data-screen]
// wrapper, rect) is plain DOM.
// ---------------------------------------------------------------------------

function ownText(element: Element): string {
  let text = "";
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

function cssPath(element: Element, root: Element): string {
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
  return [`div[data-screen="${root.getAttribute("data-screen")}"]`, ...parts].join(" > ");
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
  if (!screenRoot) return null;
  return {
    component: element.getAttribute("data-component") ?? element.tagName.toLowerCase(),
    text: ownText(element),
    path: cssPath(element, screenRoot),
    rect: roundRect(element.getBoundingClientRect()),
  };
}

function screenContext(element: Element): { screen: string; state: string } | null {
  const root = element.closest("[data-screen]");
  if (!root) return null;
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
// 2. The comment-pin overlay (D67 → D78 · D79 · D80). All styling inline —
// the repo's classes are the repo's; pointer-events none on the root so the
// page stays live.
//
// D78: RECORDED pins come down from the web (`colo-overlay:pins`, the whole
// project list) and are filtered against the page's own [data-screen] /
// [data-state] — a screen switch needs no round trip. They anchor by `path`
// each time they are drawn (no element reference survives a hot reload), and
// a pin whose element is gone docks in the 못 찾은 목록.
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

/** A recorded pin paired with its 확인해 주세요 mark (D78). */
interface RecordedPin {
  item: CommentItem;
  attention: boolean;
}

const Z = "2147483000";
const root = document.createElement("div");
root.setAttribute("data-colo-design-overlay", "");
root.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${Z};font-family:system-ui,-apple-system,sans-serif;`;

const ACCENT = "#f59e0b";

let mode = false;
let altHeld = false;
let busy = false;
let drafts: DraftPin[] = [];
let recorded: RecordedPin[] = [];
let hover: HTMLDivElement | null = null;
let hoverTarget: Element | null = null;
let nextId = 1;
let layoutStop: (() => void) | null = null;
let layoutTimer: number | null = null;
/** The 못 찾은 목록's fold — survives the re-renders every layout triggers. */
let lostExpanded = false;

function isOverlayUi(target: EventTarget | null): boolean {
  return target instanceof Node && root.contains(target);
}

function currentScreenRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-screen]");
}

function setMode(on: boolean): void {
  mode = on;
  // D79: turning the mode off keeps the root and every pin — the recorded
  // pins are the product now; drafts live in memory and die with the screen,
  // not with the toggle. Only the hover (a picking affordance) and the hint
  // line belong to the mode.
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

/** Draft chips ride their held element; recorded pins are re-resolved fresh. */
function layoutOverlay(): void {
  layoutHover();
  for (const pin of drafts) {
    const chip = root.querySelector<HTMLElement>(`[data-pin="${pin.id}"]`);
    if (!chip) continue;
    const rect = pin.anchor.getBoundingClientRect();
    const x = Math.min(Math.max(rect.x + rect.width - 20, rect.x), rect.x + rect.width);
    const y = Math.max(rect.y - 10, 8);
    chip.style.left = `${Math.round(x)}px`;
    chip.style.top = `${Math.round(y)}px`;
  }
  for (const entry of visibleRecorded()) {
    const chip = root.querySelector<HTMLElement>(`[data-rpin="${cssEscape(entry.item.id)}"]`);
    if (!chip) continue;
    const anchor = anchorFor(entry.item);
    if (!anchor) continue;
    const rect = anchor.getBoundingClientRect();
    const x = Math.min(Math.max(rect.x + rect.width - 10, rect.x), rect.x + rect.width);
    const y = Math.max(rect.y - 10, 8);
    chip.style.left = `${Math.round(x)}px`;
    chip.style.top = `${Math.round(y)}px`;
  }
}

function cssEscape(value: string): string {
  // Attribute-selector safe: ids are uuids today, but a hand edit should not
  // break the whole overlay's querySelector.
  return value.replace(/(["\\])/g, "\\$1");
}

/** The screen the page is showing right now, as the pins were recorded. */
function visibleRecorded(): RecordedPin[] {
  const current = currentScreenRoot();
  if (!current) return [];
  const screen = current.getAttribute("data-screen") ?? "";
  const state = current.getAttribute("data-state") ?? "default";
  // 해결된 핀은 화면에서 사라진다 (D78 — 기본 숨김): the popover's
  // 해결된 것 보기 is where resolved history is read.
  return recorded.filter(
    (entry) => !entry.item.resolved && entry.item.screen === screen && entry.item.state === state,
  );
}

/**
 * The recorded pin's anchor, resolved fresh on every layout (D78 — no element
 * reference is held): `path` first, the declared component among the screen's
 * elements with the same own text second.
 */
function anchorFor(item: CommentItem): Element | null {
  if (!item.element) return null;
  try {
    const byPath = document.querySelector(item.element.path);
    if (byPath) return byPath;
  } catch {
    // A path the page no longer parses; the fallback below still runs.
  }
  const screenRoot = document.querySelector(`[data-screen="${cssEscape(item.screen)}"]`);
  if (!screenRoot) return null;
  const candidates = screenRoot.querySelectorAll(
    `[data-component="${cssEscape(item.element.component)}"]`,
  );
  for (const candidate of candidates) {
    if (ownText(candidate) === item.elementText) return candidate;
  }
  if (item.elementText === "") {
    // A textless element (a wrapper, an icon): first same-component match is
    // the best guess and better than the 못 찾은 목록.
    return candidates[0] ?? null;
  }
  return null;
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
    hoverTarget = element && element.closest("[data-screen]") ? element : null;
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
    if (!target || !context) {
      // 셸 클릭은 조용히 무시한다. 단, 페이지에 [data-screen] 이 아예 없으면
      // Claude 가 래퍼를 빼먹은 화면이다 — 핀이 조용히 죽는 대신 말한다 (D89).
      if (!document.querySelector("[data-screen]")) {
        toast("이 화면에는 핀을 붙일 수 없습니다 — 화면 보여 주기로 알려 주세요");
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
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
// 기록된 핀은 화면별로 걸러지므로 지울 것이 없다 (D80); the same observer
// RE-RENDERS them — a state chip change re-filters the list, so the pins of
// the old state must leave the screen (D78).
const screenWatch = new MutationObserver(() => {
  if (drafts.length > 0) {
    const gone = drafts.length;
    drafts = [];
    renderOverlay();
    toast(`화면이 바뀌어 보내지 않은 핀 ${gone}개를 지웠습니다.`);
    return;
  }
  renderOverlay();
});
if (document.documentElement) {
  screenWatch.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-screen", "data-state"],
  });
}

// D78: the recorded pin's anchor re-resolves when the page moves under it —
// a hot reload must drag the pins along, not strand them. No element refs.
const anchorWatch = new MutationObserver(() => scheduleLayout());
if (document.documentElement) {
  anchorWatch.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}
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

/** Which recorded pins draw an open bubble: the clicked one, and attention ones (D78). */
const openBubbles = new Set<string>();

function renderOverlay(): void {
  for (const child of [...root.childNodes]) {
    if (child !== hover) child.remove();
  }

  const shown = visibleRecorded();
  let number = 0;

  // --- recorded pins: numbered accent dots (D78) --------------------------
  for (const entry of shown) {
    number += 1;
    const anchor = anchorFor(entry.item);
    if (!anchor) continue;
    const rect = anchor.getBoundingClientRect();
    const wrap = el("div", "position:fixed;pointer-events:none;");
    wrap.dataset.rpin = entry.item.id;
    const dot = el(
      "button",
      `pointer-events:auto;width:22px;height:22px;border-radius:999px;border:2px solid #fff;color:#fff;font-size:11px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;background:${entry.item.resolved ? "#9ca3af" : entry.attention ? ACCENT : ACCENT};`,
      String(number),
    );
    dot.title = entry.item.elementText || entry.item.text;
    dot.addEventListener("click", () => {
      if (openBubbles.has(entry.item.id)) openBubbles.delete(entry.item.id);
      else openBubbles.add(entry.item.id);
      renderOverlay();
    });
    wrap.appendChild(dot);
    wrap.style.left = `${Math.round(Math.min(Math.max(rect.x + rect.width - 10, rect.x), rect.x + rect.width))}px`;
    wrap.style.top = `${Math.round(Math.max(rect.y - 10, 8))}px`;
    if (openBubbles.has(entry.item.id)) wrap.appendChild(recordedBubble(entry.item));
    root.appendChild(wrap);
  }

  // --- 못 찾은 코멘트: the dock list, collapsed by default (D78) ----------
  const lost = shown.filter((entry) => !anchorFor(entry.item));
  if (lost.length > 0) {
    const dock = el(
      "div",
      "position:fixed;left:16px;bottom:16px;pointer-events:auto;background:#fff;border:1px solid #d4d4d4;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.2);max-width:320px;display:flex;flex-direction:column;",
    );
    const head = el(
      "button",
      "pointer-events:auto;border:0;background:none;text-align:left;padding:7px 10px;font-size:12px;font-weight:600;color:#374151;cursor:pointer;",
      `${lostExpanded ? "▾" : "▸"} 자리를 못 찾은 코멘트 ${lost.length}`,
    );
    dock.appendChild(head);
    head.addEventListener("click", () => {
      lostExpanded = !lostExpanded;
      renderOverlay();
    });
    if (lostExpanded) {
      for (const entry of lost) {
        const row = el(
          "button",
          "pointer-events:auto;border:0;border-top:1px solid #eee;background:none;text-align:left;padding:7px 10px;font-size:12px;cursor:pointer;color:#1a1a1a;",
          entry.item.elementText || entry.item.text,
        );
        row.addEventListener("click", () => {
          if (openBubbles.has(entry.item.id)) openBubbles.delete(entry.item.id);
          else openBubbles.add(entry.item.id);
          renderOverlay();
        });
        dock.appendChild(row);
        if (openBubbles.has(entry.item.id)) dock.appendChild(recordedBubble(entry.item));
      }
    }
    root.appendChild(dock);
  }

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

/**
 * The recorded pin's bubble (D78): the words, the 해결 toggle, and — for a
 * pin a finished turn owes a look at — 다시 요청. 해결과 다시 요청 both go
 * up as envelopes; the view relays them to the web.
 */
function recordedBubble(item: CommentItem): HTMLElement {
  const bubble = el(
    "div",
    "pointer-events:auto;margin-top:4px;max-width:288px;background:#fff;border:1px solid #d4d4d4;border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.2);display:flex;flex-direction:column;gap:6px;",
  );
  const title = el("div", "font-weight:700;color:#374151;", `${item.elementText || "화면의 요소"}`);
  bubble.appendChild(title);
  bubble.appendChild(el("div", "color:#1a1a1a;line-height:1.5;", item.text));
  if (item.resolved) bubble.appendChild(el("div", "color:#9ca3af;", "해결됨"));
  const row = el("div", "display:flex;gap:6px;justify-content:flex-end;");
  const toggle = el(
    "button",
    `${BUTTON_BASE}background:${item.resolved ? "none" : ACCENT};${item.resolved ? "color:#555;" : "color:#fff;"}border:${item.resolved ? "1px solid #d4d4d4" : "0"};`,
    item.resolved ? "미해결로" : "해결",
  );
  toggle.addEventListener("click", () => {
    ipcRenderer.send("colo-overlay:post", {
      type: "colo-design.comments.resolve",
      id: item.id,
      resolved: !item.resolved,
    } satisfies {
      type: "colo-design.comments.resolve";
      id: string;
      resolved: boolean;
    });
    openBubbles.delete(item.id);
    renderOverlay();
  });
  row.appendChild(toggle);
  if (!item.resolved) {
    const resend = el(
      "button",
      `${BUTTON_BASE}background:none;color:#555;border:1px solid #d4d4d4;`,
      "다시 요청",
    );
    resend.addEventListener("click", () => {
      ipcRenderer.send("colo-overlay:post", {
        type: "colo-design.comments.resend",
        id: item.id,
      });
      openBubbles.delete(item.id);
      renderOverlay();
    });
    row.appendChild(resend);
  }
  const close = el("button", `${BUTTON_BASE}background:none;color:#888;padding:0 6px;`, "닫기");
  close.addEventListener("click", () => {
    openBubbles.delete(item.id);
    renderOverlay();
  });
  row.appendChild(close);
  bubble.appendChild(row);
  return bubble;
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
// Inbound — the view's words. Mode (narrowed, D79), the recorded list (D78),
// busy (D86), and the capture three-beat (D87: hide → the view shoots → back).
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

ipcRenderer.on("colo-overlay:pins", (_event, payload: { items?: unknown; attention?: unknown }) => {
  const items = Array.isArray(payload?.items) ? (payload.items as CommentItem[]) : [];
  const attention = Array.isArray(payload?.attention) ? (payload.attention as string[]) : [];
  recorded = items
    .filter((item) => item && typeof item === "object" && typeof item.id === "string")
    .map((item) => ({ item, attention: attention.includes(item.id) }));
  // A resolved pin keeps no bubble open; a fresh list draws fresh state.
  const ids = new Set(items.map((item) => item.id));
  for (const id of [...openBubbles]) if (!ids.has(id)) openBubbles.delete(id);
  renderOverlay();
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

// D79: the root mounts once the document exists, always.
const boot = () => {
  if (!root.isConnected && document.body) document.body.appendChild(root);
  scheduleLayout();
};
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
