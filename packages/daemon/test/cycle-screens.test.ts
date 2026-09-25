// PLAN-UI U2 · P2 의 순수 시험 — 바뀐 화면(cycleScreens)의 파생. 지도 행의
// 경로 · 제목 고르기(screensOfTurn), git log 읽기, 커밋 × 화면의 목록.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deriveCycleScreens,
  parseCycleLog,
  readHeadSha,
  screenPathOf,
  screensOfTurn,
} from "../dist/cycle-screens.js";

const ORIGIN = "http://127.0.0.1:5274";

test("screenPathOf — 미리보기의 주소와 핀의 화면 id 를 같은 경로로", () => {
  assert.equal(screenPathOf(`${ORIGIN}/member/list/`, ORIGIN), "/member/list");
  assert.equal(screenPathOf(`${ORIGIN}/member/list?tab=2#x`, ORIGIN), "/member/list?tab=2");
  assert.equal(screenPathOf("member/list", ORIGIN), "/member/list");
  assert.equal(screenPathOf("index", ORIGIN), "/");
  assert.equal(
    screenPathOf("https://docs.example.com/guide", ORIGIN),
    null,
    "외부 주소는 화면이 아니다",
  );
  assert.equal(
    screenPathOf("http://127.0.0.1:9999/other", ORIGIN),
    null,
    "다른 서버는 화면이 아니다",
  );
  // 서버를 모르면(꺼진 순간의 저장) 이 기계의 주소만 받는다.
  assert.equal(screenPathOf("http://localhost:3000/a", null), "/a");
  assert.equal(screenPathOf("https://example.com/a", null), null);
});

test("screensOfTurn — 답변 링크의 제목을 입히고 같은 화면은 한 번", () => {
  const answer =
    "회원 목록을 고쳤어요 — [**회원 목록**](http://127.0.0.1:5274/member/list). 참고: [문서](https://docs.example.com)";
  assert.deepEqual(
    screensOfTurn(
      [`${ORIGIN}/member/list`, "member/list", "https://docs.example.com", `${ORIGIN}/coupon`],
      answer,
      ORIGIN,
    ),
    [
      { route: "/member/list", title: "회원 목록" },
      { route: "/coupon", title: "" },
    ],
  );
});

test("parseCycleLog — sha · 제목 · 시각", () => {
  const out =
    "a1\x1f검색창을 넣어 줘\x1f2026-09-25T10:00:00+09:00\nb2\x1f버튼 색\x1f2026-09-25T09:00:00+09:00\n";
  assert.deepEqual(parseCycleLog(out), [
    { sha: "a1", subject: "검색창을 넣어 줘", at: "2026-09-25T10:00:00+09:00" },
    { sha: "b2", subject: "버튼 색", at: "2026-09-25T09:00:00+09:00" },
  ]);
  assert.deepEqual(parseCycleLog(""), []);
});

test("deriveCycleScreens — 최근 커밋부터, 화면 없는 커밋은 빠지고 빈 제목은 빌린다", () => {
  const commits = [
    { sha: "c3", subject: "쿠폰 화면도", at: "T3" },
    { sha: "c2", subject: "README 고쳐 줘", at: "T2" },
    { sha: "c1", subject: "회원 목록에 검색창", at: "T1" },
  ];
  const rows = [
    // 사이클 밖(베이스)의 옛 행 — 제목의 출처로만 쓰인다.
    {
      at: "T0",
      sha: "old",
      routes: [],
      files: [],
      screens: [{ route: "/coupon", title: "쿠폰 발급" }],
    },
    {
      at: "T1",
      sha: "c1",
      routes: [`${ORIGIN}/member/list`],
      files: ["a.tsx"],
      screens: [{ route: "/member/list", title: "회원 목록" }],
    },
    {
      at: "T3",
      sha: "c3",
      routes: [],
      files: ["b.tsx"],
      screens: [
        { route: "/coupon", title: "" },
        { route: "/mystery", title: "" },
      ],
    },
  ];
  assert.deepEqual(deriveCycleScreens(commits, rows), [
    { route: "/coupon", title: "쿠폰 발급", note: "쿠폰 화면도", at: "T3" },
    { route: "/member/list", title: "회원 목록", note: "회원 목록에 검색창", at: "T1" },
  ]);
});

test("deriveCycleScreens — screens 가 없는 옛 행은 routes 를 읽고 제목을 빌린다", () => {
  const rows = [
    {
      at: "T0",
      sha: "t",
      routes: [],
      files: [],
      screens: [{ route: "/member/list", title: "회원 목록" }],
    },
    { at: "T1", sha: "legacy", routes: ["member/list"], files: ["a.tsx"] },
  ];
  assert.deepEqual(deriveCycleScreens([{ sha: "legacy", subject: "옛 커밋", at: "T1" }], rows), [
    { route: "/member/list", title: "회원 목록", note: "옛 커밋", at: "T1" },
  ]);
});

test("readHeadSha — 느슨한 ref 와 packed-refs 를 git 없이 읽는다", () => {
  const root = mkdtempSync(join(tmpdir(), "cycle-screens-"));
  try {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "packed-refs"), `# pack-refs\n${sha} refs/heads/main\n`);
    assert.equal(readHeadSha(root), sha);
    const loose = "fedcba9876543210fedcba9876543210fedcba98";
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${loose}\n`);
    assert.equal(readHeadSha(root), loose);
    assert.equal(readHeadSha(join(root, "nope")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
