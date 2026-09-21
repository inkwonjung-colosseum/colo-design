/**
 * OmpAgentSession 의 배선 검사 — 가짜 rpc-ui 에이전트(stdout 줄 JSONL) 위에서
 * 실제 세션 클래스가 무슨 명령을 보내고 무슨 이벤트를 내는지 잠근다.
 *
 * 계약:
 *  - 런치는 `--mode rpc-ui --approval-mode always-ask` 다 — rpc 에는 승인
 *    모드를 바꿀 명령이 없으므로 모든 쓰기·실행 승인이 데몬에 와야 쓰기
 *    정책이 집행된다.
 *  - `ready` 뒤 protocol v2 를 협상하고, 1 MiB 를 넘는 프레임은 `rpc_chunk`
 *    수열로 와도 하나의 논리 프레임으로 복원된다.
 *  - 승인은 `extension_ui_request{select}` 로 온다. 그 프레임에는 인자가
 *    없으므로 직전 어시스턴트 메시지가 실은 도구 호출이 인자를 댄다 —
 *    카드가 무엇을 승인하는지는 그 짝이 정한다.
 *  - bypass 모드는 카드를 열지 않고 Approve 로 답한다.
 *  - 턴의 끝은 `agent_end{isTerminal !== false}` 하나다.
 *  - 브라우저 도구는 host tool 로 실리고 데몬이 in-process 로 답한다.
 *
 * Run: node --test packages/daemon/test/omp-session.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OmpAgentSession } from "../dist/agent/drivers/omp/session.js";

const dir = mkdtempSync(join(tmpdir(), "omp-session-test-"));
const AGENT = join(dir, "fake-omp.mjs");
const LOG = join(dir, "agent-log.jsonl");

/**
 * 가짜 omp — 받은 명령을 로그에 남기고 계약대로 답한다. 시나리오는 argv 로
 * 고른다: `approve` 는 도구 하나를 부르며 승인을 요청하고, `host` 는 브라우저
 * 도구를 호스트에 되묻고, `chunk` 는 큰 프레임을 rpc_chunk 로 쪼갠다.
 */
