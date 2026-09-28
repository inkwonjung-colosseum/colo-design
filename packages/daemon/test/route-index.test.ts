// PLAN-HARNESS §3.B — 화면 색인(route-index). 순수 도우미(조각 · 열쇠 · 점수 ·
// 정렬)는 그대로, 파일 훑기(filesForRoute)는 임시 클론으로 본다. 핀 턴의
// (주소) 후보 줄도 여기서 한 건 본다(기존 핀 시험 파일이 없다).
// `../dist` 임포트인 이유: node --test 는 src 의 `.js` 지정자를 못 읽는다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enrichCommentsTurn } from "../dist/pin-files.js";
import {
  fileSegments,
  filesForRoute,
  rankPathMatches,
  routeSegments,
  routesForFiles,
  segmentKey,
} from "../dist/route-index.js";
import { MAX_GATE_SCREENS } from "../dist/screen-gate.js";
import type { ScreenMapRow } from "../dist/screen-map.js";

// ————— 순수 — 조각 · 열쇠 · 점수 · 정렬 —————

test("routeSegments — 경로 · 핀 id · 루트 · 전체 주소를 조각으로 폰다", () => {
  assert.deepEqual(routeSegments("/member/list"), ["member", "list"]);
  assert.deepEqual(routeSegments("member/list"), ["member", "list"]);
  assert.deepEqual(routeSegments("index"), []);
  assert.deepEqual(routeSegments("/"), []);
  assert.deepEqual(routeSegments("/a/b?x=1#frag"), ["a", "b"]);
  // 루프백 전체 주소는 경로만, 외부 주소는 빈 결과.
  assert.deepEqual(routeSegments("http://127.0.0.1:5274/member/list"), ["member", "list"]);
  assert.deepEqual(routeSegments("https://docs.example.com/member/list"), []);
  // 인코딩된 조각은 벗긴다.
  assert.deepEqual(routeSegments("/%EC%B9%B4%EB%93%9C/list"), ["카드", "list"]);
});

test("fileSegments — 확장자를 모두 벗기고 page·index 는 폴더가 이름이다", () => {
  assert.deepEqual(fileSegments("src/screens/member/MemberList.screen.tsx"), {
    dirs: ["src", "screens", "member"],
    name: "MemberList",
  });
  assert.deepEqual(fileSegments("app/member/list/page.tsx"), {
    dirs: ["app", "member"],
    name: "list",
  });
  assert.deepEqual(fileSegments("a/b.tsx"), { dirs: ["a"], name: "b" });
  // 후보가 아닌 파일들 — 테스트 · 스토리 · d.ts · __tests__ 안.
  assert.equal(fileSegments("src/a.test.tsx"), null);
  assert.equal(fileSegments("src/a.spec.ts"), null);
  assert.equal(fileSegments("src/a.stories.tsx"), null);
  assert.equal(fileSegments("src/a.d.ts"), null);
  assert.equal(fileSegments("src/__tests__/a.tsx"), null);
});

test("segmentKey — 소문자로, - · _ · 공백을 지운다", () => {
  assert.equal(segmentKey("member-list"), segmentKey("MemberList"));
  assert.equal(segmentKey("member_list"), segmentKey("member list"));
  assert.equal(segmentKey("회원 목록"), "회원목록");
});

test("rankPathMatches — 마지막 조각이 이름, 나머지는 순서 있는 부분열", () => {
  const files = [
    "src/screens/member/MemberList.screen.tsx",
    "src/screens/member/MemberList.screen.mock.ts",
    "src/screens/member/OrderList.tsx",
    "src/a/List.tsx", // `list` 만 — member 가 dirs 에 없다.
    "src/member/other/list.tsx",
  ];
  // route /member/list: 이름 `list` 인 파일 둘 중 member 가 dirs 에 있는 것만.
  assert.deepEqual(rankPathMatches(["member", "list"], files), ["src/member/other/list.tsx"]);
  // route /member/MemberList: 화면 파일과 목 파일 둘 다, 화면이 먼저.
  assert.deepEqual(rankPathMatches(["member", "MemberList"], files), [
    "src/screens/member/MemberList.screen.tsx",
    "src/screens/member/MemberList.screen.mock.ts",
  ]);
});

// ————— 임시 클론 — filesForRoute —————

function makeClone(): string {
  return mkdtempSync(join(tmpdir(), "colo-route-index-"));
}

