/**
 * 드라이버 원샷의 계약 (2단계 합류) — codex 와 omp 의 단답 턴이 3보장을
 * 어떤 플래그로 내리는지, 그리고 계약 없는 드라이버가 담당 후보에서 빠지는지를
 * 스텁 CLI 위에서 잠근다.
 *
 * Run: node --test packages/daemon/test/one-shot-drivers.test.mjs
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexOneShot } from "../dist/agent/drivers/codex/one-shot.js";
import { OmpDriver } from "../dist/agent/drivers/omp/driver.js";
import { runCliOneShot } from "../dist/agent/one-shot-cli.js";
import { DriverRegistry } from "../dist/agent/registry.js";
import { resolveMachineProvider } from "../dist/machine-provider.js";

const dir = mkdtempSync(join(tmpdir(), "one-shot-drivers-"));
const argsFile = join(dir, "stub-args.json");
process.env.STUB_ARGS_FILE = argsFile;

/** 받은 인자를 기록하고 시나리오대로 답하는 스텁 CLI 를 하나 쓴다. */
function writeStub(name, body) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  const path = join(dir, "bin", name);
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'require("fs").writeFileSync(process.env.STUB_ARGS_FILE, JSON.stringify(args));',
      ...body,
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

test("runCliOneShot — stdout 를 돌려주고, 시간을 넘기면 null", async () => {
  const ok = writeStub("sleeper", ['console.log("늦지 않은 답");']);
  assert.equal(await runCliOneShot(ok, [], { cwd: dir, timeoutMs: 5_000 }), "늦지 않은 답\n");

  const late = writeStub("late", [
    "setTimeout(() => { console.log('너무 늦은 답'); process.exit(0); }, 5_000);",
  ]);
  assert.equal(await runCliOneShot(late, [], { cwd: dir, timeoutMs: 150 }), null);

  assert.equal(await runCliOneShot(join(dir, "없는-CLI"), [], { cwd: dir, timeoutMs: 500 }), null);
});

test("codex oneShot — 읽기 전용 샌드박스 플래그로 답 파일 하나만 읽는다", async () => {
  const stub = writeStub("codex", [
    'const o = args.indexOf("-o");',
    "const prompt = args[args.length - 1];",
    'require("fs").writeFileSync(args[o + 1], `한 줄: ${prompt}`);',
    'console.log("tokens used"); // 진행 출력 — 답통로가 아니다',
  ]);
  process.env.STUB_ARGS_FILE = argsFile;
  const answer = await codexOneShot("문단 추가", {
    cwd: dir,
    executable: stub,
    timeoutMs: 5_000,
  });
  assert.equal(answer, "한 줄: 문단 추가");
  const args = JSON.parse(readFileSync(argsFile, "utf8"));
  assert.deepEqual(
    [
      "exec",
      "-s",
      "read-only",
      "--ephemeral",
      "--skip-git-repo-check",
      "-c",
      "model_reasoning_effort=low",
    ].map((flag) => args.includes(flag)),
    [true, true, true, true, true, true, true],
    `받은 인자: ${JSON.stringify(args)}`,
  );
  assert.equal(args[args.length - 1], "문단 추가", "프롬프트는 마지막 인자");
});

test("codex oneShot — 실패하면 null, 빈 답도 null", async () => {
  process.env.STUB_ARGS_FILE = argsFile;
  const failing = writeStub("codex-fail", ["process.exit(1);"]);
  assert.equal(await codexOneShot("p", { cwd: dir, executable: failing, timeoutMs: 5_000 }), null);
  const empty = writeStub("codex-empty", [
    'const o = args.indexOf("-o");',
    'require("fs").writeFileSync(args[o + 1], "   ");',
  ]);
  assert.equal(await codexOneShot("p", { cwd: dir, executable: empty, timeoutMs: 5_000 }), null);
  assert.equal(await codexOneShot("p", { cwd: dir, executable: null, timeoutMs: 5_000 }), null);
});

test("omp oneShot — 무도구 플래그(-p --no-tools)로 stdout 를 답으로 쓴다", async () => {
  const stub = writeStub("omp", ['console.log("  omp 의 한 줄  ");']);
  process.env.STUB_ARGS_FILE = argsFile;
  process.env.COLO_DESIGN_OMP_BIN = stub;
  const answer = await new OmpDriver().oneShot("초안", { cwd: dir, timeoutMs: 5_000 });
  assert.equal(answer, "omp 의 한 줄", "앞뒤 공백은 잘라낸다");
  const args = JSON.parse(readFileSync(argsFile, "utf8"));
  for (const flag of ["-p", "--no-tools", "--no-session", "--thinking=off", "--model=smol"]) {
    assert.ok(args.includes(flag), `플래그 ${flag} — 받은 인자: ${JSON.stringify(args)}`);
  }
  assert.equal(args[args.length - 1], "초안");

  process.env.COLO_DESIGN_OMP_BIN = writeStub("omp-silent", ['console.log("   ");']);
  assert.equal(
    await new OmpDriver().oneShot("p", { cwd: dir, timeoutMs: 5_000 }),
    null,
    "빈 stdout 은 null",
  );
  delete process.env.COLO_DESIGN_OMP_BIN;
});

test("후보 선택 — 계약 없는 드라이버는 건너뛰고 omp 가 담당이 된다", async () => {
  process.env.COLO_DESIGN_OMP_BIN = writeStub("omp-pick", ['console.log("ok");']);
  const registry = new DriverRegistry();
  registry.register({
    id: "계약없는-드라이버",
    describe: () => ({
      id: "계약없는-드라이버",
      label: "계약 없음",
      modes: [],
      defaultModeId: "",
      capabilities: {},
    }),
    isAvailable: async () => ({ ok: true }),
    createSession: () => {
      throw new Error("세션을 열 일이 없다");
    },
  });
  registry.register(new OmpDriver());
  assert.deepEqual(await resolveMachineProvider(registry, null), { id: "omp", origin: "auto" });
});

test.after(() => {
  delete process.env.COLO_DESIGN_OMP_BIN;
  rmSync(dir, { recursive: true, force: true });
});
