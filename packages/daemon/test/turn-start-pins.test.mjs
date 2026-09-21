/**
 * 화면 게이트의 입력이 살아남는가 — 턴 도중의 확인 카드가 그 턴의 핀을
 * 지우지 않는가 (감사 2026-09-19 C1).
 *
 * 결함의 사슬: `Session.handlePermission` 의 settle 이 카드 하나를 정산할
 * 때마다 `setState("running")` 을 다시 방송했고, 서버는 그 방송을 "새 턴"
 * 으로 읽어 `PreviewDrivers.pinnedThisTurn` 을 비웠다. Claude 세션은
 * `default` 모드에 고정돼 대부분의 Bash 가 카드로 오므로, 이것은 예외
 * 경로가 아니라 평상시 경로였다 — 사람이 가리킨 화면이 끝내 재검증되지
 * 않고 "작업이 끝났습니다" 만 나갔다.
 *
 * 계약(수정 후): 턴의 목록은 턴의 시작에서만 비워진다. 턴의 시작을 아는
 * 것은 세션뿐이므로(`send`·`release` 가 turnStartedAt 을 세우는 자리)
 * 세션이 `onTurnStart` 로 말하고, 서버는 그 훅에서만 지운다.
 *
 * Run: node --test packages/daemon/test/turn-start-pins.test.mjs
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

const { Session } = await import("../dist/session.js");
const { PreviewDrivers } = await import("../dist/preview-drivers.js");

// browser-gate.test.mjs 와 같은 이유의 킵얼라이브 — 이 파일의 시험은 전부
// 마이크로태스크 위에서 끝나므로, 앞 파일의 자식이 늦게 죽어 루프가 비는
// 순간과 겹치면 러너 판본에 따라 pending 시험이 일괄 취소된다.
const keepLoopAlive = setTimeout(() => {}, 3_600_000);
after(() => clearTimeout(keepLoopAlive));

/**
 * 서버의 배선을 그대로 흉내 낸 최소 호스트: 세션의 훅 두 개(onTurnStart ·
 * onPinned)를 PreviewDrivers 의 같은 자리에 잇는다. 서버가 `onState` 에서
 * 하던 삭제가 사라졌다는 것이 이 시험의 대상이므로, 여기서도 하지 않는다.
 */
function host() {
  const host = { deleteOnRunning: false };
  const drivers = new PreviewDrivers({
    factory: () => ({ for: () => null, forIsolated: () => null }),
    activeRepo: () => null,
    session: () => undefined,
    sessions: () => [],
    notice: () => undefined,
  });
  const states = [];
  const turnStarts = [];
  const events = {
    onEvent: () => undefined,
    onState: (_id, state) => {
      states.push(state);
      // 옛 배선(결함 재현): 서버는 `running` 방송을 새 턴으로 읽고 목록을
      // 비웠다. 이 줄이 남아 있는 한, running 이 턴당 한 번보다 많이
      // 방송되는 모든 경로에서 현 턴의 핀이 사라진다.
      if (state === "running" && host.deleteOnRunning) drivers.pinnedThisTurn.delete(_id);
    },
    // 새 배선: 턴의 시작에서만 비운다.
    onTurnStart: (sessionId) => {
      turnStarts.push(sessionId);
      drivers.pinnedThisTurn.delete(sessionId);
    },
    onPinned: (sessionId, pins) => {
      for (const pin of pins) drivers.notePinned(sessionId, pin.screen);
    },
    onPermissionRequest: () => undefined,
    onQuestionRequest: () => undefined,
  };
  host.drivers = drivers;
  host.states = states;
  host.turnStarts = turnStarts;
  host.events = events;
  return host;
}

/** 말을 삼키기만 하는 전송 — 턴은 이 시험이 직접 몬다. */
function silentAgent() {
  return {
    alive: true,
    send: async () => undefined,
    interrupt: async () => "answered",
    setMode: async () => undefined,
    close: async () => undefined,
  };
}

function pinnedKeys(drivers, sessionId) {
  return [...(drivers.pinnedThisTurn.get(sessionId)?.values() ?? [])].map((screen) => screen.route);
}

