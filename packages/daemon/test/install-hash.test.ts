import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// `../dist` 임포트인 이유: repo-bringup 은 형제를 `.js` 지정자로 부른다 —
// src 직접 로드는 그 지정을 못 고친다(cycle-observe 와 같은 길).
import {
  BringUp,
  dependencyHash,
  globMatchesDir,
  installStale,
  workspaceGlobs,
  workspacePackageJsons,
} from "../dist/repo-bringup.js";
import { INSTALL_MARKER } from "../dist/repo-core.js";
import { makeScene } from "./helpers/cycle-harness.ts";

const ROOT_PKG = JSON.stringify({ name: "root", workspaces: ["packages/*"] });

/** 임시 레포 폴더 — `write` 는 중간 폴더까지 만든다. */
function tempRepo(): { root: string; write: (rel: string, body: string) => void } {
  const root = mkdtempSync(join(tmpdir(), "install-hash-"));
  const write = (rel: string, body: string) => {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  };
  return { root, write };
}

/** 이 판 전의 해시 — 넷의 이름과 내용만. 옛 표식과의 비교 잣대. */
function legacyHash(root: string): string {
  const hash = createHash("sha256");
  for (const file of ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const path = join(root, file);
    hash.update(file);
    hash.update(existsSync(path) ? readFileSync(path) : Buffer.alloc(0));
  }
  return hash.digest("hex").slice(0, 16);
}

test("workspaceGlobs — pnpm-workspace.yaml 과 package.json workspaces 둘 다 편다", () => {
  assert.deepEqual(workspaceGlobs("packages:\n  - packages/*\n  - apps/*\n", null), [
    "packages/*",
    "apps/*",
  ]);
  assert.deepEqual(workspaceGlobs(null, ROOT_PKG), ["packages/*"]);
  // 배열 아닌 workspaces({packages}) 모양도.
  assert.deepEqual(workspaceGlobs(null, JSON.stringify({ workspaces: { packages: ["apps/*"] } })), [
    "apps/*",
  ]);
  // 없으면 빈 목록 — 깨진 package.json 도 조용히(그것은 루트 해시의 몫).
  assert.deepEqual(workspaceGlobs(null, null), []);
  assert.deepEqual(workspaceGlobs(null, "{broken"), []);
});

test("workspaceGlobs — 주석 · 따옴표 · 빼는 글롭 · 다른 최상위 키", () => {
  const yaml = [
    "# 워크스페이스",
    "packages:",
    "  - 'packages/*' # 라이브러리",
    '  - "apps/**"',
    "# 사이 주석",
    "  - '!**/test/**'",
    "catalog:",
    "  - not-a-package",
  ].join("\n");
  assert.deepEqual(workspaceGlobs(yaml, null), ["packages/*", "apps/**", "!**/test/**"]);
  assert.deepEqual(workspaceGlobs("packages: [libs/*, 'tools/x']\n", null), ["libs/*", "tools/x"]);
});

test("globMatchesDir — * 한 마디, ** 여러 마디", () => {
  assert.equal(globMatchesDir("packages/*", "packages/ui"), true);
  assert.equal(globMatchesDir("packages/*", "packages/ui/src"), false);
  assert.equal(globMatchesDir("packages/**", "packages/ui/src"), true);
  assert.equal(globMatchesDir("apps/*", "packages/ui"), false);
  assert.equal(globMatchesDir("**/test/**", "apps/web/test/fixture"), true);
  assert.equal(globMatchesDir("pkg-*", "pkg-ui"), true);
});

test("workspacePackageJsons — 선언이 담는 package.json 만, node_modules 밖에서", () => {
  const { root, write } = tempRepo();
  write("package.json", ROOT_PKG);
  write("packages/ui/package.json", '{"name":"@x/ui"}');
  write("packages/ui/node_modules/dep/package.json", '{"name":"dep"}');
  write("packages/app/package.json", '{"name":"@x/app"}');
  write("outside/package.json", '{"name":"outside"}');
  assert.deepEqual(workspacePackageJsons(root), [
    "packages/app/package.json",
    "packages/ui/package.json",
  ]);
});

test("workspacePackageJsons — ** 는 내려가고, ! 글롭은 뺀다", () => {
  const { root, write } = tempRepo();
  write("package.json", "{}");
  write("pnpm-workspace.yaml", "packages:\n  - 'apps/**'\n  - '!**/test/**'\n");
  write("apps/web/package.json", "{}");
  write("apps/web/test/fixture/package.json", "{}");
  write("apps/tools/cli/package.json", "{}");
  write("apps/web/node_modules/x/package.json", "{}");
  assert.deepEqual(workspacePackageJsons(root), [
    "apps/tools/cli/package.json",
    "apps/web/package.json",
  ]);
});

