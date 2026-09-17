/**
 * `앱에서 링크 열기`의 라우팅 — 설정이 켜지고 데스크톱 칸이 있을 때만 링크가
 * 미리보기 칸으로 가고, 그 외(끔·브라우저·수식 키·비 http)는 OS 브라우저의
 * 평소 길을 탄다. 칸에 자리가 없을 때의 OS 폴백은 데스크톱 쪽의 일이다.
 *
 * Run: node --experimental-transform-types --test packages/web/test/open-link.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// The module under test reads localStorage and window at click time — stub
// both before it loads.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

const paneOpened: string[] = [];
const osOpened: string[] = [];
let bridge: { openExternal: (url: string) => Promise<unknown> } | undefined = {
  openExternal: (url: string) => {
    paneOpened.push(url);
    return Promise.resolve({ ok: true });
  },
};
(globalThis as Record<string, unknown>).window = {
  get coloDesignDesktop() {
    return bridge ? { preview: bridge } : undefined;
  },
  open: (url: string) => {
    osOpened.push(url);
  },
};

const { openLink, linkClick } = await import("../src/lib/open-link.ts");

const setInApp = (on: boolean) =>
  store.set("colo-design.settings", JSON.stringify({ openLinksInApp: on }));

const reset = () => {
  paneOpened.length = 0;
  osOpened.length = 0;
};

const click = (href: string, init: Record<string, unknown> = {}) => {
  let prevented = false;
  linkClick({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    currentTarget: { getAttribute: () => href },
    preventDefault: () => {
      prevented = true;
    },
    ...init,
  } as never);
  return prevented;
};

test("꺼진 설정은 OS 브라우저가 연다", () => {
  reset();
  setInApp(false);
  openLink("https://example.com/a");
  assert.deepEqual(paneOpened, []);
  assert.deepEqual(osOpened, ["https://example.com/a"]);
});

test("켜진 설정 + 데스크톱 칸은 칸이 연다", () => {
  reset();
  setInApp(true);
  openLink("https://example.com/b");
  assert.deepEqual(paneOpened, ["https://example.com/b"]);
  assert.deepEqual(osOpened, []);
});

test("켜져도 다리가 없으면(plain 브라우저) OS 브라우저가 연다", () => {
  reset();
  setInApp(true);
  bridge = undefined;
  openLink("https://example.com/c");
  assert.deepEqual(paneOpened, []);
  assert.deepEqual(osOpened, ["https://example.com/c"]);
  bridge = { openExternal: (url) => (paneOpened.push(url), Promise.resolve({ ok: true })) };
});

test("앵커 클릭: 켜진 설정은 기본 동작을 막고 칸이 연다", () => {
  reset();
  setInApp(true);
  const prevented = click("https://github.com/o/r/pull/1");
  assert.equal(prevented, true);
  assert.deepEqual(paneOpened, ["https://github.com/o/r/pull/1"]);
});

test("수식 키 클릭은 새 창 의도 — 건드리지 않는다", () => {
  reset();
  setInApp(true);
  const prevented = click("https://example.com", { metaKey: true });
  assert.equal(prevented, false);
  assert.deepEqual(paneOpened, []);
});

test("http(s) 가 아닌 href 는 건드리지 않는다", () => {
  reset();
  setInApp(true);
  assert.equal(click("mailto:a@b.c"), false);
  assert.equal(click("#section"), false);
  assert.deepEqual(paneOpened, []);
});

test("꺼진 설정의 앵커 클릭은 브라우저의 평소 길을 탄다", () => {
  reset();
  setInApp(false);
  assert.equal(click("https://example.com"), false);
  assert.deepEqual(paneOpened, []);
});
