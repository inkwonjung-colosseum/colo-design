/**
 * Comments, checkpoints and the save/draft turn — comments.json durability, fallback summaries, discard, and the Claude one-turn that writes save memos and handoff drafts.
 *
 * Split out of repo.test.mjs — the bodies are verbatim; shared scaffolding
 * (workdir · repoRoot · clone · bringUp · promisifiedRun · stub client) lives
 * in ./repo-test-kit.mjs.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readComments, recordComments } from "../dist/comments.js";
import { fallbackSummary, RepoWorkspace, restorePlan, safeRepoPath } from "../dist/repo.js";
import { createFixtureRepo, freePort, pushFixtureChange } from "./fixture-repo.mjs";
import { bringUp, promisifiedRun, workdir } from "./repo-test-kit.mjs";

// ---------------------------------------------------------------------------
// 코멘트 저장소
// ---------------------------------------------------------------------------

test("comments.record appends delivered rows — a second send of the same words stays", () => {
  const dir = workdir("hub-comments-");
  const file = join(dir, "comments.json");
  try {
    recordComments(file, [
      { screen: "/member/MemberList", state: "default", text: "첫 코멘트", elementText: "목록" },
    ]);
    // 자동 정리: delivery is the row's birth — every row lands resolved,
    // because the turn carrying the words IS the delivery.
    let rows = readComments(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].resolved, true, "the row is born delivered");
    assert.equal(rows[0].screen, "member/MemberList", "no leading slash");

    // The store is an append-only log of what went to Claude: a reworded
    // second send is a second request, and both stay.
    recordComments(file, [
      {
        screen: "/member/MemberList",
        state: "default",
        text: "다시 쓴 코멘트",
        elementText: "목록",
      },
      {
        screen: "/member/MemberList",
        state: "default",
        text: "하나 더",
        elementText: "페이지 제목",
      },
    ]);
    rows = readComments(file);
    assert.equal(rows.length, 3, "a second send of the same pair appends, never replaces");
    assert.equal(new Set(rows.map((row) => row.id)).size, 3, "each written row carries its own id");
    assert.ok(
      rows.some((row) => row.text === "첫 코멘트"),
      "the first request is still history",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one pair's re-send never touches another screen·state's rows", () => {
  const file = join(workdir("hub-comments-pair-"), "comments.json");
  recordComments(file, [
    { screen: "/member/MemberList", state: "default", text: "회원", elementText: "목록" },
  ]);
  recordComments(file, [
    { screen: "/pay/PayFailed", state: "error", text: "결제", elementText: "실패" },
  ]);
  const rows = readComments(file);
  assert.equal(rows.length, 2, JSON.stringify(rows));
});

test("recordComments keeps the pin's element and normalizes the screen spelling", () => {
  const file = join(workdir("hub-comments-element-"), "comments.json");
  const element = {
    component: "button",
    path: 'div[data-screen="pay/PayFailed"] > div > button:nth-of-type(1)',
    rect: { x: 40, y: 120, width: 96, height: 32 },
  };
  // The fixture once wrote route-shaped spellings; the store keeps the
  // `[data-screen]` one, or the recorded pin would strand on every screen.
  recordComments(file, [
    {
      screen: "/pay/PayFailed",
      state: "error",
      text: "고쳐 주세요",
      elementText: "다시 시도",
      element,
    },
  ]);
  const rows = readComments(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].screen, "pay/PayFailed", "no leading slash");
  assert.deepEqual(rows[0].element, element, "the anchor rides the row verbatim");
  // The recorded list is what the overlay draws from: element in, element out.
  assert.equal(rows[0].elementText, "다시 시도");
});

test("an old row without element survives; a broken element row is dropped", () => {
  const dir = workdir("hub-comments-legacy-");
  const file = join(dir, "comments.json");
  try {
    writeFileSync(
      file,
      JSON.stringify([
        // A legacy row: no element, still a comment.
        {
          id: "old",
          screen: "pay/PayFailed",
          state: "error",
          text: "옛 코멘트",
          elementText: "제목",
          at: "2026-09-01T00:00:00Z",
          resolved: false,
        },
        // A row whose element is half there would anchor a pin on a half
        // identity — dropped rather than drawn.
        {
          id: "broken",
          screen: "pay/PayFailed",
          state: "error",
          text: "깨진 위치",
          elementText: "제목",
          element: { component: "div" },
          at: "2026-09-02T00:00:00Z",
          resolved: false,
        },
      ]),
    );
    const rows = readComments(file);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["old"],
      JSON.stringify(rows),
    );
    assert.equal(rows[0].element, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
        {
          id: "1",
          screen: "s",
          state: "t",
          text: "x",
          elementText: "y",
          at: "2026-09-11T00:00:00Z",
          resolved: false,
        },
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
// 되돌리기와 요약 — offline: the fallback path and the
// snapshot mechanics. The summarizer's Claude turn is test:daemon's stub case.
// ---------------------------------------------------------------------------

test("폴백 요약은 바뀐 종류별로 파일 이름을 묶어 쓴다", () => {
  // 폴더 이름은 레포의 전문어다 — 기획자가 가리킬 수 있는 것은 파일의 이름.
  const lines = fallbackSummary([
    { path: "src/screens/member/MemberList.screen.tsx", status: "modified" },
    { path: "src/screens/member/PayFailed.screen.tsx", status: "added" },
    { path: "src/screens/pay/Pay.screen.tsx", status: "modified" },
    { path: "index.html", status: "modified" },
    { path: "src/screens/old/Old.screen.tsx", status: "deleted" },
  ]);
  assert.deepEqual(lines, [
    "새로 만든 파일 1개: PayFailed.screen.tsx",
    "고친 파일 3개: MemberList.screen.tsx, Pay.screen.tsx, index.html",
    "지운 파일 1개: Old.screen.tsx",
  ]);

  // 이름이 넷을 넘으면 나열을 접고 `외 N개` 로 센다.
  const many = fallbackSummary([
    { path: "a/1.tsx", status: "modified" },
    { path: "a/2.tsx", status: "modified" },
    { path: "a/3.tsx", status: "modified" },
    { path: "a/4.tsx", status: "modified" },
  ]);
  assert.deepEqual(many, ["고친 파일 4개: 1.tsx, 2.tsx, 3.tsx 외 1개"]);
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
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
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
    writeFileSync(
      join(work, "src", "screens", "new", "New.screen.tsx"),
      "export const New = () => null;\n",
    );

    const headBefore = (await git(["rev-parse", "HEAD"])).trim();
    const checkpoint = await workspace.checkpoint("session-a", 1);
    assert.equal(checkpoint.id, "session-a/1");
    assert.equal(checkpoint.sessionId, "session-a");
    assert.equal(checkpoint.turn, 1);
    assert.ok(checkpoint.at !== "", "the snapshot is dated");

    assert.equal((await git(["rev-parse", "HEAD"])).trim(), headBefore, "HEAD never moved");
    const status = await git(["status", "--porcelain"]);
    assert.match(status, /^M {2}index\.html/m, "the real index kept its staged edit");
    // git collapses a fully-untracked directory to `?? src/`; the invariant
    // is that the real index never absorbed the new screen.
    assert.match(status, /^\?\? src\//m, "the new screen stayed untracked");
    assert.equal(
      (await git(["ls-files", "src/screens/new/New.screen.tsx"])).trim(),
      "",
      "the real index never absorbed the new screen",
    );

    // `stash create` could not have done this: the snapshot holds the file
    // too, which is the whole point for a first screen before its first 저장.
    const tree = await git([
      "ls-tree",
      "-r",
      "--name-only",
      "refs/colo-design/checkpoints/session-a/1",
    ]);
    assert.match(
      tree,
      /src\/screens\/new\/New\.screen\.tsx/,
      "the snapshot holds the untracked screen",
    );
    assert.match(tree, /index\.html/, "and the tracked file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("변경 버리기는 미추적 화면 폴더째 지우고 죽지 않는다", async () => {
  const dir = workdir("hub-discard-dir-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    // A repo that already tracks a screen — the shape every real connection
    // has. Without it porcelain folds the whole empty `src/` tree into one
    // `?? src/` row and the new-folder scenario never appears.
    await pushFixtureChange(fixture.seed, fixture.remote, {
      "src/screens/existing/Existing.screen.tsx": "export const Existing = () => null;\n",
    });
    const workspace = await bringUp(dir, fixture);
    assert.ok(
      existsSync(join(dir, "work", "src", "screens", "existing", "Existing.screen.tsx")),
      "the tracked screen is here",
    );

    // Claude 의 가장 흔한 자국: 통째로 새로 생긴 화면 폴더. porcelain 은
    // 이것을 `src/screens/brandnew/` 한 줄로 접어 내보내고, 버리기가 그
    // 경로를 파일인 양 rmSync 하면 EISDIR 로 죽는다 — 부분 복구 상태로.
    mkdirSync(join(dir, "work", "src", "screens", "brandnew"), { recursive: true });
    writeFileSync(
      join(dir, "work", "src", "screens", "brandnew", "BrandNew.screen.tsx"),
      "export const BrandNew = () => null;\n",
    );
    const claude = readFileSync(join(dir, "work", "CLAUDE.md"), "utf8");
    writeFileSync(join(dir, "work", "CLAUDE.md"), `${claude}\n임시 수정\n`);

    const discarded = await workspace.discard();
    assert.ok(
      discarded.removed.some((path) => path.includes("brandnew")),
      "the folded folder row is in the removal list",
    );
    assert.ok(
      !existsSync(join(dir, "work", "src", "screens", "brandnew")),
      "the untracked folder is gone whole",
    );
    assert.ok(
      existsSync(join(dir, "work", "src", "screens", "existing", "Existing.screen.tsx")),
      "the tracked screen is untouched — only the untracked folder row was removed",
    );
    assert.equal(
      readFileSync(join(dir, "work", "CLAUDE.md"), "utf8"),
      claude,
      "the tracked edit is back at HEAD",
    );
    const status = await workspace.status();
    assert.equal(status.pendingChanges, 0, "nothing is left to save");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarize without a Claude path falls back to file-name grouping — once per diff", async () => {
  const dir = workdir("hub-summarize-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    // No claudeExecutable option: the fallback is the only path.
    const workspace = await bringUp(dir, fixture);

    const html = readFileSync(join(dir, "work", "index.html"), "utf8");
    writeFileSync(join(dir, "work", "index.html"), `${html}<p>회원 목록 줄</p>\n`);
    mkdirSync(join(dir, "work", "src", "screens", "member"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, "work", "src", "screens", "member", "PayFailed.screen.tsx"),
      "export const PayFailed = () => null;\n",
    );

    const summary = await workspace.summarize();
    assert.equal(summary.source, "fallback");
    assert.deepEqual(summary.lines, [
      "새로 만든 파일 1개: PayFailed.screen.tsx",
      "고친 파일 1개: index.html",
    ]);

    // Same diff, same answer — from the one-entry cache, without another look.
    const again = await workspace.summarize();
    assert.deepEqual(again, summary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
/**
 * 비개발자 저장·넘기기의 한 턴: RepoWorkspace 의 기계 턴이 닿는 목 — 빈
 * 메모의 저장도, 넘기기의 초안도 같은 한 턴이라 답만 갈아 끼우면 된다.
 */
