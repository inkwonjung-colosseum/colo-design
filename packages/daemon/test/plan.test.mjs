/**
 * 계획 모드의 승인 루프, 오프라인 단위: ExitPlanMode 는 항상 허용의 우위를
 * 받지 않고 계획 카드로 가고, 승인은 모드 복귀를 착수보다 먼저 맺으며, 거절은
 * 계획 모드에 머문다. 세션 전체는 plan-e2e.mjs 가 실제 와이어 위에서 검사한다.
 *
 * Usage: node --test packages/daemon/test/plan.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { Session } = await import("../dist/session.js");
const { PLAN_TOOL } = await import("../../protocol/dist/index.js");

/**
 * A stub `this` carrying one pending plan request and a spying run — the
 * prototype-call pattern security.test.mjs established for the permission
 * choke point.
 */
function planSession({ mode = "plan", modeBeforePlan = "bypassPermissions" } = {}) {
  const seen = { modeCalls: [], resolved: null };
  const stub = {
    agent: {
      setMode: async (m) => {
        seen.modeCalls.push(m);
      },
    },
    providerModeId: mode,
    modeBeforePlan,
    planModeId: "plan",
    defaultModeId: "default",
    pending: new Map([
      [
        "req-1",
        {
          requestId: "req-1",
          kind: "plan",
          toolName: PLAN_TOOL,
          suggestions: [],
          input: { plan: "1. 레이아웃 2. 폼" },
          resolve: (outcome) => {
            seen.resolved = outcome;
          },
        },
      ],
    ]),
  };
  // respondPermission 은 인스턴스 메서드인 setMode 로 복귀한다 — 복귀 대상은
  // 이 공급자의 모드 id 이지 Claude 열거형이 아니다(감사 C5). 스텁에도 진짜
  // 프로토타입 메서드를 심어 같은 장부를 쓰게 한다.
  stub.setMode = Session.prototype.setMode;
  return { stub, seen };
}

test("decidePermission routes ExitPlanMode to a plan card even when 항상 허용 remembers it", async () => {
  let captured = null;
  const ask = {
    alwaysAllowed: { allows: () => true },
    handlePermission: (tool, input) => {
      captured = { tool, input };
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    },
  };
  const signal = new AbortController().signal;
  const verdict = await Session.prototype.decidePermission.call(
    ask,
    { kind: "plan", name: PLAN_TOOL },
    { plan: "1. 화면 2. 상태" },
    { signal },
  );
  assert.equal(captured.tool.name, PLAN_TOOL, "the plan went to a card, not to the memory");
  assert.equal(verdict.behavior, "allow");
});

test("respondPermission allow restores the working mode BEFORE resolving the plan", async () => {
  const { stub, seen } = planSession();
  const ok = await Session.prototype.respondPermission.call(stub, "req-1", "allow");
  assert.equal(ok, true);
  assert.deepEqual(seen.modeCalls, ["bypassPermissions"], "one restore, the stashed mode");
  assert.equal(stub.providerModeId, "bypassPermissions");
  assert.equal(stub.modeBeforePlan, null, "the stash is spent");
  assert.equal(seen.resolved?.behavior, "allow");
});

test("respondPermission deny keeps the plan mode and delivers the reason", async () => {
  const { stub, seen } = planSession();
  const ok = await Session.prototype.respondPermission.call(
    stub,
    "req-1",
    "deny",
    "버튼을 더 크게",
  );
  assert.equal(ok, true);
  assert.deepEqual(seen.modeCalls, [], "a denial asks for a better plan, not a mode change");
  assert.equal(stub.providerModeId, "plan");
  assert.equal(stub.modeBeforePlan, "bypassPermissions", "the stash survives for the next plan");
  assert.equal(seen.resolved?.behavior, "deny");
  assert.match(seen.resolved?.message, /버튼을 더 크게/);
});

test("setMode stashes on entering plan and clears on leaving it", async () => {
  const stub = {
    agent: { setMode: async () => {} },
    providerModeId: "bypassPermissions",
    planModeId: "plan",
    defaultModeId: "default",
  };
  await Session.prototype.setMode.call(stub, "plan");
  assert.equal(stub.modeBeforePlan, "bypassPermissions");
  await Session.prototype.setMode.call(stub, "plan");
  assert.equal(stub.modeBeforePlan, "bypassPermissions", "re-entry keeps the first memory");
  await Session.prototype.setMode.call(stub, "acceptEdits");
  assert.equal(stub.modeBeforePlan, null, "an explicit switch out ends the plan era");
});

/**
 * 감사 C5: 두 자리는 이제 다른 것을 뜻한다 — `providerModeId` 는 이 세션이
 * 실제로 도는 모드이고, 선로의 `permissionMode` 는 Claude 열거형의 자리다.
 * 공급자 자신의 모드 id 는 열거형 칸에 실리지 않는다.
 */
test("selectors: 공급자 모드 id 는 열거형 칸을 오염시키지 않는다", async () => {
  const acp = {
    provider: "omp",
    providerModeId: "bypass",
    selectedModel: null,
    model: null,
    selectedEffort: null,
    fastMode: false,
    fastModeBlocked: null,
    sendable: false,
    agent: null,
  };
  const rows = await Session.prototype.selectors.call(acp);
  assert.equal(rows.mode, "bypass", "실제 모드는 mode 가 든다");
  assert.equal(rows.permissionMode, "default", "열거형 칸에는 열거형 값만 온다");

  const claude = { ...acp, provider: "claude", providerModeId: "bypassPermissions" };
  const claudeRows = await Session.prototype.selectors.call(claude);
  assert.equal(claudeRows.mode, "bypassPermissions");
  assert.equal(claudeRows.permissionMode, "bypassPermissions", "Claude 는 두 자리가 같다");
});

test("a restore failure still releases the plan", async () => {
  const { stub, seen } = planSession();
  stub.agent.setMode = async () => {
    throw new Error("stub refused");
  };
  const ok = await Session.prototype.respondPermission.call(stub, "req-1", "allow");
  assert.equal(ok, true, "the approval went out");
  assert.equal(seen.resolved?.behavior, "allow", "a wedged restore must not strand the plan");
});
