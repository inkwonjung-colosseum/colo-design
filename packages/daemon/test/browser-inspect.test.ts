// PLAN-MCP §3.E-1 시험 — browser_inspect 의 답 조립(renderIdentity)과 정체
// 보강(enrichIdentity). `../dist` 임포트인 이유: node --test 는 src 의 `.js`
// 지정자를 못 읽는다. 클론 fixture 는 임시 폴더(다른 시험들의 관례) — enrich 는
// 뿌리마다 파일을 묶어 두므로 시험마다 새 뿌리를 쓴다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ColoDesignCommentTarget } from "@colo-design/protocol";
import {
  IDENTITY_NAME_LIMIT,
  IDENTITY_PATH_LIMIT,
  renderIdentity,
} from "../dist/browser-snapshot.js";
import { enrichIdentity, type IdentityFiles } from "../dist/pin-files.js";

/** 임시 클론(파일 → 내용)과 프로젝트 폴더 — 관찰 지도는 projectRoot 에 산다. */
function makeClone(files: Record<string, string>): { root: string; projectRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "colo-inspect-clone-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "colo-inspect-project-"));
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return { root, projectRoot };
}

/** 빈 files — 요소만 있는 답의 짝. */
const EMPTY: IdentityFiles = { candidates: [], observed: false };

test("renderIdentity — 온전한 정체는 예시의 줄 순서를 그대로 잇는다", () => {
  const element: ColoDesignCommentTarget = {
    component: "button",
    text: "검색",
    path: "body > main > form > button",
    rect: { x: 1, y: 2, width: 80, height: 32 },
    a11y: { role: "button", name: "검색" },
    attrs: { testId: "member-search" },
    owners: ["MemberSearch", "SearchBar"],
    styles: { color: "#0a0a0a", "background-color": "#f3f4f6", "font-size": "14px" },
  };
  const text = renderIdentity(element, {
    candidates: ["src/screens/member/MemberSearch.tsx", "src/components/SearchBar.tsx"],
    observed: false,
    excerpt: {
      file: "src/screens/member/MemberSearch.tsx",
      from: 12,
      to: 14,
      code: "export function MemberSearch() {\n  return <SearchBar />;\n}",
    },
  });
  assert.equal(
    text,
    [
      '요소: button "검색"  (컴포넌트: MemberSearch › SearchBar)',
      "testid: member-search · 경로: body > main > form > button",
      "글자: 검색",
      "파일 후보: src/screens/member/MemberSearch.tsx · src/components/SearchBar.tsx",
      "파일 발췌 src/screens/member/MemberSearch.tsx 12-14줄:",
      "  export function MemberSearch() {",
      "    return <SearchBar />;",
      "  }",
      "스타일: color #0a0a0a · background-color #f3f4f6 · font-size 14px",
    ].join("\n"),
  );
});

test("renderIdentity — 없는 칸은 줄째 빠지고 관찰 후보는 표식을 단다", () => {
  // 영역 핀처럼 경로조차 없는 정체 — 요소 줄 하나만 남는다.
  const bare: ColoDesignCommentTarget = {
    component: "div",
    text: "",
    path: "",
    rect: { x: 0, y: 0, width: 10, height: 10 },
  };
  assert.equal(renderIdentity(bare, EMPTY), "요소: div");
  const withPath: ColoDesignCommentTarget = {
    component: "div",
    text: "",
    path: "body > div",
    rect: { x: 0, y: 0, width: 10, height: 10 },
  };
  assert.equal(
    renderIdentity(withPath, { candidates: ["src/a.tsx"], observed: true }),
    ["요소: div", "경로: body > div", "파일 후보: src/a.tsx (관찰)"].join("\n"),
  );
});

