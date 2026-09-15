/**
 * 권한 카드 반복 측정(커미티 판정 2026-09-14, 의장 판정 2)의 종단 검증 —
 * fully offline.
 *
 * 제품의 아픈 지점 그대로를 와이어 위에서 재현한다: `alwaysAllowed` 는
 * 세션 하나의 기억이라, 사용자가 "항상 허용"으로 답한 카드가 새 대화에서
 * 같은 모습로 다시 뜬다. 이 스위트가 지키는 계약:
 *
 *   - 첫 카드는 repeat:false 로 기록되고, "항상 허용" 답은 always 로 남는다.
 *   - 새 세션의 같은 카드는 repeat:true 로 기록된다 — 측정이 잡아야 할 반복.
 *   - 기록은 카드의 사실(도구·서명·cwd)뿐이다 — 질문·계획 카드는 잡히지
 *     않는다.
 *
 * Usage: node packages/daemon/test/permission-repeat-e2e.mjs
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-permission-repeat-e2e");
const LOG = join(DIR, "permission-repeat.jsonl");
const COMMAND = "pnpm run check";
const SIGNATURE = `Bash:command:${COMMAND}`;

process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_DESIGN_PERMISSION_LOG = LOG;

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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * 매 사용자 턴에서 Bash 카드 하나를 던지고, 답(control_response)이 오면
 * 턴을 마친다 — 실제 CLI 가 can_use_tool 로 묻는 모양 그대로.
 */
function writeAskingStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  const lines = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
    'if (args[0] === "auth") {',
    '  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team", email: "planner@example.com" }));',
    "  process.exit(0);",
    "}",
    "let buf = '';",
    "let sessionId = 'stub';",
    "let awaiting = null;",
    "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "const seen = () => {",
    "  let idx;",
    '  while ((idx = buf.indexOf("\\n")) !== -1) {',
    "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
    "    let o = null; try { o = JSON.parse(line); } catch { continue; }",
    '    if (o.type === "control_request") {',
    "      const sub = String(o.request && o.request.subtype);",
    "      const id = String(o.request_id);",
    '      if (sub === "initialize" || sub === "set_permission_mode") {',
    '        send({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });',
    "      }",
    "      continue;",
    "    }",
    '    if (o.type === "control_response") {',
    "      const id = String((o.response && o.response.request_id) || '');",
    "      if (awaiting !== null && id === awaiting) {",
    "        awaiting = null;",
    "        setTimeout(() => send({",
    '          type: "result", subtype: "success", is_error: false,',
    '          session_id: sessionId, result: "돌렸습니다.", num_turns: 1, duration_ms: 5,',
    "        }), 100);",
    "      }",
    "      continue;",
    "    }",
    '    if (o.type === "user") {',
    '      sessionId = (line.match(/\\"session_id\\":\\"[^\\"]*\\"/) || [])[0] || sessionId;',
    "      awaiting = 'ask-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);",
    "      send({ type: 'control_request', request_id: awaiting, request: {",
    "        subtype: 'can_use_tool', tool_name: 'Bash',",
    `        input: { command: ${JSON.stringify(COMMAND)} },`,
    "      } });",
    "    }",
    "  }",
    "};",
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { buf += chunk; seen(); });',
    "",
  ];
  writeFileSync(path, lines.join("\n"));
  chmodSync(path, 0o755);
  return path;
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });

  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });

  const port = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port,
    token: "permission-repeat-e2e",
    claudeExecutable: writeAskingStubClaude(join(DIR, "bin")),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=permission-repeat-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  let nextId = 0;
  const request = async (message, timeoutMs = 60_000) => {
    nextId += 1;
    const id = `m${nextId}`;
    ws.send(JSON.stringify({ ...message, id }));
    const reply = await waitFor(() => inbox.find((m) => m.id === id), timeoutMs, message.type);
    if (reply.type === "ok") return reply.data;
    throw new Error(reply.message);
  };

  /** 한 세션에서: 턴 → 카드 → 응답(decision) → 턴 종료까지. */
  const runCardTurn = async (sessionId, decision, label) => {
    await request({ type: "session.send", sessionId, text: "검사 좀 돌려줘" });
    const card = await waitFor(
      () =>
        inbox.find(
          (m) =>
            m.type === "permission.request" && m.sessionId === sessionId && m.toolName === "Bash",
        ) ?? null,
      20_000,
      label,
    );
    await request({ type: "permission.respond", requestId: card.requestId, decision });
    await waitFor(
      () =>
        inbox.some(
          (m) => m.type === "session.state" && m.sessionId === sessionId && m.state === "idle",
        ),
      20_000,
      `${label} 마침`,
    );
  };

  try {
    await request({
      type: "project.create",
      name: "측정",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    const ready = await waitFor(
      async () => {
        const status = await request({ type: "repo.status" });
        return status.phase === "ready" || status.phase === "error" ? status : null;
      },
      60_000,
      "the clone",
    );
    if (ready.phase !== "ready") throw new Error(String(ready.detail ?? ready.phase));

    // --- 세션 A: 첫 카드에 "항상 허용" --------------------------------------
    const first = await request({ type: "session.create", title: "첫 대화" });
    await runCardTurn(first.sessionId, "allowAlways", "세션 A의 첫 카드");

    // --- 세션 B: 같은 카드가 다시 뜬다 (alwaysAllowed 는 세션 것) ------------
    const second = await request({ type: "session.create", title: "둘째 대화" });
    await runCardTurn(second.sessionId, "allow", "세션 B의 같은 카드");

    // --- 로그가 잡았는가 ------------------------------------------------------
    const events = readFileSync(LOG, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const forSignature = events.filter((entry) => entry.signature === SIGNATURE);
    const asks = forSignature.filter((entry) => entry.kind === "ask");
    const always = forSignature.filter((entry) => entry.kind === "always");

    check(
      "the first card is recorded as a non-repeat ask",
      asks.length >= 1 && asks[0].repeat === false,
      JSON.stringify(asks[0] ?? {}),
    );
    check(
      "the always-allow answer is recorded as the seed",
      always.length === 1 && always[0].tool === "Bash",
    );
    check(
      "the same card in the NEXT session is recorded as a repeat",
      asks.some((entry, index) => index > 0 && entry.repeat === true),
      asks.map((entry) => String(entry.repeat)).join(","),
    );
    check(
      "only permission cards are measured — no plan or question noise",
      events.every((entry) => entry.tool === "Bash" && typeof entry.cwd === "string"),
      [...new Set(events.map((entry) => entry.tool))].join(","),
    );
  } finally {
    ws.close();
    await server.stop();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed` +
      (failed.length ? ` — FAILED: ${failed.map((r) => r.name).join(" · ")}` : ""),
  );
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
