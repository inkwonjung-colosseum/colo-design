// PLAN-HARNESS §3.C 의 시험 — 증분 타입 진단. 판정(파싱 · 답 문장 · 계획)은
// 순수 함수로, 줄 세우기와 상한은 가짜 spawn 으로, 마지막 한 건은 이 모노레포의
// 설치된 typescript 로 진짜 tsc 를 돌려 본다. `../dist` 임포트인 이유: node
// --test 는 src 의 `.js` 지정자를 못 읽는다.
import assert from "node:assert/strict";
import type { ChildProcess, spawn as realSpawn, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BROWSER_TOOLS } from "../dist/browser-tools.js";
import { repoCommandEnv } from "../dist/repo-bringup.js";
import {
  diagnosticsAnswer,
  isTypeScriptFile,
  MAX_TYPE_LINES,
  parseTscOutput,
  TypeChecker,
  type TypeCheckResult,
  typeCheckPlan,
  typeTroublesOf,
} from "../dist/type-check.js";

// ————— 파싱 —————

test("parseTscOutput — 한 줄의 진단을 file·line·col·code·message 로", () => {
  const parsed = parseTscOutput(
    "a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  );
  assert.deepEqual(parsed, [
    {
      file: "a.ts",
      line: 3,
      col: 7,
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
    },
  ]);
});

test("parseTscOutput — 들여 쓴 이어진 줄은 버리고 첫 줄만 남는다", () => {
  const parsed = parseTscOutput(
    [
      "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  The type 'string' is not assignable to the type 'number'.",
      "",
      "Found 1 error in 1 file.",
    ].join("\n"),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.message, "Type 'string' is not assignable to type 'number'.");
});

test("parseTscOutput — 윈도우 경로의 백슬래시는 슬래시로", () => {
  const parsed = parseTscOutput("src\\app\\MemberList.tsx(12,5): error TS2741: 빠진 prop");
  assert.equal(parsed[0]?.file, "src/app/MemberList.tsx");
});

test("parseTscOutput — 파일 없는 오류 줄은 file 이 빈 진단이 된다", () => {
  const parsed = parseTscOutput("error TS5083: Cannot read file 'x/tsconfig.json'.");
  assert.deepEqual(parsed, [
    { file: "", line: 0, col: 0, code: "TS5083", message: "Cannot read file 'x/tsconfig.json'." },
  ]);
});

// ————— 답 문장 —————

test("diagnosticsAnswer — ok 0건은 한 줄", () => {
  assert.equal(
    diagnosticsAnswer({ status: "ok", diagnostics: [], ms: 1_500 }, []),
    "타입 오류 없음 (2초)",
  );
});

test("diagnosticsAnswer — 바뀐 파일의 진단이 먼저 실린다", () => {
  const result: TypeCheckResult = {
    status: "ok",
    ms: 3_000,
    diagnostics: [
      { file: "src/a.ts", line: 1, col: 1, code: "TS2322", message: "a 문제" },
      { file: "src/b.ts", line: 2, col: 3, code: "TS2345", message: "b 문제" },
    ],
  };
  assert.equal(
    diagnosticsAnswer(result, ["src/b.ts"]),
    [
      "타입 오류 2건 — 이번에 바뀐 파일에서 1건",
      "- src/b.ts:2:3 TS2345 b 문제",
      "- src/a.ts:1:1 TS2322 a 문제",
    ].join("\n"),
  );
});

test("diagnosticsAnswer — 30줄 상한을 넘으면 나머지 수만 알린다", () => {
  const diagnostics = Array.from({ length: 32 }, (_, i) => ({
    file: `src/f${i}.ts`,
    line: i + 1,
    col: 1,
    code: "TS2322",
    message: `문제 ${i}`,
  }));
  const answer = diagnosticsAnswer({ status: "ok", diagnostics, ms: 1_000 }, []);
  const lines = answer.split("\n");
  assert.equal(lines.length, 32);
  assert.equal(lines[0], "타입 오류 32건 — 이번에 바뀐 파일에서 0건");
  assert.equal(lines[1], "- src/f0.ts:1:1 TS2322 문제 0");
  assert.equal(lines.at(-1), "… 나머지 2건");
});

test("diagnosticsAnswer — 진단 메시지는 200자에서 자른다", () => {
  const long = "가".repeat(300);
  const answer = diagnosticsAnswer(
    {
      status: "ok",
      ms: 1,
      diagnostics: [{ file: "a.ts", line: 1, col: 1, code: "TS2322", message: long }],
    },
    [],
  );
  const line = answer.split("\n")[1] ?? "";
  assert.ok(line.includes("가".repeat(200)));
  assert.ok(!line.includes("가".repeat(201)));
});

test("diagnosticsAnswer — unavailable · timeout · failed 의 문장", () => {
  assert.equal(
    diagnosticsAnswer({ status: "unavailable", reason: "tsconfig.json 이 없습니다" }, []),
    "이 레포에는 타입 검사가 없습니다 — tsconfig.json 이 없습니다",
  );
  assert.equal(
    diagnosticsAnswer({ status: "timeout", ms: 120_000 }, []),
    "타입 검사가 120초 안에 끝나지 않았습니다 — 레포의 검사 명령으로 확인하십시오",
  );
  assert.equal(
    diagnosticsAnswer({ status: "failed", reason: "무슨 이유" }, []),
    "타입 검사를 실행하지 못했습니다 — 무슨 이유",
  );
});

// ————— 계획 —————

/** 임시 클론 — tsconfig 과 node_modules/typescript/bin/tsc 을 채워 넣는다. */
function makeRepo(withTsconfig: boolean, withTypescript: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "nova-type-check-plan-"));
  if (withTsconfig) writeFileSync(join(root, "tsconfig.json"), "{}");
  if (withTypescript) {
    mkdirSync(join(root, "node_modules", "typescript", "bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", "typescript", "bin", "tsc"), "");
  }
  return root;
}

