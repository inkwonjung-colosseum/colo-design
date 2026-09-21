/**
 * 턴 자기치유(감독, 2026-09-19) — 채팅으로 보낸 말이 일시적 오류로 답을 못
 * 받았을 때 도구가 스스로 다시 시도하는 계약.
 *
 * classifyRetry 의 판정(상한 · 영구 실패 · 한도 기다림)과 Session 의 실행
 * (재전송 · 에코 없음 · 중지 우선 · 크래시 재개 요청)을 가짜 에이전트 위에서
 * 잠근다. dispatch.revive 의 상한은 라우터 수준에서.
 *
 * Run: node --test packages/daemon/test/turn-retry.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RequestRouter } from "../dist/dispatch.js";
import { Session } from "../dist/session.js";
import { classifyRetry, looksLikeStreamError } from "../dist/turn-retry.js";

const dir = mkdtempSync(join(tmpdir(), "turn-retry-test-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 실패한 턴의 이벤트 — 세션은 이것을 드라이버에게서 받는다. */
const turnError = (resultText = null) => ({
  kind: "turn.end",
  subtype: "error",
  isError: true,
  costUsd: null,
  numTurns: null,
  durationMs: 10,
  resultText,
});
const turnSuccess = () => ({ ...turnError(), subtype: "success", isError: false });

/** 말을 기록만 하는 가짜 에이전트. */
function fakeAgent() {
  return {
    alive: true,
    sent: [],
    async send(payload) {
      this.sent.push(payload);
    },
    async interrupt() {
      return "answered";
    },
    async close() {},
  };
}

/** 세션 하나와 그 이벤트의 기록. 재시도 간격은 테스트용으로 짧다. */
function makeSession({ agent = fakeAgent(), delays = [5, 5] } = {}) {
  const events = [];
  const states = [];
  const revived = [];
  const session = new Session(
    { cwd: dir, retryDelays: delays, providerLabel: "테스트에이전트" },
    {
      onEvent: (_sessionId, event) => events.push(event),
      onState: (_sessionId, state) => states.push(state),
      onQuestionRequest: () => {},
      onRevive: (sessionId) => revived.push(sessionId),
    },
  );
  session.attach(agent);
  return { session, events, states, revived, agent };
}

const notices = (events) => events.filter((event) => event.kind === "notice");
const echoes = (events) => events.filter((event) => event.kind === "user.echo");

// ---------------------------------------------------------------------------
// classifyRetry — 판정만, 순수하게
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// looksLikeStreamError — 공급자 스트림 오류가 답변 옷을 입고 온 모양 (E2E 2026-09-20)
// ---------------------------------------------------------------------------

const DEVIN_STREAM_ERROR =
  "Devin stream error unavailable: The third-party model provider is experiencing issues " +
  "and is currently not available. Please try this model again later. (error ID: c185d69a)";

test("looksLikeStreamError: 공급자 스트림 오류 문구는 실패로 읽는다", () => {
  assert.equal(looksLikeStreamError(DEVIN_STREAM_ERROR), true);
  assert.equal(looksLikeStreamError("omp stream error: upstream not available"), true);
  assert.equal(looksLikeStreamError("stream error — try the model again later"), true);
});

test("looksLikeStreamError: 정상 답변과 오류를 화제로 다루는 긴 답은 통과시킨다", () => {
  assert.equal(looksLikeStreamError(null), false);
  assert.equal(looksLikeStreamError("공지사항 관리 화면 3개를 만들었습니다."), false);
  assert.equal(
    looksLikeStreamError(
      (
        "스트림 오류는 보통 네트워크 문제입니다. stream error unavailable 를 만나면 " +
        "모델을 바꾸고 다시 시도하세요. "
      ).repeat(30),
    ),
    false,
    "오류를 설명하는 긴 답변은 실패가 아니다",
  );
  assert.equal(looksLikeStreamError("stream error"), false, "근거 문구 없는 말은 판정하지 않는다");
});

test("classifyRetry: 일시적 실패는 첫 백오프로, 상한은 간격의 길이로", () => {
  const now = Date.now();
  assert.deepEqual(
    classifyRetry({ attempt: 0, resultText: "stream error", rateLimit: null, now }),
    {
      action: "retry",
      delayMs: 4_000,
    },
  );
  assert.deepEqual(classifyRetry({ attempt: 1, resultText: null, rateLimit: null, now }), {
    action: "retry",
    delayMs: 16_000,
  });
  assert.deepEqual(
    classifyRetry({ attempt: 2, resultText: "stream error", rateLimit: null, now }),
    {
      action: "stop",
      reason: "exhausted",
    },
  );
});

