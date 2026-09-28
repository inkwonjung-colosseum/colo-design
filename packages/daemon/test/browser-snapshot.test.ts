// PLAN-MCP §3.C 시험 — 스냅샷 한 줄 표기 · 액션 요약 · 찾기의 순수 판정.
// `../dist` 임포트인 이유: node --test 는 src 의 `.js` 지정자를 못 읽는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIND_DEFAULT_LIMIT,
  findInSnapshot,
  isWholeSnapshot,
  renderSnapshot,
  SNAPSHOT_NAME_LIMIT,
  summarizeAction,
} from "../dist/browser-snapshot.js";
import { browserTools, callBrowserTool } from "../dist/browser-tools.js";
import type { PreviewAxNode } from "../dist/preview-driver.js";

/** 온전한 노드를 짧게 짓는 생성기 — 시험 트리의 소음을 줄인다. */
function n(node: Partial<PreviewAxNode> & { role: string }): PreviewAxNode {
  return { ref: "", name: "", states: [], children: [], ...node };
}

/** 여러 시험이 함께 쓰는 화면 — 검색창 · 버튼 · 접힌 구조 속 목록. */
const page: PreviewAxNode[] = [
  n({ ref: "e1", role: "textbox", name: "이름 검색", value: "김", states: ["focused"] }),
  n({ ref: "e2", role: "button", name: "검색", states: ["disabled"] }),
  n({
    role: "generic",
    children: [
      n({
        ref: "e3",
        role: "list",
        children: [
          n({
            ref: "e4",
            role: "listitem",
            children: [
              n({ ref: "e5", role: "link", name: "김바다" }),
              n({ role: "text", name: "부산 · 2019년 가입" }),
            ],
          }),
        ],
      }),
    ],
  }),
];

test("renderSnapshot — 접힌 구조 노드는 줄 없이 자식만 올리고 들여쓰기를 아낀다", () => {
  const { text, truncated } = renderSnapshot(page);
  assert.equal(truncated, false);
  assert.equal(
    text,
    [
      'textbox "이름 검색" e1 = "김" [focused]',
      'button "검색" e2 [disabled]',
      "list e3",
      "  listitem e4",
      '    link "김바다" e5',
      '    text "부산 · 2019년 가입"',
    ].join("\n"),
  );
});

test('renderSnapshot — 값은 = "…" 로, 상태는 […] 로, 이름은 80자에서 자른다', () => {
  const long = "가".repeat(SNAPSHOT_NAME_LIMIT + 20);
  const { text } = renderSnapshot([
    n({ ref: "e9", role: "textbox", name: long, value: "v", states: ["required", "focused"] }),
    n({ ref: "e10", role: "image", name: `따옴표"와 \\ 역슬래시` }),
  ]);
  const [first, second] = text.split("\n");
  assert.equal(first, `textbox "${"가".repeat(SNAPSHOT_NAME_LIMIT)}" e9 = "v" [required, focused]`);
  assert.equal(second, 'image "따옴표\\"와 \\\\ 역슬래시" e10');
});

test("renderSnapshot — 상한을 넘으면 남은 줄 수와 이어 읽을 ref 를 말한다", () => {
  const many: PreviewAxNode[] = Array.from({ length: 10 }, (_, i) =>
    n({ ref: `e${i + 1}`, role: "listitem", name: `항목 ${i + 1}` }),
  );
  const { text, lines, truncated, fullLines } = renderSnapshot(many, { maxLines: 3 });
  assert.equal(truncated, true);
  assert.equal(lines.length, 4, "상한 3줄 + 안내 1줄");
  assert.equal(fullLines.length, 10, "fullLines 는 잘리지 않는다");
  assert.equal(lines[3], '… 7개 더 — browser_snapshot { ref: "e4" } 로 그 아래를 읽으십시오');
  assert.equal(text.split("\n").length, 4);
  // ref 가 하나도 없는 트리에서는 부분 읽기를 좁힐 수 없다 — 전체 읽기로 안내한다.
  const bare = renderSnapshot(
    Array.from({ length: 5 }, (_, i) => n({ role: "text", name: `글 ${i + 1}` })),
    { maxLines: 2 },
  );
  assert.equal(bare.lines[2], "… 3개 더 — browser_snapshot 으로 그 아래를 읽으십시오");
});

test("renderSnapshot — ref 를 주면 그 노드의 부분 트리만 그린다", () => {
  const { text } = renderSnapshot(page, { ref: "e4" });
  assert.equal(
    text,
    ["listitem e4", '  link "김바다" e5', '  text "부산 · 2019년 가입"'].join("\n"),
  );
});

