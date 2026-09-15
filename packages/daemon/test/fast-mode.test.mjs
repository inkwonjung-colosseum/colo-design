/**
 * 빠르게(fast mode)의 장부, 오프라인 단위: 켜 달라는 부탁은 노력 수준과 같은
 * 깃발 층으로 가고, 켜졌는지는 우리가 아니라 CLI 가 말한다 — 부탁이 거절되면
 * 다음 메시지가 토글을 제자리로 돌려놓아야 한다. 이것이 이 파일이 지키는
 * 한 줄이다: 토글은 눌린 것을 그리지 않고, 받아들여진 것을 그린다.
 *
 * Usage: node --test packages/daemon/test/fast-mode.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { Session } = await import("../dist/session.js");

/** 깃발 요청을 받아 적는 스텁 — plan.test.mjs 의 프로토타입 호출 패턴 그대로. */
function fastSession({ fastMode = false, fastModeBlocked = null } = {}) {
  const seen = { flags: [] };
  const stub = {
    run: {
      applyFlagSettings: async (settings) => {
        seen.flags.push(settings);
      },
    },
    fastMode,
    fastModeBlocked,
  };
  stub.setFastMode = Session.prototype.setFastMode;
  stub.readFastMode = Session.prototype.readFastMode;
  return { stub, seen };
}

test("켜기는 깃발 층으로 가고, 막힌 사유는 그 자리에서 지워진다", async () => {
  const { stub, seen } = fastSession({ fastModeBlocked: "preference" });
  await stub.setFastMode(true);
  assert.deepEqual(seen.flags, [{ fastMode: true }], "빠르게는 effortLevel 과 같은 문으로 간다");
  assert.equal(stub.fastMode, true);
  assert.equal(stub.fastModeBlocked, null, "켜는 순간 옛 사유는 옛말이 된다");
});

test("끄기도 같은 문으로 가되, 사유는 건드리지 않는다", async () => {
  const { stub, seen } = fastSession({ fastMode: true, fastModeBlocked: "free" });
  await stub.setFastMode(false);
  assert.deepEqual(seen.flags, [{ fastMode: false }]);
  assert.equal(stub.fastMode, false);
  assert.equal(stub.fastModeBlocked, "free", "못 쓰는 이유는 끈다고 사라지지 않는다");
});

test("켜졌다고 말하는 것은 CLI 다 — 거절은 다음 메시지가 정정한다", () => {
  const { stub } = fastSession();
  stub.fastMode = true; // 눌린 자리를 낙관적으로 그려 둔 상태
  stub.readFastMode({ fast_mode_state: "off", fast_mode_disabled_reason: "free" });
  assert.equal(stub.fastMode, false, "받아들여지지 않은 부탁은 켜짐이 아니다");
  assert.equal(stub.fastModeBlocked, "free");
});

test("쿨다운은 켜짐이 아니다 — 지금 도는 것은 보통 속도다", () => {
  const { stub } = fastSession({ fastMode: true });
  stub.readFastMode({ fast_mode_state: "cooldown" });
  assert.equal(stub.fastMode, false);
});

test("빠르게를 말하지 않는 메시지는 소식이 없는 것이지 꺼졌다는 뜻이 아니다", () => {
  const { stub } = fastSession({ fastMode: true, fastModeBlocked: null });
  stub.readFastMode({ type: "assistant", message: { content: [] } });
  assert.equal(stub.fastMode, true, "말 없는 메시지가 토글을 끄면 켠 사람이 거짓말을 당한다");
  assert.equal(stub.fastModeBlocked, null);
});

test("상태를 실은 메시지에 사유가 없으면 막힘이 풀린 것이다", () => {
  const { stub } = fastSession({ fastModeBlocked: "network_error" });
  stub.readFastMode({ fast_mode_state: "on" });
  assert.equal(stub.fastMode, true);
  assert.equal(stub.fastModeBlocked, null, "지나간 사유를 물려주면 토글이 영영 잠긴다");
});
