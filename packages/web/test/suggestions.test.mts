import assert from "node:assert/strict";
import { test } from "node:test";
import type { ColoDesignScreen } from "../../protocol/src/index.ts";
import { GENERIC_STARTERS, suggestionsFromScreens } from "../src/suggestions.ts";

const screen = (title: string, states: string[] = ["default"]): ColoDesignScreen => ({
  route: `/s/${encodeURIComponent(title)}`,
  title,
  states,
  spec: null,
});

test("a repo that declares nothing keeps the generic sentences", () => {
  assert.deepEqual(suggestionsFromScreens([]), GENERIC_STARTERS);
});

test("the first declared screen names itself in the first chip", () => {
  const out = suggestionsFromScreens([screen("회원 관리"), screen("결제 목록")]);
  assert.equal(out[0], "「회원 관리」화면을 만들어 줘");
});

test("a screen with a non-default state borrows the state sentence", () => {
  const out = suggestionsFromScreens([
    screen("회원 관리"),
    screen("회원 목록", ["default", "empty"]),
  ]);
  assert.ok(out.includes("「회원 목록」에 빈 상태와 오류 상태를 추가해 줘"), out.join(" / "));
});

test("a second screen borrows the polish sentence", () => {
  const out = suggestionsFromScreens([screen("회원 관리"), screen("결제 목록")]);
  assert.ok(
    out.some((line) => line.includes("「결제 목록」")),
    out.join(" / "),
  );
});

test("nameless screens read as nothing declared", () => {
  assert.deepEqual(suggestionsFromScreens([screen("  ")]), GENERIC_STARTERS);
});

test("three chips at most — the tape is an invitation, not a menu", () => {
  const out = suggestionsFromScreens([
    screen("화면1"),
    screen("화면2"),
    screen("화면3", ["default", "error"]),
    screen("화면4"),
    screen("화면5"),
  ]);
  assert.ok(out.length <= 3, out.join(" / "));
});
