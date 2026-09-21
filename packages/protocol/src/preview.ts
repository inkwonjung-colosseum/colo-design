// ---------------------------------------------------------------------------
// Preview envelopes (PLAN D64–D69) — two contracts live here.
//
// 1. 레포 브리지 계약 (D68): `colo-design.navigate` is ALL a connected repo
//    owes the tool — a pin's 화면 이동이 이 한 봉투로 간다. The repo
//    carries a hand-synced duplicate of these shapes
//    (reference clone `src/preview-bridge/types.ts`); on the desktop the
//    envelopes ride the preview preload's `window.coloDesign.post` → IPC, in a
//    plain browser they ride postMessage with the iframe.
// 2. 도구 내부 (D67 · D69): the comments bundle, the error report and the
//    comments-mode switch are the TOOL talking to itself — the desktop's
//    preview preload makes them, the main process relays them verbatim, and
//    the web consumes them. No repo code is involved, which is the point: the
//    overlay died the day it lived in the repo.
// ---------------------------------------------------------------------------
/**
 * One pinned element in the repo's preview app, described by the tool's own
 * overlay (D67) from the DOM it shares with the page: the tag, the element's
 * own text, a CSS path from the page's `body`, and the viewport rect at pin
 * time(2026-09-21 레포 마커 철거 — 신원은 경로뿐이다).
 */
export interface ColoDesignCommentTarget {
  /** The tag name — the element's own kind. */
  component: string;
  /** The element's own text (direct text nodes), trimmed and capped. */
  text: string;
  /** CSS path from the page's `body` down to the element. */
  path: string;
  /** Viewport rect of the element at pin time. */
  rect: { x: number; y: number; width: number; height: number };
  /**
   * What the click took (재설계 C9): an element (default — absent reads as
   * `element`, and older pins carry no kind) or a dragged region.
   */
  kind?: "element" | "region";
  /** outerHTML, overlay nodes stripped, capped at 1.5KB (재설계 C9). */
  html?: string;
  /** A computed-style subset worth quoting: color, font, spacing, size. */
  styles?: Record<string, string>;
  /** The element's accessible identity, when the page declares one. */
  a11y?: { role?: string; name?: string };
  /** Stable hooks the repo may have left: id, test id, a few classes. */
  attrs?: { id?: string; testId?: string; classes?: string[] };
  /** React component names, nearest first, ≤3 (재설계 C9). Dev builds only. */
  owners?: string[];
}

/**
 * One pin from the tool's preview overlay (재설계 C1): a click lands as ONE
 * envelope, the view crops the element (`shot`), and the web parks it as a
 * composer attachment. The overlay holds no draft state — the web's pin list
 * is the truth, and it projects back through `ColoDesignPinsSync`.
 */
export interface ColoDesignPinEnvelope {
  type: "colo-design.pin";
  pin: {
    /** The overlay's UUID — chip, badge and store row all meet on it. */
    id: string;
    /** The screen the pin sat on, as `screenContext` read it. */
    screen: string;

    element: ColoDesignCommentTarget;
    /**
     * What the planner was looking at (PLAN D87): the view crops the element
     * (`element.rect`) out of the page before the pin reaches the web, and
     * the crop rides the turn as the planner's own image. Filled by the
     * VIEW — the overlay does not know it exists; absent when the capture
     * could not run.
     */
    shot?: { mediaType: string; data: string };
  };
}

/**
 * The web → overlay projection (재설계 C1): the live pins, oldest first —
 * the order IS the badge number. Idempotent: the web resends the whole list
 * on every change and after a page load, and the overlay re-anchors each
 * badge on `path`. A pin on another screen draws no badge; its row exists
 * all the same.
 */
export interface ColoDesignPinsSync {
  pins: Array<{
    id: string;
    screen: string;
    /**
     * The element path the badge re-anchors on. A `screenMark` row has no
     * element — it carries "" and the overlay anchors on the screen frame.
     */
    path: string;
    /** Sent pins grey out for the turn's life (재설계 C10). */
    sent: boolean;
    /**
     * 고침 표시: the mark registry's number — stable for
     * the cycle, so a done mark keeps the number its pin was sent with and
     * the conversation's ③④⑤⑥ references resolve 1:1. Absent on old webs;
     * the overlay falls back to the row's place in the list.
     */
    n?: number;
    /**
     * The badge's tone: `live` (absent — the accent badge), `sent` (the
     * turn's grey), `done` (a sent 수정 핀 that outlives its turn — solid
     * green). `sent` and `tone` agree; tone is the newer word.
     */
    tone?: "live" | "sent" | "done";
    /**
     * 화면 마크: a changed screen no pin covered — no element anchor, so the
     * badge docks on the screen frame's corner instead.
     */
    screenMark?: boolean;
    /**
     * A region pin has no element path — the overlay re-anchors it on these
     * page coordinates instead (재설계 C9). Absent on element pins.
     */
    rect?: { x: number; y: number; width: number; height: number };
  }>;
}

/**
 * What the desktop reports when the screen it is showing fails (PLAN D49 →
 * D69): `console-message` errors and a crashed renderer are `runtime`, a
 * failed main-frame load is `build`. Built from the preview view's own
 * events — no repo hook involved — and sent to the web as
 * `colo-preview:error`, where the banner above the frame offers it to Claude
 * as one marker turn.
 */
export interface ColoDesignErrorEnvelope {
  type: "colo-design.error";
  /** A crash inside the page, or the build that serves it. */
  kind: "runtime" | "build";
  /** The error text, as the browser or the loader reported it. */
  message: string;
  /** The route that was up when it failed. */
  route: string;
}

/**
 * `preview.screenCheck` — the isolated verification window's verdict for one
 * screen (게이트 `inspectScreens` 와 같은 드라이버·같은 기준): did the page
 * settle, and what did its console count as trouble (`error`·네트워크 실패
 * 만 — `warn` 은 레포 개발 빌드의 기본 소음이라 세지 않는다).
 */
export interface ScreenCheckReport {
  /** The page's settle marker appeared in time. */
  settled: boolean;
  /** Trouble lines, `level: text`, at most `MAX_LINES_PER_SCREEN`. */
  errors: string[];
}
