/**
 * Parallel test runner — the same suites as `test:sequential`, grouped into
 * four lanes that share no resources while running:
 *   L1 unit + app    — `node --test` suites and the two Electron app
 *                      suites (comments, smoke); every port is a free port
 *   L2 daemon e2e    — offline WebSocket suites; free ports + own tmpdirs
 *   L3 browser e2e   — Playwright UI suites; each binds its own fixed web
 *                      port (5397 settings, 5398 publish, 5401 onboarding,
 *                      5402 sidebar) — all distinct
 *   L4 real Claude   — screen-build (fixed web 5396 + daemon 7834) and
 *                      daemon status suites; they spend subscription turns
 *
 * Usage: node scripts/test-parallel.mjs [lane ...]   (default: all lanes)
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(
  process.cwd(),
  ".test-logs",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
// One directory per invocation: a complete multi-lane run's logs survive the
// next (possibly single-lane) run instead of being wiped by it.

const LANES = {
  L1: {
    name: "unit",
    suites: ["test:unit", "test:onboard-unit", "test:desktop-unit", "test:comments-ui", "test:desktop-smoke"],
  },
  L2: {
    name: "daemon-e2e",
    suites: ["test:projects", "test:rewind", "test:bootstrap", "test:repo", "test:publish", "test:onboarding"],
  },
  L3: {
    name: "browser-e2e",
    suites: [
      "test:publish-ui",
      "test:settings",
      "test:sidebar-ui",
      "test:onboarding-ui",
    ],
  },
  L4: {
    name: "real-claude",
    suites: ["test:daemon", "test:planner"],
  },
};

const requested = process.argv.slice(2);
const laneIds = requested.length > 0 ? requested : Object.keys(LANES);
for (const id of laneIds) {
  if (!LANES[id]) {
    console.error(`unknown lane '${id}' — valid: ${Object.keys(LANES).join(", ")}`);
    process.exit(2);
  }
}

mkdirSync(LOG_DIR, { recursive: true });

/** Lanes still running — killed with their groups on interrupt. */
const running = new Set();

/**
 * A lane that failed (or a runner that was interrupted) can leave
 * grandchildren behind: an Electron suite killed mid-flight holds the app's
 * single-instance lock, and the NEXT run's smoke dies on it — exactly the
 * contamination a failed lane once handed the run after it. Each lane runs
 * in its own process group, and the group dies with the lane: on a normal
 * close everything in it has already exited, so the kill is a no-op; what is
 * left is by definition leaked.
 */
function killLaneGroup(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone — the lane exited cleanly.
  }
}

function runLane(id, lane) {
  return new Promise((resolve) => {
    const log = join(LOG_DIR, `${id}-${lane.name}.log`);
    const startedAt = new Date();
    appendFileSync(log, `[${startedAt.toISOString()}] lane ${id} (${lane.name}): ${lane.suites.join(" && ")}\n`);
    const child = spawn(
      "bash",
      ["-lc", `set -o pipefail; ${lane.suites.map((suite) => `pnpm run ${suite}`).join(" && ")}`],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    running.add(child);
    child.stdout.on("data", (chunk) => appendFileSync(log, chunk));
    child.stderr.on("data", (chunk) => appendFileSync(log, chunk));
    child.on("close", (code) => {
      running.delete(child);
      killLaneGroup(child);
      const seconds = ((Date.now() - startedAt.getTime()) / 1000).toFixed(0);
      resolve({ id, name: lane.name, code: code ?? 1, seconds, log });
    });
    child.on("error", () => {
      running.delete(child);
      resolve({ id, name: lane.name, code: 1, seconds: "0", log });
    });
  });
}

// Ctrl-C on the runner must not leak the lanes it was running.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of running) killLaneGroup(child);
    process.exit(130);
  });
}

const startedAll = Date.now();
const results = await Promise.all(laneIds.map((id) => runLane(id, LANES[id])));
const elapsed = ((Date.now() - startedAll) / 1000).toFixed(0);

let failed = 0;
for (const result of results) {
  const verdict = result.code === 0 ? "PASS" : "FAIL";
  if (result.code !== 0) failed += 1;
  console.log(`${verdict}  lane ${result.id} (${result.name}) — ${result.seconds}s  log: ${result.log}`);
  // Per-suite outcome lines from each log, so the summary reads like the
  // sequential chain did.
  const text = readFileSync(result.log, "utf8");
  for (const line of text.split("\n")) {
    if (/checks passed$/.test(line) || /^# (tests|pass|fail) /.test(line)) {
      console.log(`        ${line.trim()}`);
    }
  }
  if (result.code !== 0) {
    const tail = text.split("\n").filter(Boolean).slice(-25).join("\n");
    console.log(`        --- last output ---\n${tail}`);
  }
}

console.log(`\n${failed === 0 ? "ALL LANES GREEN" : `${failed} LANE(S) FAILED`} — ${elapsed}s total`);
process.exit(failed === 0 ? 0 : 1);
