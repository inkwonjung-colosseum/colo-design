/**
 * Onboarding step checks — offline, against a stubbed PATH (fake git and a
 * fake claude CLI) and a local fixture repo remote. Covers the §8 contract:
 * Korean failure reasons, fix kinds, pass/warn/fail transitions, and the
 * registry→npmrc merge.
 *
 * Run: node --test packages/daemon/test/onboarding.test.mjs
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mergeNpmrc, npmrcPath } from "../dist/credentials.js";
import { gitCandidates, resolveGitExecutable, resolveNodeVersion } from "../dist/environment.js";
import { GitHubClient } from "../dist/github.js";
import {
  checkRuntime,
  gitInstallGuidance,
  runOnboardingChecks,
  runPnpmInstall,
  startClaudeInstall,
  startClaudeLogin,
} from "../dist/onboarding.js";
import { writeStubClaude } from "./fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function workdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A PATH whose git answers --version and delegates everything else. */
function stubPath(dir, { gitVersion = true } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const git = join(bin, "git");
  writeFileSync(
    git,
    gitVersion
      ? '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.50.0-stub"; exit 0; fi\nexec /usr/bin/git "$@"\n'
      : "#!/bin/sh\nexit 127\n",
  );
  chmodSync(git, 0o755);
  return bin;
}

const find = (steps, id) => steps.find((step) => step.id === id);

