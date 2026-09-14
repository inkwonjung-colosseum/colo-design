/**
 * 되감기 end-to-end (PLAN D95), fully offline: 두 답을 받은 뒤 `session.rewind`
 * 로 두 번째 답을 버리면 — 파일이 그 전으로 돌고(체크포인트 복원), 대화는 새
 * id 로 이어지며, 고친 문장이 다시 나간다. 스텁 CLI 가 실제 SDK fork 를 하는
 * 대신 빠르게 끝나므로 이 스위트가 증명하는 것은 절차(복원 · fork · 재전송 ·
 * 목록 정리)까지다; 실 CLI 의 절단 재개 검증은 PLAN 이 스파이크로 요구한다.
 *
 * Usage: node packages/daemon/test/rewind-e2e.mjs
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-rewind-e2e");

process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_PROMPT_LOG = join(DIR, "prompts.log");

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") throw new Error(`check("${name}") needs a verdict`);
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await predicate();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** 로그를 남기는 한 턴 스텁: user 줄을 만나면 result 를 출력하고 끝난다. */
function loggingStub(dir, logPath) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("fs");',
      'if (process.argv[2] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (process.argv[2] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"p@x.com"}\');',
      "  process.exit(0);",
      "}",
      "const log = process.env.COLO_PROMPT_LOG;",
      'let buf = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => {',
      "  buf += chunk;",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      '    if (line.includes(\'"type":"user"\')) {',
      '      if (log) { try { fs.appendFileSync(log, line + "\\n"); } catch {} }',
      '      const sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || "stub";',
      "      process.stdout.write(JSON.stringify({",
      '        type: "result", subtype: "success", is_error: false,',
      '        session_id: sessionId, result: "넵", num_turns: 1, duration_ms: 5,',
      '      }) + "\\n");',
      "      setTimeout(() => process.exit(0), 150);",
      "      return;",
      "    }",
      "  }",
      "});",
      'process.stdin.on("end", () => process.exit(0));',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const promptLog = process.env.COLO_PROMPT_LOG;
  const fixture = await createFixtureRepo({
    dir: join(DIR, "fixture"),
    port: await freePort(),
  });

  const port = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port,
    token: "rewind-e2e",
    claudeExecutable: loggingStub(join(DIR, "bin"), promptLog),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=rewind-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((ok, fail) => {
    ws.once("open", ok);
    ws.once("error", fail);
  });
  let nextId = 0;
  const request = async (message, timeoutMs = 120_000) => {
    nextId += 1;
    const id = `m${nextId}`;
    ws.send(JSON.stringify({ ...message, id }));
    const reply = await waitFor(() => inbox.find((m) => m.id === id), timeoutMs, message.type);
    if (reply.type === "ok") return reply.data;
    throw new Error(reply.message);
  };

  try {
    await request({
      type: "project.create",
      name: "되감기",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    const ready = await waitFor(
      async () => {
        const status = await request({ type: "repo.status" });
        return status.phase === "ready" || status.phase === "error" ? status : null;
      },
      60_000,
      "repo ready",
    );
    check("the fixture repo is ready", ready.phase === "ready", ready.detail ?? "");

    const { sessionId: first } = await request({ type: "session.create" });
    await request({
      type: "session.send",
      sessionId: first,
      text: "첫 번째 화면",
    });
    await waitFor(
      () =>
        inbox.some(
          (m) => m.type === "session.state" && m.sessionId === first && m.state === "idle",
        ),
      30_000,
      "turn 1 settle",
    );
    await request({
      type: "session.send",
      sessionId: first,
      text: "두 번째 화면",
    });
    await waitFor(
      () =>
        inbox.some(
          (m) => m.type === "session.state" && m.sessionId === first && m.state === "idle",
        ),
      30_000,
      "turn 2 settle",
    );
    check("two turns ran", true);

    // The checkpoint write rides the send asynchronously — poll for it.
    const checkpoints = await waitFor(
      async () => {
        const list = await request({ type: "repo.checkpoints" });
        return list.entries.some((e) => e.turn === 2) ? list : null;
      },
      10_000,
      "checkpoint 2",
    );
    check(
      "the turns left per-turn checkpoints",
      checkpoints.entries.some((e) => e.turn === 2),
      JSON.stringify(checkpoints.entries.map((e) => e.turn)),
    );

    const before = readPrompts(promptLog);
    const rewound = await request({
      type: "session.rewind",
      sessionId: first,
      turn: 2,
      text: "두 번째 화면, 대신 이렇게 고쳐 주세요",
    });
    check(
      "the rewind answers with a session to carry on in",
      typeof rewound.sessionId === "string" && rewound.sessionId !== first,
      `${first.slice(0, 8)}… → ${rewound.sessionId.slice(0, 8)}…`,
    );
    check(
      "memoryKept names the fallback honestly when the stub cannot fork",
      typeof rewound.memoryKept === "boolean",
      String(rewound.memoryKept),
    );
    await waitFor(() => readPrompts(promptLog).includes("고쳐 주세요"), 10_000, "resent prompt");
    const after = readPrompts(promptLog);
    check(
      "the corrected words went out again",
      after.includes("고쳐 주세요") && !before.includes("고쳐 주세요"),
      "prompts.log diff",
    );
    const listed = await request({ type: "session.list" });
    check(
      "the old conversation is gone from the list",
      !listed.some((s) => s.sessionId === first),
      listed.map((s) => s.sessionId.slice(0, 8)).join(","),
    );
  } finally {
    ws.close();
    await server.stop();
    rmSync(DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

function readPrompts(log) {
  try {
    return readFileSync(log, "utf8");
  } catch {
    return "";
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
