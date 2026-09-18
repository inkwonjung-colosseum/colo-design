/**
 * Workspace bring-up phases — the sync state machine and the clone debris
 * sweep.
 *
 * Split out of repo.test.mjs — the bodies are verbatim; shared scaffolding
 * (workdir · repoRoot · clone · bringUp · promisifiedRun · stub client) lives
 * in ./repo-test-kit.mjs.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_URL_MISSING_DETAIL, RepoWorkspace } from "../dist/repo.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";
import { clone, workdir } from "./repo-test-kit.mjs";

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
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
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
    assert.ok(
      !existsSync(join(root, "partial-download.tmp")),
      "the debris must not survive the re-clone",
    );
    assert.ok(existsSync(join(root, ".git")), "a real clone is in place");
    await workspace.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("전환된 프로젝트의 늦은 bring-up 은 프리뷰 포트를 건드리지 않는다", async () => {
  const dir = workdir("hub-switch-race-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const port = await freePort();
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port,
    });
    const workspace = clone(dir, fixture);
    const serving = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        return res.status > 0;
      } catch {
        return false;
      }
    };

    // B→C 전환: B 의 bring-up 이 진행 중이던 창에서 활성이 바뀌었다. 늦게
    // 끝나는 B 는 install · preview — 무인 부수효과 — 에서 멈춰야 한다: 포트를
    // 빼액지도, 데몬보다 오래 사는 고아 서버를 남기지도 않는다.
    workspace.setActive(false);
    const abandoned = await workspace.sync();
    await workspace.stop();
    assert.notEqual(abandoned.phase, "ready", "the abandoned bring-up never reached ready");
    assert.equal(await serving(), false, "no orphan preview server survives the switch");

    // 게이트는 영구 스위치가 아니다 — 다시 활성이 되면 다음 sync 는 평범하게
    // 띄운다.
    workspace.setActive(true);
    const ready = await workspace.sync();
    try {
      assert.equal(ready.phase, "ready", ready.detail ?? "");
      assert.equal(await serving(), true, "re-activation brings the preview up");
    } finally {
      await workspace.stop();
    }
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
    assert.throws(
      () => readFileSync(marker),
      /ENOENT/,
      "the old clone must be discarded, not merged",
    );
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

test("a moved url forgets the old repository's cycle — the fresh clone starts its own", async () => {
  const dir = workdir("hub-repo-move-cycle-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const port = await freePort();
    const first = await createFixtureRepo({ dir: join(dir, "a"), port });
    const second = await createFixtureRepo({ dir: join(dir, "b"), port });

    // What the project registry hears; the cycle lives only there.
    const cycles = [];
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: first.remote,
      onStatus: () => undefined,
      cycle: {
        branch: "colo-design/20260918-1",
        handoff: {
          number: 7,
          url: "https://example.test/pull/7",
          title: "옛 레포의 요청",
          state: "open",
          branch: "colo-design/20260918-1",
        },
      },
      onCycleChange: (cycle) => cycles.push(cycle),
    });
    assert.equal((await workspace.sync()).phase, "ready");

    const moved = await workspace.update({ url: second.remote });
    assert.equal(moved.phase, "ready", moved.detail ?? "");
    assert.equal(workspace.currentBranch, null, "the old cycle's branch stays behind");
    assert.equal(workspace.currentHandoff, null, "the old PR is not the new repo's");
    const last = cycles.at(-1);
    assert.equal(last?.branch, null, "the registry heard the clear");
    assert.equal(last?.handoff, null);
    await workspace.stop();
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
