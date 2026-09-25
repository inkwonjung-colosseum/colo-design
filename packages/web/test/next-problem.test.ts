import assert from "node:assert/strict";
import { test } from "node:test";
import type { Attention, RepoStatus } from "@colo-design/protocol";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import { pickAttention, problemFor } from "../src/next/lib/problem.ts";

const REPO: RepoStatus = {
  root: "/tmp/r",
  phase: "ready",
  detail: null,
  previewUrl: "http://127.0.0.1:5274/",
  previewPort: 5274,
  previewEpoch: 1,
  url: null,
  branch: null,
  baseBranch: "main",
  handoff: null,
  pendingChanges: 0,
};

const since = "2026-09-25T00:00:00.000Z";
const fixing: Attention = { kind: "ai-fixing", since };
const notified: Attention = { kind: "developer-notified", since, via: "pr" };
const github: Attention = { kind: "reconnect", since, what: "github" };
const login: Attention = { kind: "reconnect", since, what: "agent-login" };

test("problemFor: 주의가 없으면 문장도 없다", () => {
  assert.equal(problemFor(null, null, L), null);
  assert.equal(problemFor({ attention: null }, REPO, L), null);
});

test("problemFor: 연결 코드 만료는 초대 파일, AI 로그인은 브라우저 로그인", () => {
  const invite = problemFor(null, { ...REPO, attention: github }, L);
  assert.equal(invite?.kind, "reconnect");
  assert.equal(invite?.title, L.problem.reconnect);
  assert.equal(invite?.body, L.problem.reconnectInvite);
  assert.equal(invite?.action, "invite");
  const relogin = problemFor({ attention: login }, REPO, L);
  assert.equal(relogin?.body, L.problem.reconnectLogin);
  assert.equal(relogin?.action, "login");
});

test("problemFor: 다시 연결이 제출 막힘 · 알림 · 고침보다 먼저다", () => {
  const repo = {
    ...REPO,
    attention: fixing,
    submit: { phase: "blocked" as const, attempts: 3, log: [] },
  };
  assert.equal(problemFor({ attention: github }, repo, L)?.kind, "reconnect");
});

test("problemFor: 제출이 막히면 개발자에게 알렸어요 — 제출의 문장", () => {
  const problem = problemFor(
    null,
    {
      ...REPO,
      attention: fixing,
      submit: { phase: "blocked", attempts: 3, lastError: "auth", log: [] },
    },
    L,
  );
  assert.equal(problem?.kind, "notified");
  assert.equal(problem?.title, L.problem.notified);
  assert.equal(problem?.body, L.problem.notifiedSubmit);
  assert.equal(problem?.action, null);
});

test("problemFor: 막히지 않은 제출(retrying)은 문제 문장이 아니다", () => {
  const repo = { ...REPO, submit: { phase: "retrying" as const, attempts: 1, log: [] } };
  assert.equal(problemFor(null, repo, L), null);
});

test("problemFor: 개발자 알림은 다른 문제의 문장", () => {
  const problem = problemFor({ attention: notified }, REPO, L);
  assert.equal(problem?.kind, "notified");
  assert.equal(problem?.body, L.problem.notifiedOther);
});

test("problemFor: AI 고침 — 미리보기가 없으면 미리보기의 문장", () => {
  const down = problemFor(
    null,
    { ...REPO, phase: "starting", previewUrl: null, attention: fixing },
    L,
  );
  assert.equal(down?.kind, "fixing");
  assert.equal(down?.title, L.problem.fixing);
  assert.equal(down?.body, L.problem.fixingPreview);
  const up = problemFor({ attention: fixing }, REPO, L);
  assert.equal(up?.body, L.chat.fixingOther);
});

test("pickAttention: reconnect > developer-notified > ai-fixing, 같은 순위면 프로젝트의 것", () => {
  assert.equal(pickAttention(fixing, notified), notified);
  assert.equal(pickAttention(notified, login), login);
  assert.equal(pickAttention(null, fixing), fixing);
  assert.equal(pickAttention(undefined, null), null);
  const other: Attention = { kind: "ai-fixing", since: "x" };
  assert.equal(pickAttention(fixing, other), fixing);
});
