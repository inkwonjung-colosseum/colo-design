import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { bundledToolEnv, gitCandidates } from "../dist/environment.js";
import { windowsBashPath } from "../dist/onboarding.js";

/** 주어진 경로들만 존재한다고 답하는 시험용 exists. */
const existsOf =
  (paths: string[]) =>
  (path: string): boolean =>
    paths.includes(path);

// ---------------------------------------------------------------------------
// 번들 도구 환경 — darwin
// ---------------------------------------------------------------------------

test("번들 git 이 있으면 PATH 앞자리와 두 변수를 내놓는다 (darwin)", () => {
  const bin = "/Applications/Colo Design.app/Contents/Resources/bin";
  const env = bundledToolEnv(bin, "darwin", {}, existsOf([join(bin, "git", "bin", "git")]));
  assert.deepEqual(env.pathPrefixes, [join(bin, "git", "bin")]);
  assert.equal(env.env.GIT_EXEC_PATH, join(bin, "git", "libexec", "git-core"));
  assert.equal(env.env.GIT_TEMPLATE_DIR, join(bin, "git", "share", "git-core", "templates"));
});

test("번들 git 이 없으면 아무것도 안 한다 (darwin)", () => {
  const env = bundledToolEnv("/nowhere", "darwin", { GIT_EXEC_PATH: "/기존/값" }, () => false);
  assert.deepEqual(env.pathPrefixes, []);
  assert.deepEqual(env.env, {});
  // 기존 값을 확인하지도 않는다 — 번들이 없으면 개입 자체가 없다.
  assert.equal(env.env.GIT_EXEC_PATH, undefined);
});

test("번들이 있으면 기존 변수를 덮어쓴다 (darwin) — exec path 가 섞이면 깨지므로", () => {
  const bin = "/r/bin";
  const env = bundledToolEnv(
    bin,
    "darwin",
    { GIT_EXEC_PATH: "/다른/git/libexec/git-core", GIT_TEMPLATE_DIR: "/다른/templates" },
    existsOf([join(bin, "git", "bin", "git")]),
  );
  assert.equal(env.env.GIT_EXEC_PATH, join(bin, "git", "libexec", "git-core"));
  assert.equal(env.env.GIT_TEMPLATE_DIR, join(bin, "git", "share", "git-core", "templates"));
});

// ---------------------------------------------------------------------------
// 번들 도구 환경 — win32
// ---------------------------------------------------------------------------

test("번들 bash.exe 가 있으면 CLAUDE_CODE_GIT_BASH_PATH 를 세운다 (win32)", () => {
  const bin = "C:\\Apps\\Colo Design\\resources\\bin";
  const bash = join(bin, "usr", "bin", "bash.exe");
  const env = bundledToolEnv(bin, "win32", {}, existsOf([bash]));
  assert.deepEqual(env.pathPrefixes, []);
  assert.equal(env.env.CLAUDE_CODE_GIT_BASH_PATH, bash);
});

test("번들 bash.exe 가 없으면 세우지 않는다 (win32)", () => {
  const env = bundledToolEnv("C:\\Apps", "win32", {}, () => false);
  assert.deepEqual(env.env, {});
});

test("사용자가 정한 CLAUDE_CODE_GIT_BASH_PATH 는 존중한다 (win32)", () => {
  const bin = "C:\\Apps";
  const env = bundledToolEnv(
    bin,
    "win32",
    { CLAUDE_CODE_GIT_BASH_PATH: "C:\\내\\bash.exe" },
    existsOf([join(bin, "usr", "bin", "bash.exe")]),
  );
  assert.deepEqual(env.env, {});
});

test("darwin 번들 경로는 win32 규칙에 들지 않는다 — 플랫폼이 갈라놓는다", () => {
  const env = bundledToolEnv("/r/bin", "linux", {}, () => true);
  assert.deepEqual(env.pathPrefixes, []);
  assert.deepEqual(env.env, {});
});

// ---------------------------------------------------------------------------
// git 탐색 — darwin 이 번들을 맨 앞에 둔다
// ---------------------------------------------------------------------------

test("gitCandidates(darwin): EXTRA_PATH 각 항목의 번들 git 이 맨 앞이다", () => {
  const candidates = gitCandidates("darwin", { COLO_DESIGN_EXTRA_PATH: "/r/bin:/다른/곳" });
  assert.deepEqual(candidates, [
    "/r/bin/git/bin/git",
    "/다른/곳/git/bin/git",
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
    "/usr/bin/git",
  ]);
});

test("gitCandidates(darwin): EXTRA_PATH 없으면 지금 그대로 — 개발 실행", () => {
  assert.deepEqual(gitCandidates("darwin", {}), [
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
    "/usr/bin/git",
  ]);
});

// ---------------------------------------------------------------------------
// Windows bash 확인 — Claude CLI 가 찾는 자리 셋
// ---------------------------------------------------------------------------

test("windowsBashPath: 지정한 변수가 실재하면 그 길을 돌려준다", () => {
  const found = windowsBashPath(
    { CLAUDE_CODE_GIT_BASH_PATH: "C:\\번들\\bash.exe" },
    existsOf(["C:\\번들\\bash.exe"]),
  );
  assert.equal(found, "C:\\번들\\bash.exe");
});

test("windowsBashPath: 변수가 비었으면 ProgramFiles 의 Git bash 를 본다", () => {
  // 기대값도 join 으로 조립한다 — 이 테스트는 POSIX 에서도 돌고(구분자 /),
  // Windows 에서는 둘 다 \ 로 조립되어 어느 쪽이든 일치한다.
  const fallback = join("C:\\Program Files (x86)", "Git", "bin", "bash.exe");
  const found = windowsBashPath(
    { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    existsOf([fallback]),
  );
  assert.equal(found, fallback);
});

test("windowsBashPath: 어디에도 없으면 null — 온보딩 게이트가 실패 문장으로 잡는다", () => {
  assert.equal(
    windowsBashPath(
      { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
      () => false,
    ),
    null,
  );
});
