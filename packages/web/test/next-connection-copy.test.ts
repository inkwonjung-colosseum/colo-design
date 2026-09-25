import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import { connectionCopy } from "../src/next/lib/connection-copy.ts";

/** 모든 케이스가 함께 보는 기준 시각 — 경계가 실행 속도에 흔들리지 않게. */
const NOW = Date.now();
const DAY = 86_400_000;
/** 기준 `now` 로부터 `days` 일 뒤의 ISO 시각. */
const inDays = (days: number) => new Date(NOW + days * DAY).toISOString();
/** 같은 시각의 현지 날짜 — 문장에 적히는 `N월 N일` 의 원료. */
const localDate = (days: number) => new Date(NOW + days * DAY);

test("connectionCopy: 만료를 모르면 지금 문장 그대로 — 초록 점", () => {
  for (const expiresAt of [null, "말도 안 되는 문장"]) {
    const copy = connectionCopy(
      { expired: false, expiresAt, projects: 3, noticeRoute: "github" },
      NOW,
      L,
    );
    assert.equal(copy.dot, "green");
    assert.equal(copy.text, "연결 정상 · 프로젝트 3개");
  }
});

test("connectionCopy: 15일 이상 남으면 남은 날짜까지 — 초록 점", () => {
  const copy = connectionCopy(
    { expired: false, expiresAt: inDays(20), projects: 2, noticeRoute: "github" },
    NOW,
    L,
  );
  assert.equal(copy.dot, "green");
  const date = localDate(20);
  assert.equal(
    copy.text,
    `연결 정상 · 프로젝트 2개 · ${date.getMonth() + 1}월 ${date.getDate()}일까지`,
  );
});

test("connectionCopy: 14일 안이면 노란 점과 개발자 부탁 — 알림 길에 따라 문장이 다르다", () => {
  const asked = connectionCopy(
    { expired: false, expiresAt: inDays(12), projects: 1, noticeRoute: "github" },
    NOW,
    L,
  );
  assert.equal(asked.dot, "amber");
  assert.equal(asked.text, "연결이 12일 뒤 끝나요 · 개발자에게 새 초대 파일을 부탁했어요");
  const ask = connectionCopy(
    { expired: false, expiresAt: inDays(3), projects: 1, noticeRoute: "none" },
    NOW,
    L,
  );
  assert.equal(ask.dot, "amber");
  assert.equal(ask.text, "연결이 3일 뒤 끝나요 · 개발자에게 새 초대 파일을 부탁하세요");
});

test("connectionCopy: 경계 — 꼭 14일은 노란 점, 15일은 날짜까지(초록)", () => {
  const warn = connectionCopy(
    { expired: false, expiresAt: inDays(14), projects: 1, noticeRoute: "github" },
    NOW,
    L,
  );
  assert.equal(warn.dot, "amber");
  assert.equal(warn.text, "연결이 14일 뒤 끝나요 · 개발자에게 새 초대 파일을 부탁했어요");
  const calm = connectionCopy(
    { expired: false, expiresAt: inDays(15), projects: 1, noticeRoute: "github" },
    NOW,
    L,
  );
  assert.equal(calm.dot, "green");
  const date = localDate(15);
  assert.equal(
    calm.text,
    `연결 정상 · 프로젝트 1개 · ${date.getMonth() + 1}월 ${date.getDate()}일까지`,
  );
});

test("connectionCopy: 지났거나 이미 만료면 다시 연결 문장 — 빨간 점", () => {
  const past = connectionCopy(
    { expired: false, expiresAt: inDays(-1), projects: 1, noticeRoute: "github" },
    NOW,
    L,
  );
  assert.equal(past.dot, "red");
  assert.equal(past.text, L.problem.reconnectInvite);
  const expired = connectionCopy(
    { expired: true, expiresAt: inDays(12), projects: 1, noticeRoute: "github" },
    NOW,
    L,
  );
  assert.equal(expired.dot, "red");
  assert.equal(expired.text, L.problem.reconnectInvite);
});
