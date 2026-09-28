import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import type { FastWords } from "../src/next/lib/thread.ts";
import {
  chipLabel,
  dedupeScreens,
  EFFORT_OF,
  effortWord,
  failureCards,
  fastBlockedWords,
  fastChip,
  fastCost,
  fastTipWords,
  fastToast,
  handoffOpen,
  noteAllowed,
  noticeKind,
  promptNumbers,
  rawErrorLine,
  retryCount,
  screenTitle,
  sizeText,
  splitDuration,
  textRoles,
} from "../src/next/lib/thread.ts";

test("effortWord: 다섯 칸과 CLI 의 단계 — 하나씩 대응", () => {
  assert.equal(effortWord(null), "normal");
  assert.equal(effortWord("low"), "short");
  assert.equal(effortWord("medium"), "normal");
  assert.equal(effortWord("high"), "long");
  assert.equal(effortWord("xhigh"), "longer");
  assert.equal(effortWord("max"), "max");
  assert.deepEqual(EFFORT_OF, {
    short: "low",
    normal: "medium",
    long: "high",
    longer: "xhigh",
    max: "max",
  });
});

test("noticeKind: 데몬 알림의 첫머리로 종류를 알아본다", () => {
  assert.equal(
    noticeKind("일시적인 문제입니다 — 같은 말로 스스로 다시 시도합니다 (2/5).", L.daemonNotice),
    "retry",
  );
  assert.equal(
    noticeKind(
      "사용량이 다시 채워지는대로 스스로 이어서 합니다 — 잠시만 기다려 주세요.",
      L.daemonNotice,
    ),
    "wait",
  );
  assert.equal(
    noticeKind("AI 프로그램을 다시 켰어요 — 하던 일을 이어서 합니다", L.daemonNotice),
    "revive",
  );
  assert.equal(noticeKind("대화가 길어져 정리한 뒤 이어서 합니다", L.daemonNotice), null);
});

test("retryCount: 문장 끝의 (n/N)", () => {
  assert.deepEqual(retryCount("… 다시 시도합니다 (3/5)."), { n: 3, of: 5 });
  assert.equal(retryCount("다시 시도합니다"), null);
});

test("promptNumbers: 보낸 말의 순번 — 기계 턴도 센다", () => {
  const blocks = [
    { type: "user", id: "u1" },
    { type: "text", id: "t1" },
    { type: "turn", id: "e1" },
    { type: "user", id: "u2" },
    { type: "notice", id: "n1" },
    { type: "user", id: "u3" },
  ];
  assert.deepEqual(
    [...promptNumbers(blocks)],
    [
      ["u1", 1],
      ["u2", 2],
      ["u3", 3],
    ],
  );
});

test("dedupeScreens: 같은 화면은 한 번", () => {
  assert.deepEqual(dedupeScreens([{ screen: "a" }, { screen: "b" }, { screen: "a" }]), [
    { screen: "a" },
    { screen: "b" },
  ]);
});

test("splitDuration · sizeText", () => {
  assert.deepEqual(splitDuration(12_400), { minutes: 0, seconds: 12 });
  assert.deepEqual(splitDuration(65_000), { minutes: 1, seconds: 5 });
  assert.deepEqual(splitDuration(-5), { minutes: 0, seconds: 0 });
  assert.equal(sizeText(300), "1KB");
  assert.equal(sizeText(320 * 1024), "320KB");
  assert.equal(sizeText(2.4 * 1024 * 1024), "2.4MB");
});

test("chipLabel: 칩은 모델과 생각 시간을 말한다(W6) — 목록이 오지 않았을 때만 프로바이더", () => {
  assert.equal(chipLabel("Opus 5.5", "보통"), "Opus 5.5 · 보통");
  assert.equal(chipLabel("GPT-5.2", "짧게"), "GPT-5.2 · 짧게");
  // 생각 시간을 고르지 않았으면 모델만.
  assert.equal(chipLabel("Opus 5.5", null), "Opus 5.5");
  // 모델 목록이 아직 오지 않았을 때의 프로바이더 폴백.
  assert.equal(chipLabel("Claude", "보통"), "Claude · 보통");
});

