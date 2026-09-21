/**
 * Parallel test runner — the same suites as `test:sequential`, grouped into
 * five lanes that share no resources while running:
 *   L1 unit          — `node --test` suites; no port, no window, no display
 *   L2 daemon e2e    — offline WebSocket suites; free ports + own tmpdirs
 *   L3 browser e2e   — Playwright UI suites; each binds its own web port —
 *                      a few older suites pin theirs (5397 settings,
 *                      5398 publish), the rest pick free ports
 *   L4 real Claude   — screen-build (fixed web 5396 + daemon 7834) and
 *                      daemon status suites; they spend subscription turns,
 *                      so they are opt-in: `pnpm test` skips them, CI never
 *                      runs them, `pnpm test:real` asks for them
 *   L5 electron      — the Electron app suites; each suite restages
 *                      packages/desktop/web-dist (rmSync+cpSync), so the
 *                      runner stages it once up front and hands the suites
 *                      COLO_TEST_SKIP_WEBDIST=1 — the copy is the only shared
 *                      mutable state, everything else (userData, ports) is
 *                      already per-suite
 *
 * Every lane reads `dist/`, so the runner builds ONCE up front — and only the
 * packages the requested lanes read (L1/L2 skip the web bundle's ~20s of
 * vite). Before this, four Electron suites each ran `pnpm build` themselves —
 * minutes of repeated compiling, and worse, `tsc` rewriting
 * `packages/daemon/dist` WHILE L2 and L3 imported it (three L2 suites once
 * died mid-run on a half-written module, green on a rerun).
 *
 * Each suite runs as its own process with its own log and its own progress
 * deadline — a failing suite no longer short-circuits the rest of its lane
 * the way `pnpm run a && pnpm run b` once did.
 *
 * Usage: node scripts/test-parallel.mjs [lane ...]   (default: all but L4)
 * Env:   COLO_TEST_LANE_CONCURRENCY — suites per lane at once (default 1;
 *        L5 always stays serial). L2/L3 bind only free ports + tmpdirs so a
 *        local bump is safe; the CI matrix keeps the default because the
 *        lanes already split the runners, and freePort()'s check-then-bind
 *        window can hand two parallel suites the same port once in a long
 *        while.
 *        COLO_TEST_SKIP_BUILD — the caller built already (CI does).
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), ".test-logs", new Date().toISOString().replace(/[:.]/g, "-"));
// One directory per invocation: a complete multi-lane run's logs survive the
// next (possibly single-lane) run instead of being wiped by it.

const LANES = {
  L1: {
    name: "unit",
    needs: ["@colo-design/daemon..."],
    suites: ["test:contrast", "test:unit", "test:onboard-unit"],
  },
  L2: {
    name: "daemon-e2e",
    needs: ["@colo-design/daemon..."],
    suites: [
      "test:projects",
      "test:common-instructions",
      "test:permission-repeat",
      "test:branch",
      "test:repo",
      "test:preview-detect",
      "test:publish",
      "test:auto-save",
      "test:onboarding",
      "test:plan",
      "test:crash",
      "test:midturn-queue",
      "test:turn-clock",
    ],
  },
  L3: {
    name: "browser-e2e",
    needs: ["@colo-design/daemon...", "@colo-design/web..."],
    suites: [
      "test:publish-ui",
      "test:settings",
      "test:first-send",
      "test:thread-delete-ui",
      "test:clear-all-ui",
      "test:sidebar-ui",
      "test:status-menu-ui",
      "test:onboarding-ui",
      "test:branch-ui",
      "test:chat-settings-ui",
      "test:selector-chain",
      "test:silence",
    ],
  },
  L4: {
    name: "real-claude",
    needs: ["@colo-design/daemon...", "@colo-design/web..."],
    suites: ["test:daemon", "test:planner"],
  },
  L5: {
    name: "electron",
    // desktop's deps are daemon+protocol — web is not among them, so the web
    // bundle filter must be named or the suites' web-dist staging has no
    // packages/web/dist to copy.
    needs: ["@colo-design/desktop...", "@colo-design/web..."],
    stagesWebDist: true,
    // Electron suites stay serial even when in-lane concurrency is on: their
    // window/timing assertions (the work-area size, focus order) are
    // load-sensitive, and under parallel Electron they flake by pixels, not
    // by shared state.
    maxConcurrency: 1,
    suites: [
      // Every suite here boots a real Electron: the driver unit through its
      // own entry, the four app suites through the app's. web-dist (the one
      // shared mutable state) is staged once by the runner; the lane stays
      // serial anyway because the suites' window/timing assertions flake
      // under parallel Electron load.
      "test:desktop-unit",
      "test:comments-ui",
      "test:desktop-smoke",
      "test:desktop-switch",
      "test:pane",
      "test:browser-driver",
    ],
  },
};

const requested = process.argv.slice(2);
const laneIds = requested.length > 0 ? requested : Object.keys(LANES).filter((id) => id !== "L4");
for (const id of laneIds) {
  if (!LANES[id]) {
    console.error(`unknown lane '${id}' — valid: ${Object.keys(LANES).join(", ")}`);
    process.exit(2);
  }
}

// Scripts are the single source of truth for what a suite runs; every one of
// them is a plain `node ...` invocation, so the runner spawns the argv
// directly instead of paying ~330ms of `pnpm run` (plus a login shell) per
// suite.
const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
function suiteArgv(name) {
  const script = pkg.scripts?.[name];
  if (!script) {
    console.error(`suite '${name}' is not a package.json script`);
    process.exit(2);
  }
  const argv = script.trim().split(/\s+/);
  if (argv[0] !== "node") {
    console.error(`suite '${name}' is not a plain node script: ${script}`);
    process.exit(2);
  }
  return argv;
}

// The one build every lane reads — filtered to the packages the requested
// lanes actually consume. CI builds in its own step and sets the flag; a
// developer running `pnpm test` gets it here, once.
if (!process.env.COLO_TEST_SKIP_BUILD) {
  const startedBuild = Date.now();
  const filters = [...new Set(laneIds.flatMap((id) => LANES[id].needs))];
  const build = spawnSync("pnpm", [...filters.flatMap((f) => ["--filter", f]), "build"], {
    stdio: "inherit",
  });
  if (build.status !== 0) {
    console.error("build failed — no lane can run against a dist that is not there");
    process.exit(build.status ?? 1);
  }
  console.log(`build — ${((Date.now() - startedBuild) / 1000).toFixed(0)}s`);
}

// web-dist is the Electron suites' one shared mutable resource: stage it once
// here so the suites can run (serially or not) without rmSync'ing the floor
// out from under each other.
const LANE_ENV = { ...process.env, COLO_TEST_SKIP_BUILD: "1" };
if (laneIds.some((id) => LANES[id].stagesWebDist)) {
  const staged = spawnSync(process.execPath, ["packages/desktop/scripts/stage-web-dist.mjs"], {
    stdio: "inherit",
  });
  if (staged.status !== 0) {
    console.error("web-dist staging failed — the Electron suites have no bundle to serve");
    process.exit(staged.status ?? 1);
  }
  LANE_ENV.COLO_TEST_SKIP_WEBDIST = "1";
}

mkdirSync(LOG_DIR, { recursive: true });

// Number() quietly makes NaN of a non-numeric value — which would flow into
// Math.min and Array.from({length: NaN}), run ZERO workers per lane, and end
// with a green summary over suites that never ran.
const laneConcurrency = Number(process.env.COLO_TEST_LANE_CONCURRENCY ?? 1);
const CONCURRENCY = Math.max(1, Number.isFinite(laneConcurrency) ? laneConcurrency : 1);

/** Suites still running — killed with their groups on interrupt. */
const running = new Set();