const writeAnswerStubClaude = (stubDir, answer) => {
  mkdirSync(stubDir, { recursive: true });
  const path = join(stubDir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'if (process.argv[2] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      `const answer = ${JSON.stringify(answer)};`,
      "let buf = '';",
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "const seen = () => {",
      "  let idx;",
      "  while ((idx = buf.indexOf('\\n')) !== -1) {",
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      "    let o = null; try { o = JSON.parse(line); } catch { continue; }",
      "    if (o.type === 'control_request') {",
      "      send({ type: 'control_response', response: { subtype: 'success',",
      "        request_id: String(o.request_id), response: {} } });",
      "      continue;",
      "    }",
      "    if (o.type === 'user') {",
      "      setTimeout(() => send({ type: 'result', subtype: 'success', is_error: false,",
      "        session_id: 'stub', result: answer, num_turns: 1,",
      "        duration_ms: 5 }), 20);",
      "    }",
      "  }",
      "};",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { buf += chunk; seen(); });",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
};

/** The cycle branch's own subject, read straight off the bare remote. */
const remoteSubject = async (remote) => {
  const branch = (
    await promisifiedRun("git", [
      "--git-dir",
      remote,
      "for-each-ref",
      "refs/heads/colo-design/*",
      "--format=%(refname:short)",
    ])
  )
    .split(/\r?\n/)
    .filter(Boolean)[0];
  return (
    await promisifiedRun("git", ["--git-dir", remote, "log", "-1", "--pretty=%s", branch])
  ).trim();
};

