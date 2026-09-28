import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-update-row.test.ts 와 같은 모양).
import { advanceInstallStep, classifyInstallLine } from "../src/next/lib/install-step.ts";

test("classifyInstallLine: 설치 프로그램의 날 줄을 세 단계로 가린다", () => {
  // Claude 설치 스크립트의 영어 줄.
  assert.equal(classifyInstallLine("Downloading Claude Code 2.2.0..."), "download");
  assert.equal(classifyInstallLine("Installing Claude Code..."), "install");
  assert.equal(classifyInstallLine("Successfully installed Claude Code"), "install");
  // Codex 진행기의 한국어 줄 — 접두어와 바이트 수가 섞여도 단계는 닿는다.
  assert.equal(classifyInstallLine("Codex 내려받는 중 15 MB / 120 MB"), "download");
  assert.equal(classifyInstallLine("Codex 확인하는 중…"), "verify");
  assert.equal(classifyInstallLine("Codex 설치하는 중…"), "install");
  // 해시 확인의 영어 표기.
  assert.equal(classifyInstallLine("verifying sha256 digest"), "verify");
});

test("classifyInstallLine: 모르는 줄은 null — 직전 단계가 살아 남는다", () => {
  assert.equal(classifyInstallLine("resolved 401 packages"), null);
  assert.equal(classifyInstallLine(""), null);
});

test("advanceInstallStep: 모르는 줄은 직전 단계를 유지한다", () => {
  assert.equal(advanceInstallStep("download", "npm warn deprecated"), "download");
  assert.equal(advanceInstallStep(null, "resolved 401 packages"), null);
  assert.equal(advanceInstallStep("download", "Installing Claude Code..."), "install");
});

test("advanceInstallStep: 줄이 끊기면 단계도 처음부터", () => {
  assert.equal(advanceInstallStep("install", null), null);
  assert.equal(advanceInstallStep("install", undefined), null);
  assert.equal(advanceInstallStep("install", "   "), null);
});

test("advanceInstallStep: 확인 · 설치의 말이 한 줄에 섞이면 뒤 걸음을 택한다", () => {
  assert.equal(advanceInstallStep("download", "verify then install"), "install");
});
