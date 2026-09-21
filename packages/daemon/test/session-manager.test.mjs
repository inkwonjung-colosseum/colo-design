/**
 * 대화 절단점: the pure function that picks where a truncating fork keeps
 * and drops. Everything runs offline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBranchCutoff, resolveCutoff } from "../dist/agent/drivers/claude/cutoff.js";
import { DriverRegistry } from "../dist/agent/registry.js";
import { SessionManager } from "../dist/session-manager.js";

/** A synthetic transcript: prompts and answers with tool-result carriers. */
const msg = (type, uuid, extra = {}) => ({ type, uuid, ...extra });
const prompt = (uuid) => msg("user", uuid, { message: { content: "말" } });
const assistant = (uuid) => msg("assistant", uuid);
const carrier = (uuid) =>
  msg("user", uuid, {
    message: { content: [{ type: "tool_result", tool_use_id: "t" }] },
  });
const synthetic = (uuid) => msg("user", uuid, { isSynthetic: true, message: { content: "알림" } });

const TAPE = [
  prompt("p1"), // 1번째 턴 시작
  assistant("a1"),
  carrier("c1"), // 도구 결과 캐리어가 답 뒤에 붙는다
  prompt("p2"), // 2번째 턴
  assistant("a2"),
  synthetic("s1"), // 합성 알림은 프롬프트가 아니다
  prompt("p3"), // 3번째 턴
  assistant("a3"),
];

test("resolveCutoff: kept 는 버리는 프롬프트 바로 앞의 마지막 체인 항목", () => {
  const cut = resolveCutoff(TAPE, 2);
  assert.deepEqual(cut, { cut: "c1", drops: "p2", answerCount: 3 });
});

test("resolveCutoff: k = 1 은 cut 없이 새 대화로", () => {
  const cut = resolveCutoff(TAPE, 1);
  assert.deepEqual(cut, { cut: null, drops: "p1", answerCount: 3 });
});

test("resolveCutoff: 마지막 답도 버릴 수 있고, 캐리어 뒤의 합성 행까지는 본다", () => {
  const cut = resolveCutoff(TAPE, 3);
  assert.deepEqual(cut, { cut: "s1", drops: "p3", answerCount: 3 });
});

test("resolveCutoff: 없는 답은 null — 호출자가 한국어로 거절한다", () => {
  assert.equal(resolveCutoff(TAPE, 0), null);
  assert.equal(resolveCutoff(TAPE, 4), null);
});

// ---------------------------------------------------------------------------
// 대화 분기의 절단점 — 되감기의 계산을 한 칸 뒤에서 산다. k 번째 답까지가
// 남는 것(되감기는 k-1 번째까지), 마지막 답에서는 잘림 없이 전체 포크다.
// ---------------------------------------------------------------------------

test("resolveBranchCutoff: 1번째 답까지 남긴다 — 되감기가 2번째를 버릴 지점과 같다", () => {
  const cut = resolveBranchCutoff(TAPE, 1);
  assert.deepEqual(cut, { cut: "c1", drops: "p2", answerCount: 3 });
});

test("resolveBranchCutoff: 중간 답까지 남긴다 — drops 는 그다음 프롬프트다", () => {
  const cut = resolveBranchCutoff(TAPE, 2);
  assert.deepEqual(cut, { cut: "s1", drops: "p3", answerCount: 3 });
});

test("resolveBranchCutoff: 마지막 답은 잘라낼 것이 없다 — 전체 포크", () => {
  const cut = resolveBranchCutoff(TAPE, 3);
  assert.deepEqual(cut, { cut: null, drops: null, answerCount: 3 });
});

test("resolveBranchCutoff: 없는 답은 null — 호출자가 폴백한다", () => {
  assert.equal(resolveBranchCutoff(TAPE, 0), null);
  assert.equal(resolveBranchCutoff(TAPE, 4), null);
});

/**
 * 같은 id 를 두 번 여는 요청(더블클릭, 두 창의 재개)은 새 세션이 아니라 이미
 * 살아 있는 그 세션이다 — 덮어쓰면 첫 Session 의 CLI 가 맵 밖에서 살아남아
 * 훅을 통해 계속 방송한다. 두 번째 create 는 드라이버에 새 transport 를
 * 만들지 않고 첫 세션을 그대로 돌려줘야 한다.
 */
test("create: 같은 id 의 두 번째 create 는 살아 있는 세션을 돌려준다", () => {
  const registry = new DriverRegistry();
  let created = 0;
  registry.register({
    id: "fake",
    describe: () => ({
      id: "fake",
      label: "가짜",
      modes: [],
      defaultModeId: "default",
      capabilities: {},
    }),
    isAvailable: async () => ({ ok: true, executable: "/bin/true" }),
    createSession: () => {
      created += 1;
      return {
        alive: true,
        send: async () => {},
        interrupt: async () => "dead",
        setMode: async () => {},
        close: async () => {},
      };
    },
  });
  const manager = new SessionManager(
    {
      onEvent: () => {},
      onState: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
    },
    registry,
  );
  const options = { cwd: "/tmp/clone", provider: "fake", launch: { resume: "thread-1" } };
  const first = manager.create(options);
  const second = manager.create(options);
  assert.equal(second, first);
  assert.equal(created, 1);
});

/**
 * ACP `session/new` 은 에이전트가 자기 uuid 를 답한다 — 대화록은 그 id 로
 * 쓰이고 우리 세션 id 와 어긋난다. 살아 있는 세션의 스토어 조회(내보내기·
 * 대화록 재생)는 세션 id 가 아니라 벤더 id 로 물어야 한다.
 */
test("history: 살아 있는 세션의 스토어 조회는 벤더 id 로 묻는다", async () => {
  const registry = new DriverRegistry();
  const asked = [];
  registry.register({
    id: "acpish",
    describe: () => ({
      id: "acpish",
      label: "ACP",
      modes: [],
      defaultModeId: "default",
      capabilities: {},
    }),
    isAvailable: async () => ({ ok: true, executable: "/bin/true" }),
    createSession: () => ({
      vendorId: "vendor-1",
      alive: true,
      send: async () => {},
      interrupt: async () => "dead",
      setMode: async () => {},
      close: async () => {},
    }),
    store: {
      import: async (id) => {
        asked.push(["import", id]);
        return [
          {
            kind: "turn.end",
            subtype: "success",
            isError: false,
            costUsd: null,
            numTurns: null,
            durationMs: null,
            resultText: null,
          },
        ];
      },
      has: async (id) => {
        asked.push(["has", id]);
        return false;
      },
    },
  });
  const manager = new SessionManager(
    {
      onEvent: () => {},
      onState: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
    },
    registry,
  );
  const session = manager.create({ cwd: "/tmp/clone", provider: "acpish" });
  const events = await manager.history(session.id, session.cwd);
  assert.deepEqual(asked[0], ["import", "vendor-1"]);
  assert.equal(events.length, 1);
});
