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
