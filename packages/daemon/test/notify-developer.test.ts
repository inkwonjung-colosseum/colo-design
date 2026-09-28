// PLAN-MCP §3.E 의 E-3 — notify_developer 도구. 인자 정규화 · 결과 문장 ·
// 알림 키는 순수로, 예산은 감독자 장면(가짜 시계)의 원장으로, 배달은
// developer-notice.test.ts 의 가짜 GitHub(MemoryGitHub) 관례로 본다.
// `../dist` 임포트인 이유: node --test 는 src 의 `.js` 지정자를 못 읽는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BROWSER_TOOLS,
  NOTIFY_ASK_MAX,
  NOTIFY_TITLE_MAX,
  NOTIFY_WHAT_MAX,
  normalizeNotifyArgs,
  notifyDeveloperAnswer,
  shortHash,
} from "../dist/browser-tools.js";
import { BUDGETS } from "../dist/budgets.js";
import { MemoryCredentialStore } from "../dist/credentials.js";
import { readLedger } from "../dist/cycle-ledger.js";
import {
  AGENT_NOTICE_KEY_PREFIX,
  DeveloperNotice,
  type DeveloperNoticeDeps,
  isScreenQuietKey,
} from "../dist/developer-notice.js";
import { Escalation } from "../dist/escalation.js";
import { GitHubClient } from "../dist/github.js";
import type { DaemonLogger } from "../dist/log.js";
import { MemoryGitHub, makeRemote, makeSupervisedScene } from "./helpers/cycle-harness.ts";

const quiet: DaemonLogger = { info() {}, warn() {}, error() {} };

// ————— 순수 — 인자 정규화 —————

test("normalizeNotifyArgs — 공백을 걷고 각각의 상한에서 자른다", () => {
  const args = normalizeNotifyArgs({
    title: "  푸시가 막혔습니다  ",
    what: "w".repeat(NOTIFY_WHAT_MAX + 100),
    ask: "봐 주세요",
  });
  assert.deepEqual(args, {
    title: "푸시가 막혔습니다",
    what: "w".repeat(NOTIFY_WHAT_MAX),
    ask: "봐 주세요",
  });
  assert.equal(NOTIFY_TITLE_MAX, 80);
  assert.equal(NOTIFY_ASK_MAX, 300);
});

test("normalizeNotifyArgs — 셋 중 하나라도 비면 쪽지는 나가지 않는다", () => {
  assert.equal(normalizeNotifyArgs({ title: "제목", what: "무엇", ask: "" }), null);
  assert.equal(normalizeNotifyArgs({ title: "   ", what: "무엇", ask: "부탁" }), null);
  assert.equal(normalizeNotifyArgs({ what: "무엇", ask: "부탁" }), null);
  assert.equal(normalizeNotifyArgs({ title: 1, what: "무엇", ask: "부탁" }), null);
  assert.equal(normalizeNotifyArgs({}), null);
});

test("shortHash — 같은 제목은 같은 키, 다른 제목은 다른 키다", () => {
  const first = shortHash("푸시가 막혔습니다");
  assert.equal(first, shortHash("푸시가 막혔습니다"));
  assert.notEqual(first, shortHash("준비가 멈췄습니다"));
  // 여덟 글자 16진수 — 알림 키의 뒷부분으로 읽기 좋은 길이.
  assert.match(first, /^[0-9a-f]{8}$/);
});

test("notifyDeveloperAnswer — 닿은 길은 알렸고, none 은 닿지 못했다고 말한다", () => {
  assert.equal(notifyDeveloperAnswer("issue"), "개발자에게 알렸어요");
  assert.equal(notifyDeveloperAnswer("pr"), "개발자에게 알렸어요");
  assert.equal(notifyDeveloperAnswer("slack"), "개발자에게 알렸어요");
  assert.equal(
    notifyDeveloperAnswer("none"),
    "개발자에게 닿지 못했어요 — 답변에 이유를 적어 두십시오",
  );
});

// ————— 도구 계약 —————

test("notify_developer 도구 — 세 인자가 모두 필수고 op 는 notifyDeveloper 다", () => {
  const tool = BROWSER_TOOLS.find((entry) => entry.name === "notify_developer");
  assert.equal(tool?.op, "notifyDeveloper");
  assert.deepEqual(tool?.required, ["title", "what", "ask"]);
});

test("BUDGETS.agentNotice — 하루 3통이다", () => {
  assert.deepEqual(BUDGETS.agentNotice, { max: 3, windowMs: 24 * 60 * 60_000 });
});

// ————— 화면 주의 — agent: 키는 문제 문장에 서지 않는다 —————

test("isScreenQuietKey — agent: 접두는 화면 주의에서 조용하다", () => {
  assert.equal(isScreenQuietKey(`${AGENT_NOTICE_KEY_PREFIX}0badc0de`), true);
  assert.equal(isScreenQuietKey("agentish"), false);
  assert.equal(isScreenQuietKey("disk:low"), true);
  assert.equal(isScreenQuietKey("push:behind"), false);
});

