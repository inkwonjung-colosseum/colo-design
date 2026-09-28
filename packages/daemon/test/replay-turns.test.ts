import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEvent } from "@colo-design/protocol";
import { closeReplayTurns } from "../src/replay-turns.ts";

const echo = (text: string): ChatEvent => ({ kind: "user.echo", text, images: 0 });
const said = (text: string, agentId: string | null = null): ChatEvent => ({
  kind: "text.done",
  blockId: `b:${text}`,
  text,
  agentId,
});
const thought = (agentId: string | null = null): ChatEvent => ({
  kind: "thinking.delta",
  blockId: `t:${Math.random()}`,
  text: "…",
  agentId,
});
const tool = (agentId: string | null = null): ChatEvent => ({
  kind: "tool.start",
  toolUseId: `c:${Math.random()}`,
  name: "Bash",
  input: {},
  agentId,
});
const ended = (): ChatEvent => ({
  kind: "turn.end",
  subtype: "success",
  isError: false,
  costUsd: null,
  numTurns: null,
  durationMs: null,
  resultText: null,
});

const kinds = (events: ChatEvent[]) => events.map((event) => event.kind);

test("두 턴 — 둘째 말 앞과 꼬리에 턴 끝이 하나씩 선다", () => {
  const closed = closeReplayTurns(
    [echo("첫 말"), said("첫 답"), echo("둘째 말"), said("둘째 답")],
    { open: false },
  );
  assert.deepEqual(kinds(closed), [
    "user.echo",
    "text.done",
    "turn.end",
    "user.echo",
    "text.done",
    "turn.end",
  ]);
  // 넣은 턴 끝은 정산 칸이 비어 있는 성공 판정이다.
  const end = closed.find((event) => event.kind === "turn.end");
  assert.deepEqual(end, ended());
});

test("도는 중(open)이면 꼬리에는 붙지 않는다 — 도는 턴을 끝낸 것처럼 그리지 않는다", () => {
  const closed = closeReplayTurns(
    [echo("첫 말"), said("첫 답"), echo("둘째 말"), said("도는 답")],
    { open: true },
  );
  assert.deepEqual(kinds(closed), ["user.echo", "text.done", "turn.end", "user.echo", "text.done"]);
});

test("중단 표식 앞의 턴은 닫지 않는다 — 웹은 그 말을 멈췄어요로 그린다", () => {
  for (const marker of [
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
    "  [Request interrupted by user]", // 앞 공백이 붙어 저장된 표식도 같다
  ]) {
    const closed = closeReplayTurns([echo("첫 말"), said("고치는 중"), echo(marker)], {
      open: false,
    });
    assert.deepEqual(
      kinds(closed),
      ["user.echo", "text.done", "user.echo"],
      `${marker} 앞에는 turn.end 가 없다`,
    );
  }
});

test("답 없는 턴은 닫지 않는다 — 말만 있고 답이 오기 전에 끊긴 턴", () => {
  const closed = closeReplayTurns([echo("말"), echo("다시 말"), said("답")], {
    open: false,
  });
  assert.deepEqual(kinds(closed), ["user.echo", "user.echo", "text.done", "turn.end"]);
});

test("도구만 돈 턴도 닫는다 — tool.start 도 본 에이전트의 답이다", () => {
  const closed = closeReplayTurns([echo("말"), tool()], { open: false });
  assert.deepEqual(kinds(closed), ["user.echo", "tool.start", "turn.end"]);
  // 생각만 든 턴도 마찬가지다.
  const thinking = closeReplayTurns([echo("말"), thought()], { open: false });
  assert.deepEqual(kinds(thinking), ["user.echo", "thinking.delta", "turn.end"]);
});

test("하위 에이전트의 말만 든 턴은 닫지 않는다", () => {
  const closed = closeReplayTurns(
    [
      echo("말"),
      said("보조의 말", "task-1"),
      tool("task-1"),
      thought("task-1"),
      echo("다음 말"),
      said("본 답"),
    ],
    { open: false },
  );
  assert.deepEqual(kinds(closed), [
    "user.echo",
    "text.done",
    "tool.start",
    "thinking.delta",
    "user.echo",
    "text.done",
    "turn.end",
  ]);
});

test("이미 turn.end 가 있는 턴에는 겹쳐 넣지 않는다", () => {
  const closed = closeReplayTurns([echo("말"), said("답"), ended(), echo("다음 말"), said("답2")], {
    open: false,
  });
  assert.deepEqual(kinds(closed), [
    "user.echo",
    "text.done",
    "turn.end",
    "user.echo",
    "text.done",
    "turn.end",
  ]);
});

test("입력 배열은 바꾸지 않는다 — 순서도 그대로다", () => {
  const events = [echo("말"), said("답")];
  const closed = closeReplayTurns(events, { open: false });
  assert.notEqual(closed, events);
  assert.deepEqual(kinds(events), ["user.echo", "text.done"]);
});

test("턴 번호의 약속 — 턴 끝 앞에 선 사람 말의 수가 그 턴의 번호다", () => {
  // 네 프롬프트, 그중 하나는 중단 표식: 웹의 turnBlockNumbers 가 세는 셈(앞의
  // user 블록 수)과 데몬의 branchCut(isPrompt 셈)이 어긋나지 않는 자리.
  const closed = closeReplayTurns(
    [
      echo("하나"),
      said("답 하나"),
      echo("[Request interrupted by user]"),
      echo("셋"),
      said("답 셋"),
      echo("넷"),
      said("답 넷"),
    ],
    { open: false },
  );
  // 표식 앞의 턴(1)과 표식이 연 턴(2)은 닫지 않는다 — 서는 것은 셋 · 넷 뿐.
  const ends = closed
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "turn.end");
  assert.equal(ends.length, 2);
  assert.deepEqual(
    ends.map(
      ({ index }) => closed.slice(0, index).filter((event) => event.kind === "user.echo").length,
    ),
    [3, 4],
  );
});
