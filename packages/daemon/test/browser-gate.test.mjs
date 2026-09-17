/**
 * 브라우저 게이트의 단위 검사 — Session.decideBrowserOp 가 민감 브라우저 op를
 * 세션의 권한 카드 흐름(other-kind 도구)으로 보내는지, 카드가 정산된 뒤 턴이
 * 없는 방의 상태를 거둬 들이는지 본다. 데몬 경계(/internal/browser)의 게이트
 * 배선도 같이 잠근다: 실행 직전의 표면 판정(비-레포 표면의 모든 op 는 카드,
 * 레포 표면은 무카드), 이동의 바깥 착지 안내, type 의 clear 기본 덮어쓰기,
 * op 타임아웃의 큐 꼬리 교체와 드라이버 recover.
 *
 * Usage: node --test packages/daemon/test/browser-gate.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { Session } = await import("../dist/session.js");

/**
 * The prototype-call stub pattern security.test.mjs established: the gate is
 * a thin path over handlePermission, so a stub `this` with a spying
 * handlePermission pins the contract without a driver in the way.
 */
function gateStub({ verdict, state = "running", turnStartedAt = null }) {
  const seen = { calls: [], stateChanges: [] };
  const stub = {
    handlePermission: (tool, input, opts) => {
      seen.calls.push({ tool, input, signal: opts.signal });
      return Promise.resolve(verdict);
    },
    state,
    turnStartedAt,
    setState: (next) => {
      seen.stateChanges.push(next);
      stub.state = next;
    },
  };
  return { stub, seen };
}

test("decideBrowserOp asks via the permission card as an other-kind tool", async () => {
  const { stub, seen } = gateStub({
    verdict: { behavior: "deny", message: "사용자가 거절했습니다." },
  });
  const verdict = await Session.prototype.decideBrowserOp.call(
    stub,
    "browser_evaluate",
    new AbortController().signal,
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.message, "사용자가 거절했습니다.");
  assert.equal(seen.calls.length, 1);
  assert.equal(seen.calls[0].tool.kind, "other");
  assert.equal(seen.calls[0].tool.name, "browser_evaluate");
  assert.equal(seen.calls[0].input.op, "browser_evaluate");
  assert.ok(seen.calls[0].signal instanceof AbortSignal);
});

test("an allow verdict passes with no message", async () => {
  const { stub, seen } = gateStub({ verdict: { behavior: "allow", updatedInput: {} } });
  const verdict = await Session.prototype.decideBrowserOp.call(
    stub,
    "browser_screenshot",
    new AbortController().signal,
  );
  assert.deepEqual(verdict, { allowed: true, message: null });
  assert.equal(seen.calls[0].tool.name, "browser_screenshot");
});

test("an idle room settles back to idle; a running turn keeps its lamp", async () => {
  // 턴 없는 방 — handlePermission 의 settle 이 running 으로 놓은 상태를
  // decideBrowserOp 가 거둔다. 아니면 램프가 영원히 도는 죽은 방이 된다.
  const idle = gateStub({ verdict: { behavior: "allow", updatedInput: {} } });
  await Session.prototype.decideBrowserOp.call(
    idle.stub,
    "browser_snapshot",
    new AbortController().signal,
  );
  assert.deepEqual(idle.seen.stateChanges, ["idle"]);

  // 도는 턴이 있는 방 — 상태를 건드리지 않는다. 턴의 끝은 턴이 스스로 말한다.
  const busy = gateStub({
    verdict: { behavior: "allow", updatedInput: {} },
    turnStartedAt: Date.now(),
  });
  await Session.prototype.decideBrowserOp.call(
    busy.stub,
    "browser_snapshot",
    new AbortController().signal,
  );
  assert.deepEqual(busy.seen.stateChanges, []);
});

// ── 데몬 경계(/internal/browser) — onInternalBrowser 의 게이트 배선 ─────
// browser-gate 의 prototype-call stub 패턴 그대로: onInternalBrowser 가 `this`
// 에서 읽는 것은 browserSecrets·config.browserDriverFactory·browserOps·
// manager.get·drivers.notePinned·broadcast 뿐이므로, 가짜 드라이버와 가짜
// 세션을 심어 진짜 배선을 그대로 돌린다.

