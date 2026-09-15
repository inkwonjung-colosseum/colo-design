/**
 * 레포 최신화 — pull the developer's side without reading git: unsaved work carried across a moved base, conflicts handed to Claude, cycle re-reads that must not land.
 *
 * Split out of repo.test.mjs — the bodies are verbatim; shared scaffolding
 * (workdir · repoRoot · clone · bringUp · promisifiedRun · stub client) lives
 * in ./repo-test-kit.mjs.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RepoWorkspace } from "../dist/repo.js";
import { createFixtureRepo, freePort, pushFixtureChange } from "./fixture-repo.mjs";
import { bringUp, promisifiedRun, stubPullRequestClient, workdir } from "./repo-test-kit.mjs";

// ---------------------------------------------------------------------------
// 레포 최신화: pull the developer's side without reading git
// ---------------------------------------------------------------------------

test("최신화 carries unsaved work across a moved base — tracked and untracked alike", async () => {
  const dir = workdir("hub-refresh-dirty-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);

    // The planner's unsaved half: a tracked edit at the top of CLAUDE.md
    // (nine lines from the developer's edit below, so git can truly combine
    // them) plus a brand-new screen.
    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    writeFileSync(
      join(dir, "work", "CLAUDE.md"),
      claude.replace("# fixture colo-design 레포", "# 사용자의 저장하지 않은 제목"),
    );
    mkdirSync(join(dir, "work", "src", "screens", "new"), { recursive: true });
    writeFileSync(
      join(dir, "work", "src", "screens", "new", "New.screen.tsx"),
      "export const New = () => null;\n",
    );

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
    assert.ok(
      merged.includes("사용자의 저장하지 않은 제목"),
      "the planner's unsaved edit survived",
    );
    assert.ok(
      existsSync(join(dir, "work", "src", "screens", "new", "New.screen.tsx")),
      "untracked screens ride along",
    );
    assert.deepEqual(briefs, [], "a clean combine briefs nobody");
    const status = await workspace.status();
    assert.equal(status.phase, "ready");
    assert.ok(
      status.pendingChanges >= 2,
      `the work is back, awaiting 저장: ${status.pendingChanges}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare bring-up carries unsaved work across a moved base too", async () => {
  const dir = workdir("hub-refresh-bootstrap-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);

    // The planner left unsaved work at the top of CLAUDE.md; the developer
    // merged an edit into the same file's end. A blind `git pull --ff-only`
    // refused this exact shape.
    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    writeFileSync(
      join(dir, "work", "CLAUDE.md"),
      claude.replace("# fixture colo-design 레포", "# 사용자의 저장하지 않은 제목"),
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
    assert.ok(
      merged.includes("사용자의 저장하지 않은 제목"),
      "the planner's unsaved edit survived",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("최신화 hands a genuine conflict to Claude, work parked and named", async () => {
  const dir = workdir("hub-refresh-conflict-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);

    const html = readFileSync(join(dir, "work", "index.html"), "utf8");
    writeFileSync(
      join(dir, "work", "index.html"),
      html.replace("<p>연결 레포가 렌더하는 미리보기입니다.</p>", "<p>사용자의 줄</p>"),
    );
    // The developer changed the very same line: git cannot combine this.
    const seedHtml = readFileSync(join(fixture.seed, "index.html"), "utf8");
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "index.html": seedHtml.replace(
        "<p>연결 레포가 렌더하는 미리보기입니다.</p>",
        "<p>개발자의 줄</p>",
      ),
    });

    const briefs = [];
    await workspace.pull((brief) => briefs.push(brief));

    assert.equal(briefs.length, 1, `exactly one brief: ${briefs.length}`);
    assert.match(briefs[0], /<!-- colo-design:gate .*최신 변경 받아오기/);
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

test("반영됨 확인은 저장하지 않은 변경을 지우지 않는다", async () => {
  const dir = workdir("hub-merged-dirty-");
  const previousSlug = process.env.COLO_DESIGN_GITHUB_SLUG;
  process.env.COLO_DESIGN_GITHUB_SLUG = "colosseumcoinckr/colo-design-e2e";
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const requests = [];
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      onStatus: () => undefined,
      gitHubClient: () => ({
        ...stubPullRequestClient(requests),
        // The developer pressed merge: the pull request reads merged now.
        async getPullRequest() {
          return {
            number: 7,
            url: "https://github.com/colosseumcoinckr/colo-design-e2e/pull/7",
            title: "결제 화면",
            state: "merged",
          };
        },
      }),
    });
    await workspace.sync();
    await workspace.stop();

    // 저장 → 넘기기: 이번 사이클의 변경이 브랜치에 커밋돼 올라간다.
    writeFileSync(join(dir, "work", "index.html"), "<p>사이클의 변경</p>\n");
    const saved = await workspace.save({ message: "사이클의 변경" });
    assert.equal(saved.stage, "published", saved.detail ?? "");
    await workspace.handoff({ title: "결제 화면" });

    // 개발자의 병합: 원격 베이스는 사이클의 변경과 함께, 사용자가 모르는
    // 사이 main 에서 직접 건 문장(CLAUDE.md)까지 담는다. 위험한 조합은
    // 정확히 이것이다 — CLAUDE.md 는 이번 사이클이 건드린 적 없어 양쪽
    // 브랜치에서 같으므로 checkout 이 사용자의 저장 안 한 편집을 실어
    // 나르고, 뒤따르는 reset --hard 가 그것을 origin/main 의 문장으로
    // 소리 없이 덮어쓴다.
    const seedClaude = readFileSync(join(fixture.seed, "CLAUDE.md"), "utf8");
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "index.html": "<p>사이클의 변경</p>\n",
      "CLAUDE.md": `${seedClaude}\n- 개발자가 main 에서 직접 단 문장\n`,
    });
    writeFileSync(
      join(dir, "work", "CLAUDE.md"),
      `${readFileSync(join(dir, "work", "CLAUDE.md"), "utf8")}\n사용자의 저장 안 한 메모\n`,
    );

    const report = await workspace.refreshHandoff();
    assert.equal(report?.state, "merged");
    const after = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    assert.ok(after.includes("사용자의 저장 안 한 메모"), "unsaved work survives the merged reset");
  } finally {
    if (previousSlug === undefined) delete process.env.COLO_DESIGN_GITHUB_SLUG;
    else process.env.COLO_DESIGN_GITHUB_SLUG = previousSlug;
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 커미티 2026-09-15 판정 1·2. 폴링은 10분마다 도는 타이머다: 그것이 사이클을
 * 내려앉히면 되돌리기 기록(체크포인트)이 아무도 없는 자리에서 사라지고,
 * 반대로 칩에만 끝을 적고 착지를 미루면 `this.branch` 가 살아남아 다음 저장이
 * 이미 닫힌 브랜치로 푸시된다. 두 실패 모두 이 한 테스트가 잡는다.
 */
