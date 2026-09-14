/**
 * Publish-path end-to-end check, offline: the remote is a local bare git
 * repository (fixture-repo.mjs). The repo's `check`/`build` commands never
 * gate the path anymore — a save with a failing check on disk still lands,
 * and a handoff with a failing build still opens the pull request (실사:
 * problems are the developer's to catch in the PR, not a wall here).
 *
 * Covers the whole path: diff.get lists tracked and untracked changes; a
 * failing check does not stop the save and never runs; a push that cannot
 * reach the remote reports failed{gate:"push"} without moving the remote and
 * hands the failure to the live session as a marked card — with no thread
 * open the daemon opens one itself; after the fix the commits land on the
 * remote; a publish with nothing to commit is rejected. From PLAN D51–D53
 * on: `repo.history` reads the saves, `repo.restore` lands a 되돌리기 commit
 * instead of rewriting, a dirty worktree refuses it, `repo.discard` throws
 * away exactly the unsaved work, and two turn starts leave two checkpoint
 * refs — the first of which puts the worktree back — until the merge clears
 * them all. The session is real (it is the same wire a typed message uses)
 * but is closed the moment its failure turn is observed, so no model turn is
 * spent.
 *
 * Usage: node packages/daemon/test/publish-e2e.mjs
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { readTurn } from "../../protocol/dist/index.js";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const run = promisify(execFile);

const DIR = join(tmpdir(), "colo-design-publish-e2e");
const ROOT = join(DIR, "work");

// The session and the PAT store must never touch the real home during the run,
// and neither may the project registry: on the default path the daemon writes
// ~/colo-design/config/projects.json, and the next run would start from this
// run's project — a repo url pointing at a fixture remote that no longer exists.
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_DESIGN_REPO_SETTINGS = join(DIR, "settings.json");
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
// The handoff half talks to GitHub. The remote here is a local bare
// repository, so nothing in its url could name a GitHub project — the slug is
// pinned, and the REST calls replay recorded pairs in order.
process.env.COLO_DESIGN_GITHUB_FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures",
  "github",
  "handoff",
);
process.env.COLO_DESIGN_GITHUB_SLUG = "colosseumcoinckr/colo-design-e2e";
process.env.COLO_DESIGN_REPO_PAT = "ghp_handoff_e2e";

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await predicate();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function remoteHead(remote, ref = "main") {
  const { stdout } = await run("git", ["--git-dir", remote, "rev-parse", ref]);
  return stdout.trim();
}

/** Branches the bare remote holds, so a save's own branch can be seen arriving. */
async function remoteBranches(remote) {
  const { stdout } = await run("git", [
    "--git-dir",
    remote,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

const FAILING_CHECK = `console.error("check: 테스트용 실패 — src/screens 규칙 위반");
process.exit(1);
`;
const PASSING_CHECK = `console.log("check: 통과");
`;

/**
 * The CLI this suite's sessions speak to. The daemon resolves its Claude
 * executable from COLO_DESIGN_CLAUDE_BIN first — pinned here so the suite is
 * the same machine-independent check everywhere: a dev box with a real CLI
 * installed must not quietly exercise the real one (that was the only reason
 * this suite ever passed locally — CI, with no CLI at all, died at
 * session.create). Every user line gets a plain result and the process stays
 * up: the checkpoint section sends a second turn through the SAME session.
 */
function stubClaude(dir) {
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (args[0] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
      "  process.exit(0);",
      "}",
      'let buf = "";',
      "const seen = () => {",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      '    if (line.includes(\'"subtype":"interrupt"\') || line.includes(\'"subtype":"set_permission_mode"\')) {',
      '      const id = (line.match(/"request_id":"([^"]*)"/) || [])[1];',
      "      process.stdout.write(JSON.stringify({",
      '        type: "control_response",',
      '        response: { subtype: "success", request_id: id },',
      '      }) + "\\n");',
      "      continue;",
      "    }",
      '    if (line.includes(\'"type":"user"\')) {',
      '      const sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || "stub";',
      "      // A real CLI answers in model time; the suite closes the failing-check",
      "      // session the moment its turn is OBSERVED, before any answer could",
      "      // exist. An instant stub result would finish that turn first and fire",
      "      // the planner's done notice the close contract forbids — so the answer",
      "      // waits a beat the suite never gives it.",
      "      setTimeout(() => {",
      "        process.stdout.write(JSON.stringify({",
      '          type: "result", subtype: "success", is_error: false,',
      '          session_id: sessionId, result: "알겠습니다.", num_turns: 1, duration_ms: 10,',
      '        }) + "\\n");',
      "      }, 1000);",
      "    }",
      "  }",
      "};",
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { buf += chunk; seen(); });',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  process.env.COLO_DESIGN_CLAUDE_BIN = stubClaude(join(DIR, "claude-config"));
  const port = await freePort();
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port });
  const remoteBefore = await remoteHead(fixture.remote);

  process.env.COLO_DESIGN_REPO_DIR = ROOT;
  process.env.COLO_DESIGN_REPO_URL = fixture.remote;
  const daemonPort = await freePort();
  const notices = [];
  const server = new DaemonServer({
    host: "127.0.0.1",
    port: daemonPort,
    token: "publish-e2e",
    // The desktop app paints these as OS notifications; the test reads the
    // meaning straight off the hook.
    onNotice: (notice) => notices.push(notice),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}?token=publish-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const request = async (message, timeoutMs = 120_000) => {
    ws.send(JSON.stringify(message));
    const reply = await waitFor(
      () => inbox.find((m) => m.id === message.id),
      timeoutMs,
      message.type,
    );
    if (reply.type !== "ok") throw new Error(`${message.type} failed: ${reply.message}`);
    return reply.data;
  };

  try {
    // --- 1. the clone exists before there is anything to review ------------
    const ready = await request({ id: "1", type: "repo.sync" });
    check("the fixture repo clones", ready.phase === "ready", ready.detail ?? "");
    const remoteAfterClone = await remoteHead(fixture.remote);
    check("a clone alone moves no remote ref", remoteAfterClone === remoteBefore);

    // --- 2. changes on disk show up in diff.get ---------------------------
    mkdirSync(join(ROOT, "src", "screens", "member"), { recursive: true });
    writeFileSync(
      join(ROOT, "src", "screens", "member", "MemberList.screen.tsx"),
      "export default function MemberListScreen() { return null; }\n",
    );
    const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
    writeFileSync(join(ROOT, "index.html"), `${indexHtml}<p>회원 관리 목록 추가</p>\n`);

    const files = await request({ id: "2", type: "diff.get" });
    const byPath = new Map(files.map((file) => [file.path, file]));
    const screen = byPath.get("src/screens/member/MemberList.screen.tsx");
    check(
      "an untracked new file is listed as added with content hunks",
      screen?.status === "added" && screen.hunks[0]?.lines[0]?.includes("MemberListScreen"),
      `${screen?.status ?? "missing"} · ${screen?.hunks[0]?.lines.length ?? 0} line(s)`,
    );
    const page = byPath.get("index.html");
    check(
      "a tracked edit is listed as modified with its hunk",
      page?.status === "modified" &&
        page.hunks.some((hunk) => hunk.lines.some((line) => line.includes("회원 관리 목록 추가"))),
      `${page?.status ?? "missing"} · ${page?.hunks.length ?? 0} hunk(s)`,
    );

    // --- 3. the repo's check does not gate the save ------------------------
    // 실패하는 check 를 두고도 저장은 그대로 올라간다 — 검사는 아예 돌지 않고,
    // 문제는 넘기기가 연 PR 에서 개발자가 본다 (실사: 검사에서 멈춘 저장).
    writeFileSync(join(ROOT, "scripts", "check.mjs"), FAILING_CHECK);
    const created = await request({ id: "3", type: "session.create" });
    const sessionId = created.sessionId;

    const saved = await request({
      id: "4",
      type: "repo.save",
      message: "회원 관리 화면 추가",
      sessionId,
    });
    check(
      "a failing check no longer stops the save",
      saved.stage === "published" && /^[0-9a-f]{40}$/.test(saved.commit ?? ""),
      saved.commit ?? `${saved.stage}/${saved.gate ?? ""}`,
    );
    check(
      "the check never ran — its output is nowhere in the status",
      !(saved.detail ?? "").includes("테스트용 실패"),
      saved.detail ?? "",
    );
    check(
      "no gating stage is ever broadcast",
      !inbox.some((m) => m.type === "diff.status" && m.status.stage === "gating"),
    );

    // The whole point of PLAN D5[넘기기]: a developer receives this as a branch
    // to review, and the base they work on is untouched until they merge it.
    const branches = await remoteBranches(fixture.remote);
    const cycleBranch = branches.find((name) => name.startsWith("colo-design/"));
    check(
      "the save created its own branch on the remote",
      cycleBranch !== undefined && /^colo-design\/\d{8}-\d+$/.test(cycleBranch),
      branches.join(", "),
    );
    check(
      "the commit is on that branch",
      cycleBranch !== undefined && (await remoteHead(fixture.remote, cycleBranch)) === saved.commit,
    );
    check(
      "main did not move — the developer's base is untouched",
      (await remoteHead(fixture.remote)) === remoteBefore,
      remoteBefore.slice(0, 10),
    );

    // --- 3b. a push that cannot reach the remote reaches Claude instead ----
    // The failure machinery survives the check's removal: break the remote,
    // save, and the failure lands in the live session as a marked card the
    // planner reads instead of git's words.
    await run("git", ["-C", ROOT, "remote", "set-url", "origin", join(DIR, "nowhere")]);
    writeFileSync(join(ROOT, "index.html"), "<p>올리기 점검</p>\n");
    const pushFailed = await request({
      id: "4b",
      type: "repo.save",
      message: "올리기 점검",
      sessionId,
    });
    check(
      "an unreachable remote fails the save at the push gate",
      pushFailed.stage === "failed" && pushFailed.gate === "push",
      `${pushFailed.stage}/${pushFailed.gate ?? ""}`,
    );
    check(
      "the remote branches stand where the good save left them",
      JSON.stringify(await remoteBranches(fixture.remote)) === JSON.stringify(branches),
    );
    const brief = await waitFor(
      () =>
        inbox.find(
          (m) =>
            m.type === "session.event" &&
            m.sessionId === sessionId &&
            m.event.kind === "user.echo" &&
            m.event.text.includes("저장한 변경을 올리지 못했습니다"),
        ),
      30_000,
      "the failure turn in the live session",
    );
    check(
      "the failure lands in the session as a fixable brief",
      brief.event.text.includes("git push에 실패했습니다"),
      `${brief.event.text.split("\n").slice(0, 2).join(" ")}…`,
    );
    // The planner reads a card, not the command output (PLAN D9). The marker
    // is what the transcript turns into one, and it names the step by the
    // button that was pressed rather than by the gate that ran.
    const marked = readTurn(brief.event.text);
    check(
      "and it is marked so the planner sees a card instead of the output",
      marked.marker?.kind === "gate" && marked.marker.step === "저장한 내용 올리기",
      JSON.stringify(marked.marker),
    );
    check(
      "the marker does not disturb what Claude reads",
      marked.body.startsWith("저장한 변경을 올리지 못했습니다.") &&
        marked.body.includes("git push에 실패했습니다"),
      marked.body.split("\n")[0] ?? "",
    );
    check(
      "the gate failure fired the planner notice for the named thread",
      notices.some(
        (n) =>
          n.kind === "gate" &&
          n.stage === "save" &&
          n.sessionId === sessionId &&
          n.title === "새 화면",
      ),
      JSON.stringify(notices),
    );
    await request({ id: "5", type: "session.close", sessionId });
    check(
      "closing the thread calls back nothing — the planner just did it themselves",
      notices.filter((n) => n.sessionId === sessionId).length === 1 &&
        !notices.some(
          (n) =>
            n.sessionId === sessionId &&
            (n.kind === "done" || n.kind === "crashed" || n.kind === "ask"),
        ),
      JSON.stringify(notices),
    );

    // --- 3c. a push failure with NO thread open still reaches Claude -------
    // With no session to brief, the daemon opens one itself — titled, the way
    // the bootstrap prepare turn is — and the failure lands there as the same
    // marked card.
    writeFileSync(join(ROOT, "index.html"), "<p>스레드 없는 저장</p>\n");
    const failedThreadless = await request({
      id: "3c",
      type: "repo.save",
      message: "스레드 없는 저장",
    });
    check(
      "a threadless push failure still reports the gate",
      failedThreadless.stage === "failed" && failedThreadless.gate === "push",
      `${failedThreadless.stage}/${failedThreadless.gate ?? ""}`,
    );
    const gateBrief = await waitFor(
      () =>
        inbox.find(
          (m) =>
            m.type === "session.event" &&
            m.sessionId !== sessionId &&
            m.event.kind === "user.echo" &&
            m.event.text.includes("저장한 변경을 올리지 못했습니다"),
        ),
      30_000,
      "the failure turn in the daemon-opened thread",
    );
    const gateThreadId = gateBrief.sessionId;
    check(
      "the daemon opened a NEW thread for the brief",
      typeof gateThreadId === "string" && gateThreadId !== sessionId,
      String(gateThreadId),
    );
    const threads = await request({ id: "3c-list", type: "session.list" });
    const gateThread = threads.find((row) => row.sessionId === gateThreadId);
    check(
      "and the thread is listed, live and titled",
      gateThread?.live === true && gateThread?.title === "저장 문제 해결",
      `live=${gateThread?.live} title=${gateThread?.title ?? "?"}`,
    );
    check(
      "the threadless gate failure fired the planner notice too",
      notices.some((n) => n.kind === "gate" && n.stage === "save" && n.sessionId === gateThreadId),
    );
    await request({ id: "3c-close", type: "session.close", sessionId: gateThreadId });
    await run("git", ["-C", ROOT, "remote", "set-url", "origin", fixture.remote]);

    // --- 4. the follow-up save rides the same branch -----------------------
    writeFileSync(join(ROOT, "scripts", "check.mjs"), PASSING_CHECK);
    /**
     * What a 저장 would carry, as the stepper reads it (PLAN D8). The number
     * moves when the clone is prepared, when a 화면 turn settles, and when a
     * save cleans the worktree — never on a timer, because it only changes
     * when somebody does something.
     */
    const dirty = await request({ id: "6a", type: "repo.sync" });
    check(
      "uncommitted work is counted, so the stepper can say 저장",
      dirty.pendingChanges > 0,
      `pendingChanges=${dirty.pendingChanges}`,
    );

    const saved2 = await request({
      id: "6",
      type: "repo.save",
      message: "검사 문구 복원",
    });
    check(
      "the follow-up save lands, carrying the stranded commits with it",
      saved2.stage === "published" && /^[0-9a-f]{40}$/.test(saved2.commit ?? ""),
      saved2.commit ?? `${saved2.stage}/${saved2.gate ?? ""}`,
    );

    const { stdout: localHead } = await run("git", ["-C", ROOT, "rev-parse", "HEAD"]);
    check(
      "the commit is local HEAD",
      localHead.trim() === saved2.commit,
      `${localHead.trim().slice(0, 10)}`,
    );
    check(
      "it stays on the same branch — one cycle, one review",
      JSON.stringify(await remoteBranches(fixture.remote)) === JSON.stringify(branches),
      (await remoteBranches(fixture.remote)).join(", "),
    );

    const status = await request({ id: "6b", type: "repo.status" });
    check(
      "and the save clears it, so the stepper moves on to 넘기기",
      status.pendingChanges === 0,
      `pendingChanges=${status.pendingChanges}`,
    );
    check(
      "the status names the branch the cycle is on",
      status.branch === cycleBranch && status.handoff === null,
      `${status.branch} · ${status.baseBranch}`,
    );

    const { stdout: subject } = await run("git", ["-C", ROOT, "log", "-1", "--pretty=%s"]);
    check(
      "the planner's message is the commit subject",
      subject.trim() === "검사 문구 복원",
      subject.trim(),
    );

    const stages = inbox
      .filter((m) => m.type === "diff.status")
      .map((m) => `${m.status.stage}${m.status.gate ? `:${m.status.gate}` : ""}`);
    for (const stage of ["computing", "pushing", "published"]) {
      check(
        `every save step is broadcast (${stage})`,
        stages.includes(stage),
        [...new Set(stages)].join(" → "),
      );
    }

    // --- 5. a second save stays on the same branch ------------------------
    writeFileSync(join(ROOT, "index.html"), "<p>두 번째 저장</p>\n");
    const again = await request({
      id: "7",
      type: "repo.save",
      message: "문구 수정",
    });
    check("a second save lands too", again.stage === "published", again.detail ?? again.stage);
    check(
      "it stays on the same branch — one cycle, one review",
      JSON.stringify(await remoteBranches(fixture.remote)) === JSON.stringify(branches),
      (await remoteBranches(fixture.remote)).join(", "),
    );

    // --- 6. nothing left to save is a clear rejection ---------------------
    const empty = await request({ id: "8", type: "diff.get" });
    check("a saved worktree has an empty diff", empty.length === 0);
    const rejected = await request({
      id: "9",
      type: "repo.save",
      message: "빈 저장",
    });
    check(
      "saving nothing is rejected in Korean",
      rejected.stage === "failed" &&
        rejected.gate === "diff" &&
        (rejected.detail ?? "").includes("저장할 변경사항이 없습니다"),
      rejected.detail ?? "",
    );

    // --- 6.5 저장 기록 · 되돌리기 · 변경 버리기 (PLAN D53) -----------------
    const history = await request({ id: "u1", type: "repo.history" });
    check(
      "every save on the cycle reads as an entry over origin/main",
      history.base === "origin/main" &&
        JSON.stringify(history.entries.map((entry) => entry.message)) ===
          JSON.stringify([
            "문구 수정",
            "검사 문구 복원",
            "스레드 없는 저장",
            "올리기 점검",
            "회원 관리 화면 추가",
          ]),
      JSON.stringify(history.entries.map((entry) => entry.message)),
    );
    check(
      "each entry names the files it carried",
      history.entries[0].files.join(",") === "index.html" &&
        history.entries[4].files.includes("index.html") &&
        history.entries[4].files.includes("src/screens/member/MemberList.screen.tsx"),
      JSON.stringify(history.entries.map((entry) => entry.files)),
    );
    const firstSha = history.entries[4].sha;
    const undone = await request({
      id: "u2",
      type: "repo.restore",
      sha: firstSha,
    });
    check(
      "되돌리기 lands as a new published commit",
      undone.stage === "published" && /^[0-9a-f]{40}$/.test(undone.commit ?? ""),
      `${undone.stage} · ${undone.commit ?? undone.detail ?? ""}`,
    );
    const cycleCommits = await run("git", ["-C", ROOT, "rev-list", "--count", "origin/main..HEAD"]);
    check(
      "the cycle carries six commits now — nothing was rewritten",
      cycleCommits.stdout.trim() === "6",
      cycleCommits.stdout.trim(),
    );
    const revertSubject = await run("git", ["-C", ROOT, "log", "-1", "--pretty=%s"]);
    check(
      "the new commit announces itself as 되돌리기",
      revertSubject.stdout.trim() === "되돌리기: 회원 관리 화면 추가",
      revertSubject.stdout.trim(),
    );
    const restoredHtml = await run("git", ["-C", ROOT, "show", "HEAD:index.html"]);
    check(
      "the worktree reads the first save again",
      restoredHtml.stdout.includes("회원 관리 목록 추가") &&
        !restoredHtml.stdout.includes("두 번째 저장"),
      restoredHtml.stdout.trim().split("\n").pop() ?? "",
    );

    writeFileSync(join(ROOT, "index.html"), "<p>아직 저장하지 않은 문장</p>\n");
    const refused = await request({
      id: "u3",
      type: "repo.restore",
      sha: firstSha,
    });
    check(
      "a dirty worktree refuses 되돌리기 and names the way out",
      refused.stage === "failed" &&
        (refused.detail ?? "").includes("먼저 저장하거나 되돌려 주세요"),
      refused.detail ?? "",
    );

    mkdirSync(join(ROOT, "src", "screens", "member"), { recursive: true });
    writeFileSync(
      join(ROOT, "src", "screens", "member", "Throwaway.screen.tsx"),
      "export default function Throwaway() { return null; }\n",
    );
    const discarded = await request({ id: "u4", type: "repo.discard" });
    check(
      "변경 버리기 throws away exactly the unsaved work",
      discarded.removed.length === 2 &&
        discarded.removed.includes("index.html") &&
        discarded.removed.includes("src/screens/member/Throwaway.screen.tsx"),
      JSON.stringify(discarded.removed),
    );
    check(
      "the thrown-away screen is gone",
      !existsSync(join(ROOT, "src", "screens", "member", "Throwaway.screen.tsx")),
    );
    const headHtml = await run("git", ["-C", ROOT, "show", "HEAD:index.html"]);
    check(
      "index.html is back to what HEAD saved",
      readFileSync(join(ROOT, "index.html"), "utf8") === headHtml.stdout,
    );
    const cleanAfterDiscard = await run("git", ["-C", ROOT, "status", "--porcelain"]);
    check(
      "and the worktree is clean",
      cleanAfterDiscard.stdout.trim() === "",
      cleanAfterDiscard.stdout,
    );

    // --- 6.6 체크포인트: every turn start is a snapshot (PLAN D52) ---------
    const cpSession = await request({ id: "u5", type: "session.create" });
    await request({
      id: "u6",
      type: "session.send",
      sessionId: cpSession.sessionId,
      text: "파일을 만지지 말고 한 문장으로만 답해 주세요.",
    });
    let pollId = 0;
    const myCheckpoints = async () => {
      pollId += 1;
      const listed = await request({
        id: `u6-${pollId}`,
        type: "repo.checkpoints",
      });
      return listed.entries.filter((entry) => entry.sessionId === cpSession.sessionId);
    };
    await waitFor(
      async () => (await myCheckpoints()).length >= 1,
      30_000,
      "the first turn's checkpoint",
    );

    // The turn's own unsaved half: a screen born after the snapshot, and a
    // file that existed before it, deleted. Restoring must do both halves.
    writeFileSync(
      join(ROOT, "src", "screens", "member", "UndoMe.screen.tsx"),
      "export default function UndoMe() { return null; }\n",
    );
    rmSync(join(ROOT, "scripts", "check.mjs"));
    await request({
      id: "u7",
      type: "session.send",
      sessionId: cpSession.sessionId,
      text: "여전히 파일을 만지지 말고 짧게만 답해 주세요.",
    });
    await waitFor(
      async () => (await myCheckpoints()).length >= 2,
      60_000,
      "the second turn's checkpoint",
    );
    await request({
      id: "u8",
      type: "session.close",
      sessionId: cpSession.sessionId,
    });

    const mine = await myCheckpoints();
    check(
      "two turns read as two snapshots, turns numbered from one",
      mine.length === 2 &&
        mine
          .map((entry) => entry.turn)
          .sort()
          .join(",") === "1,2" &&
        mine[0].at !== "",
      JSON.stringify(mine),
    );
    const firstCheckpoint = mine.find((entry) => entry.turn === 1);
    const rewound = await request({
      id: "rewind-1",
      type: "repo.checkpoint.restore",
      checkpoint: firstCheckpoint.id,
    });
    check(
      "the screen born after the snapshot is gone",
      !existsSync(join(ROOT, "src", "screens", "member", "UndoMe.screen.tsx")),
    );
    check(
      "the file deleted after the snapshot is back",
      existsSync(join(ROOT, "scripts", "check.mjs")),
    );
    const rewoundStatus = await run("git", ["-C", ROOT, "status", "--porcelain"]);
    check(
      "and the worktree stands at the turn's first instant",
      rewoundStatus.stdout.trim() === "",
      rewoundStatus.stdout,
    );

    // --- 7. `build` gates nothing — the pull request is where problems land
    // 넘기기가 연 PR 에서 개발자가 문제를 본다(실사): 실패하는 build 를 두고도
    // 저장과 넘기기는 그대로 간다.
    const manifest = join(ROOT, "colo-design.json");
    const config = JSON.parse(readFileSync(manifest, "utf8"));
    config.build = "node -e \"console.error('build: 테스트용 실패'); process.exit(1)\"";
    writeFileSync(manifest, `${JSON.stringify(config, null, 2)}\n`);

    const savedWithBadBuild = await request({
      id: "9b",
      type: "repo.save",
      message: "빌드 게이트 추가",
    });
    check(
      "a save ignores build",
      savedWithBadBuild.stage === "published",
      `${savedWithBadBuild.stage}/${savedWithBadBuild.gate ?? ""}`,
    );

    const handed = await request({
      id: "9c",
      type: "repo.handoff",
      title: "결제 화면",
    });
    check(
      "a failing build no longer stops the handoff — the pull request is where it lands",
      handed.stage === "handed-off" && handed.handoff?.number === 12,
      `${handed.stage} · ${handed.handoff?.url ?? handed.detail ?? ""}`,
    );
    // --- 8. 개발자에게 넘기기: the work became a pull request --------------
    const afterHandoff = await request({ id: "11", type: "repo.status" });
    check(
      "the status carries the handoff so the planner sees 넘김",
      afterHandoff.handoff?.state === "open" && afterHandoff.branch === cycleBranch,
      `${afterHandoff.handoff?.state} · ${afterHandoff.branch}`,
    );
    check(
      "the handoff survives a restart — it lives in the registry",
      JSON.parse(readFileSync(join(DIR, "projects.json"), "utf8")).projects[0].repo.handoff
        ?.number === 12,
    );
    check(
      "a handoff without a driver commits no captures (PLAN D56)",
      !existsSync(join(ROOT, ".colo-design", "shots")),
    );

    // --- 9. 반영됨: the merge ends the cycle -------------------------------
    const stillOpen = await request({ id: "12", type: "repo.handoffStatus" });
    check("an unmerged pull request stays 넘김", stillOpen.state === "open", stillOpen.state);

    const merged = await request({ id: "13", type: "repo.handoffStatus" });
    check("a merged pull request reads 반영됨", merged.state === "merged", merged.state);
    const afterMerge = await request({ id: "14", type: "repo.status" });
    check(
      "the merge ends the cycle, so the next save starts a new branch",
      afterMerge.branch === null,
      `${afterMerge.branch}`,
    );
    const { stdout: head } = await run("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"]);
    check(
      "and the clone is back on the developer's base branch",
      head.trim() === "main",
      head.trim(),
    );
    const leftoverRefs = await run("git", [
      "-C",
      ROOT,
      "for-each-ref",
      "refs/colo-design/checkpoints",
    ]);
    check(
      "반영됨 clears the cycle's checkpoint refs (PLAN D52)",
      leftoverRefs.stdout.trim() === "",
      leftoverRefs.stdout.trim(),
    );

    // --- 9.5 코멘트 저장소 (PLAN D57) ----------------------------------------

    // The overlay's pins land in the project's comments.json — the planner
    // is looking at the ACTIVE project, so no slug rides the message.
    await request({
      id: "c1",
      type: "comments.record",
      items: [
        {
          screen: "/member/MemberList",
          state: "default",
          text: "여백이 좁아요",
          elementText: "회원 목록",
        },
      ],
    });
    await request({
      id: "c2",
      type: "comments.record",
      items: [
        { screen: "/pay/PayFailed", state: "error", text: "문구를 다시", elementText: "결제 실패" },
      ],
    });
    const listed = await request({ id: "c3", type: "comments.list" });
    check(
      "two recorded screens read as two stored comments",
      listed.items.length === 2 && listed.items.every((item) => item.id !== "" && item.at !== ""),
      JSON.stringify(listed.items),
    );
    // D78 + 자동 정리: the store normalizes the screen to the [data-screen]
    // spelling — no leading slash, whatever spelling the client used — and
    // every row is born resolved: the turn carrying the words IS the
    // delivery, so no resolve step exists.
    check(
      "recorded rows land delivered, on the [data-screen] spelling",
      listed.items.some((item) => item.screen === "member/MemberList") &&
        listed.items.some((item) => item.screen === "pay/PayFailed") &&
        listed.items.every((item) => item.resolved === true),
      JSON.stringify(listed.items.map((item) => [item.screen, item.resolved])),
    );

    writeFileSync(join(ROOT, "index.html"), "<p>다음 주기</p>\n");
    const nextCycle = await request({
      id: "15",
      type: "repo.save",
      message: "다음 주기",
    });
    check(
      "the next save lands",
      nextCycle.stage === "published",
      nextCycle.detail ?? nextCycle.stage,
    );
    const finalBranches = await remoteBranches(fixture.remote);
    check(
      "on a branch of its own, leaving the handed-over one alone",
      finalBranches.filter((name) => name.startsWith("colo-design/")).length === 2,
      finalBranches.join(", "),
    );

    // --- 10. 두 번째 사이클 (PLAN D84): the merged PR stays history --------
    const secondStatus = await request({ id: "16", type: "repo.status" });
    check(
      "D84 the merged handoff does not ride into the new cycle",
      secondStatus.handoff === null && secondStatus.branch !== null,
      `handoff:${secondStatus.handoff?.number ?? "null"} branch:${secondStatus.branch}`,
    );
    // D93: comments recorded after the branch's first commit ride the PR body.
    // The fixture's second POST /pulls recording demands the section — a body
    // without it would not match and the handoff would fail loudly.
    await request({
      id: "16a",
      type: "comments.record",
      items: [
        { screen: "member/MemberList", state: "default", text: "코멘트 하나", elementText: "제목" },
      ],
    });
    // Both pay/PayFailed comments ride ONE record — the store appends, but
    // one batch is one moment's request, and the section reads cleaner for it.
    await request({
      id: "16b",
      type: "comments.record",
      items: [
        { screen: "pay/PayFailed", state: "error", text: "코멘트 둘", elementText: "문구" },
        { screen: "pay/PayFailed", state: "error", text: "코멘트 셋", elementText: "문구" },
      ],
    });
    const secondHanded = await request({
      id: "17",
      type: "repo.handoff",
      title: "결제 후속",
    });
    check(
      "D84 the second 넘기기 opens a NEW pull request",
      secondHanded.stage === "handed-off" && secondHanded.handoff?.number === 13,
      `${secondHanded.stage} · ${secondHanded.handoff?.number ?? secondHanded.detail ?? ""}`,
    );
    const secondCheck = await request({ id: "18", type: "repo.handoffStatus" });
    check(
      "D84 the second cycle's status reads its own open pull request",
      secondCheck.state === "open" && secondCheck.number === 13,
      `${secondCheck.state} · ${secondCheck.number}`,
    );

    // --- D90: pr 게이트는 Claude 에게 가지 않는다 ---------------------------
    // A third handoff with no recording left fails at the pr gate. A session
    // rides along so the test can prove NO fixable brief was composed — the
    // inbox is the whole wire.
    const createdForGate = await request({ id: "19a", type: "session.create" });
    const gateSessionId = createdForGate.sessionId;
    const inboxMark = inbox.length;
    const prFailed = await request({
      id: "19b",
      type: "repo.handoff",
      title: "또 넘기기",
      sessionId: gateSessionId,
    });
    check(
      "D90 a failed pr gate reports failed at pr",
      prFailed.stage === "failed" && prFailed.gate === "pr",
      `${prFailed.stage}/${prFailed.gate ?? ""}`,
    );
    await new Promise((ok) => setTimeout(ok, 1200));
    const gateBriefs = inbox
      .slice(inboxMark)
      .filter((m) => m.type === "session.event" && m.sessionId === gateSessionId)
      .filter((m) => m.event.kind === "user.echo");
    check(
      "D90 the pr gate composes no fixable brief for Claude",
      gateBriefs.length === 0,
      `${gateBriefs.length} brief(s)`,
    );
    await request({
      id: "19c",
      type: "session.close",
      sessionId: gateSessionId,
    });

    // --- D88: 개발자 코멘트가 도구 안으로 -----------------------------------
    const report = await request({ id: "20", type: "repo.handoffStatus" });
    const reviews = report.reviews ?? [];
    check(
      "D88 상태 확인 carries the developer's comments",
      reviews.length === 3 &&
        reviews.some(
          (r) =>
            r.kind === "inline" &&
            r.path === "src/screens/member/MemberList.screen.tsx" &&
            r.line === 12,
        ) &&
        reviews.some((r) => r.kind === "review"),
      JSON.stringify(reviews.map((r) => [r.kind, r.author, r.path ?? ""])),
    );
    const replied = await request({
      id: "21",
      type: "comments.reply",
      reviewId: 21,
      body: "기본 문구입니다 — 다음 넘기기에 반영해 두겠습니다.",
    });
    check("D88 답하기 goes out under the planner's name", replied.ok === true);
    let unknownRefused = false;
    try {
      await request({
        id: "22",
        type: "comments.reply",
        reviewId: 999,
        body: "없는 코멘트",
      });
    } catch {
      unknownRefused = true;
    }
    check("D88 an unknown review id is refused, not guessed", unknownRefused === true);
  } finally {
    ws.close();
    await server.stop();
    rmSync(DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
  // A green suite ends deterministically — a lingering handle must not stall
  // the parallel runner's lane.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
