/**
 * Onboarding step checks — offline, against a stubbed PATH (fake git and a
 * fake claude CLI) and a local fixture repo remote. Covers the contract:
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
  AgentLogin,
  checkRuntime,
  gitInstallGuidance,
  runOnboardingChecks,
  runPnpmInstall,
  startClaudeInstall,
  startGitInstall,
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
      // gitMissing() speaks the current platform's installer — darwin 은 이제
      // 버튼이 설치 창을 직접 연다(startGitInstall), 다른 플랫폼은 문장이 전부.
      const expectedGuidance =
        process.platform === "darwin"
          ? /설치 버튼을 누르면 설치 창이 열립니다/
          : new RegExp(gitInstallGuidance().command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      assert.match(step.detail, expectedGuidance);
      assert.equal(step.fix?.kind, "install-git");
      if (process.platform === "darwin") {
        assert.equal(step.fix?.label, "git 설치", "darwin 의 버튼은 설치다");
      }
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

test("쓰기 레포 0개면 warn — 개발자에게 다시 요청하는 문구로 물러난다 (P1-2)", async () => {
  const client = new GitHubClient("ghp_onboard_unit", {
    request: async () => ({
      status: 200,
      body: new TextEncoder().encode(JSON.stringify({ login: "jik-dev" })),
    }),
  });
  const deps = (count) => ({
    gitHubClient: () => client,
    githubWriteRepoCount: () => Promise.resolve(count),
  });

  // 0개: 토큰은 살아 있지만 이 기계가 넘길 수 있는 레포가 없다. fail 이면
  // 마법사가 막히고 카드가 다시 물을 수 있는 일이 없다 — warn 이어야 한다.
  const zero = find(await runOnboardingChecks(deps(0)), "github");
  assert.equal(zero.status, "warn", zero.detail);
  assert.match(zero.detail, /개발자에게 받은 코드가 이 레포에 닿지 않습니다/);
  assert.match(zero.detail, /다시 요청하세요/);

  // 1개 이상: 지난날의 pass 에 쓸 수 있는 레포 수가 붙는다.
  const some = find(await runOnboardingChecks(deps(3)), "github");
  assert.equal(some.status, "pass", some.detail);
  assert.match(some.detail, /쓸 수 있는 레포 3개/);

  // null(목록을 못 읽음): 판정 유보 — 네트워크 탓에 게이트가 말을 바꾸지 않는다.
  const unknown = find(await runOnboardingChecks(deps(null)), "github");
  assert.equal(unknown.status, "pass", unknown.detail);
  assert.ok(!unknown.detail.includes("쓸 수 있는"), unknown.detail);
});

test("the github gate: a stored but refused token warns — the wizard must stay escapable", async () => {
  // 실사 결함: a pasted-and-rejected token judged fail, and fail hides
  // 시작하기. Nothing on the card can un-store a token, so the planner was
  // locked out of the product over one typo. A refused token is, capability
  // for capability, a missing one — warn with the reason, form still open.
  const rejected = new GitHubClient("ghp_onboard_unit", {
    request: async () => ({ status: 401, body: new TextEncoder().encode("{}") }),
  });
  const steps = await runOnboardingChecks({ gitHubClient: () => rejected });
  const step = find(steps, "github");
  assert.equal(step.status, "warn", step.detail);
  assert.match(step.detail, /연결 코드가 유효하지 않거나 만료됐습니다/);
  assert.ok(step.detail.includes("시작"), "the detail must say the workspace stays reachable");
  assert.equal(step.fix, undefined, "the token form is the fix, not a button");
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
      emitError: () => {
        const handler = listeners.get("error");
        if (!handler) {
          // 진짜 ChildProcess 라면 등록 안 된 error 는 프로세스를 죽인다.
          // 등록을 지운 회귀가 이 더블에서도 드러나야 한다.
          throw new Error("no error listener attached — the daemon would crash");
        }
        handler(new Error("spawn ENOENT"));
      },
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
  const login = new AgentLogin(throwingSpawn);
  const result = login.start("claude", ["auth", "login"], noopEvents());
  assert.equal(result.started, false);
  assert.match(result.guidance, /에이전트 설치를 먼저 마치고/);
});

test("B3: an async spawn error is absorbed, never an unhandled crash", async () => {
  const factory = eventingSpawn();
  const login = new AgentLogin(factory);
  const done = [];
  const result = login.start("claude", ["auth", "login"], {
    ...noopEvents(),
    onDone: (ok, detail) => done.push({ ok, detail }),
  });
  assert.equal(result.started, true);
  assert.ok(factory.children.length >= 1, "a child was spawned");
  // The piped child dies asynchronously; without the error listener this
  // would crash the process. The double throws when no listener is attached,
  // so dropping the once("error", …) registration fails this test loudly.
  for (const child of factory.children) child.emitError();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    done.map((entry) => entry.ok),
    [false],
    "the error is reported as a failed end, not a crash",
  );
});

// ---------------------------------------------------------------------------
// 터미널 없는 에이전트 로그인 (P1-1) — 파이프 플로우의 출력 계약
// ---------------------------------------------------------------------------

/** 이벤트를 기록하는 로그인 더블 — stdout/stderr/string stdin 을 흉내 낸다. */
function scriptedLoginChild() {
  const listeners = new Map();
  const writes = [];
  const streams = {
    stdout: { on: (event, handler) => listeners.set(`stdout:${event}`, handler) },
    stderr: { on: (event, handler) => listeners.set(`stderr:${event}`, handler) },
  };
  const child = {
    exitCode: null,
    killed: false,
    stdin: { write: (text) => writes.push(text) },
    stdout: streams.stdout,
    stderr: streams.stderr,
    once: (event, handler) => listeners.set(event, handler),
    kill: () => {
      child.killed = true;
    },
    emit: (stream, text) => listeners.get(`${stream}:data`)?.(Buffer.from(text)),
    exit: (code) => {
      child.exitCode = code;
      listeners.get("close")?.(code);
    },
  };
  return { child, writes };
}

