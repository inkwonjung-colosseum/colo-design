import { chmodSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "/Users/developjik/.paseo/worktrees/37blf94g/durable-spider/packages/daemon/dist/server.js";
import { createFixtureRepo, freePort } from "/Users/developjik/.paseo/worktrees/37blf94g/durable-spider/packages/daemon/test/fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-crash-debug");
rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, "claude-config"), { recursive: true });
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_DESIGN_REPO_SETTINGS = join(DIR, "settings.json");
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_REPO_DIR = join(DIR, "work");

// same stub as the test
const stubDir = join(DIR, "claude-config");
const marker = join(stubDir, "crashed.flag");
const stubPath = join(stubDir, "claude");
writeFileSync(stubPath, [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  `const marker = ${JSON.stringify(marker)};`,
  "const args = process.argv.slice(2);",
  'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
  'if (args[0] === "auth") { console.log(\'{"loggedIn":true}\'); process.exit(0); }',
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
  "        fs.writeFileSync(marker, '1');",
  "        process.stderr.write('stub: unexpected condition in turn\\n');",
  "        process.exit(1);",
  "      }",
  '      setTimeout(() => send({ type: "result", subtype: "success", is_error: false, session_id: "stub", result: "이어서 만들겠습니다.", num_turns: 1, duration_ms: 10, duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], errors: [] }), 20);',
  "    }",
  "  }",
  "};",
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (c) => { buf += c; seen(); });',
  'process.stdin.on("end", () => process.exit(0));',
].join("\n"));
chmodSync(stubPath, 0o755);
process.env.COLO_DESIGN_CLAUDE_BIN = stubPath;

const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });
process.env.COLO_DESIGN_REPO_URL = fixture.remote;

const port = await freePort();
const server = new DaemonServer({
  host: "127.0.0.1", port, token: "t",
  logger: { info: (m, d) => console.log("[info]", m, d ?? ""), warn: (m, d) => console.log("[warn]", m, d ?? ""), error: (m, d) => console.log("[error]", m, d ?? "") },
});
await server.start();
const ws = new WebSocket(`ws://127.0.0.1:${port}?token=t`);
const inbox = [];
ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
let seq = 0;
const request = async (type, extra = {}) => {
  const id = `m${++seq}`;
  ws.send(JSON.stringify({ id, type, ...extra }));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const hit = inbox.find((m) => m.id === id);
    if (hit) { if (hit.type !== "ok") throw new Error(`${type}: ${hit.message}`); return hit.data; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout ${type}`);
};
await request("repo.sync");
const { sessionId } = await request("session.create", {});
console.log("session:", sessionId);
await request("session.send", { sessionId, text: "crash me" });
const t0 = Date.now();
while (Date.now() - t0 < 15000) {
  const ev = inbox.filter((m) => m.type === "session.event" || m.type === "session.state");
  if (ev.length) console.log(JSON.stringify(ev.map((m) => m.event?.kind ?? m.state)));
  const card = inbox.find((m) => m.event?.kind === "notice" && m.event?.level === "error");
  if (card) { console.log("CARD:", card.event.text.slice(0, 80)); break; }
  await new Promise((r) => setTimeout(r, 500));
}
ws.close();
await server.stop();
process.exit(0);