test("typeCheckPlan — tsconfig 이 없으면 그 이유로 unavailable", () => {
  const plan = typeCheckPlan(makeRepo(false, true), "/project/tsc.tsbuildinfo");
  assert.deepEqual(plan, { unavailable: "tsconfig.json 이 없습니다" });
});

test("typeCheckPlan — typescript 이 없으면 그 이유로 unavailable", () => {
  const plan = typeCheckPlan(makeRepo(true, false), "/project/tsc.tsbuildinfo");
  assert.deepEqual(plan, { unavailable: "typescript 가 설치돼 있지 않습니다" });
});

test("typeCheckPlan — 둘 다 있으면 node 로 tsc, 빌드 정보 파일은 클론 밖", () => {
  const repoRoot = makeRepo(true, true);
  const buildInfoFile = join(repoRoot, "..", "tsc.tsbuildinfo");
  const plan = typeCheckPlan(repoRoot, buildInfoFile);
  assert.ok(!("unavailable" in plan), "둘 다 있으면 계획이 있다");
  if ("unavailable" in plan) return;
  assert.equal(plan.command, "node");
  assert.equal(plan.args[0], join(repoRoot, "node_modules", "typescript", "bin", "tsc"));
  assert.deepEqual(plan.args.slice(1), [
    "--noEmit",
    "--pretty",
    "false",
    "--incremental",
    "--tsBuildInfoFile",
    buildInfoFile,
    "-p",
    "tsconfig.json",
  ]);
  // 빌드 정보 파일은 클론 밖 — git status 가 깨끗해야 하므로.
  assert.ok(!buildInfoFile.startsWith(repoRoot));
});

// ————— 가짜 spawn — 줄 세우기 · 상한 · 실패 —————

/** 가짜 spawn 의 형태 — 진짜 spawn 과 같은 계약을 흉내 낸다. */
type SpawnFn = typeof realSpawn;

interface FakeChild {
  say: (text: string) => void;
  close: (code: number | null) => void;
  kills: string[];
}

/**
 * spawn 을 가짜로 바꾸는 자리 — 자식은 EventEmitter 로, close 를 시험이 직접
 * 부른다. kill 을 받으면 close(null, signal) 로 답해 실제 자식의 모양을 따른다.
 */
function fakeSpawn(): { children: FakeChild[]; spawn: SpawnFn } {
  const children: FakeChild[] = [];
  const spawn = ((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter() as ChildProcess;
    Object.assign(proc, { stdout, stderr, pid: 1_000 + children.length });
    const kills: string[] = [];
    proc.kill = (signal?: string) => {
      kills.push(signal ?? "SIGTERM");
      queueMicrotask(() => proc.emit("close", null, signal ?? "SIGTERM"));
      return true;
    };
    children.push({
      say: (text: string) => stdout.emit("data", Buffer.from(text)),
      close: (code: number | null) => proc.emit("close", code, null),
      kills,
    });
    return proc;
  }) as unknown as SpawnFn;
  return { children, spawn };
}

