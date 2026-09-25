// U20(PLAN-UI §10) — 영수증의 `개발자에게 한마디 더`(repo.note). 열린 요청에
// 달리는 코멘트의 몸통(`> 한마디:` 인용 줄 + 대리 표기) · 열린 요청 없음과
// 401 의 거절 문장 · 성공이 제출 기록에 남기는 한 줄.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSupervisedScene } from "./helpers/cycle-harness.ts";

const BRANCH = "colo-design/20260924-1";

/** 레지스트리가 기억하는 열린 요청 — HandoffStatus 와 같은 모양. */
const OPEN_PR = {
  number: 7,
  url: "https://github.test/colo-design/harness/pull/7",
  title: "회원 목록 화면",
  state: "open" as const,
  branch: BRANCH,
};

test("한마디 더 — 열린 요청에 `> 한마디:` 줄과 대리 표기가 실린다", async () => {
  const scene = await makeSupervisedScene({ branch: BRANCH, handoff: OPEN_PR });
  try {
    scene.authorName = "김기획";
    await scene.workspace.noteToDeveloper("검색창 위치는 기획 의도예요");
    const sent = scene.github.commentsFor(7).at(-1);
    assert.ok(sent, "요청에 코멘트가 달렸다");
    assert.equal(sent.body.split("\n\n")[0], "> 한마디: 검색창 위치는 기획 의도예요");
    assert.match(sent.body, /— Colo Design 이 김기획 님 대신 남김/);
    // 성공의 흔적 — 제출 기록의 마지막 한 줄(`이번 작업` 이 읽는 값).
    const log = scene.supervisor.submitView().log;
    assert.equal(log.at(-1)?.text, "개발자에게 한마디를 더 보냈어요");
  } finally {
    await scene.dispose();
  }
});

test("한마디 더 — 여러 줄 말은 인용 줄마다 이어진다", async () => {
  const scene = await makeSupervisedScene({ branch: BRANCH, handoff: OPEN_PR });
  try {
    await scene.workspace.noteToDeveloper("첫째 줄\n둘째 줄");
    const sent = scene.github.commentsFor(7).at(-1);
    assert.ok(sent);
    assert.equal(
      sent.body.split("\n\n")[0],
      "> 한마디: 첫째 줄\n> 둘째 줄",
      "제출 확인의 한마디와 같은 꼴(noteLine)",
    );
  } finally {
    await scene.dispose();
  }
});

test("한마디 더 — 열린 요청이 없으면 한국어로 거절한다", async () => {
  const scene = await makeSupervisedScene({ branch: BRANCH });
  try {
    await assert.rejects(
      scene.workspace.noteToDeveloper("덧붙일 말"),
      /열린 요청이 없어요 — 제출한 뒤에 보낼 수 있어요/,
    );
    // 끝난 요청도 닫힌 것이다 — 반영됐다는 말은 갈 곳이 없다는 말이다.
    const ended = await makeSupervisedScene({
      branch: BRANCH,
      handoff: { ...OPEN_PR, state: "merged" },
    });
    try {
      await assert.rejects(ended.workspace.noteToDeveloper("덧붙일 말"), /열린 요청이 없어요/);
    } finally {
      await ended.dispose();
    }
  } finally {
    await scene.dispose();
  }
});

test("한마디 더 — 401 은 답하기와 같은 거절 문장으로 나간다", async () => {
  const scene = await makeSupervisedScene({ branch: BRANCH, handoff: OPEN_PR });
  try {
    scene.github.expireAuth();
    await assert.rejects(
      scene.workspace.noteToDeveloper("덧붙일 말"),
      /GitHub 401/,
      "commentOnIssue 의 한국어 머리 + GitHub 의 말",
    );
    // 실패는 기록에 남지 않는다 — 간 말의 영수증만 적는다.
    assert.equal(scene.supervisor.submitView().log.length, 0);
  } finally {
    await scene.dispose();
  }
});
