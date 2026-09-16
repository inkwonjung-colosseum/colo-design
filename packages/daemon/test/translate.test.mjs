/**
 * Streaming-to-block translation. The case that matters is the seam between
 * the deltas and the aggregated assistant message that repeats the same text:
 * if the two disagree about a block's identity, the UI shows every sentence
 * twice, which is what a planner reported first.
 *
 * Run: node --test packages/daemon/test/translate.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageTranslator } from "../dist/agent/drivers/claude/event-mapper.js";

function textBlocks(events) {
  return events.filter((event) => event.kind === "text.delta" || event.kind === "text.done");
}

test("deltas and the aggregated message describe one block, not two", () => {
  const translator = new MessageTranslator();
  const events = [
    ...translator.translate({
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_01" } },
    }),
    ...translator.translate({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "안녕" },
      },
    }),
    ...translator.translate({
      type: "assistant",
      message: {
        id: "msg_01",
        content: [{ type: "text", text: "안녕하세요" }],
      },
    }),
  ];
  const ids = new Set(textBlocks(events).map((event) => event.blockId));
  assert.equal(ids.size, 1, `one block expected, got ${[...ids].join(", ")}`);
});

test("a stream that never announced a message id still lines up", () => {
  const translator = new MessageTranslator();
  const events = [
    ...translator.translate({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "부분" },
      },
    }),
    ...translator.translate({
      type: "assistant",
      message: { content: [{ type: "text", text: "부분 텍스트" }] },
    }),
  ];
  assert.equal(new Set(textBlocks(events).map((event) => event.blockId)).size, 1);
});

test("consecutive messages in one turn keep separate blocks", () => {
  const translator = new MessageTranslator();
  const ids = [];
  for (const id of ["msg_01", "msg_02"]) {
    translator.translate({
      type: "stream_event",
      event: { type: "message_start", message: { id } },
    });
    ids.push(
      ...textBlocks(
        translator.translate({
          type: "assistant",
          message: { id, content: [{ type: "text", text: "같은 문장" }] },
        }),
      ).map((event) => event.blockId),
    );
  }
  assert.equal(new Set(ids).size, 2, "identical text from two messages must not merge");
});

test("a subagent's blocks never collide with the main thread's", () => {
  const translator = new MessageTranslator();
  const main = textBlocks(
    translator.translate({
      type: "assistant",
      message: { id: "msg_01", content: [{ type: "text", text: "본문" }] },
    }),
  )[0];
  const sub = textBlocks(
    translator.translate({
      type: "assistant",
      parent_tool_use_id: "toolu_9",
      message: { id: "msg_01", content: [{ type: "text", text: "본문" }] },
    }),
  )[0];
  assert.notEqual(main.blockId, sub.blockId);
  assert.equal(sub.agentId, "toolu_9");
});

// ---------------------------------------------------------------------------
// 진행 · 작업 · 상태 (PLAN D97 · D99 · D100)
// ---------------------------------------------------------------------------

test("보조 작업의 근황이 한 줄로 올라온다", () => {
  const translator = new MessageTranslator();
  const [started] = translator.translate({
    type: "system",
    subtype: "task_started",
    task_id: "task_1",
    tool_use_id: "toolu_1",
    description: "인증 모듈 살펴보기",
    subagent_type: "Explore",
    is_backgrounded: false,
  });
  assert.deepEqual(started, {
    kind: "task.start",
    taskId: "task_1",
    toolUseId: "toolu_1",
    description: "인증 모듈 살펴보기",
    subagentType: "Explore",
    backgrounded: false,
  });

  const [progress] = translator.translate({
    type: "system",
    subtype: "task_progress",
    task_id: "task_1",
    tool_use_id: "toolu_1",
    description: "인증 모듈 살펴보기",
    summary: "인증 모듈 분석 중",
    last_tool_name: "Read",
    usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 9000 },
  });
  assert.equal(progress.kind, "task.progress");
  assert.equal(progress.summary, "인증 모듈 분석 중");
  assert.equal(progress.toolUses, 3);
});

test("집안일 작업(ambient · skip_transcript)은 활동으로 올라오지 않는다", () => {
  const translator = new MessageTranslator();
  assert.deepEqual(
    translator.translate({
      type: "system",
      subtype: "task_started",
      task_id: "task_bg",
      description: "watcher",
      ambient: true,
    }),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "system",
      subtype: "task_notification",
      task_id: "task_bg",
      status: "completed",
      summary: "watcher",
      skip_transcript: true,
    }),
    [],
  );
});

test("살아 있는 백그라운드 작업 목록은 통째로 갈아 끼운다 — 집안일은 빼고", () => {
  const translator = new MessageTranslator();
  const [event] = translator.translate({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [
      { task_id: "t1", task_type: "shell", description: "pnpm build" },
      { task_id: "t2", task_type: "monitor", description: "watcher", ambient: true },
    ],
  });
  assert.equal(event.kind, "tasks");
  assert.deepEqual(event.tasks, [{ taskId: "t1", type: "shell", description: "pnpm build" }]);
});

test("도구의 경과와 서브에이전트 재시도가 그 도구 행으로 간다", () => {
  const translator = new MessageTranslator();
  const [event] = translator.translate({
    type: "tool_progress",
    tool_use_id: "toolu_7",
    tool_name: "Task",
    parent_tool_use_id: null,
    elapsed_time_seconds: 42,
    subagent_retry: { attempt: 2, max_retries: 5, retry_delay_ms: 1000 },
  });
  assert.equal(event.kind, "tool.progress");
  assert.equal(event.toolUseId, "toolu_7");
  assert.equal(event.elapsedSeconds, 42);
  assert.deepEqual(event.retry, { attempt: 2, maxRetries: 5, delayMs: 1000 });
  // 도구 id 가 없는 심장 박동은 붙을 행이 없다 — 올리지 않는다.
  assert.deepEqual(translator.translate({ type: "tool_progress", elapsed_time_seconds: 3 }), []);
});

test("다음 칩 · 상태가 그대로 올라온다", () => {
  const translator = new MessageTranslator();
  assert.deepEqual(translator.translate({ type: "prompt_suggestion", suggestion: "  " }), []);
  assert.deepEqual(translator.translate({ type: "prompt_suggestion", suggestion: "다음은?" }), [
    { kind: "suggestion", text: "다음은?" },
  ]);
  assert.deepEqual(
    translator.translate({ type: "system", subtype: "status", status: "compacting" }),
    [{ kind: "status", status: "compacting" }],
  );
});

test("하위 작업의 생각은 델타 한 번으로 올라온다 (forwardSubagentText)", () => {
  const translator = new MessageTranslator();
  const events = translator.translate({
    type: "assistant",
    parent_tool_use_id: "toolu_3",
    message: { id: "msg_sub", content: [{ type: "thinking", thinking: "무엇을 먼저 읽을까" }] },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "thinking.delta");
  assert.equal(events[0].agentId, "toolu_3");
  assert.equal(events[0].text, "무엇을 먼저 읽을까");
});

test("대화 새로 시작(/clear)은 기록을 지우지 않고 기억이 끊긴 자리를 적는다", () => {
  const translator = new MessageTranslator();
  const [event] = translator.translate({
    type: "conversation_reset",
    new_conversation_id: "conv_2",
    session_id: "s1",
  });
  assert.equal(event.kind, "notice");
  assert.match(event.text, /기억하지 않습니다/);
});

test("예고된 종료는 세션이 읽는 귀띔이고, CLI 의 알림 글은 그대로 흐른다", () => {
  const translator = new MessageTranslator();
  assert.deepEqual(
    translator.translate({ type: "system", subtype: "worker_shutting_down", reason: "host_exit" }),
    [{ kind: "shutdown", reason: "host_exit" }],
  );
  assert.deepEqual(
    translator.translate({ type: "system", subtype: "informational", content: "  " }),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "system",
      subtype: "informational",
      content: "설정을 다시 읽었습니다",
    }),
    [{ kind: "notice", level: "info", text: "설정을 다시 읽었습니다" }],
  );
});

test("한도 변화는 요금 칩의 방아쇠로만 올라간다", () => {
  const translator = new MessageTranslator();
  const [event] = translator.translate({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed_warning", resetsAt: 1_760_000_000 },
  });
  assert.deepEqual(event, {
    kind: "ratelimit",
    status: "allowed_warning",
    resetsAt: 1_760_000_000,
  });
});
