/**
 * Connected-repo unit checks — no Claude, no network. git remotes are local
 * paths created by the fixture helper, so even the phase-transition tests run
 * offline.
 *
 * These cover the parts that decide what the planner ends up with: what a
 * repo's cds-design.json may declare, how the workspace moves through its
 * phases, how an attached document is named on disk, how the PAT is kept out
 * of urls and errors, how workspace trust is recorded, and how the two
 * failure modes a planner cannot debug (no pnpm, no registry token) are
 * recognised.
 *
 * Run: node --test packages/daemon/test/repo.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticatedUrl,
  extraPathPrefix,
  fallbackGroup,
  fallbackSummary,
  parseCdsDesignConfig,
  parseUnifiedDiff,
  readCdsDesignConfig,
  restorePlan,
  safeRepoPath,
  saveSpecFiles,
  specFileName,
  trustWorkspace,
  REPO_URL_MISSING_DETAIL,
  RepoWorkspace,
} from "../dist/repo.js";
import { MemoryCredentialStore, REPO_PAT_ITEM } from "../dist/credentials.js";
import { readComments, recordComments, resolveComment } from "../dist/comments.js";
import { createFixtureRepo, freePort, pushFixtureChange } from "./fixture-repo.mjs";
import { detectsRegistryAuthFailure, pnpmCandidates } from "../dist/environment.js";

const never = () => false;

function workdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// cds-design.json contract
// ---------------------------------------------------------------------------

test("a full cds-design.json parses into its typed shape", () => {
  const config = parseCdsDesignConfig(
    JSON.stringify({
      install: "pnpm install",
      check: "pnpm check",
      build: "pnpm build",
      preview: { command: "pnpm dev", port: 5274 },
      registry: { host: "npm.pkg.github.com", scope: "@colosseumcoinckr" },
    }),
  );
  assert.equal(config.install, "pnpm install");
  assert.equal(config.check, "pnpm check");
  assert.equal(config.build, "pnpm build");
  assert.deepEqual(config.preview, { command: "pnpm dev", port: 5274 });
  assert.deepEqual(config.registry, { host: "npm.pkg.github.com", scope: "@colosseumcoinckr" });
});

test("a minimal cds-design.json needs only preview", () => {
  const config = parseCdsDesignConfig('{"preview":{"command":"node server.mjs","port":3000}}');
  assert.equal(config.install, undefined);
  assert.equal(config.registry, undefined);
  assert.deepEqual(config.preview, { command: "node server.mjs", port: 3000 });
});

test("validation errors are Korean, name the field, and say what it should be", () => {
  assert.throws(() => parseCdsDesignConfig("{}"), /preview가 없습니다/);
  assert.throws(
    () => parseCdsDesignConfig('{"preview":{"port":5274}}'),
    /preview\.command가 없습니다/,
  );
  assert.throws(
    () => parseCdsDesignConfig('{"preview":{"command":"pnpm dev"}}'),
    /preview\.port가 잘못되었습니다.*1~65535/s,
  );
  for (const port of [0, 65536, "5274", 5274.5]) {
    assert.throws(
      () => parseCdsDesignConfig(JSON.stringify({ preview: { command: "x", port } })),
      /preview\.port가 잘못되었습니다/,
      `port ${JSON.stringify(port)} must be rejected`,
    );
  }
  assert.throws(
    () => parseCdsDesignConfig('{"install":3,"preview":{"command":"x","port":1}}'),
    /install는 실행할 명령을 문자열로 적어야 합니다/,
  );
  assert.throws(
    () => parseCdsDesignConfig('{"registry":{},"preview":{"command":"x","port":1}}'),
    /registry는 \{ "host", "scope" \} 형태여야 합니다/,
  );
  assert.throws(() => parseCdsDesignConfig("{not json"), /cds-design\.json을 해석할 수 없습니다/);
  assert.throws(() => parseCdsDesignConfig("[]"), /cds-design\.json은 객체여야 합니다/);
});

test("a repo without cds-design.json says so instead of guessing", () => {
  const root = workdir("hub-repo-empty-");
  try {
    assert.throws(() => readCdsDesignConfig(root), /cds-design\.json이 없습니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shots rides the parser — typed when declared, Korean-rejected when not", () => {
  const config = parseCdsDesignConfig(
    JSON.stringify({
      preview: { command: "node server.mjs", port: 3000 },
      shots: false,
    }),
  );
  assert.equal(config.shots, false);
  assert.equal(parseCdsDesignConfig('{"preview":{"command":"n","port":1}}').shots, undefined);
  assert.throws(
    () => parseCdsDesignConfig('{"preview":{"command":"n","port":1},"shots":"no"}'),
    /shots는 true 또는 false여야 합니다/,
  );
});

// ---------------------------------------------------------------------------
// PAT handling
// ---------------------------------------------------------------------------

test("the PAT rides inside https urls only, and never other schemes", () => {
  assert.equal(
    authenticatedUrl("https://github.com/org/repo.git", "ghp_secret"),
    "https://ghp_secret@github.com/org/repo.git",
  );
  assert.equal(authenticatedUrl("https://github.com/org/repo.git", null), "https://github.com/org/repo.git");
  assert.equal(authenticatedUrl("git@github.com:org/repo.git", "ghp_secret"), "git@github.com:org/repo.git");
});

test("a failed clone never repeats the PAT in its detail", async () => {
  // A RepoWorkspace may record trust; keep that away from the real home.
  process.env.CLAUDE_CONFIG_DIR = workdir("hub-repo-trust-away-");
  const broadcasts = [];
  const workspace = new RepoWorkspace({
    root: join(workdir("hub-repo-nope-"), "work"),
    // A refused localhost connection fails fast without any network access,
    // and git quotes the (token-bearing) url in its error output.
    url: "https://127.0.0.1:1/org/repo.git",
    pat: "ghp_super_secret",
    onStatus: (status) => broadcasts.push(status),
  });
  try {
    const status = await workspace.sync();
    assert.equal(status.phase, "error");
    assert.ok(!JSON.stringify(broadcasts).includes("ghp_super_secret"), "the PAT must stay daemon-side");
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

// ---------------------------------------------------------------------------
// Phase transitions (local fixture remote, offline)
// ---------------------------------------------------------------------------

test("sync without a configured url stays missing and explains what to do", async () => {
  const workspace = new RepoWorkspace({
    root: join(workdir("hub-repo-nourl-"), "work"),
    url: null,
    onStatus: () => undefined,
  });
  const status = await workspace.sync();
  assert.equal(status.phase, "missing");
  assert.equal(status.detail, REPO_URL_MISSING_DETAIL);
  assert.equal(status.previewUrl, null);
});

test("a clone from nowhere lands in error with the git output", async () => {
  const workspace = new RepoWorkspace({
    root: join(workdir("hub-repo-noclone-"), "work"),
    url: join(workdir("hub-repo-noclone-"), "nope.git"),
    onStatus: () => undefined,
  });
  const status = await workspace.sync();
  assert.equal(status.phase, "error");
  assert.match(status.detail, /git clone에 실패했습니다/);
});

test("a half-finished clone's leftover folder is cleared and re-cloned, not a 128 loop", async () => {
  const dir = workdir("hub-repo-debris-");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    // What a killed bring-up leaves behind: a `repo` folder with copied
    // files but no `.git`, which `git clone` refuses until it is gone.
    const root = join(dir, "work");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "partial-download.tmp"), "debris from the dead run");

    const workspace = new RepoWorkspace({
      root,
      url: fixture.remote,
      onStatus: () => undefined,
    });
    const status = await workspace.sync();
    assert.equal(status.phase, "ready", status.detail ?? "");
    assert.ok(!existsSync(join(root, "partial-download.tmp")), "the debris must not survive the re-clone");
    assert.ok(existsSync(join(root, ".git")), "a real clone is in place");
    await workspace.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a seeded repo walks cloning → installing → starting, and a dead preview names itself", async () => {
  const dir = workdir("hub-repo-phases-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const port = await freePort();
    // The preview command exits at once, so the run observes every working
    // phase and then the honest failure, without waiting out a timeout.
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port,
      previewCommand: 'node -e "process.exit(3)"',
      installCommand: 'node -e ""',
    });

    const phases = [];
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      onStatus: (status) => phases.push(status.phase),
    });
    const status = await workspace.sync();

    assert.equal(status.phase, "error");
    for (const phase of ["cloning", "installing", "starting", "error"]) {
      assert.ok(phases.includes(phase), `expected a ${phase} broadcast, got ${phases.join(" → ")}`);
    }
    assert.match(status.detail, /미리보기 서버가/);
    assert.equal(status.previewUrl, null);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bring-up in flight reads as running, so the onboarding check can tell progress from a broken manifest", async () => {
  const dir = workdir("hub-repo-syncstate-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const port = await freePort();
    // A slow install stretches the working window, so the wizard's check —
    // which fires while `project.create` is still cloning — reliably lands
    // inside it instead of racing the whole bootstrap.
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port,
      installCommand: "sleep 0.5",
    });

    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      onStatus: () => undefined,
    });
    const settling = workspace.sync();

    let during = workspace.syncState();
    const WORKING = ["cloning", "pulling", "installing", "starting"];
    const deadline = Date.now() + 10_000;
    while (!WORKING.includes(during.phase) && during.phase !== "ready" && Date.now() < deadline) {
      await new Promise((ok) => setTimeout(ok, 10));
      during = workspace.syncState();
    }
    assert.ok(
      WORKING.includes(during.phase),
      `expected a working phase mid-bring-up, saw ${during.phase}`,
    );
    assert.equal(during.running, true);

    const done = await settling;
    const settled = workspace.syncState();
    assert.equal(settled.running, false);
    assert.equal(done.phase, "ready", done.detail ?? "");
    assert.equal(settled.phase, "ready");
    await workspace.stop();
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changing the url discards the old clone, re-clones, and reports the move once", async () => {
  const dir = workdir("hub-repo-reclone-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const port = await freePort();
    const first = await createFixtureRepo({ dir: join(dir, "a"), port });
    const second = await createFixtureRepo({ dir: join(dir, "b"), port });

    // What the project registry hears; nothing else persists the url now.
    const moves = [];
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: first.remote,
      onStatus: () => undefined,
      onUrlChange: (url) => moves.push(url),
    });
    assert.equal((await workspace.sync()).phase, "ready");
    const marker = join(dir, "work", "sentinel-from-first-repo.txt");
    writeFileSync(marker, "planner work that belongs to the OLD repository");

    const moved = await workspace.update({ url: second.remote });
    assert.equal(moved.phase, "ready", moved.detail ?? "");
    assert.equal(moved.url, second.remote);
    assert.throws(() => readFileSync(marker), /ENOENT/, "the old clone must be discarded, not merged");
    assert.ok(existsSync(join(dir, "work", ".git")), "the new clone is in place");
    assert.deepEqual(moves, [second.remote], "the move is reported with the new url");

    // Re-submitting the same url is not a move: the registry must not be told
    // to rewrite (and broadcast) a project nothing changed about.
    await workspace.update({ url: second.remote });
    assert.deepEqual(moves, [second.remote]);
    await workspace.stop();
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
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
      "+export const meta = { title: \"회원 목록\" };",
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

test("CDS_DESIGN_EXTRA_PATH is prepended to PATH, deduplicated, on both separators", () => {
  const env = { PATH: "/usr/bin:/bin:/usr/local/bin" };
  assert.equal(
    extraPathPrefix("/Applications/CDS Design.app/Contents/Resources/bin", env),
    ["/Applications/CDS Design.app/Contents/Resources/bin", "/usr/bin", "/bin", "/usr/local/bin"].join(":"),
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
// specs/ naming
// ---------------------------------------------------------------------------

test("a spec file is dated, keeps its spaces, and loses path structure", () => {
  assert.equal(
    specFileName("회원 관리 기획서.pdf", "2026-09-08", never),
    "2026-09-08-회원 관리 기획서.pdf",
  );
  assert.equal(
    specFileName("../../etc/passwd.md", "2026-09-08", never),
    "2026-09-08-etcpasswd.md",
    "separators and the leading dots that hide a file both go",
  );
  assert.equal(specFileName("plan\u0007\u0000.txt", "2026-09-08", never), "2026-09-08-plan.txt");
  assert.equal(specFileName("a:b*c?.txt", "2026-09-08", never), "2026-09-08-abc.txt");
});

test("a filename the planner already dated is not dated twice", () => {
  assert.equal(
    specFileName("2026-09-08-회원관리.md", "2026-09-08", never),
    "2026-09-08-회원관리.md",
  );
  assert.equal(
    specFileName("2026-09-05-회원관리.md", "2026-09-08", never),
    "2026-09-05-회원관리.md",
    "their date wins — it is the document's version, not the upload time",
  );
});

test("a spec name stays under the 100 character cap", () => {
  const name = specFileName(`${"가".repeat(300)}.pdf`, "2026-09-08", never);
  assert.ok(name.length <= 100, `expected <= 100 chars, got ${name.length}`);
  assert.ok(name.startsWith("2026-09-08-"));
  assert.ok(name.endsWith(".pdf"));
});

test("colliding uploads get -2, -3 instead of overwriting", () => {
  const existing = new Set(["2026-09-08-spec.pdf", "2026-09-08-spec-2.pdf"]);
  assert.equal(
    specFileName("spec.pdf", "2026-09-08", (candidate) => existing.has(candidate)),
    "2026-09-08-spec-3.pdf",
  );
});

test("an extension outside the allow list is refused with the list in the message", () => {
  assert.throws(() => specFileName("기획서.docx", "2026-09-08", never), /docx/);
  assert.throws(() => specFileName("noextension", "2026-09-08", never), /\.pdf/);
  for (const extension of [".md", ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".webp"]) {
    assert.ok(specFileName(`plan${extension.toUpperCase()}`, "2026-09-08", never).endsWith(extension));
  }
});

test("attachments land in specs/ and are reported as relative paths", () => {
  const cwd = workdir("hub-specs-");
  try {
    const saved = saveSpecFiles(
      cwd,
      [
        { name: "기획서.md", mediaType: "text/markdown", data: Buffer.from("# 회원").toString("base64") },
        { name: "기획서.md", mediaType: "text/markdown", data: Buffer.from("# 주문").toString("base64") },
      ],
      new Date(2026, 8, 8),
    );
    assert.deepEqual(saved, ["specs/2026-09-08-기획서.md", "specs/2026-09-08-기획서-2.md"]);
    assert.equal(readFileSync(join(cwd, saved[0]), "utf8"), "# 회원");
    assert.equal(readFileSync(join(cwd, saved[1]), "utf8"), "# 주문");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
  assert.ok(found.some((p) => p.includes("npm")), "the corepack/npm global shim must be searched");
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
  assert.ok(mac.some((p) => p.includes("/Library/pnpm")), "macOS standalone install");
  assert.ok(mac.some((p) => p.includes("/opt/homebrew/")), "Homebrew must be searched");
  assert.ok(!linux.some((p) => p.includes("Library")), "no macOS paths on the Linux branch");
  assert.ok(linux.some((p) => p.includes(".local/share/pnpm") || p.includes(".local\\share\\pnpm")));
  assert.ok([...mac, ...linux].every((p) => !p.endsWith(".cmd")), "no .cmd shims off Windows");
});

// A daemon started from a desktop app inherits a minimal PATH, so `which pnpm`
// finds nothing and the candidate list is the only thing that saves the repo
// commands. This machine's pnpm lives in ~/.local/bin next to node — the
// layout the first live run failed on with "pnpm이 없습니다".
test("pnpm is looked for beside node and in ~/.local/bin", () => {
  const found = pnpmCandidates("darwin", "/Users/dev", {}, "/Users/dev/.local/bin");
  assert.ok(found.includes(join("/Users/dev/.local/bin", "pnpm")), "the node-adjacent shim");
  assert.ok(found.includes(join("/Users/dev", ".local", "bin", "pnpm")), "the native installer path");
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
  const root = join(home, "cds-design", "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "dev@example.com" },
      projects: { "/work/other": { hasTrustDialogAccepted: true, lastCost: 1.5 } },
    }),
  );

  trustWorkspace(root, home);

  const config = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.equal(config.oauthAccount.emailAddress, "dev@example.com", "unrelated keys survive");
  assert.deepEqual(config.projects["/work/other"], { hasTrustDialogAccepted: true, lastCost: 1.5 });
  // Without this flag Claude Code drops the repo's permissions.allow rules
  // and every repo command turns into an approval card in the planner's chat.
  assert.equal(config.projects[root]?.hasTrustDialogAccepted, true);
  rmSync(home, { recursive: true, force: true });
});

test("trust survives a missing config and never rewrites a corrupt one", () => {
  const fresh = workdir("hub-trust-fresh-");
  trustWorkspace(join(fresh, "cds-design", "repo"), fresh);
  assert.equal(
    JSON.parse(readFileSync(join(fresh, ".claude.json"), "utf8")).projects[
      join(fresh, "cds-design", "repo")
    ].hasTrustDialogAccepted,
    true,
  );

  const broken = workdir("hub-trust-broken-");
  writeFileSync(join(broken, ".claude.json"), "{ not json");
  trustWorkspace(join(broken, "cds-design", "repo"), broken);
  assert.equal(readFileSync(join(broken, ".claude.json"), "utf8"), "{ not json");
  rmSync(fresh, { recursive: true, force: true });
  rmSync(broken, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// Publish regressions (B1, F4, F5)
// ---------------------------------------------------------------------------

/** A fixture whose check passes while writing a file nobody reviewed. */
const SNEAKY_CHECK = `import { writeFileSync } from "node:fs";
writeFileSync("sneaky-unreviewed.txt", "the gate wrote this");
console.log("check: 통과");
`;

