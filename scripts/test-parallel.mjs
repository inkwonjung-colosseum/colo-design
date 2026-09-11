/**
 * Parallel test runner — the same suites as `test:sequential`, grouped into
 * four lanes that share no resources while running:
 *   L1 unit          — pure `node --test`, no ports, no daemons
 *   L2 daemon e2e    — offline WebSocket suites; free ports + own tmpdirs
 *   L3 browser e2e   — Playwright UI suites; each binds its own fixed web
 *                      port (5397 settings, 5398 publish,
 *                      5400 comments, 5401 onboarding) — all distinct
 *   L4 real Claude   — screen-build (fixed web 5396 + daemon 7834) and
 *                      daemon status suites; they spend subscription turns
 * A lane fails if ANY of its suites fails; the runner exits non-zero and
 * prints the failing lanes' tails. Logs land in .test-logs/ (gitignored).
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
    suites: ["test:unit", "test:onboard-unit", "test:desktop-unit", "test:comments-ui"],
  },
  L2: {
    name: "daemon-e2e",
    suites: ["test:projects", "test:repo", "test:publish", "test:onboarding"],
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

function runLane(id, lane) {
  return new Promise((resolve) => {
    const log = join(LOG_DIR, `${id}-${lane.name}.log`);
    const startedAt = new Date();
    appendFileSync(log, `[${startedAt.toISOString()}] lane ${id} (${lane.name}): ${lane.suites.join(" && ")}\n`);
    const child = spawn(
      "bash",
      ["-lc", `set -o pipefail; ${lane.suites.map((suite) => `pnpm run ${suite}`).join(" && ")}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk) => appendFileSync(log, chunk));
    child.stderr.on("data", (chunk) => appendFileSync(log, chunk));
    child.on("close", (code) => {
      const seconds = ((Date.now() - startedAt.getTime()) / 1000).toFixed(0);
      resolve({ id, name: lane.name, code: code ?? 1, seconds, log });
    });
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
