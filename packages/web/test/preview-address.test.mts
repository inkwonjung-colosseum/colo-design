/**
 * 주소창 판정의 표 — preview-address.test 에서 node --test 로.
 * 순수 함수라 시뮬레이션 없이 표 그대로 단언한다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAddress } from "../src/lib/preview-address.ts";

const opts = {
  origin: "http://127.0.0.1:5400",
  currentPath: "/member/MemberList",
};

test("a path inside the origin is an open target", () => {
  assert.deepEqual(parseAddress("/member/MemberList", opts), {
    kind: "path",
    path: "/member/MemberList",
  });
  // 쿼리는 경로의 일부로 그대로 실린다 — 특별한 취급을 받는 키는 더
  // 없다(2026-09-21 상태 축 철거).
  assert.deepEqual(parseAddress("/member/MemberList?after=2026-09-01", opts), {
    kind: "path",
    path: "/member/MemberList?after=2026-09-01",
  });
});

test("a path without the leading slash gets one", () => {
  assert.deepEqual(parseAddress("member/MemberDetail", opts), {
    kind: "path",
    path: "/member/MemberDetail",
  });
  assert.deepEqual(parseAddress("member/MemberDetail?after=2026-09-01", opts), {
    kind: "path",
    path: "/member/MemberDetail?after=2026-09-01",
  });
});

test("a lone ?query rides the current path", () => {
  assert.deepEqual(parseAddress("?after=2026-09-21", opts), {
    kind: "path",
    path: "/member/MemberList?after=2026-09-21",
  });
  // 지금 주소에 이미 쿼리가 있으면 lone query 가 그 자리를 대신한다 —
  // 이어붙이기가 아니라 경로에 대한 하나의 쿼리다.
  assert.deepEqual(
    parseAddress("?after=2026-09-21", {
      origin: opts.origin,
      currentPath: "/member/MemberList?after=2026-09-01",
    }),
    {
      kind: "path",
      path: "/member/MemberList?after=2026-09-21",
    },
  );
});

test("an absolute url of the preview origin reduces to its path", () => {
  assert.deepEqual(
    parseAddress("http://127.0.0.1:5400/member/MemberList?after=2026-09-01", opts),
    {
      kind: "path",
      path: "/member/MemberList?after=2026-09-01",
    },
  );
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
  assert.deepEqual(parseAddress("  /member/MemberList  ", opts), {
    kind: "path",
    path: "/member/MemberList",
  });
  assert.equal(parseAddress("   ", opts).kind, "error");
});
