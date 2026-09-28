import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanUsage } from "@colo-design/protocol";
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
  sizeText,
  splitDuration,
  USAGE_WORD_MIN,
  usageReading,
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

const plan = (five: number | null, week: number | null, models: number[] = []): PlanUsage => ({
  subscriptionType: "max",
  fiveHour: five === null ? null : { utilization: five, resetsAt: "2026-09-25T08:40:00Z" },
  sevenDay: week === null ? null : { utilization: week, resetsAt: null },
  modelWeekly: models.map((utilization, index) => ({
    label: `m${index}`,
    utilization,
    resetsAt: null,
  })),
});

test("usageReading: 가장 찬 창 하나 — 같으면 5시간", () => {
  assert.equal(usageReading(null), null);
  assert.equal(usageReading(plan(null, null)), null);
  const five = usageReading(plan(38.4, 12));
  assert.equal(five?.pct, 38);
  assert.deepEqual(five?.window, { kind: "fiveHour" });
  assert.equal(five?.resetsAt, "2026-09-25T08:40:00Z");
  assert.deepEqual(usageReading(plan(40, 81))?.window, { kind: "sevenDay" });
  assert.deepEqual(usageReading(plan(40, 40, [92]))?.window, { kind: "model", label: "m0" });
  assert.deepEqual(usageReading(plan(50, 50))?.window, { kind: "fiveHour" });
  assert.equal(usageReading(plan(140, null))?.pct, 100);
});

test("사용량 한 단어는 70% 를 넘어야 선다(P6)", () => {
  assert.equal(USAGE_WORD_MIN, 70);
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
