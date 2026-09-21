import { useSyncExternalStore } from "react";

/**
 * 첫 실행 투어(P3-2) — 새 프레임워크가 아니라 **순서표** 하나다.
 *
 * 이 앱에는 이미 손수 만든 코치마크가 셋 있다: 빈 대화의 예시 문장 창, 핀 버튼의
 * 코치, 제출 버튼의 코치. 셋이 각자의 localStorage 키로 "봤는가"를 기억하는
 * 것은 그대로 두고 — 그것이 그 키들이 말하는 사실이다 — 이 파일은 하나만
 * 더한다: **한 번에 하나만**, 그리고 순서대로.
 *
 * 셋이 동시에 서면 첫 화면이 안내로 뒤덮인다. 무엇을 먼저 하라는 것인지
 * 알 수 없는 안내는 없느니만 못하다.
 *
 * 걸음은 한 방향으로만 간다: `composer` → `pin` → `submit` → `done`.
 * 뒤로 가는 길은 없다 — 되돌릴 이유가 있다면 그것은 투어가 아니라 도움말이다.
 */

const KEY = "colo-design.tour-step";

export type TourStep = "composer" | "pin" | "submit" | "done";

const ORDER: TourStep[] = ["composer", "pin", "submit", "done"];

function read(): TourStep {
  try {
    const raw = localStorage.getItem(KEY);
    return ORDER.includes(raw as TourStep) ? (raw as TourStep) : "composer";
  } catch {
    // 저장소가 막힌 기기 — 투어는 이번 실행에서만 산다.
    return "composer";
  }
}

/** 구독자 — 세 표면이 같은 걸음을 읽어야 하나만 선다. */
const listeners = new Set<() => void>();

let current: TourStep | null = null;

export function tourStep(): TourStep {
  if (current === null) current = read();
  return current;
}

/**
 * 이 걸음을 마친다. `from` 이 지금 걸음일 때만 움직인다 — 늦게 도착한 표면의
 * 졸업 신호가 이미 지나간 걸음을 다시 밀지 않게.
 */
export function advanceTour(from: TourStep): void {
  if (tourStep() !== from) return;
  const next = ORDER[ORDER.indexOf(from) + 1] ?? "done";
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 저장 실패는 치명적이지 않다 — 다음 실행에 한 번 더 볼 뿐.
  }
  for (const listener of [...listeners]) listener();
}

export function subscribeTour(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * React 쪽의 손 — `useSyncExternalStore` 로 세 표면이 같은 걸음에 함께 다시
 * 그려진다(하나가 졸업하면 다음이 그 자리에서 곧바로 선다).
 */
export function useTourStep(): TourStep {
  return useSyncExternalStore(subscribeTour, tourStep, () => "composer" as TourStep);
}
