/**
 * Repo contract & environment checks — config derivation, diff parsing, PATH/pnpm detection, workspace trust. Pure functions; no workspace is brought up.
 *
 * Split out of repo.test.mjs — the bodies are verbatim; shared scaffolding
 * (workdir · repoRoot · clone · bringUp · promisifiedRun · stub client) lives
 * in ./repo-test-kit.mjs.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { detectsRegistryAuthFailure, pnpmCandidates } from "../dist/environment.js";
import {
  extraPathPrefix,
  parseUnifiedDiff,
  repoSettingsWarning,
  trustWorkspace,
} from "../dist/repo.js";
import {
  deriveRegistry,
  parseRepoOverrides,
  readDeclaredPreviewPort,
  resolveRepoConfig,
} from "../dist/repo-config.js";
import { repoRoot, workdir } from "./repo-test-kit.mjs";

// ---------------------------------------------------------------------------
// 연결 계약 — 레포가 이미 말한 것에서 추론하고, 파일은 포트와 예외만 적는다
// ---------------------------------------------------------------------------
test("the contract is derived from the repo's own files — the config names only the port", () => {
  const root = repoRoot("repo-derive-", {
    "colo-design.json": { preview: { port: 5274 } },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "package.json": { scripts: { dev: "vite", check: "tsc --noEmit", build: "vite build" } },
    ".npmrc": "@colosseumcoinckr:registry=https://npm.pkg.github.com/\n",
  });
  try {
    assert.deepEqual(resolveRepoConfig(root), {
      install: "pnpm install",
      check: "pnpm run check",
      build: "pnpm run build",
      registry: { host: "npm.pkg.github.com", scope: "@colosseumcoinckr" },
      preview: { command: "pnpm run dev", port: 5274, origins: [] },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lockfile decides the package manager and the install command", () => {
  for (const [lockfile, install, manager] of [
    ["pnpm-lock.yaml", "pnpm install", "pnpm"],
    ["package-lock.json", "npm ci", "npm"],
    ["yarn.lock", "yarn install", "yarn"],
    ["bun.lockb", "bun install", "bun"],
  ]) {
    const root = repoRoot("repo-lock-", {
      [lockfile]: "",
      "colo-design.json": { preview: { port: 3000 } },
      "package.json": { scripts: { dev: "x", check: "y" } },
    });
    try {
      const config = resolveRepoConfig(root);
      assert.equal(config.install, install, lockfile);
      // 네 매니저 모두가 받는 유일한 꼴 — `npm dev` 는 없는 명령이다.
      assert.equal(config.preview.command, `${manager} run dev`, lockfile);
      assert.equal(config.check, `${manager} run check`, lockfile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("only the scripts the repo has become commands — the preview name falls back", () => {
  const bare = repoRoot("repo-bare-", {
    "colo-design.json": { preview: { port: 3000 } },
    "package.json": { scripts: { start: "node server.mjs" } },
  });
  try {
    const config = resolveRepoConfig(bare);
    assert.equal(config.preview.command, "pnpm run start");
    // 없는 스크립트는 게이트가 되지 않는다 — 저장은 검사 없이 간다. 락파일이
    // 없으면 설치도 돌지 않는다: `pnpm install` 이 레포에 락파일을 만들어
    // 사용자가 만들지 않은 변경을 저장 검토에 올린다.
    assert.equal(config.install, undefined);
    assert.equal(config.check, undefined);
    assert.equal(config.build, undefined);
    assert.equal(config.registry, undefined);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }

  const both = repoRoot("repo-both-", {
    "colo-design.json": { preview: { port: 3000 } },
    "package.json": { scripts: { start: "next start", dev: "next dev" } },
  });
  try {
    // 개발 서버가 이긴다 — `start` 는 프레임워크에 따라 빌드 결과를 띄운다.
    assert.equal(resolveRepoConfig(both).preview.command, "pnpm run dev");
  } finally {
    rmSync(both, { recursive: true, force: true });
  }

  const none = repoRoot("repo-nopreview-", {
    "colo-design.json": { preview: { port: 3000 } },
    "package.json": { scripts: { check: "tsc" } },
  });
  try {
    assert.throws(() => resolveRepoConfig(none), /미리보기 명령을 찾지 못했습니다/);
  } finally {
    rmSync(none, { recursive: true, force: true });
  }
});

test("the port is the one thing the repo cannot say for itself", () => {
  const root = repoRoot("repo-noport-", { "package.json": { scripts: { dev: "vite" } } });
  const file = join(root, "colo-design.json");
  try {
    // 파일이 아예 없는 레포도, 빈 파일인 레포도 같은 말을 듣는다.
    assert.throws(() => resolveRepoConfig(root), /미리보기 포트를 알 수 없습니다/);
    assert.equal(readDeclaredPreviewPort(root), null);
    writeFileSync(file, "{}");
    assert.throws(() => resolveRepoConfig(root), /미리보기 포트를 알 수 없습니다/);
    assert.equal(readDeclaredPreviewPort(root), null);
    writeFileSync(file, JSON.stringify({ preview: { port: 4000 } }));
    assert.equal(readDeclaredPreviewPort(root), 4000);
    assert.equal(resolveRepoConfig(root).preview.port, 4000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an override beats the derivation, key by key — the monorepo escape hatch", () => {
  const root = repoRoot("repo-override-", {
    "pnpm-lock.yaml": "",
    "package.json": { scripts: { dev: "vite", check: "tsc", build: "vite build" } },
    "colo-design.json": {
      install: "pnpm install --filter web...",
      check: "pnpm --filter web check",
      preview: { command: "pnpm --filter web dev", port: 5274 },
      shots: false,
    },
  });
  try {
    const config = resolveRepoConfig(root);
    assert.equal(config.install, "pnpm install --filter web...");
    assert.equal(config.check, "pnpm --filter web check");
    assert.equal(config.preview.command, "pnpm --filter web dev");
    assert.equal(config.shots, false);
    // 덮지 않은 키는 그대로 추론된다.
    assert.equal(config.build, "pnpm run build");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the private registry comes from the repo's .npmrc, GitHub package hosts only", () => {
  // 이 줄이 기계의 PAT 를 겨눈다 — 레포가 임의의 서버를 가리킬 수는 없다.
  for (const line of [
    "@x:registry=https://evil.example.com/",
    "@x:registry=https://npm.pkg.github.com.evil.example.com/",
    "registry=https://npm.pkg.github.com/",
    "; @x:registry=https://npm.pkg.github.com/",
  ]) {
    const root = repoRoot("repo-npmrc-", { ".npmrc": `${line}\n` });
    try {
      assert.equal(deriveRegistry(root), null, line);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const ok = repoRoot("repo-npmrc-ok-", {
    ".npmrc": "registry=https://registry.npmjs.org/\n@team:registry=https://npm.pkg.github.com/\n",
  });
  try {
    assert.deepEqual(deriveRegistry(ok), { host: "npm.pkg.github.com", scope: "@team" });
  } finally {
    rmSync(ok, { recursive: true, force: true });
  }
});

test("override validation errors are Korean, name the field, and say what it should be", () => {
  // 빈 파일은 합법이다 — 추론이 나머지를 전부 답한다.
  assert.deepEqual(parseRepoOverrides("{}"), {});
  for (const port of [0, 65536, "5274", 5274.5]) {
    assert.throws(
      () => parseRepoOverrides(JSON.stringify({ preview: { port } })),
      /preview\.port가 잘못되었습니다/,
      `port ${JSON.stringify(port)} must be rejected`,
    );
  }
  assert.throws(
    () => parseRepoOverrides('{"install":3}'),
    /install는 실행할 명령을 문자열로 적어야 합니다/,
  );
  assert.throws(
    () => parseRepoOverrides('{"preview":{"command":"  "}}'),
    /preview\.command는 실행할 명령을 문자열로 적어야 합니다/,
  );
  assert.throws(() => parseRepoOverrides('{"preview":5274}'), /preview는 \{ "port" \} 형태/);
  assert.throws(
    () => parseRepoOverrides('{"registry":{}}'),
    /registry는 \{ "host", "scope" \} 형태여야 합니다/,
  );
  assert.throws(() => parseRepoOverrides('{"shots":"no"}'), /shots는 true 또는 false여야 합니다/);
  assert.throws(
    () => parseRepoOverrides('{"preview":{"origins":"http://localhost:6006"}}'),
    /preview\.origins는 주소 문자열의 배열/,
  );
  assert.throws(
    () => parseRepoOverrides('{"preview":{"origins":["file:///etc/passwd"]}}'),
    /preview\.origins 항목이 http\(s\) 주소가 아닙니다/,
  );
  // 경로까지 적어도 origin 으로 정규화되고, 중복은 한 번만 남는다.
  assert.deepEqual(
    parseRepoOverrides(
      JSON.stringify({
        preview: { origins: ["http://localhost:6006/iframe.html", "http://localhost:6006"] },
      }),
    ).preview?.origins,
    ["http://localhost:6006"],
  );
  assert.throws(() => parseRepoOverrides("{not json"), /colo-design\.json을 해석할 수 없습니다/);
  assert.throws(() => parseRepoOverrides("[]"), /colo-design\.json은 객체여야 합니다/);
  for (const host of [
    "evil.example.com",
    "npm.pkg.github.com.evil.example.com",
    "npm-pkg-github.com",
  ]) {
    assert.throws(
      () => parseRepoOverrides(JSON.stringify({ registry: { host, scope: "@x" } })),
      /registry\.host는 GitHub 패키지 호스트/,
      `host ${host} must be refused`,
    );
  }
  assert.deepEqual(
    parseRepoOverrides(JSON.stringify({ registry: { host: "NPM.PKG.GITHUB.COM", scope: "@team" } }))
      .registry,
    { host: "npm.pkg.github.com", scope: "@team" },
  );
});

test("a repo that ships Claude Code project settings gets a header warning", () => {
  const dir = workdir("repo-settings-warning-");
  try {
    // The normal repo: no .claude at all.
    assert.equal(repoSettingsWarning(dir), null);
    const claude = join(dir, ".claude");
    mkdirSync(claude, { recursive: true });
    const file = join(claude, "settings.json");
    // Harmless keys are not news.
    writeFileSync(file, JSON.stringify({ model: "opus" }));
    assert.equal(repoSettingsWarning(dir), null);
    // Pre-approved tools, env, and hooks each are — the warning names the
    // file so the planner can go look. The fingerprint moves with the
    // bytes: a client may file one as read, but changed settings are new
    // news.
    let previous = null;
    for (const key of ["permissions", "env", "hooks"]) {
      writeFileSync(file, JSON.stringify({ [key]: {} }));
      const warning = repoSettingsWarning(dir);
      assert.ok(
        warning?.text.includes(key) && warning?.text.includes(".claude/settings.json"),
        `${key} must be named in the warning`,
      );
      assert.notEqual(warning?.fingerprint, previous?.fingerprint);
      previous = warning;
    }
    // Same bytes, same fingerprint — the re-broadcast a client may ignore.
    assert.equal(repoSettingsWarning(dir)?.fingerprint, previous?.fingerprint);
    // Another repo carrying the very same bytes is still new news — the
    // fingerprint names the repo, not just the file.
    const twin = workdir("repo-settings-warning-twin-");
    try {
      mkdirSync(join(twin, ".claude"), { recursive: true });
      writeFileSync(join(twin, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
      assert.notEqual(repoSettingsWarning(twin)?.fingerprint, previous?.fingerprint);
    } finally {
      rmSync(twin, { recursive: true, force: true });
    }
    // A broken file is the CLI's news, not ours.
    writeFileSync(file, "{not json");
    assert.equal(repoSettingsWarning(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// Unified diff parsing
// ---------------------------------------------------------------------------

test("a new file parses as added with its content lines", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/src/screens/member/MemberList.screen.tsx b/src/screens/member/MemberList.screen.tsx",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/src/screens/member/MemberList.screen.tsx",
      "@@ -0,0 +1,2 @@",
      '+export const meta = { title: "회원 목록" };',
      "+export default function MemberListScreen() { return null; }",
    ].join("\n"),
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/screens/member/MemberList.screen.tsx");
  assert.equal(files[0].status, "added");
  assert.equal(files[0].hunks.length, 1);
  assert.equal(files[0].hunks[0].header, "@@ -0,0 +1,2 @@");
  assert.deepEqual(files[0].hunks[0].lines, [
    '+export const meta = { title: "회원 목록" };',
    "+export default function MemberListScreen() { return null; }",
  ]);
});

test("a deleted file keeps its removal hunk", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-이전 내용",
    ].join("\n"),
  );
  assert.equal(files[0].status, "deleted");
  assert.equal(files[0].path, "old.txt");
  assert.deepEqual(files[0].hunks[0].lines, ["-이전 내용"]);
});

test("a modified file keeps hunk order and every context line", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/index.html b/index.html",
      "index 2222222..3333333 100644",
      "--- a/index.html",
      "+++ b/index.html",
      "@@ -1,4 +1,4 @@",
      " <head>",
      "-<title>old</title>",
      "+<title>회원 관리</title>",
      " </head>",
      "@@ -10,3 +10,4 @@",
      " <body>",
      "+  <p>추가</p>",
      " </body>",
    ].join("\n"),
  );
  assert.equal(files[0].status, "modified");
  assert.equal(files[0].hunks.length, 2);
  assert.equal(files[0].hunks[0].header, "@@ -1,4 +1,4 @@");
  assert.deepEqual(files[0].hunks[0].lines, [
    " <head>",
    "-<title>old</title>",
    "+<title>회원 관리</title>",
    " </head>",
  ]);
  assert.deepEqual(files[0].hunks[1].lines, [" <body>", "+  <p>추가</p>", " </body>"]);
});

test("the no-newline marker stays with its hunk", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-한 줄",
      "+다른 줄",
      "\\ No newline at end of file",
    ].join("\n"),
  );
  assert.deepEqual(files[0].hunks[0].lines, ["-한 줄", "+다른 줄", "\\ No newline at end of file"]);
});

test("a binary file is marked and carries no hunks", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/logo.png b/logo.png",
      "index 4444444..5555555 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n"),
  );
  assert.equal(files[0].binary, true);
  assert.deepEqual(files[0].hunks, []);
  assert.equal(files[0].path, "logo.png");
});

test("a rename reports the new path and no phantom trailing line", () => {
  const output = [
    "diff --git a/src/screens/old/X.screen.tsx b/src/screens/member/X.screen.tsx",
    "similarity index 100%",
    "rename from src/screens/old/X.screen.tsx",
    "rename to src/screens/member/X.screen.tsx",
  ].join("\n");
  const files = parseUnifiedDiff(`${output}\n`);
  assert.equal(files.length, 1);
  assert.equal(files[0].status, "renamed");
  assert.equal(files[0].path, "src/screens/member/X.screen.tsx");
  assert.deepEqual(files[0].hunks, []);
});

// ---------------------------------------------------------------------------
// Bundled-runtime PATH prefix (desktop app)
// ---------------------------------------------------------------------------

test("COLO_DESIGN_EXTRA_PATH is prepended to PATH, deduplicated, on both separators", () => {
  const env = { PATH: "/usr/bin:/bin:/usr/local/bin" };
  assert.equal(
    extraPathPrefix("/Applications/Colo Design.app/Contents/Resources/bin", env),
    [
      "/Applications/Colo Design.app/Contents/Resources/bin",
      "/usr/bin",
      "/bin",
      "/usr/local/bin",
    ].join(":"),
    "the bundled runtime wins over whatever the machine has",
  );
  assert.equal(extraPathPrefix("/usr/bin", env), "/usr/bin:/bin:/usr/local/bin", "no duplicates");
  assert.equal(extraPathPrefix(undefined, env), env.PATH, "browser/daemon path is untouched");
  assert.equal(
    extraPathPrefix("C:\\Apps\\bin", { PATH: "C:\\Windows" }, "win32"),
    "C:\\Apps\\bin;C:\\Windows",
    "windows separator",
  );
});

// ---------------------------------------------------------------------------
// pnpm discovery and registry failure
// ---------------------------------------------------------------------------

test("Windows looks for pnpm.cmd where its installers put it", () => {
  const found = pnpmCandidates("win32", "C:/Users/dev", {
    LOCALAPPDATA: "C:/Users/dev/AppData/Local",
    APPDATA: "C:/Users/dev/AppData/Roaming",
  });
  assert.ok(
    found.every((p) => p.endsWith("pnpm.cmd")),
    `every Windows candidate must be a .cmd shim: ${found.join(", ")}`,
  );
  assert.ok(found.some((p) => p.includes("AppData/Local") || p.includes("AppData\\Local")));
  assert.ok(
    found.some((p) => p.includes("npm")),
    "the corepack/npm global shim must be searched",
  );
  assert.ok(!found.some((p) => p.includes("homebrew")), "no macOS paths on the Windows branch");
});

test("PNPM_HOME wins over the guessed locations on both platforms", () => {
  assert.equal(
    pnpmCandidates("win32", "C:/Users/dev", { PNPM_HOME: "D:/pnpm" })[0],
    join("D:/pnpm", "pnpm.cmd"),
  );
  assert.equal(
    pnpmCandidates("linux", "/home/dev", { PNPM_HOME: "/opt/pnpm" })[0],
    join("/opt/pnpm", "pnpm"),
  );
});

test("macOS and Linux look in their own default pnpm homes", () => {
  const mac = pnpmCandidates("darwin", "/Users/dev", {});
  const linux = pnpmCandidates("linux", "/home/dev", {});
  assert.ok(
    mac.some((p) => p.includes("/Library/pnpm")),
    "macOS standalone install",
  );
  assert.ok(
    mac.some((p) => p.includes("/opt/homebrew/")),
    "Homebrew must be searched",
  );
  assert.ok(!linux.some((p) => p.includes("Library")), "no macOS paths on the Linux branch");
  assert.ok(
    linux.some((p) => p.includes(".local/share/pnpm") || p.includes(".local\\share\\pnpm")),
  );
  assert.ok(
    [...mac, ...linux].every((p) => !p.endsWith(".cmd")),
    "no .cmd shims off Windows",
  );
});

// A daemon started from a desktop app inherits a minimal PATH, so `which pnpm`
// finds nothing and the candidate list is the only thing that saves the repo
// commands. This machine's pnpm lives in ~/.local/bin next to node — the
// layout the first live run failed on with "pnpm이 없습니다".
test("pnpm is looked for beside node and in ~/.local/bin", () => {
  const found = pnpmCandidates("darwin", "/Users/dev", {}, "/Users/dev/.local/bin");
  assert.ok(found.includes(join("/Users/dev/.local/bin", "pnpm")), "the node-adjacent shim");
  assert.ok(
    found.includes(join("/Users/dev", ".local", "bin", "pnpm")),
    "the native installer path",
  );
  const nvm = pnpmCandidates("linux", "/home/dev", {}, "/home/dev/.nvm/versions/node/v22.15.0/bin");
  assert.equal(nvm[0], join("/home/dev/.nvm/versions/node/v22.15.0/bin", "pnpm"), "nvm shim wins");
  assert.equal(
    pnpmCandidates("win32", "C:/Users/dev", {}, "C:/Program Files/nodejs")[0],
    join("C:/Program Files/nodejs", "pnpm.cmd"),
  );
});

test("a private-registry rejection is told apart from an ordinary install failure", () => {
  assert.ok(
    detectsRegistryAuthFailure(
      "ERR_PNPM_FETCH_401  GET https://npm.pkg.github.com/@colosseumcoinckr%2Fcds: Unauthorized - 401",
    ),
  );
  assert.ok(detectsRegistryAuthFailure("GET https://npm.pkg.github.com/...: 403 Forbidden"));
  assert.ok(!detectsRegistryAuthFailure("ERR_PNPM_NO_MATCHING_VERSION  No matching version found"));
  assert.ok(!detectsRegistryAuthFailure("Progress: resolved 401 packages, downloaded 12"));
});

// ---------------------------------------------------------------------------
// Workspace trust
// ---------------------------------------------------------------------------

test("trusting the repo clone keeps the rest of ~/.claude.json intact", () => {
  const home = workdir("hub-trust-");
  const root = join(home, "colo-design", "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "dev@example.com" },
      projects: {
        "/work/other": { hasTrustDialogAccepted: true, lastCost: 1.5 },
      },
    }),
  );

  trustWorkspace(root, home);

  const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.equal(config.oauthAccount.emailAddress, "dev@example.com", "unrelated keys survive");
  assert.deepEqual(config.projects["/work/other"], {
    hasTrustDialogAccepted: true,
    lastCost: 1.5,
  });
  // Without this flag Claude Code drops the repo's permissions.allow rules
  // and every repo command turns into an approval card in the planner's chat.
  assert.equal(config.projects[root]?.hasTrustDialogAccepted, true);
  rmSync(home, { recursive: true, force: true });
});

test("trust survives a missing config and never rewrites a corrupt one", () => {
  const fresh = workdir("hub-trust-fresh-");
  trustWorkspace(join(fresh, "colo-design", "repo"), fresh);
  assert.equal(
    JSON.parse(readFileSync(join(fresh, ".claude.json"), "utf8")).projects[
      join(fresh, "colo-design", "repo")
    ].hasTrustDialogAccepted,
    true,
  );

  const broken = workdir("hub-trust-broken-");
  writeFileSync(join(broken, ".claude.json"), "{ not json");
  trustWorkspace(join(broken, "colo-design", "repo"), broken);
  assert.equal(readFileSync(join(broken, ".claude.json"), "utf8"), "{ not json");
  rmSync(fresh, { recursive: true, force: true });
  rmSync(broken, { recursive: true, force: true });
});
