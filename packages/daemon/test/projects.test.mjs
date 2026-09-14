/**
 * Project registry durability — the file that maps every project to its clone
 * and open pull request. A corrupt read must not become a silent wipe: the
 * damaged copy is parked next to the file for recovery, and every save keeps
 * the previous good copy one rename away.
 *
 * Run: node --test packages/daemon/test/projects.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectRegistry } from "../dist/projects.js";

function workdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The env that points every registry read/write at the test's own file. */
const envFor = (dir) => ({
  COLO_DESIGN_PROJECTS_SETTINGS: join(dir, "projects.json"),
  COLO_DESIGN_PROJECTS_DIR: join(dir, "projects"),
});

test("a corrupt registry is parked as .corrupt instead of silently replaced", () => {
  const dir = workdir("hub-projects-corrupt-");
  try {
    const file = join(dir, "projects.json");
    writeFileSync(file, "{ this is not json", { mode: 0o600 });

    const registry = ProjectRegistry.load(envFor(dir));
    assert.deepEqual(registry.list(), [], "the daemon still boots with an empty registry");
    assert.ok(existsSync(`${file}.corrupt`), "the damaged copy is kept for recovery");
    assert.equal(readFileSync(`${file}.corrupt`, "utf8"), "{ this is not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing registry is the normal first run — no ceremony, no .corrupt", () => {
  const dir = workdir("hub-projects-missing-");
  try {
    const registry = ProjectRegistry.load(envFor(dir));
    assert.deepEqual(registry.list(), []);
    assert.ok(!existsSync(join(dir, "projects.json.corrupt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every save keeps the previous good copy one rename away (.bak)", () => {
  const dir = workdir("hub-projects-bak-");
  try {
    const env = envFor(dir);
    const file = join(dir, "projects.json");

    const registry = ProjectRegistry.load(env);
    registry.create({ name: "첫 프로젝트", repoUrl: "https://github.com/org/one.git" });
    const first = readFileSync(file, "utf8");

    registry.create({ name: "둘 프로젝트", repoUrl: "https://github.com/org/two.git" });

    assert.ok(existsSync(`${file}.bak`), "the previous good copy survived the second save");
    assert.equal(readFileSync(`${file}.bak`, "utf8"), first, ".bak is exactly the last save");
    assert.equal(registry.list().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("지켜 줄 것은 저장되고, 비우면 지워진다", () => {
  const dir = workdir("hub-projects-guard-");
  try {
    const env = envFor(dir);
    const registry = ProjectRegistry.load(env);
    const project = registry.create({
      name: "화면 프로젝트",
      repoUrl: "https://github.com/org/screens.git",
    });

    registry.update(project.slug, { instructions: "  버튼은 CDS 컴포넌트만 씁니다.  " });
    assert.equal(
      ProjectRegistry.load(env).get(project.slug)?.instructions,
      "버튼은 CDS 컴포넌트만 씁니다.",
      "지침은 다듬어져 파일을 넘어 살아남는다",
    );

    // 빈 상자는 "없음"이다 — 지우개가 없으면 한 번 적은 규칙에 갇힌다.
    registry.update(project.slug, { instructions: "   " });
    assert.equal(ProjectRegistry.load(env).get(project.slug)?.instructions, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