test("summarizeAction — 집합 차로 바뀐 줄을 세고 상한 20줄을 넘으면 안내로 끝낸다", () => {
  const before = ['textbox "이름 검색" e1 = ""', 'text "회원이 없습니다"'];
  const after = ['textbox "이름 검색" e1 = "김"', "listitem e4", '  link "김바다" e5'];
  const { text } = summarizeAction(before, after, {
    url: "http://127.0.0.1:5274/member/MemberList",
    title: "회원 목록",
    focus: 'textbox "이름 검색" e1 = "김"',
  });
  assert.equal(
    text,
    [
      "회원 목록 · http://127.0.0.1:5274/member/MemberList",
      '포커스: textbox "이름 검색" e1 = "김"',
      "바뀐 줄: +3 −2",
      '+ textbox "이름 검색" e1 = "김"',
      "+ listitem e4",
      '+   link "김바다" e5',
      '− textbox "이름 검색" e1 = ""',
      '− text "회원이 없습니다"',
    ].join("\n"),
  );
  const first = summarizeAction([], after, { url: "http://x/", title: "제목", focus: null });
  assert.equal(first.text, "제목 · http://x/\n화면 전체는 browser_snapshot 으로 읽으십시오");
  // 상한 — 차이 21줄은 20줄 + 안내로 끊긴다.
  const bigBefore = ["textbox e1"];
  const bigAfter = Array.from({ length: 21 }, (_, i) => `listitem e${i + 2}`);
  const capped = summarizeAction(bigBefore, bigAfter, { url: "http://x/", title: "t" });
  const cappedLines = capped.text.split("\n");
  assert.equal(cappedLines[1], "바뀐 줄: +21 −1");
  assert.equal(cappedLines.length, 2 + 20 + 1, "제목 · 줄 수 · 20줄 · 안내");
  assert.equal(cappedLines[cappedLines.length - 1], "… 더 바뀜 — browser_snapshot 으로 읽으십시오");
});

test("findInSnapshot — 이름(부분 · 대소문자 무시)과 역할의 일치, 접힌 노드는 내놓지 않는다", () => {
  assert.deepEqual(findInSnapshot(page, { text: "바다" }).lines, ['    link "김바다" e5']);
  assert.deepEqual(findInSnapshot(page, { role: "BUTTON" }).lines, ['button "검색" e2 [disabled]']);
  // 둘 다 주어지면 둘 다 본다 — 이름에 "검색"이 있어도 역할이 다르면 빠진다.
  assert.deepEqual(findInSnapshot(page, { text: "검색", role: "button" }).lines, [
    'button "검색" e2 [disabled]',
  ]);
  // 접힌 구조 노드(role: generic)는 스냅샷에 보이지 않으므로 찾기에도 없다.
  assert.equal(
    findInSnapshot(page, { role: "generic" }).text,
    "맞는 요소가 없습니다 — browser_snapshot 으로 화면을 읽으십시오.",
  );
  assert.equal(
    findInSnapshot(page, {}).text,
    "찾을 조건이 없습니다 — text 나 role 을 하나 이상 주십시오.",
  );
});

test("summarizeAction — 정착 실패(navigate)만 둘째 줄에 말하고, 다른 액션은 말하지 않는다", () => {
  const warning = "화면이 끝까지 로드되지 않았습니다 — browser_wait 로 기다리거나 다시 읽으십시오";
  const unsettled = summarizeAction(["textbox e1"], ["textbox e1"], {
    url: "http://x/",
    title: "제목",
    settled: false,
  });
  assert.equal(unsettled.lines[1], warning);
  const settled = summarizeAction(["textbox e1"], ["textbox e1"], {
    url: "http://x/",
    title: "제목",
    settled: true,
  });
  assert.ok(!settled.lines.includes(warning), "정착했으면 그 말이 없다");
  const click = summarizeAction(["textbox e1"], ["textbox e1"], {
    url: "http://x/",
    title: "제목",
  });
  assert.ok(!click.lines.includes(warning), "액션은 정착을 말하지 않는다");
});

test("isWholeSnapshot — 부분 트리(ref) 읽기는 세션의 차이 기준을 갈지 않는다", () => {
  assert.equal(isWholeSnapshot({}), true);
  assert.equal(isWholeSnapshot({ maxLines: 50 }), true, "maxLines 는 fullLines 가 온전하다");
  assert.equal(isWholeSnapshot({ ref: "e3" }), false);
  assert.equal(isWholeSnapshot({ ref: "" }), false, "빈 ref 도 부분 읽기 요청이다");
});

test("findInSnapshot — limit 은 기본 10, 상한 30으로 맞는다", () => {
  const many: PreviewAxNode[] = Array.from({ length: 40 }, (_, i) =>
    n({ ref: `e${i + 1}`, role: "button", name: `버튼 ${i + 1}` }),
  );
  const base = findInSnapshot(many, { role: "button" });
  assert.equal(FIND_DEFAULT_LIMIT, 10);
  assert.equal(base.lines.length, 11, "기본 10줄 + 남은 수 안내");
  assert.equal(base.lines[10], "… 30개 더 — 조건을 좁혀 다시 찾으십시오");
  const clamped = findInSnapshot(many, { role: "button", limit: 40 });
  assert.equal(clamped.lines.length, 31, "40을 요청해도 30줄 + 안내");
  assert.equal(clamped.lines[30], "… 10개 더 — 조건을 좁혀 다시 찾으십시오");
});

test("callBrowserTool — 문자열 결과는 JSON 따옴표 없이 그대로 text 로 내려간다", async () => {
  const original = globalThis.fetch;
  const rendered = 'textbox "검색" e1\nbutton "확인" e2';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, result: rendered }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const tool = browserTools(false).find((candidate) => candidate.name === "browser_snapshot");
    assert.ok(tool, "browser_snapshot 도구가 목록에 있다");
    const outcome = await callBrowserTool(
      tool,
      {},
      { daemonUrl: "http://127.0.0.1:1", secret: "s" },
    );
    assert.equal(outcome.isError, undefined);
    assert.equal(outcome.content.length, 1);
    const block = outcome.content[0];
    assert.ok(block?.type === "text", "text 블록으로 내려온다");
    if (block?.type === "text") {
      assert.equal(block.text, rendered, "따옴표 · \\n 이스케이프에 갇히지 않는다");
    }
  } finally {
    globalThis.fetch = original;
  }
});