test("classifyRetry: 같은 말로는 영영 안 되는 실패는 사람에게", () => {
  const decision = classifyRetry({
    attempt: 0,
    resultText: "Prompt is too long: 300000 tokens > 200000 maximum",
    rateLimit: null,
    now: Date.now(),
  });
  assert.deepEqual(decision, { action: "stop", reason: "permanent" });
});

test("classifyRetry: 한도는 재충전 시각을 알 때만 기다린다", () => {
  const now = Date.now();
  const resetsAt = now + 60_000;
  const wait = classifyRetry({
    attempt: 0,
    resultText: "Claude usage limit reached",
    rateLimit: { status: "blocked", resetsAt },
    now,
  });
  assert.equal(wait.action, "wait");
  assert.equal(wait.delayMs, resetsAt + 3_000 - now);
  // 돌아올 시각을 모르는 한도, 15분보다 먼 한도 — 기다림이 아니라 카드.
  assert.deepEqual(
    classifyRetry({
      attempt: 0,
      resultText: "usage limit reached",
      rateLimit: null,
      now,
    }),
    { action: "stop", reason: "limit-no-reset" },
  );
  assert.deepEqual(
    classifyRetry({
      attempt: 0,
      resultText: null,
      rateLimit: { status: "blocked", resetsAt: now + 60 * 60_000 },
      now,
    }),
    { action: "stop", reason: "limit-no-reset" },
  );
  // 이미 지난 재충전 — 백오프로 곧바로 다시.
  const past = classifyRetry({
    attempt: 0,
    resultText: null,
    rateLimit: { status: "blocked", resetsAt: now - 10_000 },
    now,
  });
  assert.equal(past.action, "wait");
  assert.equal(past.delayMs, 4_000);
});

// ---------------------------------------------------------------------------
// Session — 실패한 턴의 실행
// ---------------------------------------------------------------------------

test("Session: 실패한 턴은 같은 말로 스스로 다시 나가고, 에코는 다시 울리지 않는다", async () => {
  const { session, events, states, agent } = makeSession();
  session.send("로그인 화면 만들어 줘");
  assert.equal(agent.sent.length, 1);
  assert.equal(echoes(events).length, 1);

  session.driverHooks.onEvent(turnError("stream error"));
  const retryNotices = notices(events).filter((event) => event.level === "info");
  assert.equal(retryNotices.length, 1);
  assert.match(retryNotices[0].text, /스스로 다시 시도합니다 \(1\/2\)/);

  await sleep(30);
  assert.equal(agent.sent.length, 2);
  assert.equal(agent.sent[1].text, "로그인 화면 만들어 줘");
  assert.equal(echoes(events).length, 1, "재시도는 화면에 같은 말을 두 번 띄우지 않는다");
  assert.ok(states.includes("running"), "재시도는 도는 턴으로 다시 들어간다");
});

test("Session: 상한(두 번)을 채우면 조용히 멈춘다", async () => {
  const { session, events, agent } = makeSession();
  session.send("목록 화면");
  session.driverHooks.onEvent(turnError());
  await sleep(30);
  session.driverHooks.onEvent(turnError());
  await sleep(30);
  session.driverHooks.onEvent(turnError()); // 상한 밖 — 네 번째 전송은 없다
  await sleep(30);
  assert.equal(agent.sent.length, 3, "원래 전송 + 재시도 2회뿐");
  assert.equal(
    notices(events).filter((event) => /스스로 다시 시도합니다/.test(event.text)).length,
    2,
  );
});

test("Session: 성공한 턴은 재시도 상한을 되돌린다", async () => {
  const { session, events, agent } = makeSession();
  session.send("첫 요청");
  session.driverHooks.onEvent(turnError());
  await sleep(30);
  session.driverHooks.onEvent(turnSuccess());
  session.driverHooks.onEvent(turnError()); // 새 실패 — 다시 (1/2)부터
  await sleep(30);
  assert.equal(agent.sent.length, 3);
  const texts = notices(events)
    .filter((event) => /스스로 다시 시도합니다/.test(event.text))
    .map((event) => event.text);
  assert.equal(texts.length, 2);
  assert.match(texts[1], /\(1\/2\)/);
});

