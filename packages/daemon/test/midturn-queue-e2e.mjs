/**
 * 다음 턴에 보내기 (PLAN D86) 의 약속을 와이어 위에서 고정하는 스위트: 턴이
 * 도는 중에 보낸 말은 그 턴에 끼어들지 않는다.
 *
 * 이 스위트가 막는 회귀는 SDK 의 성질 그 자체다. SDK 의 입력 스트림은 대기
 * 줄이 아니다 — 거기에 쓴 사용자 메시지는 CLI 가 도는 턴 안으로(툴 라운드
 * 사이에) 접어 넣는다(sdk.d.ts 의 `user_message_uuids`: "any queued user
 * message folded into the running turn"). 그래서 데몬이 send 를 그대로
 * 밀어 넣으면 설정은 `다음 턴에 보내기` 인데 동작은 끼어들기가 된다. 대기
 * 줄은 데몬이 쥐어야 하고, 이 스위트는 스텁 CLI 의 stdin 로그로 그것을 본다:
 * 그 말은 앞 턴이 끝나기 전에는 CLI 에 도착조차 하지 않는다.
 *
 * Free: no real Claude turn. Offline end to end — daemon, SDK, stub CLI.
 *
 * Usage: node packages/daemon/test/midturn-queue-e2e.mjs
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-midturn-queue-e2e");
const STDIN_LOG = join(DIR, "cli-stdin.log");

process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_DESIGN_REPO_SETTINGS = join(DIR, "settings.json");
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_REPO_DIR = join(DIR, "work");

const LONG = "오래 걸리는 작업 시작해 줘";
const WAITING = "그동안 이것도 확인해 줘";

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await predicate();
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** What the CLI's stdin actually received, in arrival order. */
function stdinLog() {
  if (!existsSync(STDIN_LOG)) return [];
  return readFileSync(STDIN_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * A stub CLI that writes down every user line it is handed, with the instant
 * it arrived. The marker turn never answers on its own — it RUNS until the
 * interrupt cuts it, which is how a mid-turn send gets a running turn to land
 * in. The process stays alive after the cut, because what happens NEXT (does
 * the waiting line arrive now?) is the whole point of the suite.
 */
function loggingStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const log = ${JSON.stringify(STDIN_LOG)};`,
      'if (process.argv[2] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (process.argv[2] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
      "  process.exit(0);",
      "}",
      'let buf = "";',
      'let sessionId = "stub";',
      "let busy = false;",
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "const note = (kind, text) => fs.appendFileSync(log, JSON.stringify({ kind, text, at: Date.now() }) + '\\n');",
      "const seen = () => {",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      "    let o = null; try { o = JSON.parse(line); } catch { continue; }",
      '    if (o.type === "control_request") {',
      "      const sub = String(o.request && o.request.subtype);",
      '      if (sub === "initialize" || sub === "set_permission_mode" || sub === "interrupt") {',
      '        send({ type: "control_response", response: { subtype: "success", request_id: o.request_id,',
      '          response: sub === "initialize" ? { models: [], commands: [], agents: [] } : {} } });',
      "      }",
      '      if (sub === "interrupt") {',
      "        // 실제 CLI 가 멈춘 턴을 끝내는 모양 그대로: 에러 결과 하나.",
      '        note("interrupt", "");',
      "        busy = false;",
      // 실제 CLI 의 결과 한 줄에는 SDK 가 훑는 배열들이 들어 있다. 그것이
      // 빠지면 SDK 가 질의 안에서 터지고(TypeError: reading 'map'), 이 스위트가
      // 보려는 "끝난 턴 다음의 전달" 자체가 일어나지 않는다.
      '        send({ type: "result", subtype: "error_during_execution", is_error: true,',
      '          session_id: sessionId, result: "interrupted", num_turns: 1, duration_ms: 5,',
      "          duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {},",
      "          permission_denials: [], errors: [] });",
      "      }",
      "      continue;",
      "    }",
      '    if (o.type !== "user") continue;',
      "    sessionId = o.session_id || sessionId;",
      "    const content = o.message && o.message.content;",
      '    const text = typeof content === "string" ? content : JSON.stringify(content);',
      '    note("user", text);',
      "    // 표식이 실린 턴은 스스로 끝나지 않는다 — 무언가 끊을 때까지 돈다.",
      '    if (text.includes("오래 걸리는 작업")) { busy = true; continue; }',
      "    if (busy) continue;",
      "    setTimeout(() => send({",
      '      type: "result", subtype: "success", is_error: false,',
      '      session_id: sessionId, result: "알겠습니다.", num_turns: 1, duration_ms: 10,',
      "      duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {},",
      "      permission_denials: [], errors: [],",
      "    }), 20);",
      "  }",
      "};",
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { buf += chunk; seen(); });',
      'process.stdin.on("end", () => process.exit(0));',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  process.env.COLO_DESIGN_CLAUDE_BIN = loggingStubClaude(join(DIR, "bin"));

  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });
  process.env.COLO_DESIGN_REPO_URL = fixture.remote;

  const daemonPort = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port: daemonPort,
    token: "midturn-queue",
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}?token=midturn-queue`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  let seq = 0;
  const request = async (type, extra = {}, timeoutMs = 60_000) => {
    const id = `m${++seq}`;
    ws.send(JSON.stringify({ id, type, ...extra }));
    const reply = await waitFor(() => inbox.find((m) => m.id === id), timeoutMs, type);
    if (reply.type !== "ok") throw new Error(`${type} failed: ${reply.message}`);
    return reply.data;
  };
  const sessionEvents = (sessionId, kind) =>
    inbox.filter(
      (m) => m.type === "session.event" && m.sessionId === sessionId && m.event.kind === kind,
    );

  try {
    const ready = await request("repo.sync");
    check("the fixture repo clones", ready.phase === "ready", ready.detail ?? "");

    const { sessionId } = await request("session.create", {});

    // --- 1. 도는 턴 하나 --------------------------------------------------
    await request("session.send", { sessionId, text: LONG });
    await waitFor(
      () => stdinLog().some((row) => row.kind === "user" && row.text.includes(LONG)),
      20_000,
      "the first turn reaching the CLI",
    );
    await waitFor(
      () =>
        inbox.some(
          (m) => m.type === "session.state" && m.sessionId === sessionId && m.state === "running",
        ),
      20_000,
      "the running state",
    );

    // --- 2. 그 턴 한가운데로 보낸 말 --------------------------------------
    await request("session.send", { sessionId, text: WAITING });

    check(
      "the waiting words enter the transcript at once",
      sessionEvents(sessionId, "user.echo").some((m) => m.event.text === WAITING),
    );
    // 도는 턴은 스스로 끝나지 않으니, 이 기다림은 경합이 아니다: 이 창이
    // 지나도 CLI 의 stdin 에 그 말이 없어야 한다. 있다면 그것이 끼어들기다.
    await sleep(1500);
    const midTurn = stdinLog();
    check(
      "the running turn never receives the waiting words",
      !midTurn.some((row) => row.kind === "user" && row.text.includes(WAITING)),
      JSON.stringify(midTurn.map((row) => `${row.kind}:${row.text.slice(0, 20)}`)),
    );
    check(
      "the daemon says one send is waiting",
      sessionEvents(sessionId, "queued").some((m) => m.event.count === 1),
      JSON.stringify(sessionEvents(sessionId, "queued").map((m) => m.event.count)),
    );

    check(
      "and the turn it would have interrupted is still running",
      inbox.filter((m) => m.type === "session.state" && m.sessionId === sessionId).at(-1)?.state ===
        "running",
    );

    // --- 3. 턴이 끝나면 — 그리고 그때서야 — 나간다 ------------------------
    await request("session.interrupt", { sessionId });
    const delivered = await waitFor(
      () => stdinLog().find((row) => row.kind === "user" && row.text.includes(WAITING)),
      20_000,
      "the waiting words reaching the CLI",
    );
    const cut = stdinLog().find((row) => row.kind === "interrupt");
    check(
      "the waiting words reach the CLI only after the turn ended",
      Boolean(cut) && delivered.at >= cut.at,
      `interrupt@${cut?.at} → send@${delivered.at}`,
    );
    check(
      "the transcript closed the stopped turn before the next one opened",
      sessionEvents(sessionId, "turn.end").some((m) => m.event.subtype === "interrupted"),
      JSON.stringify(sessionEvents(sessionId, "turn.end").map((m) => m.event.subtype)),
    );
    await waitFor(
      () => sessionEvents(sessionId, "queued").some((m) => m.event.count === 0),
      10_000,
      "the wait-line clearing",
    );
    check("the wait-line empties when the words go out", true);

    const answered = await waitFor(
      () => sessionEvents(sessionId, "turn.end").find((m) => m.event.subtype === "success"),
      20_000,
      "the released turn's own answer",
    );
    check(
      "the released words run as their own turn",
      answered.event.resultText === "알겠습니다.",
      String(answered.event.resultText),
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
