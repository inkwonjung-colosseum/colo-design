/**
 * Publish-path end-to-end check, offline: the remote is a local bare git
 * repository (fixture-repo.mjs) whose `check` gate is a plain node script the
 * test breaks and then fixes.
 *
 * Covers the whole gate: diff.get lists tracked and untracked changes;
 * a publish with a failing `check` reports failed{gate:"check"} without moving
 * the remote, and hands the failure to the live session as a user turn; after
 * the fix the commit lands locally and on the remote; a publish with nothing
 * to commit is rejected. The session is real (it is the same wire a typed
 * message uses) but is closed the moment its failure turn is observed, so no
 * model turn is spent.
 *
 * Usage: node packages/daemon/test/publish-e2e.mjs
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { readTurn } from "../../protocol/dist/index.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const run = promisify(execFile);

const DIR = join(tmpdir(), "cds-design-publish-e2e");
const ROOT = join(DIR, "work");

// The session and the PAT store must never touch the real home during the run,
// and neither may the project registry: on the default path the daemon writes
// ~/cds-design/config/projects.json, and the next run would start from this
// run's project — a repo url pointing at a fixture remote that no longer exists.
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.CDS_DESIGN_REPO_SETTINGS = join(DIR, "settings.json");
process.env.CDS_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.CDS_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.CDS_DESIGN_CREDENTIAL_STORE = "memory";
// The handoff half talks to GitHub. The remote here is a local bare
// repository, so nothing in its url could name a GitHub project — the slug is
// pinned, and the REST calls replay recorded pairs in order.
process.env.CDS_DESIGN_GITHUB_FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures",
  "github",
  "handoff",
);
process.env.CDS_DESIGN_GITHUB_SLUG = "colosseumcoinckr/cds-design-e2e";
process.env.CDS_DESIGN_REPO_PAT = "ghp_handoff_e2e";

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
    const hit = predicate();
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
  const { stdout } = await run("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

const FAILING_CHECK = `console.error("check: 테스트용 실패 — src/screens 규칙 위반");
process.exit(1);
`;
const PASSING_CHECK = `console.log("check: 통과");
`;

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });

  const port = await freePort();
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port });
  const remoteBefore = await remoteHead(fixture.remote);

  process.env.CDS_DESIGN_REPO_DIR = ROOT;
  process.env.CDS_DESIGN_REPO_URL = fixture.remote;
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
    const reply = await waitFor(() => inbox.find((m) => m.id === message.id), timeoutMs, message.type);
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
      'export default function MemberListScreen() { return null; }\n',
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

    // --- 3. a failing check stops the save, and tells the session ---------
    writeFileSync(join(ROOT, "scripts", "check.mjs"), FAILING_CHECK);
    const created = await request({ id: "3", type: "session.create" });
    const sessionId = created.sessionId;

    const failed = await request({
      id: "4",
      type: "repo.save",
      message: "회원 관리 화면 추가",
      sessionId,
    });
    check(
      "a failing check reports failed at the check gate",
      failed.stage === "failed" && failed.gate === "check",
      `${failed.stage}/${failed.gate}`,
    );
    check(
      "the failure quotes the gate's own output",
      (failed.detail ?? "").includes("테스트용 실패"),
      (failed.detail ?? "").split("\n")[0] ?? "",
    );
    check("the remote ref is unchanged", (await remoteHead(fixture.remote)) === remoteBefore);

    const brief = await waitFor(
      () =>
        inbox.find(
          (m) =>
            m.type === "session.event" &&
            m.sessionId === sessionId &&
            m.event.kind === "user.echo" &&
            m.event.text.includes("저장 전 검사(check)가 실패"),
        ),
      30_000,
      "the failure turn in the live session",
    );
    check(
      "the failure lands in the session as a fixable brief",
      brief.event.text.includes("테스트용 실패"),
      `${brief.event.text.split("\n").slice(0, 2).join(" ")}…`,
    );
    // The planner reads a card, not the command output (PLAN D9). The marker
    // is what the transcript turns into one, and it names the step by the
    // button that was pressed rather than by the gate that ran.
    const marked = readTurn(brief.event.text);
    check(
      "and it is marked so the planner sees a card instead of the output",
      marked.marker?.kind === "gate" && marked.marker.step === "저장 전 검사",
      JSON.stringify(marked.marker),
    );
    check(
      "the marker does not disturb what Claude reads",
      marked.body.startsWith("저장 전 검사(check)가 실패했습니다.") &&
        marked.body.includes("테스트용 실패"),
      marked.body.split("\n")[0] ?? "",
    );
    check(
      "the gate failure fired the planner notice for the unnamed thread",
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
          (n) => n.sessionId === sessionId && (n.kind === "done" || n.kind === "crashed" || n.kind === "ask"),
        ),
      JSON.stringify(notices),
    );

    check(
      "the check gate failure was broadcast",
      inbox.some((m) => m.type === "diff.status" && m.status.stage === "gating" && m.status.gate === "check"),
    );

    // --- 4. a fixed repo saves onto its OWN branch, never onto main -------
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

    const saved = await request({ id: "6", type: "repo.save", message: "회원 관리 화면 추가" });
    check(
      "a fixed repo saves",
      saved.stage === "published" && /^[0-9a-f]{40}$/.test(saved.commit ?? ""),
      saved.commit ?? `${saved.stage}/${saved.gate ?? ""}`,
    );

    const { stdout: localHead } = await run("git", ["-C", ROOT, "rev-parse", "HEAD"]);
    check(
      "the commit is local HEAD",
      localHead.trim() === saved.commit,
      `${localHead.trim().slice(0, 10)}`,
    );

    // The whole point of PLAN D5: a developer receives this as a branch to
    // review, and the base they work on is untouched until they merge it.
    const branches = await remoteBranches(fixture.remote);
    const cycleBranch = branches.find((name) => name.startsWith("cds-design/"));
    check(
      "the save created its own branch on the remote",
      cycleBranch !== undefined && /^cds-design\/\d{8}-\d+$/.test(cycleBranch),
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
    check("the planner's message is the commit subject", subject.trim() === "회원 관리 화면 추가", subject.trim());

    const stages = inbox
      .filter((m) => m.type === "diff.status")
      .map((m) => `${m.status.stage}${m.status.gate ? `:${m.status.gate}` : ""}`);
    for (const stage of ["computing", "gating:check", "pushing", "published"]) {
      check(
        `every save step is broadcast (${stage})`,
        stages.includes(stage),
        [...new Set(stages)].join(" → "),
      );
    }

    // --- 5. a second save stays on the same branch ------------------------
    writeFileSync(join(ROOT, "index.html"), "<p>두 번째 저장</p>\n");
    const again = await request({ id: "7", type: "repo.save", message: "문구 수정" });
    check("a second save lands too", again.stage === "published", again.detail ?? again.stage);
    check(
      "it stays on the same branch — one cycle, one review",
      JSON.stringify(await remoteBranches(fixture.remote)) === JSON.stringify(branches),
      (await remoteBranches(fixture.remote)).join(", "),
    );

    // --- 6. nothing left to save is a clear rejection ---------------------
    const empty = await request({ id: "8", type: "diff.get" });
    check("a saved worktree has an empty diff", empty.length === 0);
    const rejected = await request({ id: "9", type: "repo.save", message: "빈 저장" });
    check(
      "saving nothing is rejected in Korean",
      rejected.stage === "failed" &&
        rejected.gate === "diff" &&
        (rejected.detail ?? "").includes("저장할 변경사항이 없습니다"),
      rejected.detail ?? "",
    );

    // --- 7. `build` gates 넘기기, never 저장 -------------------------------
    // A save that paid for a full build every time would teach the planner to
    // save rarely; being wrong at 넘기기 costs a developer's attention, so the
    // build belongs there. Both halves of that decision are checked here.
    const manifest = join(ROOT, "cds-design.json");
    const config = JSON.parse(readFileSync(manifest, "utf8"));
    config.build = 'node -e "console.error(\'build: 테스트용 실패\'); process.exit(1)"';
    writeFileSync(manifest, `${JSON.stringify(config, null, 2)}\n`);

    const savedWithBadBuild = await request({ id: "9b", type: "repo.save", message: "빌드 게이트 추가" });
    check(
      "a save ignores build — only 넘기기 pays for it",
      savedWithBadBuild.stage === "published",
      `${savedWithBadBuild.stage}/${savedWithBadBuild.gate ?? ""}`,
    );

    const blocked = await request({ id: "9c", type: "repo.handoff", title: "실패할 넘기기" });
    check(
      "a failing build stops the handoff before anything reaches the developer",
      blocked.stage === "failed" && blocked.gate === "build",
      `${blocked.stage}/${blocked.gate ?? ""}`,
    );
    check(
      "and no pull request was opened",
      (await request({ id: "9d", type: "repo.status" })).handoff === null,
    );

    config.build = 'node -e "process.exit(0)"';
    writeFileSync(manifest, `${JSON.stringify(config, null, 2)}\n`);
    await request({ id: "9e", type: "repo.save", message: "빌드 고침" });

    // --- 8. 개발자에게 넘기기: the work becomes a pull request -------------
    const handed = await request({ id: "10", type: "repo.handoff", title: "결제 화면" });
    check(
      "handing over opens a pull request from this cycle's branch",
      handed.stage === "handed-off" && handed.handoff?.number === 12,
      `${handed.stage} · ${handed.handoff?.url ?? handed.detail ?? ""}`,
    );
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
    check("and the clone is back on the developer's base branch", head.trim() === "main", head.trim());

    writeFileSync(join(ROOT, "index.html"), "<p>다음 주기</p>\n");
    const nextCycle = await request({ id: "15", type: "repo.save", message: "다음 주기" });
    check("the next save lands", nextCycle.stage === "published", nextCycle.detail ?? nextCycle.stage);
    const finalBranches = await remoteBranches(fixture.remote);
    check(
      "on a branch of its own, leaving the handed-over one alone",
      finalBranches.filter((name) => name.startsWith("cds-design/")).length === 2,
      finalBranches.join(", "),
    );
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
