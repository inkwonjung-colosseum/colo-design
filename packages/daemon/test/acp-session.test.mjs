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
