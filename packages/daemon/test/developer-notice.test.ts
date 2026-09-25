import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeAttention } from "@colo-design/protocol";
import { MemoryCredentialStore } from "../dist/credentials.js";
import { emptyLedger, readLedger, writeLedger } from "../dist/cycle-ledger.js";
import {
  clipDetail,
  DeveloperNotice,
  type DeveloperNoticeDeps,
  describeProblem,
  findIssueMarker,
  findNoticeIssue,
  type NoticeStore,
  noticeBody,
  SCREEN_QUIET_KEYS,
} from "../dist/developer-notice.js";
import { Escalation } from "../dist/escalation.js";
import { GitHubClient } from "../dist/github.js";
import type { DaemonLogger } from "../dist/log.js";
import { PublishCycle } from "../dist/repo-publish.js";
import { MemoryGitHub, makeClone, makeCore, makeRemote } from "./helpers/cycle-harness.ts";

const quiet: DaemonLogger = { info() {}, warn() {}, error() {} };

/** 가짜 Slack — 보낸 문장을 기록한다. configured 는 보낸 횟수가 아니라 설정 유무다. */
function fakeSlack() {
  const sent: string[] = [];
  const escalation = new Escalation(new MemoryCredentialStore(), quiet, async () => {
    return new Response("ok");
  });
  return {
    escalation,
    sent,
    async configure() {
      await escalation.set({ kind: "webhook", url: "https://hooks.example/test" });
    },
  };
}

/** 슬러그 "app" 하나를 아는 deps — GitHub · 프로젝트 · 원장을 시험이 갈아끼운다. */
function deps(over: Partial<DeveloperNoticeDeps> = {}): DeveloperNoticeDeps {
  return {
    github: () => null,
    githubAuthExpired: () => false,
    repoSlug: () => ({ owner: "colo-design", repo: "harness" }),
    project: () => ({ name: "앱", reviewers: ["dev1"], openPr: null }),
    authorName: () => "기획자",
    slack:
      over.slack ??
      new Escalation(new MemoryCredentialStore(), quiet, async () => {
        throw new Error("slack 없음");
      }),
    store: () => null,
    logger: quiet,
    ...over,
  };
}

const PROBLEM = { key: "push:auth", slug: "app", ...describeProblem("push:auth") };

// ————— 순수 —————

test("describeProblem — 표의 키는 한국어 네 줄, 모르는 키는 키가 곧 제목이다", () => {
  const known = describeProblem("push:auth");
  assert.equal(known.title, "푸시가 인증 · 권한으로 거절됐습니다");
  assert.ok(known.ask.length > 0);
  const unknown = describeProblem("weird:key");
  assert.equal(unknown.title, "weird:key");
  const bringUp = describeProblem("bring-up:install");
  assert.equal(bringUp.title, "화면 준비가 멈췄습니다");
  assert.ok(bringUp.what.includes("install"));
});

test("describeProblem — 반려 반영 턴의 예산 소진은 라운드 상한 문장이 아니다", () => {
  const rejection = describeProblem("review:7:rejection");
  assert.equal(rejection.title, "반려 이유를 AI 에게 맡기지 못했습니다");
  assert.equal(describeProblem("review:7:rounds").title, "코멘트 반영이 라운드 상한에 닿았습니다");
});

test("noticeBody — 네 줄 구조와 details, 생니타이저와 자르기", () => {
  const body = noticeBody(
    { ...PROBLEM, detail: "토큰 ghp_secret1234567890 이 거절됐습니다" },
    { projectName: "앱", authorName: "기획자" },
    1,
    new Date("2026-09-24T00:00:00Z"),
  );
  assert.ok(body.startsWith("[Colo Design] 앱 · 기획자 님의 작업이 막혔습니다"));
  assert.ok(body.includes("무엇이"));
  assert.ok(body.includes("해 본 것"));
  assert.ok(body.includes("부탁"));
  assert.ok(body.includes("<details><summary>자세히</summary>"));
  // 생니타이저 — 토큰은 본문에 남지 않는다.
  assert.ok(!body.includes("ghp_secret1234567890"));
  assert.ok(body.includes("{secret}"));
});

test("clipDetail — 30줄 · 4000자에서 자르고 비밀을 걷는다", () => {
  const long = Array.from({ length: 40 }, (_, i) => `줄 ${i}`).join("\n");
  const clipped = clipDetail(long);
  // 30줄 + 잘림 표식 줄.
  assert.equal(clipped.split("\n").length, 31);
  assert.ok(clipped.endsWith("…"));
  assert.ok(clipDetail("x".repeat(5000)).length <= 4001);
});

