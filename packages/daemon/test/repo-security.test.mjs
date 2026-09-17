/**
 * Credential-boundary checks — the PAT stays out of urls, argv, errors, and the clone; a registry repo's save writes no .npmrc and runs no sneaky check.
 *
 * Split out of repo.test.mjs — the bodies are verbatim; shared scaffolding
 * (workdir · repoRoot · clone · bringUp · promisifiedRun · stub client) lives
 * in ./repo-test-kit.mjs.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertClonableRepoUrl, RepoWorkspace } from "../dist/repo.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";
import { promisifiedRun, workdir } from "./repo-test-kit.mjs";

// ---------------------------------------------------------------------------
// PAT handling
// ---------------------------------------------------------------------------

test("a clone url names a transport git may run a command through, so only the known ones pass", () => {
  // The forms a planner may legitimately aim at: the web's two, git/ssh
  // remotes, scp-style, and a local path (the offline suites' bare remotes).
  for (const url of [
    "https://github.com/org/repo.git",
    "http://gitea.internal/org/repo.git",
    "ssh://git@github.com/org/repo.git",
    "git://host/org/repo.git",
    "git@github.com:org/repo.git",
    "/var/folders/tmp/remote.git",
  ]) {
    assert.doesNotThrow(() => assertClonableRepoUrl(url), url);
  }
  // ext:: (and its helper cousins) is a command executor wearing a url; a
  // leading dash is an option; an unknown scheme is not a transport we know;
  // a bare word is not a path this tool will resolve for the planner.
  for (const url of [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${Q} 는 템플릿이 아니라 명령 주입 페이로드 그 자체다.
    "ext::sh -c touch${Q}pwned",
    "fdim::9",
    "--upload-pack=evil",
    "ftp://host/repo.git",
    "relative-nope",
  ]) {
    assert.throws(() => assertClonableRepoUrl(url), /이 주소로는/, url);
  }
  // The one place `::` is an address, not a helper: an IPv6 literal passes.
  assert.doesNotThrow(() => assertClonableRepoUrl("ssh://user@[2001:db8::1]/repo.git"));
});

test("git auth rides the environment, never the url — the PAT is absent from argv and .git/config", async () => {
  process.env.CLAUDE_CONFIG_DIR = workdir("hub-repo-auth-env-");
  const root = join(workdir("hub-repo-auth-clone-"), "work");
  const broadcasts = [];
  const workspace = new RepoWorkspace({
    root,
    url: "https://127.0.0.1:1/org/repo.git",
    pat: "ghp_super_secret",
    onStatus: (status) => broadcasts.push(status),
  });
  try {
    const status = await workspace.sync();
    assert.equal(status.phase, "error");
    // The failure detail quotes what git saw — the clean url, never the PAT.
    assert.ok(
      !JSON.stringify(broadcasts).includes("ghp_super_secret"),
      "the PAT must stay daemon-side",
    );
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
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
    assert.ok(
      !JSON.stringify(broadcasts).includes("ghp_super_secret"),
      "the PAT must stay daemon-side",
    );
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});
// ---------------------------------------------------------------------------
// Publish regressions (B1, F5)
// ---------------------------------------------------------------------------

/** A fixture whose check passes while writing a file nobody reviewed. */
const SNEAKY_CHECK = `import { writeFileSync } from "node:fs";
writeFileSync("sneaky-unreviewed.txt", "the gate wrote this");
console.log("check: 통과");
`;

/** A private-registry fixture + a PAT, for the npmrc-leak checks. The host
 * is the real GitHub endpoint — the derivation refuses a registry line a
 * repo could aim at a server of its own choosing. */
async function registryFixture(dir, home) {
  const fixture = await createFixtureRepo({
    dir: join(dir, "fixture"),
    port: await freePort(),
    previewCommand: 'node -e "process.exit(0)"',
    checkMjs: SNEAKY_CHECK,
    registry: { host: "npm.pkg.github.com", scope: "@leaktest" },
  });
  const npmrc = join(home, ".npmrc");
  process.env.COLO_DESIGN_NPMRC = npmrc;
  writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n");
  return { fixture, npmrc };
}

test("B1: a registry repo's committed .npmrc never gains the PAT — creds stay user-level", async () => {
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

    // The repo's own .npmrc is the registry line and nothing else — the PAT
    // must never be written into the clone.
    const committedNpmrc = readFileSync(join(dir, "work", ".npmrc"), "utf8");
    assert.equal(committedNpmrc, "@leaktest:registry=https://npm.pkg.github.com/\n");
    const user = readFileSync(npmrc, "utf8");
    assert.ok(
      user.includes("@leaktest:registry=https://npm.pkg.github.com/"),
      "scope mapping merged",
    );
    assert.ok(
      user.includes("//npm.pkg.github.com/:_authToken=ghp_npmrc_leak_probe"),
      "token merged user-level",
    );
    assert.ok(
      user.includes("registry=https://registry.npmjs.org/"),
      "existing lines survive the merge",
    );

    writeFileSync(join(dir, "work", "index.html"), "<p>게시 검증</p>\n");
    const published = await workspace.save({ message: "npmrc 누출 검증" });
    assert.equal(published.stage, "published", published.detail ?? "");

    const pushedNpmrc = await promisifiedRun("git", ["-C", fixture.remote, "show", "HEAD:.npmrc"]);
    assert.equal(pushedNpmrc, "@leaktest:registry=https://npm.pkg.github.com/\n");
    const pushedPat = await promisifiedRun("git", [
      "-C",
      fixture.remote,
      "grep",
      "-c",
      "ghp_npmrc_leak_probe",
      "HEAD",
    ]).catch(() => "");
    assert.ok(!String(pushedPat).includes("1"), "the pushed tree has no PAT");
  } finally {
    delete process.env.COLO_DESIGN_NPMRC;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F5: a save does not run the repo's check — a broken gate no longer blocks", async () => {
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

    // A freshly broken check on disk, the way a Claude turn or an editor
    // leaves one: the save must put the work up anyway — problems are the
    // developer's to catch in the pull request, not a wall in front of the
    // planner (실사).
    const manifest = join(dir, "work", "package.json");
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    pkg.scripts.check = "node -e \"console.error('NEWGATE-RAN'); process.exit(7)\"";
    writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);

    writeFileSync(join(dir, "work", "index.html"), "<p>게이트 확인</p>\n");
    const status = await workspace.save({ message: "게이트" });
    assert.equal(status.stage, "published", status.detail ?? "");
    assert.ok(/[0-9a-f]{40}/.test(status.commit ?? ""), status.commit ?? "");
    assert.ok(
      !(status.detail ?? "").includes("NEWGATE-RAN"),
      `the check must not run during a save: ${status.detail ?? ""}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
