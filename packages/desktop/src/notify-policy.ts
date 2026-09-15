import type { DaemonNotice } from "@colo-design/daemon/server";

/**
 * 알림 정책(설정 문서 P0#3)의 결정부. 렌더러의 설정이 여기로 와서, 어떤
 * 순간이 사용자를 부를지 정한다.
 *
 * 규칙은 하나다: **부르는 값이 있는 순간은 언제나 부른다.** 확인 요청·중단·
 * 게이트 실패는 자리를 비운 사람이 돌아와야 하는 이유 그 자체라 시점 설정과
 * 무관하다. 고를 수 있는 것은 `완료`뿐이고, 그마저 기본은 "오래 걸린 턴만" —
 * 30초짜리 수정마다 울리는 알림은 곧 꺼지는 알림이기 때문이다.
 */

/** 완료 알림의 시점: 끔 / 오래 걸린 턴만(기본) / 모든 턴. */
type NoticeTiming = "off" | "long" | "all";

export interface NotificationPrefs {
  done: NoticeTiming;
  sound: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { done: "long", sound: true };

/** "오래 걸린 턴"의 기준 — 웹 경로(daemon-client)와 같은 값이다. */
const LONG_TURN_MS = 60_000;

const TIMINGS: NoticeTiming[] = ["off", "long", "all"];

/** 렌더러가 넘긴 값을 믿지 않는다 — 못 쓰는 값은 기본으로 돌아간다. */
export function normalizeNotificationPrefs(value: unknown): NotificationPrefs {
  if (!value || typeof value !== "object") return { ...DEFAULT_NOTIFICATION_PREFS };
  const stored = value as Partial<NotificationPrefs>;
  return {
    done: TIMINGS.includes(stored.done as NoticeTiming)
      ? (stored.done as NoticeTiming)
      : DEFAULT_NOTIFICATION_PREFS.done,
    sound: typeof stored.sound === "boolean" ? stored.sound : DEFAULT_NOTIFICATION_PREFS.sound,
  };
}

/**
 * 이 순간이 알림이 되는가. 걸린 시간을 모르는 완료는 "오래 걸린" 쪽으로
 * 묶는다 — 알리지 않아 놓치는 쪽이 한 번 더 울리는 쪽보다 비싸다.
 */
export function shouldNotify(notice: DaemonNotice, prefs: NotificationPrefs): boolean {
  if (notice.kind !== "done") return true;
  if (prefs.done === "off") return false;
  if (prefs.done === "all") return true;
  return (notice.durationMs ?? LONG_TURN_MS) >= LONG_TURN_MS;
}
