/**
 * 진행 시계의 와이어, 오프라인 e2e: 보낸 요청이 몇 분 몇 초째인지를 화면이
 * 스스로 세지 않고 데몬에게 묻는다는 계약을 본다.
 *
 * 시계가 창의 것이었다면 새로고침한 창이 3분째인 턴을 0초부터 다시 세고, 두
 * 번째 창은 또 다른 숫자를 말한다. 그래서 시작 시각은 세션이 들고
 * (`Session.turnStartedAt`), `session.state.startedAt` 으로 방송되며
 * `session.list` 의 `turnStartedAt` 으로도 읽힌다 — 이 스위트가 그 세 자리를
 * 한 번의 턴에서 확인한다.
 *
 * 확인 카드 앞에 멈춘 시간도 그 요청의 시간이라는 것이 두 번째 계약이다:
 * 카드가 떠도, 답해서 턴이 재개돼도 시작은 그대로고, 턴이 끝나야 사라진다.
 * 스텁 CLI 는 plan-e2e 와 같은 수법으로 ExitPlanMode 카드를 띄워, 사람이
 * 기다리는 그 구간을 실제로 만든다.
 *
 * Usage: node packages/daemon/test/turn-clock-e2e.mjs
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-turn-clock-e2e");

process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_DESIGN_REPO_SETTINGS = join(DIR, "settings.json");
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_REPO_DIR = join(DIR, "work");

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") throw new Error(`check("${name}") was called without a verdict`);
  results.push({ name, passed });
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
 * 한 마디에 카드 하나로 답하고, 계획자가 답해야만 턴을 끝내는 CLI. 그 사이가
 * 이 스위트가 재려는 구간이다 — 사람이 카드 앞에서 기다리는 시간.
 */
function stubClaude(dir) {
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (args[0] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
      "  process.exit(0);",
      "}",
      "let buf = '';",
      "let turns = 0;",
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "const seen = () => {",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      "    let o = null; try { o = JSON.parse(line); } catch { continue; }",
      '    if (o.type === "control_request") {',
      "      const sub = o.request && o.request.subtype;",
      '      const payload = sub === "initialize" ? { commands: [], output_style: "default" } : {};',
      '      if (sub === "initialize" || sub === "interrupt" || sub === "set_permission_mode") send({ type: "control_response", response: { subtype: "success", request_id: o.request_id, response: payload } });',
      "      continue;",
      "    }",
      '    if (o.type === "control_response" && String(o.response?.request_id || "").startsWith("card-")) {',
      "      setTimeout(() => send({",
      '        type: "result", subtype: "success", is_error: false,',
      '        session_id: "stub", result: "만들겠습니다.", num_turns: 1, duration_ms: 5',
      "      }), 50);",
      "      continue;",
      "    }",
      '    if (o.type === "user") {',
      "      turns += 1;",
      "      setTimeout(() => send({",
      '        type: "control_request", request_id: "card-" + turns,',
      '        request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "1. 화면 골격" } }',
      "      }), 150);",
      "      continue;",
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
  const server = new DaemonServer({ host: "127.0.0.1", port: daemonPort, token: "turn-clock-e2e" });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}?token=turn-clock-e2e`);
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
  const states = (sessionId) =>
    inbox.filter((m) => m.type === "session.state" && m.sessionId === sessionId);

  try {
    const ready = await request("repo.sync");
    check("the fixture repo clones", ready.phase === "ready", ready.detail ?? "");

    const { sessionId } = await request("session.create", {});
    const listed = async () =>
      (await request("session.list")).find((s) => s.sessionId === sessionId) ?? null;
    check("an idle session has no clock", (await listed())?.turnStartedAt === null);

    // 카드를 띄우는 자세로 보낸다 — 계획 모드의 ExitPlanMode 가 사람의 기다림을
    // 만드는 가장 짧은 길이다.
    await request("session.setPermissionMode", { sessionId, mode: "plan" });
    const sentAt = Date.now();
    await request("session.send", { sessionId, text: "회원가입 화면 만들어 줘" });
    const running = await waitFor(
      () => states(sessionId).find((m) => m.state === "running") ?? null,
      20_000,
      "running",
    );
    check(
      "the send starts the clock",
      typeof running.startedAt === "number" && Math.abs(running.startedAt - sentAt) < 3000,
      `${running.startedAt} vs ${sentAt}`,
    );

    const card = await waitFor(
      () => inbox.find((m) => m.type === "permission.request" && m.sessionId === sessionId) ?? null,
      20_000,
      "the permission card",
    );
    const waiting = await waitFor(
      () => states(sessionId).find((m) => m.state === "waiting_permission") ?? null,
      20_000,
      "waiting_permission",
    );
    check(
      "a card does not restart the clock",
      waiting.startedAt === running.startedAt,
      `${waiting.startedAt} vs ${running.startedAt}`,
    );
    check(
      "a window that opens mid-card reads the same start",
      (await listed())?.turnStartedAt === running.startedAt,
      String((await listed())?.turnStartedAt),
    );

    await request("permission.respond", { requestId: card.requestId, decision: "allow" });
    const resumed = await waitFor(
      () =>
        states(sessionId)
          .filter((m) => m.state === "running")
          .at(-1) ?? null,
      20_000,
      "the resumed turn",
    );
    check(
      "answering the card resumes the same clock",
      resumed.startedAt === running.startedAt,
      `${resumed.startedAt} vs ${running.startedAt}`,
    );

    const idle = await waitFor(
      () => states(sessionId).find((m) => m.state === "idle") ?? null,
      20_000,
      "the turn's end",
    );
    check(
      "the turn's end takes the clock with it",
      idle.startedAt === undefined,
      String(idle.startedAt),
    );
    check("and the list agrees", (await listed())?.turnStartedAt === null);

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
