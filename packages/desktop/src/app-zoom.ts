import { loadDesktopSettings, saveDesktopSettings } from "./desktop-settings.js";

/**
 * 앱 배율 (PLAN-UI §10 U19) — ⌘= · ⌘- · ⌘0 이 앱 전체(사이드바 · 대화 ·
 * 상태 줄 · 미리보기 게스트)를 키운다. 값은 desktop-settings.json 에 산다:
 * 데몬의 포트가 실행마다 바뀌는 origin 에는 Electron 의 배율 저장을 맡길 수
 * 없다(desktop-settings.ts 와 같은 이유).
 */

/** 사람이 쓸 배율의 울타리 — 0.8 ~ 1.5, 0.1 씩 움직인다. */
export const APP_ZOOM_MIN = 0.8;
export const APP_ZOOM_MAX = 1.5;

/** 한 걸음 — 울타리 안에서 0.1 씩, 소수 첫째 자리로 반올림한다(reset 은 1). */
export function stepZoom(current: number, direction: "in" | "out" | "reset"): number {
  if (direction === "reset") return 1;
  const stepped = Math.min(
    APP_ZOOM_MAX,
    Math.max(APP_ZOOM_MIN, current + (direction === "in" ? 0.1 : -0.1)),
  );
  return Math.round(stepped * 10) / 10;
}

/** 지난 실행이 저장한 앱 배율 — 손으로 고친 값도 읽히므로 범위를 본다(loadStoredPort 와 같은 태도). */
export function loadAppZoom(path: string): number {
  const zoom = loadDesktopSettings(path).zoom;
  return typeof zoom === "number" && zoom >= APP_ZOOM_MIN && zoom <= APP_ZOOM_MAX ? zoom : 1;
}

/** 읽기-수정-쓰기는 저장소 쪽이 지킨다 — 여기선 값만 실는다. */
export function saveAppZoom(path: string, factor: number): void {
  saveDesktopSettings(path, { zoom: factor });
}
