import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// 이 시험은 빌드 뒤에 돈다(루트 pnpm test = build → node --test). projects 은
// environment.js 를 데리고 있어 src 직접 로드가 안 된다(project-registry-create
// 와 같은 길).
import { ProjectRegistry } from "../dist/projects.js";

/** 데몬이 쓴 projects.json 의 모습 — 손으로 쓴 파일이 아니라 도구의 출력이다. */
function registryWithHandoff(reviewers: unknown): { registry: ProjectRegistry; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "project-registry-handoff-"));
  const file = join(dir, "projects.json");
  writeFileSync(
    file,
    JSON.stringify({
      projects: [
        {
          slug: "a",
          name: "회원 관리",
          repo: {
            url: "https://github.com/org/repo.git",
            handoff: {
              number: 7,
              url: "https://github.com/org/repo/pull/7",
              title: "회원 목록 화면",
              state: "open",
              branch: "colo-design/20260924-1",
              reviewers,
            },
          },
        },
      ],
    }),
    "utf8",
  );
  return {
    registry: ProjectRegistry.load({
      COLO_DESIGN_PROJECTS_SETTINGS: file,
      COLO_DESIGN_PROJECTS_DIR: join(dir, "projects"),
    }),
    dir,
  };
}

test("handoff 의 reviewers 가 왕복한다 — 재시작 뒤에도 리뷰어 줄이 산다", () => {
  const { registry, dir } = registryWithHandoff(["dev1", "dev2"]);
  try {
    const handoff = registry.get("a")?.repo.handoff;
    assert.equal(handoff?.number, 7);
    assert.deepEqual(handoff?.reviewers, ["dev1", "dev2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("빈 배열은 그대로 산다 — 아무도 지정하지 않았다는 뜻이 undefined 와 다르다", () => {
  const { registry, dir } = registryWithHandoff([]);
  try {
    assert.deepEqual(registry.get("a")?.repo.handoff?.reviewers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("문자열 배열이 아니면 필드만 버린다 — handoff 자체는 산다", () => {
  const { registry, dir } = registryWithHandoff(["dev1", 7]);
  try {
    const handoff = registry.get("a")?.repo.handoff;
    assert.equal(handoff?.reviewers, undefined);
    assert.equal(handoff?.number, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
