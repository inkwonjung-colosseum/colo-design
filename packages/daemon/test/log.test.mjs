/**
 * 파일 로거의 계약 — 하루 한 파일, 줄 단위 형식, 7일 보존, 죽지 않음.
 *
 * 날짜는 주사바늘로 흘려 보내고 폴더는 임시로 만든다. 실제 사용자 폴더
 * (~/.colo-design/logs)는 건드리지 않는다.
 *
 * Run: node --test packages/daemon/test/log.test.mjs (dist 빌드 뒤)
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileLogger } from "../dist/log.js";

const DAY = 24 * 60 * 60 * 1000;

test("한 줄은 시각·수준·메시지·필드로 갈라진다", () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-log-"));
  try {
    const fixed = new Date("2026-09-14T03:24:00.000Z");
    const logger = createFileLogger({ dir, now: () => fixed });
    logger.info("세션 시작", { sessionId: "s1", title: "로그인 화면" });
    logger.error("전송 거절", { err: new Error("CLI 가 죽었습니다\n둘째 줄") });

    const file = join(dir, "daemon-2026-09-14.log");
    assert.ok(existsSync(file), "하루 치 파일이 만들어진다");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);

    const [at, level, message, fields] = lines[0].split("\t");
    assert.equal(at, "2026-09-14T03:24:00.000Z");
    assert.equal(level, "info");
    assert.equal(message, "세션 시작");
    assert.deepEqual(JSON.parse(fields), { sessionId: "s1", title: "로그인 화면" });

    // 메시지의 줄바꿈은 눌러 담기고, Error 필드는 이름·메시지로 직렬화된다.
    // 필드의 줄바꿈은 JSON 이 이스케이프하므로 줄은 여전히 하나다.
    const errorLine = lines[1].split("\t");
    assert.equal(errorLine.length, 4, "줄바꿈이 줄 수를 늘리지 않는다");
    assert.ok(!errorLine[2].includes("\n"));
    const parsed = JSON.parse(errorLine[3]);
    assert.equal(parsed.err.name, "Error");
    assert.ok(parsed.err.message.startsWith("CLI 가 죽었습니다"), parsed.err.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("날짜가 바뀌면 새 파일로 옮겨가고 보존 창을 넘긴 파일을 지운다", () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-log-"));
  try {
    const today = new Date("2026-09-14T09:00:00.000Z");
    let at = today;
    const logger = createFileLogger({ dir, now: () => at });
    // 스위트가 남긴 지난 파일들: 하나는 보존 창 안, 하나는 밖.
    writeFileSync(join(dir, "daemon-2026-09-12.log"), "keep\n");
    writeFileSync(join(dir, "daemon-2026-08-20.log"), "gone\n");
    writeFileSync(join(dir, "notes.txt"), "not a log\n");

    logger.info("오늘의 첫 줄");
    at = new Date(today.getTime() + DAY);
    logger.info("다음 날의 첫 줄");

    assert.ok(existsSync(join(dir, "daemon-2026-09-14.log")));
    assert.ok(existsSync(join(dir, "daemon-2026-09-15.log")), "날이 바뀌면 새 파일에 쓴다");
    assert.ok(existsSync(join(dir, "daemon-2026-09-12.log")), "7일 안의 파일은 산다");
    assert.ok(!existsSync(join(dir, "daemon-2026-08-20.log")), "7일을 넘긴 파일은 지운다");
    assert.ok(existsSync(join(dir, "notes.txt")), "로그가 아닌 파일은 건드리지 않는다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("로그 폴더를 만들 수 없어도 도구는 죽지 않는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-log-"));
  try {
    const asFile = join(dir, "occupied");
    writeFileSync(asFile, "파일이 폴더 자리를 막고 있다");
    const logger = createFileLogger({ dir: join(asFile, "logs"), now: () => new Date() });
    assert.doesNotThrow(() => logger.info("이 줄은 나가지 못한다"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