test("findIssueMarker · findNoticeIssue — 표식이 같은 열린 이슈를 찾는다", () => {
  const body = "앞\n<!-- colo-design:problem push:auth -->\n뒤";
  assert.equal(findIssueMarker(body), "push:auth");
  assert.equal(findIssueMarker("표식 없음"), null);
  const rows = [
    { number: 3, body: "<!-- colo-design:problem push:auth -->\n…" },
    { number: 4, body: "<!-- colo-design:problem submit:pr -->\n…" },
  ];
  assert.equal(findNoticeIssue(rows, "submit:pr"), 4);
  assert.equal(findNoticeIssue(rows, "env:git"), null);
});

test("composeAttention — 우선순위 reconnect > developer-notified > ai-fixing", () => {
  const since = "2026-09-24T00:00:00.000Z";
  assert.equal(composeAttention({}), null);
  assert.deepEqual(composeAttention({ aiFixingSince: since }), { kind: "ai-fixing", since });
  assert.deepEqual(
    composeAttention({
      aiFixingSince: since,
      notices: { k: { via: "issue", raisedAt: since } },
    }),
    { kind: "developer-notified", since, via: "issue" },
  );
  assert.deepEqual(
    composeAttention({
      reconnect: { what: "github", since },
      aiFixingSince: since,
      notices: { k: { via: "slack", raisedAt: since } },
    }),
    { kind: "reconnect", since, what: "github" },
  );
});

// ————— MemoryGitHub 위의 배달 —————

test("PR 이 없으면 이슈를 열고, 다시 raise 는 코멘트만, resolve 는 코멘트 + 닫기", async () => {
  const remote = await makeRemote();
  try {
    const github = new MemoryGitHub(remote);
    const client = new GitHubClient("t", github);
    const notice = new DeveloperNotice(deps({ github: () => client }));
    assert.equal(await notice.raise(PROBLEM), "issue");
    assert.equal(github.openIssueCount, 1);
    const issue = github.issue(1);
    assert.ok(issue !== undefined);
    assert.ok(issue.body.includes("<!-- colo-design:problem push:auth -->"));
    // 다시 raise — 같은 이슈에 코멘트만 덧붙인다.
    assert.equal(await notice.raise(PROBLEM), "issue");
    assert.equal(github.openIssueCount, 1);
    assert.ok(issue.number === 1);
    await notice.resolve("push:auth", "app");
    const after = github.issue(1);
    assert.ok(after !== undefined);
    assert.equal(after.state, "closed");
    assert.ok(after.comments.some((c) => c.body === "해결됐습니다"));
  } finally {
    remote.dispose();
  }
});

test("열린 PR 이 있으면 PR 코멘트 — 다시 raise 는 그 코멘트를 고치고 resolve 는 해결 표식", async () => {
  const remote = await makeRemote();
  try {
    const github = new MemoryGitHub(remote);
    const pr = await github.openPull({ head: "main" });
    const client = new GitHubClient("t", github);
    let now = 1_000_000;
    const notice = new DeveloperNotice(
      deps({
        github: () => client,
        project: () => ({ name: "앱", reviewers: [], openPr: pr }),
        now: () => now,
      }),
    );
    assert.equal(await notice.raise(PROBLEM), "pr");
    // 10분 창을 넘긴 다시 raise — 같은 코멘트를 고쳐 횟수를 갱신한다.
    now += 11 * 60_000;
    assert.equal(await notice.raise(PROBLEM), "pr");
    await notice.resolve("push:auth", "app");
    const comments = github.commentsFor(pr);
    // 같은 코멘트 하나가 갱신되고 해결 표식이 앞에 선다 — 새 코멘트가 아니다.
    assert.equal(comments.length, 1);
    assert.ok(comments[0]?.body.startsWith("[OK] 해결됨"));
  } finally {
    remote.dispose();
  }
});

test("GitHub 이 401 이면 Slack 으로 간다 — 설정이 없으면 none", async () => {
  const remote = await makeRemote();
  try {
    const github = new MemoryGitHub(remote);
    github.expireAuth();
    const client = new GitHubClient("t", github);
    const slack = fakeSlack();
    await slack.configure();
    const notice = new DeveloperNotice(deps({ github: () => client, slack: slack.escalation }));
    assert.equal(await notice.raise(PROBLEM), "slack");
    // Slack 도 없으면 none — 알리지 못한 것을 알렸다고 말하지 않는다(O9).
    const nowhere = new DeveloperNotice(deps({ github: () => client }));
    assert.equal(await nowhere.raise({ ...PROBLEM, key: "submit:pr" }), "none");
  } finally {
    remote.dispose();
  }
});

