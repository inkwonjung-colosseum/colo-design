import assert from "node:assert/strict";
import { test } from "node:test";
import { editPathsOf } from "../src/tool-paths.ts";

test("세 프로바이더의 편집 입력에서 경로를 뽑는다", () => {
  // Claude SDK — Edit · Write · NotebookEdit
  assert.deepEqual(editPathsOf({ file_path: "src/a.tsx", old_string: "x" }), ["src/a.tsx"]);
  assert.deepEqual(editPathsOf({ notebook_path: "n.ipynb" }), ["n.ipynb"]);
  // Codex — fileChange 의 changes[].path
  assert.deepEqual(editPathsOf({ changes: [{ path: "src/b.tsx" }, { path: "src/c.ts" }] }), [
    "src/b.tsx",
    "src/c.ts",
  ]);
  // omp — edit 의 path, write 의 file, 여러 파일의 paths[]
  assert.deepEqual(editPathsOf({ path: "src/d.tsx", oldText: "a", newText: "b" }), ["src/d.tsx"]);
  assert.deepEqual(editPathsOf({ file: "src/e.tsx", content: "" }), ["src/e.tsx"]);
  assert.deepEqual(editPathsOf({ paths: ["src/f.tsx", "src/g.tsx"] }), ["src/f.tsx", "src/g.tsx"]);
});

test("모르는 모양은 빈 배열 — 없는 사실을 지어내지 않는다", () => {
  assert.deepEqual(editPathsOf(null), []);
  assert.deepEqual(editPathsOf("src/a.tsx"), []);
  assert.deepEqual(editPathsOf({ command: "pnpm check" }), []);
  assert.deepEqual(editPathsOf({ paths: [1, "", null] }), []);
});
