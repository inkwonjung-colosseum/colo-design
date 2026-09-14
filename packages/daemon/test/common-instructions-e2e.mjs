/**
 * 공통 지침(커미티 판정 2026-09-14 1번)의 종단 검증 — 완전 오프라인.
 *
 * 이 스위트가 지키는 계약:
 *
 *   - 앱이 authoring 한 COMMON_INSTRUCTIONS 블록이 모든 세션의 시스템
 *     프롬프트 끝에 붙는다 — 프로젝트 지침이 없어도, 있어도.
 *   - 프로젝트의 "지켜 줄 것"(instructions)은 공통 블록 '뒤에' 이어진다.
 *     순서가 계약이다: 공통이 먼저, 프로젝트가 나중.
 *   - status 브로드캐스트가 그 블록을 읽기 전용 표시용으로 실어 나른다.
 *
 * 관찰 지점은 스텁 claude CLI 가 받는 initialize 컨트롤 요청이다 —
 * appendSystemPrompt 는 SDK 가 systemPrompt.append 로 CLI 에 내려주므로,
 * 스텁이 받은 요청 전문에 그 내용이 그대로 담긴다. 레포에 파일을 쓰지
 * 않는다는 것이 이 설계의 요지이므로, 클론 작업트리에 남는 파일이
 * 하나도 없음도 함께 확인한다.
 *
 * Usage: node packages/daemon/test/common-instructions-e2e.mjs
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { COMMON_INSTRUCTIONS } from "../dist/common-instructions.js";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-common-instructions-e2e");
const DUMPS = join(DIR, "init-dumps");
const COMMON_MARKER = "Colo Design 공통 규칙";
const PROJECT_RULE = "버튼은 CDS 컴포넌트만 씁니다.";

process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");

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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * writeStubClaude 와 같은 자세지만, initialize 컨트롤 요청의 전문을
 * DUMPS 에 덤프한다 — 세션마다 프로세스가 하나씩 뜨므로 pid 가 곧
 * 세션의 구분자다. 사용자 턴에는 짧은 결과로 답해 대화가 마무리된다.
 */
function writeDumpStubClaude(dir) {
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
    '      if (sub === "initialize") {',
    "        try {",
    `          fs.writeFileSync(pathMod.join(${JSON.stringify(DUMPS)}, 'init-' + process.pid + '.json'), JSON.stringify(o.request));`,
    "        } catch {}",
    '        send({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });',
    '      } else if (sub === "set_permission_mode") {',
    '        send({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });',
    "      }",
    "      continue;",
    "    }",
    '    if (o.type === "user") {',
    '      sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || sessionId;',
    "      setTimeout(() => send({",
    '        type: "result", subtype: "success", is_error: false,',
    '        session_id: sessionId, result: "완료했습니다.", num_turns: 1, duration_ms: 5,',
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

/**
 * 새로 남은 initialize 덤프 중 `matches` 를 만족하는 것의 전문. 대화 세션만
 * initialize 를 남기는 게 아니다 — memo·요약 같은 머신 턴의 CLI 도 남긴다.
 * "새 파일 하나"가 아니라 내용으로 대화 세션을 골라 낸다.
 */
async function dumpMatching(before, matches, label) {
  return waitFor(
    async () => {
      for (const entry of readdirSync(DUMPS)) {
        if (before.has(entry)) continue;
        const text = readFileSync(join(DUMPS, entry), "utf8");
        if (matches(text)) return text;
      }
      return null;
    },
    30_000,
    label,
  );
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DUMPS, { recursive: true });

  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });

  const port = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port,
    token: "common-instructions-e2e",
    claudeExecutable: writeDumpStubClaude(join(DIR, "bin")),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=common-instructions-e2e`);
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
      name: "지침",
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

    // --- 1. status 는 공통 블록을 읽기 전용 표시용으로 실어 나른다 ---------
    const appStatus = await request({ type: "daemon.status" });
    check(
      "status.commonInstructions is the app-authored block, verbatim",
      appStatus.commonInstructions === COMMON_INSTRUCTIONS,
      `${String(appStatus.commonInstructions).slice(0, 40)}…`,
    );

    // --- 2. 지침 없는 세션에도 공통 블록은 붙는다 ---------------------------
    let seen = new Set(readdirSync(DUMPS));
    const first = await request({ type: "session.create", title: "지침 없는 첫 대화" });
    const firstDump = await dumpMatching(
      seen,
      (text) => text.includes(COMMON_MARKER),
      "the first session's initialize dump",
    );
    // 덤프를 못 찾으면 dumpMatching 이 시간 초과로 실패한다 — 그래서 여기의
    // 조건은 마커가 아니라, 마커를 단 세션이 아직 규칙을 모른다는 것이다.
    check(
      "a session with no project instructions carries the common block (and no rule yet)",
      !firstDump.includes(PROJECT_RULE),
    );
    check("session.create answered with a live session id", typeof first.sessionId === "string");

    // --- 3. "지켜 줄 것"은 공통 블록 뒤에 이어진다 --------------------------
    await request({ type: "project.update", slug: project.slug, instructions: PROJECT_RULE });
    seen = new Set(readdirSync(DUMPS));
    await request({ type: "session.create", title: "지침 있는 둘째 대화" });
    const secondDump = await dumpMatching(
      seen,
      (text) => text.includes(COMMON_MARKER) && text.includes(PROJECT_RULE),
      "the second session's initialize dump",
    );
    check(
      "the project rule rides beside the common block",
      secondDump.includes(COMMON_MARKER) && secondDump.includes(PROJECT_RULE),
    );
    check(
      "the common block comes first, the project's words after it",
      secondDump.indexOf(COMMON_MARKER) < secondDump.indexOf(PROJECT_RULE),
    );

    // --- 4. 설계의 요지: 클론에는 파일이 하나도 남지 않는다 -----------------
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
