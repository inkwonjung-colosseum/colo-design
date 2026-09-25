import assert from "node:assert/strict";
import { test } from "node:test";
// 둘 다 형제를 부르지 않는 순수 모듈 — src 에서 곧장 읽는다.
import { previewPathOf } from "../src/lib/screen-link.ts";
import {
  lastTurnScreens,
  screenKey,
  screenLinksOf,
  threadScreens,
  titleOfPath,
} from "../src/lib/turn-screens.ts";

const PREVIEW = "http://127.0.0.1:5274/";
const toPath = (href: string) => previewPathOf(href, PREVIEW);

const user = (id: string, text = "화면 만들어 줘") =>
  ({ type: "user", id, text, images: 0 }) as const;
const answer = (id: string, text: string, agentId: string | null = null) =>
  ({ type: "text", id, text, agentId, streaming: false }) as const;
const turnEnd = (id: string) =>
  ({
    type: "turn",
    id,
    subtype: "success",
    isError: false,
    costUsd: null,
    durationMs: 1000,
    resultText: null,
  }) as const;

test("마크다운 링크의 제목과 경로를 뽑고, 미리보기 밖 주소는 버린다", () => {
  const text =
    "만들었습니다.\n\n[**회원 목록**](http://127.0.0.1:5274/member/list) · [문서](https://github.com/o/r)";
  assert.deepEqual(screenLinksOf(text, toPath), [{ path: "/member/list", title: "회원 목록" }]);
});

test("다른 포트의 루프백 링크도 이 미리보기의 화면으로 읽는다", () => {
  const text = "[주문 상세](http://localhost:6001/order/detail?id=3)";
  assert.deepEqual(screenLinksOf(text, toPath), [
    { path: "/order/detail?id=3", title: "주문 상세" },
  ]);
});

test("맨 주소는 제목 없이, 문장 끝 구두점을 떼고 읽는다", () => {
  const text = "여기서 보세요: http://127.0.0.1:5274/settings.";
  assert.deepEqual(screenLinksOf(text, toPath), [{ path: "/settings", title: null }]);
});

test("링크 안의 주소를 맨 주소로 한 번 더 세지 않는다", () => {
  const text = "[설정](http://127.0.0.1:5274/settings)";
  assert.equal(screenLinksOf(text, toPath).length, 1);
});

test("마지막 턴의 화면만 — 앞 턴의 링크와 하위 에이전트의 글은 빠진다", () => {
  const blocks = [
    user("u1"),
    answer("t1", "[옛 화면](http://127.0.0.1:5274/old)"),
    turnEnd("e1"),
    user("u2"),
    answer("t2", "[내부 보고](http://127.0.0.1:5274/sub)", "agent-1"),
    answer("t3", "[회원 목록](http://127.0.0.1:5274/member/list)"),
    answer(
      "t4",
      "[회원 목록](http://127.0.0.1:5274/member/list/) · [상세](http://127.0.0.1:5274/member/1)",
    ),
    turnEnd("e2"),
  ];
  assert.deepEqual(lastTurnScreens(blocks, toPath), [
    { path: "/member/list", title: "회원 목록" },
    { path: "/member/1", title: "상세" },
  ]);
});

test("화면을 말하지 않은 턴은 빈 목록이다", () => {
  const blocks = [user("u1"), answer("t1", "색을 바꿨습니다."), turnEnd("e1")];
  assert.deepEqual(lastTurnScreens(blocks, toPath), []);
});

test("대화의 화면은 최근에 말한 것이 앞, 제목은 마지막 것을 입되 맨 주소가 지우지 않는다", () => {
  const blocks = [
    user("u1"),
    answer("t1", "[회원 목록](http://127.0.0.1:5274/member/list)"),
    user("u2"),
    answer("t2", "[주문](http://127.0.0.1:5274/order)"),
    user("u3"),
    answer("t3", "다시 보세요 http://127.0.0.1:5274/member/list"),
  ];
  assert.deepEqual(threadScreens(blocks, toPath), [
    { path: "/member/list", title: "회원 목록" },
    { path: "/order", title: "주문" },
  ]);
});

test("같은 화면의 잣대는 끝 슬래시와 해시를 무시하고 쿼리는 지킨다", () => {
  assert.equal(screenKey("/member/list/"), "/member/list");
  assert.equal(screenKey("/member/list#top"), "/member/list");
  assert.equal(screenKey(""), "/");
  assert.equal(screenKey("member"), "/member");
  assert.notEqual(screenKey("/order?id=1"), screenKey("/order?id=2"));
  const screens = [{ path: "/member/list", title: "회원 목록" }];
  assert.equal(titleOfPath(screens, "/member/list/"), "회원 목록");
  assert.equal(titleOfPath(screens, "/order"), null);
});
