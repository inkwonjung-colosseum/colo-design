import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiffFile } from "@colo-design/protocol";
import { saveablePaths } from "../src/saveable-paths.ts";

/** 경로만 다른 added 행 — 미추적 파일의 모양. */
const added = (path: string): DiffFile => ({ path, status: "added", hunks: [] });
/** 경로만 다른 modified 행 — 추적 파일의 모양. */
const modified = (path: string): DiffFile => ({ path, status: "modified", hunks: [] });

test("무시 규칙 없는 레포 — node_modules 항목은 언제나 빠진다", () => {
  // pnpm 이 남긴 모양 그대로 — .gitignore 없이도 보관이 담으면 안 된다.
  const files = [
    added("node_modules/.pnpm/left-pad@0.0.1/index.js"),
    added("node_modules/.modules.yaml"),
    added("packages/app/node_modules/tiny/index.js"),
    added("src/Screen.tsx"),
  ];
  assert.deepEqual(
    saveablePaths(files, new Set()).map((file) => file.path),
    ["src/Screen.tsx"],
  );
});

test("추적 중인 락파일의 변경은 담는다 — AI 가 의존성을 더한 정당한 편집", () => {
  const files = [
    modified("pnpm-lock.yaml"),
    modified("package.json"),
    modified("packages/lib/package-lock.json"),
  ];
  const tracked = new Set(["pnpm-lock.yaml", "package.json", "packages/lib/package-lock.json"]);
  assert.deepEqual(
    saveablePaths(files, tracked).map((file) => file.path),
    ["pnpm-lock.yaml", "package.json", "packages/lib/package-lock.json"],
  );
});

test("레포가 추적하지 않는 락파일은 빠진다 — 도구의 부산물이다", () => {
  const files = [
    added("pnpm-lock.yaml"),
    added("bun.lockb"),
    added("yarn.lock"),
    added("package-lock.json"),
    added("bun.lock"),
  ];
  assert.deepEqual(
    saveablePaths(files, new Set()).map((file) => file.path),
    [],
  );
});

test("섞인 변경 — 진짜 편집은 남고 부산물만 빠진다", () => {
  const files = [
    added("pnpm-lock.yaml"),
    added("node_modules/.pnpm/lock.yaml"),
    modified("src/MemberList.tsx"),
    added("src/MemberList.mock.ts"),
    modified("packages/lib/yarn.lock"), // 이 레포는 lib 의 락파일을 추적한다
  ];
  const tracked = new Set(["src/MemberList.tsx", "packages/lib/yarn.lock"]);
  assert.deepEqual(
    saveablePaths(files, tracked).map((file) => file.path),
    ["src/MemberList.tsx", "src/MemberList.mock.ts", "packages/lib/yarn.lock"],
  );
});
