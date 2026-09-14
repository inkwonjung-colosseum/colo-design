/**
 * 관례 최신화 (커미티 판정 2026-09-14) end-to-end — fully offline.
 *
 * 이 스위트가 지키는 계약:
 *
 *   - 표식 없는 CLAUDE.md(판이 생기기 전에 연결된 레포)는
 *     conventionsStale 로 보인다 — 프로젝트 요약이 그 사실을 실어 나른다.
 *   - project.refreshConventions 는 그 클론에 "관례 최신화" 대화를 열고
 *     첫 턴으로 현행 브리프를 내린다: 이미 연결돼 있다는 전제, 표식
 *     갱신 지시, colo-design.json 금지가 그 안에 있어야 한다.
 *   - 세션이 표식을 달아 CLAUDE.md 를 다시 쓰면 stale 이 거짓이 되고,
 *     바뀐 파일은 저장을 기다리는 미해결 변경으로 남는다 — 승인 게이트는
 *     개발자의 PR 이다(재주입이 아니라 제안).
 *
 * 관찰 지점은 스텁 claude CLI 가 받는 첫 사용자 턴(브리프)과 스텁이 클론에
 * 남기는 파일이다.
 *
 * Usage: node packages/daemon/test/conventions-refresh-e2e.mjs
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { CONVENTIONS_REVISION, conventionsMarker, REFRESH_BRIEF } from "../dist/bootstrap-brief.js";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-conventions-refresh-e2e");
const TURNS = join(DIR, "turns");
const MARKER = conventionsMarker(CONVENTIONS_REVISION);

process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");

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
 * 브리프를 받으면 그 전문을 TURNS 에 덤프하고, 'Claude 가 한 일'을 흉내
 * 낸다 — CLAUDE.md 를 현행 표식과 함께 다시 쓴다. 바뀐 파일은 커밋되지
 * 않고 미해결 변경으로 남는다(저장 → 넘기기가 다음 관문이다).
 */
function writeRefreshStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  const lines = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const pathMod = require('node:path');",
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
    'if (args[0] === "auth") {',
    '  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team", email: "planner@example.com" }));',
    "  process.exit(0);",
    "}",
    "let buf = '';",
    "let sessionId = 'stub';",
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
    '    if (o.type === "user") {',
    '      sessionId = (line.match(/\\"session_id\\":\\"[^\\"]*\\"/) || [])[0] || sessionId;',
    `      fs.writeFileSync(pathMod.join(${JSON.stringify(TURNS)}, 'turn-' + process.pid + '.json'), line);`,
    `      fs.writeFileSync('CLAUDE.md', ${JSON.stringify(MARKER)} + "\\n# fixture colo-design 레포\\n\\n관례를 현행 판으로 다시 썼습니다.\\n");`,
    "      setTimeout(() => send({",
    '        type: "result", subtype: "success", is_error: false,',
    '        session_id: sessionId, result: "관례를 현행 판으로 다시 썼습니다.", num_turns: 1, duration_ms: 5,',
    "      }), 200);",
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
  mkdirSync(TURNS, { recursive: true });

  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });

  const port = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port,
    token: "conventions-refresh-e2e",
    claudeExecutable: writeRefreshStubClaude(join(DIR, "bin")),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=conventions-refresh-e2e`);
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

  try {
    const project = await request({
      type: "project.create",
      name: "관례",
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

    // --- 1. 표식 없는 CLAUDE.md 는 낡은 것으로 보인다 -----------------------
    const listed = await request({ type: "project.list" });
    const before = listed.projects.find((entry) => entry.slug === project.slug);
    check(
      "a CLAUDE.md with no conventions marker reads as stale",
      before?.conventionsStale === true,
    );

    // --- 2. 최신화 턴: 대화가 열리고 첫 턴이 현행 브리프다 ------------------
    const turnsBefore = new Set(readdirSync(TURNS));
    const refresh = await request({ type: "project.refreshConventions", slug: project.slug });
    check(
      "refreshConventions answers with a live session id",
      typeof refresh.sessionId === "string",
    );
    const brief = await waitFor(
      async () => {
        // 새 턴 덤프가 대화의 것뿐이지 않다 — 머신 턴도 남긴다. 브리프의
        // 첫 문장으로 관례 최신화 턴을 골라 낸다.
        for (const entry of readdirSync(TURNS)) {
          if (turnsBefore.has(entry)) continue;
          const text = readFileSync(join(TURNS, entry), "utf8");
          if (text.includes("이미 Colo Design 도구와 연결되어")) return text;
        }
        return null;
      },
      30_000,
      "the refresh brief turn",
    );
    check(
      "the first turn is the refresh brief: already-connected premise, marker, config fence",
      brief.includes("이미 Colo Design 도구와 연결되어") &&
        brief.includes(MARKER) &&
        brief.includes("colo-design.json` 고치기") &&
        brief.includes("PR 승인"),
      REFRESH_BRIEF.slice(0, 30),
    );

    // --- 3. 표식이 달리면 stale 이 거짓이 된다 -----------------------------
    const settled = await waitFor(
      async () => {
        const current = await request({ type: "project.list" });
        return current.projects.find((entry) => entry.slug === project.slug) ?? null;
      },
      30_000,
      "a project summary with conventionsStale=false",
    ).then((entry) => entry.conventionsStale === false);
    check("a marker at the current revision reads as current", settled);

    // --- 4. 바뀐 파일은 저장을 기다리는 미해결 변경이다 ---------------------
    // 재주입이 아니라 제안: 스텁은 커밋하지 않았고, 클론에는 CLAUDE.md 의
    // 수정이 미해결 변경으로 남아 저장 → 넘기기 게이트로 간다.
    const pending = await waitFor(
      async () => {
        const current = await request({ type: "project.list" });
        return current.projects.find((entry) => entry.slug === project.slug)?.pendingChanges > 0;
      },
      30_000,
      "the rewritten CLAUDE.md to count as pending",
    );
    check("the rewritten conventions ride the save pipeline as unsaved changes", pending);

    // --- 5. 설계의 요지: 앱이 클론에 설정 파일을 쓰지 않았다 ----------------
    const stray = readdirSync(join(DIR, "projects", project.slug, "repo")).filter(
      (name) => name === ".claude" || name === ".agents",
    );
    check(
      "no .claude/ or .agents/ was written into the clone",
      stray.length === 0,
      stray.join(","),
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