test("dependencyHash — 워크스페이스 패키지의 package.json 이 움직이면 해시가 바뀐다", () => {
  const { root, write } = tempRepo();
  write("package.json", ROOT_PKG);
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  write("packages/ui/package.json", '{"name":"@x/ui","version":"0.1.0"}');
  const before = dependencyHash(root);
  // 루트가 그대로여도 패키지의 의존성이 바뀌면 해시가 움직인다.
  write("packages/ui/package.json", '{"name":"@x/ui","version":"0.2.0"}');
  assert.notEqual(dependencyHash(root), before);
  // 돌려놓으면 같은 해시 — 판정은 멱등이다.
  write("packages/ui/package.json", '{"name":"@x/ui","version":"0.1.0"}');
  assert.equal(dependencyHash(root), before);
});

test("dependencyHash — 새 재료가 없는 레포는 옛 해시 그대로, bun 락파일은 있을 때만 셈한다", () => {
  const { root, write } = tempRepo();
  write("package.json", '{"name":"plain","dependencies":{"a":"1"}}');
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  // 이 판으로 올라가도 옛 표식이 그대로 맞는다 — 모든 프로젝트가 한꺼번에
  // 다시 설치하지 않는다.
  assert.equal(dependencyHash(root), legacyHash(root));
  write("bun.lock", "{ lockfileVersion: 1 }\n");
  const withBun = dependencyHash(root);
  assert.notEqual(withBun, legacyHash(root));
  write("bun.lock", "{ lockfileVersion: 2 }\n");
  assert.notEqual(dependencyHash(root), withBun, "bun 락파일이 움직이면 해시가 바뀐다");
});

test("installStale — 트리를 남기지 않은 설치와 Yarn PnP 는 node_modules 없이도 최신", () => {
  const { root, write } = tempRepo();
  write("package.json", '{"name":"x"}');
  mkdirSync(join(root, ".git"));
  const marker = join(root, ".git", INSTALL_MARKER);
  // 표식이 없으면 낡았다 — 한 번도 설치하지 않은 클론.
  assert.equal(installStale(root), true);
  writeFileSync(marker, dependencyHash(root));
  assert.equal(installStale(root), true, "해시가 같아도 트리가 없으면 낡았다");
  writeFileSync(join(root, ".pnp.cjs"), "");
  assert.equal(installStale(root), false, "Yarn PnP 의 로더도 설치된 트리다");
  rmSync(join(root, ".pnp.cjs"));
  // 설치가 트리를 남기지 않았다는 표시 — 틱마다 같은 설치를 되풀이하지 않는다.
  writeFileSync(marker, `${dependencyHash(root)}\nno-tree\n`);
  assert.equal(installStale(root), false);
  // 해시가 움직이면 표시와 무관하게 낡았다.
  write("package.json", '{"name":"x","dependencies":{"a":"1"}}');
  assert.equal(installStale(root), true);
});

test("node_modules 없음 — 마커가 해시와 같아도 설치는 낡았다 (PLAN 단계 9)", async () => {
  const scene = await makeScene();
  try {
    const bringup = new BringUp(scene.core);
    // 하네스 클론엔 lockfile 도 scripts 도 없다 — 설치 선언 자체가 없으니 늘 최신.
    assert.equal(bringup.installUpToDate(), true);
    // lockfile + dev 스크립트를 클론에 두면(미커밋 파일 — 판정은 디스크만 본다)
    // 설치가 선언되고, node_modules 이 없으므로 낡았다.
    writeFileSync(
      join(scene.clone.path, "package.json"),
      JSON.stringify({ name: "x", scripts: { dev: "vite" } }),
    );
    writeFileSync(join(scene.clone.path, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    assert.equal(bringup.installUpToDate(), false);
    // node_modules 과 마커(해시와 같은 값)를 두면 최신 — 지워진 설치가 아니라는 뜻.
    mkdirSync(join(scene.clone.path, "node_modules"));
    writeFileSync(join(scene.clone.path, ".git", INSTALL_MARKER), dependencyHash(scene.clone.path));
    assert.equal(bringup.installUpToDate(), true);
    // 준비의 최신화(pull)가 읽는 해시 판정은 움직이지 않았다.
    assert.equal(bringup.dependenciesMoved(), false);
    // node_modules 을 지우면 해시가 같아도 다시 설치해야 한다 — PLAN 단계 9 의
    // 새 규칙: 지워진 설치는 해시가 기억하지 못한다.
    rmSync(join(scene.clone.path, "node_modules"), { recursive: true, force: true });
    assert.equal(bringup.installUpToDate(), false);
  } finally {
    scene.dispose();
  }
});
