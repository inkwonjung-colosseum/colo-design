import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import {
  entryScreens,
  entryTitle,
  historyRows,
  revertSummary,
} from "../src/next/lib/revert-summary.ts";

const PREFIX = L.history.commentPrefix;

/** `repo.history` 모양 — 최신이 앞. */
const ENTRIES = [
  { sha: "e", message: "표를 10줄씩 보여 줘", at: "2026-09-25T05:00:00Z" },
  { sha: "d", message: `${PREFIX}검색창을 오른쪽으로`, at: "2026-09-25T04:00:00Z" },
  { sha: "c", message: "등급 필터를 붙여 줘\n\n자세한 말", at: "2026-09-25T03:00:00Z" },
  { sha: "b", message: "회원 목록에 검색창을 넣어 줘", at: "2026-09-25T02:00:00Z" },
  { sha: "a", message: "회원 목록을 만들어 줘", at: "2026-09-25T01:00:00Z" },
];

test("revertSummary — 그 뒤의 차례 수를 센다", () => {
  assert.deepEqual(revertSummary(ENTRIES, 1, PREFIX), { count: 1, withComments: false });
  assert.equal(revertSummary(ENTRIES, 3, PREFIX).count, 3);
  assert.equal(revertSummary(ENTRIES, 4, PREFIX).count, 4);
});

test("revertSummary — 뒤에 코멘트 반영이 있으면 알린다", () => {
  assert.equal(revertSummary(ENTRIES, 1, PREFIX).withComments, false);
  assert.equal(revertSummary(ENTRIES, 2, PREFIX).withComments, true);
  assert.equal(revertSummary(ENTRIES, 4, PREFIX).withComments, true);
});

test("revertSummary — 맨 위(지금)와 범위 밖", () => {
  assert.deepEqual(revertSummary(ENTRIES, 0, PREFIX), { count: 0, withComments: false });
  assert.equal(revertSummary(ENTRIES, 99, PREFIX).count, ENTRIES.length);
  assert.equal(revertSummary([], 2, PREFIX).count, 0);
});

test("revertSummary — 제목 한가운데의 `코멘트 반영` 은 세지 않는다", () => {
  const entries = [{ message: `버튼 문구에서 ${PREFIX}빼 줘` }, { message: "처음" }];
  assert.equal(revertSummary(entries, 1, PREFIX).withComments, false);
});

test("확인 문구 — 제목과 수로 묻는다", () => {
  const { count, withComments } = revertSummary(ENTRIES, 3, PREFIX);
  const text = L.history.confirm(entryTitle(ENTRIES[3]?.message ?? ""), count, withComments);
  assert.match(text, /「회원 목록에 검색창을 넣어 줘」 직후의 화면으로 되돌릴까요\?/);
  assert.match(text, /변경 3가지 \(개발자 코멘트 반영 포함\)/);
  assert.equal(L.history.confirm("t", 1, false).includes("코멘트"), false);
});

test("entryTitle — 첫 줄만", () => {
  assert.equal(entryTitle("등급 필터를 붙여 줘\n\n자세한 말"), "등급 필터를 붙여 줘");
  assert.equal(entryTitle(""), "");
});

test("historyRows — 제출은 그보다 오래된 첫 차례 위에 선다", () => {
  const rows = historyRows(ENTRIES, ["2026-09-25T02:30:00Z"]);
  assert.deepEqual(rows, [
    { kind: "entry", index: 0 },
    { kind: "entry", index: 1 },
    { kind: "entry", index: 2 },
    { kind: "submit", at: "2026-09-25T02:30:00Z" },
    { kind: "entry", index: 3 },
    { kind: "entry", index: 4 },
  ]);
});

test("historyRows — 사이클 밖의 제출은 긋지 않고, 같은 틈의 제출은 하나로 접는다", () => {
  const rows = historyRows(ENTRIES, [
    "2026-09-24T00:00:00Z",
    "2026-09-25T04:10:00Z",
    "2026-09-25T04:40:00Z",
    "not a date",
  ]);
  assert.deepEqual(rows.slice(0, 3), [
    { kind: "entry", index: 0 },
    { kind: "submit", at: "2026-09-25T04:40:00Z" },
    { kind: "entry", index: 1 },
  ]);
  assert.equal(rows.filter((row) => row.kind === "submit").length, 1);
});

test("historyRows — 모든 차례보다 새 제출은 맨 위에 선다", () => {
  const rows = historyRows(ENTRIES, ["2026-09-25T06:00:00Z"]);
  assert.deepEqual(rows[0], { kind: "submit", at: "2026-09-25T06:00:00Z" });
});

test("entryScreens — 차례의 제목(note)으로 짝짓고, 제목 없는 화면은 뺀다", () => {
  const screens = [
    { route: "/member", title: "회원 목록", note: "회원 목록에 검색창을 넣어 줘", at: "x" },
    { route: "/member/1", title: "회원 상세", note: "회원 목록에 검색창을 넣어 줘", at: "x" },
    { route: "/x", title: "", note: "회원 목록에 검색창을 넣어 줘", at: "x" },
    { route: "/member", title: "회원 목록", note: "회원 목록에 검색창을 넣어 줘", at: "y" },
    { route: "/order", title: "주문 목록", note: "다른 말", at: "x" },
  ];
  assert.deepEqual(entryScreens(ENTRIES[3] ?? { message: "" }, screens), [
    "회원 목록",
    "회원 상세",
  ]);
  assert.deepEqual(entryScreens(ENTRIES[0] ?? { message: "" }, screens), []);
  assert.deepEqual(entryScreens(ENTRIES[0] ?? { message: "" }, undefined), []);
});

test("entryScreens — sha 를 실은 화면은 sha 로도 짝짓는다", () => {
  const screens = [{ title: "주문 목록", note: "딴 제목", sha: "e" }];
  assert.deepEqual(entryScreens(ENTRIES[0] ?? { message: "" }, screens), ["주문 목록"]);
});
