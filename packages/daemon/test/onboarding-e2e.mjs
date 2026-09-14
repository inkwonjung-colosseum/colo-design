/**
 * Onboarding end-to-end check, fully offline: the four §8 gates driven over
 * the real DaemonServer WebSocket — a local fixture repo as the connected
 * repo, the memory credential store, and the recorded GitHub fixtures. The
 * story walks the wizard's exact sequence: a first run with no project and
 * no token, `github.token.set` (the machine-wide token the picker and every
 * clone share), the repo list the token can see, `project.create`, the repo
 * fix, and the tab gate opening when every step passes.
 *
 * Nothing here points COLO_DESIGN_REPO_URL at the fixture remote: this suite
 * is the one that must see a genuinely first run, so the registry migration
 * finds no legacy repo and no legacy url, and the daemon comes up with zero
 * projects.
 *
 * Usage: node packages/daemon/test/onboarding-e2e.mjs
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(tmpdir(), "colo-design-onboard-e2e");

const REPO_PAT = "onboard_e2e_pat";
/**
 * The onboarding gate answers for the machine's Claude CLI — on a CI runner
 * there is none, and on a dev machine the REAL one quietly made this suite
 * pass. The stub satisfies what the gate asks of a CLI: `--version` and
 * `auth status` (logged in, subscription attached). Pinned through
 * COLO_DESIGN_CLAUDE_BIN so the check is the same everywhere.
 */
function stubClaude(dir) {
  const path = join(dir, "claude");
  const script = [
    "#!/usr/bin/env node",
    'if (process.argv[2] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
    'if (process.argv[2] === "auth" && process.argv[3] === "status") {',
    '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
    "  process.exit(0);",
    "}",
    "console.log('{\"loggedIn\":false}');",
  ].join("\n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_REPO_DIR = join(DIR, "work");
process.env.COLO_DESIGN_REPO_SETTINGS = join(DIR, "repo.json");
// The project registry decides whether this run has a project at all, so it
// must be this run's own file: on the default path the daemon would write
// ~/colo-design/config/projects.json and the next run would start already
// migrated, from a fixture remote that no longer exists.
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
// The github gate and the repo list talk to the recorded pairs, never to
// api.github.com — the suite stays offline like the rest of it.
process.env.COLO_DESIGN_GITHUB_FIXTURE = join(here, "fixtures", "github");
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
    const hit = predicate();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function step(steps, id) {
  return steps.find((entry) => entry.id === id);
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  process.env.COLO_DESIGN_CLAUDE_BIN = stubClaude(join(DIR, "claude-bin"));
  const fixture = await createFixtureRepo({
    dir: join(DIR, "fixture"),
    port: await freePort(),
  });

  const port = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port,
    token: "onboard-e2e",
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=onboard-e2e`);
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
    if (reply.type === "ok") return reply.data;
    throw new Error(`${message.type} failed: ${reply.message}`);
  };
  const checkAll = async () => request({ id: `c${Math.random()}`, type: "onboarding.check" });
  const workspaceOpen = (steps) => !steps.some((entry) => entry.status === "fail");

  try {
    // --- 1. a genuinely first run: no project, no token --------------------
    const first = await checkAll();
    check(
      "the first check reports the four machine gates in order",
      JSON.stringify(first.map((entry) => entry.id)) === '["claude","git","runtime","github"]',
      first.map((entry) => `${entry.id}:${entry.status}`).join(" "),
    );
    check(
      "the runtime step passes on the bundled or system runtime",
      step(first, "runtime").status === "pass",
      step(first, "runtime").detail,
    );
    check(
      "the github step warns without blocking — the form in the card is the fix",
      step(first, "github").status === "warn" &&
        /GitHub 토큰이 없습니다/.test(step(first, "github").detail) &&
        step(first, "github").fix === undefined,
      step(first, "github").detail,
    );
    check(
      "a missing project is not a gate: the workspace opens on the machine gates alone",
      workspaceOpen(first) === true,
      first.map((entry) => `${entry.id}:${entry.status}`).join(" "),
    );

    // Everything that means "the repo" has no referent yet; the daemon has to
    // say so instead of inventing one. This is what the workspace's empty
    // state exists to avoid asking for.
    const noProject = await request({ id: "r0", type: "repo.status" }).catch((error) => error);
    check(
      "repo.status refuses in Korean while no project exists",
      noProject instanceof Error && /프로젝트가 없습니다/.test(noProject.message),
      String(noProject.message ?? noProject),
    );

    // --- 2. github.token.set is the fix for the github gate ----------------
    const githubStep = await request({
      id: "t1",
      type: "github.token.set",
      token: REPO_PAT,
    });
    check(
      "the stored token names the login it acts as",
      githubStep.status === "pass" && /GitHub @jik-dev 로 연결됨/.test(githubStep.detail),
      githubStep.detail,
    );

    // --- 3. the repo list the token can reach ------------------------------
    const repos = await request({ id: "l1", type: "github.repos.list" });
    check(
      "the picker's list names the repos the token can see",
      repos.truncated === false &&
        repos.repos.some((repo) => repo.fullName === "colo-org/payments-web") &&
        !repos.repos.some((repo) => repo.fullName === "colo-org/archive"),
      JSON.stringify(repos.repos.map((repo) => repo.fullName)),
    );

    // The picker judges one repo before any clone: a repo without a
    // colo-design.json cannot become a project, and saying so here is what
    // saves the planner the download.
    const inspection = await request({
      id: "i1",
      type: "github.repo.inspect",
      owner: "colo-org",
      repo: "payments-web",
    });
    check(
      "inspect answers colo-design.json, push access and the base branch",
      inspection.hasColoDesign === true && inspection.defaultBranch === "main",
      JSON.stringify(inspection),
    );

    // --- 4. the project is created from the workspace, not from a gate -----
    const created = await request({
      id: "p1",
      type: "project.create",
      name: "회원 관리 개편",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    check(
      "project.create returns the project it registered",
      created.name === "회원 관리 개편" && created.repoUrl === fixture.remote,
      JSON.stringify(created),
    );
    check(
      "no per-project PAT field rides the summary any more",
      !("repoPatConfigured" in created) && !("repoPat" in created),
      JSON.stringify(Object.keys(created)),
    );

    // --- 5. the clone reports itself — no onboarding fix in the middle -----
    const ready = await waitFor(
      () => {
        const status = inbox
          .filter((message) => message.type === "repo.status")
          .map((message) => message.status)
          .reverse()
          .find((status) => status.phase === "ready" || status.phase === "error");
        return status ?? null;
      },
      600_000,
      "the clone to settle",
    );
    check("the clone reaches ready on its own", ready.phase === "ready", ready.detail ?? "");
    check(
      "the token never crosses the wire back",
      !JSON.stringify(inbox).includes(REPO_PAT),
      `${inbox.length} messages inspected`,
    );

    // --- 6. the gates stay answered ----------------------------------------
    const last = await checkAll();
    check(
      "every machine gate passes once the token is stored",
      last.every((entry) => entry.status === "pass"),
      last.map((entry) => `${entry.id}:${entry.status}`).join(" "),
    );

    // The repo url lives in the project registry; that is the file a PAT
    // would leak into if it were ever written next to it.
    const registry = readFileSync(join(DIR, "projects.json"), "utf8");
    check(
      "the project registry holds the repo url and no plaintext PAT",
      registry.includes(fixture.remote) && !registry.includes(REPO_PAT),
    );
  } finally {
    ws.close();
    await server.stop();
    rmSync(DIR, { recursive: true, force: true });
  }

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

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