const { DaemonServer } = await import("../dist/server.js");

const ENDPOINT_SECRET = "endpoint-secret-0123456789";
const ROOM = "room-1";

/** /internal/browser 본문 — 권한 카드로 정산되는 가짜 세션. */
function cardSession({ verdict }) {
  const seen = { ops: [] };
  const session = {
    decideBrowserOp: (op) => {
      seen.ops.push(op);
      return Promise.resolve(verdict);
    },
  };
  return { session, seen };
}

/** BrowserDriver 가짜 — 부른 op와 인자를 기록하고, recover 를 센다. */
function fakeDriver(overrides = {}) {
  const seen = { calls: [], recovers: 0 };
  const record = (name) => async (arg) => {
    seen.calls.push([name, arg]);
    return name === "navigate" ? { settled: true, snapshot: [] } : [];
  };
  const driver = {
    seen,
    isRepoSurface: () => true,
    navigate: record("navigate"),
    back: record("back"),
    forward: record("forward"),
    snapshot: async () => {
      seen.calls.push(["snapshot", undefined]);
      return [];
    },
    type: async (input) => {
      seen.calls.push(["type", input]);
      return [];
    },
    scroll: record("scroll"),
    consoleLines: async () => {
      seen.calls.push(["consoleLines", undefined]);
      return [];
    },
    evaluate: async (fn) => {
      seen.calls.push(["evaluate", fn]);
      return 1;
    },
    waitFor: async (target) => {
      seen.calls.push(["waitFor", target]);
      return true;
    },
    recover: () => {
      seen.recovers += 1;
    },
  };
  Object.assign(driver, overrides);
  return driver;
}

/** onInternalBrowser 가 `this`에서 읽는 것만 심은 데몬 뼈대. */
function endpointStub({ driver, session }) {
  const seen = { pins: [], broadcasts: [] };
  return {
    seen,
    browserSecrets: new Map([[ENDPOINT_SECRET, { sessionId: ROOM, issuedAt: Date.now() }]]),
    config: { browserDriverFactory: { forPane: () => driver } },
    browserOps: new Map(),
    manager: { get: () => session ?? null },
    drivers: { notePinned: (...args) => seen.pins.push(args) },
    broadcast: (message) => seen.broadcasts.push(message),
  };
}

