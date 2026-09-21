/**
 * 개발자 에스컬레이션 (슬라이스 5) — 환경 실패를 Slack 으로 흘리는 문의 계약.
 * 웹훅과 봇 토큰 두 붙는 법, 저장소 왕복, 같은 문장 10분 방지, Slack 의
 * 200 {ok:false} 규칙까지 가짜 fetch 위에서 잠근다.
 *
 * Run: node --test packages/daemon/test/escalation.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryCredentialStore } from "../dist/credentials.js";
import { ESCALATION_ITEM, Escalation } from "../dist/escalation.js";

const logger = { info: () => {}, warn: () => {} };

/** 받은 요청을 기록하는 가짜 fetch — 테스트가 매 번 갈아 끼운다. */
function fakeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return calls;
}

const ok = () => new Response("ok", { status: 200 });

test("웹훅: 설정한 주소로 {text} 가 나간다", async () => {
  const calls = fakeFetch(ok);
  const escalation = new Escalation(new MemoryCredentialStore(), logger);
  await escalation.set({ kind: "webhook", url: "https://hooks.slack.com/services/T/B/X" });
  assert.equal(await escalation.notify("[Colo Design] 토큰 만료"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hooks.slack.com/services/T/B/X");
  assert.equal(JSON.parse(calls[0].init.body).text, "[Colo Design] 토큰 만료");
});

test("봇: chat.postMessage 에 토큰과 채널이 실린다 — ok:false 는 실패다", async () => {
  const calls = fakeFetch(() => Response.json({ ok: true }));
  const escalation = new Escalation(new MemoryCredentialStore(), logger);
  await escalation.set({ kind: "bot", token: "xoxb-1", channel: "#개발-알림" });
  assert.equal(await escalation.notify("첫 넘기기 실패"), true);
  assert.equal(calls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(calls[0].init.headers.authorization, "Bearer xoxb-1");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    channel: "#개발-알림",
    text: "첫 넘기기 실패",
  });

  // Slack 은 실패도 200 으로 답한다 — ok:false 가 진짜 판정이다.
  fakeFetch(() => Response.json({ ok: false, error: "channel_not_found" }));
  assert.equal(await escalation.notify("다른 문장"), false);
});

test("같은 문장은 10분에 한 번 — 다른 문장은 바로 간다", async () => {
  const calls = fakeFetch(ok);
  const escalation = new Escalation(new MemoryCredentialStore(), logger);
  await escalation.set({ kind: "webhook", url: "https://hooks.slack.com/x" });
  const now = 1_000_000;
  assert.equal(await escalation.notify("고장", now), true);
  assert.equal(await escalation.notify("고장", now + 60_000), true, "10분 안은 재울림 없음");
  assert.equal(await escalation.notify("다른 고장", now + 60_000), true);
  assert.equal(await escalation.notify("고장", now + 11 * 60_000), true, "창이 지나면 다시");
  assert.equal(calls.length, 3);
});

test("설정은 저장소를 왕복한다 — 끄면 지워지고 깨진 줄은 없는 것이다", async () => {
  const store = new MemoryCredentialStore();
  const escalation = new Escalation(store, logger);
  await escalation.set({ kind: "bot", token: "xoxb-2", channel: "C123" });
  const reborn = new Escalation(store, logger);
  await reborn.load();
  assert.equal(reborn.configured, true);
  await reborn.set(null);
  assert.equal(reborn.configured, false);
  assert.equal(await store.load(ESCALATION_ITEM), null);

  await store.save(ESCALATION_ITEM, "{깨진");
  const broken = new Escalation(store, logger);
  await broken.load();
  assert.equal(broken.configured, false, "깨진 저장은 시작을 막지 않는다");
});

test("설정이 없거나 채널이 죽어도 조용하다 — false 가 답, 예외가 아니다", async () => {
  const bare = new Escalation(new MemoryCredentialStore(), logger);
  assert.equal(await bare.notify("아무 설정 없음"), false);
  const escalation = new Escalation(new MemoryCredentialStore(), logger);
  await escalation.set({ kind: "webhook", url: "https://hooks.slack.com/x" });
  fakeFetch(() => {
    throw new Error("network down");
  });
  assert.equal(await escalation.notify("채널 사망"), false);
});
