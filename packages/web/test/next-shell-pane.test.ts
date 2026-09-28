import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-connection-copy.test.ts 와 같은 모양).
import { decideShellPane } from "../src/next/lib/shell-pane.ts";

/** 프로젝트가 있는 기계의 다시 열기 — 초대장으로 이미 시작한 창이 이 모양이다. */
const reopened = {
  statusLoaded: true,
  projectCount: 3,
  applyingFirst: false,
  gatesHold: false,
};

test("첫 상태가 오기 전에는 판정하지 않는다 — 표지가 창을 지킨다", () => {
  // 상태가 없는 동안은 `프로젝트 0개` 가 아니다 — 다시 열기의 첫 순간에
  // 체크리스트가 번쩍이던 깜빡임의 뿌리다.
  for (const projectCount of [0, 3]) {
    for (const gatesHold of [false, true]) {
      const pane = decideShellPane({
        statusLoaded: false,
        projectCount,
        applyingFirst: false,
        gatesHold,
      });
      assert.equal(pane, "boot", `projectCount=${projectCount} gatesHold=${gatesHold}`);
    }
  }
});

test("다시 열기 — 프로젝트가 있고 게이트가 다니면 곧장 작업 틀", () => {
  assert.equal(decideShellPane(reopened), "workspace");
});

test("첫 실행 — 상태가 왔는데 프로젝트가 없으면 체크리스트", () => {
  const pane = decideShellPane({ ...reopened, projectCount: 0 });
  assert.equal(pane, "first-run");
});

test("게이트가 막으면 프로젝트가 있어도 체크리스트", () => {
  const pane = decideShellPane({ ...reopened, gatesHold: true });
  assert.equal(pane, "first-run");
});

test("첫 실행의 초대 적용이 도는 동안에도 첫 화면을 지킨다", () => {
  // 첫 프로젝트가 생기는 순간 넘어가면 나머지 진행과 실패가 안 보인다.
  const pane = decideShellPane({ ...reopened, projectCount: 1, applyingFirst: true });
  assert.equal(pane, "first-run");
});
