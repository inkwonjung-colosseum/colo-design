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
    run: {
      setPermissionMode: async (m) => {
        seen.modeCalls.push(m);
      },
    },
    permissionMode: mode,
    modeBeforePlan,
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
  // respondPermission 은 인스턴스 메서드인 setPermissionMode 로 복귀한다 —
  // 스텁에도 진짜 프로토타입 메서드를 심어 같은 장부를 쓰게 한다.
  stub.setPermissionMode = Session.prototype.setPermissionMode;
  return { stub, seen };
}

test("canUse routes ExitPlanMode to a plan card even when 항상 허용 remembers it", async () => {
  let captured = null;
  const ask = {
    alwaysAllowed: { allows: () => true },
    handlePermission: (toolName, input) => {
      captured = { toolName, input };
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    },
  };
  const signal = new AbortController().signal;
  const verdict = await Session.prototype.canUse.call(
    ask,
    PLAN_TOOL,
    { plan: "1. 화면 2. 상태" },
    { signal },
  );
  assert.equal(captured.toolName, PLAN_TOOL, "the plan went to a card, not to the memory");
  assert.equal(verdict.behavior, "allow");
});

test("respondPermission allow restores the working mode BEFORE resolving the plan", async () => {
  const { stub, seen } = planSession();
  const ok = await Session.prototype.respondPermission.call(stub, "req-1", "allow");
  assert.equal(ok, true);
  assert.deepEqual(seen.modeCalls, ["bypassPermissions"], "one restore, the stashed mode");
  assert.equal(stub.permissionMode, "bypassPermissions");
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
  assert.equal(stub.permissionMode, "plan");
  assert.equal(stub.modeBeforePlan, "bypassPermissions", "the stash survives for the next plan");
  assert.equal(seen.resolved?.behavior, "deny");
  assert.match(seen.resolved?.message, /버튼을 더 크게/);
});

test("setPermissionMode stashes on entering plan and clears on leaving it", async () => {
  const stub = {
    run: { setPermissionMode: async () => {} },
    permissionMode: "bypassPermissions",
  };
  await Session.prototype.setPermissionMode.call(stub, "plan");
  assert.equal(stub.modeBeforePlan, "bypassPermissions");
  await Session.prototype.setPermissionMode.call(stub, "plan");
  assert.equal(stub.modeBeforePlan, "bypassPermissions", "re-entry keeps the first memory");
  await Session.prototype.setPermissionMode.call(stub, "acceptEdits");
  assert.equal(stub.modeBeforePlan, null, "an explicit switch out ends the plan era");
});

test("a restore failure still releases the plan", async () => {
  const { stub, seen } = planSession();
  stub.run.setPermissionMode = async () => {
    throw new Error("stub refused");
  };
  const ok = await Session.prototype.respondPermission.call(stub, "req-1", "allow");
  assert.equal(ok, true, "the approval went out");
  assert.equal(seen.resolved?.behavior, "allow", "a wedged restore must not strand the plan");
});
