/**
 * Codex 설치·로그인 판별 (2026-09-28) — 설치돼 있지만 로그인이 없는 판이
 * 「설치되지 않았어요」로 읽히던 세계를 고친 자리의 시험. 판별의 세 축을
 * 누른다: 환경 변수 오버라이드, auth.json 유무의 로그인 판정, 고정 후보가
 * 비었을 때의 PATH 탐색.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexDriver, searchPathForCodex } from "../dist/agent/drivers/codex/driver.js";

/** --version 에 답하는 가짜 codex — 성공 판정의 길 그대로를 돈다. */
function fakeCodex(dir: string): string {
  const path = join(dir, "codex");
  writeFileSync(path, "#!/bin/sh\necho 'codex-cli 0.0.0-test'\n", { mode: 0o755 });
  return path;
}

/** 환경 변수를 잠시 바꿔 돌려주는 소매 — 판별이 읽는 건 process.env 그 자체다. */
async function withEnv(patch: Record<string, string | undefined>, body: () => Promise<void>) {
  const before: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    before[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("설치돼 있고 로그인도 됐다 — reason 없이 깨끗한 판정", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-codex-detect-"));
  try {
    mkdirSync(join(dir, "home"));
    writeFileSync(join(dir, "home", "auth.json"), '{"OPENAI_API_KEY":"k"}');
    const executable = fakeCodex(dir);
    await withEnv(
      { COLO_DESIGN_CODEX_BIN: executable, CODEX_HOME: join(dir, "home") },
      async () => {
        const diagnostic = await new CodexDriver().isAvailable();
        assert.equal(diagnostic.ok, true);
        assert.equal(diagnostic.version, "codex-cli 0.0.0-test");
        assert.equal(diagnostic.loggedIn, true);
        assert.equal(diagnostic.reason, undefined);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("설치돼 있지만 로그인이 없다 — 미설치가 아니라 로그인을 말하는 reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-codex-detect-"));
  try {
    mkdirSync(join(dir, "home")); // auth.json 없음
    const executable = fakeCodex(dir);
    await withEnv(
      { COLO_DESIGN_CODEX_BIN: executable, CODEX_HOME: join(dir, "home") },
      async () => {
        const diagnostic = await new CodexDriver().isAvailable();
        assert.equal(diagnostic.ok, true);
        assert.equal(diagnostic.loggedIn, false);
        assert.ok(diagnostic.reason?.includes("로그인"), `reason=${diagnostic.reason}`);
        // 미설치 문구와 갈라 읽히는지 — 「설치되지 않았어요」를 말하지 않는다.
        assert.ok(!diagnostic.reason?.includes("설치하지"));
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("빈 auth.json 은 로그인 없음이다 — 몸통이 있는 것만 센다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-codex-detect-"));
  try {
    mkdirSync(join(dir, "home"));
    writeFileSync(join(dir, "home", "auth.json"), "{}");
    const executable = fakeCodex(dir);
    await withEnv(
      { COLO_DESIGN_CODEX_BIN: executable, CODEX_HOME: join(dir, "home") },
      async () => {
        const diagnostic = await new CodexDriver().isAvailable();
        assert.equal(diagnostic.ok, true);
        assert.equal(diagnostic.loggedIn, false);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("고정 후보가 비었으면 PATH 를 뒤진다 — 찾은 길을 이 실행은 기억한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-codex-detect-"));
  try {
    const found = join(dir, "volta", "codex");
    const type = (stdout: string) =>
      (async () => ({ stdout })) as unknown as Parameters<typeof searchPathForCodex>[0];
    // 못 찾는 세계(빈 stdout)는 null.
    assert.equal(await searchPathForCodex(type("")), null);
    // PATH 가 알려 준 길 — 찾으면 이 실행이 기억한다.
    assert.equal(await searchPathForCodex(type(`${found}\n`)), found);
    // 기억한 길이 살아 있는 한 다시 뒤지지 않는다(which 가 실패해도 그대로).
    mkdirSync(join(dir, "volta"), { recursive: true });
    writeFileSync(found, "#!/bin/sh\n", { mode: 0o755 });
    const exploding = (async () => {
      throw new Error("which should not run");
    }) as unknown as Parameters<typeof searchPathForCodex>[0];
    assert.equal(await searchPathForCodex(exploding), found);
    // 기억한 길이 사라지면 다시 뒤진다 — 이번엔 못 찾는다.
    rmSync(found);
    assert.equal(await searchPathForCodex(type("")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
