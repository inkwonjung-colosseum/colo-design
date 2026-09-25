// U17(E3) — machine.json 의 문자열 키·값 저장. 만료 예정(githubTokenExpiresAt)과
// 예고를 보낸 슬러그(githubExpiryNoticeSlug)가 다시 켠 직후에도 답하는지를 본다.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MachineSetting } from "../dist/machine-setting.js";

test("MachineSetting — 만료 예정 키를 저장하고, 다시 켠 값처럼 읽고, null 은 잊는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-machine-"));
  const file = join(dir, "machine.json");
  try {
    const setting = new MachineSetting(file);
    setting.set("githubTokenExpiresAt", "2026-10-15T12:00:00.000Z");
    setting.set("githubExpiryNoticeSlug", "app");
    assert.equal(setting.get("githubTokenExpiresAt"), "2026-10-15T12:00:00.000Z");
    assert.equal(setting.get("githubExpiryNoticeSlug"), "app");
    // 다시 켠 직후 — 새 객체가 같은 파일을 읽는다. 첫 GitHub 관찰 전에도
    // 설정의 연결 줄이 만료일을 답하는 근거다.
    const reopened = new MachineSetting(file);
    reopened.load();
    assert.equal(reopened.get("githubTokenExpiresAt"), "2026-10-15T12:00:00.000Z");
    assert.equal(reopened.get("githubExpiryNoticeSlug"), "app");
    // null 은 잊는다 — 새 자격의 생애가 시작됐을 때 쓰는 자리다.
    reopened.set("githubTokenExpiresAt", null);
    reopened.set("githubExpiryNoticeSlug", null);
    assert.equal(reopened.get("githubTokenExpiresAt"), null);
    assert.equal(reopened.get("githubExpiryNoticeSlug"), null);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.ok(!("githubTokenExpiresAt" in onDisk));
    assert.ok(!("githubExpiryNoticeSlug" in onDisk));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
