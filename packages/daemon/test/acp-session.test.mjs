/**
 * AcpAgentSession의 공급자별 배선 검사 — 가짜 ACP 에이전트(stdout 줄 JSON-RPC)
 * 위에서 실제 세션 클래스가 무슨 요청을 보내는지 잠근다.
 *
 * 계약: launch.browserMcp → session/new의 mcpServers에 colo-browser stdio
 * 서버(절대경로·args·env 필수 형태) / launch.effort + effortConfigId →
 * session/set_config_option 핀 / setEffort(null) → 초기값 복원 / models()는
 * enrichModels를 통과한다. browserMcp가 없으면 mcpServers는 빈 배열.
 *
 * Run: node --test packages/daemon/test/acp-session.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserMcpEntry } from "../dist/browser-launch.js";

const { AcpAgentSession } = await import("../dist/agent/drivers/acp/session.js");

const dir = mkdtempSync(join(tmpdir(), "acp-session-test-"));
const AGENT_SCRIPT = join(dir, "fake-agent.mjs");
const LOG = join(dir, "agent-log.jsonl");

/**
 * 가짜 에이전트 — 받은 요청을 로그에 남기고 계약대로 답한다. configOptions는
 * omp의 형태를 따라 한다: model select + thinking(off/auto/low/high/max,
 * 초기값 max).
 */
writeFileSync(
  AGENT_SCRIPT,
  `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const LOG = ${JSON.stringify(LOG)};
const configOptions = [
  {
    id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
    options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }],
  },
  {
    id: "model", name: "Model", category: "model", type: "select", currentValue: "fake/one",
    options: [
      { value: "fake/one", name: "One" },
      { value: "fake/two", name: "Two" },
    ],
  },
  {
    id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "max",
    options: [
      { value: "off", name: "Off" }, { value: "auto", name: "Auto" },
      { value: "low", name: "low" }, { value: "high", name: "high" }, { value: "max", name: "max" },
    ],
  },
];
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let m; try { m = JSON.parse(t); } catch { return; }
  appendFileSync(LOG, JSON.stringify({ method: m.method, params: m.params }) + "\\n");
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "initialize") {
    result = {
      protocolVersion: 1,
      agentInfo: { name: "fake", version: "0" },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
    };
  } else if (m.method === "session/new" || m.method === "session/resume") {
    result = {
      sessionId: "fake-session-1",
      configOptions,
      modes: {
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
        currentModeId: "default",
      },
    };
  } else if (m.method === "session/prompt") {
    result = { stopReason: "end_turn" };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
lines.on("close", () => process.exit(0));
`,
);

