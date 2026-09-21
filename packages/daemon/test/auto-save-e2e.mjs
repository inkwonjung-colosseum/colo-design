/**
 * 자동 저장(P2-1)의 종단 — 저장 버튼이 사라진 세계의 계약 한 줄:
 * **답을 낸 턴 하나가 커밋 하나를 남긴다.**
 *
 * 두 가지를 못 박는다.
 *
 * 1. 게이트가 없는 턴 — 턴이 끝나면 사람이 아무것도 누르지 않아도 커밋이
 *    하나 생기고, 그 제목은 그 턴을 연 **사용자의 말**이다(메모 턴을 하나 더
 *    돌리면 턴마다 구독이 두 배로 탄다). 워크트리는 다시 깨끗해진다.
 * 2. 화면 확인 게이트가 걸린 턴 — 커밋은 게이트의 판정이 **끝난 뒤**에,
 *    그리고 **한 번만** 걸린다. 게이트가 고침 턴을 열면 워크트리가 다시
 *    더러워지므로, 먼저 커밋하면 한 턴이 커밋 둘로 갈린다. 이 파일은 그것을
 *    시간이 아니라 사실로 잰다: 게이트의 드라이버가 화면을 여는 순간 클론이
 *    아직 더러웠는가.
 *
 * 원격은 로컬 bare 레포(fixture-repo.mjs), CLI 는 스텁이다 — 모델 턴은 한 번도
 * 쓰지 않는다. 게이트의 창은 가짜 PreviewDriver 로 주입한다(브라우저 개발
 * 경로에 창이 없는 것과 같은 자리).
 *
 * Usage: node packages/daemon/test/auto-save-e2e.mjs
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const run = promisify(execFile);

const DIR = join(tmpdir(), "colo-design-auto-save-e2e");
const ROOT = join(DIR, "work");

process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_DESIGN_REPO_SETTINGS = join(DIR, "settings.json");
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_UNDO_LOG = join(DIR, "undo.jsonl");

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

const git = async (...args) => (await run("git", ["-C", ROOT, ...args])).stdout.trim();
/** 이번 사이클이 베이스 위에 쌓은 커밋 수 — 자동 저장이 남긴 것 전부. */
const cycleCommits = async () =>
  Number(await git("rev-list", "--count", "origin/main..HEAD").catch(() => "0"));
const cycleSubjects = async () =>
  (await git("log", "--pretty=%s", "origin/main..HEAD").catch(() => ""))
    .split("\n")
    .filter(Boolean);
const dirty = async () => (await git("status", "--porcelain")).length > 0;

/**
 * 턴마다 클론에 파일 하나를 남기고 답하는 스텁 CLI. 자동 저장이 커밋할 것을
 * 만드는 것이 이 스텁의 유일한 일이다 — 진짜 CLI 라면 화면 파일이 그 자리다.
 */
