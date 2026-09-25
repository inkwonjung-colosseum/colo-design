import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { type NotificationPrefs, normalizeNotificationPrefs } from "./notify-policy.js";

/**
 * desktop-settings.json 의 읽고 쓰기 — 경로는 호출자(main)가 넘기므로 이
 * 모듈은 electron 없이 돌아 단위 테스트가 가능하다.
 *
 * 파일은 두 종류의 값을 든다: 창이 없어도 메인이 알아야 하는 값(알림 정책)과
 * 다음 실행이 그대로 잡아야 하는 값(데몬 포트). localStorage 는 origin(포트
 * 포함) 단위라 포트가 실행마다 흔들리면 창의 설정이 전부 초기화된다.
 */

export interface DesktopSettings {
  notifications?: unknown;
  /** 데몬이 지난 실행에 바인드한 포트 — 다음 실행이 같은 자리를 다시 잡는다. */
  port?: unknown;
  /** 앱 배율(⌘= · ⌘- · ⌘0) — 다음 실행이 창과 미리보기 게스트에 다시 건다. */
  zoom?: unknown;
}

export function loadDesktopSettings(path: string): DesktopSettings {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as DesktopSettings) : {};
  } catch {
    return {};
  }
}

/** 읽기-수정-쓰기 — 통째로 덮어쓰면 다른 키(포트)가 알림 갱신마다 지워진다. */
export function saveDesktopSettings(path: string, patch: Partial<DesktopSettings>): void {
  try {
    const temporary = `${path}.colo-design-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ ...loadDesktopSettings(path), ...patch }, null, 2), {
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch {
    // 저장이 안 되면 이번 실행에만 유효하다 — 알림 자체는 계속 나간다.
  }
}

/** 창이 없는 순간에도 알림 정책은 살아 있어야 하므로 부팅 때 한 번 읽는다. */
export function loadNotificationPrefs(path: string): NotificationPrefs {
  return normalizeNotificationPrefs(loadDesktopSettings(path).notifications);
}

/** 지난 실행이 저장한 데몬 포트 — 손으로 고친 값도 읽히므로 범위를 본다. */
export function loadStoredPort(path: string): number | null {
  const port = loadDesktopSettings(path).port;
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535
    ? port
    : null;
}
