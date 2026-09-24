import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("초대 v4: defaults·lifecycle 이 projects.json 을 거쳐 살아남는다", () => {
  const { registry: reg, file, dir } = registry();
  try {
    reg.create({
      name: "회원 관리",
      repoUrl: "https://github.com/org/repo.git",
      defaults: { provider: "claude", model: "sonnet", effort: "high" },
      lifecycle: { deleteMergedBranches: false, keepRejectedDays: 30, autoReply: false },
    });
    // 디스크에서 다시 읽은 레지스트리가 같은 값을 돌려준다 — 손편집이 아닌
    // 정상 왕복의 증거다.
    const reloaded = ProjectRegistry.load({
      COLO_DESIGN_PROJECTS_SETTINGS: file,
      COLO_DESIGN_PROJECTS_DIR: join(dir, "projects"),
    });
    const project = reloaded.list()[0];
    assert.deepEqual(project?.defaults, { provider: "claude", model: "sonnet", effort: "high" });
    assert.deepEqual(project?.lifecycle, {
      deleteMergedBranches: false,
      keepRejectedDays: 30,
      autoReply: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("초대 v4: update 의 null 은 defaults·lifecycle 을 지운다 — 개발자의 값이라 덮는다", () => {
  const { registry: reg, dir } = registry();
  try {
    const project = reg.create({
      name: "회원 관리",
      repoUrl: "https://github.com/org/repo.git",
      defaults: { model: "sonnet" },
      lifecycle: { autoReply: false },
    });
    reg.update(project.slug, { defaults: null, lifecycle: null });
    const after = reg.get(project.slug);
    assert.equal(after?.defaults, undefined);
    assert.equal(after?.lifecycle, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("초대 v4: 손편집으로 깨진 defaults·lifecycle 은 파서가 버린다", () => {
  const { registry: reg, file, dir } = registry();
  try {
    const project = reg.create({ name: "회원 관리", repoUrl: "https://github.com/org/repo.git" });
    // 디스크의 JSON 을 직접 깨뜨린다 — 잘못된 effort 와 범위 밖 일수.
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      projects: Array<Record<string, unknown>>;
    };
    saved.projects[0]!.defaults = { model: "sonnet", effort: "엄청" };
    saved.projects[0]!.lifecycle = { keepRejectedDays: 9999, autoReply: "yes" };
    writeFileSync(file, JSON.stringify(saved));
    const reloaded = ProjectRegistry.load({
      COLO_DESIGN_PROJECTS_SETTINGS: file,
      COLO_DESIGN_PROJECTS_DIR: join(dir, "projects"),
    });
    const reloadedProject = reloaded.get(project.slug);
    // 모르는 값은 버리고 나머지는 산다 — effort·days·autoReply 는 떨어지고
    // model 만 남는다.
    assert.deepEqual(reloadedProject?.defaults, { model: "sonnet" });
    assert.equal(reloadedProject?.lifecycle, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