test("renderIdentity — 긴 값은 자른다(이름 · 경로 · 스타일 값)", () => {
  const longName = "가".repeat(IDENTITY_NAME_LIMIT + 30);
  const longPath = `${"div > ".repeat(60)}span`;
  const element: ColoDesignCommentTarget = {
    component: "span",
    text: longName,
    path: longPath,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    attrs: { testId: longName },
    styles: { "font-family": `system-ui, -apple-system, ${"sans-serif, ".repeat(30)}monospace` },
  };
  const lines = renderIdentity(element, EMPTY).split("\n");
  const ellipsis = (value: string, max: number) => `${value.slice(0, max)}…`;
  const facts = lines[1] ?? "";
  assert.equal(lines[0], `요소: span ${JSON.stringify(ellipsis(longName, IDENTITY_NAME_LIMIT))}`);
  assert.ok(facts.startsWith(`testid: ${ellipsis(longName, IDENTITY_NAME_LIMIT)} · 경로: `));
  const clippedPath = ellipsis(longPath, IDENTITY_PATH_LIMIT);
  const pathTail = clippedPath.split(" > ").at(-1) ?? clippedPath;
  assert.ok(facts.endsWith(pathTail));
  assert.ok((lines[2] ?? "").startsWith("글자: "));
  assert.ok((lines[3] ?? "").length < 200, "스타일 값도 잘린다");
});

test("enrichIdentity — testid 적중은 그 파일을 후보로 올린다", async () => {
  const { root, projectRoot } = makeClone({
    "src/screens/member/MemberSearch.tsx": '<button data-testid="member-search">검색</button>\n',
    "src/screens/other/Other.tsx": "export function Other() {\n  return null;\n}\n",
  });
  try {
    const files = await enrichIdentity(
      root,
      { id: "e3", testId: "member-search" },
      { projectRoot },
    );
    assert.deepEqual(files.candidates, ["src/screens/member/MemberSearch.tsx"]);
    assert.equal(files.observed, false);
    // testid 는 점수 4 — 정확한 적중이므로 발췌도 온다.
    assert.equal(files.excerpt?.file, "src/screens/member/MemberSearch.tsx");
    assert.ok(files.excerpt?.code.includes("member-search"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("enrichIdentity — owners 정의 적중도 후보를 내고 발췌를 얹는다", async () => {
  const { root, projectRoot } = makeClone({
    "src/components/SearchBar.tsx": "function SearchBar() {\n  return <input />;\n}\n",
  });
  try {
    const files = await enrichIdentity(root, { id: "e2", owners: ["SearchBar"] }, { projectRoot });
    assert.deepEqual(files.candidates, ["src/components/SearchBar.tsx"]);
    assert.ok(files.excerpt?.code.includes("function SearchBar() {"));
    assert.ok((files.excerpt?.from ?? 0) >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("enrichIdentity — 정체가 빈손이면 관찰 지도가 마지막 길이다", async () => {
  const { root, projectRoot } = makeClone({
    "src/screens/member/MemberList.tsx":
      "export default function MemberList() {\n  return null;\n}\n",
  });
  try {
    writeFileSync(
      join(projectRoot, "screen-map.jsonl"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        sha: "abc123",
        routes: ["member/MemberList"],
        files: ["src/screens/member/MemberList.tsx"],
      })}\n`,
    );
    const files = await enrichIdentity(
      root,
      { id: "e1", screen: "member/MemberList" },
      { projectRoot },
    );
    assert.deepEqual(files.candidates, ["src/screens/member/MemberList.tsx"]);
    assert.equal(files.observed, true);
    assert.equal(files.excerpt, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("enrichIdentity — 정체 · 관찰이 둘 다 빈손이면 조용히 빈 재료다", async () => {
  const { root, projectRoot } = makeClone({
    "src/unrelated.tsx": "export const UNRELATED = 1;\n",
  });
  try {
    const files = await enrichIdentity(root, { id: "e9", screen: "nowhere" }, { projectRoot });
    assert.deepEqual(files, { candidates: [], observed: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
