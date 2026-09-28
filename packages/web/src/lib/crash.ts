import { useSyncExternalStore } from "react";

/**
 * 크래시 방어의 순수 심장(PLAN-CRASH-PROCESS 3.A 층 2 · P-1 · P-2). DOM 없이
 * 시험되게 `storage` 와 `now` 를 주입받는다 — 이 모듈은 기록만 남기고 화면을
 * 절대 바꾸지 않는다. 전면 안내판을 세우는 판정은 `source === "render"` 하나
 * (CrashScreen) — 전역 오류(error · unhandledrejection · boot)는 화면이 살아
 * 있으므로 덮는 것이 유일하게 새로 생기는 피해다.
 *
 * 저장 키는 `lib/settings.ts` 의 `nova-design.*` 규칙을 따른다. 미러
 * (`nova-design.last-crash`)는 번들 밖의 와치독(public/boot-watchdog.js)이
 * 다음 부팅의 안내줄로 읽는, 죽은 프로세스에서 살아남는 유일한 기록이다.
 */

export type CrashSource = "render" | "error" | "unhandledrejection" | "boot";

/** 하나의 사고 기록 — 미러와 링이 같은 모양을 공유한다. */
export interface CrashReport {
  source: CrashSource;
  message: string;
  stack?: string;
  componentStack?: string;
  appVersion?: string;
  time: number;
}

/** publish 에 들어가는 몸 — 시각은 저장소가 찍는다. */
export type CrashInput = Omit<CrashReport, "time">;

/** 주입받는 저장소 — `localStorage` 가 구조적으로 만족한다. */
export interface CrashStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const MIRROR_KEY = "nova-design.last-crash";
/** 링 상한 — 하루치 전역 오류라도 최근 20개면 문맥에 충분하다. */
export const RING_LIMIT = 20;
/** 같은 서명의 재연송(스트림이 한 오류를 여러 번 흘리는 경우)을 접는 창. */
export const DEDUPE_MS = 2_000;
/** 마운트 뒤 미러를 비우기까지 — 층 2 의 즉시 사고가 기록을 남길 여유. */
export const MIRROR_CLEAR_MS = 10_000;

/**
 * 양성 접두 — 브라우저가 이유 없이 반복해서 흘리는 소음. 링에만 남고
 * `latest` 도 미러도 안 건드린다: 이것들 때문에 화면이 죽은 적은 없다.
 */
const BENIGN_PREFIXES = [
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop limit exceeded",
  "Script error",
] as const;

export interface CrashStore {
  publish(input: CrashInput): void;
  latest(): CrashReport | null;
  ring(): readonly CrashReport[];
  /** 미러를 비운다 — `mountedAt` 가 주어지면 그보다 낡은 기록만. */
  clearMirror(mountedAt?: number): void;
  subscribe(listener: () => void): () => void;
  now(): number;
}