writeFileSync(
  AGENT,
  `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const LOG = ${JSON.stringify(LOG)};
const scenario = process.argv.includes("--scenario=host")
  ? "host"
  : process.argv.includes("--scenario=approve")
    ? "approve"
    : process.argv.includes("--scenario=crash")
      ? "crash"
      : "plain";
appendFileSync(LOG, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const ok = (id, command, data) =>
  out({ id, type: "response", command, success: true, ...(data ? { data } : {}) });

out({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
});

const STATE = {
  model: { provider: "zai", id: "glm-5.3-flash", name: "GLM" },
  thinkingLevel: "max",
  isStreaming: false,
  sessionId: "vendor-session-1",
  contextUsage: { tokens: 1200, contextWindow: 100000, percent: 1.2 },
};

/** 큰 논리 프레임 하나를 rpc_chunk 수열로 흘린다. */
function chunked(frame) {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const size = 64;
  const count = Math.ceil(bytes.byteLength / size);
  for (let i = 0; i < count; i++) {
    out({
      type: "rpc_chunk",
      chunkId: "c1",
      index: i,
      count,
      byteLength: bytes.byteLength,
      data: bytes.subarray(i * size, (i + 1) * size).toString("base64"),
    });
  }
}

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let m;
  try { m = JSON.parse(t); } catch { return; }
  appendFileSync(LOG, JSON.stringify(m) + "\\n");
  if (m.type === "negotiate_protocol") return ok(m.id, "negotiate_protocol", { protocolVersion: 2 });
  if (m.type === "set_host_tools") {
    return ok(m.id, "set_host_tools", { toolNames: m.tools.map((tool) => tool.name) });
  }
  if (m.type === "get_state") return ok(m.id, "get_state", STATE);
  if (m.type === "branch") return ok(m.id, "branch", { text: "dropped", cancelled: false });
  if (m.type === "set_thinking_level") return ok(m.id, "set_thinking_level");
  if (m.type === "set_model") return ok(m.id, "set_model", { id: "other" });
  if (m.type === "set_fast_mode") {
    return m.enabled
      ? ok(m.id, "set_fast_mode", { enabled: true, active: true })
      : out({ id: m.id, type: "response", command: "set_fast_mode", success: false, error: "Fast mode is unavailable for the current model." });
  }
  if (m.type === "abort") { ok(m.id, "abort"); out({ type: "agent_end", isTerminal: true }); return; }
  if (m.type === "steer") return ok(m.id, "steer");
  if (m.type === "extension_ui_response") {
    appendFileSync(LOG, JSON.stringify({ uiAnswer: m }) + "\\n");
    if (m.cancelled || m.value === "Deny") {
      out({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "denied" }] } });
    } else {
      out({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo hi" } });
      out({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "hi" }] } });
    }
    out({ type: "agent_end", isTerminal: true });
    return;
  }
  if (m.type === "host_tool_result") {
    appendFileSync(LOG, JSON.stringify({ hostResult: m }) + "\\n");
    out({ type: "agent_end", isTerminal: true });
    return;
  }
  if (m.type !== "prompt") return;
  ok(m.id, "prompt");
  out({ type: "agent_start" });
  out({ type: "message_start", message: { role: "assistant" } });
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "생각" } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "답" } });
  if (scenario === "crash") {
    // 턴 도중 프로세스가 사라진다 — agent_end 는 오지 않는다.
    setTimeout(() => process.exit(1), 20);
    return;
  }
  if (scenario === "plain") {
    // 유지보수가 뒤를 예약한 agent_end — 아직 턴의 끝이 아니다.
    out({ type: "agent_end", isTerminal: false });
    chunked({ type: "notice", level: "info", message: "긴 " + "가".repeat(200) });
    out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { cost: { total: 0.25 } } } });
    out({ type: "agent_end", isTerminal: true });
    return;
  }
  const call = scenario === "host"
    ? { type: "toolCall", id: "call-b", name: "browser_navigate", arguments: { url: "http://127.0.0.1:1/x" } }
    : { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } };
  out({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [call] } });
  if (scenario === "host") {
    out({ type: "host_tool_call", id: "host-1", toolCallId: "call-b", toolName: "browser_navigate", arguments: { url: "http://127.0.0.1:1/x" } });
    return;
  }
  out({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Allow tool: bash\\nCommand: echo hi", options: ["Approve", "Deny"] });
});
lines.on("close", () => process.exit(0));
`,
);

