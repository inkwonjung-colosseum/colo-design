/**
 * Connected-repo end-to-end check. Uses no Claude session and therefore no
 * subscription usage; the remote is a local bare git repository seeded with a
 * minimal colo-design app (see fixture-repo.mjs), so everything runs offline.
 *
 * Covers what a planner's first minute depends on: the workspace clones,
 * installs once, reaches `ready` with a serving preview; a second sync pulls
 * and skips the install; a pushed commit arrives with the next pull; the same
 * workspace works through the wire the browser uses, `repo.update` stores a
 * PAT daemon-side without ever echoing it back; and shutdown gives the port
 * back.
 *
 * Usage: node packages/daemon/test/repo-e2e.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { RepoWorkspace } from "../dist/repo.js";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort, pushFixtureChange } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-repo-e2e");
const ROOT = join(DIR, "work");

/**
 * A foreign process holding the preview port — the holder 다시 시작 must be
 * able to kill. Its own process on purpose: port-killer kills the PID, and
 * the holder must not be this suite.
 */
function spawnSquatter(port) {
  const script = `require("node:http").createServer((_, res) => res.end("squatter")).listen(${port}, "127.0.0.1");`;
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

// Trust and PAT storage must never touch the real home during the run. The
// project registry is part of that: left on the default path the daemon would
// write ~/colo-design/config/projects.json, and the NEXT run would load this
// run's stale project — a repo url pointing at a fixture remote that is gone.
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_DESIGN_REPO_SETTINGS = join(DIR, "settings.json");
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function portAccepts(port) {
  const { promise, resolve } = Promise.withResolvers();
  const socket = createConnection({ port, host: "127.0.0.1" });
  const settle = (ok) => {
    socket.destroy();
    resolve(ok);
  };
  socket.setTimeout(1000);
  socket.once("connect", () => settle(true));
  socket.once("timeout", () => settle(false));
  socket.once("error", () => settle(false));
  return promise;
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = predicate();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });

  const port = await freePort();
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port });

  const broadcasts = [];
  const workspace = new RepoWorkspace({
    root: ROOT,
    url: fixture.remote,
    onStatus: (status) => broadcasts.push(status),
  });

  // --- 1. first sync: clone → install → preview ---------------------------
  const started = Date.now();
  // Two callers race on a fresh page load; they must share one bootstrap.
  const [first, second] = await Promise.all([workspace.sync(), workspace.sync()]);
  check("concurrent sync() calls share one bootstrap", first === second);
  check(
    "sync() reaches ready",
    first.phase === "ready",
    `${first.phase}${first.detail ? `: ${first.detail}` : ""} in ${Math.round((Date.now() - started) / 1000)}s`,
  );

  const phases = [...new Set(broadcasts.map((s) => s.phase))];
  check(
    "every bootstrap step is broadcast",
    ["cloning", "installing", "starting", "ready"].every((phase) => phases.includes(phase)),
    phases.join(" → "),
  );

  check(
    "preview url points at the declared port",
    first.previewUrl === `http://127.0.0.1:${port}` && first.previewPort === port,
    String(first.previewUrl),
  );
  check(
    "the clone exists and colo-design.json came with it",
    existsSync(join(ROOT, "colo-design.json")),
  );
  const response = await fetch(first.previewUrl);
  const body = await response.text();
  check(
    "the preview serves the repo's app",
    response.status === 200 && body.includes("회원 관리"),
    `${response.status}, ${body.length} bytes`,
  );

  // --- 2. stop() and a second sync: pull, no reinstall --------------------
  await workspace.stop();
  check("stop() releases the preview port", !(await portAccepts(port)), `port ${port}`);

  broadcasts.length = 0;
  const again = await workspace.sync();
  check("a second sync() serves again", again.phase === "ready", again.detail ?? "");
  check(
    "an unchanged dependency set skips the install",
    !broadcasts.some((s) => s.phase === "installing"),
    [...new Set(broadcasts.map((s) => s.phase))].join(" → "),
  );
  check(
    "an existing clone pulls instead of cloning",
    broadcasts.some((s) => s.phase === "pulling"),
    [...new Set(broadcasts.map((s) => s.phase))].join(" → "),
  );
  check("the restarted preview answers", (await fetch(again.previewUrl)).status === 200);

  // --- 3. a pushed commit arrives with the next sync ----------------------
  await pushFixtureChange(fixture.seed, fixture.remote, {
    "src/screens/member/MemberList.screen.tsx":
      "export default function MemberListScreen() { return null; }\n",
  });
  broadcasts.length = 0;
  const pulled = await workspace.sync();
  check(
    "a pushed commit reaches the clone",
    existsSync(join(ROOT, "src", "screens", "member", "MemberList.screen.tsx")),
  );
  check(
    "the pull is reported and the preview stays up",
    pulled.phase === "ready" && broadcasts.some((s) => s.phase === "pulling"),
    [...new Set(broadcasts.map((s) => s.phase))].join(" → "),
  );

  // --- 4. 다시 시작: the one button that may kill ---------------------------
  // The busy-port error is the one a planner cannot fix alone — the holder is
  // a foreign program. A plain sync reports it; the forced restart (what the
  // error screen's 다시 시작 sends) kills the holder and serves over the port.
  // The kill is listener-only: a blanket port kill also hits the port's
  // clients — this suite's own fetch included (a naive port-killer killed
  // this runner). Surviving to the next check is part of the assertion.
  await workspace.stop();
  const squatter = spawnSquatter(port);
  await waitFor(() => portAccepts(port), 10_000, "the squatter to hold the port");

  const blocked = await workspace.sync();
  check(
    "a plain sync reports a busy port instead of killing it",
    blocked.phase === "error" && (blocked.detail ?? "").includes("이미 쓰고 있어"),
    `${blocked.phase}: ${blocked.detail ?? ""}`,
  );
  check(
    "the foreign holder survives a plain sync",
    (await fetch(`http://127.0.0.1:${port}`).then((r) => r.text())) === "squatter",
  );

  const restarted = await workspace.sync(true);
  check(
    "the forced restart frees the port and reaches ready",
    restarted.phase === "ready",
    `${restarted.phase}: ${restarted.detail ?? ""}`,
  );
  check(
    "what answers the port now is the preview, not the squatter",
    (await fetch(`http://127.0.0.1:${port}`).then((r) => r.text())).includes("회원 관리"),
  );
  await waitFor(
    () => squatter.exitCode !== null || squatter.signalCode !== null,
    5_000,
    "the foreign holder to die",
  );
  check("the foreign holder process is gone", squatter.signalCode === "SIGKILL");
  await checkWireProtocol(port, fixture.remote, workspace);

  rmSync(DIR, { recursive: true, force: true });

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
  // A green suite ends deterministically — a lingering handle must not stall
  // the parallel runner's lane.
  process.exit(0);
}