test("같은 키는 10분에 한 번만 GitHub 에 쓴다 — 창 안의 raise 는 서 있는 경로를 답한다", async () => {
  const remote = await makeRemote();
  try {
    const github = new MemoryGitHub(remote);
    const client = new GitHubClient("t", github);
    let now = 1_000_000;
    const notice = new DeveloperNotice(deps({ github: () => client, now: () => now }));
    assert.equal(await notice.raise(PROBLEM), "issue");
    assert.equal(github.openIssueCount, 1);
    // 5분 뒤 — 쓰지 않는다.
    now += 5 * 60_000;
    assert.equal(await notice.raise(PROBLEM), "issue");
    assert.equal(github.issue(1)?.comments.length, 0);
    // 11분 뒤 — 같은 이슈에 코멘트로 갱신한다.
    now += 6 * 60_000;
    assert.equal(await notice.raise(PROBLEM), "issue");
    assert.equal(github.openIssueCount, 1);
    assert.equal(github.issue(1)?.comments.length, 1);
  } finally {
    remote.dispose();
  }
});

test("프로젝트 알림의 상태는 원장에 남는다 — 새 DeveloperNotice 가 같은 이슈에 덧붙인다", async () => {
  const remote = await makeRemote();
  const dir = mkdtempSync(join(tmpdir(), "colo-notice-"));
  try {
    const github = new MemoryGitHub(remote);
    const client = new GitHubClient("t", github);
    const ledgerPath = join(dir, "cycle.json");
    writeLedger(ledgerPath, emptyLedger());
    // 원장을 등에 업은 NoticeStore — 감독자가 주는 접근자와 같은 모양.
    const storeFor = (): NoticeStore => ({
      notices: () => readLedger(ledgerPath).notices,
      setNotice: (key, entry) => {
        const ledger = readLedger(ledgerPath);
        const notices = { ...ledger.notices };
        if (entry === null) delete notices[key];
        else notices[key] = entry;
        writeLedger(ledgerPath, { ...ledger, notices });
      },
    });
    const first = new DeveloperNotice(deps({ github: () => client, store: storeFor }));
    assert.equal(await first.raise(PROBLEM), "issue");
    assert.equal(github.openIssueCount, 1);
    // 재시작 흉내 — 새 DeveloperNotice 가 같은 원장을 읽어 같은 이슈에 코멘트한다.
    const second = new DeveloperNotice(deps({ github: () => client, store: storeFor }));
    assert.equal(await second.raise(PROBLEM), "issue");
    assert.equal(github.openIssueCount, 1);
    assert.equal(github.issue(1)?.comments.length, 1);
    await second.resolve("push:auth", "app");
    assert.equal(github.issue(1)?.state, "closed");
    assert.deepEqual(readLedger(ledgerPath).notices, {});
  } finally {
    remote.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("기계 전체 알림(slug null)은 machineNotices 에 서고 주의가 developer-notified 다", async () => {
  const slack = fakeSlack();
  await slack.configure();
  const notice = new DeveloperNotice(deps({ slack: slack.escalation }));
  // GitHub 에 닿지 않는 기계 전체 문제 — Slack 으로 간다.
  assert.equal(
    await notice.raise({ key: "github:auth", slug: null, ...describeProblem("github:auth") }),
    "slack",
  );
  const machines = notice.machineNotices();
  assert.equal(machines["github:auth"]?.via, "slack");
  // status 의 machineAttention 이 읽는 것과 같은 합성 — 화면에 올라온다.
  assert.deepEqual(composeAttention({ notices: machines }), {
    kind: "developer-notified",
    since: machines["github:auth"]?.raisedAt,
    via: "slack",
  });
  await notice.resolve("github:auth", null);
  assert.deepEqual(notice.machineNotices(), {});
});

test("disk:low 는 Slack 으로 가지만 화면 주의의 재료(machineNotices)에는 서지 않는다 (O8)", async () => {
  const slack = fakeSlack();
  await slack.configure();
  const notice = new DeveloperNotice(deps({ slack: slack.escalation }));
  assert.equal(
    await notice.raise({
      key: "disk:low",
      slug: null,
      ...describeProblem("disk:low", "여유 1.0GB"),
    }),
    "slack",
  );
  // 사용자 기계의 일이라 네 번째 문장을 두지 않는다 — 기계 주의는 비어 있다.
  assert.deepEqual(notice.machineNotices(), {});
  assert.equal(composeAttention({ notices: notice.machineNotices() }), null);
  await notice.resolve("disk:low", null);
});

test("github:expiring — 예고 네 줄에 이슈 하나, 둘째 알림은 중복 없음, 새 토큰에 해결 (U17)", async () => {
  const remote = await makeRemote();
  try {
    // 본문 — 만료 예고의 네 줄(표의 문장 그대로).
    const words = describeProblem("github:expiring");
    assert.equal(words.title, "연결 코드(GitHub)가 곧 만료됩니다");
    assert.equal(words.what, "연결 코드의 만료일이 2주 안입니다");
    assert.equal(words.tried, "토큰은 사용자의 열쇠라 도구가 대신 만들 수 없습니다");
    assert.equal(words.ask, "만료 전에 새 초대 파일을 사용자에게 보내 주세요");
    // 조용한 키 — 사용자가 할 일이 없으니 문제 문장(개발자에게 알렸어요)에 서지 않는다.
    assert.equal(SCREEN_QUIET_KEYS["github:expiring"], true);

    const github = new MemoryGitHub(remote);
    const client = new GitHubClient("t", github);
    const notice = new DeveloperNotice(deps({ github: () => client }));
    const problem = {
      key: "github:expiring",
      slug: "app",
      ...describeProblem("github:expiring", "만료: 2026-10-07T12:00:00.000Z · 12일 남음"),
    };
    assert.equal(await notice.raise(problem), "issue");
    assert.equal(github.openIssueCount, 1);
    const issue = github.issue(1);
    assert.ok(issue !== undefined);
    assert.ok(issue.title.includes("곧 만료됩니다"));
    assert.ok(issue.body.includes("만료일이 2주 안입니다"));
    assert.ok(issue.body.includes("만료: 2026-10-07T12:00:00.000Z · 12일 남음"));
    // 둘째 알림(창 안의 다시 나기) — 같은 이슈에 새 글 없음.
    assert.equal(await notice.raise(problem), "issue");
    assert.equal(github.openIssueCount, 1);
    assert.equal(github.issue(1)?.comments.length, 0);
    // 새 토큰 — 서 있던 예고를 거둔다(해결 코멘트 + 닫기).
    await notice.resolve("github:expiring", "app");
    assert.equal(github.issue(1)?.state, "closed");
  } finally {
    remote.dispose();
  }
});

test("disk:low 는 프로젝트가 셋이라도 하루에 한 번만 나간다 — 기계 전체 알림의 창", async () => {
  // fakeSlack 의 문장 기록은 비어 있다 — 보낸 횟수를 세는 fetch 몸을 직접 둔다.
  let sends = 0;
  const slack = new Escalation(new MemoryCredentialStore(), quiet, async () => {
    sends += 1;
    return new Response("ok");
  });
  await slack.set({ kind: "webhook", url: "https://hooks.example/test" });
  let now = 1_000_000;
  const notice = new DeveloperNotice(deps({ slack, now: () => now }));
  const raise = (detail: string) =>
    notice.raise({ key: "disk:low", slug: null, ...describeProblem("disk:low", detail) });

  assert.equal(await raise("여유 1.0GB"), "slack");
  assert.equal(sends, 1);
  // 10분 창을 훌쩍 넘어도(다른 프로젝트의 감독자가 올린다) 하루 안에는 쓰지
  // 않는다 — 문제는 기계 하나의 것이므로 알림도 하나다.
  now += 3 * 60 * 60_000;
  assert.equal(await raise("여유 1.0GB"), "slack");
  assert.equal(sends, 1, "하루 안의 다시 나기는 쓰지 않는다");
  // 다음 날 — 여전히 모자라다고 갱신한다(Escalation 의 같은 문장 10분 창을
  // 피해 문장을 바꾼다 — 실사에서는 detail 이 오늘의 여유를 실어 매번 다르다).
  now += 22 * 60 * 60_000;
  assert.equal(await raise("여유 0.9GB"), "slack");
  assert.equal(sends, 2);
});

test("넘기기가 성공하면 서 있던 submit:pr 알림을 거둔다", async () => {
  const remote = await makeRemote();
  const clone = await makeClone(remote);
  try {
    const github = new MemoryGitHub(remote);
    const core = makeCore(clone, remote, { github });
    // 사이클 브랜치에 커밋 하나 — 넘길 것이 있어야 runHandoff 가 돈다.
    const branch = "colo-design/20260924-1";
    execFileSync("git", ["checkout", "-b", branch], { cwd: clone.path });
    writeFileSync(join(clone.path, "screen.tsx"), "export default () => null;\n");
    execFileSync("git", ["add", "-A"], { cwd: clone.path });
    execFileSync("git", ["commit", "-m", "화면"], { cwd: clone.path });
    core.setCycle(branch, null);
    const resolved: string[] = [];
    const publish = new PublishCycle(core, {
      machineMemo: async () => null,
      resolveNotice: (key) => resolved.push(key),
    });
    const status = await publish.runHandoff({});
    assert.equal(status.stage, "handed-off");
    assert.deepEqual(resolved, ["submit:pr"]);
    assert.equal(status.handoff?.number, 1);
  } finally {
    clone.dispose();
    remote.dispose();
  }
});