test("fastToast: 받아들여지면 켬·끔 인사, 거절되면 이유, 이유가 없으면 못했어요", () => {
  const say = { on: "켜졌어요", off: "꺼졌어요", fail: "못했어요" };
  assert.equal(fastToast(true, true, null, say), "켜졌어요");
  assert.equal(fastToast(false, false, null, say), "꺼졌어요");
  // 데몬이 대신 말하는 이유(요금제 · 쿨다운)는 그대로 옮겨진다.
  assert.equal(fastToast(true, false, "요금제가 빠르게를 막아요", say), "요금제가 빠르게를 막아요");
  assert.equal(fastToast(false, true, null, say), "못했어요");
});

test("rawErrorLine: 원문 → 문장 매핑(W3) — 한국어 고지 · 영문 원문 · 한도", () => {
  // 한국어 고지(고칠 것을 말하는 안내)는 가리지 않고 지나간다.
  const notice = "8MB 를 넘는 파일은 붙일 수 없습니다";
  assert.deepEqual(rawErrorLine(notice, L), { title: notice, raw: null });
  // 영문 날 원문은 받은 문장으로 덮고, 원문은 접힌 자리로.
  assert.deepEqual(rawErrorLine("Claude Code process exited with code 1", L), {
    title: L.vocab.aiFailed,
    raw: "Claude Code process exited with code 1",
  });
  // 한도 문장은 그 문장으로 바꾼다.
  assert.deepEqual(rawErrorLine("usage limit reached until 3pm", L), {
    title: "구독 사용량을 채워 작업이 멈췄습니다",
    raw: "usage limit reached until 3pm",
  });
});

test("failureCards: 잃은 말마다 카드 한 장(W8) — 대화록이 말하는 실패와 겹치면 하나", () => {
  const lost = (id: string, text: string, images = 0, files = 0) => ({
    id,
    text,
    images,
    files,
    lostAt: 0,
  });
  // 대화록이 비었으면 잃은 말 전부가 카드가 된다.
  assert.deepEqual(failureCards([lost("a", "검색창 넣어 줘", 2, 1)], []), [
    { id: "a", text: "검색창 넣어 줘", images: 2, files: 1 },
  ]);
  // 같은 말이 대화록에 실패한 답으로 남아 있으면(살아 있는 error 블록) 카드는 하나다.
  const tape = [
    { type: "user", id: "u1", text: "검색창 넣어 줘" },
    { type: "turn", id: "t1", subtype: "error_max_turns" as const, isError: true },
  ];
  assert.deepEqual(failureCards([lost("a", "검색창 넣어 줘")], tape), []);
  // 다른 말의 실패는 그 말의 카드로 남는다.
  assert.deepEqual(failureCards([lost("b", "버튼 옮겨 줘")], tape), [
    { id: "b", text: "버튼 옮겨 줘", images: 0, files: 0 },
  ]);
});

test("noteAllowed: 영수증의 `한마디 더` — 그 요청이 열려 있을 때만(U20)", () => {
  const block = { pr: 7 };
  // 열림.
  assert.equal(noteAllowed(block, { number: 7, state: "open" }), true);
  // 닫힘 · 반영 — 갈 곳이 없다.
  assert.equal(noteAllowed(block, { number: 7, state: "closed" }), false);
  assert.equal(noteAllowed(block, { number: 7, state: "merged" }), false);
  // 다른 요청 번호 — 옛 영수증의 요청은 이미 끝났다.
  assert.equal(noteAllowed(block, { number: 9, state: "open" }), false);
  assert.equal(noteAllowed(block, null), false);
  // changes_requested 는 리뷰의 판정이지 닫힘이 아니다(감독자와 같은 잣대).
  assert.equal(handoffOpen({ state: "changes_requested" }), true);
  assert.equal(noteAllowed(block, { number: 7, state: "changes_requested" }), true);
});