/** 가짜 요청·응답 — headers/비동기 순회와 writeHead/end 만 흉내 낸다. */
function wire(secret, body) {
  const response = {
    status: 0,
    body: null,
    writeHead(status) {
      response.status = status;
    },
    end(raw) {
      response.body = JSON.parse(raw);
    },
  };
  const request = {
    headers: { authorization: `Bearer ${secret}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
  return { request, response };
}

const GATED_OPS = [
  ["scroll", { dy: 0 }],
  ["snapshot", {}],
  ["consoleLines", {}],
  ["waitFor", { text: "완료" }],
  ["evaluate", { fn: "() => 1" }],
];

test("비-레포 표면의 모든 op는 실행 직전 카드를 지난다 — 레포 표면은 지나지 않는다", async () => {
  const allowed = { allowed: true, message: null };

  // 바깥 화면: scroll{dy:0} 한 줄도 페이지 전체를 실어 나르므로 op 종류와
  // 무관하게 카드가 먼저다.
  for (const [op, params] of GATED_OPS) {
    const driver = fakeDriver({ isRepoSurface: () => false });
    const gate = cardSession({ verdict: allowed });
    const server = endpointStub({ driver, session: gate.session });
    const { request, response } = wire(ENDPOINT_SECRET, { op, params });
    await DaemonServer.prototype.onInternalBrowser.call(server, request, response);
    assert.equal(response.body.ok, true, `${op}: 카드 통과 뒤 실행된다`);
    assert.deepEqual(gate.seen.ops, [`browser_${op}`], `${op}: 카드는 op 이름을 걸고 한 번 지난다`);
    assert.deepEqual(
      driver.seen.calls.map(([name]) => name),
      [op],
      `${op}: 카드 뒤 드라이버가 정확히 한 번 불린다`,
    );
  }

  // 레포의 화면: 같은 op들이 카드 없이 곧장 실행된다.
  for (const [op, params] of GATED_OPS) {
    const driver = fakeDriver();
    const gate = cardSession({ verdict: allowed });
    const server = endpointStub({ driver, session: gate.session });
    const { request, response } = wire(ENDPOINT_SECRET, { op, params });
    await DaemonServer.prototype.onInternalBrowser.call(server, request, response);
    assert.equal(response.body.ok, true, `${op}: 레포 표면의 실행은 성공`);
    assert.deepEqual(gate.seen.ops, [], `${op}: 레포 표면은 카드를 모른다`);
  }
});

test("카드 거절은 op를 실행하지 않고 거절 문구로 답한다", async () => {
  const driver = fakeDriver({ isRepoSurface: () => false });
  const gate = cardSession({ verdict: { allowed: false, message: "사용자가 거절했습니다." } });
  const server = endpointStub({ driver, session: gate.session });
  const { request, response } = wire(ENDPOINT_SECRET, { op: "snapshot", params: {} });
  await DaemonServer.prototype.onInternalBrowser.call(server, request, response);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "사용자가 거절했습니다.");
  assert.deepEqual(driver.seen.calls, [], "거절된 op는 드라이버에 닿지 않는다");
});

test("navigate는 레포 착지에 스냅샷을, 바깥 착지에 안내를 내린다", async () => {
  // 레포 → 레포: 카드 없이, 스냅샷이 그대로 내려온다.
  const inside = fakeDriver();
  inside.navigate = async () => ({
    settled: true,
    snapshot: [{ ref: "e1", role: "button", name: "저장", states: [], children: [] }],
  });
  const insideGate = cardSession({ verdict: { allowed: true, message: null } });
  const insideServer = endpointStub({ driver: inside, session: insideGate.session });
  const insideWire = wire(ENDPOINT_SECRET, {
    op: "navigate",
    params: { url: "http://127.0.0.1:4100/" },
  });
  await DaemonServer.prototype.onInternalBrowser.call(
    insideServer,
    insideWire.request,
    insideWire.response,
  );
  assert.deepEqual(insideGate.seen.ops, [], "시작 표면이 레포면 이동에 카드가 없다");
  assert.deepEqual(insideWire.response.body.result, {
    settled: true,
    snapshot: [{ ref: "e1", role: "button", name: "저장", states: [], children: [] }],
  });

  // 레포 → 바깥: 이동 자체는 카드 없이 허용, 하지만 스냅샷은 실지 않고
  // 다시 읽는 법(browser_snapshot 재호출)을 안내한다.
  const roaming = fakeDriver();
  roaming.isRepoSurface = () => !roaming.seen.calls.some(([name]) => name === "navigate");
  const roamingGate = cardSession({ verdict: { allowed: true, message: null } });
  const roamingServer = endpointStub({ driver: roaming, session: roamingGate.session });
  const roamingWire = wire(ENDPOINT_SECRET, {
    op: "navigate",
    params: { url: "https://example.com/out" },
  });
  await DaemonServer.prototype.onInternalBrowser.call(
    roamingServer,
    roamingWire.request,
    roamingWire.response,
  );
  assert.deepEqual(roamingGate.seen.ops, [], "바깥으로 나가는 이동 자체는 카드 없이 허용된다");
  const landed = roamingWire.response.body.result;
  assert.deepEqual(
    Object.keys(landed).sort(),
    ["note", "settled"],
    "바깥 착지의 답은 착지 사실과 안내뿐이다 — 스냅샷이 없다",
  );
  assert.equal("snapshot" in landed, false);
  assert.ok(landed.note.includes("browser_snapshot"), "안내는 다시 읽는 법을 알려준다");

  // back도 같다 — 스냅샷 대신 안내(settled 조차 없다).
  const backDriver = fakeDriver();
  backDriver.isRepoSurface = () => !backDriver.seen.calls.some(([name]) => name === "back");
  const backGate = cardSession({ verdict: { allowed: true, message: null } });
  const backServer = endpointStub({ driver: backDriver, session: backGate.session });
  const backWire = wire(ENDPOINT_SECRET, { op: "back", params: {} });
  await DaemonServer.prototype.onInternalBrowser.call(
    backServer,
    backWire.request,
    backWire.response,
  );
  assert.deepEqual(Object.keys(backWire.response.body.result), ["note"]);
  assert.ok(backWire.response.body.result.note.includes("browser_snapshot"));
});

test("type의 clear는 생략하면 덮어쓴다 — false로만 지울 수 있다", async () => {
  const cases = [
    [{}, true, "clear 생략은 덮어쓰기다"],
    [{ clear: false }, false, "false로 명시할 때만 지우지 않는다"],
    [{ clear: true }, true, "true는 그대로 전한다"],
  ];
  for (const [given, expected, why] of cases) {
    const driver = fakeDriver();
    const server = endpointStub({ driver, session: null });
    const { request, response } = wire(ENDPOINT_SECRET, {
      op: "type",
      params: { ref: "e1", text: "안녕", ...given },
    });
    await DaemonServer.prototype.onInternalBrowser.call(server, request, response);
    assert.equal(response.body.ok, true);
    assert.deepEqual(
      driver.seen.calls[0],
      ["type", { ref: "e1", text: "안녕", clear: expected }],
      why,
    );
  }
});

test("op가 시간을 넘기면 큐 꼬리를 갈아치우고 드라이버를 복구한다", async () => {
  // 데몬의 op 상한(90s)은 상수라 기다릴 수 없다 — 이 시험 창에서만
  // setTimeout을 짧게 깎아 타임아웃 경로를 걸어 본다(끝나면 복구).
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) =>
    realSetTimeout(fn, Math.min(Number(ms) || 0, 25), ...rest);
  try {
    const driver = fakeDriver();
    let snapshotCalls = 0;
    driver.snapshot = () => {
      snapshotCalls += 1;
      // 첫 op는 영원히 — 90초 상한에 걸려야 할 몸종. 둘째 op는 곧 답한다.
      return snapshotCalls === 1 ? new Promise(() => {}) : Promise.resolve([]);
    };
    const server = endpointStub({ driver, session: null });

    // 멈춘 op — 타임아웃으로 ok:false, 그리고 recover.
    const hung = wire(ENDPOINT_SECRET, { op: "snapshot", params: {} });
    await DaemonServer.prototype.onInternalBrowser.call(server, hung.request, hung.response);
    assert.equal(hung.response.body.ok, false);
    assert.equal(hung.response.body.error, "브라우저 명령이 시간을 넘겼습니다.");
    assert.equal(
      driver.seen.recovers,
      1,
      "타임아웃 뒤 드라이버를 복구한다(디버거 탈부착·ref 세대 청소)",
    );

    // 꼬리 교체의 증거 — 멈춘 op가 아직 돌아오지 않았어도 다음 op는 곧 답한다.
    const followup = wire(ENDPOINT_SECRET, { op: "snapshot", params: {} });
    const answer = await Promise.race([
      DaemonServer.prototype.onInternalBrowser
        .call(server, followup.request, followup.response)
        .then(() => "answered"),
      new Promise((_resolve, reject) => {
        realSetTimeout(
          () => reject(new Error("타임아웃 뒤 큐가 막혔다 — 꼬리 교체가 없다")),
          2_000,
        );
      }),
    ]);
    assert.equal(answer, "answered");
    assert.equal(followup.response.body.ok, true);
    assert.equal(
      driver.seen.recovers,
      1,
      "복구는 타임아웃 한 번분만이다 — 정상 op가 다시 복구하지 않는다",
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
