/**
 * 턴 통계 (turn-stats.ts) 단위 검사. 임시 폴더에 하루 JSONL 이 쓰이는
 * 것까지 본다.
 *
 * 계약: 세션 사건의 흐름(user.echo → tool.start… → turn.end)이 정확히 한
 * 줄로 내려앉는다 — 종류(사람·핀·게이트), 핀 수, 도구 묶음 수, 게이트
 * 여부, 컨텍스트 토큰. 사용자의 말은 조금도 남지 않는다.
 *
 * Run: node --test packages/daemon/test/turn-stats.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markTurn } from "../../protocol/dist/turn-marker.js";
import { TurnStats } from "../dist/turn-stats.js";

function stats(dir, overrides = {}) {
  return new TurnStats(
    {
      projectOf: () => "team-service",
      chipsOf: () => ({ provider: "claude", model: "sonnet", effort: "medium" }),
      contextTokens: async () => 123_456,
      ...overrides,
    },
    { dir },
  );
}

/** 핀 턴의 user.echo — 마커 첫 줄에서 핀 수를 읽는 대상. */
function echoEvent(text, images = 0, files = 0) {
  return { kind: "user.echo", text, images, ...(files ? { files: ["a.pdf"] } : {}) };
}

async function readRows(dir) {
  const { readdirSync } = await import("node:fs");
  const name = readdirSync(dir).find((file) => file.startsWith("turn-stats-"));
  assert.ok(name, "하루 파일이 쓰였다");
  return readFileSync(join(dir, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("핀 턴 한 바퀴가 사실 한 줄로 내려앉는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-stats-"));
  try {
    const stats_ = stats(dir);
    stats_.observe(
      "s1",
      echoEvent(
        markTurn(
          {
            kind: "comments",
            screen: "회원 목록",
            items: [
              { id: "a", label: "x", comment: "" },
              { id: "b", label: "y", comment: "" },
            ],
          },
          "본문",
        ),
        1,
        1,
      ),
    );
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "1",
      name: "Grep",
      input: {},
      agentId: null,
    });
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "2",
      name: "Read",
      input: {},
      agentId: null,
    });
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "3",
      name: "Edit",
      input: {},
      agentId: null,
    });
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "4",
      name: "Bash",
      input: {},
      agentId: null,
    });
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "5",
      name: "mcp__colo-browser__screen_check",
      input: {},
      agentId: null,
    });
    stats_.observe("s1", { kind: "text.delta", blockId: "b", text: "답", agentId: null });
    stats_.noteGate("s1");
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 9,
      durationMs: 41_230,
      resultText: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const [row] = await readRows(dir);
    assert.equal(row.kind, "comments");
    assert.equal(row.pins, 2);
    assert.equal(row.images, 1);
    assert.equal(row.files, 1);
    assert.equal(row.project, "team-service");
    assert.equal(row.provider, "claude");
    assert.equal(row.durationMs, 41_230);
    assert.equal(row.numTurns, 9);
    assert.equal(row.gate, true, "게이트가 다시 연 턴이 새겨진다");
    assert.equal(row.contextTokens, 123_456);
    assert.deepEqual(row.tools, { read: 2, edit: 1, exec: 1, browser: 1, other: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("사람 턴은 user 로, 컨텍스트를 못 읽으면 null 로 솔직하다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-stats-"));
  try {
    const stats_ = stats(dir, { contextTokens: async () => Promise.reject(new Error("x")) });
    stats_.observe("s2", echoEvent("버튼 글자를 바꿔 줘"));
    stats_.observe("s2", {
      kind: "turn.end",
      subtype: "error_max_turns",
      isError: true,
      costUsd: null,
      numTurns: null,
      durationMs: null,
      resultText: "너무 김",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const [row] = await readRows(dir);
    assert.equal(row.kind, "user");
    assert.equal(row.pins, 0);
    assert.equal(row.contextTokens, null);
    assert.equal(row.isError, true);
    assert.equal(row.durationMs, null);
    assert.equal(row.subtype, "error_max_turns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("echo 없이 돌아온 turn.end 는 조용히 사라진다 — 줄이 없다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-stats-"));
  try {
    const stats_ = stats(dir);
    stats_.observe("s3", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 10,
      resultText: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => readRows(dir), /하루 파일이 쓰였다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("첫 편집까지·카드 대기·스캔 시간이 한 줄에 갈라 내려앉는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-stats-"));
  try {
    const stats_ = stats(dir);
    // 보내기 문에서 잰 핀 강화 — 턴이 시작될 때 물려받는다.
    stats_.noteScan("s3", 412);
    stats_.observe("s3", echoEvent("핀 턴"));
    stats_.observe("s3", {
      kind: "tool.start",
      toolUseId: "1",
      name: "Grep",
      input: {},
      agentId: null,
    });
    stats_.observe("s3", {
      kind: "tool.start",
      toolUseId: "2",
      name: "Edit",
      input: {},
      agentId: null,
    });
    // 카드 대기 두 구간 — 누적된다.
    stats_.noteWait("s3", 3_000);
    stats_.noteWait("s3", 5_000);
    stats_.observe("s3", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 3,
      durationMs: 60_000,
      resultText: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const [row] = await readRows(dir);
    assert.equal(row.scanMs, 412, "문에서 잰 강화 시간이 턴에 얹힌다");
    assert.equal(row.waitMs, 8_000, "카드 대기가 누적으로 새겨진다");
    assert.equal(typeof row.firstEditMs, "number", "편집이 있었던 턴의 첫 편집까지 시간");
    assert.ok(row.firstEditMs >= 0);
    assert.equal(row.sincePrevTurnMs, null, "첫 턴에는 이전 턴이 없다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("읽기만 한 턴의 firstEditMs 는 null 이다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-stats-"));
  try {
    const stats_ = stats(dir);
    stats_.observe("s4", echoEvent("읽기만"));
    stats_.observe("s4", {
      kind: "tool.start",
      toolUseId: "1",
      name: "Read",
      input: {},
      agentId: null,
    });
    stats_.observe("s4", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 1_000,
      resultText: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const [row] = await readRows(dir);
    assert.equal(row.firstEditMs, null, "편집 도구가 없었으면 방향 잡기가 끝나지 않았다");
    assert.equal(row.waitMs, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("게이트의 한 바퀴는 제 행(kind gateset)으로 내려앉는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-stats-"));
  try {
    const stats_ = stats(dir);
    stats_.observe("s5", echoEvent("핀 턴"));
    stats_.observe("s5", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 2,
      durationMs: 30_000,
      resultText: null,
    });
    stats_.noteGateCheck("s5", { ms: 4_200, screens: 2, reopened: true });
    await new Promise((resolve) => setImmediate(resolve));
    const rows = await readRows(dir);
    const gate = rows.find((row) => row.kind === "gateset");
    assert.ok(gate, "게이트 행이 있다");
    assert.equal(gate.gateMs, 4_200);
    assert.equal(gate.screens, 2);
    assert.equal(gate.reopened, true);
    assert.equal(gate.project, "team-service");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("이전 턴 종료 뒤 재보내기의 틈이 두 번째 턴에 새겨진다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-stats-"));
  try {
    const stats_ = stats(dir);
    const end = {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 1_000,
      resultText: null,
    };
    stats_.observe("s6", echoEvent("첫 턴"));
    stats_.observe("s6", end);
    await new Promise((resolve) => setImmediate(resolve));
    stats_.observe("s6", echoEvent("바로 다음 턴"));
    stats_.observe("s6", end);
    await new Promise((resolve) => setImmediate(resolve));
    const rows = await readRows(dir);
    assert.equal(rows[0].sincePrevTurnMs, null);
    assert.equal(typeof rows[1].sincePrevTurnMs, "number", "두 번째 턴에는 틈이 있다");
    assert.ok(rows[1].sincePrevTurnMs >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
