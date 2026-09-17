// ---------------------------------------------------------------------------
// Preview envelopes (PLAN D64–D69) — two contracts live here.
//
// 1. 레포 브리지 계약 (D68): `colo-design.screens`(+ `screens?`) and
//    `colo-design.navigate` are ALL a connected repo owes the tool. The repo
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
 * overlay (D67) from the DOM it shares with the page: a `data-component`
 * name or the tag, the element's own text, a CSS path from the
 * `[data-screen]` wrapper, and the viewport rect at pin time.
 */
export interface ColoDesignCommentTarget {
  /** `data-component` when the repo sets one, else the tag name. */
  component: string;
  /** The element's own text (direct text nodes), trimmed and capped. */
  text: string;
  /** CSS path from the [data-screen] wrapper down to the element. */
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
  /** The repo's own `data-colo-src` stamp: `path:line` of the JSX (재설계 C8). */
  source?: string;
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
    /** The screen state the pin sat on. */
    state: string;
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
    state: string;
    /**
     * The element path the badge re-anchors on. A `screenMark` row has no
     * element — it carries "" and the overlay anchors on the screen frame.
     */
    path: string;
    /** Sent pins grey out for the turn's life (재설계 C10). */
    sent: boolean;
    /**
     * 고침 표시 (preview.md §1-C): the mark registry's number — stable for
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
  /** The state the screen was showing. */
  state: string;
}

/**
 * The 💬 코멘트 toggle's word to the overlay (PLAN D58 → D67): the web keeps
 * the truth and the main process re-tells the preview preload
 * (`colo-overlay:mode`). Tool-internal — the repo never sees it; the overlay
 * has no toggle of its own, so the two can never disagree.
 */
export interface ColoDesignCommentsModeEnvelope {
  type: "colo-design.comments.mode";
  on: boolean;
}

/**
 * One screen the connected repo declares, as its overlay reports it (PLAN D7).
 * The repo names what it can render; the tool never parses its code.
 */
export interface ColoDesignScreen {
  /** Route the preview app serves it at, e.g. `/member/MemberList`. */
  route: string;
  /** What the screen is called, in the planner's words. */
  title: string;
  /** `?state=` variants this screen actually implements. */
  states: string[];
}

/**
 * 스트립이 그리는 탭 한 칸의 계약(인앱 브라우저 1단계, §3 규칙 3). 데스크톱이
 * `colo-preview:tabs` 로 푸는 사실이자 `preview:tabs` 가 돌려주는 것 — 웹의
 * 스트립이 그릴 전부다. WebContents 를 담지 않는다: 버려진(discarded) 탭도
 * 메타로는 살아 있어, 다시 골랐을 때 `url` 로 되살아난다.
 */
export interface PreviewTabMeta {
  /** 스트립 id — "t1"부터. 닫혀도 재활용하지 않는다. */
  id: string;
  /** repo 가 선언한 origin 위면 `preview`(오버레이 무장), 그 밖의 http(s) 면 `web`. */
  kind: "preview" | "web";
  /** 페이지가 마지막으로 보고한 제목 — 스트립 라벨. */
  title: string;
  /** 마지막 주소 — 버려진 탭이 되살아날 때 이 주소로 다시 시작한다. */
  url: string | null;
  /** WebContents 는 파기됐고 메타만 남았다 — 재활성화가 재로드를 부른다. */
  discarded: boolean;
}

/**
 * What the preview app posts on load: everything it can render. The tool never
 * parses the repo's code, so this is the only way it can offer a screen picker.
 */
export interface ColoDesignScreensEnvelope {
  type: "colo-design.screens";
  screens: ColoDesignScreen[];
}

/**
 * The tool asking for the list again.
 *
 * A request rather than a retry on the overlay's side: a retry window that
 * expires loses the list with no way to ask for it back, while a request can
 * only be lost while the overlay is unmounted — and the overlay's own mount
 * post then lands at a tool that is provably already listening. Every
 * ordering is covered and neither side waits on the other.
 */
export interface ColoDesignScreensRequestEnvelope {
  type: "colo-design.screens?";
}

/**
 * The one message that goes the other way: show this route in this state.
 * Sent when the planner picks a screen in the list, or taps a state chip.
 * The preview app routes; the tool does not touch its url.
 */
export interface ColoDesignNavigateEnvelope {
  type: "colo-design.navigate";
  route: string;
  /** Omitted or null means the screen's default. */
  state?: string | null;
}
