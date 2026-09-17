/**
 * 브라우저 MCP stdio 서버(browser-mcp.ts)와 기동 명세 빌더(browser-launch.ts)의
 * 단위 검사 — 가짜 데몬 HTTP 서버 위에서 돈다.
 *
 * 계약: initialize 악수 / tools/list 16개 / tools/call이 /internal/browser로
 * 올바른 op·params·Bearer 시크릿으로 중계 / 데몬의 401·404·ok:false가 isError
 * 도구 결과로 매핑 / 빌더의 3형태(claude 레코드·acp 배열·codex config 객체)가
 * 계약과 정확히 일치.
 *
 * Run: node --test packages/daemon/test/browser-mcp.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acpBrowserMcpServer,
  BROWSER_MCP_SERVER_NAME,
  browserMcpEntry,
  claudeBrowserMcpServer,
  codexBrowserMcpServer,
} from "../dist/browser-launch.js";

const MCP_SCRIPT = fileURLToPath(new URL("../dist/browser-mcp.js", import.meta.url));
const SECRET = "test-secret-0123456789";

const TOOL_NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_hover",
  "browser_select",
  "browser_drag",
  "browser_wait",
  "browser_console",
  "browser_evaluate",
  "browser_back",
  "browser_forward",
];

/** 가짜 데몬 — /internal/browser 요청을 기록하고 handler가 답을 정한다. */
async function startFakeDaemon(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      calls.push({
        url: req.url,
        method: req.method,
        auth: req.headers.authorization,
        body,
      });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

/** stdio MCP 자식 — 줄 단위 JSON-RPC로 말하고 id로 응답을 짝짓는다. */
function startMcp(daemonUrl, secret) {
  const child = spawn(process.execPath, [MCP_SCRIPT], {
    env: { ...process.env, COLO_DAEMON_URL: daemonUrl, COLO_BROWSER_SECRET: secret },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  child.stderr.resume();
  return {
    rpc: (method, params) => {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
          (error) => {
            if (error) reject(error);
          },
        );
      });
    },
    notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

test("initialize 악수와 tools/list의 16개 도구", async () => {
  const daemon = await startFakeDaemon((_req, res) => res.writeHead(404).end());
  const mcp = startMcp(daemon.url, SECRET);
  try {
    const init = await mcp.rpc("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "test" },
    });
    // 서버는 클라이언트가 제안한 프로토콜 버전을 그대로 따른다.
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(init.result.serverInfo.name, "colo-browser");
    assert.ok(init.result.capabilities.tools);
    mcp.notify("notifications/initialized");
    const ping = await mcp.rpc("ping");
    assert.deepEqual(ping.result, {});
    const list = await mcp.rpc("tools/list");
    const names = list.result.tools.map((tool) => tool.name);
    assert.equal(names.length, 16);
    assert.deepEqual(new Set(names), new Set(TOOL_NAMES));
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name}의 inputSchema`);
    }
  } finally {
    mcp.close();
    daemon.close();
  }
});

test("tools/call이 /internal/browser로 op·params·시크릿을 중계한다", async () => {
  const daemon = await startFakeDaemon((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { settled: true } }));
  });
  const mcp = startMcp(daemon.url, SECRET);
  try {
    await mcp.rpc("initialize", {});
    const call = await mcp.rpc("tools/call", {
      name: "browser_navigate",
      arguments: { url: "http://localhost:3000/members" },
    });
    assert.equal(daemon.calls.length, 1);
    const seen = daemon.calls[0];
    assert.equal(seen.url, "/internal/browser");
    assert.equal(seen.method, "POST");
    assert.equal(seen.auth, `Bearer ${SECRET}`);
    assert.deepEqual(seen.body, {
      op: "navigate",
      params: { url: "http://localhost:3000/members" },
    });
    assert.equal(call.result.isError, undefined);
    assert.deepEqual(JSON.parse(call.result.content[0].text), { settled: true });
  } finally {
    mcp.close();
    daemon.close();
  }
});

test("이름이 다른 도구의 op 매핑 — fill→type, wait→waitFor, console→consoleLines", async () => {
  const daemon = await startFakeDaemon((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: null }));
  });
  const mcp = startMcp(daemon.url, SECRET);
  try {
    await mcp.rpc("initialize", {});
    await mcp.rpc("tools/call", {
      name: "browser_fill",
      arguments: { ref: "e3", text: "안녕", clear: false },
    });
    await mcp.rpc("tools/call", {
      name: "browser_wait",
      arguments: { text: "완료", ms: 500 },
    });
    await mcp.rpc("tools/call", { name: "browser_console", arguments: {} });
    assert.deepEqual(
      daemon.calls.map((call) => call.body),
      [
        { op: "type", params: { ref: "e3", text: "안녕", clear: false } },
        { op: "waitFor", params: { text: "완료", ms: 500 } },
        { op: "consoleLines", params: {} },
      ],
    );
  } finally {
    mcp.close();
    daemon.close();
  }
});

test("데몬의 ok:false는 isError 도구 결과로 내려간다", async () => {
  const daemon = await startFakeDaemon((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "stale ref e3" }));
  });
  const mcp = startMcp(daemon.url, SECRET);
  try {
    await mcp.rpc("initialize", {});
    const call = await mcp.rpc("tools/call", {
      name: "browser_click",
      arguments: { ref: "e3" },
    });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /stale ref e3/);
  } finally {
    mcp.close();
    daemon.close();
  }
});

test("시크릿 불일치 401과 pane 없음 404가 isError로 매핑된다", async () => {
  // 가짜 데몬은 SECRET만 받는다 — 다른 시크릿은 401, 맞는 시크릿은 pane 없음 404.
  const daemon = await startFakeDaemon((req, res) => {
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "no pane" }));
  });
  const wrong = startMcp(daemon.url, "wrong-secret");
  try {
    const call = await wrong.rpc("tools/call", {
      name: "browser_snapshot",
      arguments: {},
    });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /401/);
  } finally {
    wrong.close();
  }
  const right = startMcp(daemon.url, SECRET);
  try {
    const call = await right.rpc("tools/call", {
      name: "browser_snapshot",
      arguments: {},
    });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /404/);
  } finally {
    right.close();
    daemon.close();
  }
});

test("빌더의 3형태가 계약과 정확히 일치한다", () => {
  const entry = browserMcpEntry(true, "http://127.0.0.1:7823", "s3cret");
  assert.ok(entry);
  assert.ok(entry.command.length > 0);
  assert.equal(entry.args.length, 1);
  assert.ok(entry.args[0].endsWith("browser-mcp.js"));
  assert.ok(isAbsolute(entry.args[0]), "스크립트 경로는 절대경로");
  assert.deepEqual(entry.env, {
    COLO_DAEMON_URL: "http://127.0.0.1:7823",
    COLO_BROWSER_SECRET: "s3cret",
    ELECTRON_RUN_AS_NODE: "1",
  });

  // claude — query options.mcpServers의 레코드 값.
  assert.deepEqual(claudeBrowserMcpServer(entry), {
    type: "stdio",
    command: entry.command,
    args: entry.args,
    env: {
      COLO_DAEMON_URL: "http://127.0.0.1:7823",
      COLO_BROWSER_SECRET: "s3cret",
      ELECTRON_RUN_AS_NODE: "1",
    },
  });
  // acp — session/new mcpServers의 배열 원소: command 절대경로·args·env 필수.
  assert.deepEqual(acpBrowserMcpServer(entry), {
    type: "stdio",
    name: BROWSER_MCP_SERVER_NAME,
    command: entry.command,
    args: entry.args,
    env: [
      { name: "COLO_DAEMON_URL", value: "http://127.0.0.1:7823" },
      { name: "COLO_BROWSER_SECRET", value: "s3cret" },
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
    ],
  });
  // codex — thread/start config.mcp_servers의 표 객체.
  assert.deepEqual(codexBrowserMcpServer(entry), {
    command: entry.command,
    args: entry.args,
    env: {
      COLO_DAEMON_URL: "http://127.0.0.1:7823",
      COLO_BROWSER_SECRET: "s3cret",
      ELECTRON_RUN_AS_NODE: "1",
    },
  });
  // 팩토리 미주입 → null — 세션은 브라우저 도구 없이 열린다.
  assert.equal(browserMcpEntry(false, "http://127.0.0.1:7823", "s3cret"), null);
});
