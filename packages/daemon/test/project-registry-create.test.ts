import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// 이 시험은 빌드 뒤에 돈다(루트 pnpm test = build → node --test). projects 은
// environment.js 를 데리고 있어 src 직접 로드가 안 되고, 형제 시험들의 순수
// 모듈 전통과 달리 여기는 dist 를 본다.
import { ProjectRegistry } from "../dist/projects.js";

/** 임시 폴더 하나에 레지스트리를 만든다 — COLO_DESIGN_* 환경만 주면 된다. */
function registry(): { registry: ProjectRegistry; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "project-registry-create-"));
  const file = join(dir, "projects.json");
  return {
    registry: ProjectRegistry.load({
      COLO_DESIGN_PROJECTS_SETTINGS: file,
      COLO_DESIGN_PROJECTS_DIR: join(dir, "projects"),
    }),
    file,
    dir,
  };
}

test("create 는 지침을 trim 해 저장한다", () => {
  const { registry: reg, file, dir } = registry();
  try {
    const project = reg.create({
      name: "회원 관리",
      repoUrl: "https://github.com/org/repo.git",
      instructions: "  목 데이터는 mock 파일에만 둔다  ",
    });
    assert.equal(project.instructions, "목 데이터는 mock 파일에만 둔다");
    // 저장 파일에도 그대로 — create 는 즉시 남는다.
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      projects: Array<{ instructions?: string }>;
    };
    assert.equal(saved.projects[0]?.instructions, "목 데이터는 mock 파일에만 둔다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("빈 지침은 저장되지 않는다 — update 와 같은 규칙", () => {
  const { registry: reg, file, dir } = registry();
  try {
    const project = reg.create({
      name: "회원 관리",
      repoUrl: "https://github.com/org/repo.git",
      instructions: "   ",
    });
    assert.equal(project.instructions, undefined);
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.includes("instructions"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("첫 프로젝트만 active 다 — 둘째는 active 를 바꾸지 않는다", () => {
  const { registry: reg, dir } = registry();
  try {
    const first = reg.create({ name: "첫째", repoUrl: "https://github.com/org/a.git" });
    assert.equal(reg.activeSlug(), first.slug);
    const second = reg.create({ name: "둘째", repoUrl: "https://github.com/org/b.git" });
    assert.equal(second.slug !== first.slug, true);
    assert.equal(reg.activeSlug(), first.slug);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
