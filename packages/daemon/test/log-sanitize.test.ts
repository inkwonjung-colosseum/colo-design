import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileLogger } from "../src/log.ts";

test("비밀·이메일·계정 경로는 눌러 닫힌다", () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-log-"));
  try {
    const logger = createFileLogger({ dir, now: () => new Date("2026-09-22T00:00:00Z") });
    logger.error("요청 실패", {
      detail:
        "fatal: Authentication failed for https://x-access-token:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ@github.com/owner/repo.git",
      contact: "planner@example.com",
      cwd: "/Users/developjik/.colo-design/projects/my-repo/repo",
      slack: "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX",
      bearer: "Bearer eyJhbGciOi.eyJzdWIi.TL0",
    });
    const line = readFileSync(join(dir, "daemon-2026-09-22.log"), "utf8");
    assert.match(line, /\{secret\}@github\.com/);
    assert.doesNotMatch(line, /ghp_[A-Za-z0-9_]+/);
    assert.match(line, /\{email\}/);
    assert.doesNotMatch(line, /planner@example\.com/);
    // 계정 이름만 닫힌다 — 나머지 경로는 지원의 단서로 남는다.
    assert.match(line, /~\/\.colo-design\/projects\/my-repo\/repo/);
    assert.doesNotMatch(line, /developjik/);
    assert.match(line, /"slack":"https:\/\/\{secret\}"/); // 도메인까지 통째로
    assert.doesNotMatch(line, /hooks\.slack\.com/);
    assert.match(line, /Bearer \{secret\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("정상 문장과 중첩 값은 그대로 남는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-log-"));
  try {
    const logger = createFileLogger({ dir, now: () => new Date("2026-09-22T00:00:00Z") });
    logger.info("클라이언트 연결", {
      clients: 2,
      nested: { note: "저장이 성립했습니다", err: new Error("read ECONNRESET on /home/dev/app") },
    });
    const line = readFileSync(join(dir, "daemon-2026-09-22.log"), "utf8");
    assert.match(line, /저장이 성립했습니다/);
    assert.match(line, /~/); // Error 의 message 도 샌다 — /home/dev 가 ~ 로
    assert.doesNotMatch(line, /\/home\/dev/);
    assert.match(line, /"clients":2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