test("Session: 오류 문구가 답변으로 도착한 턴은 실패로 갈라 스스로 다시 나간다", async () => {
  // E2E 2026-09-20: 드라이버가 isError 를 못 달아 "Devin stream error
  // unavailable" 가 정상 답변 카드로 남고 재시도도 없었다 — 이 호출계약을 잠근다.
  const { session, events, agent } = makeSession();
  session.send("공지 상세의 등록일을 빼 줘");
  assert.equal(agent.sent.length, 1);
  session.driverHooks.onEvent({
    ...turnSuccess(),
    resultText: DEVIN_STREAM_ERROR,
  });
  const retryNotices = notices(events).filter((event) => event.level === "info");
  assert.equal(retryNotices.length, 1, "성공으로 닫히지 않고 재시도가 예약된다");
  assert.match(retryNotices[0].text, /스스로 다시 시도합니다 \(1\/2\)/);

  await sleep(30);
  assert.equal(agent.sent.length, 2, "같은 말이 스스로 다시 나간다");
  assert.equal(agent.sent[1].text, "공지 상세의 등록일을 빼 줘");
  // 재시도가 성공하면 그 턴은 성공으로 닫힌다 — 실패 판정이 재시도 상한을
  // 되돌리는지도 함께.
  session.driverHooks.onEvent(turnSuccess());
  assert.equal(notices(events).filter((event) => event.level === "info").length, 1);
});

test("Session: 턴이 먼저 정산된 뒤 늦게 답한 카드는 유령 대기에 남기지 않는다", async () => {
  // E2E 2026-09-20 실측: waiting_question 인 채 턴이 끝나면 상태가 내려앉지
  // 않았고, 재시작 뒤엔 카드 없는 '확인 대기' 배지만 남았다. 늦게 도착한 답이
  // 상태를 idle 로 내려놓는다는 호출계약을 잠근다.
  const requests = [];
  const events = [];
  const states = [];
  const session = new Session(
    { cwd: dir, retryDelays: [5, 5], providerLabel: "테스트에이전트" },
    {
      onEvent: (_sessionId, event) => events.push(event),
      onState: (_sessionId, state) => states.push(state),
      onQuestionRequest: (payload) => requests.push(payload),
      onPermissionRequest: (payload) => requests.push(payload),
      onRevive: () => {},
    },
  );
  session.attach(fakeAgent());
  session.send("질문 카드를 띄워 줘");

  const verdict = session.driverHooks.decidePermission(
    { kind: "question", name: "AskUserQuestion" },
    { questions: [{ question: "어느 쪽으로 할까요?", options: [] }] },
    { signal: new AbortController().signal },
  );
  await sleep(10);
  assert.equal(requests.length, 1, "카드 요청이 계획자에게 온다");
  assert.ok(states.includes("waiting_question"), "카드 대기 상태로 들어간다");

  // 턴이 카드보다 먼저 정산된다 — pending 이 남아 있어 상태는 waiting 유지다.
  session.driverHooks.onEvent(turnSuccess());
  assert.equal(session.turnStartedAt, null, "턴은 정산됐다");

  const answered = await session.respondPermission(requests[0].requestId, "deny");
  assert.equal(answered, true);
  assert.equal(session.state, "idle", "늦게 답한 카드는 상태를 idle 로 내려놓는다");
  const outcome = await verdict;
  assert.equal(outcome.behavior, "deny");
});

test("Session: 중지는 재시도보다 우선한다 — 멈춘 턴의 말을 스스로 보내지 않는다", async () => {
  const { session, events, agent } = makeSession();
  session.send("이어서 만들어 줘");
  await session.interrupt();
  session.driverHooks.onEvent(turnError("aborted"));
  await sleep(30);
  assert.equal(agent.sent.length, 1, "중지된 턴은 재시도하지 않는다");
  assert.equal(notices(events).filter((event) => /스스로 다시/.test(event.text)).length, 0);
});

test("Session: 한도로 답이 없으면 재충전 문구로 기다린다", async () => {
  const { session, events, agent } = makeSession();
  session.send("대시보드 화면");
  session.driverHooks.onEvent({
    kind: "ratelimit",
    status: "blocked",
    resetsAt: Date.now() - 5_000,
  });
  session.driverHooks.onEvent(turnError("usage limit reached"));
  await sleep(30);
  assert.ok(
    notices(events).some((event) => /다시 채워지는대로 스스로 이어서/.test(event.text)),
    "한도 안내 문구가 남는다",
  );
  assert.equal(agent.sent.length, 2, "지난 재충전은 곧바로 다시 시도한다");
});

test("Session: 전송 거절도 같은 길로 스스로 다시 나간다", async () => {
  const agent = fakeAgent();
  let refuse = true;
  agent.send = async (payload) => {
    agent.sent.push(payload);
    if (refuse) throw new Error("turn/start refused");
  };
  // 첫 재시도 간격을 넉넉히 — 거절과 재시도 사이에 경합이 없게.
  const { session, events } = makeSession({ agent, delays: [200, 200] });
  session.send("거절될 말"); // 거절 → 스스로 턴을 닫고 재시도를 예약
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (agent.sent.length === 1) {
        refuse = false;
        clearInterval(poll);
        resolve();
      }
    }, 1);
  });
  assert.ok(
    notices(events).some((event) => /스스로 다시 시도합니다/.test(event.text)),
    "거절 직후 재시도 예약이 기록에 남는다",
  );
  await sleep(260); // 예약된 재시도가 이번엔 거절 없이 나간다
  assert.equal(agent.sent.length, 2);
  assert.equal(agent.sent[1].text, "거절될 말");
});

