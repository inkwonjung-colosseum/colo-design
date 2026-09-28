// PLAN-MCP §3.E 의 E-2 — screen_files 도구. 판정(병합 · 표기 · 상한 · 빈손)은
// 순수 함수로, 관찰 지도의 읽기는 임시 screen-map.jsonl 과 임시 클론으로 본다.
// `../dist` 임포트인 이유: node --test 는 src 의 `.js` 지정자를 못 읽는다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BROWSER_TOOLS, SCREEN_FILES_MAX, screenFilesAnswer } from "../dist/browser-tools.js";
import { huntPinFiles } from "../dist/pin-files.js";
import { observedFilesFor } from "../dist/screen-map.js";

// ————— 순수 — screenFilesAnswer —————

test("screenFilesAnswer — 관찰만이면 한 줄에 (관찰) 표식으로", () => {
  assert.equal(
    screenFilesAnswer(["src/a.tsx", "src/a.mock.ts"], [], "회원 목록"),
    "파일 후보: src/a.tsx · src/a.mock.ts (관찰)",
  );
});

test("screenFilesAnswer — 글자만이면 한 줄에 (글자) 표식으로", () => {
  assert.equal(
    screenFilesAnswer([], ["src/routes.tsx"], "회원 목록"),
    '파일 후보: src/routes.tsx (글자 "회원 목록")',
  );
});

test("screenFilesAnswer — 둘 다면 관찰이 먼저이고 겹치는 파일은 한 번만", () => {
  assert.equal(
    screenFilesAnswer(["src/a.tsx", "src/b.ts"], ["src/b.ts", "src/routes.tsx"], "회원 목록"),
    '파일 후보: src/a.tsx · src/b.ts (관찰)\n파일 후보: src/routes.tsx (글자 "회원 목록")',
  );
});

test("screenFilesAnswer — 합이 상한을 넘으면 관찰이 먼저이고 글자가 잘린다", () => {
  const observed = ["src/1.ts", "src/2.ts", "src/3.ts", "src/4.ts"];
  const hunted = ["src/5.ts", "src/6.ts", "src/7.ts"];
  const answer = screenFilesAnswer(observed, hunted, "제목");
  assert.equal(
    answer,
    '파일 후보: src/1.ts · src/2.ts · src/3.ts · src/4.ts (관찰)\n파일 후보: src/5.ts · src/6.ts (글자 "제목")',
  );
  // 도구의 답에 실린 후보는 상한을 넘지 않는다.
  assert.ok(answer.split("\n").join(" ").split("src/").length - 1 <= SCREEN_FILES_MAX);
});

test("screenFilesAnswer — 빈손은 오류가 아니다", () => {
  assert.equal(screenFilesAnswer([], [], "회원 목록"), "이 화면을 고친 기록이 아직 없습니다");
});

// ————— (주소) 줄 (PLAN-HARNESS §3.B B-2) —————

test("screenFilesAnswer — 주소의 파일이 맨 앞 줄에 (주소) 표식으로", () => {
  assert.equal(
    screenFilesAnswer(["src/obs.tsx"], ["src/word.tsx"], "제목", ["src/route.tsx"]),
    '파일 후보: src/route.tsx (주소)\n파일 후보: src/obs.tsx (관찰)\n파일 후보: src/word.tsx (글자 "제목")',
  );
});

test("screenFilesAnswer — 겹치는 파일은 앞 줄에 한 번만", () => {
  assert.equal(
    screenFilesAnswer(["src/a.tsx", "src/b.tsx"], ["src/b.tsx"], "제목", ["src/b.tsx"]),
    "파일 후보: src/b.tsx (주소)\n파일 후보: src/a.tsx (관찰)",
  );
});

test("screenFilesAnswer — 합이 상한을 넘으면 (주소) 줄이 먼저 실린다", () => {
  const routed = ["src/r1.tsx", "src/r2.tsx", "src/r3.tsx"];
  const observed = ["src/o1.tsx", "src/o2.tsx", "src/o3.tsx"];
  const hunted = ["src/h1.tsx", "src/h2.tsx"];
  assert.equal(
    screenFilesAnswer(observed, hunted, "제목", routed),
    "파일 후보: src/r1.tsx · src/r2.tsx · src/r3.tsx (주소)\n" +
      "파일 후보: src/o1.tsx · src/o2.tsx · src/o3.tsx (관찰)",
  );
});

// ————— 도구 계약 —————

test("screen_files 도구 — 두 새 도구는 목록의 맨 끝이고 route 는 필수다", () => {
  const tail = BROWSER_TOOLS.slice(-2).map((tool) => tool.name);
  assert.deepEqual(tail, ["screen_files", "notify_developer"]);
  const files = BROWSER_TOOLS.find((tool) => tool.name === "screen_files");
  assert.equal(files?.op, "screenFiles");
  assert.deepEqual(files?.required, ["route"]);
});

// ————— 관찰 지도 — 임시 screen-map.jsonl 과 클론 —————

/** 지도 행과 클론을 한 곳에 세운 임시 장면 — 시험 끝에 지운다. */
function makeScene(): { root: string; projectRoot: string; repoRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "nova-screen-files-"));
  const projectRoot = join(root, "project");
  const repoRoot = join(root, "repo");
  mkdirSync(projectRoot);
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  return { root, projectRoot, repoRoot };
}

const fileOf = (repoRoot: string, rel: string): string => join(repoRoot, rel);

