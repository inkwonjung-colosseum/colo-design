import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-crash.test.ts 와 같은 모양).
import { copyLegacyStorageKeys } from "../src/lib/storage-migration.ts";

/** 가짜 Storage — 맵을 감싸 키 순회(length · key)까지 진짜처럼 움직인다. */
function fakeStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    key: (index: number) => [...map.keys()][index] ?? null,
  };
}

test("storage-migration: 옛 키만 있으면 같은 접미의 새 키로 값을 옮긴다", () => {
  const store = fakeStorage({
    "colo-design.settings": "다크", // read-legacy
    "colo-design.daemon-url": "http://127.0.0.1:29170", // read-legacy
    "colo-design.last-crash": "oom", // read-legacy
  });
  const copied = copyLegacyStorageKeys(store);
  assert.equal(copied, 3);
  assert.equal(store.getItem("nova-design.settings"), "다크");
  assert.equal(store.getItem("nova-design.daemon-url"), "http://127.0.0.1:29170");
  assert.equal(store.getItem("nova-design.last-crash"), "oom");
});

test("storage-migration: 새 키가 이미 있으면 덮어쓰지 않는다", () => {
  const store = fakeStorage({
    "colo-design.settings": "옛 값", // read-legacy
    "colo-design.last-crash": "옛 사고", // read-legacy
    "nova-design.settings": "새 값",
  });
  const copied = copyLegacyStorageKeys(store);
  assert.equal(copied, 1); // 비어 있는 last-crash 접미만 옮겼다
  assert.equal(store.getItem("nova-design.settings"), "새 값");
  assert.equal(store.getItem("nova-design.last-crash"), "옛 사고");
});

test("storage-migration: 옛 접두 밖의 키는 건드리지 않는다", () => {
  const store = fakeStorage({
    "colo-site-theme": "dark", // 접두가 비슷해도 옛 접두가 아니다 // read-legacy
    "colo-designx.settings": "x", // read-legacy — 점까지 같아야 옛 키다
    "another-app.key": "y",
  });
  const copied = copyLegacyStorageKeys(store);
  assert.equal(copied, 0);
  assert.equal(store.length, 3); // 하나도 늘지 않았다
  assert.equal(store.getItem("colo-site-theme"), "dark"); // read-legacy
  assert.equal(store.getItem("colo-designx.settings"), "x"); // read-legacy
  assert.equal(store.getItem("another-app.key"), "y");
});

test("storage-migration: 옛 키는 지우지 않고 남긴다", () => {
  const store = fakeStorage({ "colo-design.settings": "옛 값" }); // read-legacy
  copyLegacyStorageKeys(store);
  assert.equal(store.getItem("colo-design.settings"), "옛 값"); // read-legacy — 되돌려 깐 옛 앱을 위해서
  assert.equal(store.getItem("nova-design.settings"), "옛 값");
  assert.equal(store.length, 2); // 옛 키와 새 키가 나란히 산다
});
