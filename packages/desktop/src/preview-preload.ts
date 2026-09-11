import { contextBridge, ipcRenderer } from "electron";
import type {
  CdsDesignCommentsEnvelope,
  CdsDesignCommentTarget,
  CdsDesignNavigateEnvelope,
} from "@cds-design/protocol";

/**
 * 미리보기 뷰의 preload (PLAN D67 · D68). Sandbox + contextIsolation 아래
 * 단일 파일로 살아야 한다 — 샌드박스 preload 의 require 는 electron 과 몇 개
 * 내장 모듈만 주므로, 신원 조사 같은 순수 조각도 여기 안에 인라인이다.
 *
 * 세 몫:
 * 1. 레포 브리지의 문 (D68): `window.cdsDesign.post` — 브리지가
 *    `cds-design.screens` 를 올리는 길. `cds-overlay:navigate` 는 반대로
 *    메인이 주면 페이지의 window 로 돌려 보낸다(postMessage). DOM 이벤트는
 *    world 를 넘으므로 메인 월드의 브리지 리스너가 받는다.
 * 2. 코멘트 핀 오버레이 (D67): 모드는 IPC 로만 받는다(안의 토글은 없다).
 *    핀은 요소에 붙고(스크롤·리사이즈마다 다시 그린다), 화면이 바뀌면
 *    미전송 핀은 지운다.
 * 3. 옛 이름 감지: `drafthouse.*` 봉투가 window 에 흐르면 stale 을 올린다.
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

function roundRect(rect: DOMRect): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function describeElement(element: Element | null): CdsDesignCommentTarget | null {
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

contextBridge.exposeInMainWorld("cdsDesign", {
  post: (envelope: unknown) => ipcRenderer.send("cds-overlay:post", envelope),
});

ipcRenderer.on("cds-overlay:navigate", (_event, payload: { route?: unknown; state?: unknown }) => {
  if (typeof payload?.route !== "string") return;
  const envelope: CdsDesignNavigateEnvelope = {
    type: "cds-design.navigate",
    route: payload.route,
    state: typeof payload.state === "string" ? payload.state : null,
  };
  // Addressed to our own origin; the page's bridge listens on window.
  window.postMessage(envelope, window.location.origin);
});

// ---------------------------------------------------------------------------
// 3. Stale-bridge detection — an old `drafthouse.*` overlay still posts at
// window.parent, which is this window; the messages stay visible here.
// ---------------------------------------------------------------------------

let staleReported = false;
window.addEventListener("message", (event) => {
  const type = (event.data as { type?: unknown } | null)?.type;
  if (!staleReported && typeof type === "string" && type.startsWith("drafthouse.")) {
    staleReported = true;
    ipcRenderer.send("cds-overlay:post", { type: "cds-design.stale" });
  }
});

// ---------------------------------------------------------------------------
// 2. The comment-pin overlay (D67). All styling inline — the repo's classes
// are the repo's; pointer-events none on the root so the page stays live.
// ---------------------------------------------------------------------------

interface Pin {
  id: number;
  anchor: Element;
  element: CdsDesignCommentTarget;
  context: { screen: string; state: string };
  comment: string;
  editing: boolean;
}

const Z = "2147483000";
const root = document.createElement("div");
root.setAttribute("data-cds-design-overlay", "");
root.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${Z};font-family:system-ui,-apple-system,sans-serif;`;

let mode = false;
let pins: Pin[] = [];
let hover: HTMLDivElement | null = null;
let nextId = 1;
let layoutStop: (() => void) | null = null;

function isOverlayUi(target: EventTarget | null): boolean {
  return target instanceof Node && root.contains(target);
}

function setMode(on: boolean): void {
  mode = on;
  if (!on) {
    pins = [];
    hover?.remove();
    hover = null;
    root.remove();
    layoutStop?.();
    layoutStop = null;
    return;
  }
  if (!root.isConnected && document.body) document.body.appendChild(root);
  startLayoutLoop();
}

function startLayoutLoop(): void {
  if (layoutStop) return;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    layoutOverlay();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  layoutStop = () => {
    stopped = true;
  };
}

/** The one place pin geometry comes from — the element, not the click (D67). */
function layoutOverlay(): void {
  if (hover && hoverTarget) {
    const rect = hoverTarget.getBoundingClientRect();
    Object.assign(hover.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }
  for (const pin of pins) {
    const chip = root.querySelector<HTMLElement>(`[data-pin="${pin.id}"]`);
    if (!chip) continue;
    const rect = pin.anchor.getBoundingClientRect();
    const x = Math.min(Math.max(rect.x + rect.width - 20, rect.x), rect.x + rect.width);
    const y = Math.max(rect.y - 10, 8);
    chip.style.left = `${Math.round(x)}px`;
    chip.style.top = `${Math.round(y)}px`;
  }
}

let hoverTarget: Element | null = null;

document.addEventListener(
  "mouseover",
  (event) => {
    if (!mode || isOverlayUi(event.target)) return;
    const element = event.target instanceof Element ? event.target : null;
    hoverTarget = element && element.closest("[data-screen]") ? element : null;
    if (!hoverTarget) {
      hover?.remove();
      hover = null;
      return;
    }
    if (!hover) {
      hover = document.createElement("div");
      hover.setAttribute("data-cds-hover", "");
      hover.style.cssText =
        "position:fixed;outline:2px solid #e05252;outline-offset:1px;pointer-events:none;";
      root.appendChild(hover);
    }
  },
  true,
);

document.addEventListener(
  "click",
  (event) => {
    if (!mode || isOverlayUi(event.target)) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    const target = describeElement(element);
    const context = screenContext(element);
    // 셸 · 피커에는 핀을 만들지 않는다 — 화면 수정 요청이 아니기 때문이다.
    if (!target || !context) return;
    event.preventDefault();
    event.stopPropagation();
    pins = [...pins, { id: nextId++, anchor: element, element: target, context, comment: "", editing: true }];
    renderOverlay();
  },
  true,
);

/** 화면이 바뀌면 미전송 핀은 지운다 (D67) — 핀이 다른 화면에 남으면 거짓말이다. */
const screenWatch = new MutationObserver(() => {
  if (pins.length === 0) return;
  const gone = pins.length;
  pins = [];
  renderOverlay();
  toast(`화면이 바뀌어 보내지 않은 핀 ${gone}개를 지웠습니다.`);
});
if (document.documentElement) {
  screenWatch.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-screen", "data-state"],
  });
}

