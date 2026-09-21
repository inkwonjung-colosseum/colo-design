/**
 * 바로 실어 보내기(steer) — 턴이 도는 중에 온 말이 대기 줄 대신 도는 턴에
 * 실리는 길의 계약. 가짜 에이전트 위에서 세션 코어만 잠근다(와이어 절반은
 * codex 드라이버의 turn/steer, 실사 확인이 필요하다).
 *
 * 이 스위트가 지키는 것:
 *  - steer 실림: 대기 줄에 들르지 않고, 핀은 지금 이 턴의 게이트 입력이
 *    되고, 에코는 실은 순간 한 번만 울린다.
 *  - 길이 없는 에이전트(claude·ACP): 설정이 steer 여도 대기 줄로 물러난다.
 *  - 실지 못한 말(거절): 턴은 그대로 두고 말만 대기 줄로 — 다음 턴이
 *    데려간다는 안내와 함께.
 *
 * Run: node --test packages/daemon/test/midturn-steer.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../dist/session.js";

const dir = mkdtempSync(join(tmpdir(), "midturn-steer-test-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 말을 기록만 하는 가짜 에이전트. `steers` 를 달면 steer 길이 있는
 * 드라이버(codex)의 모양이 되고, `refuseSteer` 로 실어 주지 않는 서버를
 * 흉내 낸다.
 */
function fakeAgent({ steer = true, refuseSteer = false } = {}) {
  const agent = {
    alive: true,
    sent: [],
    steered: [],
    interrupts: 0,
    async send(payload) {
      this.sent.push(payload);
    },
    async interrupt() {
      agent.interrupts += 1;
      return "answered";
    },
    async close() {},
  };
  if (steer) {
    agent.steer = async (payload) => {
      if (refuseSteer) throw new Error("turn/steer refused");
      agent.steered.push(payload);
    };
  }
  return agent;
}

/** 세션 하나와 그 이벤트의 기록. 첫 send 로 연 턴은 스스로 끝나지 않는다. */
function makeSession(agent) {
  const events = [];
  const states = [];
  const turnStarts = [];
  const pinned = [];
  const session = new Session(
    { cwd: dir, providerLabel: "테스트에이전트" },
    {
      onEvent: (_sessionId, event) => events.push(event),
      onState: (_sessionId, state) => states.push(state),
      onTurnStart: (sessionId) => turnStarts.push(sessionId),
      onPinned: (_sessionId, pins) => pinned.push(pins),
    },
  );
  session.attach(agent);
  return { session, events, states, turnStarts, pinned };
}

const echoes = (events) => events.filter((event) => event.kind === "user.echo");
const notices = (events) => events.filter((event) => event.kind === "notice");
const room = (events) => events.filter((event) => event.kind === "queued").at(-1)?.items ?? [];

test("steer: 도는 턴에 온 말은 대기 줄을 거치지 않고 그 턴에 실린다", async () => {
  const agent = fakeAgent();
  const { session, events, turnStarts } = makeSession(agent);
  session.send("오래 걸리는 작업 시작해 줘");
  assert.equal(agent.sent.length, 1, "첫 말은 새 턴으로 나간다");

  session.send("그동안 이것도 확인해 줘", undefined, undefined, "steer");
  await sleep(10);

  assert.deepEqual(
    agent.steered.map((turn) => turn.text),
    ["그동안 이것도 확인해 줘"],
    "steer 가 실어 나른다",
  );
  assert.equal(room(events).length, 0, "대기 줄에 들르지 않는다");
  assert.equal(
    echoes(events).filter((event) => event.text === "그동안 이것도 확인해 줘").length,
    1,
    "실은 순간 에코가 한 번 울린다",
  );
  assert.equal(turnStarts.length, 1, "새 턴이 열리지 않는다 — 도는 턴에 실린다");
});

test("steer: 핀은 지금 도는 턴의 게이트 입력이 된다", async () => {
  const agent = fakeAgent();
  const { session, pinned } = makeSession(agent);
  session.send("화면 고치기", undefined, [{ screen: "/list" }]);
  session.send("이 화면도", undefined, [{ screen: "/pay" }], "steer");
  await sleep(10);

  assert.deepEqual(pinned.at(-1), [{ screen: "/pay" }], "steer 의 핀도 실리는 순간 기록된다");
});

