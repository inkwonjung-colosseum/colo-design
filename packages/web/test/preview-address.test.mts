/**
 * 주소창 판정의 표 — preview-address.test 에서 node --test 로.
 * 순수 함수라 시뮬레이션 없이 표 그대로 단언한다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAddress, splitPath } from "../src/lib/preview-address.ts";

const opts = {
  origin: "http://127.0.0.1:5400",
  currentPath: "/member/MemberList?state=empty",
  routes: ["/member/MemberList", "/member/MemberDetail"],
};

test("declared route (+state) becomes a screen target", () => {
  assert.deepEqual(parseAddress("/member/MemberList", opts), {
    kind: "screen",
    route: "/member/MemberList",
    state: null,
  });
  assert.deepEqual(parseAddress("/member/MemberList?state=empty", opts), {
    kind: "screen",
    route: "/member/MemberList",
    state: "empty",
  });
});

test("a route without the leading slash gets one", () => {
  assert.deepEqual(parseAddress("member/MemberDetail", opts), {
    kind: "screen",
    route: "/member/MemberDetail",
    state: null,
  });
});

test("a lone ?state= applies to the current path", () => {
  assert.deepEqual(parseAddress("?state=error", opts), {
    kind: "screen",
    route: "/member/MemberList",
    state: "error",
  });
});

test("any other path inside the origin is an open target", () => {
  assert.deepEqual(parseAddress("/docs/guide", opts), {
    kind: "path",
    path: "/docs/guide",
  });
  assert.deepEqual(parseAddress("docs/guide?page=2", opts), {
    kind: "path",
    path: "/docs/guide?page=2",
  });
});

test("an absolute url of the preview origin reduces to its path", () => {
  assert.deepEqual(parseAddress("http://127.0.0.1:5400/member/MemberList?state=empty", opts), {
    kind: "screen",
    route: "/member/MemberList",
    state: "empty",
  });
});

test("another origin, protocol-relative and scheme urls are refused", () => {
  for (const input of [
    "https://example.com",
    "//example.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "http://localhost:5400/",
  ]) {
    assert.equal(parseAddress(input, opts).kind, "error", input);
  }
});

test("whitespace is trimmed; empty input says so", () => {
  assert.deepEqual(parseAddress("  /member/MemberList  ", opts).kind, "screen");
  assert.equal(parseAddress("   ", opts).kind, "error");
});

test("splitPath separates route and state", () => {
  assert.deepEqual(splitPath("/a/B?state=x&other=1"), {
    route: "/a/B",
    state: "x",
  });
  assert.deepEqual(splitPath("/a/B"), { route: "/a/B", state: null });
  assert.deepEqual(splitPath("/a/B?state="), { route: "/a/B", state: null });
});
