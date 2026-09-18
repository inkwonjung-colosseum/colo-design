/**
 * 되돌리기 측정 로그의 단위 검사.
 *
 * 계약: 세 문(다시 요청 · 턴 되돌리기 · 저장 되돌리기)이 한 파일의 JSONL 로
 * 쌓이고, 상한을 넘으면 최근 절반만 남되 파일은 계속 JSONL 이다 — 깨진 줄
 * 하나가 측정 전부를 죽이지 않는다.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UndoLog } from "../dist/undo-log.js";

const workdir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("세 문이 한 파일에 제 종류로 쌓이고 다음 인스턴스가 그것을 읽는다", () => {
  const file = join(workdir("undo-"), "undo.jsonl");
  const log = new UndoLog(file);
  log.record({ kind: "retry", slug: "shop", sessionId: "s-1", turn: 3 });
  log.record({ kind: "turn", slug: "shop", sessionId: "s-1", turn: 2 });
  log.record({ kind: "save", slug: "shop" });

  const written = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    written.map((line) => line.kind),
    ["retry", "turn", "save"],
  );
  assert.equal(written[0].turn, 3, "되돌린 턴 번호가 남는다");
  assert.equal(written[2].turn, undefined, "저장 되돌리기에는 턴이 없다");
  assert.ok(
    written.every((line) => typeof line.ts === "number"),
    "모든 줄에 시각이 있다",
  );

  // 데몬이 다시 뜬 세계: 파일이 그대로 세는 근거다.
  assert.equal(new UndoLog(file).countOf("retry"), 1);
});

test("상한을 넘으면 최근 절반만 남고 파일은 여전히 JSONL 이다", () => {
  const file = join(workdir("undo-trim-"), "undo.jsonl");
  const log = new UndoLog(file);
  for (let index = 0; index < 4001; index += 1) {
    log.record({ kind: "turn", slug: "shop", sessionId: "s-1", turn: index });
  }
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length <= 2001, `잘려야 한다 (${lines.length}줄)`);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.equal(parsed.at(-1).turn, 4000, "가장 최근 줄이 살아남는다");
  assert.ok(parsed[0].turn > 0, "가장 오래된 줄부터 버린다");
});

test("깨진 줄은 없던 것으로 읽고 새 기록을 막지 않는다", () => {
  const file = join(workdir("undo-broken-"), "undo.jsonl");
  appendFileSync(file, "{ this is not json\n");
  const log = new UndoLog(file);
  assert.equal(log.countOf("retry"), 0);
  log.record({ kind: "retry", slug: "shop", sessionId: "s-2", turn: 1 });
  assert.equal(log.countOf("retry"), 1);
});

test("덧붙이다 찢어진 꼬리 줄이 앞의 온전한 줄을 함께 묻지 않는다", () => {
  const file = join(workdir("undo-torn-"), "undo.jsonl");
  appendFileSync(
    file,
    `${JSON.stringify({ ts: 1, kind: "retry", slug: "shop", sessionId: "s-3", turn: 1 })}\n`,
  );
  // 정전·강제 종료로 append 도중에 끊긴 줄 — 그 줄만 없던 것으로 하고 앞의
  // 줄은 살아 있어야 한다. 파일 전체를 한 번에 try/catch 하던 세계에서는
  // 온전한 줄까지 빈 배열로 사라졌다.
  appendFileSync(file, '{"ts":2,"kind":"tur');
  const log = new UndoLog(file);
  assert.equal(log.countOf("retry"), 1, "온전한 줄은 산다");
  log.record({ kind: "turn", slug: "shop", sessionId: "s-3", turn: 2 });
  assert.equal(log.countOf("turn"), 1, "깨진 줄 뒤에서도 기록은 계속된다");
});
