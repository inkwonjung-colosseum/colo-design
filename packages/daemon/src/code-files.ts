/**
 * 클론의 코드 파일 목록 (PLAN-HARNESS §3.B F2): 사냥(pin-files)과 화면
 * 색인(route-index)이 함께 쓰는 반 — 건너뛰는 폴더 · 확장자 · 상한이 한 곳에서
 * 정해진다. 이 파일을 따로 둔 이유는 순환 임포트(pin-files ↔ route-index)를
 * 끊는 것이다: 나눠 두면 모듈 평가 순서가 바뀌었을 때 깨지는 발판이 된다.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** 검사하지 않는 폴더 — 클론의 작업실이 아니라 거실이다. */
const SKIP_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  dist: true,
  build: true,
  out: true,
  coverage: true,
  ".next": true,
  ".turbo": true,
  ".cache": true,
  ".vercel": true,
};
/** 코드로 치는 확장자 — 화면의 말이 사는 곳이다. */
const CODE_EXTENSIONS: Record<string, true> = {
  ".ts": true,
  ".tsx": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".cjs": true,
  ".vue": true,
  ".svelte": true,
  ".astro": true,
  ".html": true,
  ".htm": true,
};
/** 훑는 파일 수 상한 — 거대한 모노레포도 답은 앞쪽 얕은 곳에 있다. */
const MAX_FILES = 4_000;

/** 클론의 코드 파일 목록 — 넓이 우선, 상한에 닿으면 거기까지. */
export async function collectCodeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  for (const dir of queue) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) continue;
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return files;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS[entry.name]) queue.push(join(dir, entry.name));
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      if (dot <= 0) continue;
      if (CODE_EXTENSIONS[entry.name.slice(dot).toLowerCase()]) files.push(join(dir, entry.name));
    }
  }
  return files;
}

/**
 * 확장자가 코드 파일인가 — collectCodeFiles 와 같은 판정을 경로 하나에 쓴다.
 * routesForFiles(F1)가 관찰 지도의 재료를 거르는 자리다: `.md` · `.json` ·
 * 락파일 · 생성 문서는 되짚기의 재료가 아니다.
 */
export function isCodeFile(rel: string): boolean {
  const base = rel.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && CODE_EXTENSIONS[base.slice(dot).toLowerCase()] === true;
}
