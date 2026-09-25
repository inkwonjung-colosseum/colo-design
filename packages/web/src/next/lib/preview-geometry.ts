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
}): { left: number; top: number; up: boolean } {
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
  return { left: Math.round(left), top: Math.round(top), up };
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