function noopEvents() {
  return { onUrl: () => undefined, onDone: () => undefined };
}

test("AgentLogin: stdout 의 OAuth 주소를 방송하고 코드 프롬프트를 알린다", () => {
  const { child } = scriptedLoginChild();
  const login = new AgentLogin(() => child);
  const urls = [];
  login.start("claude", ["auth", "login"], {
    onUrl: (url, wantsCode) => urls.push({ url, wantsCode }),
    onDone: () => undefined,
  });

  // 스파이크로 본 claude auth login 의 실제 출력 순서 — 주소가 먼저, 프롬프트가
  // 같은 덩어리 뒤에. 주소만 먼저 오는 세계(codex)도 같은 코드가 잡는다.
  child.emit(
    "stdout",
    "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=x\n",
  );
  assert.equal(urls.length, 1, "주소는 처음 본 순간 방송된다");
  assert.match(urls[0].url, /^https:\/\/claude\.com\//);
  assert.equal(urls[0].wantsCode, false, "아직 코드를 청하지 않았다");

  child.emit("stdout", "Paste code here if prompted > ");
  assert.equal(urls.length, 2, "프롬프트가 늦게 오면 wantsCode 로 다시 방송한다");
  assert.equal(urls.at(-1).wantsCode, true);
});

test("AgentLogin: 코드를 stdin 으로, 끝나면 onDone 으로", async () => {
  const { child, writes } = scriptedLoginChild();
  const login = new AgentLogin(() => child);
  const done = [];
  login.start("codex", ["login"], {
    onUrl: () => undefined,
    onDone: (ok, detail) => done.push({ ok, detail }),
  });
  assert.equal(login.running, true);

  assert.equal(login.submitCode(" abcd1234 \n"), true);
  assert.deepEqual(writes, ["abcd1234\n"], "코드는 잘라내고 줄바꿈을 붙인다");

  child.exit(0);
  assert.equal(login.running, false);
  assert.equal(login.submitCode("again"), false, "끝난 로그인에는 쓰지 않는다");
  assert.deepEqual(done, [{ ok: true, detail: "로그인이 완료되었습니다." }]);
});

test("AgentLogin: 실패의 이유는 자식의 마지막 말 — 틀린 코드 뒤의 종료", () => {
  const { child } = scriptedLoginChild();
  const login = new AgentLogin(() => child);
  const done = [];
  login.start("claude", ["auth", "login"], {
    onUrl: () => undefined,
    onDone: (ok, detail) => done.push({ ok, detail }),
  });
  child.emit("stdout", "Paste code here if prompted > ");
  child.emit("stderr", "Invalid code. Please make sure the full code was copied.\n");
  child.exit(1);
  assert.equal(done[0].ok, false);
  assert.match(done[0].detail, /Invalid code/);
});

test("AgentLogin: 재시작은 진행 중인 자식을 끊고 그 끝을 방송하지 않는다", () => {
  const { child } = scriptedLoginChild();
  const second = scriptedLoginChild();
  const login = new AgentLogin((command) => (command === "claude" ? child : second.child));
  const done = [];
  login.start("claude", ["auth", "login"], {
    onUrl: () => undefined,
    onDone: (ok, detail) => done.push({ ok, detail }),
  });
  login.start("codex", ["login"], noopEvents());
  assert.equal(child.killed, true, "이전 자식은 끊긴다");
  child.exit(1);
  assert.deepEqual(done, [], "교체로 끊긴 자식의 종료는 사건이 아니다");
});

// ---------------------------------------------------------------------------
// The install guidance a planner actually reads (platform branches)
// ---------------------------------------------------------------------------

test("the git guidance names each platform's own installer", () => {
  assert.equal(gitInstallGuidance("darwin").command, "xcode-select --install");
  assert.match(gitInstallGuidance("win32").command, /winget/);
  assert.match(gitInstallGuidance("linux").command, /apt/);
});

test("darwin 은 xcode-select --install 을 직접 띄운다(P1-1) — 다른 플랫폼은 문장", () => {
  const mac = recordingSpawn();
  const macResult = startGitInstall(mac, "darwin");
  assert.equal(macResult.started, true);
  assert.equal(mac.calls[0].command, "xcode-select");
  assert.deepEqual(mac.calls[0].args, ["--install"]);
  assert.match(macResult.guidance, /설치 창을 열었습니다/);

  const win = recordingSpawn();
  const winResult = startGitInstall(win, "win32");
  assert.equal(winResult.started, false);
  assert.deepEqual(win.calls, [], "win32 는 스폰하지 않는다");
  assert.match(winResult.guidance, /winget/);
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
  // 번들 MinGit 이 먼저다(P1-1) — resources/bin/cmd/git.exe. 번들 경로가 없으면
  // 예전 그대로의 설치자 후보만 남는다. join 은 이 머신의 구분자를 쓰므로
  // 기대값도 같은 join 으로 만든다.
  const bundled = gitCandidates("win32", { COLO_DESIGN_EXTRA_PATH: "C:\\app\\resources\\bin" });
  assert.equal(bundled[0], join("C:\\app\\resources\\bin", "cmd", "git.exe"));
  assert.deepEqual(bundled.slice(1), win, "번들이 있으면 앞에 서고 없으면 설치자 후보만");
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

// ---------------------------------------------------------------------------
// The provider-aware agent gate
// ---------------------------------------------------------------------------

test("a non-claude provider checks its driver and names the label", async () => {
  const dir = workdir("hub-onboard-provider-");
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = stubPath(dir);
    const fakeDriver = {
      id: "codex",
      describe: () => ({ id: "codex", label: "Codex" }),
      isAvailable: async () => ({ ok: true, version: "1.0" }),
    };
    const steps = await runOnboardingChecks({
      provider: "codex",
      driverFor: (id) => (id === "codex" ? fakeDriver : undefined),
      pnpmResolver: async () => null,
    });
    const agent = find(steps, "claude");
    assert.equal(agent.status, "pass");
    assert.match(agent.detail, /Codex 준비됨 \(1\.0\)/);
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a provider the daemon does not know fails without a fix", async () => {
  const dir = workdir("hub-onboard-unknown-");
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = stubPath(dir);
    const steps = await runOnboardingChecks({
      provider: "codex",
      driverFor: () => undefined,
      pnpmResolver: async () => null,
    });
    const agent = find(steps, "claude");
    assert.equal(agent.status, "fail");
    assert.match(agent.detail, /codex/);
    assert.equal(agent.fix, undefined);
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
