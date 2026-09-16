import assert from "node:assert/strict";
import { test } from "node:test";
import { toolLabel } from "../../protocol/src/tool-names.ts";
import { errorWords } from "../src/lib/error-words.ts";
import { bashHeadline, objectParticle } from "../src/lib/labels.ts";

// The dictionary, not the CLI, names a machine action.
test("toolLabel names known tools in Korean", () => {
  assert.equal(toolLabel("Bash"), "명령 실행");
  assert.equal(toolLabel("Write"), "파일 만들기");
  assert.equal(toolLabel("MultiEdit"), "파일 고치기");
});

// The colo-preview 도구는 하나의 동작으로 읽힌다. The names
// arrive with the MCP server prefix on (`mcp__colo-preview__screen_*`), so the
// dictionary is keyed on the tool's own name and the prefix is stripped.
test("toolLabel folds the screen tools into 화면 보기", () => {
  for (const name of [
    "screen_list",
    "screen_open",
    "screen_screenshot",
    "screen_read",
    "screen_click",
    "screen_type",
    "screen_press",
    "screen_scroll",
    "screen_hover",
    "screen_console",
  ]) {
    assert.equal(toolLabel(name), "화면 보기");
    assert.equal(toolLabel(`mcp__colo-preview__${name}`), "화면 보기");
  }
});

test("toolLabel passes an unknown tool through", () => {
  assert.equal(toolLabel("SomeFutureTool"), "SomeFutureTool");
});

// The particle follows the label's own ending, so the card reads as Korean.
test("objectParticle picks 을 after a final consonant", () => {
  assert.equal(objectParticle("명령 실행"), "을");
  assert.equal(objectParticle("파일 만들기"), "를");
  assert.equal(objectParticle("SomeTool"), "를");
});

// A command that IS the repo's own colo-design.json command reads as the job.
test("bashHeadline names a declared gate command", () => {
  const commands = {
    install: "pnpm install",
    check: "pnpm check",
    build: "pnpm build",
  };
  assert.equal(bashHeadline("pnpm check", commands), "레포 검사");
  assert.equal(bashHeadline("  pnpm install ", commands), "설치 실행");
});

test("bashHeadline keeps an unknown command raw", () => {
  assert.equal(bashHeadline("rm -rf build", { check: "pnpm check" }), "rm -rf build");
  assert.equal(bashHeadline("pnpm lint", undefined), "pnpm lint");
});

// Error ids become sentences; unknown ids fall through.
test("errorWords maps known ids and passes unknown ones", () => {
  assert.equal(errorWords("overloaded"), "Claude가 붐빕니다");
  assert.equal(errorWords("mystery_code"), null);
});
