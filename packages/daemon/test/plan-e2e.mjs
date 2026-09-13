/**
 * 계획 모드의 승인 루프, 오프라인 e2e: 스텁 CLI 가 실제 SDK 와이어 위에서
 * ExitPlanMode 의 can_use_tool 을 던지고, 데몬이 그것을 `만들 것` 카드로
 * 띄웠다가 승인 순간 작업 모드로 되돌리는 것까지 검사한다. 거절은 계획 모드에
 * 머문다. 단위 검사(plan.test.mjs)가 프로토타입 자리를 본다면 이 스위트는
 * session.create 부터 selectors 까지의 실제 와이어를 본다.
 *
 * Usage: node packages/daemon/test/plan-e2e.mjs
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-plan-e2e");

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

const VERDICT_FILE = () => join(DIR, "verdict.json");
/** What the stub CLI heard back from the planner, for the test to read. */
function readVerdict() {
  try {
    return JSON.parse(readFileSync(VERDICT_FILE(), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The CLI this suite's sessions speak to. Turn 1 and 2 answer a user message
 * with an ExitPlanMode can_use_tool control request — the plan-mode CLI's own
 * move — and end the turn only after the control_response lands. The verdict
 * (and the denial's reason) go to a side file the suite reads.
 */
function stubClaude(dir, verdictPath) {
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
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
      // control answers the CLI owes the SDK: initialize (selectors read the
      // handshake's model list), interrupt, and set_permission_mode.
      '    if (o.type === "control_request") {',
      "      const sub = String(o.request && o.request.subtype);",
      "      let payload = {};",
      '      if (sub === "initialize") payload = { models: [{ value: "stub-model", displayName: "Stub", resolvedModel: "stub-model", description: "stub", supportsEffort: false, supportedEffortLevels: null }], commands: [], agents: [] };',
      '      if (sub === "initialize" || sub === "interrupt" || sub === "set_permission_mode") send({ type: "control_response", response: { subtype: "success", request_id: o.request_id, response: payload } });',
      "      continue;",
      "    }",
      // the planner's verdict on our plan
      '    if (o.type === "control_response" && String(o.response?.request_id || "").startsWith("plan-")) {',
      "      const r = (o.response && o.response.response) || {};",
      `      fs.writeFileSync(${JSON.stringify(verdictPath)}, JSON.stringify({`,
      "        behavior: r.behavior, message: r.message ?? null",
      "      }));",
      "      setTimeout(() => send({",
      '        type: "result", subtype: "success", is_error: false,',
      '        session_id: "stub", result: r.behavior === "allow" ? "만들겠습니다." : "계획을 다시 세우겠습니다.",',
      "        num_turns: 1, duration_ms: 5",
      "      }), 50);",
      "      continue;",
      "    }",
      '    if (o.type === "user") {',
      "      turns += 1;",
      "      setTimeout(() => send({",
      '        type: "control_request", request_id: "plan-" + turns,',
      '        request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "1. 화면 골격 " + turns + "\\n2. 목 데이터" } }',
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
  process.env.COLO_DESIGN_CLAUDE_BIN = stubClaude(join(DIR, "claude-config"), VERDICT_FILE());

  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });
  process.env.COLO_DESIGN_REPO_URL = fixture.remote;

  const daemonPort = await freePort();
  const server = new DaemonServer({ host: "127.0.0.1", port: daemonPort, token: "plan-e2e" });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}?token=plan-e2e`);
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
  const events = (kind) => inbox.filter((m) => m.type === kind);

  try {
    // --- 준비: 활성 프로젝트가 있어야 세션의 cwd 가 생긴다 ------------------
    const ready = await request("repo.sync");
    check("the fixture repo clones", ready.phase === "ready", ready.detail ?? "");

    const { sessionId } = await request("session.create", {});
    check("a session is born", typeof sessionId === "string" && sessionId.length > 0);

    const modeOf = async () => (await request("session.selectors", { sessionId })).permissionMode;
    check("a session starts on default", (await modeOf()) === "default");

    // --- 전 작업 모드 → 계획: 들어갈 때의 모드가 기억된다 -------------------
    await request("session.setPermissionMode", { sessionId, mode: "bypassPermissions" });
    await request("session.setPermissionMode", { sessionId, mode: "plan" });
    check("plan mode is on", (await modeOf()) === "plan");

    // --- 턴 1: 계획 카드가 뜨고, 승인하면 작업 모드로 돌아온다 --------------
    await request("session.send", { sessionId, text: "회원가입 화면 만들어 줘" });
    const planRequest = await waitFor(
      () =>
        events("permission.request").find(
          (m) => m.sessionId === sessionId && m.toolName === "ExitPlanMode",
        ) ?? null,
      20_000,
      "the plan card",
    );
    check(
      "ExitPlanMode surfaces as a card with the plan",
      typeof planRequest.input?.plan === "string" && planRequest.input.plan.includes("화면 골격"),
    );

    await request("permission.respond", {
      requestId: planRequest.requestId,
      decision: "allow",
    });
    const verdict = await waitFor(() => readVerdict(), 20_000, "the stub hearing the approval");
    check("the approval reached the CLI as allow", verdict.behavior === "allow", verdict.behavior);
    await waitFor(
      () => events("session.state").some((m) => m.sessionId === sessionId && m.state === "idle"),
      20_000,
      "turn 1 end",
    );
    check("approval restores the working mode", (await modeOf()) === "bypassPermissions");
    check(
      "the restored mode is what the session returns to",
      (await request("session.selectors", { sessionId })).permissionMode === "bypassPermissions",
    );

    // --- 턴 2: 거절은 계획 모드에 머물고 이유가 전달된다 ---------------------
    const cardsBefore = events("permission.request").filter(
      (m) => m.toolName === "ExitPlanMode",
    ).length;
    rmSync(VERDICT_FILE(), { force: true });
    await request("session.setPermissionMode", { sessionId, mode: "acceptEdits" });
    await request("session.setPermissionMode", { sessionId, mode: "plan" });
    await request("session.send", { sessionId, text: "로그인 화면도 만들어 줘" });
    await waitFor(
      () =>
        events("permission.request").filter((m) => m.toolName === "ExitPlanMode").length >
        cardsBefore,
      20_000,
      "the second plan card",
    );
    const planRequest2 = events("permission.request")
      .filter((m) => m.toolName === "ExitPlanMode")
      .at(-1);
    await request("permission.respond", {
      requestId: planRequest2.requestId,
      decision: "deny",
      message: "버튼을 더 크게",
    });
    const verdict2 = await waitFor(() => readVerdict(), 20_000, "the stub hearing the denial");
    check(
      "the denial's reason reaches the CLI",
      verdict2.behavior === "deny" && verdict2.message === "버튼을 더 크게",
      JSON.stringify(verdict2),
    );
    await waitFor(
      () => (events("session.state").at(-1)?.state ?? "") === "idle",
      20_000,
      "turn 2 end",
    );
    check("denial keeps the plan mode", (await modeOf()) === "plan");

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
