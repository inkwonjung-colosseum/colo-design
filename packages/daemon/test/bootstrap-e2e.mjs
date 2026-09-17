/**
 * 연결 준비 end-to-end (PLAN D94), fully offline: `colo-design.json` 이 없는
 * 레포를 `project.create` 로 추가하면 — 브링업은 레포의 package.json scripts
 * 만으로 ready 까지 가고(미리보기 포트는 뜬 서버의 출력에서 감지), 그 뒤에
 * 관례 준비 턴(brief 마커, purpose bootstrap)이 자동으로 열린다. 스텁 Claude 는
 * CLAUDE.md 에 관례 표식을 달고 화면 브리지 파일을 쓴다 — 그 파일들은 저장을
 * 기다리는 미해결 변경으로 남고, 첫 넘기기 PR 이 개발자의 수용 게이트다.
 * 준비는 클론당 한 번이다: 표식이 달린 뒤의 sync 는 턴을 다시 열지 않는다.
 *
 * Usage: node packages/daemon/test/bootstrap-e2e.mjs
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { BOOTSTRAP_BRIEF, BOOTSTRAP_TITLE, conventionsMarker } from "../dist/bootstrap-brief.js";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-bootstrap-e2e");
const MARKER = conventionsMarker(1);

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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * 준비 턴의 스텁: brief 를 받으면 'AI 가 한 일'을 흉내 낸다 — CLAUDE.md 를
 * 현행 관례 표식과 함께 다시 쓰고 화면 브리지 파일을 둔다. 설정 파일은 쓰지
 * 않는다: 포트는 데몬이 뜬 서버에서 읽고, 명령은 레포의 scripts 가 말한다.
 * 바뀐 파일은 커밋되지 않고 미해결 변경으로 남는다(저장 → 넘기기가 다음 관문).
 */
function bootstrapStub(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const pathMod = require("node:path");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (args[0] === "auth") {',
      '  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team", email: "p@x.com" }));',
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
      "      if (typeof o.session_id === 'string') sessionId = o.session_id;",
      `      fs.writeFileSync('CLAUDE.md', ${JSON.stringify(MARKER)} + "\\n# fixture colo-design 레포\\n\\n화면 브리지와 래퍼 관례를 적었습니다.\\n");`,
      "      fs.mkdirSync(pathMod.join('src', 'dev'), { recursive: true });",
      "      fs.writeFileSync(pathMod.join('src', 'dev', 'colo-bridge.js'), '// stub bridge\\n');",
      "      setTimeout(() => send({",
      '        type: "result", subtype: "success", is_error: false,',
      '        session_id: sessionId, result: "연결 준비를 마쳤습니다", num_turns: 1, duration_ms: 5,',
      "      }), 200);",
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
  mkdirSync(DIR, { recursive: true });

  // 포트를 선언하지 않는다 — 서버가 빈 포트를 고르고 출력이 그 주소를 말한다.
  const fixture = await createFixtureRepo({
    dir: join(DIR, "fixture"),
    omitConfig: true,
  });
  check(
    "the fixture seeds without colo-design.json",
    !existsSync(join(fixture.seed, "colo-design.json")),
  );

  const port = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port,
    token: "bootstrap-e2e",
    claudeExecutable: bootstrapStub(join(DIR, "bin")),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=bootstrap-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((ok, fail) => {
    ws.once("open", ok);
    ws.once("error", fail);
  });
  let nextId = 0;
  const request = async (message, timeoutMs = 180_000) => {
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
      name: "연결 준비",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    const status = await waitFor(
      async () => {
        const current = await request({ type: "repo.status" });
        return current.phase === "ready" || current.phase === "error" ? current : null;
      },
      180_000,
      "bring-up → ready",
    );
    check(
      "a repo with no colo-design.json brings itself up to ready",
      status.phase === "ready",
      `${status.phase} · ${status.detail ?? ""}`,
    );
    check(
      "the preview serves the app on the auto-detected port",
      status.previewUrl !== null && (await fetch(status.previewUrl)).status === 200,
      status.previewUrl ?? "(none)",
    );

    // 준비 턴은 브링업의 관문이 아니라 ready 뒤에 오는 훅이다 — 순서가 계약이다.
    const briefEcho = await waitFor(
      () =>
        inbox.findIndex(
          (m) =>
            m.type === "session.event" &&
            m.event.kind === "user.echo" &&
            m.event.text.includes('"purpose":"bootstrap"'),
        ),
      60_000,
      "the conventions-prep brief echo",
    );
    const readyAt = inbox.findIndex((m) => m.type === "repo.status" && m.status?.phase === "ready");
    check(
      "the conventions turn opens after ready, not as a bring-up gate",
      readyAt !== -1 && briefEcho > readyAt,
      `ready@${readyAt} brief@${briefEcho}`,
    );
    check(
      "the prep turn carries the 연결 준비 brief marker",
      inbox[briefEcho].event.text.includes(`"title":"${BOOTSTRAP_TITLE}"`) &&
        inbox[briefEcho].event.text.includes(BOOTSTRAP_BRIEF.slice(0, 40)),
    );

    // 스텁이 쓴 파일들은 커밋되지 않은 채 저장 → 넘기기 파이프라인을 기다린다.
    const pending = await waitFor(
      async () => {
        const current = await request({ type: "repo.status" });
        return current.pendingChanges >= 2 ? current : null;
      },
      60_000,
      "the stub's writes to count as pending",
    );
    check(
      "the preparation waits as unsaved changes — the first PR is the gate",
      pending.pendingChanges >= 2,
      String(pending.pendingChanges),
    );
    const claudeMd = readFileSync(join(status.root, "CLAUDE.md"), "utf8");
    check("the stub's CLAUDE.md carries the conventions marker", claudeMd.startsWith(MARKER));
    check(
      "the stub's bridge file landed in the clone",
      existsSync(join(status.root, "src", "dev", "colo-bridge.js")),
    );
    check(
      "no colo-design.json was written — the port is detected, not declared",
      !existsSync(join(status.root, "colo-design.json")),
    );

    // 표식이 달린 뒤(그리고 클론당 한 번의 시도 뒤) 두 번째 sync 는 준비 턴을
    // 다시 열지 않는다.
    await request({ type: "repo.sync" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const briefEchoes = inbox.filter(
      (m) =>
        m.type === "session.event" &&
        m.event.kind === "user.echo" &&
        m.event.text.includes('"purpose":"bootstrap"'),
    ).length;
    const sessions = await request({ type: "session.list" });
    const prepSessions = sessions.filter((s) => s.title === BOOTSTRAP_TITLE).length;
    check(
      "a second sync does not re-run conventions prep",
      briefEchoes === 1 && prepSessions === 1,
      `${briefEchoes} brief echo(es) · ${prepSessions} prep session(s)`,
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
