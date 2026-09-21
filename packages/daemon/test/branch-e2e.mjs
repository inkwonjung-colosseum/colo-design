/**
 * 대화 분기(여기서 새 대화) end-to-end, fully offline: 두 답을 받은 대화의
 * 1번째 답에서 `session.branch` 로 분기하면 — 기억을 이어받은 새 대화가
 * 태어나고(id 가 다르다), 원래 대화는 목록에 그대로 남으며, 분기로 인해
 * 나가는 말은 없다(프롬프트 무전송). 스텁 CLI 가 실제 SDK fork 를 하는 대신
 * 빠르게 끝나므로 절단 재개의 폴백(새 대화 + memoryKept:false)으로도 절차 —
 * 포크 · 보존 · 무전송 · 이어 보내기 — 가 증명된다; 절단점 계산 자체는
 * session-manager.test.mjs 의 순수 함수 시험이 잡는다.
 *
 * Usage: node packages/daemon/test/branch-e2e.mjs
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-branch-e2e");

process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_PROMPT_LOG = join(DIR, "prompts.log");
process.env.COLO_DESIGN_UNDO_LOG = join(DIR, "undo.jsonl");

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
function loggingStub(dir) {
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
    token: "branch-e2e",
    claudeExecutable: loggingStub(join(DIR, "bin")),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=branch-e2e`);
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
      name: "분기",
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
    const turn2From = inbox.length;
    await request({
      type: "session.send",
      sessionId: first,
      text: "두 번째 화면",
    });
    // The stub exits 150ms after every answer — a send that lands before the
    // exit is processed goes to a dying query and surfaces as the crash card
    // (error state). The card's own promise answers it: send the same words.
    const turn2Settled = await waitFor(
      () =>
        inbox.some(
          (m, i) =>
            i >= turn2From &&
            m.type === "session.state" &&
            m.sessionId === first &&
            (m.state === "idle" || m.state === "error"),
        ),
      30_000,
      "turn 2 settle",
    ).then(() => inbox.findLast((m) => m.type === "session.state" && m.sessionId === first));
    if (turn2Settled.state === "error") {
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
        "turn 2 retry settle",
      );
    }
    const idleCount = inbox.filter(
      (m) => m.type === "session.state" && m.sessionId === first && m.state === "idle",
    ).length;
    check("two turns ran", idleCount === 2, `idle events: ${idleCount}`);

    // --- 분기: 1번째 답에서 갈라 낸다 --------------------------------------
    const before = readPrompts(promptLog);
    const branched = await request({
      type: "session.branch",
      sessionId: first,
      turn: 1,
    });
    check(
      "the branch answers with a NEW conversation id",
      typeof branched.sessionId === "string" && branched.sessionId !== first,
      `${first.slice(0, 8)}… → ${String(branched.sessionId).slice(0, 8)}…`,
    );
    check(
      "memoryKept names the fallback honestly when the stub cannot fork",
      typeof branched.memoryKept === "boolean",
      String(branched.memoryKept),
    );
    check(
      "the branch sends no words — the next turn is the user's",
      readPrompts(promptLog) === before,
      "prompts.log unchanged",
    );
    const listed = await request({ type: "session.list" });
    check(
      "the original conversation survives the branch",
      listed.some((s) => s.sessionId === first),
      listed.map((s) => s.sessionId.slice(0, 8)).join(","),
    );

    // 분기한 대화는 이어지는 대화다 — 다음 말은 그 대화의 턴으로 나간다.
    await request({
      type: "session.send",
      sessionId: branched.sessionId,
      text: "분기-이후-마커",
    });
    await waitFor(() => readPrompts(promptLog).includes("분기-이후-마커"), 10_000, "branch prompt");
    check(
      "the branched conversation carries the next turn",
      readPrompts(promptLog).includes("분기-이후-마커"),
      "prompts.log diff",
    );

    // 마지막 답에서의 분기도 같은 절차다 — 잘라낼 것이 없을 뿐.
    const last = await request({
      type: "session.branch",
      sessionId: first,
      turn: 2,
    });
    check(
      "branching at the last answer also opens a NEW conversation",
      typeof last.sessionId === "string" && last.sessionId !== first,
      String(last.sessionId).slice(0, 8),
    );
    const afterLast = await request({ type: "session.list" });
    check(
      "both the original and the branch are listed",
      afterLast.some((s) => s.sessionId === first) &&
        afterLast.some((s) => s.sessionId === branched.sessionId) &&
        afterLast.some((s) => s.sessionId === last.sessionId),
      `${afterLast.length} rows`,
    );

    // 없는 대화의 분기는 거절이 정직한 답이다.
    let refused = "";
    try {
      await request({ type: "session.branch", sessionId: "no-such-thread", turn: 1 });
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    check(
      "branching an unknown conversation is refused, not invented",
      refused.includes("대화가 이미 닫혔습니다"),
      refused,
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