test("observedFilesFor — 두 route 모양(핀 id · 경로)이 같은 화면의 행을 모두 본다", async () => {
  const { root, projectRoot, repoRoot } = makeScene();
  try {
    writeFileSync(fileOf(repoRoot, "src/member.tsx"), "export const MemberList = () => null;\n");
    writeFileSync(fileOf(repoRoot, "src/member.mock.ts"), "export const rows = [];\n");
    // 최근 행(전체 주소 — navigate·screen_check 가 남기는 모양)과 오래된 행(핀의 화면 id).
    writeFileSync(
      join(projectRoot, "screen-map.jsonl"),
      `${JSON.stringify({
        at: "2026-09-27T00:00:00.000Z",
        sha: "a".repeat(40),
        routes: ["http://127.0.0.1:5274/member/list"],
        files: ["src/member.tsx"],
        screens: [{ route: "/member/list", title: "회원 목록" }],
      })}\n${JSON.stringify({
        at: "2026-09-26T00:00:00.000Z",
        sha: "b".repeat(40),
        routes: ["member/list"],
        files: ["src/member.mock.ts"],
      })}\n`,
    );
    // 최근 커밋부터 — 핀 id 로도, 경로로도 두 행이 다 읽힌다.
    const byId = await observedFilesFor(projectRoot, repoRoot, "member/list");
    const byPath = await observedFilesFor(projectRoot, repoRoot, "/member/list");
    assert.deepEqual(byId, ["src/member.mock.ts", "src/member.tsx"]);
    assert.deepEqual(byPath, ["src/member.mock.ts", "src/member.tsx"]);
    // 클론에 없는 파일은 후보가 아니다 — 두 행 다 존재하는 파일만 실렸다.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observedFilesFor — 루트는 index 와 / 가 같고, 없는 지도는 빈손이다", async () => {
  const { root, projectRoot, repoRoot } = makeScene();
  try {
    writeFileSync(fileOf(repoRoot, "src/App.tsx"), "export default () => null;\n");
    writeFileSync(
      join(projectRoot, "screen-map.jsonl"),
      `${JSON.stringify({
        at: "2026-09-27T00:00:00.000Z",
        sha: "a".repeat(40),
        routes: ["index"],
        files: ["src/App.tsx"],
      })}\n`,
    );
    assert.deepEqual(await observedFilesFor(projectRoot, repoRoot, "index"), ["src/App.tsx"]);
    assert.deepEqual(await observedFilesFor(projectRoot, repoRoot, "/"), ["src/App.tsx"]);
    // 지도 파일이 없어도 빈 목록 — 오류로 터지지 않는다.
    assert.deepEqual(await observedFilesFor(join(projectRoot, "none"), repoRoot, "/"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observedFilesFor — 외부 주소 행은 같은 경로의 미리보기 화면과 짝지어지지 않는다", async () => {
  const { root, projectRoot, repoRoot } = makeScene();
  try {
    writeFileSync(fileOf(repoRoot, "src/member.tsx"), "export const MemberList = () => null;\n");
    // notePinned 는 navigate 주소를 origin 과 무관하게 적는다 — 외부 이동의 행도 남는다.
    writeFileSync(
      join(projectRoot, "screen-map.jsonl"),
      `${JSON.stringify({
        at: "2026-09-27T00:00:00.000Z",
        sha: "a".repeat(40),
        routes: ["https://docs.example.com/member/list"],
        files: ["src/member.tsx"],
      })}\n`,
    );
    // 외부 주소가 편 경로가 미리보기의 같은 경로와 만나면 그 턴의 파일이
    // 엉뚱한 화면의 후보가 된다 — 어떤 모양으로 물어도 빈손이어야 한다.
    assert.deepEqual(await observedFilesFor(projectRoot, repoRoot, "member/list"), []);
    assert.deepEqual(await observedFilesFor(projectRoot, repoRoot, "/member/list"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observedFilesFor — 루프백 전체 주소 행은 같은 경로의 화면과 짝지어진다", async () => {
  const { root, projectRoot, repoRoot } = makeScene();
  try {
    writeFileSync(fileOf(repoRoot, "src/member.tsx"), "export const MemberList = () => null;\n");
    const row = (routes: string[]): string =>
      `${JSON.stringify({
        at: "2026-09-27T00:00:00.000Z",
        sha: "a".repeat(40),
        routes,
        files: ["src/member.tsx"],
      })}\n`;
    writeFileSync(
      join(projectRoot, "screen-map.jsonl"),
      `${row(["http://127.0.0.1:5274/member/list"])}${row(["http://localhost:5274/list"])}`,
    );
    assert.deepEqual(await observedFilesFor(projectRoot, repoRoot, "/member/list"), [
      "src/member.tsx",
    ]);
    assert.deepEqual(await observedFilesFor(projectRoot, repoRoot, "/list"), ["src/member.tsx"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ————— 글자 사냥 — 임시 클론으로 huntPinFiles —————

test("screen_files 의 재료 — 제목 글자가 코드에 적힌 자리를 huntPinFiles 가 찾는다", async () => {
  const root = mkdtempSync(join(tmpdir(), "nova-screen-hunt-"));
  try {
    mkdirSync(join(root, "src/screens/member"), { recursive: true });
    writeFileSync(
      join(root, "src/screens/member/MemberList.tsx"),
      "export const TITLE = '회원 목록';\n",
    );
    const found = await huntPinFiles(root, [{ id: "screen-files", text: "회원 목록" }]);
    const hits = found.get("screen-files") ?? [];
    assert.ok(hits.some((hit) => hit.file === "src/screens/member/MemberList.tsx"));
    // 판정에 흘러드는 모양은 파일 경로뿐이다.
    const answer = screenFilesAnswer(
      [],
      hits.map((hit) => hit.file),
      "회원 목록",
    );
    assert.ok(answer.includes("src/screens/member/MemberList.tsx"));
    assert.ok(answer.includes('(글자 "회원 목록")'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
