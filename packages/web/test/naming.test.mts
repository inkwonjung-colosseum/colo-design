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

// The MCP prefix is plumbing — the dictionary keys on the tool's own name,
// and an unknown tool passes through with its full name untouched. The
// colo-preview screen tools are gone (the in-process server was), so nothing
// folds them anymore: a stale screen_* name must stay raw.
test("toolLabel strips the mcp__ prefix, then looks the bare name up", () => {
  assert.equal(toolLabel("mcp__anything__Bash"), "명령 실행");
  assert.equal(toolLabel("mcp__colo-preview__screen_screenshot"), "mcp__colo-preview__screen_screenshot");
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
  assert.equal(errorWords("overloaded"), "AI가 붐빕니다");
  assert.equal(errorWords("mystery_code"), null);
});