/**
 * The same workspace through the wire the browser uses: `repo.status` must
 * stay read-only, `repo.update` must persist a PAT without echoing it back,
 * and every client must see the phase broadcasts.
 */
async function checkWireProtocol(previewPort, remoteUrl, workspace) {
  process.env.COLO_DESIGN_REPO_DIR = ROOT;
  process.env.COLO_DESIGN_REPO_URL = remoteUrl;
  const port = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port,
    token: "repo-e2e",
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=repo-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const request = async (message) => {
    ws.send(JSON.stringify(message));
    const reply = await waitFor(
      () => inbox.find((m) => m.id === message.id),
      120_000,
      message.type,
    );
    if (reply.type !== "ok") throw new Error(`${message.type} failed: ${reply.message}`);
    return reply;
  };

  try {
    const hello = await waitFor(() => inbox.find((m) => m.type === "hello"), 10_000, "hello");
    // 선로 버전은 살아 있는 값을 읽는다 — 승격이 테스트를 깨지 않는다.
    const { PROTOCOL_VERSION } = await import("../../protocol/dist/index.js");
    check(
      "hello speaks the pinned protocol",
      hello.protocolVersion === PROTOCOL_VERSION,
      String(hello.protocolVersion),
    );

    // The server owns its own workspace state; the preview this test process
    // started is foreign to it, so step aside before asking it to serve.
    await workspace.stop();

    // 검사의 말 그대로: 묻는 행위가 아무것도 시작하지 않는다. 절대적인
    // '포트가 조용하다' 는 이 자리에서 참이 아닐 수 있다 — killPreview 는
    // 포트 해제를 3초까지만 기다리고, 느린 러너에서는 방금 멈춘 미리보기의
    // 리스너가 그보다 늦게 사라진다. 그래서 묻기 전후를 비교한다: 상태 질의가
    // 포트를 없던 데서 살려 냈다면 그것이 '시작' 이다.
    const portBefore = await portAccepts(previewPort);
    const before = await request({ id: "1", type: "repo.status" });
    const portAfter = await portAccepts(previewPort);
    check(
      "repo.status reports the workspace without starting it",
      before.data.root === ROOT && before.data.url === remoteUrl && portAfter === portBefore,
      `${before.data.phase}, url=${before.data.url}, port ${portBefore} → ${portAfter}`,
    );

    // PAT storage went machine-wide (github.token.set); a repo.update that
    // still carries one has the field stripped by the protocol, not stored.
    const PAT = "ghp_repo_e2e_secret";
    const updated = await request({ id: "2", type: "repo.update", pat: PAT });
    check(
      "repo.update ignores a stray pat field and reports no per-project PAT",
      updated.data.phase === "ready" && !("patConfigured" in updated.data),
      `${updated.data.phase}`,
    );
    check(
      "the PAT never crosses the wire back",
      !JSON.stringify(inbox).includes(PAT),
      `${inbox.filter((m) => m.type === "repo.status").length} repo.status broadcasts inspected`,
    );
    check(
      // The repo url moved into the project registry when M1 landed; that file
      // is now the only thing the daemon writes for a connected repo, so it is
      // where a leaked PAT would show up.
      "the PAT is not persisted anywhere in the project registry",
      !readFileSync(join(DIR, "projects.json"), "utf8").includes(PAT),
    );
    check(
      "phase changes are broadcast to every client",
      inbox.some((m) => m.type === "repo.status" && m.status.phase === "pulling") &&
        inbox.some((m) => m.type === "repo.status" && m.status.phase === "ready"),
    );
    check(
      "the preview url serves the repo's app",
      (await fetch(updated.data.previewUrl)).status === 200,
      updated.data.previewUrl,
    );
  } finally {
    ws.close();
    await server.stop();
  }

  check(
    "daemon shutdown stops the preview",
    !(await portAccepts(previewPort)),
    `port ${previewPort}`,
  );
}

main().catch((error) => {
  console.error(error);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