// 빠르게 문장 묶음의 가짜 — 진짜 문장 대신 짧은 표식으로 어느 칸이 골라졌는지 본다.
const fast: FastWords = {
  offTitle: "off",
  nextTitle: "next",
  onTitle: "on",
  costClaude: "cost-c",
  costMidway: "midway",
  costOmp: "cost-o",
  costOther: "cost-x",
  blocked: {
    creditsGone: "cg",
    credits: "cr",
    org: "og",
    orgModels: "om",
    network: "nw",
    evaluation: "ev",
    cooldown: "cd",
  },
};

test("fastChip: 켜져 있으면 능력을 몰라도 보인다 — 끌 길은 남긴다", () => {
  // 켜짐 — omp 의 `-fast` 변종으로 도는 대화. 능력 · 행을 몰라도 끌 길이 있어야 한다.
  assert.equal(fastChip({ capability: false, row: undefined, on: true }), true);
  // 꺼짐 · 능력 없음 — 보이지 않는다.
  assert.equal(fastChip({ capability: false, row: undefined, on: false }), false);
  // 행을 모른다(선택자가 오기 전 잠깐) — 능력만으로 낙관한다.
  assert.equal(fastChip({ capability: true, row: undefined, on: false }), true);
  // 행이 알아 주면 능력과 함께, 거절하면 숨는다.
  assert.equal(fastChip({ capability: true, row: { supportsFastMode: true }, on: false }), true);
  assert.equal(fastChip({ capability: true, row: { supportsFastMode: false }, on: false }), false);
});

test("fastCost: 프로바이더별 비용 문장 — 툴팁과 토스트가 같은 문장을 쓴다", () => {
  assert.equal(fastCost("claude", fast), "cost-c");
  assert.equal(fastCost("omp", fast), "cost-o");
  assert.equal(fastCost("codex", fast), "cost-x");
});

test("fastBlockedWords: CLI 영어 원문을 단서로 가른다 — 단서의 순서가 곧 우선순위", () => {
  assert.equal(fastBlockedWords("Fast mode requires usage credits", fast.blocked), "cr");
  assert.equal(
    fastBlockedWords("Fast mode disabled · usage credits exhausted", fast.blocked),
    "cg",
  );
  assert.equal(
    fastBlockedWords("Fast mode has been disabled by your organization.", fast.blocked),
    "og",
  );
  // organization 을 품긴 문장이지만 allowed models 단서가 이긴다.
  assert.equal(
    fastBlockedWords("claude-opus-5 is not in your organization's allowed models", fast.blocked),
    "om",
  );
  assert.equal(
    fastBlockedWords("Fast mode unavailable due to network connectivity issues", fast.blocked),
    "nw",
  );
  assert.equal(
    fastBlockedWords(
      "Fast mode unavailable during evaluation. Please purchase credits.",
      fast.blocked,
    ),
    "ev",
  );
  assert.equal(fastBlockedWords("rate limit cooldown", fast.blocked), "cd");
  // 모르는 원문은 지어내지 않고 그대로 — 빈 원문도 그대로 돌아가 호출자가 판단한다.
  assert.equal(fastBlockedWords("Something entirely new", fast.blocked), "Something entirely new");
  assert.equal(fastBlockedWords("", fast.blocked), "");
});

