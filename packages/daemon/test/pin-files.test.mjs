/**
 * 핀 → 파일 후보 (pin-files.ts) 단위 검사. 임시 클론 훅터로 돈다.
 *
 * 계약: 힌트의 정체(testid · 컴포넌트 이름 · 요소 글자)로 클론에서 후보를
 * 매기고, 정확한 것을 앞세워 세 개까이 돌려준다. 이미 정확한 `파일:`(소스
 * 표식)이 있으면 검색하지 않고, 표식 턴에 후보 줄을 얹는 일은 멱등이다 —
 * 대기줄 복원이 같은 턴을 다시 보낼 수 있으므로.
 *
 * Run: node --test packages/daemon/test/pin-files.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markTurn } from "../../protocol/dist/turn-marker.js";
import { enrichCommentsTurn, huntPinFiles } from "../dist/pin-files.js";

/** 훅터 클론 — 검사가 그리는 최소한의 모양. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pin-files-"));
  const write = (rel, body) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write(
    "src/screens/member/MemberRow.tsx",
    [
      'import { Badge } from "@cds/react";',
      "",
      "export function MemberRow({ member }) {",
      '  return <div data-testid="member-row">…</div>;',
      "}",
      "",
    ].join("\n"),
  );
  write(
    "src/screens/member/MemberList.tsx",
    [
      'import { MemberRow } from "./MemberRow";',
      "",
      "export const MemberList = () => (",
      "  <section><header>회원 목록</header>",
      "    <MemberRow member={{}} />",
      "  </section>",
      ");",
      "",
    ].join("\n"),
  );
  // 노이즈 — 훑지 않는다: node_modules, dist, 큰 파일.
  write("node_modules/pkg/index.js", 'export const MemberList = 1; data-testid="member-row"');
  write("dist/App.js", "function MemberList() {}");
  write("src/legacy.ts", "function MemberList() {}\n".repeat(1));
  write("README.md", "# MemberList\n회원 목록");
  return root;
}

test("testid 가 컴포넌트 정의·글자보다 앞선다", async () => {
  const root = fixture();
  try {
    const found = await huntPinFiles(root, [{ id: "p1", testId: "member-row" }]);
    assert.equal(found.get("p1")?.[0]?.file, "src/screens/member/MemberRow.tsx");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("컴포넌트 정의 자리를 찾고, 같은 점수면 짧은 경로가 앞선다", async () => {
  const root = fixture();
  try {
    const found = await huntPinFiles(root, [
      { id: "p1", owners: ["MemberList", "App"] },
      { id: "p2", text: "회원 목록" },
    ]);
    // MemberList 정의는 src/screens… 와 src/legacy.ts 에 있다 — 경로 짧은 쪽이
    // 첫 후보지만 정의 파일(선언 없는 dist/node_modules)은 오지 않는다.
    const hit = (found.get("p1") ?? []).map((candidate) => candidate.file);
    assert.ok(hit.includes("src/legacy.ts"), `정의 후보에 legacy 가 있어야 한다: ${hit}`);
    assert.ok(!hit.some((file) => file.startsWith("dist/") || file.startsWith("node_modules/")));
    // JSX 글자는 그 글자를 그린 파일로 간다.
    assert.equal(found.get("p2")?.[0]?.file, "src/screens/member/MemberList.tsx");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 2026-09-21 레포 마커 철거 — 「소스 표식(file)이 있으면 검색하지 않는다」
// 검체는 폐지된 계약(data-colo-src 의 file 힌트)을 검증하던 것이라 지웠다.
// 이제 모든 힌트가 사냥된다.

test("정체가 없는 힌트는 조용히 비워 둔다", async () => {
  const root = fixture();
  try {
    const found = await huntPinFiles(root, [{ id: "p1" }, { id: "p2", text: "x" }]);
    assert.equal(found.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 마커 턴 두 블록 — id 로 블록과 짝짓는다. */
function twoPinTurn() {
  return markTurn(
    {
      kind: "comments",
      screen: "회원 목록",
      items: [
        { id: "pin-1", label: "회원 목록", comment: "" },
        { id: "pin-2", label: "member-row", comment: "" },
      ],
    },
    [
      "미리보기에서 가리킨 요소 2개입니다. 아래 위치를 기준으로 고친 뒤 화면을 다시 보여 주세요.",
      "",
      '1. 회원 목록 — "회원 목록"',
      "   위치: section > header (rect 0,0 300×40)",
      "",
      '2. member-row — "member-row"',
      "   위치: div (rect 0,40 300×60)",
      "",
    ].join("\n"),
  );
}