/** A local-registry fixture + a PAT, for the npmrc-leak checks. */
async function registryFixture(dir, home) {
  const fixture = await createFixtureRepo({
    dir: join(dir, "fixture"),
    port: await freePort(),
    previewCommand: 'node -e "process.exit(0)"',
    checkMjs: SNEAKY_CHECK,
    registry: { host: "npm.pkg.github.test", scope: "@leaktest" },
  });
  const npmrc = join(home, ".npmrc");
  process.env.CDS_DESIGN_NPMRC = npmrc;
  writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n");
  return { fixture, npmrc };
}

test("B1: a registry repo saves with no .npmrc and no PAT — creds stay user-level", async () => {
  const dir = workdir("hub-publish-npmrc-");
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  try {
    const { fixture, npmrc } = await registryFixture(dir, home);
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      pat: "ghp_npmrc_leak_probe",
      onStatus: () => undefined,
    });
    await workspace.sync(); // install runs (fresh clone) → registry merge lands user-level
    await workspace.stop();

    assert.ok(!existsSync(join(dir, "work", ".npmrc")), "the clone must not carry an npmrc");
    const user = readFileSync(npmrc, "utf8");
    assert.ok(user.includes("@leaktest:registry=https://npm.pkg.github.test/"), "scope mapping merged");
    assert.ok(user.includes("//npm.pkg.github.test/:_authToken=ghp_npmrc_leak_probe"), "token merged user-level");
    assert.ok(user.includes("registry=https://registry.npmjs.org/"), "existing lines survive the merge");

    writeFileSync(join(dir, "work", "index.html"), "<p>게시 검증</p>\n");
    const published = await workspace.save({ message: "npmrc 누출 검증" });
    assert.equal(published.stage, "published", published.detail ?? "");

    const tree = await promisifiedRun("git", ["-C", fixture.remote, "ls-tree", "-r", "--name-only", "HEAD"]);
    assert.ok(!tree.split("\n").includes(".npmrc"), "the pushed tree has no .npmrc");
    assert.ok(!tree.includes("ghp_npmrc_leak_probe"), "the pushed tree has no PAT");
    const localTree = await promisifiedRun("git", ["-C", join(dir, "work"), "ls-tree", "-r", "--name-only", "HEAD"]);
    assert.ok(!localTree.split("\n").includes(".npmrc"));
  } finally {
    delete process.env.CDS_DESIGN_NPMRC;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F4: a save commits exactly the reviewed paths — gate-written files stay out", async () => {
  const dir = workdir("hub-publish-sneaky-");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
      previewCommand: 'node -e "process.exit(0)"',
      checkMjs: SNEAKY_CHECK,
    });
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      onStatus: () => undefined,
    });
    await workspace.sync();
    await workspace.stop();

    // The reviewed change: an edit the planner saw in the diff panel.
    writeFileSync(join(dir, "work", "index.html"), "<p>검토된 변경</p>\n");
    const published = await workspace.save({ message: "검토된 것만" });
    assert.equal(published.stage, "published", published.detail ?? "");

    const committed = (await promisifiedRun("git", ["-C", join(dir, "work"), "show", "--name-only", "--pretty=", "HEAD"]))
      .split("\n")
      .filter(Boolean);
    assert.ok(committed.includes("index.html"), `index.html committed: ${committed.join(", ")}`);
    assert.ok(!committed.includes("sneaky-unreviewed.txt"), "the gate's unreviewed file must not be committed");
    assert.ok(existsSync(join(dir, "work", "sneaky-unreviewed.txt")), "the gate still ran (its file exists on disk)");
    const status = await promisifiedRun("git", ["-C", join(dir, "work"), "status", "--porcelain"]);
    assert.match(status, /sneaky-unreviewed\.txt/, "it remains untracked, awaiting its own review");

    const remoteTree = await promisifiedRun("git", ["-C", fixture.remote, "ls-tree", "-r", "--name-only", "HEAD"]);
    assert.ok(!remoteTree.includes("sneaky-unreviewed.txt"), "the remote is clean too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F5: a save re-reads cds-design.json — a freshly edited gate is the one that runs", async () => {
  const dir = workdir("hub-publish-config-");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
      previewCommand: 'node -e "process.exit(0)"',
    });
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      onStatus: () => undefined,
    });
    await workspace.sync();
    await workspace.stop();

    // Swap the clone's gate AFTER sync cached the config: publish must run
    // what is on disk now, not the cached copy.
    const config = JSON.parse(readFileSync(join(dir, "work", "cds-design.json"), "utf8"));
    config.check = "node -e \"console.error('NEWGATE-RAN'); process.exit(7)\"";
    writeFileSync(join(dir, "work", "cds-design.json"), `${JSON.stringify(config, null, 2)}\n`);

    writeFileSync(join(dir, "work", "index.html"), "<p>게이트 확인</p>\n");
    const status = await workspace.save({ message: "게이트" });
    assert.equal(status.stage, "failed");
    assert.equal(status.gate, "check");
    assert.ok((status.detail ?? "").includes("NEWGATE-RAN"), `the new gate ran: ${status.detail ?? ""}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const promisifiedRun = async (command, args) => (await promisify(execFileCb)(command, args)).stdout;


// ---------------------------------------------------------------------------
// 코멘트 저장소 (PLAN D57)
// ---------------------------------------------------------------------------

test("comments.record replaces a screen·state's unresolved rows and keeps resolved history", () => {
  const dir = workdir("hub-comments-");
  const file = join(dir, "comments.json");
  try {
    recordComments(file, "/member/MemberList", "default", [{ text: "첫 코멘트", elementText: "목록" }]);
    // The overlay re-sends what is still pinned: one row becomes a reworded two.
    const written = recordComments(file, "/member/MemberList", "default", [
      { text: "다시 쓴 코멘트", elementText: "목록" },
      { text: "하나 더", elementText: "페이지 제목" },
    ]);
    assert.equal(written, 2);
    let rows = readComments(file);
    assert.equal(rows.length, 2, "the re-send replaced the pair's unresolved row");
    assert.ok(rows.every((row) => row.text !== "첫 코멘트"), JSON.stringify(rows));
    // A resolved row is history: the same screen·state's re-send cannot touch
    // it — but the pair's other unresolved row still goes.
    resolveComment(file, rows[0].id, true);
    recordComments(file, "/member/MemberList", "default", [{ text: "새 코멘트", elementText: "목록" }]);
    rows = readComments(file);
    assert.equal(rows.length, 2, "resolved history stayed, the unresolved one was replaced");
    assert.deepEqual(
      rows.map((row) => [row.resolved, row.text]),
      [
        [true, "다시 쓴 코멘트"],
        [false, "새 코멘트"],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one pair's re-send never touches another screen·state's rows", () => {
  const file = join(workdir("hub-comments-pair-"), "comments.json");
  recordComments(file, "/member/MemberList", "default", [{ text: "회원", elementText: "목록" }]);
  recordComments(file, "/pay/PayFailed", "error", [{ text: "결제", elementText: "실패" }]);
  const rows = readComments(file);
  assert.equal(rows.length, 2, JSON.stringify(rows));
});

test("recordComments keeps the pin's element and normalizes the screen spelling (PLAN D78)", () => {
  const file = join(workdir("hub-comments-element-"), "comments.json");
  const element = {
    component: "button",
    path: 'div[data-screen="pay/PayFailed"] > div > button:nth-of-type(1)',
    rect: { x: 40, y: 120, width: 96, height: 32 },
  };
  // The fixture once wrote route-shaped spellings; the store keeps the
  // `[data-screen]` one, or the recorded pin would strand on every screen.
  recordComments(file, "/pay/PayFailed", "error", [{ text: "고쳐 주세요", elementText: "다시 시도", element }]);
  const rows = readComments(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].screen, "pay/PayFailed", "no leading slash");
  assert.deepEqual(rows[0].element, element, "the anchor rides the row verbatim");
  // The recorded list is what the overlay draws from: element in, element out.
  assert.equal(rows[0].elementText, "다시 시도");
});

test("an old row without element survives; a broken element row is dropped (PLAN D78)", () => {
  const dir = workdir("hub-comments-legacy-");
  const file = join(dir, "comments.json");
  try {
    writeFileSync(
      file,
      JSON.stringify([
        // A pre-D78 row: no element, still a comment.
        { id: "old", screen: "pay/PayFailed", state: "error", text: "옛 코멘트", elementText: "제목", at: "2026-09-01T00:00:00Z", resolved: false },
        // A row whose element is half there would anchor a pin on a half
        // identity — dropped rather than drawn.
        { id: "broken", screen: "pay/PayFailed", state: "error", text: "깨진 위치", elementText: "제목", element: { component: "div" }, at: "2026-09-02T00:00:00Z", resolved: false },
      ]),
    );
    const rows = readComments(file);
    assert.deepEqual(rows.map((row) => row.id), ["old"], JSON.stringify(rows));
    assert.equal(rows[0].element, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveComment answers false for an id the store never had", () => {
  const file = join(workdir("hub-comments-miss-"), "comments.json");
  recordComments(file, "/a/A", "default", [{ text: "x", elementText: "y" }]);
  assert.equal(resolveComment(file, "no-such-id", true), false);
  assert.equal(readComments(file).length, 1, "a failed resolve moved nothing");
});

test("a comments.json a hand mangled reads as whatever survives", () => {
  const dir = workdir("hub-comments-mangled-");
  const file = join(dir, "comments.json");
  try {
    writeFileSync(file, "{not json");
    assert.deepEqual(readComments(file), []);
    writeFileSync(file, JSON.stringify({ comments: [] }));
    assert.deepEqual(readComments(file), [], "an object is not a store");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "1", screen: "s", state: "t", text: "x", elementText: "y", at: "2026-09-11T00:00:00Z", resolved: false },
        { junk: true },
      ]),
    );
    const rows = readComments(file);
    assert.equal(rows.length, 1, "the malformed row dropped, the well-formed one stayed");
    assert.equal(rows[0].id, "1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 넘기기의 화면 캡처 (PLAN D56) — offline: a stub GitHub client records the
// pull request it is asked for, and the remote is the fixture's bare clone.
// ---------------------------------------------------------------------------

const stubPullRequestClient = (requests) => ({
  async createPullRequest(input) {
    requests.push(input);
    return { number: 7, url: "https://github.com/colosseumcoinckr/cds-design-e2e/pull/7", title: input.title, state: "open" };
  },
  async updatePullRequest(input) {
    requests.push(input);
    return { number: 7, url: "https://github.com/colosseumcoinckr/cds-design-e2e/pull/7", title: input.title, state: "open" };
  },
});

test("넘기기 commits the captures under .cds-design/shots and links them at the end of the body", async () => {
  const dir = workdir("hub-handoff-shots-");
  const previousSlug = process.env.CDS_DESIGN_GITHUB_SLUG;
  process.env.CDS_DESIGN_GITHUB_SLUG = "colosseumcoinckr/cds-design-e2e";
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
      previewCommand: 'node -e "process.exit(0)"',
    });
    const requests = [];
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      onStatus: () => undefined,
      gitHubClient: () => stubPullRequestClient(requests),
    });
    await workspace.sync();
    await workspace.stop();

    writeFileSync(join(dir, "work", "index.html"), "<p>캡처 실어 넘기기</p>\n");
    const saved = await workspace.save({ message: "캡처 실어 넘기기" });
    assert.equal(saved.stage, "published", saved.detail ?? "");

    const handed = await workspace.handoff({
      title: "결제 화면",
      shots: [
        { route: "/member/MemberList", state: "default", png: Buffer.from("png-기본") },
        { route: "/결제 완료", state: "빈 상태", png: Buffer.from("png-빈 상태") },
      ],
    });
    assert.equal(handed.stage, "handed-off", handed.detail ?? handed.stage);

    // The captures are files of the cycle branch now, pushed with it.
    const branch = requests[0].head;
    // `core.quotepath=false`: git would otherwise escape the Korean paths and
    // the assertion would compare against octal noise, not what is on disk.
    const committed = (
      await promisifiedRun("git", [
        "-c",
        "core.quotepath=false",
        "-C",
        join(dir, "work"),
        "show",
        "--name-only",
        "--pretty=",
        "HEAD",
      ])
    )
      .split("\n")
      .filter(Boolean);
    assert.ok(committed.includes(".cds-design/shots/-member-MemberList--default.png"), committed.join(", "));
    assert.ok(committed.includes(".cds-design/shots/-결제 완료--빈 상태.png"), committed.join(", "));
    const remoteTree = await promisifiedRun("git", [
      "-c",
      "core.quotepath=false",
      "-C",
      fixture.remote,
      "ls-tree",
      "-r",
      "--name-only",
      branch,
    ]);
    assert.ok(remoteTree.includes(".cds-design/shots/-결제 완료--빈 상태.png"), "the captures reached the remote");

    // The section rides at the END of the body; Korean reads as itself, only
    // the url's spaces escape.
    const body = requests[0].body;
    assert.ok(body.indexOf("### 화면 미리보기") > 0, "appended, not prepended");
    const section = body.slice(body.indexOf("### 화면 미리보기"));
    assert.ok(section.includes(`blob/${branch}/.cds-design/shots/-결제%20완료--빈%20상태.png`), section);
    assert.ok(section.includes("`/member/MemberList · default`"), section);
    assert.ok(section.trimEnd().endsWith(".png)"), section);
  } finally {
    if (previousSlug === undefined) delete process.env.CDS_DESIGN_GITHUB_SLUG;
    else process.env.CDS_DESIGN_GITHUB_SLUG = previousSlug;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cds-design.json#shots: false refuses the captures — no files, no section", async () => {
  const dir = workdir("hub-handoff-noshots-");
  const previousSlug = process.env.CDS_DESIGN_GITHUB_SLUG;
  process.env.CDS_DESIGN_GITHUB_SLUG = "colosseumcoinckr/cds-design-e2e";
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
      previewCommand: 'node -e "process.exit(0)"',
    });
    const requests = [];
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      onStatus: () => undefined,
      gitHubClient: () => stubPullRequestClient(requests),
    });
    await workspace.sync();
    await workspace.stop();

    // The repo's refusal, written after the clone brought its config here.
    const config = JSON.parse(readFileSync(join(dir, "work", "cds-design.json"), "utf8"));
    config.shots = false;
    writeFileSync(join(dir, "work", "cds-design.json"), `${JSON.stringify(config, null, 2)}\n`);

    writeFileSync(join(dir, "work", "index.html"), "<p>캡처 없이 넘기기</p>\n");
    const saved = await workspace.save({ message: "캡처 없이 넘기기" });
    assert.equal(saved.stage, "published", saved.detail ?? "");

    const handed = await workspace.handoff({
      title: "결제 화면",
      shots: [{ route: "/member/MemberList", state: "default", png: Buffer.from("png") }],
    });
    assert.equal(handed.stage, "handed-off", handed.detail ?? handed.stage);
    assert.ok(!existsSync(join(dir, "work", ".cds-design")), "the refused captures never landed");
    assert.equal(requests[0].body, "", JSON.stringify(requests[0].body));
  } finally {
    if (previousSlug === undefined) delete process.env.CDS_DESIGN_GITHUB_SLUG;
    else process.env.CDS_DESIGN_GITHUB_SLUG = previousSlug;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 레포 최신화: pull the developer's side without reading git
// ---------------------------------------------------------------------------

const clone = (dir, fixture) =>
  new RepoWorkspace({
    root: join(dir, "work"),
    url: fixture.remote,
    onStatus: () => undefined,
  });

const bringUp = async (dir, fixture) => {
  const workspace = clone(dir, fixture);
  await workspace.sync();
  await workspace.stop();
  return workspace;
};

test("최신화 carries unsaved work across a moved base — tracked and untracked alike", async () => {
  const dir = workdir("hub-refresh-dirty-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const workspace = await bringUp(dir, fixture);

    // The planner's unsaved half: a tracked edit at the top of CLAUDE.md
    // (nine lines from the developer's edit below, so git can truly combine
    // them) plus a brand-new screen.
    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    writeFileSync(
      join(dir, "work", "CLAUDE.md"),
      claude.replace("# fixture cds-design 레포", "# 기획자의 저장하지 않은 제목"),
    );
    mkdirSync(join(dir, "work", "src", "screens", "new"), { recursive: true });
    writeFileSync(join(dir, "work", "src", "screens", "new", "New.screen.tsx"), "export const New = () => null;\n");

    // The developer's side moved the same file's last rule meanwhile.
    const seedClaude = readFileSync(join(fixture.seed, "CLAUDE.md"), "utf8");
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "CLAUDE.md": seedClaude.replace(
        "- 만들거나 바꾼 화면을 이름과 경로로 답변에 남긴다.",
        "- 만들거나 바꾼 화면을 이름과 경로로 답변에 남긴다 — 개발자가 다듬은 문장.",
      ),
    });

    const briefs = [];
    await workspace.pull((brief) => briefs.push(brief));

    const merged = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    assert.ok(merged.includes("개발자가 다듬은 문장"), "the developer's change landed");
    assert.ok(merged.includes("기획자의 저장하지 않은 제목"), "the planner's unsaved edit survived");
    assert.ok(existsSync(join(dir, "work", "src", "screens", "new", "New.screen.tsx")), "untracked screens ride along");
    assert.deepEqual(briefs, [], "a clean combine briefs nobody");
    const status = await workspace.status();
    assert.equal(status.phase, "ready");
    assert.ok(status.pendingChanges >= 2, `the work is back, awaiting 저장: ${status.pendingChanges}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare bring-up carries unsaved work across a moved base too", async () => {
  const dir = workdir("hub-refresh-bootstrap-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const workspace = await bringUp(dir, fixture);

    // The planner left unsaved work at the top of CLAUDE.md; the developer
    // merged an edit into the same file's end. A blind `git pull --ff-only`
    // refused this exact shape.
    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    writeFileSync(
      join(dir, "work", "CLAUDE.md"),
      claude.replace("# fixture cds-design 레포", "# 기획자의 저장하지 않은 제목"),
    );
    const seedClaude = readFileSync(join(fixture.seed, "CLAUDE.md"), "utf8");
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "CLAUDE.md": seedClaude.replace(
        "- 만들거나 바꾼 화면을 이름과 경로로 답변에 남긴다.",
        "- 만들거나 바꾼 화면을 이름과 경로로 답변에 남긴다 — 개발자가 다듬은 문장.",
      ),
    });

    const status = await workspace.sync();
    assert.equal(status.phase, "ready", status.detail ?? "");
    const merged = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    assert.ok(merged.includes("개발자가 다듬은 문장"), "the developer's change landed");
    assert.ok(merged.includes("기획자의 저장하지 않은 제목"), "the planner's unsaved edit survived");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("최신화 hands a genuine conflict to Claude, work parked and named", async () => {
  const dir = workdir("hub-refresh-conflict-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const workspace = await bringUp(dir, fixture);

    const html = readFileSync(join(dir, "work", "index.html"), "utf8");
    writeFileSync(
      join(dir, "work", "index.html"),
      html.replace("<p>연결 레포가 렌더하는 미리보기입니다.</p>", "<p>기획자의 줄</p>"),
    );
    // The developer changed the very same line: git cannot combine this.
    const seedHtml = readFileSync(join(fixture.seed, "index.html"), "utf8");
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "index.html": seedHtml.replace("<p>연결 레포가 렌더하는 미리보기입니다.</p>", "<p>개발자의 줄</p>"),
    });

    const briefs = [];
    await workspace.pull((brief) => briefs.push(brief));

    assert.equal(briefs.length, 1, `exactly one brief: ${briefs.length}`);
    assert.match(briefs[0], /<!-- cds-design:gate .*최신 변경 받아오기/);
    assert.match(briefs[0], /index\.html/);
    assert.match(briefs[0], /stash drop/);

    const status = await promisifiedRun("git", ["-C", join(dir, "work"), "status", "--porcelain"]);
    assert.match(status, /^UU index\.html/m, "the conflicted file sits unmerged, awaiting Claude");
    const stashes = await promisifiedRun("git", ["-C", join(dir, "work"), "stash", "list"]);
    assert.match(stashes, /최신화 임시 보관/, "the parked work is not dropped");

    // Claude's recovery, exactly as the brief describes: resolve, add, drop.
    writeFileSync(join(dir, "work", "index.html"), "<p>합쳐진 줄</p>\n");
    await promisifiedRun("git", ["-C", join(dir, "work"), "add", "index.html"]);
    await promisifiedRun("git", ["-C", join(dir, "work"), "stash", "drop"]);
    const after = await workspace.status();
    assert.equal(after.phase, "ready");
    assert.ok(after.pendingChanges >= 1, "the resolved work is back, awaiting 저장");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mid-cycle, the developer's base merges into the cycle — conflict included", async () => {
  const dir = workdir("hub-refresh-cycle-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const workspace = await bringUp(dir, fixture);

    // The first 저장 opens the cycle branch and pushes it.
    const html = readFileSync(join(dir, "work", "index.html"), "utf8");
    writeFileSync(
      join(dir, "work", "index.html"),
      html.replace("<p>연결 레포가 렌더하는 미리보기입니다.</p>", "<p>화면 1</p>"),
    );
    const saved = await workspace.save({ message: "화면 1" });
    assert.equal(saved.stage, "published", saved.detail ?? "");
    assert.match(workspace.currentBranch ?? "", /^cds-design\//);

    // The developer changes the same line on the base branch meanwhile.
    const seedHtml = readFileSync(join(fixture.seed, "index.html"), "utf8");
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "index.html": seedHtml.replace("<p>연결 레포가 렌더하는 미리보기입니다.</p>", "<p>개발자가 고친 줄</p>"),
    });

    // Unsaved work on another file parks while the merge runs.
    writeFileSync(join(dir, "work", "CLAUDE.md"), "# 기획자의 메모\n");

    const briefs = [];
    await workspace.pull((brief) => briefs.push(brief));

    assert.equal(briefs.length, 1, `one brief: ${briefs.join(" | ")}`);
    assert.match(briefs[0], /\[conflict\]/);
    assert.match(briefs[0], /git stash pop/);
    const verify = await promisifiedRun("git", ["-C", join(dir, "work"), "rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    assert.ok(verify.trim().length > 0, "the merge stays open for Claude");

    // Claude finishes the merge, then replays the parked work.
    writeFileSync(join(dir, "work", "index.html"), "<p>합친 화면</p>\n");
    await promisifiedRun("git", ["-C", join(dir, "work"), "add", "index.html"]);
    await promisifiedRun(
      "git",
      ["-C", join(dir, "work"), "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "[conflict] 병합 정리"],
    );
    await promisifiedRun("git", ["-C", join(dir, "work"), "stash", "pop"]);
    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    assert.ok(claude.includes("기획자의 메모"), "the parked edit came back after the merge");

    const parents = await promisifiedRun("git", ["-C", join(dir, "work"), "rev-list", "--parents", "-n", "1", "HEAD"]);
    assert.equal(parents.trim().split(" ").length, 3, "the cycle carries a real merge commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a base branch that diverged is named, never rewritten", async () => {
  const dir = workdir("hub-refresh-diverged-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const workspace = await bringUp(dir, fixture);

    // A local commit on the base branch (a session could make one) plus a
    // fresh upstream commit: 자동 병합 must not rewrite either side.
    writeFileSync(join(dir, "work", "CLAUDE.md"), "# 로컬 커밋\n");
    await promisifiedRun("git", ["-C", join(dir, "work"), "add", "CLAUDE.md"]);
    await promisifiedRun(
      "git",
      ["-C", join(dir, "work"), "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "local"],
    );
    const localHead = (await promisifiedRun("git", ["-C", join(dir, "work"), "rev-parse", "HEAD"])).trim();
    await pushFixtureChange(fixture.seed, fixture.remote, { "업스트림.md": "원격에서만 있는 커밋\n" });

    await workspace.pull();
    const status = await workspace.status();
    assert.match(status.detail ?? "", /갈라진/, `the reason is Korean: ${status.detail ?? ""}`);
    const head = (await promisifiedRun("git", ["-C", join(dir, "work"), "rev-parse", "HEAD"])).trim();
    assert.equal(head, localHead, "local history is untouched");

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 되돌리기와 요약 (PLAN D51 · D52 · D53) — offline: the fallback path and the
// snapshot mechanics. The summarizer's Claude turn is test:daemon's stub case.
// ---------------------------------------------------------------------------

test("폴백 요약은 경로를 화면 폴더로 묶어 `폴더: 수정 N · 추가 M` 로 쓴다", () => {
  // `src/screens/<기능>/<화면>` — the folder above the file names the group,
  // exactly as D51's own example (`member: 수정 2 · 추가 1`) reads.
  assert.equal(fallbackGroup("src/screens/member/MemberList.screen.tsx"), "member");
  assert.equal(fallbackGroup("src/screens/pay/PayFailed.screen.tsx"), "pay");
  // A file with no folder above it has no group to borrow.
  assert.equal(fallbackGroup("index.html"), "기타");

  const lines = fallbackSummary([
    { path: "src/screens/member/MemberList.screen.tsx", status: "modified" },
    { path: "src/screens/member/PayFailed.screen.tsx", status: "added" },
    { path: "src/screens/pay/Pay.screen.tsx", status: "modified" },
    { path: "index.html", status: "modified" },
  ]);
  assert.deepEqual(lines, [
    "member: 수정 1 · 추가 1",
    "pay: 수정 1",
    "기타: 수정 1",
  ]);
});

test("복원 계획은 허용 경로 밖의 파일을 손대지 않는다", () => {
  const plan = restorePlan(
    [
      "M\tindex.html",
      "A\tsrc/screens/new/New.screen.tsx",
      // A snapshot tree is git's own output — but the plan is what executes,
      // and both of these are escapes, not paths inside a worktree.
      "D\t../outside/secret.txt",
      "A\t/etc/evil",
    ].join("\n"),
  );
  assert.ok(safeRepoPath("src/screens/new/New.screen.tsx") !== null);
  assert.equal(safeRepoPath("../outside/secret.txt"), null);
  assert.equal(safeRepoPath("/etc/evil"), null);
  assert.deepEqual(plan.checkout, ["index.html"]);
  assert.deepEqual(plan.remove, ["src/screens/new/New.screen.tsx"]);
});

test("체크포인트는 추적 안 된 새 파일을 담고 HEAD · 인덱스를 안 건드린다", async () => {
  const dir = workdir("hub-checkpoint-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const workspace = await bringUp(dir, fixture);
    const work = join(dir, "work");
    const git = (args) => promisifiedRun("git", ["-C", work, ...args]);

    // The planner's unsaved half, the exact shape a turn starts with: a
    // tracked edit staged in the real index, and a brand-new screen file
    // git has never heard of.
    const html = readFileSync(join(work, "index.html"), "utf8");
    writeFileSync(join(work, "index.html"), `${html}<p>저장 전 마지막 모습</p>\n`);
    await git(["add", "index.html"]);
    mkdirSync(join(work, "src", "screens", "new"), { recursive: true });
    writeFileSync(join(work, "src", "screens", "new", "New.screen.tsx"), "export const New = () => null;\n");

    const headBefore = (await git(["rev-parse", "HEAD"])).trim();
    const checkpoint = await workspace.checkpoint("session-a", 1);
    assert.equal(checkpoint.id, "session-a/1");
    assert.equal(checkpoint.sessionId, "session-a");
    assert.equal(checkpoint.turn, 1);
    assert.ok(checkpoint.at !== "", "the snapshot is dated");

    assert.equal((await git(["rev-parse", "HEAD"])).trim(), headBefore, "HEAD never moved");
    const status = await git(["status", "--porcelain"]);
    assert.match(status, /^M  index\.html/m, "the real index kept its staged edit");
    // git collapses a fully-untracked directory to `?? src/`; the invariant
    // is that the real index never absorbed the new screen.
    assert.match(status, /^\?\? src\//m, "the new screen stayed untracked");
    assert.equal((await git(["ls-files", "src/screens/new/New.screen.tsx"])).trim(), "", "the real index never absorbed the new screen");

    // `stash create` could not have done this: the snapshot holds the file
    // too, which is the whole point for a first screen before its first 저장.
    const tree = await git(["ls-tree", "-r", "--name-only", "refs/cds-design/checkpoints/session-a/1"]);
    assert.match(tree, /src\/screens\/new\/New\.screen\.tsx/, "the snapshot holds the untracked screen");
    assert.match(tree, /index\.html/, "and the tracked file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarize without a Claude path falls back to folder grouping — once per diff", async () => {
  const dir = workdir("hub-summarize-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    // No claudeExecutable option: the fallback is the only path (PLAN D51).
    const workspace = await bringUp(dir, fixture);

    const html = readFileSync(join(dir, "work", "index.html"), "utf8");
    writeFileSync(join(dir, "work", "index.html"), `${html}<p>회원 목록 줄</p>\n`);
    mkdirSync(join(dir, "work", "src", "screens", "member"), { recursive: true });
    writeFileSync(
      join(dir, "work", "src", "screens", "member", "PayFailed.screen.tsx"),
      "export const PayFailed = () => null;\n",
    );

    const summary = await workspace.summarize();
    assert.equal(summary.source, "fallback");
    assert.deepEqual(summary.lines, ["member: 추가 1", "기타: 수정 1"]);

    // Same diff, same answer — from the one-entry cache, without another look.
    const again = await workspace.summarize();
    assert.deepEqual(again, summary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
