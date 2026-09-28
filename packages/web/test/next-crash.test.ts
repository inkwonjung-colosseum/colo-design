import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import {
  MIRROR_CLEAR_MS,
  createCrashStore,
  installGlobalHandlers,
  markAppMounted,
  readLastCrash,
  type CrashStorage,
} from "../src/lib/crash.ts";

/** 주입하는 시계 — 시험 시간을 접는다. */
function fakeClock(): { now: () => number; tick: (ms: number) => void } {
  let at = 0;
  return { now: () => at, tick: (ms: number) => (at += ms) };
}

function memoryStorage(): CrashStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

test("crash: 같은 서명은 2초 창 안에서 한 번만 남는다", () => {
  const clock = fakeClock();
  const store = createCrashStore({ storage: memoryStorage(), now: clock.now });
  const burst = { source: "error" as const, message: "요청이 실패했다" };
  store.publish(burst);
  clock.tick(1_000);
  store.publish(burst);
  assert.equal(store.ring().length, 1);
  clock.tick(1_500); // 마지막으로 남긴 시각(0ms)에서 2.5초 — 창 밖
  store.publish(burst);
  assert.equal(store.ring().length, 2);
});

test("crash: 양성 접두는 링에만 남고 latest · 미러에는 안 남는다", () => {
  const storage = memoryStorage();
  const store = createCrashStore({ storage, now: () => 0 });
  store.publish({
    source: "error",
    message: "ResizeObserver loop completed with undelivered notifications.",
  });
  store.publish({ source: "error", message: "ResizeObserver loop limit exceeded" });
  store.publish({ source: "error", message: "Script error." });
  store.publish({ source: "error", message: "Script error." }); // 같은 양성 서명은 링을 밀지 않는다
  assert.equal(store.ring().length, 3);
  assert.equal(store.latest(), null);
  assert.equal(readLastCrash(storage), null);
});

test("crash: 링은 20개를 넘지 않는다 — 오래된 것이 밀린다", () => {
  const store = createCrashStore({ storage: memoryStorage(), now: () => 0 });
  for (let index = 0; index < 25; index += 1) {
    store.publish({ source: "error", message: `사고 ${index}` });
  }
  const ring = store.ring();
  assert.equal(ring.length, 20);
  assert.equal(ring[0]?.message, "사고 5");
  assert.equal(ring[19]?.message, "사고 24");
});

test("crash: unhandledrejection 은 전면 대상이 아니다 — latest.source 가 render 가 아니다", () => {
  const store = createCrashStore({ storage: memoryStorage(), now: () => 0 });
  const listeners = new Map<string, (event: unknown) => void>();
  installGlobalHandlers(
    {
      addEventListener: (type, listener) => void listeners.set(type, listener),
      removeEventListener: (type) => void listeners.delete(type),
    },
    store,
  );
  listeners.get("unhandledrejection")?.({ reason: new Error("거절당한 약속") });
  assert.equal(store.latest()?.source, "unhandledrejection");
  assert.notEqual(store.latest()?.source, "render");
});

test("crash: 미러는 왕복한다 — 쓴 것을 readLastCrash 가 그대로 읽는다", () => {
  const storage = memoryStorage();
  const store = createCrashStore({ storage, now: () => 1_234 });
  const error = new Error("화면이 깨졌다");
  store.publish({
    source: "render",
    message: error.message,
    stack: error.stack,
    componentStack: " at App\n at Crash",
  });
  assert.deepEqual(readLastCrash(storage), store.latest());
});

test("crash: markAppMounted 는 10초 뒤 낡은 미러만 비운다", () => {
  const storage = memoryStorage();
  const clock = fakeClock();
  const store = createCrashStore({ storage, now: clock.now });
  store.publish({ source: "boot", message: "renderer oom" }); // 마운트 전의 낡은 기록
  const dataset: Record<string, string> = {};
  let sweep: (() => void) | null = null;
  const delays: number[] = [];
  markAppMounted(store, {
    doc: { documentElement: { dataset } },
    schedule: (callback, delayMs) => {
      sweep = callback;
      delays.push(delayMs);
    },
  });
  assert.equal(dataset.appMounted, "1");
  assert.deepEqual(delays, [MIRROR_CLEAR_MS]); // 문서가 말하는 10초
  sweep?.();
  assert.equal(readLastCrash(storage), null); // 방금 성공한 부팅은 낡은 기록을 다음 부팅에 보이지 않게
  clock.tick(50);
  store.publish({ source: "render", message: "마운트 뒤의 사고" }); // 이 기록은 다음 부팅의 문맥이다
  sweep?.(); // 같은 판정을 다시 — 새 사고는 살아 남는다
  assert.equal(readLastCrash(storage)?.message, "마운트 뒤의 사고");
});