test("TypeChecker — 도는 검사가 있으면 하나만 줄을 서고 셋은 둘째 결과를 받는다", async () => {
  const repoRoot = makeRepo(true, true);
  const { children, spawn } = fakeSpawn();
  const checker = new TypeChecker({ spawn, timeoutMs: 10_000 });

  const first = checker.check(repoRoot, "/project", {});
  const second = checker.check(repoRoot, "/project", {});
  const third = checker.check(repoRoot, "/project", {});
  // 셋이 불렀지만 자식은 하나 — 나머지 둘은 줄 선 검사 하나를 기다린다.
  assert.equal(children.length, 1);

  children[0]?.say("a.ts(1,1): error TS2322: 첫째\n");
  children[0]?.close(2);
  const firstResult = await first;
  assert.equal(firstResult.status, "ok");
  assert.equal(firstResult.diagnostics[0]?.file, "a.ts");
  // 첫째가 끝나야 줄 선 검사가 하나 돈다 — .then 에서 자식이 켜지는 순간을 한
  // 번 기다린다. 셋이 불렀어도 자식은 둘뿐이다.
  const { promise: turn, resolve: nextTurn } = Promise.withResolvers<void>();
  setImmediate(nextTurn);
  await turn;
  assert.equal(children.length, 2);
  children[1]?.say("b.ts(2,2): error TS2322: 둘째\n");
  children[1]?.close(2);
  const [secondResult, thirdResult] = await Promise.all([second, third]);
  assert.deepEqual(secondResult, thirdResult);
  assert.equal(secondResult.status, "ok");
  assert.equal(secondResult.diagnostics[0]?.file, "b.ts");
  assert.equal(children.length, 2);
});

test("TypeChecker — 상한을 넘으면 자식을 죽이고 timeout", async () => {
  const repoRoot = makeRepo(true, true);
  const { children, spawn } = fakeSpawn();
  const checker = new TypeChecker({ spawn, timeoutMs: 40 });

  const result = await checker.check(repoRoot, "/project", {});
  assert.equal(result.status, "timeout");
  if (result.status === "timeout") assert.ok(result.ms >= 40);
  // 자식이 죽었다 — kill 이 불렸다.
  assert.equal(children[0]?.kills.length, 1);
});

test("TypeChecker — 진단 없이 끝나면 failed, 비지 않은 마지막 줄이 이유", async () => {
  const repoRoot = makeRepo(true, true);
  const { children, spawn } = fakeSpawn();
  const checker = new TypeChecker({ spawn, timeoutMs: 10_000 });

  const pending = checker.check(repoRoot, "/project", {});
  children[0]?.say("무슨 출력\n마지막 줄의 이유\n");
  children[0]?.close(1);
  assert.deepEqual(await pending, { status: "failed", reason: "마지막 줄의 이유" });
});

// ————— 도구 계약 —————

test("repo_diagnostics 도구 — submit_for_review 바로 앞에 선다", () => {
  const names = BROWSER_TOOLS.map((tool) => tool.name);
  const diagnostics = names.indexOf("repo_diagnostics");
  assert.ok(diagnostics > 0);
  assert.equal(names.indexOf("submit_for_review"), diagnostics + 1);
  // 목록의 맨 끝은 그대로 screen_files · notify_developer (screen-files 시험의 계약).
  assert.deepEqual(names.slice(-2), ["screen_files", "notify_developer"]);
  const tool = BROWSER_TOOLS[diagnostics];
  assert.equal(tool?.op, "repoDiagnostics");
  assert.deepEqual(tool?.properties, {});
  assert.equal(tool?.required, undefined);
});

// ————— 게이트의 타입 절 (PLAN-HARNESS §3.D D-1) —————

test("isTypeScriptFile — ts · tsx · mts · cts 는 참, 다른 확장자는 거짓", () => {
  for (const yes of ["a.ts", "a.tsx", "a.mts", "a.cts", "b.d.ts", "src/screens/A.screen.tsx"]) {
    assert.equal(isTypeScriptFile(yes), true, yes);
  }
  for (const no of ["a.js", "a.jsx", "server.js", "a.ts.bak", "README.md", "a.json"]) {
    assert.equal(isTypeScriptFile(no), false, no);
  }
  // 윈도우 표기도 레포 루트 상대 슬래시 표기와 같게 본다.
  assert.equal(isTypeScriptFile("src\\screens\\A.tsx"), true);
});