function readLog() {
  return readFileSync(LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeHooks() {
  const events = [];
  const asked = [];
  return {
    events,
    asked,
    hooks: {
      onEvent: (event) => events.push(event),
      onTransportEnd: () => events.push({ kind: "__end" }),
      onTransportError: (detail) => events.push({ kind: "__error", detail }),
      decidePermission: async (tool, input) => {
        asked.push({ tool, input });
        return tool.kind === "exec" && String(tool.command).includes("deny-me")
          ? { behavior: "deny", message: "no" }
          : { behavior: "allow", updatedInput: input };
      },
    },
  };
}

function open(launch, hooks, scenario = "plain") {
  rmSync(LOG, { force: true });
  return new OmpAgentSession(
    process.execPath,
    {
      cwd: dir,
      sessionId: "s1",
      model: null,
      effort: null,
      modeId: "default",
      appendSystemPrompt: null,
      ...launch,
    },
    hooks,
    [AGENT, `--scenario=${scenario}`],
  );
}

async function settle(events, predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (events.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${label} — 받은 이벤트: ${JSON.stringify(events)}`);
}

test("런치는 rpc-ui · always-ask 로 뜨고, v2 를 협상한 뒤 상태를 읽는다", async () => {
  const { hooks, events } = makeHooks();
  const session = open({ model: "zai/glm-5.3-flash", effort: "high" }, hooks);
  await settle(events, (e) => e.kind === "init", "init 이 오지 않았다");
  const log = readLog();
  const argv = log[0].argv;
  assert.ok(argv.includes("--mode") && argv[argv.indexOf("--mode") + 1] === "rpc-ui");
  assert.equal(argv[argv.indexOf("--approval-mode") + 1], "always-ask");
  assert.equal(argv[argv.indexOf("--model") + 1], "zai/glm-5.3-flash");
  assert.equal(argv[argv.indexOf("--thinking") + 1], "high");
  const commands = log.filter((row) => row.type).map((row) => row.type);
  assert.equal(commands[0], "negotiate_protocol", "첫 명령은 v2 협상이다");
  assert.ok(commands.includes("get_state"));
  const init = events.find((e) => e.kind === "init");
  assert.equal(init.sessionId, "vendor-session-1", "대화록의 주인은 에이전트가 이름한 id 다");
  assert.equal(session.vendorId, "vendor-session-1");
  assert.equal(init.model, "zai/glm-5.3-flash");
  await session.close();
});

test("턴은 agent_end{isTerminal}로만 끝나고, 큰 프레임은 청크에서 복원된다", async () => {
  const { hooks, events } = makeHooks();
  const session = open({}, hooks);
  await session.send({ text: "안녕" });
  await settle(events, (e) => e.kind === "turn.end", "turn.end 가 오지 않았다");
  assert.equal(
    events.filter((e) => e.kind === "turn.end").length,
    1,
    "예약된 agent_end 는 턴을 끝내지 않는다",
  );
  const end = events.find((e) => e.kind === "turn.end");
  assert.equal(end.subtype, "success");
  assert.equal(end.costUsd, 0.25);
  const thinking = events.find((e) => e.kind === "thinking.delta");
  const text = events.find((e) => e.kind === "text.delta");
  assert.equal(thinking.text, "생각");
  assert.equal(text.text, "답");
  assert.notEqual(thinking.blockId, text.blockId, "블록은 contentIndex 로 갈린다");
  const notice = events.find((e) => e.kind === "notice");
  assert.ok(notice.text.startsWith("긴 "), "rpc_chunk 수열이 하나의 프레임으로 복원된다");
  assert.equal(notice.text.length, 202);
  await session.close();
});

test("승인은 select 로 오고, 인자는 직전 어시스턴트 메시지의 호출에서 온다", async () => {
  const { hooks, events, asked } = makeHooks();
  const session = open({}, hooks, "approve");
  await session.send({ text: "run" });
  await settle(events, (e) => e.kind === "turn.end", "turn.end 가 오지 않았다");
  assert.equal(asked.length, 1, "승인 하나에 카드 하나");
  assert.deepEqual(asked[0].tool, { kind: "exec", name: "bash", command: "echo hi" });
  assert.deepEqual(asked[0].input, { command: "echo hi" });
  const answer = readLog().find((row) => row.uiAnswer);
  assert.equal(answer.uiAnswer.value, "Approve");
  assert.equal(answer.uiAnswer.id, "ui-1");
  await session.close();
});

test("bypass 는 카드를 열지 않고 허용으로 답한다", async () => {
  const { hooks, events, asked } = makeHooks();
  const session = open({ modeId: "bypass" }, hooks, "approve");
  await session.send({ text: "run" });
  await settle(events, (e) => e.kind === "turn.end", "turn.end 가 오지 않았다");
  assert.equal(asked.length, 0, "bypass 에서는 코어에 판단을 묻지 않는다");
  assert.equal(readLog().find((row) => row.uiAnswer).uiAnswer.value, "Approve");
  await session.close();
});

test("브라우저 도구는 host tool 로 실리고 데몬이 in-process 로 답한다", async () => {
  const { hooks, events } = makeHooks();
  const session = open(
    {
      browserMcp: {
        command: "node",
        args: [],
        env: { COLO_DAEMON_URL: "http://127.0.0.1:1", COLO_BROWSER_SECRET: "s" },
      },
    },
    hooks,
    "host",
  );
  await session.send({ text: "go" });
  await settle(events, (e) => e.kind === "turn.end", "turn.end 가 오지 않았다");
  const log = readLog();
  const registered = log.find((row) => row.type === "set_host_tools");
  assert.ok(registered, "browserMcp 가 있으면 도구를 싣는다");
  assert.ok(registered.tools.some((tool) => tool.name === "browser_navigate"));
  assert.ok(
    registered.tools.every((tool) => tool.loadMode === "essential"),
    "discoverable 은 xd:// 장치가 되어 한 겹 돌아간다",
  );
  const result = log.find((row) => row.hostResult);
  assert.equal(result.hostResult.id, "host-1");
  assert.equal(result.hostResult.isError, true, "닿지 않는 데몬도 도구 결과로 내려간다");
  await session.close();
});

test("browserMcp 가 없으면 host tool 을 싣지 않는다", async () => {
  const { hooks, events } = makeHooks();
  const session = open({}, hooks);
  await settle(events, (e) => e.kind === "init", "init 이 오지 않았다");
  assert.equal(
    readLog().some((row) => row.type === "set_host_tools"),
    false,
  );
  await session.close();
});

test("절단 포크는 버릴 프롬프트에서 branch 하고, 절단 없는 분기는 --fork 로 연다", async () => {
  const cut = makeHooks();
  const session = open(
    { resume: "old-1", forkSession: true, resumeSessionAt: "keep-9", resumeDropsTurn: "drop-9" },
    cut.hooks,
  );
  await settle(cut.events, (e) => e.kind === "init", "init 이 오지 않았다");
  const log = readLog();
  assert.equal(log[0].argv[log[0].argv.indexOf("--resume") + 1], "old-1");
  assert.equal(log.find((row) => row.type === "branch")?.entryId, "drop-9");
  await session.close();

  const whole = makeHooks();
  const forked = open({ resume: "old-1", forkSession: true }, whole.hooks);
  await settle(whole.events, (e) => e.kind === "init", "init 이 오지 않았다");
  const forkLog = readLog();
  assert.equal(forkLog[0].argv[forkLog[0].argv.indexOf("--fork") + 1], "old-1");
  assert.equal(
    forkLog.some((row) => row.type === "branch"),
    false,
    "자를 곳이 없으면 자르지 않는다",
  );
  await forked.close();
});

test("빠르게 — 에이전트가 말한 실제 상태를 알리고, 거절은 그대로 올라간다", async () => {
  const { hooks, events } = makeHooks();
  const fast = [];
  hooks.onFastMode = (on) => fast.push(on);
  const session = open({}, hooks);
  await settle(events, (e) => e.kind === "init", "init 이 오지 않았다");
  await session.setFastMode(true);
  assert.deepEqual(fast, [true]);
  await assert.rejects(() => session.setFastMode(false), /Fast mode is unavailable/);
  await session.close();
});

test("턴 도중 프로세스가 사라지면 성공이 아니라 실패로 닫힌다", async () => {
  const { hooks, events } = makeHooks();
  const session = open({}, hooks, "crash");
  await session.send({ text: "run" });
  await settle(events, (e) => e.kind === "turn.end", "죽은 턴이 닫히지 않았다");
  const end = events.find((e) => e.kind === "turn.end");
  assert.equal(end.subtype, "error_during_execution");
  assert.match(end.resultText, /끊겼습니다/);
  assert.ok(
    events.some((e) => e.kind === "__end"),
    "코어가 크래시를 볼 수 있어야 부활 경로를 탄다",
  );
  assert.equal(session.alive, false);
});

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});
