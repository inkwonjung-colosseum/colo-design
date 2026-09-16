import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEvent } from "@colo-design/protocol";
import { transcriptToMarkdown } from "../src/lib/transcript-export.ts";

const AT = new Date("2026-09-13T09:00:00");

test("a quiet transcript is a title and nothing to read", () => {
  const md = transcriptToMarkdown([], "빈 대화", AT);
  assert.match(md, /^# 빈 대화\n/);
  assert.match(md, /내보낸 시각/);
  assert.equal(md.includes("**나**"), false);
});

test("the planner's words and Claude's answer keep their order and speakers", () => {
  const events: ChatEvent[] = [
    { kind: "user.echo", text: "로그인 화면 만들어 줘", images: 1 },
    {
      kind: "text.done",
      blockId: "b1",
      text: "로그인 화면을 만들었습니다. 회원가입 링크도 넣었습니다.",
      agentId: null,
    },
  ];
  const md = transcriptToMarkdown(events, "회원가입", AT);
  const order = md.indexOf("로그인 화면 만들어 줘") < md.indexOf("로그인 화면을 만들었습니다");
  assert.equal(order, true);
  assert.match(md, /\*\*나\*\* \(이미지 1장\)/);
  assert.match(md, /\*\*Claude\*\*/);
});

test("machine traffic — tools, thinking, retries — never reaches the file", () => {
  const events: ChatEvent[] = [
    { kind: "user.echo", text: "고쳐 줘", images: 0 },
    {
      kind: "tool.start",
      toolUseId: "t1",
      name: "Bash",
      input: { command: "ls" },
      agentId: null,
    },
    { kind: "tool.end", toolUseId: "t1", isError: false, content: "ok", agentId: null },
    {
      kind: "thinking.delta",
      blockId: "th1",
      text: "음",
      agentId: null,
    },
    { kind: "retry", attempt: 1, maxRetries: 4, delayMs: 8000, error: "rate_limit" },
    {
      kind: "text.done",
      blockId: "b1",
      text: "고쳤습니다.",
      agentId: null,
    },
    {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 42_000,
      resultText: null,
    },
  ];
  const md = transcriptToMarkdown(events, "수정", AT);
  assert.equal(md.includes("Bash"), false);
  assert.equal(md.includes("ls"), false);
  assert.equal(md.includes("rate_limit"), false);
  assert.match(md, /고쳤습니다\./);
});

test("a blank message with an attached image still reads as the planner's turn", () => {
  const events: ChatEvent[] = [{ kind: "user.echo", text: "  ", images: 1 }];
  const md = transcriptToMarkdown(events, "첨부", AT);
  assert.match(md, /\*\*나\*\* \(이미지 1장\)/);
  assert.match(md, /\(빈 메시지\)/);
});