test("every step fails in Korean on an empty machine, with fixes where offered", async () => {
  const dir = workdir("hub-onboard-empty-");
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const previousClaudeBin = process.env.COLO_DESIGN_CLAUDE_BIN;
  const previousGitBin = process.env.COLO_DESIGN_GIT_BIN;
  try {
    // A genuinely empty machine: nothing on PATH, no HOME-owned installs,
    // and the git resolver pinned at nothing — its candidate list would
    // otherwise find a real install under /opt/homebrew or /usr/bin. The
    // pnpm hunt reads machine-fixed locations (PNPM_HOME on a CI runner,
    // /usr/local/bin/pnpm) no test can scrub, so its resolver is injected;
    // claude's override plays the same role for its candidate list.
    process.env.HOME = dir;
    process.env.PATH = join(dir, "empty-bin");
    process.env.COLO_DESIGN_GIT_BIN = join(dir, "no-git");
    delete process.env.COLO_DESIGN_CLAUDE_BIN;
    const steps = await runOnboardingChecks({
      claudeExecutableOverride: join(dir, "no-claude"),
      pnpmResolver: () => Promise.resolve(null),
    });

    const claude = find(steps, "claude");
    assert.equal(claude.status, "fail");
    assert.match(claude.detail, /Claude Code CLI를 찾지 못했습니다/);
    assert.deepEqual(claude.fix, {
      kind: "install-claude",
      label: "Claude Code 설치",
    });

    const git = find(steps, "git");
    assert.equal(git.status, "fail");
    assert.match(git.detail, /git이 없습니다/);

    const runtime = find(steps, "runtime");
    assert.equal(runtime.status, "fail");
    assert.match(runtime.detail, /Node\.js 22 이상이 필요합니다/);
    assert.match(runtime.detail, /pnpm이 없습니다/);
    assert.deepEqual(
      runtime.fix,
      {
        kind: "install-node",
        label: "Node.js 내려받기",
        href: "https://nodejs.org/ko/download",
      },
      "node is a link, never an installer; pnpm carries the second fix",
    );

    const github = find(steps, "github");
    assert.equal(github.status, "warn");
    assert.match(github.detail, /GitHub 토큰이 없습니다/);
    assert.equal(github.fix, undefined, "the token form is the fix, not a button");

    assert.deepEqual(
      steps.map((entry) => entry.id),
      ["claude", "git", "runtime", "github"],
      "the four machine gates in order",
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousClaudeBin === undefined) delete process.env.COLO_DESIGN_CLAUDE_BIN;
    else process.env.COLO_DESIGN_CLAUDE_BIN = previousClaudeBin;
    if (previousGitBin === undefined) delete process.env.COLO_DESIGN_GIT_BIN;
    else process.env.COLO_DESIGN_GIT_BIN = previousGitBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a logged-out claude asks for login; an API key shadows the subscription", async () => {
  const dir = workdir("hub-onboard-claude-");
  try {
    const stub = join(dir, "claude-logged-out");
    writeFileSync(
      stub,
      '#!/bin/sh\ncase "$1" in --version) echo "1.0.0-stub";; auth) echo \'{"loggedIn":false}\'; exit 0;; esac\nexit 0\n',
    );
    chmodSync(stub, 0o755);

    const loggedOut = await runOnboardingChecks({
      claudeExecutableOverride: stub,
    });
    const step = find(loggedOut, "claude");
    assert.equal(step.status, "fail");
    assert.match(step.detail, /로그인이 필요합니다/);
    assert.equal(step.fix?.kind, "login-claude");

    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      const loggedIn = await runOnboardingChecks({
        claudeExecutableOverride: writeStubClaude(join(dir, "bin-ok")),
      });
      const shadowed = find(loggedIn, "claude");
      assert.equal(shadowed.status, "warn");
      assert.match(shadowed.detail, /ANTHROPIC_API_KEY/);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git passes through the stub and fails with CLT guidance when missing", async () => {
  const dir = workdir("hub-onboard-git-");
  try {
    const ok = stubPath(dir);
    const deps = {};

    // The stub only counts when it is actually on PATH, ahead of the real git.
    const previousPath = process.env.PATH;
    process.env.PATH = `${ok}:${previousPath}`;
    const withGit = await runOnboardingChecks(deps);
    assert.equal(find(withGit, "git").status, "pass");
    assert.match(find(withGit, "git").detail, /2\.50\.0-stub/);

    rmSync(ok, { recursive: true, force: true });
    const broken = stubPath(dir, { gitVersion: false });
    // The pin beats every discovery path: without it the candidate list
    // would find this machine's own git and pass a machine with none.
    const previousPin = process.env.COLO_DESIGN_GIT_BIN;
    process.env.COLO_DESIGN_GIT_BIN = join(dir, "no-git");
    process.env.PATH = `${broken}:/usr/bin:/bin`;
    try {
      const without = await runOnboardingChecks(deps);
      const step = find(without, "git");
      assert.equal(step.status, "fail");
      // gitMissing() speaks the current platform's installer — darwin's CLT
      // one-liner, apt elsewhere. Expect the same branch the machine runs.
      const expectedGuidance =
        process.platform === "darwin"
          ? /xcode-select --install/
          : new RegExp(gitInstallGuidance().command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      assert.match(step.detail, expectedGuidance);
      assert.equal(step.fix?.kind, "install-git");
    } finally {
      if (previousPin === undefined) delete process.env.COLO_DESIGN_GIT_BIN;
      else process.env.COLO_DESIGN_GIT_BIN = previousPin;
      process.env.PATH = previousPath;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a declared registry merges into the user's npmrc without clobbering", () => {
  const home = workdir("hub-onboard-npm-");
  try {
    const file = npmrcPath({ HOME: home });
    writeFileSync(file, "registry=https://registry.npmjs.org/\n");
    mergeNpmrc(file, [
      {
        key: "@colosseumcoinckr:registry",
        value: "https://npm.pkg.github.com/",
      },
      { key: "//npm.pkg.github.com/:_authToken", value: "ghp_registry" },
    ]);
    const merged = readFileSync(file, "utf8");
    assert.ok(merged.includes("registry=https://registry.npmjs.org/"));
    assert.ok(merged.includes("@colosseumcoinckr:registry=https://npm.pkg.github.com/"));
    assert.ok(merged.includes("_authToken=ghp_registry"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The github gate
// ---------------------------------------------------------------------------

test("the github gate: no token warns without blocking, a working token names the login", async () => {
  // No client at all — the machine-wide token was never stored. A public-repo
  // planner must not be locked out, so this is a warn with the form in the card.
  const without = await runOnboardingChecks({});
  const warnStep = find(without, "github");
  assert.equal(warnStep.status, "warn");
  assert.match(warnStep.detail, /GitHub 토큰이 없습니다/);
  assert.equal(warnStep.fix, undefined);
  const client = new GitHubClient("ghp_onboard_unit", {
    request: async () => ({
      status: 200,
      body: new TextEncoder().encode(JSON.stringify({ login: "jik-dev" })),
    }),
  });
  const withClient = await runOnboardingChecks({ gitHubClient: () => client });
  const passStep = find(withClient, "github");
  assert.equal(passStep.status, "pass", passStep.detail);
  assert.match(passStep.detail, /GitHub @jik-dev 로 연결됨/);
  assert.ok(!passStep.detail.includes("ghp_onboard_unit"), "the token never rides the detail");
});

// ---------------------------------------------------------------------------
// Spawn hardening for the fix flows (B3)
// ---------------------------------------------------------------------------

/** A spawn double that throws synchronously — ENOENT before a child exists. */
function throwingSpawn() {
  throw new Error("spawn ENOENT");
}

/** A spawn double whose children only fail asynchronously (real ENOENT shape). */
function eventingSpawn() {
  const children = [];
  const spawnLike = () => {
    const listeners = new Map();
    const child = {
      once: (event, handler) => listeners.set(event, handler),
      unref: () => undefined,
      emitError: () => listeners.get("error")?.(new Error("spawn ENOENT")),
    };
    children.push(child);
    return child;
  };
  spawnLike.children = children;
  return spawnLike;
}

test("B3: a failing installer spawn returns guidance instead of throwing", () => {
  const result = startClaudeInstall(throwingSpawn);
  assert.equal(result.started, false);
  assert.match(result.guidance, /직접 실행해 주세요/);
});

test("B3: a failing login spawn returns guidance instead of throwing", () => {
  const originalPlatform = process.platform;
  if (originalPlatform === "darwin") {
    // The darwin branch tries osascript first; the double throws for it too
    // and falls through to the plain spawn, which throws again → guidance.
    const result = startClaudeLogin(throwingSpawn);
    assert.equal(result.started, false);
    assert.match(result.guidance, /직접 실행해 주세요/);
  } else {
    const result = startClaudeLogin(throwingSpawn);
    assert.equal(result.started, false);
  }
});

test("B3: an async spawn error is absorbed, never an unhandled crash", async () => {
  const factory = eventingSpawn();
  const install = startClaudeInstall(factory);
  assert.equal(install.started, true);
  assert.ok(factory.children.length >= 1, "a child was spawned");
  // The detached child dies asynchronously; without the error listener this
  // would crash the process. Every spawned child firing 'error' must be a
  // no-op the caller survives.
  for (const child of factory.children) child.emitError();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(true, "still standing after every detached child errored");
});

// ---------------------------------------------------------------------------
// The install guidance a planner actually reads (platform branches)
// ---------------------------------------------------------------------------

test("the git guidance names each platform's own installer", () => {
  assert.equal(gitInstallGuidance("darwin").command, "xcode-select --install");
  assert.match(gitInstallGuidance("win32").command, /winget/);
  assert.match(gitInstallGuidance("linux").command, /apt/);
});

/** A spawn double that records what it was asked to run. */
function recordingSpawn() {
  const calls = [];
  const spawnLike = (command, args) => {
    calls.push({ command, args });
    return { once: () => undefined, unref: () => undefined };
  };
  spawnLike.calls = calls;
  return spawnLike;
}

test("the claude installer speaks each platform's own one-liner", () => {
  // Windows has no sh: the native installer is a PowerShell one-liner there,
  // and the shell script everywhere else.
  const win = recordingSpawn();
  const winResult = startClaudeInstall(win, "win32");
  assert.equal(winResult.started, true);
  assert.equal(win.calls[0].command, "powershell");
  assert.match(win.calls[0].args.join(" "), /install\.ps1/);

  const posix = recordingSpawn();
  const posixResult = startClaudeInstall(posix, "darwin");
  assert.equal(posixResult.started, true);
  assert.equal(posix.calls[0].command, "sh");
  assert.match(posix.calls[0].args[1], /install\.sh/);
});

test("the git resolver: the pin decides, PATH wins, candidates fill the gaps", async () => {
  const dir = workdir("hub-onboard-gitresolve-");
  const previousPin = process.env.COLO_DESIGN_GIT_BIN;
  const previousPath = process.env.PATH;
  try {
    // The pin replaces discovery: a working stub resolves to itself.
    const bin = stubPath(dir);
    process.env.COLO_DESIGN_GIT_BIN = join(bin, "git");
    assert.equal(await resolveGitExecutable(), join(bin, "git"));

    // A pinned but missing git stays missing — no candidate may rescue it.
    process.env.COLO_DESIGN_GIT_BIN = join(dir, "no-git");
    assert.equal(await resolveGitExecutable(), null);

    // Without a pin, PATH wins: the stub ahead of it is the binary that runs.
    delete process.env.COLO_DESIGN_GIT_BIN;
    process.env.PATH = `${bin}:${previousPath}`;
    assert.equal(await resolveGitExecutable(), "git");
  } finally {
    if (previousPin === undefined) delete process.env.COLO_DESIGN_GIT_BIN;
    else process.env.COLO_DESIGN_GIT_BIN = previousPin;
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the git candidate list covers the installers per platform", () => {
  const mac = gitCandidates("darwin");
  assert.ok(mac.includes("/opt/homebrew/bin/git") && mac.includes("/usr/bin/git"));
  const win = gitCandidates("win32", {});
  assert.ok(win.every((candidate) => candidate.endsWith("git.exe")));
});

// ---------------------------------------------------------------------------
// Node · pnpm — the runtime gate (PLAN D5[런타임 게이트])
// ---------------------------------------------------------------------------

/** A fake node that answers `--version` with the given line. */
function writeStubNode(dir, version) {
  const bin = join(dir, `node-${version.replace(/[^0-9v.]/g, "") || "x"}-bin`);
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "node");
  writeFileSync(
    path,
    `#!/bin/sh\ncase "$1" in --version) echo "${version}"; exit 0;; esac\nexit 0\n`,
  );
  chmodSync(path, 0o755);
  return bin;
}

test("the runtime gate passes a healthy node 22 + pnpm and names the versions", async () => {
  const dir = workdir("hub-onboard-runtime-ok-");
  const previousExtra = process.env.COLO_DESIGN_EXTRA_PATH;
  const previousPath = process.env.PATH;
  try {
    const nodeBin = writeStubNode(dir, "v22.12.0");
    const pnpm = join(nodeBin, "pnpm");
    writeFileSync(pnpm, "#!/bin/sh\necho 10.4.1\n");
    chmodSync(pnpm, 0o755);
    process.env.COLO_DESIGN_EXTRA_PATH = "";
    process.env.PATH = `${nodeBin}:${previousPath}`;

    const step = await checkRuntime(() => Promise.resolve(pnpm));
    assert.equal(step.status, "pass");
    assert.match(step.detail, /Node\.js v22\.12\.0/);
    assert.match(step.detail, /pnpm 10\.4\.1/);
  } finally {
    process.env.PATH = previousPath;
    if (previousExtra === undefined) delete process.env.COLO_DESIGN_EXTRA_PATH;
    else process.env.COLO_DESIGN_EXTRA_PATH = previousExtra;
  }
});

test("an old node fails with the version it found; the fix is a link, never an installer", async () => {
  const dir = workdir("hub-onboard-runtime-old-");
  const previousExtra = process.env.COLO_DESIGN_EXTRA_PATH;
  try {
    const nodeBin = writeStubNode(dir, "v20.11.0");
    const pnpm = join(nodeBin, "pnpm");
    writeFileSync(pnpm, "#!/bin/sh\necho 10.4.1\n");
    chmodSync(pnpm, 0o755);
    process.env.COLO_DESIGN_EXTRA_PATH = "";
    const previousPath = process.env.PATH;
    process.env.PATH = `${nodeBin}:${previousPath}`;

    const step = await checkRuntime(() => Promise.resolve(pnpm));
    assert.equal(step.status, "fail");
    assert.match(step.detail, /Node\.js 22 이상이 필요합니다 \(지금: v20\.11\.0\)/);
    assert.deepEqual(step.fix, {
      kind: "install-node",
      label: "Node.js 내려받기",
      href: "https://nodejs.org/ko/download",
    });
  } finally {
    if (previousExtra === undefined) delete process.env.COLO_DESIGN_EXTRA_PATH;
    else process.env.COLO_DESIGN_EXTRA_PATH = previousExtra;
  }
});

test("a node under COLO_DESIGN_EXTRA_PATH is the bundled runtime and wins over PATH", async () => {
  const dir = workdir("hub-onboard-runtime-bundled-");
  const previousExtra = process.env.COLO_DESIGN_EXTRA_PATH;
  try {
    const bundledBin = writeStubNode(dir, "v22.20.0");
    process.env.COLO_DESIGN_EXTRA_PATH = bundledBin;

    const resolved = await resolveNodeVersion();
    assert.deepEqual(resolved, { version: "v22.20.0", bundled: true });

    // And the gate names it for what it is.
    const pnpm = join(bundledBin, "pnpm");
    writeFileSync(pnpm, "#!/bin/sh\necho 10.4.1\n");
    chmodSync(pnpm, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${dir}:${previousPath}`;
    const step = await checkRuntime(() => Promise.resolve(pnpm));
    assert.equal(step.status, "pass");
    assert.match(step.detail, /앱에 포함됨/);
  } finally {
    if (previousExtra === undefined) delete process.env.COLO_DESIGN_EXTRA_PATH;
    else process.env.COLO_DESIGN_EXTRA_PATH = previousExtra;
  }
});

test("install-pnpm runs corepack enable through the runner and quotes its failure", async () => {
  const calls = [];
  const fakeRun = async (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    if (calls.length === 1) return { stdout: "corepack enable 완료\n" };
    const error = new Error("EACCES: permission denied");
    error.stderr = "EACCES: permission denied, mkdir '/usr/local/bin'";
    throw error;
  };

  const ok = await runPnpmInstall({}, "darwin", fakeRun);
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /corepack enable 완료/);
  assert.equal(calls[0].command, "corepack");
  assert.deepEqual(calls[0].args, ["enable"]);

  const refused = await runPnpmInstall({}, "darwin", fakeRun);
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /EACCES/);
  assert.match(refused.detail, /npm i -g pnpm/);
});
