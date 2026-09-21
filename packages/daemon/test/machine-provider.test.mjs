/**
 * 기계 잔일의 담당 (machine-provider) — 저장 메모 · 넘기기 초안을 어느
 * 드라이버가 쓰는지 정하는 계약.
 *
 * 두 층이 위에서 아래로 흐른다: 설정(machine.set)이 이기고, 없으면 등록
 * 순서로 oneShot 계약을 구현한 첫 드라이버. 자격은 설치 여부뿐이고, 아무도
 * 없으면 null — 폴백이 유일한 길이다. 판정은 한 번 캐시되고 설정이 바뀌는
 * 순간에만 다시 정한다. machine.set 의 거절(모르는 id · 계약 미구현 ·
 * 미설치)과 machine.json 의 읽기·쓰기도 여기 잠근다.
 *
 * Run: node --test packages/daemon/test/machine-provider.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DriverRegistry } from "../dist/agent/registry.js";
import { RequestRouter } from "../dist/dispatch.js";
import { MachineTurns, NO_MACHINE_TURN, resolveMachineProvider } from "../dist/machine-provider.js";
import { MachineSetting } from "../dist/machine-setting.js";

/** 최소 드라이버 — 이름 · 계약 여부 · 설치 여부를 스스로 정한다. */
function fakeDriver(id, { oneShot, installed = true } = {}) {
  return {
    id,
    ...(oneShot ? { oneShot: oneShot === true ? async () => `${id} 답` : oneShot } : {}),
    describe: () => ({ id, label: id.toUpperCase() }),
    isAvailable: async () =>
      installed
        ? { ok: true, executable: `/bin/${id}`, loggedIn: true }
        : { ok: false, reason: "설치 필요" },
  };
}

test("설정이 이긴다 — origin 이 setting 으로 답한다", async () => {
  const registry = new DriverRegistry();
  registry.register(fakeDriver("claude", { oneShot: true }));
  registry.register(fakeDriver("codex", { oneShot: true }));
  assert.deepEqual(await resolveMachineProvider(registry, "codex"), {
    id: "codex",
    origin: "setting",
  });
});

test("설정값이 계약을 구현하지 않으면 자동으로 내려앉는다", async () => {
  const registry = new DriverRegistry();
  registry.register(fakeDriver("claude", { oneShot: true }));
  registry.register(fakeDriver("acp")); // 계약 없음 — 세션 전용
  assert.deepEqual(await resolveMachineProvider(registry, "acp"), {
    id: "claude",
    origin: "auto",
  });
});

test("설정값이 설치돼 있지 않아도 자동으로 내려앉는다", async () => {
  const registry = new DriverRegistry();
  registry.register(fakeDriver("claude", { oneShot: true }));
  registry.register(fakeDriver("codex", { oneShot: true, installed: false }));
  assert.deepEqual(await resolveMachineProvider(registry, "codex"), {
    id: "claude",
    origin: "auto",
  });
});

test("모르는 설정 id 도 자동으로 내려앉는다", async () => {
  const registry = new DriverRegistry();
  registry.register(fakeDriver("claude", { oneShot: true }));
  assert.deepEqual(await resolveMachineProvider(registry, "nope"), {
    id: "claude",
    origin: "auto",
  });
});

test("자동은 등록 순서대로 설치된 첫 구현자다", async () => {
  const registry = new DriverRegistry();
  registry.register(fakeDriver("acp")); // 계약 없음
  registry.register(fakeDriver("codex", { oneShot: true, installed: false }));
  registry.register(fakeDriver("omp", { oneShot: true }));
  assert.deepEqual(await resolveMachineProvider(registry, null), { id: "omp", origin: "auto" });
});

test("후보가 없으면 null — 폴백이 유일한 길이다", async () => {
  const registry = new DriverRegistry();
  registry.register(fakeDriver("acp"));
  assert.equal(await resolveMachineProvider(registry, null), null);
});

test("turn 은 담당의 oneShot 에 프롬프트와 목줄을 그대로 실운다", async () => {
  const calls = [];
  const registry = new DriverRegistry();
  registry.register(
    fakeDriver("claude", {
      oneShot: async (prompt, opts) => {
        calls.push({ prompt, opts });
        return "한 줄 메모";
      },
    }),
  );
  const turns = new MachineTurns(registry);
  assert.equal(await turns.turn("프롬프트", { cwd: "/tmp", timeoutMs: 10 }), "한 줄 메모");
  assert.deepEqual(calls, [{ prompt: "프롬프트", opts: { cwd: "/tmp", timeoutMs: 10 } }]);
});

test("담당이 없으면 turn 은 null — 폴백과 같은 길이다", async () => {
  const turns = new MachineTurns(new DriverRegistry());
  assert.equal(await turns.turn("프롬프트", { cwd: "/tmp", timeoutMs: 10 }), null);
});