test("턴 도중의 확인 카드를 답해도 그 턴의 핀은 남는다", async () => {
  const { drivers, states, turnStarts, events } = host();
  const session = new Session(
    { cwd: process.cwd(), provider: "claude", providerLabel: "Claude" },
    events,
  );
  session.attach(silentAgent());

  // 1. 핀 2개를 실은 말이 나간다 — deliver 가 onPinned 로 적는다.
  session.send("이 두 화면을 고쳐 주세요", undefined, [
    { screen: "/member/MemberList" },
    { screen: "/pay/PayFailed" },
  ]);
  assert.equal(pinnedKeys(drivers, session.id).length, 2);
  assert.equal(session.state, "running");

  // 2. 턴 도중 에이전트가 Bash 를 부른다 → 확인 카드.
  const card = session.decideBrowserOp("browser_snapshot", new AbortController().signal);
  await Promise.resolve();
  assert.equal(session.state, "waiting_permission");

  // 3. 계획자가 허용을 누른다 — settle 이 running 을 재방송하는 자리.
  const [request] = session.pendingReplays();
  assert.ok(request, "카드가 방송돼야 한다");
  await session.respondPermission(request.requestId, "allow");
  await card;

  // 4. 그 턴의 핀은 그대로여야 한다 — 이것이 수정 전 깨지던 단언이다.
  assert.deepEqual(
    pinnedKeys(drivers, session.id).sort(),
    ["/member/MemberList", "/pay/PayFailed"].sort(),
    "카드 답변이 현 턴의 게이트 입력을 지웠다",
  );
  assert.equal(drivers.gatePossible(session.id), true, "게이트가 걸릴 수 있어야 한다");

  // 근본: 두 신호는 같은 것이 아니다. 한 턴에 턴-시작은 한 번이지만
  // `running` 은 카드를 지나며 여러 번 방송된다 — 삭제를 뒤쪽에 걸었던
  // 것이 결함의 전부다.
  assert.equal(turnStarts.length, 1, "한 턴은 한 번 시작한다");
  assert.equal(
    states.filter((state) => state === "running").length,
    2,
    "카드를 지난 턴은 running 을 두 번 방송한다 — 그래서 삭제를 거기 걸 수 없다",
  );

  await session.close();
});

test("옆 배선(running 에 걸린 삭제)은 정확히 이 핀을 잃었다 — 결함의 재현", async () => {
  // 같은 시나리오를 서버의 옷 배선으로 돌려 본다: 삭제가 `running` 에
  // 걸려 있으면 카드 한 번에 현 턴의 게이트 입력이 통째로 사라진다.
  const h = host();
  h.deleteOnRunning = true;
  const session = new Session(
    { cwd: process.cwd(), provider: "claude", providerLabel: "Claude" },
    h.events,
  );
  session.attach(silentAgent());

  session.send("이 화면을 고쳐 주세요", undefined, [{ screen: "/member/MemberList" }]);
  assert.equal(pinnedKeys(h.drivers, session.id).length, 1);

  const card = session.decideBrowserOp("browser_snapshot", new AbortController().signal);
  await Promise.resolve();
  const [request] = session.pendingReplays();
  await session.respondPermission(request.requestId, "allow");
  await card;

  assert.deepEqual(
    pinnedKeys(h.drivers, session.id),
    [],
    "옷 배선은 카드 한 번에 현 턴의 핀을 잃는다 — 이것이 고친 결함이다",
  );
  assert.equal(h.drivers.gatePossible(session.id), false, "그래서 게이트가 조용히 생략됐다");

  await session.close();
});

test("다음 턴의 시작은 지난 턴의 핀을 비운다", async () => {
  const { drivers, events } = host();
  const session = new Session(
    { cwd: process.cwd(), provider: "claude", providerLabel: "Claude" },
    events,
  );
  session.attach(silentAgent());

  session.send("첫 화면", undefined, [{ screen: "/first" }]);
  assert.deepEqual(pinnedKeys(drivers, session.id), ["/first"]);

  // 턴이 끝나고 사람이 핀 없이 다시 보낸다 — 지난 턴이 가리킨 화면을 다시
  // 판정하면 고치지도 않은 화면을 AI 에게 떠넘기게 된다. 전송의 turn.end
  // 를 모는 대신 턴의 시계만 내려 다음 send 가 새 턴이 되게 한다.
  session.turnStartedAt = null;
  session.send("핀 없는 말");
  assert.deepEqual(pinnedKeys(drivers, session.id), [], "새 턴은 빈 목록으로 시작한다");

  await session.close();
});

test("턴 밖의 카드는 running 을 방송하지 않는다", async () => {
  const { drivers, events, states } = host();
  const session = new Session(
    { cwd: process.cwd(), provider: "claude", providerLabel: "Claude" },
    events,
  );
  session.attach(silentAgent());
  void drivers;

  // 도는 턴이 없다 — 브라우저 op 의 카드만 뜬다.
  const card = session.decideBrowserOp("browser_snapshot", new AbortController().signal);
  await Promise.resolve();
  const [request] = session.pendingReplays();
  await session.respondPermission(request.requestId, "allow");
  await card;

  // 옛 코드는 running → (decideBrowserOp 의 사후 교정) idle 을 연달아
  // 방송했다: 사이드바의 "작업 중" 점멸, 허위 notifyClockAt·트리 무효화.
  assert.equal(
    states.includes("running"),
    false,
    "턴이 없는데 running 이 방송됐다 — 사이드바가 허위로 도는 자리",
  );

  await session.close();
});
