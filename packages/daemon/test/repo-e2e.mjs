/**
 * Connected-repo end-to-end check. Uses no Claude session and therefore no
 * subscription usage; the remote is a local bare git repository seeded with a
 * minimal cds-design app (see fixture-repo.mjs), so everything runs offline.
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
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { RepoWorkspace } from "../dist/repo.js";
import { createFixtureRepo, freePort, pushFixtureChange } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "cds-design-repo-e2e");
const ROOT = join(DIR, "work");

// Trust and PAT storage must never touch the real home during the run. The
// project registry is part of that: left on the default path the daemon would
// write ~/cds-design/config/projects.json, and the NEXT run would load this
// run's stale project — a repo url pointing at a fixture remote that is gone.
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.CDS_DESIGN_REPO_SETTINGS = join(DIR, "settings.json");
process.env.CDS_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.CDS_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.CDS_DESIGN_CREDENTIAL_STORE = "memory";

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
  check("the clone exists and cds-design.json came with it", existsSync(join(ROOT, "cds-design.json")));
  const response = await fetch(first.previewUrl);
  const body = await response.text();
  check("the preview serves the repo's app", response.status === 200 && body.includes("회원 관리"), `${response.status}, ${body.length} bytes`);

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
    "src/screens/member/MemberList.screen.tsx": "export default function MemberListScreen() { return null; }\n",
  });
  broadcasts.length = 0;
  const pulled = await workspace.sync();
  check("a pushed commit reaches the clone", existsSync(join(ROOT, "src", "screens", "member", "MemberList.screen.tsx")));
  check(
    "the pull is reported and the preview stays up",
    pulled.phase === "ready" && broadcasts.some((s) => s.phase === "pulling"),
    [...new Set(broadcasts.map((s) => s.phase))].join(" → "),
  );

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
  process.env.CDS_DESIGN_REPO_DIR = ROOT;
  process.env.CDS_DESIGN_REPO_URL = remoteUrl;
  const port = await freePort();
  const server = new DaemonServer({ host: "127.0.0.1", port, token: "repo-e2e" });
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
    const reply = await waitFor(() => inbox.find((m) => m.id === message.id), 120_000, message.type);
    if (reply.type !== "ok") throw new Error(`${message.type} failed: ${reply.message}`);
    return reply;
  };

  try {
    const hello = await waitFor(() => inbox.find((m) => m.type === "hello"), 10_000, "hello");
    check("hello speaks protocol v10", hello.protocolVersion === 10, String(hello.protocolVersion));

    // The server owns its own workspace state; the preview this test process
    // started is foreign to it, so step aside before asking it to serve.
    await workspace.stop();

    const before = await request({ id: "1", type: "repo.status" });
    check(
      "repo.status reports the workspace without starting it",
      before.data.root === ROOT && before.data.url === remoteUrl && before.data.previewUrl === null,
      `${before.data.phase}, url=${before.data.url}`,
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

  check("daemon shutdown stops the preview", !(await portAccepts(previewPort)), `port ${previewPort}`);
}

main().catch((error) => {
  console.error(error);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
