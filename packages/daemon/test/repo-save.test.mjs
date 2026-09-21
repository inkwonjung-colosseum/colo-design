/**
 * Comments and the save/draft turn — comments.json durability, fallback summaries, discard, and the Claude one-turn that writes save memos and handoff drafts.
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
import { ClaudeDriver } from "../dist/agent/drivers/claude/driver.js";
import { readComments, recordComments } from "../dist/comments.js";
import { RepoWorkspace, safeRepoPath } from "../dist/repo.js";
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
      { screen: "/member/MemberList", text: "첫 코멘트", elementText: "목록" },
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
        text: "다시 쓴 코멘트",
        elementText: "목록",
      },
      {
        screen: "/member/MemberList",
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

test("one pair's re-send never touches another screen's rows", () => {
  const file = join(workdir("hub-comments-pair-"), "comments.json");
  recordComments(file, [{ screen: "/member/MemberList", text: "회원", elementText: "목록" }]);
  recordComments(file, [{ screen: "/pay/PayFailed", text: "결제", elementText: "실패" }]);
  const rows = readComments(file);
  assert.equal(rows.length, 2, JSON.stringify(rows));
});

test("recordComments keeps the pin's element and normalizes the screen spelling", () => {
  const file = join(workdir("hub-comments-element-"), "comments.json");
  const element = {
    component: "button",
    path: "body > main > div > div > button:nth-of-type(1)",
    rect: { x: 40, y: 120, width: 96, height: 32 },
  };
  // The client may write route-shaped spellings; the store keeps the 경로
  // 신원 철자(앞 슬래시 없음), or the recorded pin would strand on every
  // screen.
  recordComments(file, [
    {
      screen: "/pay/PayFailed",
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
        // A legacy row: no element, still a comment. Its `state` key is the
        // demolished axis's leftover — ignored, and the row still reads.
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

/**
 * RepoWorkspace 의 기계 턴 — 담당 후보 드라이버(Claude)에 스텁 CLI 를
 * 물려 실제 oneShot 경로를 그대로 돈다. 서버가 machine-provider 로 잇는
 * 그 손을 테스트가 직접 쥐는 것뿐이다.
 */
const claudeMachineTurn = (executable) => {
  const driver = new ClaudeDriver(() => executable);
  return (prompt, opts) => driver.oneShot(prompt, opts);
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
      machineTurn: claudeMachineTurn(
        writeAnswerStubClaude(join(dir, "bin"), "회원 목록에 페이지 추가"),
      ),
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
    // bringUp carries no machineTurn — the memo turn cannot land.
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

    // 아무것도 저장할 게 없는 다시 저장은 조용한 no-op 성공이다 — 방금 원격에
    // 올라간 저장을 그대로 이름할 뿐이다. 실패로 보내면 방금 저장한 사람의
    // 화면에 "저장에 실패했어요" 가 깔리는 결함이었다 (2026-09-21 실사).
    const nothing = await workspace.save();
    assert.equal(nothing.stage, "published", nothing.detail ?? "");
    assert.equal(nothing.message, "회원 목록 화면 추가");
    const countAfterNothing = (
      await promisifiedRun("git", [
        "-C",
        join(dir, "work"),
        "rev-list",
        "--count",
        "origin/main..HEAD",
      ])
    ).trim();
    assert.equal(countAfterNothing, "1", "the no-op save did not add another commit");
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
      machineTurn: claudeMachineTurn(
        writeAnswerStubClaude(
          join(dir, "bin"),
          "회원 관리 화면 넘김\n\n목록과 빈 상태를 만들었습니다.\n빈 상태 문구를 봐 주세요.",
        ),
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
    assert.equal(draft.source, "machine");
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
    // bringUp carries no machineTurn — the draft turn cannot land.
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
    // 저장이 끝난 사이클이라 `### 바뀐 파일` 은 있다: 절이 곧 본문에 간다.
    assert.equal(draft.extras?.commentsSection, null);
    assert.equal(draft.extras?.shotCount, 0);
    assert.match(draft.extras?.filesSection ?? "", /### 바뀐 파일/);
    assert.match(draft.extras?.filesSection ?? "", /index\.html/);
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
      { screen: "/member/MemberList", text: "제목을 줄여", elementText: "목록" },
    ]);

    const draft = await workspace.handoffDraft({
      commentsFile,
      shotCount: 3,
    });

    // 미리보기가 보여 주는 절은 넘기기가 실제로 붙이는 절과 같은 문장이다 —
    // 핀이 가리킨 화면 id 로, 사용자의 말 그대로.
    assert.ok(draft.extras, "자동 첨부가 보고되지 않았다");
    assert.match(draft.extras.commentsSection ?? "", /### 수정 요청/);
    assert.match(draft.extras.commentsSection ?? "", /- member\/MemberList — "제목을 줄여"/);
    // 같은 규칙의 새 절: 사이클 브랜치의 numstat 이 미리보기에 그대로 온다.
    assert.match(draft.extras.filesSection ?? "", /### 바뀐 파일/);
    assert.match(draft.extras.filesSection ?? "", /index\.html/);
    assert.equal(draft.extras.shotCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildCommentsSection: 사이클 행·20건 넘김", async () => {
  const { buildCommentsSection } = await import("../dist/repo.js");
  const rows = [
    {
      screen: "member/MemberList",
      text: "제목을 줄여",
      at: "2026-09-11T09:00:00.000Z",
    },
    {
      screen: "pay/PayFailed",
      text: "문구를 다시",
      at: "2026-09-11T09:05:00.000Z",
    },
    // 이전 사이클(브랜치 이전)의 항목은 절에 들지 않는다.
    { screen: "pay/PayFailed", text: "옛것", at: "2026-09-10T09:00:00.000Z" },
  ];
  const section = buildCommentsSection(rows, "2026-09-11T00:00:00Z");
  assert.ok(section.includes("### 수정 요청"));
  assert.ok(section.includes('- member/MemberList — "제목을 줄여"'), section);
  assert.ok(section.includes('- pay/PayFailed — "문구를 다시"'), "핀이 가리킨 화면 id 로 남는다");
  assert.ok(!section.includes("옛것"), "브랜치 이전 항목은 제외");
  assert.ok(!section.includes(".css"), "파일 경로는 섞지 않는다");

  const overflow = buildCommentsSection(
    Array.from({ length: 25 }, (_, index) => ({
      screen: "s",
      text: `코멘트 ${index + 1}`,
      at: `2026-09-11T10:${String(index).padStart(2, "0")}:00.000Z`,
    })),
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