/**
 * A suite that fails (or a runner that is interrupted) can leave
 * grandchildren behind: an Electron suite killed mid-flight leaves daemon
 * children holding preview ports, and the NEXT suite meets them as
 * strangers — exactly the contamination a failed run once handed the run
 * after it. Each suite runs in its own process group, and the group dies
 * with it: on a normal close everything in it has already exited, so the
 * kill is a no-op; what is left is by definition leaked.
 */
function killSuiteGroup(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone — the suite exited cleanly.
  }
}

/**
 * A suite that stops making progress must fail loudly instead of eating the
 * whole run: a hung Electron window once burned a 45 분 CI job to its limit
 * and the job's cancellation threw the lane logs away with it. The deadline
 * refreshes on every byte the suite prints — it fires on a hang, never on a
 * slow-but-moving suite (the slowest suite on a cold runner, Electron
 * 내려받기 포함, is minutes, not tens of them).
 */
// Same NaN trap as CONCURRENCY: Number("abc") * 60_000 is NaN, and
// setTimeout(NaN) fires in 1ms — every suite would instantly "TIMEOUT".
const laneTimeoutMin = Number(process.env.COLO_TEST_LANE_TIMEOUT_MIN ?? 15);
const SUITE_TIMEOUT_MS =
  (Number.isFinite(laneTimeoutMin) && laneTimeoutMin > 0 ? laneTimeoutMin : 15) * 60_000;