test("attentionParts — agent: 알림은 원장에 남지만 주의의 재료에서는 빠진다", async () => {
  const scene = await makeSupervisedScene();
  try {
    const at = "2026-09-28T00:00:00.000Z";
    scene.supervisor.setNotice(`${AGENT_NOTICE_KEY_PREFIX}0badc0de`, {
      via: "issue",
      raisedAt: at,
      count: 1,
    });
    scene.supervisor.setNotice("push:behind", { via: "issue", raisedAt: at, count: 1 });
    const parts = scene.supervisor.attentionParts();
    assert.equal(parts.notices[`${AGENT_NOTICE_KEY_PREFIX}0badc0de`], undefined);
    assert.ok(parts.notices["push:behind"]);
  } finally {
    await scene.dispose();
  }
});

// ————— 예산 — 감독자가 원장(cycle.json budgets)으로 센다 —————

test("spendAgentNotice — 셋째까지 허용, 넷째 거절, 창이 돌면 다시 허용", async () => {
  const scene = await makeSupervisedScene();
  try {
    const t0 = Date.parse("2026-09-28T09:00:00.000Z");
    scene.setNow(t0);
    assert.deepEqual(
      [1, 2, 3].map(() => scene.supervisor.spendAgentNotice()),
      [true, true, true],
    );
    // 넷째는 거절 — 도구가 문장으로 답할 몫이다.
    assert.equal(scene.supervisor.spendAgentNotice(), false);
    // 거절은 창을 늘리지 않는다 — 원장의 마지막 셈은 셋째다.
    const entry = readLedger(scene.ledgerPath).budgets.agentNotice;
    assert.equal(entry?.spent, 3);
    // 창 밖(다음 날)의 첫 셈은 새 사건이다.
    scene.setNow(t0 + BUDGETS.agentNotice.windowMs + 1);
    assert.equal(scene.supervisor.spendAgentNotice(), true);
  } finally {
    await scene.dispose();
  }
});

test("spendAgentNotice — 없던 원장에도 budgets.agentNotice 로 적힌다", async () => {
  const scene = await makeSupervisedScene();
  try {
    scene.setNow(Date.parse("2026-09-28T09:00:00.000Z"));
    assert.equal(scene.supervisor.spendAgentNotice(), true);
    const ledger = readLedger(scene.ledgerPath);
    assert.equal(ledger.budgets.agentNotice?.spent, 1);
    assert.equal(ledger.budgets.agentNotice?.firstAt, "2026-09-28T09:00:00.000Z");
  } finally {
    await scene.dispose();
  }
});

// ————— 배달 — 가짜 GitHub 으로 raise 한 번 —————

/** 슬러그 "app" 하나를 아는 deps — developer-notice.test.ts 의 관례와 같은 모양. */
function deps(over: Partial<DeveloperNoticeDeps> = {}): DeveloperNoticeDeps {
  return {
    github: () => null,
    githubAuthExpired: () => false,
    repoSlug: () => ({ owner: "nova-design", repo: "harness" }),
    project: () => ({ name: "앱", reviewers: ["dev1"], openPr: null }),
    authorName: () => "기획자",
    slack: new Escalation(new MemoryCredentialStore(), quiet, async () => {
      throw new Error("slack 없음");
    }),
    store: () => null,
    logger: quiet,
    ...over,
  };
}

/** 도구가 쓰는 문제의 모양 — server.ts 의 raise 인자와 같은 자리다. */
function agentProblem(title: string) {
  return {
    key: `${AGENT_NOTICE_KEY_PREFIX}${shortHash(title)}`,
    slug: "app" as const,
    title,
    what: "미리보기 서버가 포트를 잡지 못했습니다",
    tried: "AI 가 대화 안에서 시도한 것 — 답변 참조",
    ask: "개발 서버의 포트 사용 규칙을 봐 주세요",
  };
}

test("agent: 쪽지는 이슈로 한 번 나가고, 같은 제목의 재요청은 창 안에서 중복 없다", async () => {
  const remote = await makeRemote();
  try {
    const github = new MemoryGitHub(remote);
    const client = new GitHubClient("t", github);
    let now = Date.parse("2026-09-28T09:00:00.000Z");
    const notice = new DeveloperNotice(deps({ github: () => client, now: () => now }));
    const title = "미리보기가 계속 멈춥니다";
    assert.equal(await notice.raise(agentProblem(title)), "issue");
    assert.equal(github.openIssueCount, 1);
    const issue = github.issue(1);
    assert.ok(issue?.body.includes(`<!-- nova-design:problem ${AGENT_NOTICE_KEY_PREFIX}`));
    assert.ok(issue?.body.includes(`**무엇이** ${agentProblem(title).what}`));
    assert.ok(issue?.body.includes(`**해 본 것** AI 가 대화 안에서 시도한 것 — 답변 참조`));
    // 같은 제목의 두 번째 쪽지 — 같은 키라 창 안에서는 쓰지 않는다(중복 없음).
    now += 60_000;
    assert.equal(await notice.raise(agentProblem(title)), "issue");
    assert.equal(github.openIssueCount, 1);
    assert.equal(issue?.comments.length, 0);
    // 제목이 다르면 다른 문제 — 새 이슈다.
    assert.equal(await notice.raise(agentProblem("인증이 만료됐습니다")), "issue");
    assert.equal(github.openIssueCount, 2);
  } finally {
    remote.dispose();
  }
});