// ---------------------------------------------------------------------------
// Session — 죽은 질의의 재개 요청
// ---------------------------------------------------------------------------

test("Session: 턴 중에 죽으면 재개를 요청하고 마지막 말을 실어 둔다", () => {
  const { session, revived } = makeSession();
  session.send("죽기 직전의 말");
  session.driverHooks.onTransportEnd(null);
  assert.equal(session.state, "error");
  assert.deepEqual(revived, [session.id]);
  assert.deepEqual(session.revivePayload, {
    text: "죽기 직전의 말",
    attachments: [],
    pins: [],
  });
});

test("Session: 도는 턴이 없는 죽음은 재개를 요청하지 않는다", () => {
  const { session, revived } = makeSession();
  session.driverHooks.onTransportEnd(null);
  assert.equal(revived.length, 0);
  assert.equal(session.revivePayload, null);
});

// ---------------------------------------------------------------------------
// dispatch.revive — 상한과 물러남
// ---------------------------------------------------------------------------

/** 죽은 세션을 되살려 주는 최소한의 라우터. */
function makeRouter({ manager }) {
  return new RequestRouter({
    manager,
    fleet: {
      projectInstructions: () => "",
      refreshThreads: () => {},
    },
    agentDrivers: {
      get: () => ({
        isAvailable: async () => ({ ok: true, executable: "/bin/true" }),
      }),
    },
    logger: { warn: () => {}, info: () => {} },
    broadcast: () => {},
  });
}

/** 한 번 죽은 진짜 세션 — revivePayload 가 살아 있는 상태. */
function deadSession() {
  const made = makeSession();
  made.session.send("되살릴 말");
  made.session.driverHooks.onTransportEnd(null);
  return made.session;
}

test("dispatch.revive: 죽은 대화를 같은 말로 새 CLI 에 다시 내려놓는다", async () => {
  const dead = deadSession();
  let created = 0;
  const delivered = [];
  const router = makeRouter({
    manager: {
      get: () => dead,
      close: async () => {},
      create: () => {
        created += 1;
        return {
          id: dead.id,
          providerLabel: "테스트에이전트",
          cwd: dead.cwd,
          title: dead.title,
          chosen: dead.chosen,
          send: (text, attachments, pins) => delivered.push({ text, attachments, pins }),
        };
      },
      invalidateThreads: () => {},
    },
  });
  await router.revive(dead.id);
  assert.equal(created, 1);
  assert.deepEqual(delivered, [{ text: "되살릴 말", attachments: [], pins: [] }]);
});

test("dispatch.revive: 상한(두 번)을 넘기면 사람의 손(카드)에 남긴다", async () => {
  const dead = deadSession();
  const deads = [dead, deadSession(), deadSession()];
  deads[1].id = dead.id;
  deads[2].id = dead.id;
  let index = -1;
  let created = 0;
  const router = makeRouter({
    manager: {
      get: () => deads[index],
      close: async () => {},
      create: () => {
        created += 1;
        return {
          providerLabel: "테스트에이전트",
          cwd: dir,
          title: "t",
          chosen: { model: null, effort: null },
          send: () => {},
        };
      },
      invalidateThreads: () => {},
    },
  });
  for (index of [0, 1, 2]) await router.revive(dead.id);
  assert.equal(created, 2, "세 번째 고장은 스스로 일으키지 않는다");
  // 잊고 나면 다시 — 다음 고장은 새 사건이다
  router.forgetReviveBudget(dead.id);
  await router.revive(dead.id);
  assert.equal(created, 3);
});

test("dispatch.revive: 유예 사이 사람이 먼저 다시 열었다면 물러난다", async () => {
  const dead = deadSession();
  let created = 0;
  const router = makeRouter({
    manager: {
      get: () => dead,
      close: async () => {},
      create: () => {
        created += 1;
        return {
          providerLabel: "테스트에이전트",
          cwd: dir,
          title: "t",
          chosen: { model: null, effort: null },
          send: () => {},
        };
      },
      invalidateThreads: () => {},
    },
  });
  const reviving = router.revive(dead.id);
  await sleep(30);
  dead.state = "running"; // 사람이 (또는 무엇이) 먼저 살렸다
  await reviving;
  assert.equal(created, 0);
});
