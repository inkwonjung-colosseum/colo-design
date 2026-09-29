// 접근성 재료 수집의 순수한 부분 시험(2026-09-29) — 접근성 트리에서 이름 없는 컨트롤을 고르는
// 규칙과 시한 도우미. 페이지 안에서 도는 함수(collectAuditInPage · labelOfInPage)는 진짜
// Electron 창이 아니면 레이아웃이 없어 시험할 수 없으므로 거기서 따로 확인한다.
// `../dist` 임포트인 이유는 daemon 시험들과 같다(node --test 는 src 의 `.js` 지정자를 못 읽는다).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AxNodeLike, unnamedControlsOf, withDeadline } from "../dist/a11y-probe.js";

let seq = 0;
/** 접근성 노드 하나 — 기본은 이름 없는 버튼이다. */
function node(over: Partial<AxNodeLike> & { role?: string; name?: string } = {}): AxNodeLike {
  seq += 1;
  const { role = "button", name, ...rest } = over;
  return {
    nodeId: String(seq),
    backendDOMNodeId: 100 + seq,
    role: { value: role },
    ...(name === undefined ? {} : { name: { value: name } }),
    ...rest,
  };
}

test("unnamedControlsOf — 이름이 빈 컨트롤만 고른다", () => {
  const { total, targets } = unnamedControlsOf(
    [
      node({ role: "button" }),
      node({ role: "button", name: "저장" }),
      node({ role: "link", name: "" }),
      node({ role: "textbox", name: "이름" }),
      node({ role: "checkbox", name: "  " }),
    ],
    10,
  );
  assert.equal(total, 3, "이름이 없는 버튼 · 링크 · 체크박스");
  assert.deepEqual(
    targets.map((target) => target.role),
    ["button", "link", "checkbox"],
  );
});

test("unnamedControlsOf — 무시된 노드(숨김 · 장식)는 화면 낭독기에도 보이지 않으므로 뺀다", () => {
  const { total } = unnamedControlsOf([node({ ignored: true }), node()], 10);
  assert.equal(total, 1);
});

test("unnamedControlsOf — 이름이 필요 없는 역할은 이름이 없어도 문제가 아니다", () => {
  const roles = [
    "heading",
    "generic",
    "none",
    "StaticText",
    "image",
    "paragraph",
    "RootWebArea",
    "LabelText",
  ];
  const { total } = unnamedControlsOf(
    roles.map((role) => node({ role })),
    10,
  );
  assert.equal(total, 0, "그림은 접근성 트리가 아니라 페이지 안에서 따로 본다(장식용 svg 소음)");
});

test("unnamedControlsOf — 이름이 필요한 역할 목록", () => {
  const named = [
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "textbox",
    "searchbox",
    "combobox",
    "slider",
    "spinbutton",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
  ];
  const { total } = unnamedControlsOf(
    named.map((role) => node({ role })),
    50,
  );
  assert.equal(total, named.length);
});

test("unnamedControlsOf — DOM 노드를 알 수 없는 것은 라벨을 못 붙이므로 세지 않는다", () => {
  const orphan: AxNodeLike = { nodeId: "x", role: { value: "button" } };
  assert.equal(unnamedControlsOf([orphan], 10).total, 0);
});

test("unnamedControlsOf — 표본은 상한까지만이고 셈은 전체다", () => {
  const many = Array.from({ length: 12 }, () => node({ role: "checkbox" }));
  const { total, targets } = unnamedControlsOf(many, 5);
  assert.equal(total, 12);
  assert.equal(targets.length, 5);
  assert.equal(targets[0]?.backendNodeId, many[0]?.backendDOMNodeId);
});

test("unnamedControlsOf — 이름 칸의 모양이 낯설어도 죽지 않는다", () => {
  const odd: AxNodeLike[] = [
    { nodeId: "1", backendDOMNodeId: 1, role: { value: "button" }, name: { value: 5 } },
    { nodeId: "2", backendDOMNodeId: 2, role: { value: 7 }, name: { value: "" } },
    { nodeId: "3", backendDOMNodeId: 3 },
  ];
  // 이름이 문자열이 아니면 이름 없는 것으로 친다 — 못 읽은 이름을 있는 것으로 믿지 않는다.
  assert.equal(unnamedControlsOf(odd, 10).total, 1);
});

test("withDeadline — 시간 안에 끝나면 그 값이고, 넘으면 null 이다", async () => {
  assert.equal(await withDeadline(Promise.resolve(42), 200), 42);
  const never = new Promise<number>(() => {});
  assert.equal(await withDeadline(never, 20), null);
});

test("withDeadline — 일이 실패하면 그 실패가 그대로 던져진다(부르는 쪽이 null 로 삼킨다)", async () => {
  await assert.rejects(
    withDeadline(Promise.reject(new Error("붙임이 끊겼다")), 200),
    /붙임이 끊겼다/,
  );
});