test("fastTipWords: 주인과 상태가 제목과 비고 줄을 고른다", () => {
  // 꺼짐 · next — 다음 대화 문장과 비용 한 줄.
  assert.deepEqual(
    fastTipWords({ subject: "next", on: false, blocked: null, provider: "claude" }, fast),
    {
      title: "next",
      notes: ["cost-c"],
    },
  );
  // 꺼짐 · session — Claude 는 대화 중간에 켠 계산 한 줄이 더 선다.
  assert.deepEqual(
    fastTipWords({ subject: "session", on: false, blocked: null, provider: "claude" }, fast),
    { title: "off", notes: ["cost-c", "midway"] },
  );
  // omp · 그 밖의 AI — 비용 줄은 하나.
  assert.deepEqual(
    fastTipWords({ subject: "session", on: false, blocked: null, provider: "omp" }, fast),
    {
      title: "off",
      notes: ["cost-o"],
    },
  );
  assert.deepEqual(
    fastTipWords({ subject: "session", on: false, blocked: null, provider: "codex" }, fast),
    { title: "off", notes: ["cost-x"] },
  );
  // 켜짐 — 주인을 묻지 않는다.
  assert.deepEqual(
    fastTipWords({ subject: "session", on: true, blocked: null, provider: "claude" }, fast),
    {
      title: "on",
      notes: ["cost-c"],
    },
  );
  assert.deepEqual(
    fastTipWords({ subject: "next", on: true, blocked: null, provider: "codex" }, fast),
    {
      title: "on",
      notes: ["cost-x"],
    },
  );
  // 막힘(session) — 이유 하나뿐, 비고는 없다.
  assert.deepEqual(
    fastTipWords(
      { subject: "session", on: false, blocked: "usage credits exhausted", provider: "claude" },
      fast,
    ),
    { title: "cg", notes: [] },
  );
  // next 는 몸이 없어 blocked 가 와도 무시한다.
  assert.deepEqual(
    fastTipWords(
      { subject: "next", on: false, blocked: "usage credits exhausted", provider: "claude" },
      fast,
    ),
    { title: "next", notes: ["cost-c"] },
  );
});

test("fastToast: blocked 묶음을 넘기면 거절 이유가 한국어로, 안 넘기면 원문이다", () => {
  const translated = { on: "켜졌어요", off: "꺼졌어요", fail: "못했어요", blocked: fast.blocked };
  assert.equal(fastToast(true, false, "Fast mode requires usage credits", translated), "cr");
  // 선택 칸 — 묶음이 없는 부르는 쪽은 지금처럼 원문이 그대로 옮겨진다.
  assert.equal(
    fastToast(true, false, "Fast mode requires usage credits", {
      on: "켜졌어요",
      off: "꺼졌어요",
      fail: "못했어요",
    }),
    "Fast mode requires usage credits",
  );
});

test("screenTitle: 고친 화면 카드의 제목 — 링크 제목 · 이번 작업의 화면 · 첫 화면 · 일반 이름", () => {
  const words = { homeScreen: L.preview.homeScreen, unknownScreen: L.transcript.unknownScreen };
  const cycleScreens = [
    { route: "member/list", title: "회원 목록" },
    { route: "home", title: "" },
  ];
  // 답이 링크에 붙인 제목이 먼저다.
  assert.equal(screenTitle({ path: "/", title: "대문" }, cycleScreens, words), "대문");
  // 제목이 없으면 이번 작업의 화면 이름에서 찾는다 — 표기 차이는 같은 화면으로 겨눈다.
  assert.equal(
    screenTitle({ path: "/member/list", title: null }, cycleScreens, words),
    "회원 목록",
  );
  assert.equal(
    screenTitle({ path: "/member/list/", title: null }, cycleScreens, words),
    "회원 목록",
  );
  // 빈 제목의 화면은 후보가 아니다 — 루트는 첫 화면으로.
  assert.equal(screenTitle({ path: "/", title: null }, cycleScreens, words), L.preview.homeScreen);
  assert.equal(screenTitle({ path: "/home", title: null }, cycleScreens, words), "이름 없는 화면");
  // 그래도 모르면 일반 이름 — 주소가 그대로 제목에 서지 않게.
  assert.equal(
    screenTitle({ path: "/event/12", title: null }, cycleScreens, words),
    "이름 없는 화면",
  );
  assert.equal(screenTitle({ path: "/event/12", title: null }, undefined, words), "이름 없는 화면");
});