test("판정은 한 번 캐시되고, 설정이 바뀌면 다시 정한다", async () => {
  const registry = new DriverRegistry();
  registry.register(fakeDriver("claude", { oneShot: true }));
  registry.register(fakeDriver("codex", { oneShot: true }));
  let configured = null;
  const turns = new MachineTurns(registry, () => configured);

  assert.match(await turns.turn("p", { cwd: "/tmp", timeoutMs: 1 }), /claude 답/);
  configured = "codex";
  assert.equal(
    await turns.turn("p", { cwd: "/tmp", timeoutMs: 1 }),
    "claude 답",
    "캐시된 판정 — 설정 변경은 invalidate 로만 반영된다",
  );
  turns.invalidate();
  assert.equal(await turns.turn("p", { cwd: "/tmp", timeoutMs: 1 }), "codex 답");
});

test("machine.set 은 모르는 id · 계약 미구현 · 미설치를 한국어로 거절한다", async () => {
  const registry = new DriverRegistry();
  registry.register(fakeDriver("claude", { oneShot: true }));
  registry.register(fakeDriver("acp")); // 계약 없음
  registry.register(fakeDriver("codex", { oneShot: true, installed: false }));
  const saved = [];
  const router = new RequestRouter({
    agentDrivers: registry,
    machineSetting: { get: () => null, set: (key, v) => saved.push({ key, v }) },
    machineTurns: { invalidate: () => {} },
  });
  const set = (provider) => router.dispatch({ id: "t", type: "machine.set", provider });

  await assert.rejects(set("nope"), /알 수 없는 에이전트입니다/);
  await assert.rejects(set("acp"), /저장 메모를 맡을 수 없습니다/);
  await assert.rejects(set("codex"), /찾지 못했습니다/);
  assert.deepEqual(saved, [], "거절된 선택은 저장되지 않는다");
});

test("machine.set 은 통과한 선택을 저장하고 담당을 다시 정한다", async () => {
  const registry = new DriverRegistry();
  registry.register(fakeDriver("claude", { oneShot: true }));
  registry.register(fakeDriver("codex", { oneShot: true }));
  const saved = [];
  let invalidated = 0;
  const router = new RequestRouter({
    agentDrivers: registry,
    machineSetting: { get: () => saved.at(-1)?.v ?? null, set: (key, v) => saved.push({ key, v }) },
    machineTurns: { invalidate: () => (invalidated += 1) },
  });

  assert.deepEqual(await router.dispatch({ id: "t", type: "machine.set", provider: "codex" }), {
    ok: true,
  });
  assert.deepEqual(saved, [{ key: "provider", v: "codex" }]);
  assert.equal(invalidated, 1, "설정이 바뀌는 순간 담당 판정은 다시 산다");

  assert.deepEqual(await router.dispatch({ id: "t", type: "machine.set", provider: null }), {
    ok: true,
  });
  assert.deepEqual(saved.at(-1), { key: "provider", v: null }, "null 은 자동으로 돌아가는 길");
});

test("machine.json 읽고 쓰기 — 없으면 자동, 쓰면 그 값, null 은 잊기", () => {
  const file = join(mkdtempSync(join(tmpdir(), "machine-setting-")), "machine.json");
  const setting = new MachineSetting(file);
  setting.load();
  assert.equal(setting.get("provider"), null, "파일이 없으면 자동이 기본값");

  setting.set("provider", "codex");
  const rebooted = new MachineSetting(file);
  rebooted.load();
  assert.equal(rebooted.get("provider"), "codex", "다음 부팅도 같은 값을 읽는다");

  rebooted.set("provider", null);
  const forgotten = new MachineSetting(file);
  forgotten.load();
  assert.equal(forgotten.get("provider"), null, "null 은 잊기 — 자동으로 돌아간다");
});

test("machine.json 은 키 두 개를 나란히 살린다 — 한 쪽을 바꿔도 다른 쪽은 산다", () => {
  const file = join(mkdtempSync(join(tmpdir(), "machine-setting-")), "machine.json");
  const setting = new MachineSetting(file);
  setting.set("provider", "codex");
  setting.set("authorName", "김기획");

  const rebooted = new MachineSetting(file);
  rebooted.load();
  assert.equal(rebooted.get("provider"), "codex");
  assert.equal(rebooted.get("authorName"), "김기획");

  // 담당을 자동으로 되돌려도 작성자 이름은 그대로 — 두 키의 생애는 서로 독립이다.
  rebooted.set("provider", null);
  const after = new MachineSetting(file);
  after.load();
  assert.equal(after.get("provider"), null);
  assert.equal(after.get("authorName"), "김기획");

  // 예전 한 쌍 포맷도 그대로 읽힌다 — 레코드화 이전에 쓰인 파일의 하위 호환.
  writeFileSync(file, `${JSON.stringify({ provider: "claude" })}\n`);
  const legacy = new MachineSetting(file);
  legacy.load();
  assert.equal(legacy.get("provider"), "claude");
  assert.equal(legacy.get("authorName"), null);
});

test("NO_MACHINE_TURN 은 폴백의 이름 — 언제나 null", async () => {
  assert.equal(await NO_MACHINE_TURN("p", { cwd: "/tmp", timeoutMs: 1 }), null);
});
