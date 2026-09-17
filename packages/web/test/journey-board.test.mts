import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadSummary } from "@colo-design/protocol";

const { buildJourneyBoard, chipFor, trailFor, trailWords } = await import(
  "../src/lib/journey-board.ts"
);

let seq = 0;
const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: `t${++seq}`,
  title: `대화 ${seq}`,
  state: "idle",
  updatedAt: new Date(2026, 0, 1, 9, seq).toISOString(),
  ...over,
});

test("넘긴 뒤 코멘트가 돌아온 대화는 '나를 기다리는 일'에 경고 트레일로 선다", () => {
  const board = buildJourneyBoard([thread({ cycle: "review" })], {});
  assert.equal(board.waiting.length, 1);
  assert.equal(board.working.length, 0);
  assert.deepEqual(board.waiting[0]?.trail, ["done", "done", "warn", "empty"]);
  assert.deepEqual(board.waiting[0]?.chip, { tone: "danger", label: "변경 요청" });
});

test("개발자 검토 중은 기다리는 일이고 넘기기 정류장에 서 있다", () => {
  const board = buildJourneyBoard([thread({ cycle: "handed" })], {});
  assert.deepEqual(board.waiting[0]?.trail, ["done", "done", "now", "empty"]);
  assert.deepEqual(board.waiting[0]?.chip, { tone: "accent", label: "개발자 검토 중" });
});

test("도는 턴은 사이클을 덮는다 — 반영 뒤 새 작업이면 만들기로 돌아온다", () => {
  const board = buildJourneyBoard([thread({ state: "running", cycle: "merged" })], {});
  assert.equal(board.waiting.length, 0);
  assert.equal(board.working.length, 1);
  assert.deepEqual(board.working[0]?.trail, ["now", "empty", "empty", "empty"]);
  assert.deepEqual(board.working[0]?.chip, { tone: "warn", label: "작업 중" });
});

test("저장한 대화는 진행 중 그룹의 저장 정류장에 멈춰 있다", () => {
  const board = buildJourneyBoard([thread({ cycle: "saved" })], {});
  assert.equal(board.working.length, 1);
  assert.deepEqual(board.working[0]?.trail, ["done", "now", "empty", "empty"]);
  assert.deepEqual(board.working[0]?.chip, { tone: "muted", label: "저장됨" });
});

test("반영된 대화는 '방금 있던 일'에 네 점이 다 차서 선다", () => {
  const board = buildJourneyBoard([thread({ cycle: "merged" })], {});
  assert.equal(board.done.length, 1);
  assert.deepEqual(board.done[0]?.trail, ["done", "done", "done", "done"]);
  assert.deepEqual(board.done[0]?.chip, { tone: "ok", label: "반영됨" });
});

test("기여가 없는 대화는 트레일과 칩이 없다 — 빈 지도는 '못 갔다'로 오독된다", () => {
  const one = thread();
  assert.equal(trailFor(one), null);
  assert.equal(chipFor(one), null);
  const board = buildJourneyBoard([one], {});
  assert.equal(board.working.length, 1);
  assert.equal(board.working[0]?.trail, null);
});

test("확인 대기는 사이클보다 크고, 트레일은 사이클의 진실을 유지한다", () => {
  const one = thread({ state: "awaiting", cycle: "handed" });
  assert.deepEqual(chipFor(one), { tone: "warn", label: "확인 대기" });
  assert.deepEqual(trailFor(one), ["done", "done", "now", "empty"]);
  // 사이클 없는 확인 대기는 만들기에서 멈춘 것이다.
  assert.deepEqual(trailFor(thread({ state: "awaiting" })), ["now", "empty", "empty", "empty"]);
});

test("연결 준비 기록은 대화가 아니라 scaffold — 보드에 서지 않는다", () => {
  const board = buildJourneyBoard([thread({ title: "연결 준비", cycle: "merged" })], {});
  assert.equal(board.waiting.length, 0);
  assert.equal(board.working.length, 0);
  assert.equal(board.done.length, 0);
});

test("설정의 대화 이름이 데몬 제목을 이긴다", () => {
  const one = thread({ title: "새 대화" });
  const board = buildJourneyBoard([one], { [one.id]: "결제 모듈 리팩터링" });
  assert.equal(board.working[0]?.title, "결제 모듈 리팩터링");
});

test("트레일의 말은 점이 번역한 문장이다", () => {
  assert.equal(
    trailWords(thread({ cycle: "review" })),
    "만들기 · 저장 · 넘기기(코멘트 도착) · 반영",
  );
  assert.equal(trailWords(thread({ cycle: "merged" })), "반영됨");
  assert.equal(trailWords(thread({ state: "running" })), "만들기(진행 중)");
});