test("textRoles: 묶음마다 마지막 글이 답 자리다 — 도는 중에도 그렇다", () => {
  // 마감된 묶음: 마지막 글이 답, 앞의 글은 과정(첫 과정이 접는 줄).
  const done = textRoles(
    [
      { type: "user", id: "u1" },
      { type: "text", id: "t1", agentId: null },
      { type: "tool", id: "k1" },
      { type: "text", id: "t2", agentId: null },
      { type: "turn", id: "e1" },
    ],
    false,
  );
  assert.deepEqual([...done.answers], ["t2"]);
  assert.deepEqual(done.steps.get("t1"), { head: true, key: "t1", settled: true });

  // 도는 꼬리: 마지막 글도 답 자리로 — 답이 끝나는 순간 모양이 바뀌지 않게.
  const liveTail = textRoles(
    [
      { type: "user", id: "u1" },
      { type: "text", id: "t1", agentId: null },
    ],
    true,
  );
  assert.deepEqual([...liveTail.answers], ["t1"]);
  assert.equal(liveTail.steps.size, 0);

  // 답이 멈추면(세션이 멈춘 꼬리) 과정이 생기고 접힌다.
  const stoppedTail = textRoles(
    [
      { type: "user", id: "u1" },
      { type: "text", id: "t1", agentId: null },
      { type: "text", id: "t2", agentId: null },
    ],
    false,
  );
  assert.deepEqual([...stoppedTail.answers], ["t2"]);
  assert.deepEqual(stoppedTail.steps.get("t1"), { head: true, key: "t1", settled: true });
});

test("textRoles: 도는 중 뒤에 이어 온 글이 답 자리를 받으면 앞의 글은 과정으로 내려간다", () => {
  const before = textRoles(
    [
      { type: "user", id: "u1" },
      { type: "text", id: "t1", agentId: null },
    ],
    true,
  );
  const after = textRoles(
    [
      { type: "user", id: "u1" },
      { type: "text", id: "t1", agentId: null },
      { type: "tool", id: "k1" },
      { type: "text", id: "t2", agentId: null },
    ],
    true,
  );
  // t1 은 답이었다가 과정이 된다 — 이 내려갬이 한 번 부드럽게 일어난다.
  assert(before.answers.has("t1"));
  assert(!after.answers.has("t1"));
  assert.deepEqual(after.steps.get("t1"), { head: true, key: "t1", settled: false });
  assert(after.answers.has("t2"));
});

test("textRoles: 묶음의 경계와 머리 · 하위 에이전트의 글", () => {
  // 생각 · 도구 · 알림은 묶음을 끊지 않고, 사람 말 · 마감 · 기록이 끊는다.
  const roles = textRoles(
    [
      { type: "text", id: "a1", agentId: null },
      { type: "thinking", id: "h1" },
      { type: "notice", id: "n1" },
      { type: "text", id: "a2", agentId: null },
      { type: "save", id: "s1" },
      { type: "text", id: "sub1", agentId: "agent-2" },
      { type: "user", id: "u1" },
      { type: "text", id: "b1", agentId: null },
      { type: "text", id: "b2", agentId: null },
      { type: "human", id: "r1" },
      { type: "text", id: "c1", agentId: null },
    ],
    true,
  );
  // 첫 묶음 — 생각 · 알림 사이에서도 한 묶음, save 가 마감한다.
  assert.deepEqual([...roles.answers], ["a2", "b2", "c1"]);
  assert.deepEqual(roles.steps.get("a1"), { head: true, key: "a1", settled: true });
  // 둘째 묶음은 human 기록이 마감한다.
  assert.deepEqual(roles.steps.get("b1"), { head: true, key: "b1", settled: true });
  // 꼬리의 묶음은 도는 중 — 마지막 글이 곧 답이라 과정이 없다.
  assert(!roles.steps.has("c1"));
  // 하위 에이전트의 글은 답도 과정도 아니다.
  assert(!roles.answers.has("sub1"));
  assert(!roles.steps.has("sub1"));
  // 경계 블록들만으로는 묶음이 생기지 않는다.
  assert.equal(textRoles([{ type: "user", id: "u" }], true).steps.size, 0);
});