test("후보 줄은 id 가 가리킨 블록 머리 바로 다음에 얹힌다", async () => {
  const root = fixture();
  try {
    const enriched = await enrichCommentsTurn(
      twoPinTurn(),
      [{ id: "pin-2", testId: "member-row" }],
      root,
    );
    const lines = enriched.split("\n");
    const head = lines.findIndex((line) => line.startsWith("2. member-row"));
    assert.ok(head >= 0, "블록 머리가 있다");
    assert.equal(lines[head + 1], `   파일 후보: src/screens/member/MemberRow.tsx`);
    // 첫 블록은 건드리지 않는다.
    const first = lines.findIndex((line) => line.startsWith("1. 회원 목록"));
    assert.ok(!lines[first + 1].startsWith("   파일 후보:"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("이미 후보가 붙은 턴을 다시 보내면 두 번 붙지 않는다 (멱등)", async () => {
  const root = fixture();
  try {
    const hints = [{ id: "pin-2", testId: "member-row" }];
    const once = await enrichCommentsTurn(twoPinTurn(), hints, root);
    const twice = await enrichCommentsTurn(once, hints, root);
    assert.equal(twice, once);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("이미 `파일:` 줄이 있는 블록(옛 대기줄 복원)은 뛰어넘는다", async () => {
  const root = fixture();
  try {
    const stamped = twoPinTurn().replace(
      "   위치: section > header (rect 0,0 300×40)",
      "   파일: src/screens/member/MemberList.tsx:4\n   위치: section > header (rect 0,0 300×40)",
    );
    const enriched = await enrichCommentsTurn(
      stamped,
      [{ id: "pin-1", testId: "member-row" }],
      root,
    );
    const lines = enriched.split("\n");
    const first = lines.findIndex((line) => line.startsWith("1. 회원 목록"));
    const block = lines.slice(first, first + 4).join("\n");
    assert.ok(!block.includes("파일 후보"), "이미 정확한 파일이 있으면 후보를 붙이지 않는다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("표식 없는 턴과 마커를 못 읽는 턴은 그대로 돌아온다", async () => {
  const root = fixture();
  try {
    const plain = "그냥 사용자의 말";
    assert.equal(
      await enrichCommentsTurn(plain, [{ id: "p1", testId: "member-row" }], root),
      plain,
    );
    const broken = "<!-- colo-design:comments {으악 -->\n1. x";
    assert.equal(
      await enrichCommentsTurn(broken, [{ id: "p1", testId: "member-row" }], root),
      broken,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("정확한 적중에는 후보 아래에 파일 발췌가 따라온다", async () => {
  const root = fixture();
  try {
    const hints = [{ id: "pin-2", testId: "member-row" }];
    const once = await enrichCommentsTurn(twoPinTurn(), hints, root);
    const lines = once.split("\n");
    const head = lines.findIndex((line) => line.startsWith("2. member-row"));
    assert.ok(head >= 0, "블록 머리가 있다");
    assert.equal(lines[head + 1], "   파일 후보: src/screens/member/MemberRow.tsx");
    assert.ok(
      lines[head + 2]?.startsWith("   파일 발췌 src/screens/member/MemberRow.tsx "),
      "발췌 머리가 후보 바로 아래 온다",
    );
    assert.ok(
      once.includes('   return <div data-testid="member-row">…</div>;'),
      "적중 줄 주변의 코드가 발췌에 있다",
    );
    // 멱등 — 다시 보내도 발췌가 두 번 붙지 않는다.
    assert.equal(await enrichCommentsTurn(once, hints, root), once);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("낮은 점수(글자) 적중은 후보만 — 발췌는 얹지 않는다", async () => {
  const root = fixture();
  try {
    const enriched = await enrichCommentsTurn(
      twoPinTurn(),
      [{ id: "pin-1", text: "회원 목록" }],
      root,
    );
    assert.ok(enriched.includes("   파일 후보: "), "후보는 온다");
    assert.ok(!enriched.includes("파일 발췌"), "점수 1 의 적중은 발췌까지 가지 않는다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("묶어 둔 내용은 편집되면 다시 읽는다 — 두 번째 사냥이 새 내용을 본다", async () => {
  const root = fixture();
  try {
    const before = await huntPinFiles(root, [{ id: "p1", testId: "member-row" }]);
    assert.equal(before.get("p1")?.[0]?.file, "src/screens/member/MemberRow.tsx");
    // 같은 파일을 고친다 — mtime·크기가 움직인다.
    writeFileSync(
      join(root, "src/screens/member/MemberRow.tsx"),
      [
        'import { Badge } from "@cds/react";',
        "",
        "export function MemberRow({ member }) {",
        '  return <div data-testid="member-row-2">…</div>;',
        "}",
        "",
      ].join("\n"),
    );
    const after = await huntPinFiles(root, [{ id: "p1", testId: "member-row-2" }]);
    assert.equal(
      after.get("p1")?.[0]?.file,
      "src/screens/member/MemberRow.tsx",
      "묵은 내용을 내놓으면 못 찾는다 — 다시 읽었어야 한다",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
