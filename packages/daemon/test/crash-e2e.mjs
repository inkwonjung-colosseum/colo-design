/**
 * 죽은 CLI 로부터의 회복, 오프라인 e2e: 스텁 CLI 가 첫 턴 한가운데서(응답 없이)
 * exit 1 로 죽는다 — 세션은 크래시 카드와 함께 error 상태가 되고, 그 이후의
 * send 는 조용히 사라지는 대신 거절로 돌아가며, 같은 id 의 resume 이 새 CLI
 * 에서 대화를 이어받아 다음 말에 답한다. 크래시 카드의 "다시 보내면
 * 이어집니다" 약속을 와이어 위에서 고정하는 스위트다.
 *
 * Usage: node packages/daemon/test/crash-e2e.mjs
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-crash-e2e");

process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_DESIGN_REPO_SETTINGS = join(DIR, "settings.json");
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_REPO_DIR = join(DIR, "work");

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await predicate();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * The CLI this suite's sessions speak to. The FIRST process invocation dies
 * mid-turn — a user line arrives, the process answers nothing and exits 1
 * (stderr noise included, the way a real crash reads). Every later invocation
 * is a healthy CLI: it answers the handshake and ends the turn with a plain
 * success result. A marker file decides which one a spawn is.
 */
function stubClaude(dir) {
  const path = join(dir, "claude");
  const marker = join(dir, "crashed.flag");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const marker = ${JSON.stringify(marker)};`,
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (args[0] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
      "  process.exit(0);",
      "}",
      'let buf = "";',
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "const seen = () => {",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      "    let o = null; try { o = JSON.parse(line); } catch { continue; }",
      '    if (o.type === "control_request") {',
      "      const sub = String(o.request && o.request.subtype);",
      "      let payload = {};",
      '      if (sub === "initialize") payload = { models: [], commands: [], agents: [] };',
      '      if (sub === "initialize" || sub === "interrupt" || sub === "set_permission_mode") send({ type: "control_response", response: { subtype: "success", request_id: o.request_id, response: payload } });',
      "      continue;",
      "    }",
      '    if (o.type === "user") {',
      "      if (!fs.existsSync(marker)) {",
      "        fs.writeFileSync(marker, String(Date.now()));",
      "        process.stderr.write('stub: unexpected condition in turn\\n');",
      "        process.exit(1);",
      "      }",
      '      const sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || \'stub\';',
      "      setTimeout(() => send({",
      '        type: "result", subtype: "success", is_error: false,',
      '        session_id: sessionId, result: "이어서 만들겠습니다.", num_turns: 1, duration_ms: 5,',
      "      }), 50);",
      "    }",
      "  }",
      "};",
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { buf += chunk; seen(); });',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  process.env.COLO_DESIGN_CLAUDE_BIN = stubClaude(join(DIR, "claude-config"));

  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });
  process.env.COLO_DESIGN_REPO_URL = fixture.remote;

  const daemonPort = await freePort();
  const notices = [];
  const server = new DaemonServer({
    host: "127.0.0.1",
    port: daemonPort,
    token: "crash-e2e",
    onNotice: (notice) => notices.push(notice),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}?token=crash-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  let seq = 0;
  /** A request whose ERROR reply is the expected outcome, not a throw. */
  const rawRequest = async (type, extra = {}, timeoutMs = 60_000) => {
    const id = `m${++seq}`;
    ws.send(JSON.stringify({ id, type, ...extra }));
    return await waitFor(() => inbox.find((m) => m.id === id), timeoutMs, type);
  };
  const request = async (type, extra = {}, timeoutMs = 60_000) => {
    const reply = await rawRequest(type, extra, timeoutMs);
    if (reply.type !== "ok") throw new Error(`${type} failed: ${reply.message}`);
    return reply.data;
  };
  const events = (kind) => inbox.filter((m) => m.type === kind);

  try {
    // --- 준비: 활성 프로젝트가 있어야 세션의 cwd 가 생긴다 ------------------
    const ready = await request("repo.sync");
    check("the fixture repo clones", ready.phase === "ready", ready.detail ?? "");

    // --- 1. 첫 턴 한가운데 CLI 가 죽는다 ------------------------------------
    const { sessionId } = await request("session.create", {});
    await request("session.send", { sessionId, text: "회원가입 화면 만들어 줘" });

    const crashNotice = await waitFor(
      () =>
        events("session.event").find(
          (m) =>
            m.sessionId === sessionId &&
            m.event.kind === "notice" &&
            m.event.level === "error" &&
            m.event.text.startsWith("Claude가 예상 밖으로 멈췄습니다"),
        ),
      30_000,
      "the crash card",
    );
    check(
      "the crash card carries the raw detail below the Korean lead",
      crashNotice.event.text.includes("exited with code") ||
        crashNotice.event.text.split("\n").length > 1,
      crashNotice.event.text.split("\n").at(-1) ?? "",
    );
    await waitFor(
      () => events("session.state").some((m) => m.sessionId === sessionId && m.state === "error"),
      30_000,
      "the error state",
    );
    check(
      "the crash fired the planner's crashed notice",
      notices.some((n) => n.kind === "crashed" && n.sessionId === sessionId),
      JSON.stringify(notices),
    );

    // --- 2. 죽은 세션에 다시 보내면 삼켜지는 대신 재개가 이어받는다 ---------
    // The crash card promised "다시 보내면 이어집니다" — the daemon keeps that
    // promise itself: the send lands in a fresh CLI that resumed the same
    // thread, and the stub (past its crash now) answers in place.
    const resend = await rawRequest("session.send", {
      sessionId,
      text: "이어서 만들어 줘",
    });
    check(
      "a send into the dead session is resumed, not swallowed",
      resend.type === "ok",
      `${resend.type}: ${resend.message ?? ""}`,
    );
    const answer = await waitFor(
      () =>
        events("session.event").find(
          (m) =>
            m.sessionId === sessionId &&
            m.event.kind === "turn.end" &&
            m.event.subtype === "success",
        ),
      30_000,
      "the resumed turn's answer",
    );
    check(
      "the resumed turn answers in the same thread",
      answer.event.resultText === "이어서 만들겠습니다.",
      String(answer.event.resultText),
    );
    await waitFor(
      () =>
        events("session.state")
          .filter((m) => m.sessionId === sessionId)
          .some((m) => m.state === "idle"),
      30_000,
      "the resumed turn settling",
    );

    const listed = await request("session.list");
    const mine = listed.find((row) => row.sessionId === sessionId);
    check(
      "the thread is listed live again after the resume",
      mine?.live === true && mine?.state === "idle",
      `live=${mine?.live} state=${mine?.state}`,
    );

    await request("session.close", { sessionId });
  } catch (e) {
    check(`unexpected failure: ${e.message}`, false);
  } finally {
    ws.close();
    await server.stop();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
