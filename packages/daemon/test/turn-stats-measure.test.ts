import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatEvent } from "@colo-design/protocol";
import { TurnStats } from "../dist/turn-stats.js";

/**
 * `../dist` 임포트인 이유: turn-stats 의 src 는 `.js` 지정자(`./log.js`)로
 * 형제를 부르는데, node 의 타입 지우기는 그 지정을 `.ts` 로 고쳐 주지 않는다.
 * `pnpm test` 가 빌드를 먼저 돌리는 이유다.
 */

function readRows(dir: string): Array<Record<string, unknown>> {
  // 파일이 아직 없는 것은 "정산이 아직 안 떴다"의 정상 상태다 — untilRows 가
  // 기다릴 자리다.
  const name = readdirSync(dir).find((file) => file.startsWith("turn-stats-"));
  if (name === undefined) return [];
  return readFileSync(join(dir, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * turn.end 의 정산은 비동기라(컨텍스트 조회를 기다린 뒤 쓴다) 그 약속이
 * 밖으로 나오지 않는다 — 노리는 행이 파일에 뜨는 실제 신호를 기다린다.
 * 정해 둔 시간을 믿는 대신, 매크로태스크를 건너며 도는 유한 반복이다.
 */
async function untilRows(dir: string, count: number): Promise<Array<Record<string, unknown>>> {
  for (let turn = 0; turn < 1000; turn += 1) {
    const rows = readRows(dir).filter((row) => row.kind !== "gateset");
    if (rows.length >= count) return rows;
    await new Promise(setImmediate);
  }
  return assert.fail(`정산 행 ${count}개가 끝내 안 떴다`);
}

function stats(dir: string): TurnStats {
  return new TurnStats(
    {
      projectOf: () => "proj",
      chipsOf: () => ({ provider: "claude", model: "stub", effort: null }),
      contextTokens: async () => 4321,
    },
    { dir },
  );
}

test("핀 턴은 payload 크기와 TTFT 를 기록한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-stats-"));
  try {
    const stats_ = stats(dir);
    const marker = '<!-- colo-design:comments {"pins":[],"items":[{},{}]} -->\n화면을 고쳐 주세요.';
    stats_.observe("s1", { kind: "user.echo", text: marker, images: 0 } as ChatEvent);
    stats_.observe("s1", {
      kind: "text.delta",
      blockId: "b",
      text: "아",
      agentId: null,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "t1",
      name: "Edit",
      input: {},
      agentId: null,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 900,
      resultText: "고쳤습니다",
    } as ChatEvent);
    const all = await untilRows(dir, 1);
    const rows = all.filter((row) => row.kind === "comments");
    assert.equal(rows.length, 1);
    const row = rows[0] ?? {};
    assert.equal(row.pins, 2);
    // 핀 턴의 payload 크기 — 에이전트가 받은 말의 바이트.
    assert.equal(row.pinBytes, Buffer.byteLength(marker, "utf8"));
    assert.equal(typeof row.firstDeltaMs, "number");
    assert.ok((row.firstDeltaMs as number) >= 0);
    assert.equal(typeof row.firstEditMs, "number");
    assert.equal(row.failure, null);
    assert.equal(row.contextTokens, 4321);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("실패한 턴은 단계가 새겨지고, 성공 턴은 null 이다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-stats-"));
  try {
    const stats_ = stats(dir);
    stats_.observe("s1", { kind: "user.echo", text: "고쳐 줘", images: 0 } as ChatEvent);
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "error",
      isError: true,
      costUsd: null,
      numTurns: null,
      durationMs: 400,
      resultText: "usage limit reached for this account",
    } as ChatEvent);
    stats_.observe("s1", { kind: "user.echo", text: "또 고쳐 줘", images: 0 } as ChatEvent);
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 300,
      resultText: "됐습니다",
    } as ChatEvent);
    const rows = (await untilRows(dir, 2)).filter((row) => row.kind === "user");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.failure, "limit");
    assert.equal(rows[1]?.failure, null);
    // 사람 말 턴은 pinBytes 가 없다 — 핀 턴만 재는 양이다.
    assert.equal(rows[0]?.pinBytes, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("첫 delta 가 없던 턴의 firstDeltaMs 는 null 이다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-stats-"));
  try {
    const stats_ = stats(dir);
    stats_.observe("s1", { kind: "user.echo", text: "조용한 턴", images: 0 } as ChatEvent);
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "error",
      isError: true,
      costUsd: null,
      numTurns: null,
      durationMs: 100,
      resultText: "prompt is too long: 250000 tokens > 200000 maximum",
    } as ChatEvent);
    const rows = (await untilRows(dir, 1)).filter((row) => row.kind === "user");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.firstDeltaMs, null);
    assert.equal(rows[0]?.failure, "length");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("omp 의 도구 이름도 읽기·편집·실행으로 센다 — 첫 편집과 핀 적중이 성립한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-stats-"));
  try {
    const stats_ = stats(dir);
    // 보내기 문이 핀 후보를 물려준다 — 후보는 클론 루트 기준 절대경로.
    stats_.noteScan("s1", 12, { cwd: "/repo", candidates: ["/repo/src/a.tsx"] });
    const marker =
      '<!-- colo-design:comments {"pins":[],"items":[{}]} -->\n버튼 글자를 고쳐 주세요.';
    stats_.observe("s1", { kind: "user.echo", text: marker, images: 0 } as ChatEvent);
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "t1",
      name: "read",
      input: { path: "src/a.tsx" },
      agentId: null,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "t2",
      name: "bash",
      input: { command: "pnpm check" },
      agentId: null,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "t3",
      name: "edit",
      input: { path: "src/a.tsx", oldText: "a", newText: "b" },
      agentId: null,
    } as ChatEvent);
    // 레포 파일이 아닌 것을 고치는 memory_edit 는 편집이 아니다 — other 로 센다.
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "t4",
      name: "memory_edit",
      input: { path: "notes.md" },
      agentId: null,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 900,
      resultText: "고쳤습니다",
    } as ChatEvent);
    const rows = (await untilRows(dir, 1)).filter((row) => row.kind === "comments");
    assert.equal(rows.length, 1);
    const row = rows[0] ?? {};
    assert.deepEqual(row.tools, { read: 1, edit: 1, exec: 1, browser: 0, other: 1 });
    assert.equal(typeof row.firstEditMs, "number");
    assert.equal(row.pinHit, true);
    assert.equal(row.scanMs, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex 의 item 이름도 같은 묶음이다 — fileChange 의 changes[] 로 핀 적중을 본다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-stats-"));
  try {
    const stats_ = stats(dir);
    stats_.noteScan("s1", 5, { cwd: "/repo", candidates: ["/repo/src/b.tsx"] });
    const marker = '<!-- colo-design:comments {"pins":[],"items":[{}]} -->\n칩을 바꿔 주세요.';
    stats_.observe("s1", { kind: "user.echo", text: marker, images: 0 } as ChatEvent);
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "t1",
      name: "commandExecution",
      input: { command: "pnpm check" },
      agentId: null,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "t2",
      name: "fileChange",
      input: { changes: [{ path: "src/b.tsx" }] },
      agentId: null,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 700,
      resultText: "바꿨습니다",
    } as ChatEvent);
    const rows = (await untilRows(dir, 1)).filter((row) => row.kind === "comments");
    const row = rows[0] ?? {};
    assert.deepEqual(row.tools, { read: 0, edit: 1, exec: 1, browser: 0, other: 0 });
    assert.equal(row.pinHit, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("브라우저 도구는 세 이름 형태 모두 browser 묶음으로 센다 (PLAN-MCP M-7)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-stats-"));
  try {
    const stats_ = stats(dir);
    stats_.observe("s1", { kind: "user.echo", text: "고쳐 줘", images: 0 } as ChatEvent);
    for (const [id, name] of [
      ["t1", "screen_check"],
      ["t2", "mcp__colo-browser__screen_check"],
      ["t3", "colo-browser/browser_snapshot"],
    ] as const) {
      stats_.observe("s1", {
        kind: "tool.start",
        toolUseId: id,
        name,
        input: {},
        agentId: null,
      } as ChatEvent);
    }
    // 접두만 같은 우연한 이름은 브라우저가 아니다 — 도구 이름 집합의 잣대.
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "t4",
      name: "browser_teleport",
      input: {},
      agentId: null,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "t5",
      name: "Edit",
      input: {},
      agentId: null,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 500,
      resultText: "됐습니다",
    } as ChatEvent);
    const rows = await untilRows(dir, 1);
    assert.deepEqual(rows[0]?.tools, { read: 0, edit: 1, exec: 0, browser: 3, other: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browserMs — 사건만 흘린 턴은 null 이고 중계(noteBrowserOp)만 더한다 (PLAN-MCP M-8)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-stats-"));
  try {
    const stats_ = stats(dir);
    stats_.observe("s1", { kind: "user.echo", text: "고쳐 줘", images: 0 } as ChatEvent);
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "b1",
      name: "browser_click",
      input: {},
      agentId: null,
      startedAt: Date.now() - 7,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "tool.end",
      toolUseId: "b1",
      isError: false,
      content: null,
      agentId: null,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 500,
      resultText: "됐습니다",
    } as ChatEvent);
    // 사건(tool.start·tool.end)만 흘린 턴 — 중계가 잰 것이 없으니 null.
    stats_.observe("s1", { kind: "user.echo", text: "다음 턴", images: 0 } as ChatEvent);
    stats_.observe("s1", {
      kind: "tool.start",
      toolUseId: "b2",
      name: "browser_snapshot",
      input: {},
      agentId: null,
    } as ChatEvent);
    stats_.observe("s1", {
      kind: "tool.end",
      toolUseId: "b2",
      isError: false,
      content: null,
      agentId: null,
    } as ChatEvent);
    // 중계가 잴 때만 더한다 — 두 번이면 합이다.
    stats_.noteBrowserOp("s1", { op: "snapshot", ms: 40 });
    stats_.noteBrowserOp("s1", { op: "navigate", ms: 15 });
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 300,
      resultText: "읽었습니다",
    } as ChatEvent);
    const rows = await untilRows(dir, 2);
    assert.equal(rows[0]?.browserMs, null, "사건만 흘린 턴은 잰 것이 없다");
    assert.equal(rows[1]?.browserMs, 55, "중계 두 번은 합산이다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("noteBrowserOp — op 시간을 더하고 실패 종류는 0이 아닌 것만 칸에 남는다 (PLAN-MCP M-8)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-stats-"));
  try {
    const stats_ = stats(dir);
    stats_.observe("s1", { kind: "user.echo", text: "고쳐 줘", images: 0 } as ChatEvent);
    stats_.noteBrowserOp("s1", { op: "click", ms: 120, fail: "stale-ref" });
    stats_.noteBrowserOp("s1", { op: "click", ms: 30 });
    stats_.noteBrowserOp("s1", { op: "click", ms: 5, fail: "stale-ref" });
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 400,
      resultText: "됐습니다",
    } as ChatEvent);
    // 실패 없는 턴 — browserFail 칸은 아예 생략된다.
    stats_.observe("s1", { kind: "user.echo", text: "다음 턴", images: 0 } as ChatEvent);
    stats_.noteBrowserOp("s1", { op: "navigate", ms: 10 });
    stats_.observe("s1", {
      kind: "turn.end",
      subtype: "success",
      isError: false,
      costUsd: null,
      numTurns: 1,
      durationMs: 200,
      resultText: "이동했습니다",
    } as ChatEvent);
    const rows = await untilRows(dir, 2);
    assert.equal(rows[0]?.browserMs, 155);
    assert.deepEqual(rows[0]?.browserFail, { "stale-ref": 2 });
    assert.equal(rows[1]?.browserMs, 10);
    assert.equal("browserFail" in (rows[1] ?? {}), false, "실패가 없으면 칸이 없다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("noteGateCheck — fallback 칸은 되짚은 수를 싣고 0이면 싣지 않는다 (PLAN-HARNESS §3.B B-4)", () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-stats-"));
  try {
    const stats_ = stats(dir);
    stats_.noteGateCheck("s1", { ms: 5, screens: 2, reopened: false, fallback: 3 });
    stats_.noteGateCheck("s1", { ms: 5, screens: 2, reopened: false, fallback: 0 });
    stats_.noteGateCheck("s1", { ms: 5, screens: 0, reopened: false, skipped: "no-screens" });
    const rows = readRows(dir).filter((r) => r.kind === "gateset");
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.fallback, 3);
    assert.equal("fallback" in (rows[1] ?? {}), false);
    assert.equal(rows[2]?.skipped, "no-screens");
    assert.equal("fallback" in (rows[2] ?? {}), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
