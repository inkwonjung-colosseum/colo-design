/**
 * Preview auto-detection end-to-end check. A repo that never declares
 * preview.port still reaches `ready`: the daemon reads the address from the
 * dev server's own output first, and falls back to the preview process
 * tree's LISTEN sockets when the server prints nothing. The failure kinds
 * are pinned too — a server that never listens is "port-undetected", a repo
 * with no dev-family script and no preview.command is "no-preview-command",
 * and a declared port still wins over detection.
 *
 * No Claude session, no network: the remotes are local bare git
 * repositories (see fixture-repo.mjs).
 *
 * Usage: node packages/daemon/test/preview-detect-e2e.mjs
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, freePort, pushFixtureChange } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-preview-detect-e2e");

// READY_TIMEOUT_MS is a module-level constant read when repo.js loads, so
// the env must be set before the dynamic import below — 3s keeps the
// port-undetected case fast while a healthy detection answers in <1s.
process.env.COLO_DESIGN_READY_TIMEOUT_MS = "3000";
// Same isolation as repo-e2e: trust, settings, and preview-claim records
// must never touch the real home during the run.
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_DESIGN_REPO_SETTINGS = join(DIR, "settings.json");
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";

const { RepoWorkspace } = await import("../dist/repo.js");

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const workspace = (dir, fixture) =>
  new RepoWorkspace({
    root: join(DIR, dir),
    url: fixture.remote,
    onStatus: () => undefined,
  });

// A dev server that listens but never prints its address — the stdout scan
// finds no URL, so only the process-tree socket scan can locate it.
const SILENT_SERVER_MJS = `import { createServer } from "node:http";
createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><p>silent preview</p>");
}).listen(0, "127.0.0.1");
`;

// Same silent server bound to [::1] alone — react-router dev listens this
// way, and a v4-only probe read that live preview as port-undetected.
const SILENT6_SERVER_MJS = `import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const configPath = join(root, "colo-design.json");
const declared = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, "utf8")).preview?.port
  : undefined;
createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><p>silent v6 preview</p>");
}).listen(declared ?? 0, "::1");
`;

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "run"), { recursive: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });

  // --- 1. stdout detection: the server prints its own address ------------
  // port: null → colo-design.json carries preview.command but no port; the
  // fixture server listens on 0 and prints `fixture preview on http://…`.
  const printed = await createFixtureRepo({ dir: join(DIR, "fixture-printed") });
  const printedWorkspace = workspace("work-printed", printed);
  const detected = await printedWorkspace.sync();
  check(
    "an undeclared port still reaches ready",
    detected.phase === "ready",
    `${detected.phase}: ${detected.detail ?? ""}`,
  );
  // The stdout path normalizes a root URL without a trailing slash — the
  // socket-scan path below returns one, so the spelling also says WHICH
  // detection answered.
  const printedMatch = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(detected.previewUrl ?? "");
  check(
    "the preview url is the address the server printed",
    printedMatch !== null,
    String(detected.previewUrl),
  );
  check(
    "previewPort is the detected port",
    detected.previewPort === Number(printedMatch?.[1]),
    String(detected.previewPort),
  );
  const served = await fetch(detected.previewUrl);
  check(
    "the detected preview answers 200",
    served.status === 200 && (await served.text()).includes("회원 관리"),
    String(served.status),
  );
  await printedWorkspace.stop();

  // --- 2. socket-scan fallback: the server prints nothing -----------------
  const silent = await createFixtureRepo({
    dir: join(DIR, "fixture-silent"),
    previewCommand: "node silent-server.mjs",
  });
  await pushFixtureChange(
    silent.seed,
    silent.remote,
    { "silent-server.mjs": SILENT_SERVER_MJS },
    "a preview server that never prints its address",
  );
  const silentWorkspace = workspace("work-silent", silent);
  const scanned = await silentWorkspace.sync();
  check(
    "a silent server is found by the process-tree port scan",
    scanned.phase === "ready",
    `${scanned.phase}: ${scanned.detail ?? ""}`,
  );
  const scannedMatch = /^http:\/\/127\.0\.0\.1:(\d+)\/$/.exec(scanned.previewUrl ?? "");
  check(
    "the scanned url is a loopback listener",
    scannedMatch !== null && scanned.previewPort === Number(scannedMatch[1]),
    String(scanned.previewUrl),
  );
  check("the scanned preview answers 200", (await fetch(scanned.previewUrl)).status === 200);
  await silentWorkspace.stop();

  // --- 3. port-undetected: the command runs but never listens -------------
  const deaf = await createFixtureRepo({
    dir: join(DIR, "fixture-deaf"),
    previewCommand: 'node -e "setInterval(() => {}, 1 << 30)"',
  });
  const deafWorkspace = workspace("work-deaf", deaf);
  const undetected = await deafWorkspace.sync();
  check(
    "a preview that never listens is port-undetected",
    undetected.phase === "error" && undetected.errorKind === "port-undetected",
    `${undetected.phase}/${undetected.errorKind ?? "?"}`,
  );
  check(
    "the verdict points at preview.port",
    (undetected.detail ?? "").includes("preview.port"),
    undetected.detail ?? "",
  );
  check("no preview url survives the failure", undetected.previewUrl === null);
  await deafWorkspace.stop();

  // --- 4. no-preview-command: nothing to run ------------------------------
  // No colo-design.json at all, and a package.json with no dev-family
  // script — resolveRepoConfig throws before anything is spawned.
  const noCommand = await createFixtureRepo({
    dir: join(DIR, "fixture-nocommand"),
    omitConfig: true,
  });
  await pushFixtureChange(
    noCommand.seed,
    noCommand.remote,
    {
      "package.json": JSON.stringify(
        {
          name: "fixture-no-preview",
          private: true,
          version: "0.0.0",
          scripts: { check: 'node -e ""' },
        },
        null,
        2,
      ),
    },
    "drop the dev script",
  );
  const noCommandWorkspace = workspace("work-nocommand", noCommand);
  const refused = await noCommandWorkspace.sync();
  check(
    "a repo with no dev script and no preview.command is no-preview-command",
    refused.phase === "error" && refused.errorKind === "no-preview-command",
    `${refused.phase}/${refused.errorKind ?? "?"}: ${refused.detail ?? ""}`,
  );
  await noCommandWorkspace.stop();

  // --- 5. declared port still wins ----------------------------------------
  const declaredPort = await freePort();
  const declared = await createFixtureRepo({
    dir: join(DIR, "fixture-declared"),
    port: declaredPort,
  });
  const declaredWorkspace = workspace("work-declared", declared);
  const pinned = await declaredWorkspace.sync();
  check(
    "a declared port is used exactly, not detected",
    pinned.phase === "ready" &&
      pinned.previewUrl === `http://127.0.0.1:${declaredPort}` &&
      pinned.previewPort === declaredPort,
    `${pinned.phase}: ${pinned.previewUrl}`,
  );
  await declaredWorkspace.stop();

  // --- 6. a listener bound to [::1] alone is still found -------------------
  // The socket scan sees the port; only the probe family decides whether the
  // live server is found or the run dies as port-undetected.
  const silent6 = await createFixtureRepo({
    dir: join(DIR, "fixture-silent6"),
    previewCommand: "node silent6-server.mjs",
  });
  await pushFixtureChange(
    silent6.seed,
    silent6.remote,
    { "silent6-server.mjs": SILENT6_SERVER_MJS },
    "a preview server that listens on [::1] only",
  );
  const silent6Workspace = workspace("work-silent6", silent6);
  const scanned6 = await silent6Workspace.sync();
  check(
    "an [::1]-only silent server is found by the port scan",
    scanned6.phase === "ready" && scanned6.previewUrl === `http://[::1]:${scanned6.previewPort}/`,
    `${scanned6.phase}: ${scanned6.previewUrl}`,
  );
  check(
    "the [::1] preview answers 200",
    scanned6.previewUrl !== null && (await fetch(scanned6.previewUrl)).status === 200,
  );
  await silent6Workspace.stop();

  // --- 7. a declared port bound to [::1] alone still reaches ready ---------
  const declared6Port = await freePort();
  const declared6 = await createFixtureRepo({
    dir: join(DIR, "fixture-declared6"),
    port: declared6Port,
    previewCommand: "node silent6-server.mjs",
  });
  await pushFixtureChange(
    declared6.seed,
    declared6.remote,
    { "silent6-server.mjs": SILENT6_SERVER_MJS },
    "a declared-port preview on [::1] only",
  );
  const declared6Workspace = workspace("work-declared6", declared6);
  const pinned6 = await declared6Workspace.sync();
  check(
    "a declared port on [::1] is used exactly",
    pinned6.phase === "ready" &&
      pinned6.previewUrl === `http://[::1]:${declared6Port}` &&
      pinned6.previewPort === declared6Port,
    `${pinned6.phase}: ${pinned6.previewUrl}`,
  );
  await declared6Workspace.stop();

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