test("typeTroublesOf — 바뀐 파일의 오류만 줄로 실고 errors 는 그 전체 수다", () => {
  const result: TypeCheckResult = {
    status: "ok",
    ms: 800,
    diagnostics: [
      { file: "src/a.ts", line: 3, col: 7, code: "TS2322", message: "형식이 맞지 않습니다" },
      { file: "src/b.tsx", line: 1, col: 1, code: "TS7006", message: "암시적 any" },
      { file: "src/old.ts", line: 9, col: 2, code: "TS2345", message: "옛 오류" },
    ],
  };
  const troubles = typeTroublesOf(result, ["src/a.ts", "src\\b.tsx"]);
  assert.notEqual(troubles, null);
  assert.equal(troubles?.errors, 2);
  assert.deepEqual(troubles?.lines, [
    "- src/a.ts:3:7 TS2322 형식이 맞지 않습니다",
    "- src/b.tsx:1:1 TS7006 암시적 any",
  ]);
});

test("typeTroublesOf — 상한 10줄을 넘으면 나머지 수만 알린다", () => {
  const diagnostics = Array.from({ length: 12 }, (_, i) => ({
    file: "src/a.ts",
    line: i + 1,
    col: 1,
    code: "TS2322",
    message: `오류 ${i + 1}`,
  }));
  const troubles = typeTroublesOf({ status: "ok", ms: 5, diagnostics }, ["src/a.ts"]);
  assert.equal(troubles?.errors, 12);
  assert.equal(troubles?.lines.length, MAX_TYPE_LINES + 1);
  assert.equal(troubles?.lines[MAX_TYPE_LINES], "… 나머지 2건");
});

test("typeTroublesOf — ok 아닌 결과와 오류 0 은 null", () => {
  for (const result of [
    { status: "unavailable" as const, reason: "tsconfig.json 이 없습니다" },
    { status: "timeout" as const, ms: 1000 },
    { status: "failed" as const, reason: "이유" },
  ]) {
    assert.equal(typeTroublesOf(result, ["a.ts"]), null);
  }
  assert.equal(typeTroublesOf({ status: "ok", ms: 5, diagnostics: [] }, ["a.ts"]), null);
  const elsewhere: TypeCheckResult = {
    status: "ok",
    ms: 5,
    diagnostics: [{ file: "src/old.ts", line: 1, col: 1, code: "TS2322", message: "옛 오류" }],
  };
  assert.equal(typeTroublesOf(elsewhere, ["src/a.ts"]), null);
});

// ————— 진짜 tsc —————

/** 이 모노레포의 설치된 typescript — require.resolve 류로 찾지 않고 레포 루트에서. */
const TYPESCRIPT_INSTALL = fileURLToPath(
  new URL("../../../node_modules/typescript", import.meta.url),
);

test("TypeChecker — 진짜 tsc: 오류를 돌려주고 빌드 정보 파일은 클론 밖에", {
  timeout: 60_000,
}, async () => {
  assert.ok(
    existsSync(join(TYPESCRIPT_INSTALL, "bin", "tsc")),
    "레포 루트의 node_modules/typescript 가 있어야 이 시험이 돈다",
  );
  const root = mkdtempSync(join(tmpdir(), "nova-type-check-real-"));
  const repoRoot = join(root, "repo");
  const projectRoot = join(root, "project");
  try {
    mkdirSync(projectRoot);
    mkdirSync(repoRoot);
    writeFileSync(
      join(repoRoot, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    writeFileSync(join(repoRoot, "a.ts"), 'const x: number = "문자";\n');
    mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
    symlinkSync(TYPESCRIPT_INSTALL, join(repoRoot, "node_modules", "typescript"), "dir");

    const checker = new TypeChecker();
    const env = repoCommandEnv(process.env);
    const first = await checker.check(repoRoot, projectRoot, env);
    assert.equal(first.status, "ok");
    assert.equal(first.diagnostics.length, 1);
    assert.equal(first.diagnostics[0]?.file, "a.ts");
    assert.equal(first.diagnostics[0]?.code, "TS2322");
    assert.equal(first.diagnostics[0]?.line, 1);

    const second = await checker.check(repoRoot, projectRoot, env);
    assert.equal(second.status, "ok");
    assert.equal(second.diagnostics[0]?.code, "TS2322");
    // 빌드 정보 파일이 클론 밖의 프로젝트 폴더에 있다.
    assert.ok(existsSync(join(projectRoot, "tsc.tsbuildinfo")));
    // 클론 안에는 어떤 파일도 늘지 않는다 — tsconfig · a.ts · node_modules 뿐.
    assert.deepEqual(readdirSync(repoRoot).sort(), ["a.ts", "node_modules", "tsconfig.json"]);
    console.log(`[type-check] 진짜 tsc 첫 호출 ${first.ms}ms · 둘째 호출 ${second.ms}ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