function el(tag: string, style: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const BUTTON_BASE =
  "pointer-events:auto;border:0;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;";

function renderOverlay(): void {
  if (!mode) return;
  for (const child of [...root.childNodes]) {
    if (child !== hover) child.remove();
  }
  for (const pin of pins) {
    const wrap = el("div", "position:fixed;pointer-events:none;display:flex;flex-direction:column;align-items:flex-start;gap:4px;");
    wrap.dataset.pin = String(pin.id);

    const chip = el(
      "div",
      "pointer-events:auto;display:flex;align-items:center;gap:6px;background:#fff;color:#1a1a1a;border:1px solid #d4d4d4;border-radius:999px;padding:2px 6px 2px 8px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.18);",
    );
    chip.appendChild(el("span", "font-weight:700;", String(pin.id)));
    chip.appendChild(el("span", "max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:10px;color:#666;", pin.element.component));
    const remove = el("button", `${BUTTON_BASE}background:none;color:#888;padding:0 4px;font-size:13px;`, "×");
    remove.setAttribute("aria-label", `핀 ${pin.id} 삭제`);
    remove.addEventListener("click", () => {
      pins = pins.filter((entry) => entry.id !== pin.id);
      renderOverlay();
    });
    chip.appendChild(remove);
    wrap.appendChild(chip);

    if (pin.editing) {
      const editor = el("div", "pointer-events:auto;display:flex;flex-direction:column;gap:6px;background:#fff;border:1px solid #d4d4d4;border-radius:8px;padding:8px;width:288px;box-shadow:0 6px 20px rgba(0,0,0,.2);");
      const input = document.createElement("textarea");
      input.rows = 2;
      input.value = pin.comment;
      input.setAttribute("aria-label", `핀 ${pin.id} 코멘트`);
      input.placeholder = "이 요소에 바라는 점을 적어 주세요";
      input.style.cssText = "resize:none;border:1px solid #d4d4d4;border-radius:6px;padding:6px;font-size:13px;font-family:inherit;";
      input.addEventListener("input", () => {
        pin.comment = input.value;
      });
      const save = el("button", `${BUTTON_BASE}background:#e05252;color:#fff;align-self:flex-end;`, "저장");
      save.addEventListener("click", () => {
        pin.comment = input.value;
        pin.editing = false;
        renderOverlay();
      });
      editor.appendChild(input);
      editor.appendChild(save);
      wrap.appendChild(editor);
    } else if (pin.comment) {
      const bubble = el(
        "button",
        "pointer-events:auto;max-width:288px;text-align:left;background:#fff;border:1px solid #d4d4d4;border-radius:8px;padding:5px 8px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,.15);",
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

  const ready = pins.filter((pin) => pin.comment.trim() !== "");
  const bar = el(
    "div",
    "position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;gap:8px;",
  );
  if (ready.length > 0) {
    const send = el("button", `${BUTTON_BASE}background:#e05252;color:#fff;padding:8px 16px;box-shadow:0 6px 20px rgba(0,0,0,.25);`, `수정 요청 ${ready.length}건 보내기`);
    send.addEventListener("click", () => {
      const first = ready[0]!.context;
      const envelope: CdsDesignCommentsEnvelope = {
        type: "cds-design.comments",
        screen: first.screen,
        state: first.state,
        items: ready.map((pin) => ({ element: pin.element, comment: pin.comment.trim() })),
      };
      ipcRenderer.send("cds-overlay:post", envelope);
      toast(`수정 요청 ${ready.length}건을 보냈습니다.`);
      pins = [];
      renderOverlay();
    });
    bar.appendChild(send);
  }
  const hintRow = el(
    "div",
    "pointer-events:none;background:rgba(26,26,26,.85);color:#fff;border-radius:999px;padding:4px 12px;font-size:11.5px;",
    "찍을 요소를 클릭해 코멘트를 답니다 · 툴바의 💬 코멘트로 끕니다",
  );
  bar.appendChild(hintRow);
  root.appendChild(bar);
  layoutOverlay();
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

ipcRenderer.on("cds-overlay:mode", (_event, payload: { on?: boolean }) => {
  const on = Boolean(payload?.on);
  const boot = () => {
    setMode(on);
    if (on) renderOverlay();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
});