function readLog() {
  try {
    return readFileSync(LOG, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function resetLog() {
  rmSync(LOG, { force: true });
}

/** 세션을 띄우고 init 이벤트(핸드셰이크 완료)까지 기다린다. */
async function withSession({ launch, wiring }, run) {
  const events = [];
  let onInit;
  const initDone = new Promise((resolve) => {
    onInit = resolve;
  });
  const hooks = {
    onEvent: (event) => {
      events.push(event);
      if (event.kind === "init") onInit();
    },
    onTransportEnd: () => {},
    onTransportError: () => {},
    decidePermission: async () => ({ behavior: "deny", message: "테스트 거절" }),
  };
  const session = new AcpAgentSession(
    "omp",
    process.execPath,
    [AGENT_SCRIPT],
    {
      cwd: dir,
      sessionId: "core-1",
      model: null,
      effort: null,
      modeId: "default",
      appendSystemPrompt: null,
      ...launch,
    },
    hooks,
    wiring,
  );
  try {
    await initDone;
    return await run(session);
  } finally {
    // 실패 경로에서도 자식을 거둔다 — 살아남은 자식이 테스트 러너를 붙듦.
    await session.close();
  }
}

function calls(log, method) {
  return log.filter((entry) => entry.method === method).map((entry) => entry.params);
}

test("browserMcp launch rides session/new as the colo-browser stdio server", async () => {
  resetLog();
  const entry = browserMcpEntry(true, "http://127.0.0.1:7823", "s3cret");
  assert.ok(entry);
  await withSession({ launch: { browserMcp: entry }, wiring: {} }, () => {
    const created = calls(readLog(), "session/new");
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].mcpServers, [
      {
        type: "stdio",
        name: "colo-browser",
        command: entry.command,
        args: entry.args,
        env: [
          { name: "COLO_DAEMON_URL", value: "http://127.0.0.1:7823" },
          { name: "COLO_BROWSER_SECRET", value: "s3cret" },
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        ],
      },
    ]);
  });
});

test("no browserMcp launch keeps mcpServers empty", async () => {
  resetLog();
  await withSession({ launch: {}, wiring: {} }, () => {
    const created = calls(readLog(), "session/new");
    assert.deepEqual(created[0].mcpServers, []);
  });
});

test("launch effort pins the thinking config option; setEffort rides the same id", async () => {
  resetLog();
  await withSession(
    { launch: { effort: "low" }, wiring: { effortConfigId: "thinking" } },
    async (session) => {
      // setEffort queues behind `this.ready` — the handshake's own launch
      // pin has landed by the time the first runtime call resolves, so the
      // single log read below sees all three values in order.
      await session.setEffort("high");
      await session.setEffort(null);
      const pins = calls(readLog(), "session/set_config_option");
      assert.ok(
        pins.some((p) => p.configId === "thinking" && p.value === "low"),
        `launch.effort must pin thinking: ${JSON.stringify(pins)}`,
      );
      assert.ok(pins.some((p) => p.configId === "thinking" && p.value === "high"));
      // null = the agent's own open value comes back.
      assert.ok(pins.some((p) => p.configId === "thinking" && p.value === "max"));
    },
  );
});

test("setEffort throws when the config declares no effort wire", async () => {
  resetLog();
  await withSession({ launch: {}, wiring: {} }, async (session) => {
    await assert.rejects(() => session.setEffort("low"), /노력 수준/);
  });
});

test("models() rows pass through enrichModels", async () => {
  resetLog();
  await withSession(
    {
      launch: {},
      wiring: {
        enrichModels: (rows) =>
          rows.map((row) =>
            row.value === "fake/one"
              ? { ...row, supportsEffort: true, supportedEffortLevels: ["low", "high"] }
              : row,
          ),
      },
    },
    async (session) => {
      const rows = await session.models();
      assert.deepEqual(
        rows.map((r) => r.value),
        ["fake/one", "fake/two"],
      );
      assert.equal(rows[0].supportsEffort, true);
      assert.deepEqual(rows[0].supportedEffortLevels, ["low", "high"]);
      assert.equal(rows[1].supportsEffort, false);
    },
  );
});

test("bypass rides the mode picker and never reaches the wire as set_mode", async () => {
  resetLog();
  await withSession({ launch: {}, wiring: {} }, async (session) => {
    const rows = await session.modes();
    assert.deepEqual(
      rows.map((r) => r.id),
      ["default", "plan", "bypass"],
    );
    await session.setMode("bypass");
    // 와이어로 set_mode 는 하나도 안 간다 — default 는 이미 현재 모드고,
    // bypass 는 데몬이 집행하는 방식이라 에이전트에 보낼 게 없다.
    assert.deepEqual(calls(readLog(), "session/set_mode"), []);
  });
});

function permissionSession(modeId, onDecision) {
  const events = [];
  const hooks = {
    onEvent: (event) => events.push(event),
    onTransportEnd: () => {},
    onTransportError: () => {},
    decidePermission: async () => {
      onDecision();
      return { behavior: "deny", message: "테스트 거절" };
    },
  };
  const session = new AcpAgentSession(
    "omp",
    process.execPath,
    [PERMISSION_AGENT_SCRIPT],
    {
      cwd: dir,
      sessionId: "core-1",
      model: null,
      effort: null,
      modeId,
      appendSystemPrompt: null,
    },
    hooks,
    {},
  );
  return { session, events };
}

test("bypass mode answers permissions with allow and never opens a card", async () => {
  resetLog();
  let decisions = 0;
  const { session, events } = permissionSession("bypass", () => {
    decisions += 1;
  });
  try {
    await new Promise((resolve) => {
      const poll = () => (events.some((e) => e.kind === "init") ? resolve() : setTimeout(poll, 25));
      poll();
    });
    await session.send({ text: "고쳐줘" });
    const answers = readLog().filter((e) => e.permissionAnswer);
    assert.equal(answers.length, 1);
    assert.equal(answers[0].permissionAnswer.outcome.optionId, "allow-once");
    assert.equal(decisions, 0);
  } finally {
    await session.close();
  }
});

test("default mode asks the card flow and honors its denial", async () => {
  resetLog();
  let decisions = 0;
  const { session, events } = permissionSession("default", () => {
    decisions += 1;
  });
  try {
    await new Promise((resolve) => {
      const poll = () => (events.some((e) => e.kind === "init") ? resolve() : setTimeout(poll, 25));
      poll();
    });
    await session.send({ text: "고쳐줘" });
    const answers = readLog().filter((e) => e.permissionAnswer);
    assert.equal(answers.length, 1);
    assert.equal(answers[0].permissionAnswer.outcome.optionId, "reject-once");
    assert.equal(decisions, 1);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// interrupt() 회귀 — 부팅 창의 오판과 wedged 취소. 각각 전용 가짜 에이전트가
// 필요하다: session/new 를 늦게 답하는 것, session/prompt 를 영원히 안 답는
// 것, loadSession 을 거부하는 것.
// ---------------------------------------------------------------------------

const SLOW_AGENT_SCRIPT = join(dir, "slow-agent.mjs");
writeFileSync(
  SLOW_AGENT_SCRIPT,
  `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let m; try { m = JSON.parse(t); } catch { return; }
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "initialize") {
    result = { protocolVersion: 1, agentCapabilities: {} };
  } else if (m.method === "session/new") {
    // 부팅 창을 연다 — initialize 는 즉시, session/new 는 300ms 뒤에 답한다.
    result = { sessionId: "slow-session-1" };
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    }, 300);
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
lines.on("close", () => process.exit(0));
`,
);

const WEDGED_AGENT_SCRIPT = join(dir, "wedged-agent.mjs");
writeFileSync(
  WEDGED_AGENT_SCRIPT,
  `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const LOG = ${JSON.stringify(LOG)};
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let m; try { m = JSON.parse(t); } catch { return; }
  appendFileSync(LOG, JSON.stringify({ method: m.method, params: m.params }) + "\\n");
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "initialize") {
    result = { protocolVersion: 1, agentCapabilities: {} };
  } else if (m.method === "session/new") {
    result = { sessionId: "wedged-session-1" };
  } else if (m.method === "session/prompt") {
    return; // wedged — session/cancel 이 와도 프롬프트는 영원히 안 풀린다.
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
lines.on("close", () => process.exit(0));
`,
);

const PERMISSION_AGENT_SCRIPT = join(dir, "permission-agent.mjs");
writeFileSync(
  PERMISSION_AGENT_SCRIPT,
  `
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const LOG = ${JSON.stringify(LOG)};
const lines = createInterface({ input: process.stdin, terminal: false });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
let pendingPrompt = null;
lines.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let m; try { m = JSON.parse(t); } catch { return; }
  appendFileSync(LOG, JSON.stringify(m) + "\\n");
  if (m.id !== undefined && m.method) {
    let result = {};
    if (m.method === "initialize") {
      result = { protocolVersion: 1, agentCapabilities: {} };
    } else if (m.method === "session/new") {
      result = {
        sessionId: "fake-session-1",
        modes: { availableModes: [{ id: "default", name: "Default" }], currentModeId: "default" },
      };
    } else if (m.method === "session/prompt") {
      pendingPrompt = m.id;
      send({
        jsonrpc: "2.0", id: "perm-1", method: "session/request_permission",
        params: {
          options: [
            { kind: "allow_once", optionId: "allow-once", name: "Allow" },
            { kind: "reject_once", optionId: "reject-once", name: "Reject" },
          ],
          toolCall: { kind: "execute", title: "bash", rawInput: { command: "rm -rf /" } },
        },
      });
      return;
    }
    send({ jsonrpc: "2.0", id: m.id, result });
    return;
  }
  if (m.id === "perm-1") {
    appendFileSync(LOG, JSON.stringify({ permissionAnswer: m.result }) + "\\n");
    send({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "end_turn" } });
    pendingPrompt = null;
  }
});
lines.on("close", () => process.exit(0));
`,
);

const REFUSING_AGENT_SCRIPT = join(dir, "refusing-agent.mjs");
writeFileSync(
  REFUSING_AGENT_SCRIPT,
  `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let m; try { m = JSON.parse(t); } catch { return; }
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "initialize") {
    // loadSession: false — resume 요청은 핸드셰이크 안에서 거절된다.
    result = { protocolVersion: 1, agentCapabilities: { loadSession: false } };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
lines.on("close", () => process.exit(0));
`,
);

function makeHooks(events) {
  const state = { transportEnded: false, transportError: null };
  const hooks = {
    onEvent: (event) => events.push(event),
    onTransportEnd: () => {
      state.transportEnded = true;
    },
    onTransportError: (detail) => {
      state.transportError = detail;
    },
    decidePermission: async () => ({ behavior: "deny", message: "테스트 거절" }),
  };
  return { hooks, state };
}

function makeSession(script, launch) {
  const events = [];
  const { hooks, state } = makeHooks(events);
  const session = new AcpAgentSession(
    "omp",
    process.execPath,
    [script],
    {
      cwd: dir,
      sessionId: "core-1",
      model: null,
      effort: null,
      modeId: "default",
      appendSystemPrompt: null,
      ...launch,
    },
    hooks,
    {},
  );
  return { session, events, state };
}

async function waitFor(cond, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("interrupt during the boot window waits for ready instead of judging dead", async () => {
  const { session } = makeSession(SLOW_AGENT_SCRIPT, {});
  try {
    // session/new 가 아직 안 답한 창 — vendorSessionId 는 null 이지만 전송은
    // 살아 있다. dead 로 읽으면 코어가 멀쩡한 부팅 세션을 닫아 버린다.
    const outcome = await session.interrupt();
    assert.equal(outcome, "answered");
    assert.equal(session.alive, true);
  } finally {
    await session.close();
  }
});

test("interrupt on a wedged prompt escalates to transport close after the grace", async () => {
  resetLog();
  const { session, state } = makeSession(WEDGED_AGENT_SCRIPT, {});
  try {
    await waitFor(() => calls(readLog(), "session/new").length > 0);
    void session.send({ text: "hello" });
    await waitFor(() => calls(readLog(), "session/prompt").length > 0);
    const outcome = await session.interrupt();
    assert.equal(outcome, "timeout");
    // 전송이 끊겨 크래시 기계(onTransportEnd)가 돌고, 막혀 있던 프롬프트도
    // 함께 풀려 sendChain 이 서지 않는다.
    await waitFor(() => state.transportEnded);
    assert.equal(session.alive, false);
  } finally {
    await session.close();
  }
});

test("handshake rejection kills the child and surfaces as a transport error", async () => {
  const { session, state } = makeSession(REFUSING_AGENT_SCRIPT, { resume: "vendor-old" });
  try {
    await waitFor(() => state.transportError !== null);
    assert.match(state.transportError, /재개를 지원하지 않습니다/);
    // 자식은 죽고 alive 는 거짓 — 코어가 이 세션을 sendable 로 보지 않는다.
    assert.equal(session.alive, false);
    // 보고는 onTransportError 한 번 — 죽은 뒤 onTransportEnd 가 겹치지 않는다.
    assert.equal(state.transportEnded, false);
    // 뒤에 선 await 도 같은 거절을 받는다.
    await assert.rejects(() => session.send({ text: "x" }), /재개를 지원하지 않습니다/);
  } finally {
    await session.close();
  }
});
