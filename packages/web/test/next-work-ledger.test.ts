import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeveloperReview, RepoHistoryEntry } from "@colo-design/protocol";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import {
  clockParts,
  commentCount,
  commentRows,
  cycleStart,
  outgoingScreens,
  outsideChanges,
} from "../src/next/lib/work-ledger.ts";

const screen = (route: string, title: string, note: string, at: string) => ({
  route,
  title,
  note,
  at,
});
const entry = (message: string, at: string): RepoHistoryEntry => ({
  sha: at,
  message,
  at,
  files: [],
});
const review = (id: number, body: string, at: string): DeveloperReview => ({
  id,
  kind: "review",
  author: "dev1",
  body,
  pr: 7,
  at,
});

// 데몬의 순서(최근 커밋부터) · git 의 시각 표기(+09:00).
const SCREENS = [
  screen("/member/list", "회원 목록", "페이지 번호 넣어 줘", "2026-09-25T12:00:00+09:00"),
  screen("/", "", "로고만 바꿔 줘", "2026-09-25T11:30:00+09:00"),
  screen("/member/list", "회원 목록", "표로 보여 줘", "2026-09-25T11:00:00+09:00"),
  screen("/member/detail", "회원 상세", "상세 화면 만들어 줘", "2026-09-25T10:00:00+09:00"),
];

test("보낼 화면 — 화면마다 한 줄, 가장 최근의 말, 제목 없는 화면은 빠진다", () => {
  const out = outgoingScreens(SCREENS, null);
  assert.deepEqual(
    out.map((s) => [s.route, s.note]),
    [
      ["/member/list", "페이지 번호 넣어 줘"],
      ["/member/detail", "상세 화면 만들어 줘"],
    ],
  );
  assert.deepEqual(outgoingScreens(undefined, null), []);
});

test("열린 요청에 더할 때 — 마지막 제출(UTC) 뒤의 화면만", () => {
  // 02:30Z = 11:30+09:00 — 12:00 의 회원 목록만 그 뒤다.
  const out = outgoingScreens(SCREENS, "2026-09-25T02:30:00Z");
  assert.deepEqual(
    out.map((s) => s.title),
    ["회원 목록"],
  );
});

test("화면 밖 변경 — 화면 목록에 서지 않은 차례를 센다", () => {
  const history = [
    entry("페이지 번호 넣어 줘", "2026-09-25T12:00:00+09:00"),
    entry("글꼴 정리해 줘", "2026-09-25T11:45:00+09:00"),
    entry("로고만 바꿔 줘", "2026-09-25T11:30:00+09:00"),
    entry("표로 보여 줘", "2026-09-25T11:00:00+09:00"),
    entry("상세 화면 만들어 줘", "2026-09-25T10:00:00+09:00"),
  ];
  // 글꼴(목록에 없음) · 로고(제목 없는 화면만) 둘.
  assert.equal(outsideChanges(history, SCREENS, null), 2);
  assert.equal(outsideChanges(history, SCREENS, "2026-09-25T02:40:00Z"), 1);
  assert.equal(outsideChanges(null, SCREENS, null), 0);
  assert.equal(outsideChanges(history, undefined, null), 5);
});

test("코멘트 장부 — 뒤에 코멘트 반영 차례가 있으면 반영됨, 없으면 고치는 중", () => {
  const reviews = [
    review(1, "버튼 색을\n  바꿔 주세요", "2026-09-25T03:00:00Z"),
    review(2, "", "2026-09-25T03:05:00Z"),
    review(3, "제목 글자가 커요", "2026-09-25T04:00:00Z"),
  ];
  const history = [
    entry(`${L.work.reflectionPrefix}버튼 색을 바꿔 주세요`, "2026-09-25T12:30:00+09:00"),
    entry("다른 말", "2026-09-25T13:30:00+09:00"),
  ];
  const rows = commentRows(reviews, history, {
    merged: false,
    reflectionPrefix: L.work.reflectionPrefix,
  });
  assert.deepEqual(
    rows.map((r) => [r.id, r.text, r.state]),
    [
      [3, "제목 글자가 커요", "fixing"],
      [1, "버튼 색을 바꿔 주세요", "done"],
    ],
  );
  assert.equal(commentCount(reviews), 2);
  const merged = commentRows(reviews, null, { merged: true, reflectionPrefix: "x" });
  assert.ok(merged.every((r) => r.state === "done"));
});

test("시작일 · 시각 한 칸", () => {
  assert.equal(cycleStart(SCREENS, [entry("a", "2026-09-24T23:00:00Z")]), "2026-09-24T23:00:00Z");
  assert.equal(cycleStart(undefined, null), null);
  const now = new Date(2026, 8, 25, 18, 0);
  const today = clockParts(new Date(2026, 8, 25, 9, 5).toISOString(), now);
  assert.deepEqual(today, { today: true, hhmm: "09:05", month: 9, day: 25 });
  assert.equal(clockParts(new Date(2026, 8, 24, 9, 5).toISOString(), now)?.today, false);
  assert.equal(clockParts("아님", now), null);
  assert.equal(L.work.time(false, "09:05", 9, 24), "9월 24일 09:05");
  assert.equal(
    L.work.headerSub("회원 관리", "9월 25일", L.work.subDraft),
    "회원 관리 · 9월 25일부터 · 이 컴퓨터에 보관돼 있어요",
  );
});
