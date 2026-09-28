/**
 * 미리보기 칸의 순수 계산 — 말풍선의 자리(U4)와 준비 화면의 걸음(U8). 형제
 * 모듈을 부르지 않는다(시험이 src 에서 곧장 읽는다).
 */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 핀 말풍선의 자리 — 오버레이가 보고한 요소의 `rect`(게스트 뷰포트의 CSS px)를
 * 게스트 요소의 화면 위치(`frame`, 칸 기준)와 배율로 옮긴다. 요소 바로 아래에
 * 서고, 칸의 바닥을 넘으면 요소 위로 올라간다(`up`). 가로는 칸 안으로 묶는다.
 * `arrowLeft` 는 말풍선 안 화살표의 자리 — 요소의 가운데를 가리키되 말풍선
 * 안으로 묶는다(CSS 변수 `--pv-arrow` 로 흘러간다).
 */
export function bubblePlacement(input: {
  rect: Rect;
  /** 게스트 요소의 왼쪽 위 — 말풍선이 사는 칸의 좌표계. */
  frame: { left: number; top: number };
  zoom: number;
  /** 말풍선이 사는 칸의 크기. */
  box: { width: number; height: number };
  bubble: { width: number; height: number };
  gap?: number;
}): { left: number; top: number; up: boolean; arrowLeft: number } {
  const { rect, frame, box, bubble } = input;
  const zoom = input.zoom > 0 ? input.zoom : 1;
  const gap = input.gap ?? 10;
  const margin = 8;
  const elLeft = frame.left + rect.x * zoom;
  const elTop = frame.top + rect.y * zoom;
  const elBottom = elTop + rect.height * zoom;
  let top = elBottom + gap;
  let up = false;
  if (top + bubble.height > box.height - margin) {
    const above = elTop - gap - bubble.height;
    if (above >= margin) {
      top = above;
      up = true;
    } else {
      // 위에도 자리가 없다(칸보다 큰 요소) — 칸 안에 붙들어 둔다.
      top = Math.max(margin, box.height - margin - bubble.height);
    }
  }
  const maxLeft = Math.max(margin, box.width - bubble.width - margin);
  const left = Math.min(maxLeft, Math.max(margin, elLeft - 14));
  // 화살표는 요소의 가운데를 가리킨다 — 말풍선이 묶여 밀려도 화살표가
  // 요소를 좇게, 자리는 말풍선 폭 안으로 다시 묶는다.
  const elCenter = elLeft + (rect.width * zoom) / 2;
  const arrowLeft = Math.round(Math.min(bubble.width - 20, Math.max(10, elCenter - left)));
  return { left: Math.round(left), top: Math.round(top), up, arrowLeft };
}

/**
 * 말풍선이 볼 핀의 상자 — 요소 핀의 `rect` 는 찍은 순간의 화면 좌표지만,
 * 영역 핀의 `rect` 는 스크롤이 남아 있는 페이지 좌표(재설계 C9)라 찍은
 * 순간의 화면 좌표(`rectView`)를 함께 싣는다. 없는 봉투(옛 클라이언트)는
 * `rect` 로 돌아간다.
 */
export function bubbleRect(element: { rect: Rect; rectView?: Rect }): Rect {
  return element.rectView ?? element.rect;
}

/** 줌의 한계 — main 이 배율을 조이는 값(preview-view.ts 의 setZoom)과 같다. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;

/** 줌 막대의 진실 — 100% 칸은 배율이 1 일 때만 켜지고, 한계에서는 바깥
 *  단추(− · +)가 더 갈 데가 없어 꺼진다. */
export function zoomButtons(zoom: number): { out: boolean; in: boolean; reset: boolean } {
  const value = Number.isFinite(zoom) ? zoom : 1;
  return {
    out: value <= ZOOM_MIN + 1e-9,
    in: value >= ZOOM_MAX - 1e-9,
    reset: Math.abs(value - 1) < 1e-9,
  };
}

/** 준비의 세 걸음 — `내려받기 · 설치하기 · 미리보기 켜기`. 준비가 아니면 null. */
export function prepStep(phase: string): 0 | 1 | 2 | null {
  switch (phase) {
    case "missing":
    case "cloning":
    case "pulling":
      return 0;
    case "installing":
      return 1;
    case "starting":
      return 2;
    default:
      return null;
  }
}

/** 걸음마다 흔히 걸리는 시간(ms) — 막대가 그 걸음 안에서 차오르는 빠르기. */
const TYPICAL_MS = [20_000, 120_000, 30_000] as const;

/**
 * 진행 막대의 퍼센트 — 선로에 숫자 진행이 없으므로 걸음과 그 걸음에서 흐른
 * 시간으로 짓는다. 한 걸음 안에서는 끝까지 차지 않는다(다음 걸음이 채운다).
 */
export function prepProgress(phase: string, elapsedMs: number): number {
  const step = prepStep(phase);
  if (step === null) return phase === "ready" ? 100 : 0;
  const typical = TYPICAL_MS[step];
  const inStep = 1 - Math.exp(-Math.max(0, elapsedMs) / typical);
  const pct = ((step + 0.9 * inStep) / 3) * 100;
  return Math.max(2, Math.min(99, Math.round(pct)));
}

/** 흐른 시간 → 분 · 초. */
export function elapsedParts(ms: number): { minutes: number; seconds: number } {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

/**
 * 답이 끝났을 때 미리보기의 한 번의 신호 — 「옮겨 감」과 「이미 거기서
 * 바뀜」을 한 곳에서 판정한다. 턴이 끝나지 않았거나(흐르는 중 · 다른
 * 대화), 사람이 일부러 밖으로 나가 있거나, 이번 턴이 화면을 말하지
 * 않았으면 신호가 없다(null). 신호가 있으면 첫 화면의 주소와 이미 그
 * 화면에 있는지를 돌려준다 — 칸은 이 값을 하나로 받아 이동과 옅은
 * 빛줄기를 함께 일으킨다.
 */
export function arriveOnTurnEnd(input: {
  /** 이번 턴이 끝났는가 — 같은 대화의 턴이 살아 있다가 끝난 순간만 true. */
  ended: boolean;
  /** 사람이 일부러 밖(예. 링크)을 보고 있는가 — 그때는 칸이 움직이지 않는다. */
  external: boolean;
  /** 이번 턴이 말한 화면들 — `path` 는 주소, `key` 는 화면의 같음 잣대. */
  screens: { path: string; key: string }[];
  /** 지금 보고 있는 화면의 같음 잣대. */
  hereKey: string;
}): { path: string; already: boolean } | null {
  if (!input.ended || input.external) return null;
  const first = input.screens[0];
  if (!first) return null;
  const already = input.screens.some((screen) => screen.key === input.hereKey);
  return { path: first.path, already };
}
