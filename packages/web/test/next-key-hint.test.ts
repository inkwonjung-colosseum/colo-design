import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-connection-copy.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import { keyHint } from "../src/next/lib/key-hint.ts";

test("keyHint: mac 이면 문장 그대로다", () => {
  assert.equal(keyHint("⌘⇧P", true), "⌘⇧P");
  assert.equal(keyHint(L.preview.pinTip, true), L.preview.pinTip);
});

test("keyHint: mac 이 아니면 글리프가 키 이름이 된다", () => {
  assert.equal(keyHint("⌘T", false), "Ctrl+T");
  assert.equal(keyHint("⌘K", false), "Ctrl+K");
  assert.equal(keyHint("⌘⇧P", false), "Ctrl+Shift+P");
  assert.equal(keyHint("⌘↵", false), "Ctrl+↵");
  assert.equal(keyHint("⇧↵", false), "Shift+↵");
  assert.equal(keyHint("⌘,", false), "Ctrl+,");
});

test("keyHint: 문장 속의 표기만 바뀌고 나머지 글자는 그대로다", () => {
  assert.equal(
    keyHint("화면에서 고칠 곳 찍기 · ⌘⇧P", false),
    "화면에서 고칠 곳 찍기 · Ctrl+Shift+P",
  );
  assert.equal(
    keyHint("수정할 곳 찍기 · ⌘⇧P · option(⌥)+클릭은 언제든", false),
    "수정할 곳 찍기 · Ctrl+Shift+P · Alt+클릭은 언제든",
  );
});

test("keyHint: 글리프가 없는 문장은 어느 컴퓨터에서나 그대로다", () => {
  assert.equal(keyHint("보내기 · ↵", false), "보내기 · ↵");
  assert.equal(keyHint("", false), "");
});