export function createCrashStore(opts: { storage: CrashStorage; now?: () => number }): CrashStore {
  const storage = opts.storage;
  const now = opts.now ?? Date.now;
  const ring: CrashReport[] = [];
  const benignSeen = new Set<string>();
  const listeners = new Set<() => void>();
  let latestReport: CrashReport | null = null;
  let lastRecorded: { signature: string; at: number } | null = null;

  return {
    now,

    publish(input) {
      const signature = `${input.source}+${input.message}`;
      const at = now();
      if (
        lastRecorded &&
        lastRecorded.signature === signature &&
        at - lastRecorded.at < DEDUPE_MS
      ) {
        return;
      }
      const report: CrashReport = { ...input, time: at };
      if (BENIGN_PREFIXES.some((prefix) => input.message.startsWith(prefix))) {
        // 이미 남긴 양성 서명은 다시 안 남긴다 — 소음이 링을 밀지 않게.
        if (benignSeen.has(signature)) return;
        benignSeen.add(signature);
        ring.push(report);
        if (ring.length > RING_LIMIT) ring.shift();
        return;
      }
      lastRecorded = { signature, at };
      ring.push(report);
      if (ring.length > RING_LIMIT) ring.shift();
      latestReport = report;
      try {
        storage.setItem(MIRROR_KEY, JSON.stringify(report));
      } catch {
        // 저장이 막혀 있어도 이번 실행의 기록은 산다 — 미러는 다음 부팅의 안내일 뿐.
      }
      for (const listener of listeners) listener();
    },

    latest: () => latestReport,
    ring: () => ring,

    clearMirror(mountedAt) {
      try {
        if (mountedAt === undefined) {
          storage.removeItem(MIRROR_KEY);
          return;
        }
        const stored = readLastCrash(storage);
        // 마운트 뒤에 남은 새 사고는 다음 부팅의 문맥이므로 지우지 않는다.
        if (!stored || stored.time <= mountedAt) storage.removeItem(MIRROR_KEY);
      } catch {
        // 위와 같은 이유 — 저장 실패가 실행을 막아서는 안 된다.
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 저장된 미러를 읽는다 — 손상된 블롭은 없는 것으로 한다(와치독도 같은 판정). */
export function readLastCrash(storage: CrashStorage): CrashReport | null {
  try {
    const raw = storage.getItem(MIRROR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CrashReport> | null;
    if (
      !parsed ||
      typeof parsed.source !== "string" ||
      typeof parsed.message !== "string" ||
      typeof parsed.time !== "number"
    ) {
      return null;
    }
    return parsed as CrashReport;
  } catch {
    return null;
  }
}

/** 에러에서 리포트만 만드는 순수 판정 — 경계의 getDerivedStateFromError 가 쓴다. */
export function createReport(
  source: CrashSource,
  error: unknown,
  now: () => number = Date.now,
): CrashReport {
  return {
    source,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    time: now(),
  };
}

/**
 * 렌더 예외를 경계가 받았다는 신호 — 와치독이 자기 판을 덮어 쓰지 않게
 * 한다. 번들이 살아서 화면을 이미 쥔 이상, 안내판의 주인은 React 다
 * (마운트 신호와 같은 dataset 자리를 와치독이 본다).
 */
export function markAppCrashed(): void {
  document.documentElement.dataset.appCrashed = "1";
}

/**
 * 부팅 성공 신호(3.A 층 1-2) — 와치독의 타이머를 끄는 dataset 을 세우고,
 * 10초 뒤 낡은 미러를 비운다(방금 성공한 부팅이 지난사고를 다음 부팅의
 * 안내판에 보이지 않게). 시험은 `doc` 와 `schedule` 을 주입한다.
 */
export function markAppMounted(
  store: CrashStore,
  opts: {
    doc?: { documentElement: { dataset: Record<string, string> } };
    schedule?: (callback: () => void, delayMs: number) => void;
  } = {},
): void {
  const doc = opts.doc ?? document;
  const mountedAt = store.now();
  doc.documentElement.dataset.appMounted = "1";
  const schedule = opts.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  schedule(() => store.clearMirror(mountedAt), MIRROR_CLEAR_MS);
}

/**
 * 전역 오류를 저장소에 흘린다(P-2) — **화면을 바꾸지 않는다.** `error` 는
 * `source: "error"`, `unhandledrejection` 은 그 이름으로. 되돌리는 함수를 준다.
 */
export function installGlobalHandlers(
  target: {
    addEventListener(
      type: "error" | "unhandledrejection",
      listener: (event: ErrorEvent | PromiseRejectionEvent) => void,
    ): void;
    removeEventListener(
      type: "error" | "unhandledrejection",
      listener: (event: ErrorEvent | PromiseRejectionEvent) => void,
    ): void;
  },
  store: CrashStore,
): () => void {
  const onGlobalError = (event: ErrorEvent | PromiseRejectionEvent): void => {
    if ("message" in event) {
      store.publish({
        source: "error",
        message: event.message,
        stack: event.error instanceof Error ? event.error.stack : undefined,
      });
      return;
    }
    const reason = event.reason;
    store.publish({
      source: "unhandledrejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };
  target.addEventListener("error", onGlobalError);
  target.addEventListener("unhandledrejection", onGlobalError);
  return () => {
    target.removeEventListener("error", onGlobalError);
    target.removeEventListener("unhandledrejection", onGlobalError);
  };
}

/** 최신 사고를 구독하는 갈고리 — 전면 판정(`source === "render"`)은 받는 쪽이 한다. */
export function useLatestCrash(store: CrashStore): CrashReport | null {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.latest(),
    () => null,
  );
}

let defaultStore: CrashStore | null = null;

/** 브라우저의 하나뿐인 저장소 — 시험이 가짜를 만들 때는 createCrashStore 로. */
export function crashStore(): CrashStore {
  defaultStore ??= createCrashStore({ storage: window.localStorage });
  return defaultStore;
}
