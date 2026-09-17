/**
 * 넘기기와 잠깐 치워두기 — the captures a handoff commits and links, and the shelf slots that survive a restart.
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
import {
  bringUp,
  clone,
  promisifiedRun,
  stubPullRequestClient,
  workdir,
} from "./repo-test-kit.mjs";

// ---------------------------------------------------------------------------
// 넘기기의 화면 캡처 (PLAN D56) — offline: a stub GitHub client records the
// pull request it is asked for, and the remote is the fixture's bare clone.
// ---------------------------------------------------------------------------

test("넘기기 commits the captures under .colo-design/shots and links them at the end of the body", async () => {
  const dir = workdir("hub-handoff-shots-");
  const previousSlug = process.env.COLO_DESIGN_GITHUB_SLUG;
  process.env.COLO_DESIGN_GITHUB_SLUG = "colosseumcoinckr/colo-design-e2e";
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
        {
          route: "/member/MemberList",
          state: "default",
          image: Buffer.from("webp-기본"),
          extension: ".webp",
        },
        {
          route: "/결제 완료",
          state: "빈 상태",
          image: Buffer.from("webp-빈 상태"),
          extension: ".webp",
        },
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
    assert.ok(
      committed.includes(".colo-design/shots/-member-MemberList--default.webp"),
      committed.join(", "),
    );
    assert.ok(
      committed.includes(".colo-design/shots/-결제 완료--빈 상태.webp"),
      committed.join(", "),
    );
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
    assert.ok(
      remoteTree.includes(".colo-design/shots/-결제 완료--빈 상태.webp"),
      "the captures reached the remote",
    );

    // The section rides at the END of the body; Korean reads as itself, only
    // the url's spaces escape.
    const body = requests[0].body;
    // 목업 02: 사이클 브랜치의 numstat 이 본문에 실린다 — 미리보기가 약속한
    // 그 절이다. 캡처 절보다 앞: 무엇이 바뀌었는지가 먼저 읽힌다.
    assert.ok(body.indexOf("### 바뀐 파일") > 0, "appended, not prepended");
    assert.match(body, /index\.html \(\+\d+ −\d+\)/, body);
    assert.ok(
      body.indexOf("### 바뀐 파일") < body.indexOf("### 화면 미리보기"),
      "files before captures",
    );
    assert.ok(body.indexOf("### 화면 미리보기") > 0, "appended, not prepended");
    const section = body.slice(body.indexOf("### 화면 미리보기"));
    assert.ok(
      section.includes(`blob/${branch}/.colo-design/shots/-결제%20완료--빈%20상태.webp`),
      section,
    );
    assert.ok(section.includes("`/member/MemberList · default`"), section);
    // Nothing follows the links — the section is the body's tail.
    assert.ok(section.trimEnd().endsWith("-결제%20완료--빈%20상태.webp)"), section);
  } finally {
    if (previousSlug === undefined) delete process.env.COLO_DESIGN_GITHUB_SLUG;
    else process.env.COLO_DESIGN_GITHUB_SLUG = previousSlug;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("첫 저장 전에 찍힌 핀도 넘긴 요청 본문의 수정 요청 절에 온다 — 앵커는 사이클의 태생이다 (D93 후속)", async () => {
  const dir = workdir("hub-handoff-pins-");
  const previousSlug = process.env.COLO_DESIGN_GITHUB_SLUG;
  process.env.COLO_DESIGN_GITHUB_SLUG = "colosseumcoinckr/colo-design-e2e";
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
      previewCommand: 'node -e "process.exit(0)"',
    });
    const requests = [];
    // 사이클의 앵커는 핀보다 앞선다 — 프로젝트가 태어날 때 심기는 값이다.
    const cycle = { branch: null, handoff: null, commentsSince: new Date().toISOString() };
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      cycle,
      onStatus: () => undefined,
      gitHubClient: () => stubPullRequestClient(requests),
    });
    await workspace.sync();
    await workspace.stop();

    // The standard 핀 → 저장 flow: the pin lands BEFORE anything is committed,
    // so a commit-time anchor would sort it out of its own cycle's body.
    const commentsFile = join(dir, "comments.json");
    writeFileSync(
      commentsFile,
      JSON.stringify([
        {
          id: "pin-1",
          screen: "member/MemberList",
          state: "default",
          text: "이 버튼은 더 크게",
          elementText: "div",
          at: new Date().toISOString(),
          resolved: true,
        },
      ]),
    );

    writeFileSync(join(dir, "work", "index.html"), "<p>핀 실어 넘기기</p>\n");
    const saved = await workspace.save({ message: "핀 실어 넘기기" });
    assert.equal(saved.stage, "published", saved.detail ?? "");

    const handed = await workspace.handoff({ title: "핀 실어 넘기기", commentsFile });
    assert.equal(handed.stage, "handed-off", handed.detail ?? handed.stage);
    assert.match(
      requests[0].body,
      /### 수정 요청/,
      "본문에 수정 요청 절이 없으면 기획자의 핀이 개발자에게 닿지 않는다",
    );
    assert.match(requests[0].body, /이 버튼은 더 크게/);
  } finally {
    if (previousSlug === undefined) delete process.env.COLO_DESIGN_GITHUB_SLUG;
    else process.env.COLO_DESIGN_GITHUB_SLUG = previousSlug;
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// 잠깐 치워두기 (보관함 토론 2026-09-15) — snapshot + 버리기 경로로 비우고,
// 꺼내기는 3-way 로 다시 얹는다(되감기가 아니다). stash 는 쓰지 않는다.
// ---------------------------------------------------------------------------

test("잠깐 치워두기: 미저장 작업을 치워 두고 워크트리를 깨끗하게 만든다", async () => {
  const dir = workdir("hub-shelve-basic-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const workspace = await bringUp(dir, fixture);

    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    writeFileSync(
      join(dir, "work", "CLAUDE.md"),
      claude.replace("# fixture colo-design 레포", "# 치워둘 제목"),
    );
    mkdirSync(join(dir, "work", "src", "screens", "parked"), { recursive: true });
    writeFileSync(
      join(dir, "work", "src", "screens", "parked", "Parked.screen.tsx"),
      "export const Parked = () => null;\n",
    );

    await workspace.shelve();

    const shelved = await workspace.status();
    assert.ok(shelved.shelf?.at, "the slot reads as filled");
    assert.equal(shelved.pendingChanges, 0, "the desk is clean — nothing reads as unsaved");
    assert.ok(
      !existsSync(join(dir, "work", "src", "screens", "parked")),
      "untracked work left too",
    );

    // 한 칸: 두 번째 치워두기는 먼저 꺼내라고 말한다.
    await assert.rejects(
      () => workspace.shelve(),
      /이미 치워둔 작업이 있습니다/,
      "a second shelve must name the door out",
    );

    // 치울 것이 없을 때의 거부도 한 문장이다.
    const { applied } = await workspace.unshelve();
    assert.ok(applied.length >= 2, `the shelved work is back: ${applied}`);
    await workspace.discard();
    await assert.rejects(() => workspace.shelve(), /치워둘 변경이 없습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("꺼내기는 최신화된 머리 위에 다시 얹는다 — 되감기가 아니다", async () => {
  const dir = workdir("hub-unshelve-3way-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const workspace = await bringUp(dir, fixture);

    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    writeFileSync(
      join(dir, "work", "CLAUDE.md"),
      claude.replace("# fixture colo-design 레포", "# 치워둔 제목"),
    );
    await workspace.shelve();

    // 치워둔 사이 개발자는 다른 줄을 반영했다 — 같은 파일, 다른 위치.
    const seedClaude = readFileSync(join(fixture.seed, "CLAUDE.md"), "utf8");
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "CLAUDE.md": seedClaude.replace(
        "- 만들거나 바꾼 화면을 이름과 경로로 답변에 남긴다.",
        "- 만들거나 바꾼 화면을 이름과 경로로 답변에 남긴다 — 개발자가 다듬은 문장.",
      ),
    });
    const outcome = await workspace.pull(() => undefined);
    assert.equal(outcome, "clean");

    const { applied } = await workspace.unshelve();
    assert.ok(applied.includes("CLAUDE.md"), "the shelved edit lands");

    const merged = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    assert.ok(merged.includes("치워둔 제목"), "the shelved work is back");
    assert.ok(
      merged.includes("개발자가 다듬은 문장"),
      "the developer's change is NOT rewound — 다시 얹기, not 되감기",
    );
    const after = await workspace.status();
    assert.equal(after.shelf, null, "a clean landing spends the slot");
    assert.ok(after.pendingChanges >= 1, "the work awaits 저장 again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("꺼내기: 진행 중인 변경 위에는 내려오지 않고, 슬롯은 지킨다", async () => {
  const dir = workdir("hub-unshelve-dirty-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const workspace = await bringUp(dir, fixture);

    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    writeFileSync(join(dir, "work", "CLAUDE.md"), `${claude}\n치워둘 한 줄\n`);
    await workspace.shelve();

    writeFileSync(join(dir, "work", "CLAUDE.md"), `${claude}\n새로 시작한 줄\n`);
    await assert.rejects(
      () => workspace.unshelve(),
      /지금 작업 중인 변경이 있습니다/,
      "the slot is not a second worktree",
    );
    const status = await workspace.status();
    assert.ok(status.shelf?.at, "the refusal keeps the slot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("꺼내기가 겹치면 Claude 의 과제가 되고, 치워둔 작업은 남는다", async () => {
  const dir = workdir("hub-unshelve-conflict-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const workspace = await bringUp(dir, fixture);

    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    writeFileSync(
      join(dir, "work", "CLAUDE.md"),
      claude.replace("# fixture colo-design 레포", "# 치워둔 제목"),
    );
    await workspace.shelve();

    // 개발자는 같은 줄을 다르게 반영했다 — 다시 얹을 수 없는 겹침.
    const seedClaude = readFileSync(join(fixture.seed, "CLAUDE.md"), "utf8");
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "CLAUDE.md": seedClaude.replace("# fixture colo-design 레포", "# 개발자의 제목"),
    });
    await workspace.pull(() => undefined);

    const briefs = [];
    await assert.rejects(
      () => workspace.unshelve((brief) => briefs.push(brief)),
      /치워둔 작업을 다시 얹다 겹치는 부분이 생겼습니다/,
      "the refusal names the shelf, not git",
    );
    assert.equal(briefs.length, 1, "the conflict is Claude's first task, not the planner's");
    assert.ok(briefs[0].includes("치워둔 작업 꺼내기"), "the brief's step is the button's name");
    assert.ok(
      readFileSync(join(dir, "work", "CLAUDE.md"), "utf8").includes("<<<<<<<"),
      "the overlap is in the worktree, exactly where Claude reads it",
    );
    const status = await workspace.status();
    assert.ok(status.shelf?.at, "the slot survives its own conflict");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("치워둔 작업은 재시작을 건너온다 — 첫 status 가 ref 를 읽는다", async () => {
  const dir = workdir("hub-shelf-restart-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({ dir: join(dir, "fixture"), port: await freePort() });
    const workspace = await bringUp(dir, fixture);

    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    writeFileSync(join(dir, "work", "CLAUDE.md"), `${claude}\n재시작을 건너올 한 줄\n`);
    await workspace.shelve();

    // 데몬 재시작: 같은 클론을 보는 새 인스턴스는 메모리를 하나도 물려받지
    // 않는다. 첫 status 가 ref 를 읽지 않으면 메뉴는 `잠깐 치워두기` 를
    // 내밀고(ref 를 보는 shelve 는 그걸 거절한다) `꺼내기` 는 사라진다 —
    // 치워둔 작업이 분실로 읽히는 그 자리.
    const restarted = clone(dir, fixture);
    const first = await restarted.status();
    assert.ok(first.shelf?.at, "the first status after a restart still sees the slot");

    const { applied } = await restarted.unshelve();
    assert.ok(applied.includes("CLAUDE.md"), `the parked work comes back: ${applied}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