test("빈 메모의 저장은 Claude가 쓴 한 문장을 저장 메모로 커밋한다", async () => {
  const dir = workdir("hub-memo-claude-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      onStatus: () => undefined,
      claudeExecutable: writeAnswerStubClaude(join(dir, "bin"), "회원 목록에 페이지 추가"),
    });
    await workspace.sync();
    await workspace.stop();

    writeFileSync(join(dir, "work", "index.html"), "<p>빈 메모의 저장</p>\n");
    // No memo, no session — the button alone (비개발자 저장).
    const saved = await workspace.save();
    assert.equal(saved.stage, "published", saved.detail ?? "");
    assert.equal(saved.message, "회원 목록에 페이지 추가");
    assert.equal(await remoteSubject(fixture.remote), "회원 목록에 페이지 추가");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("빈 메모의 저장은 Claude가 못 내면 기본 문구로 저장한다", async () => {
  const dir = workdir("hub-memo-default-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    // bringUp carries no claudeExecutable — the memo turn cannot land.
    const workspace = await bringUp(dir, fixture);

    writeFileSync(join(dir, "work", "index.html"), "<p>기본 문구의 저장</p>\n");
    const saved = await workspace.save();
    assert.equal(saved.stage, "published", saved.detail ?? "");
    assert.equal(saved.message, "Colo Design 화면 변경");
    assert.equal(await remoteSubject(fixture.remote), "Colo Design 화면 변경");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("올리기에서 멈춘 저장은 다시 누르면 올리기만 다시 한다 — 묶은 작업이 갇히지 않는다", async () => {
  const dir = workdir("hub-push-retry-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);

    writeFileSync(join(dir, "work", "index.html"), "<p>올리기 실패</p>\n");
    // 원격이 사라진 순간의 저장: 커밋은 끝나고 푸시가 거절된다.
    const away = `${fixture.remote}.away`;
    renameSync(fixture.remote, away);
    const failed = await workspace.save({ message: "회원 목록 화면 추가" });
    assert.equal(failed.stage, "failed");
    assert.equal(failed.gate, "push", failed.detail ?? "");
    // 커밋은 남았으므로 워크트리는 깨끗하다 — 이 상태가 예전에는 "저장할
    // 변경사항이 없습니다" 로 읽혀 묶은 작업이 갇혔다.
    assert.equal((await workspace.diff()).length, 0, "the commit landed, so the diff is empty");

    renameSync(away, fixture.remote);
    const retried = await workspace.save();
    assert.equal(retried.stage, "published", retried.detail ?? "");
    // 재시도는 새 커밋을 쓰지 않는다: 멈춘 저장의 메모가 그대로 실려 간다.
    assert.equal(retried.message, "회원 목록 화면 추가");
    assert.equal(await remoteSubject(fixture.remote), "회원 목록 화면 추가");
    const count = (
      await promisifiedRun("git", [
        "-C",
        join(dir, "work"),
        "rev-list",
        "--count",
        "origin/main..HEAD",
      ])
    ).trim();
    assert.equal(count, "1", "the retry pushed the one commit, it did not add another");

    // 올릴 것도 저장할 것도 없으면 예전 그대로 거절한다.
    const nothing = await workspace.save();
    assert.equal(nothing.stage, "failed");
    assert.match(nothing.detail ?? "", /저장할 변경사항이 없습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("저장 검토의 요약은 같은 턴에서 저장 메모 제안까지 받아 온다", async () => {
  const dir = workdir("hub-summary-memo-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      onStatus: () => undefined,
      claudeExecutable: writeAnswerStubClaude(
        join(dir, "bin"),
        // 목록 표식과 따옴표는 답변의 장식이다 — 요약도 메모도 그것 없이 선다.
        '- 회원 목록 화면에 검색창을 넣었습니다\n- 빈 상태 문구를 바꿨습니다\n메모: "회원 목록 검색 추가"',
      ),
    });
    await workspace.sync();
    await workspace.stop();

    writeFileSync(join(dir, "work", "index.html"), "<p>검색창</p>\n");
    const summary = await workspace.summarize([
      { route: "/member/MemberList", title: "회원 목록" },
    ]);
    assert.equal(summary.source, "claude");
    assert.deepEqual(summary.lines, [
      "회원 목록 화면에 검색창을 넣었습니다",
      "빈 상태 문구를 바꿨습니다",
    ]);
    // 메모 줄은 요약에 섞이지 않고 제안으로 따로 선다 — 검토 화면의 메모
    // 칸이 이것으로 열린다 (비개발자 저장 검토).
    assert.equal(summary.memo, "회원 목록 검색 추가");

    // 같은 diff·같은 화면 목록이면 같은 답 — 메모까지 캐시에서 온다.
    assert.deepEqual(
      await workspace.summarize([{ route: "/member/MemberList", title: "회원 목록" }]),
      summary,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("넘기기의 초안은 이 사이클의 저장 메모에서 제목과 내용을 받아 온다", async () => {
  const dir = workdir("hub-handoff-draft-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = new RepoWorkspace({
      root: join(dir, "work"),
      url: fixture.remote,
      onStatus: () => undefined,
      claudeExecutable: writeAnswerStubClaude(
        join(dir, "bin"),
        "회원 관리 화면 넘김\n\n목록과 빈 상태를 만들었습니다.\n빈 상태 문구를 봐 주세요.",
      ),
    });
    await workspace.sync();
    await workspace.stop();

    // 저장 전에는 넘길 사이클이 없다 — 초안도 없다.
    assert.deepEqual(await workspace.handoffDraft(), {
      title: "",
      body: "",
      source: "fallback",
    });

    writeFileSync(join(dir, "work", "index.html"), "<p>회원 목록</p>\n");
    const saved = await workspace.save({ message: "회원 목록 화면 추가" });
    assert.equal(saved.stage, "published", saved.detail ?? "");

    const draft = await workspace.handoffDraft();
    assert.equal(draft.source, "claude");
    // 첫 줄은 제목, 나머지는 개발자가 읽을 내용 — 두 쪽이 섞이지 않는다.
    assert.equal(draft.title, "회원 관리 화면 넘김");
    assert.equal(draft.body, "목록과 빈 상태를 만들었습니다.\n빈 상태 문구를 봐 주세요.");

    // 사이클이 그대로면 같은 답 — 다시 열어도 턴을 또 쓰지 않는다.
    assert.deepEqual(await workspace.handoffDraft(), draft);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("넘기기의 초안은 Claude가 못 내면 비어 있어 브라우저의 제안이 남는다", async () => {
  const dir = workdir("hub-handoff-draft-none-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    // bringUp carries no claudeExecutable — the draft turn cannot land.
    const workspace = await bringUp(dir, fixture);

    writeFileSync(join(dir, "work", "index.html"), "<p>초안 없는 넘기기</p>\n");
    const saved = await workspace.save({ message: "초안 없는 저장" });
    assert.equal(saved.stage, "published", saved.detail ?? "");

    // 빈 제목·빈 내용이 계약이다 — 그래야 대화창이 제 제안을 그대로 쓴다.
    const draft = await workspace.handoffDraft();
    assert.equal(draft.title, "");
    assert.equal(draft.body, "");
    assert.equal(draft.source, "fallback");
    // 자동 첨부는 초안과 무관하게 답한다 — 핀도 캡처도 없으면 없다고 말한다.
    assert.deepEqual(draft.extras, { commentsSection: null, shotCount: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("넘기기의 미리보기는 개발자가 받을 자동 첨부를 그대로 보고한다 (비개발자 넘기기)", async () => {
  const dir = workdir("hub-handoff-draft-extras-");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
  try {
    const fixture = await createFixtureRepo({
      dir: join(dir, "fixture"),
      port: await freePort(),
    });
    const workspace = await bringUp(dir, fixture);

    writeFileSync(join(dir, "work", "index.html"), "<p>회원 목록</p>\n");
    const saved = await workspace.save({ message: "회원 목록 화면 추가" });
    assert.equal(saved.stage, "published", saved.detail ?? "");

    // 사이클이 열린 뒤에 찍은 핀 — 넘기기 본문의 `### 수정 요청` 이 될 것.
    const commentsFile = join(dir, "comments.json");
    recordComments(commentsFile, [
      { screen: "/member/MemberList", state: "default", text: "제목을 줄여", elementText: "목록" },
    ]);

    const draft = await workspace.handoffDraft({
      commentsFile,
      screenTitles: [{ route: "/member/MemberList", title: "회원 목록" }],
      shotCount: 3,
    });

    // 미리보기가 보여 주는 절은 넘기기가 실제로 붙이는 절과 같은 문장이다 —
    // 선언된 제목으로, 사용자의 말 그대로.
    assert.ok(draft.extras, "자동 첨부가 보고되지 않았다");
    assert.match(draft.extras.commentsSection ?? "", /### 수정 요청/);
    assert.match(draft.extras.commentsSection ?? "", /- 회원 목록 · 기본 — "제목을 줄여"/);
    assert.equal(draft.extras.shotCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildCommentsSection: 선언된 제목·20건 넘김", async () => {
  const { buildCommentsSection } = await import("../dist/repo.js");
  const rows = [
    {
      screen: "member/MemberList",
      state: "default",
      text: "제목을 줄여",
      at: "2026-09-11T09:00:00.000Z",
    },
    {
      screen: "pay/PayFailed",
      state: "error",
      text: "문구를 다시",
      at: "2026-09-11T09:05:00.000Z",
    },
    // 이전 사이클(브랜치 이전)의 항목은 절에 들지 않는다.
    { screen: "pay/PayFailed", state: "error", text: "옛것", at: "2026-09-10T09:00:00.000Z" },
  ];
  const section = buildCommentsSection(
    rows,
    (screen) => (screen === "member/MemberList" ? "회원 목록" : null),
    "2026-09-11T00:00:00Z",
  );
  assert.ok(section.includes("### 수정 요청"));
  assert.ok(section.includes('- 회원 목록 · 기본 — "제목을 줄여"'), section);
  assert.ok(
    section.includes('- pay/PayFailed · 오류 — "문구를 다시"'),
    "선언 없는 화면은 id 로 남는다",
  );
  assert.ok(!section.includes("옛것"), "브랜치 이전 항목은 제외");
  assert.ok(
    !section.includes("data-component") && !section.includes(".css"),
    "경로·컴포넌트명은 쓰지 않는다",
  );

  const overflow = buildCommentsSection(
    Array.from({ length: 25 }, (_, index) => ({
      screen: "s",
      state: "default",
      text: `코멘트 ${index + 1}`,
      at: `2026-09-11T10:${String(index).padStart(2, "0")}:00.000Z`,
    })),
    () => null,
    "2026-09-11T00:00:00Z",
  );
  assert.ok(overflow.includes("외 5건"), overflow.slice(-120));
});

test("PUSH_AUTH_FAILURE: 인증·권한 사유만 골라내고 나머지는 Claude 로", async () => {
  const { PUSH_AUTH_FAILURE } = await import("../dist/repo.js");
  for (const reason of [
    "remote: 403 denied to install-token",
    "Permission denied (publickey)",
    "Authentication failed",
    "403 not authorized",
  ]) {
    assert.ok(PUSH_AUTH_FAILURE.test(reason), reason);
  }
  for (const reason of [
    "! [rejected] main -> main (non-fast-forward)",
    "failed to push some refs",
    "Could not resolve host",
  ]) {
    assert.ok(!PUSH_AUTH_FAILURE.test(reason), reason);
  }
});