/** SIGTERM first, then a hard kill for whatever ignored it. */
function killSuiteGroupHard(child) {
  killSuiteGroup(child);
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is gone — the SIGTERM was enough.
    }
  }, 5_000).unref();
}

function runSuite(laneId, suite) {
  return new Promise((resolve) => {
    const log = join(LOG_DIR, `${laneId}-${suite.replace(/^test:/, "")}.log`);
    const startedAt = Date.now();
    appendFileSync(log, `[${new Date().toISOString()}] ${suite}\n`);
    const child = spawn(process.execPath, suiteArgv(suite).slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: LANE_ENV,
    });
    running.add(child);
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      appendFileSync(
        log,
        `\n[timeout] ${suite} made no progress for ${SUITE_TIMEOUT_MS / 60_000}m — killing its group\n`,
      );
      killSuiteGroupHard(child);
    }, SUITE_TIMEOUT_MS);
    // Output is progress: every line a live suite prints pushes the hang
    // deadline out — a hard cap would have killed suites mid-flight on slow
    // runners.
    const progress = (chunk) => {
      appendFileSync(log, chunk);
      deadline.refresh();
    };
    child.stdout.on("data", progress);
    child.stderr.on("data", progress);
    child.on("close", (code) => {
      clearTimeout(deadline);
      running.delete(child);
      killSuiteGroup(child);
      resolve({
        laneId,
        suite,
        code: timedOut ? 124 : (code ?? 1),
        seconds: ((Date.now() - startedAt) / 1000).toFixed(0),
        log,
        timedOut,
      });
    });
    child.on("error", () => {
      clearTimeout(deadline);
      running.delete(child);
      resolve({ laneId, suite, code: 1, seconds: "0", log, timedOut: false });
    });
  });
}

/** Run a lane's suites with the lane's concurrency bound, collecting every verdict. */
async function runLane(id, lane) {
  const results = [];
  let next = 0;
  const bound = Math.min(lane.maxConcurrency ?? CONCURRENCY, lane.suites.length);
  const workers = Array.from({ length: bound }, async () => {
    while (next < lane.suites.length) {
      const suite = lane.suites[next++];
      results.push(await runSuite(id, suite));
    }
  });
  await Promise.all(workers);
  return results;
}

// Ctrl-C on the runner must not leak the suites it was running.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of running) killSuiteGroup(child);
    process.exit(130);
  });
}

const startedAll = Date.now();
const results = (await Promise.all(laneIds.map((id) => runLane(id, LANES[id])))).flat();
const elapsed = ((Date.now() - startedAll) / 1000).toFixed(0);

let failed = 0;
for (const result of results) {
  const verdict = result.code === 0 ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL";
  if (result.code !== 0) failed += 1;
  console.log(
    `${verdict}  ${result.laneId} ${result.suite} — ${result.seconds}s  log: ${result.log}`,
  );
  // Outcome lines from each log, so the summary reads like the sequential
  // chain did.
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

console.log(
  `\n${failed === 0 ? "ALL SUITES GREEN" : `${failed} SUITE(S) FAILED`} — ${elapsed}s total`,
);
process.exit(failed === 0 ? 0 : 1);
