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
import { MessageTranslator } from "../dist/translate.js";

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