function stubClaude(dir) {
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'const { writeFileSync, mkdirSync } = require("node:fs");',
      'const { join } = require("node:path");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (args[0] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
      "  process.exit(0);",
      "}",
      'let buf = "";',
      "let turns = 0;",
      "const seen = () => {",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      '    if (line.includes(\'"subtype":"interrupt"\') || line.includes(\'"subtype":"set_permission_mode"\')) {',
      '      const id = (line.match(/"request_id":"([^"]*)"/) || [])[1];',
      "      process.stdout.write(JSON.stringify({",
      '        type: "control_response",',
      '        response: { subtype: "success", request_id: id },',
      '      }) + "\\n");',
      "      continue;",
      "    }",
      '    if (line.includes(\'"type":"user"\')) {',
      '      const sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || "stub";',
      "      turns += 1;",
      "      // 화면 하나를 만든 셈 친다 — 답하기 전에 디스크에 남긴다.",
      '      mkdirSync(join(process.cwd(), "src", "screens", "auto"), { recursive: true });',
      "      writeFileSync(",
      '        join(process.cwd(), "src", "screens", "auto", `Turn${turns}.screen.tsx`),',
      "        `export default function Turn${turns}() { return null; }\\n`,",
      "      );",
      "      process.stdout.write(JSON.stringify({",
      '        type: "result", subtype: "success", is_error: false,',
      '        session_id: sessionId, result: "만들었습니다.", num_turns: 1, duration_ms: 10,',
      '      }) + "\\n");',
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

/**
 * 게이트가 빌려 쓰는 가짜 창. 판정은 언제나 "깨끗하다" 이므로 고침 턴은 열리지
 * 않는다 — 이 파일이 재는 것은 판정의 내용이 아니라 **커밋의 순서**다.
 * `open` 이 불리는 순간의 워크트리 상태를 그대로 적어 둔다.
 */
function gateWindow(log) {
  const driver = {
    async open(route) {
      log.opened.push(route);
      log.dirtyAtOpen.push(await dirty());
      return { ok: true, settled: true };
    },
    async screenshot() {
      return { data: "", mediaType: "image/png" };
    },
    async consoleLines() {
      return [];
    },
    async destroy() {
      log.destroyed += 1;
    },
  };
  return {
    for: () => driver,
    forIsolated: () => driver,
  };
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  process.env.COLO_DESIGN_CLAUDE_BIN = stubClaude(join(DIR, "claude-config"));
  const port = await freePort();
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port });

  process.env.COLO_DESIGN_REPO_DIR = ROOT;
  process.env.COLO_DESIGN_REPO_URL = fixture.remote;
  const daemonPort = await freePort();
  const gateLog = { opened: [], dirtyAtOpen: [], destroyed: 0 };
  const server = new DaemonServer({
    host: "127.0.0.1",
    port: daemonPort,
    token: "auto-save-e2e",
    previewDriverFactory: gateWindow(gateLog),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}?token=auto-save-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const request = async (message, timeoutMs = 120_000) => {
    ws.send(JSON.stringify(message));
    const reply = await waitFor(
      () => inbox.find((m) => m.id === message.id),
      timeoutMs,
      message.type,
    );
    if (reply.type !== "ok") throw new Error(`${message.type} failed: ${reply.message}`);
    return reply.data;
  };
  const settled = async (sessionId, since) =>
    waitFor(
      () =>
        inbox
          .slice(since)
          .some(
            (m) => m.type === "session.state" && m.sessionId === sessionId && m.state === "idle",
          )
          ? true
          : null,
      60_000,
      "turn settling",
    );

  try {
    const ready = await request({ id: "1", type: "repo.sync" });
    check(
      "the fixture repo clones and the preview answers",
      ready.phase === "ready",
      ready.detail ?? "",
    );

    const created = await request({ id: "2", type: "session.create" });
    const sessionId = created.sessionId;

    // --- 1. 게이트 없는 턴: 아무도 누르지 않아도 커밋 하나 ------------------
    check("nothing is committed before the first turn", (await cycleCommits()) === 0);
    let mark = inbox.length;
    await request({
      id: "3",
      type: "session.send",
      sessionId,
      text: "회원 목록 화면을 만들어 주세요",
    });
    await settled(sessionId, mark);
    await waitFor(async () => (await cycleCommits()) >= 1, 60_000, "the turn's own commit");

    check(
      "a settled turn leaves exactly one commit — nobody pressed anything",
      (await cycleCommits()) === 1,
      (await cycleSubjects()).join(" | "),
    );
    check(
      "the commit's subject is the words that opened the turn — no second model turn for a memo",
      (await cycleSubjects())[0] === "회원 목록 화면을 만들어 주세요",
      (await cycleSubjects())[0] ?? "(none)",
    );
    check("the worktree is clean again", (await dirty()) === false);
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    check(
      "the commit rode this cycle's own branch — the developer's base is untouched",
      /^colo-design\/\d{8}-\d+$/.test(branch),
      branch,
    );

    // --- 2. 게이트가 걸린 턴: 판정 뒤에, 한 번만 --------------------------
    mark = inbox.length;
    await request({
      id: "4",
      type: "session.send",
      sessionId,
      text: "결제 실패 화면도 만들어 주세요",
      pins: [{ screen: "member/MemberList" }],
    });
    await settled(sessionId, mark);
    await waitFor(() => gateLog.opened.length > 0, 60_000, "the gate opening a screen");
    await waitFor(async () => (await cycleCommits()) >= 2, 60_000, "the gated turn's commit");
    // 게이트는 판정을 내고 물러난다 — 조금 더 두어 두 번째 커밋이 있었다면 잡는다.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    check(
      "the pinned turn ran the screen gate",
      gateLog.opened.length === 1,
      gateLog.opened.join(", "),
    );
    check(
      "the commit waited for the gate — the clone was still dirty when the screen opened",
      gateLog.dirtyAtOpen[0] === true,
      `dirtyAtOpen=${gateLog.dirtyAtOpen.join(",")}`,
    );
    check(
      "and the gated turn left exactly ONE commit, not two",
      (await cycleCommits()) === 2,
      (await cycleSubjects()).join(" | "),
    );
    check(
      "its subject is the second turn's words",
      (await cycleSubjects())[0] === "결제 실패 화면도 만들어 주세요",
      (await cycleSubjects())[0] ?? "(none)",
    );
    check("the worktree is clean after the gated turn too", (await dirty()) === false);

    // --- 3. 백그라운드 푸시 — 커밋은 원격까지 따라간다 ---------------------
    // 자동 저장의 푸시는 실패를 삼키지만, 닿을 수 있는 원격에는 닿는다.
    await waitFor(
      async () => {
        const { stdout } = await run("git", ["--git-dir", fixture.remote, "branch", "--list"]);
        return stdout.includes("colo-design/");
      },
      60_000,
      "the background push reaching the remote",
    );
    check("the background push carried the cycle branch to the remote", true);
  } finally {
    ws.close();
    await server.stop().catch(() => undefined);
  }

  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error("\nAUTO SAVE E2E ERROR:", error);
  process.exit(1);
});
