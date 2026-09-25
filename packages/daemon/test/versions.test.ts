import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, isNewerVersion, parseVersion, plainVersion } from "../dist/versions.js";

test("버전 읽기: CLI 의 글 · 릴리스 태그 · v 접두사에서 첫 버전을 뽑는다", () => {
  assert.equal(plainVersion("2.1.4 (Claude Code)"), "2.1.4");
  assert.equal(plainVersion("codex-cli 0.46.0"), "0.46.0");
  assert.equal(plainVersion("rust-v0.46.0"), "0.46.0");
  assert.equal(plainVersion("v1.2.0-beta.1"), "1.2.0-beta.1");
  assert.equal(plainVersion("1.2.0+build.5"), "1.2.0");
  assert.equal(plainVersion("버전 없음"), null);
  assert.equal(plainVersion(null), null);
  assert.deepEqual(parseVersion("v3.10"), { numbers: [3, 10], prerelease: [] });
});

test("버전 비교: 숫자로 조각마다 — 문자열 순서가 아니다", () => {
  assert.equal(compareVersions("2.1.10", "2.1.9"), 1);
  assert.equal(compareVersions("2.1.9", "2.1.10"), -1);
  assert.equal(compareVersions("v2.1.4", "2.1.4 (Claude Code)"), 0);
  assert.equal(compareVersions("rust-v0.46.0", "codex-cli 0.45.2"), 1);
  // 빠진 조각은 0 — 2.1 == 2.1.0.
  assert.equal(compareVersions("2.1", "2.1.0"), 0);
});

test("버전 비교: 프리릴리스는 같은 본판보다 앞서고, 조각은 semver 규칙대로", () => {
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-beta.11"), 1);
  // 본판이 다르면 꼬리는 보지 않는다.
  assert.equal(compareVersions("1.0.1-alpha", "1.0.0"), 1);
});

test("버전 비교: 읽지 못하는 쪽은 가장 앞 — 새 버전 판정은 거짓", () => {
  assert.equal(compareVersions("garbage", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", undefined), 1);
  assert.equal(compareVersions(null, "<html>"), 0);
  assert.equal(isNewerVersion("2.2.0", "2.1.4 (Claude Code)"), true);
  assert.equal(isNewerVersion("2.1.4", "2.1.4 (Claude Code)"), false);
  assert.equal(isNewerVersion("2.2.0", null), false);
  assert.equal(isNewerVersion("<html>", "2.1.4"), false);
});
