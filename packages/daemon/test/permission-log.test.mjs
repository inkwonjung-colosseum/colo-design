/**
 * 권한 카드 반복 측정 로그(커미티 판정 2026-09-14 의장 판정 2)의 단위 검사.
 *
 * 계약: 같은 서명에 "항상 허용"을 답한 뒤 새 세계(새 인스텐스 — 실제로는
 * 새 대화, 대몬 재시작이면 파일까지 거쳐서)에서 같은 카드가 뜨면 repeat 다.
 * 상한을 넘으면 최근 절반만 남되, 살아남은 "항상 허용"은 계속 씨앗이다.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PermissionRepeatLog } from "../dist/permission-log.js";

const workdir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("같은 서명의 카드는 '항상 허용' 이후의 세계에서 repeat 다", () => {
  const file = join(workdir("perm-repeat-"), "log.jsonl");
  const first = new PermissionRepeatLog(file);
  first.ask("Bash", "Bash:command:pnpm run check", "/work/repo");
  assert.equal(first.repeatsOf("Bash:command:pnpm run check"), 0, "첫 카드는 반복이 아니다");
  first.alwaysAllowedAnswer("Bash", "Bash:command:pnpm run check", "/work/repo");

  // 새 인스텐스 = 새 대화의 세계: alwaysAllowed 는 세션과 죽었고 파일만 안다.
  const second = new PermissionRepeatLog(file);
  assert.equal(second.repeatsOf("Bash:command:pnpm run check"), 0, "아직 반복 카드가 없다");
  second.ask("Bash", "Bash:command:pnpm run check", "/work/repo");
  assert.equal(second.repeatsOf("Bash:command:pnpm run check"), 1, "같은 카드가 반복으로 기록됐다");
  second.ask("Bash", "Bash:command:pnpm run build", "/work/repo");
  assert.equal(second.repeatsOf("Bash:command:pnpm run build"), 0, "다른 서명은 반복이 아니다");
});

test("상한을 넘으면 최근 절반만 남고 살아있는 '항상 허용'은 씨앗으로 남는다", () => {
  const file = join(workdir("perm-repeat-trim-"), "log.jsonl");
  const log = new PermissionRepeatLog(file);
  for (let index = 0; index < 4000; index += 1) {
    log.ask("Bash", `Bash:command:fill-${index}`, "/work/repo");
  }
  log.alwaysAllowedAnswer("Bash", "Bash:command:pnpm run check", "/work/repo");
  log.ask("Bash", "Bash:command:overflow", "/work/repo");
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  assert.ok(lines.length <= 2002, `줄이 절반 근처로 줄었다 (${lines.length})`);
  assert.equal(log.repeatsOf("Bash:command:overflow"), 0, "trim 직후의 그 카드는 반복이 아니었다");
  log.ask("Bash", "Bash:command:pnpm run check", "/work/repo");
  assert.equal(
    log.repeatsOf("Bash:command:pnpm run check"),
    1,
    "trim 을 넘겨 살아남은 답이 씨앗이다",
  );
});

test("깨진 파일은 없던 것이 되어 측정을 죽이지 않는다", () => {
  const file = join(workdir("perm-repeat-broken-"), "log.jsonl");
  // 절단된 줄 — 빈-줄 필터는 통과하고 JSON.parse 에서 죽는다. read() 의
  // 회복 분기가 없다면 이 생성 자체가 던진다.
  writeFileSync(file, '{"kind":"ask"\n');
  const log = new PermissionRepeatLog(file);
  log.ask("Bash", "Bash:command:ok", "/work/repo");
  assert.equal(log.repeatsOf("Bash:command:ok"), 0);
});