test("steer 폴백: 길이 없는 에이전트는 도는 턴을 끊고 그 말을 첫 새 턴으로 세운다", async () => {
  const agent = fakeAgent({ steer: false });
  const { session, events } = makeSession(agent);
  session.send("첫 말");
  session.send("기다리던 말", undefined, undefined, "queue");
  session.send("바로 가야 할 말", undefined, undefined, "steer");
  await sleep(10);

  assert.equal(agent.interrupts, 1, "도는 턴을 끊는다 — 지금 보내기와 같은 기계다");
  assert.deepEqual(
    room(events).map((item) => item.text),
    ["바로 가야 할 말", "기다리던 말"],
    "steer 말이 대기 줄 맨 앞에 선다",
  );
  assert.equal(agent.sent.length, 1, "끊긴 턴이 닫히기 전에는 나가지 않는다");
  assert.equal(
    echoes(events).some((event) => event.text === "바로 가야 할 말"),
    false,
    "에코는 제 턴이 열리며 울린다",
  );

  // 끊긴 턴이 닫히면 방의 맨 앞 한 건만 나가므로 steer 말이 제 턴으로 나간다.
  session.driverHooks.onEvent({
    kind: "turn.end",
    subtype: "interrupted",
    isError: false,
    costUsd: null,
    numTurns: null,
    durationMs: 5,
    resultText: null,
  });
  await sleep(10);
  assert.deepEqual(
    agent.sent.at(-1)?.text,
    "바로 가야 할 말",
    "끊긴 턴의 끝에서 첫 새 턴으로 즉시 나간다",
  );
  assert.deepEqual(
    room(events).map((item) => item.text),
    ["기다리던 말"],
    "나머지는 그 뒤의 턴을 기다린다",
  );
});

test("steer: 실지 못한 말은 턴을 건드리지 않고 대기 줄로 물러난다", async () => {
  const agent = fakeAgent({ refuseSteer: true });
  const { session, events } = makeSession(agent);
  session.send("첫 말");
  session.send("끼어들어 줘", undefined, undefined, "steer");
  await sleep(10);

  assert.deepEqual(
    room(events).map((item) => item.text),
    ["끼어들어 줘"],
    "거절된 말은 대기 줄에 다시 선다",
  );
  const warn = notices(events).find((event) => event.level === "warn");
  assert.ok(warn, "왜 대기 줄로 갔는지 말해 준다");
  assert.match(warn.text, /대기 줄에 두었습니다/);
  assert.equal(
    events.some((event) => event.kind === "turn.end"),
    false,
    "도는 턴은 그대로 산다 — 거절은 턴의 실패가 아니다",
  );
  assert.equal(
    echoes(events).some((event) => event.text === "끼어들어 줘"),
    false,
    "실리지 못한 말은 화면에 울리지 않는다",
  );
});

test("기본: mode 없이 보낸 말은 여전히 대기 줄에 선다", () => {
  const agent = fakeAgent();
  const { session, events } = makeSession(agent);
  session.send("첫 말");
  session.send("기다려 줘");

  assert.equal(agent.steered.length, 0, "기본 길은 대기 줄이다");
  assert.deepEqual(
    room(events).map((item) => item.text),
    ["기다려 줘"],
  );
});

test("기본: 턴이 끝나면 대기 줄의 맨 앞 한 건만 나간다", async () => {
  const agent = fakeAgent();
  const { session, events } = makeSession(agent);
  session.send("첫 말");
  session.send("둘째 말");
  session.send("셋째 말");
  await sleep(10);
  assert.deepEqual(
    room(events).map((item) => item.text),
    ["둘째 말", "셋째 말"],
    "도는 턴에 온 말은 방에서 기다린다",
  );

  // 첫 턴의 끝 — 방이 여러 건이어도 맨 앞의 한 건만 나간다.
  session.driverHooks.onEvent({
    kind: "turn.end",
    subtype: "success",
    isError: false,
    costUsd: null,
    numTurns: null,
    durationMs: 5,
    resultText: "첫 답",
  });
  await sleep(10);
  assert.deepEqual(
    agent.sent.map((turn) => turn.text),
    ["첫 말", "둘째 말"],
    "맨 앞의 한 건만 나간다 — 나머지와 한 턴에 묶이지 않는다",
  );
  assert.deepEqual(
    room(events).map((item) => item.text),
    ["셋째 말"],
    "나머지는 그 턴의 끝을 기다린다",
  );

  // 둘째 턴의 끝 — 그제서야 다음 한 건이 나간다.
  session.driverHooks.onEvent({
    kind: "turn.end",
    subtype: "success",
    isError: false,
    costUsd: null,
    numTurns: null,
    durationMs: 5,
    resultText: "둘째 답",
  });
  await sleep(10);
  assert.deepEqual(
    agent.sent.map((turn) => turn.text),
    ["첫 말", "둘째 말", "셋째 말"],
    "각 말은 제 턴으로 차례로 나간다",
  );
  assert.equal(room(events).length, 0, "방은 마침내 비운다");
});