test("filesForRoute — CDS 모양: 화면 파일과 목 파일, 화면이 먼저", async () => {
  const root = makeClone();
  try {
    mkdirSync(join(root, "src/screens/member"), { recursive: true });
    writeFileSync(join(root, "src/screens/member/MemberList.screen.tsx"), "export {};\n");
    writeFileSync(join(root, "src/screens/member/MemberList.screen.mock.ts"), "export {};\n");
    writeFileSync(join(root, "src/screens/member/MemberList.screen.test.ts"), "export {};\n");
    const found = await filesForRoute(root, "/member/MemberList");
    assert.deepEqual(found, {
      files: [
        "src/screens/member/MemberList.screen.tsx",
        "src/screens/member/MemberList.screen.mock.ts",
      ],
      source: "path",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesForRoute — Next app 의 고정 경로 page 파일", async () => {
  const root = makeClone();
  try {
    mkdirSync(join(root, "app/member/list"), { recursive: true });
    writeFileSync(join(root, "app/member/list/page.tsx"), "export {};\n");
    const found = await filesForRoute(root, "/member/list");
    assert.deepEqual(found, { files: ["app/member/list/page.tsx"], source: "path" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesForRoute — 고정 조각이 없으면 동적 경로가 보조로 선다", async () => {
  const root = makeClone();
  try {
    mkdirSync(join(root, "app/(admin)/member/[id]"), { recursive: true });
    writeFileSync(join(root, "app/(admin)/member/[id]/page.tsx"), "export {};\n");
    const found = await filesForRoute(root, "/member/7");
    assert.deepEqual(found, {
      files: ["app/(admin)/member/[id]/page.tsx"],
      source: "dynamic",
    });
    // 루트는 동적 경로로 내려가지 않는다.
    assert.equal(await filesForRoute(root, "/"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesForRoute — 루트는 정해진 네 자리의 문만 본다", async () => {
  const root = makeClone();
  try {
    mkdirSync(join(root, "pages"), { recursive: true });
    writeFileSync(join(root, "pages/index.tsx"), "export {};\n");
    writeFileSync(join(root, "pages/about.tsx"), "export {};\n");
    assert.deepEqual(await filesForRoute(root, "/"), {
      files: ["pages/index.tsx"],
      source: "path",
    });
    assert.deepEqual(await filesForRoute(root, "index"), {
      files: ["pages/index.tsx"],
      source: "path",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesForRoute — 시험 · 스토리 파일이 있어도 후보가 아니고, 빈손은 null", async () => {
  const root = makeClone();
  try {
    mkdirSync(join(root, "src/screens/member"), { recursive: true });
    writeFileSync(join(root, "src/screens/member/MemberList.test.tsx"), "export {};\n");
    writeFileSync(join(root, "src/screens/member/MemberList.stories.tsx"), "export {};\n");
    mkdirSync(join(root, "src/screens/member/__tests__"), { recursive: true });
    writeFileSync(join(root, "src/screens/member/__tests__/MemberList.tsx"), "export {};\n");
    assert.equal(await filesForRoute(root, "/member/MemberList"), null);
    // 코드 파일이 하나도 없으면 빈손.
    assert.equal(await filesForRoute(root, "/no/such/screen"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ————— routesForFiles —————

const row = (files: string[], routes: string[], screens?: ScreenMapRow["screens"]) =>
  ({
    at: "2026-09-27T00:00:00.000Z",
    sha: "a".repeat(40),
    routes,
    files,
    ...(screens ? { screens } : {}),
  }) satisfies ScreenMapRow;

test("routesForFiles — 관찰 행의 screens 를 최근 행부터 낸다", () => {
  const rows = [
    row(["src/a.tsx"], ["member/list"], [{ route: "/member/list", title: "회원" }]),
    row(["src/b.tsx"], [], [{ route: "/join", title: "가입" }]),
  ];
  // 최근 행이 뒤에 있으므로 뒤 행의 화면이 먼저다.
  assert.deepEqual(routesForFiles(["src/a.tsx", "src/b.tsx"], rows), ["/join", "/member/list"]);
});

test("routesForFiles — screens 가 없으면 routes 를 정규화하고 외부 주소는 버린다", () => {
  const rows = [
    row(
      ["src/a.tsx"],
      ["member/list", "http://127.0.0.1:5274/join", "https://docs.example.com/member/list"],
    ),
  ];
  assert.deepEqual(routesForFiles(["src/a.tsx"], rows), ["/member/list", "/join"]);
});

test("routesForFiles — 고정 page 파일은 주소가 되고 동적 page · 이름 지어내기는 안 된다", () => {
  assert.deepEqual(routesForFiles(["app/member/list/page.tsx"], []), ["/member/list"]);
  assert.deepEqual(routesForFiles(["app/(admin)/member/[id]/page.tsx"], []), []);
  // src/screens/Foo.screen.tsx 같은 이름 지어내기는 없다 — 게이트가 없는 주소를
  // 열면 404 가 "문제"로 잡히기 때문이다(H-5).
  assert.deepEqual(routesForFiles(["src/screens/foo/Foo.screen.tsx"], []), []);
});

test("routesForFiles — 상한은 게이트의 화면 수 상한과 같다", () => {
  const rows: ScreenMapRow[] = [];
  for (let i = 0; i < MAX_GATE_SCREENS + 2; i += 1) {
    rows.push(row([`src/${i}.tsx`], [], [{ route: `/r${i}`, title: "" }]));
  }
  const routes = routesForFiles(
    rows.map((r) => r.files[0] ?? ""),
    rows,
  );
  assert.equal(routes.length, MAX_GATE_SCREENS);
});

test("routesForFiles — 모든 화면이 한 파일에 사는 레포(fixture 의 server.js)는 되짚지 않는다", () => {
  // 행 다섯이 모두 server.js 를 담고 화면이 다섯 — 이 파일은 공용 파일이다.
  const rows = [
    row(["server.js"], ["index"]),
    row(["server.js"], ["/list"]),
    row(["server.js"], ["/member/kim"]),
    row(["server.js"], ["/member/lee"]),
    row(["server.js"], ["/join"]),
  ];
  assert.deepEqual(routesForFiles(["server.js"], rows), []);
});

test("routesForFiles — 화면 둘에 이어진 파일은 그 둘을 낸다(2 는 통과, 3 은 거름)", () => {
  const two = [row(["a.tsx"], ["/one"]), row(["a.tsx"], ["/two"])];
  assert.deepEqual(routesForFiles(["a.tsx"], two), ["/two", "/one"]);
  const three = [...two, row(["a.tsx"], ["/three"])];
  assert.deepEqual(routesForFiles(["a.tsx"], three), []);
});

test("routesForFiles — 같은 화면의 두 표기는 하나로 센다", () => {
  const rows = [row(["a.tsx"], ["notice/X"]), row(["a.tsx"], ["/notice/X"])];
  assert.deepEqual(routesForFiles(["a.tsx"], rows), ["/notice/X"]);
});

test("routesForFiles — 코드 파일이 아니면(.md · 생성 문서) 관찰 지도가 있어도 되짚지 않는다", () => {
  const rows = [
    row(["docs/HANDOFF.md"], [], [{ route: "/notice", title: "" }]),
    row([".claude/skills/api.gen.md"], [], [{ route: "/member", title: "" }]),
  ];
  assert.deepEqual(routesForFiles(["docs/HANDOFF.md", ".claude/skills/api.gen.md"], rows), []);
});

test("routesForFiles — 코드 파일 거름과 무관하게 Next 고정 page 파일은 여전히 낸다", () => {
  const rows = [row(["docs/HANDOFF.md"], [], [{ route: "/notice", title: "" }])];
  assert.deepEqual(routesForFiles(["docs/HANDOFF.md", "app/notice/page.tsx"], rows), ["/notice"]);
});

// ————— 핀 턴의 (주소) 후보 —————

test("enrichCommentsTurn — 정체가 빈손이면 주소의 파일이 (주소) 표식으로 선다", async () => {
  const root = makeClone();
  try {
    mkdirSync(join(root, "src/screens/member"), { recursive: true });
    writeFileSync(join(root, "src/screens/member/list.tsx"), "export {};\n");
    const text = [
      '<!-- colo-design:comments {"items":[{"id":"p1"}]} -->',
      "회원 목록에서 이 버튼을 고쳐 줘.",
      '1. 버튼 — "등록하기"',
    ].join("\n");
    const enriched = await enrichCommentsTurn(
      text,
      [{ id: "p1", screen: "member/list" }],
      root,
      null,
    );
    assert.ok(enriched.text.includes("   파일 후보: src/screens/member/list.tsx (주소)"));
    assert.deepEqual(enriched.candidates, ["src/screens/member/list.tsx"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