const endedCycleWorkspace = async (dir, state) => {
  const fixture = await createFixtureRepo({
    dir: join(dir, "fixture"),
    port: await freePort(),
  });
  const requests = [];
  const workspace = new RepoWorkspace({
    root: join(dir, "work"),
    url: fixture.remote,
    onStatus: () => undefined,
    gitHubClient: () => ({
      ...stubPullRequestClient(requests),
      async getPullRequest() {
        return {
          number: 7,
          url: "https://github.com/colosseumcoinckr/colo-design-e2e/pull/7",
          title: "결제 화면",
          state,
        };
      },
    }),
  });
  await workspace.sync();
  await workspace.stop();
  writeFileSync(join(dir, "work", "index.html"), "<p>사이클의 변경</p>\n");
  const saved = await workspace.save({ message: "사이클의 변경" });
  assert.equal(saved.stage, "published", saved.detail ?? "");
  await workspace.handoff({ title: "결제 화면" });
  await workspace.checkpoint("session-a", 1);
  return workspace;
};

test("폴링의 재판독은 착지하지 않는다 — 사람이 올 때까지 사이클도 되돌리기도 그대로", async () => {
  const dir = workdir("hub-peek-merged-");
  const previousSlug = process.env.COLO_DESIGN_GITHUB_SLUG;
  process.env.COLO_DESIGN_GITHUB_SLUG = "colosseumcoinckr/colo-design-e2e";
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const workspace = await endedCycleWorkspace(dir, "merged");
    const work = join(dir, "work");
    const git = (args) => promisifiedRun("git", ["-C", work, ...args]);
    const branch = workspace.currentBranch;
    assert.ok(branch, "넘긴 사이클에는 브랜치가 있다");

    const peeked = await workspace.peekHandoff();
    assert.equal(peeked?.state, "merged", "읽기는 개발자의 병합을 본다");
    assert.equal(workspace.currentHandoff?.state, "open", "칩은 아직 넘김 그대로다");
    assert.equal(workspace.currentBranch, branch, "사이클은 아직 닫히지 않았다");
    assert.equal(workspace.handoffLandingDue, true, "내려앉을 끝이 세워졌다");
    assert.match(
      await git(["for-each-ref", "refs/colo-design/checkpoints"]),
      /session-a\/1/,
      "타이머는 되돌리기 기록을 지우지 않는다",
    );

    // 사람이 왔다 — 그제야 내려앉는다.
    await workspace.landHandoffIfDue();
    assert.equal(workspace.currentBranch, null, "사이클이 닫혀 다음 저장이 새 브랜치를 연다");
    assert.equal(workspace.currentHandoff?.state, "merged", "이제 칩이 반영됨을 말한다");
    assert.equal(workspace.handoffLandingDue, false);
    assert.equal(
      (await git(["for-each-ref", "refs/colo-design/checkpoints"])).trim(),
      "",
      "반영된 사이클의 스냅샷은 착지와 함께 간다",
    );
  } finally {
    if (previousSlug === undefined) delete process.env.COLO_DESIGN_GITHUB_SLUG;
    else process.env.COLO_DESIGN_GITHUB_SLUG = previousSlug;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("반려된 사이클은 베이스로 돌아가되 되돌리기 기록은 남는다", async () => {
  const dir = workdir("hub-closed-cycle-");
  const previousSlug = process.env.COLO_DESIGN_GITHUB_SLUG;
  process.env.COLO_DESIGN_GITHUB_SLUG = "colosseumcoinckr/colo-design-e2e";
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const workspace = await endedCycleWorkspace(dir, "closed");
    const work = join(dir, "work");
    const git = (args) => promisifiedRun("git", ["-C", work, ...args]);

    const report = await workspace.refreshHandoff();
    assert.equal(report?.state, "closed");
    assert.equal(workspace.currentBranch, null, "반려도 사이클의 끝이다 — 브랜치를 잊는다");
    assert.equal(
      (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
      "main",
      "워크트리가 베이스로 돌아와야 다음 저장이 반려된 커밋을 다시 제안하지 않는다",
    );
    assert.match(
      await git(["for-each-ref", "refs/colo-design/checkpoints"]),
      /session-a\/1/,
      "합쳐진 적 없는 작업이므로 되돌아갈 자리는 남는다",
    );
  } finally {
    if (previousSlug === undefined) delete process.env.COLO_DESIGN_GITHUB_SLUG;
    else process.env.COLO_DESIGN_GITHUB_SLUG = previousSlug;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("준비가 충돌로 멈춘 뒤에도 pull 은 열려 있다 — 오류 카드의 Claude 요청이 브리프를 실어 나른다 (D96)", async () => {
  const dir = workdir("hub-refresh-error-brief-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);

    // The same-line collision parks the worktree mid-recovery; a BARE
    // bring-up has no thread to brief, so the throw is what the planner's
    // error card answers.
    const html = readFileSync(join(dir, "work", "index.html"), "utf8");
    writeFileSync(
      join(dir, "work", "index.html"),
      html.replace("<p>연결 레포가 렌더하는 미리보기입니다.</p>", "<p>사용자의 줄</p>"),
    );
    const seedHtml = readFileSync(join(fixture.seed, "index.html"), "utf8");
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "index.html": seedHtml.replace(
        "<p>연결 레포가 렌더하는 미리보기입니다.</p>",
        "<p>개발자의 줄</p>",
      ),
    });

    const stopped = await workspace.sync();
    assert.equal(stopped.phase, "error", stopped.detail ?? "");
    assert.match(stopped.detail ?? "", /충돌/, `the card reads Korean: ${stopped.detail ?? ""}`);
    assert.equal(
      stopped.errorKind,
      "conflict",
      "the card must name the failure a Claude ask can fix",
    );

    // D96: pull runs from the error phase now — the ask rides the same wire
    // a typed message would, and the leftover conflict briefs exactly as it
    // would have from ready.
    const briefs = [];
    await workspace.pull((brief) => briefs.push(brief));
    assert.equal(briefs.length, 1, `one brief: ${briefs.join(" | ")}`);
    assert.match(briefs[0], /<!-- colo-design:gate .*최신 변경 받아오기/);
    assert.match(briefs[0], /index\.html/);

    // Claude's recovery, exactly as the brief describes: resolve, add, drop.
    // Then 준비 다시 시도 — the clone comes back to ready.
    writeFileSync(join(dir, "work", "index.html"), "<p>합쳐진 줄</p>\n");
    await promisifiedRun("git", ["-C", join(dir, "work"), "add", "index.html"]);
    await promisifiedRun("git", ["-C", join(dir, "work"), "stash", "drop"]);
    const revived = await workspace.sync();
    assert.equal(revived.phase, "ready", revived.detail ?? "");
    assert.ok(revived.pendingChanges >= 1, "the resolved work is back, awaiting 저장");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mid-cycle, the developer's base merges into the cycle — conflict included", async () => {
  const dir = workdir("hub-refresh-cycle-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);

    // The first 저장 opens the cycle branch and pushes it.
    const html = readFileSync(join(dir, "work", "index.html"), "utf8");
    writeFileSync(
      join(dir, "work", "index.html"),
      html.replace("<p>연결 레포가 렌더하는 미리보기입니다.</p>", "<p>화면 1</p>"),
    );
    const saved = await workspace.save({ message: "화면 1" });
    assert.equal(saved.stage, "published", saved.detail ?? "");
    assert.match(workspace.currentBranch ?? "", /^colo-design\//);

    // The developer changes the same line on the base branch meanwhile.
    const seedHtml = readFileSync(join(fixture.seed, "index.html"), "utf8");
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "index.html": seedHtml.replace(
        "<p>연결 레포가 렌더하는 미리보기입니다.</p>",
        "<p>개발자가 고친 줄</p>",
      ),
    });

    // Unsaved work on another file parks while the merge runs.
    writeFileSync(join(dir, "work", "CLAUDE.md"), "# 사용자의 메모\n");

    const briefs = [];
    await workspace.pull((brief) => briefs.push(brief));

    assert.equal(briefs.length, 1, `one brief: ${briefs.join(" | ")}`);
    assert.match(briefs[0], /\[conflict\]/);
    assert.match(briefs[0], /git stash pop/);
    const verify = await promisifiedRun("git", [
      "-C",
      join(dir, "work"),
      "rev-parse",
      "-q",
      "--verify",
      "MERGE_HEAD",
    ]);
    assert.ok(verify.trim().length > 0, "the merge stays open for Claude");

    // Claude finishes the merge, then replays the parked work.
    writeFileSync(join(dir, "work", "index.html"), "<p>합친 화면</p>\n");
    await promisifiedRun("git", ["-C", join(dir, "work"), "add", "index.html"]);
    await promisifiedRun("git", [
      "-C",
      join(dir, "work"),
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@t",
      "commit",
      "-m",
      "[conflict] 병합 정리",
    ]);
    await promisifiedRun("git", ["-C", join(dir, "work"), "stash", "pop"]);
    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    assert.ok(claude.includes("사용자의 메모"), "the parked edit came back after the merge");

    const parents = await promisifiedRun("git", [
      "-C",
      join(dir, "work"),
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    ]);
    assert.equal(parents.trim().split(" ").length, 3, "the cycle carries a real merge commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("저장 waits out an open conflict — the markers never ride a save", async () => {
  const dir = workdir("hub-save-conflict-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);

    // The first 저장 opens the cycle branch with one screen edit.
    const html = readFileSync(join(dir, "work", "index.html"), "utf8");
    writeFileSync(
      join(dir, "work", "index.html"),
      html.replace("<p>연결 레포가 렌더하는 미리보기입니다.</p>", "<p>화면 1</p>"),
    );
    const saved = await workspace.save({ message: "화면 1" });
    assert.equal(saved.stage, "published", saved.detail ?? "");

    // The developer edits the same line on the base branch meanwhile.
    const seedHtml = readFileSync(join(fixture.seed, "index.html"), "utf8");
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "index.html": seedHtml.replace(
        "<p>연결 레포가 렌더하는 미리보기입니다.</p>",
        "<p>개발자가 고친 줄</p>",
      ),
    });
    const briefs = [];
    const outcome = await workspace.pull((brief) => briefs.push(brief));
    assert.equal(outcome, "conflict");
    assert.equal(briefs.length, 1, "the conflict briefed the thread");

    // The planner saves anyway: the refusal must name the conflict, and the
    // merge must survive the attempt untouched — staging the approved paths
    // would have concluded the open merge with the markers and pushed it.
    const headBefore = (
      await promisifiedRun("git", ["-C", join(dir, "work"), "rev-parse", "HEAD"])
    ).trim();
    const refused = await workspace.save({ message: "마커째 저장" });
    assert.equal(refused.stage, "failed");
    assert.match(refused.detail ?? "", /충돌/);
    const mergeHead = await promisifiedRun("git", [
      "-C",
      join(dir, "work"),
      "rev-parse",
      "-q",
      "--verify",
      "MERGE_HEAD",
    ]);
    assert.ok(mergeHead.trim().length > 0, "the merge stays open for Claude");
    const headAfter = (
      await promisifiedRun("git", ["-C", join(dir, "work"), "rev-parse", "HEAD"])
    ).trim();
    assert.equal(headAfter, headBefore, "the refused save moved nothing");

    // Claude's cleanup concludes the merge — and a 저장 after it reopens.
    writeFileSync(join(dir, "work", "index.html"), "<p>합친 화면</p>\n");
    await promisifiedRun("git", ["-C", join(dir, "work"), "add", "index.html"]);
    await promisifiedRun("git", [
      "-C",
      join(dir, "work"),
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@t",
      "commit",
      "-m",
      "[conflict] 병합 정리",
    ]);
    writeFileSync(join(dir, "work", "index.html"), "<p>정리 뒤 화면</p>\n");
    const reopened = await workspace.save({ message: "정리 뒤 저장" });
    assert.equal(reopened.stage, "published", reopened.detail ?? "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a base branch that diverged is named, never rewritten", async () => {
  const dir = workdir("hub-refresh-diverged-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);

    // A local commit on the base branch (a session could make one) plus a
    // fresh upstream commit: 자동 병합 must not rewrite either side.
    writeFileSync(join(dir, "work", "CLAUDE.md"), "# 로컬 커밋\n");
    await promisifiedRun("git", ["-C", join(dir, "work"), "add", "CLAUDE.md"]);
    await promisifiedRun("git", [
      "-C",
      join(dir, "work"),
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@t",
      "commit",
      "-m",
      "local",
    ]);
    const localHead = (
      await promisifiedRun("git", ["-C", join(dir, "work"), "rev-parse", "HEAD"])
    ).trim();
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "업스트림.md": "원격에서만 있는 커밋\n",
    });

    await workspace.pull();
    const status = await workspace.status();
    assert.match(status.detail ?? "", /갈라진/, `the reason is Korean: ${status.detail ?? ""}`);
    const head = (
      await promisifiedRun("git", ["-C", join(dir, "work"), "rev-parse", "HEAD"])
    ).trim();
    assert.equal(head, localHead, "local history is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
