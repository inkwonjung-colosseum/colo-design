// PLAN 단계 6 의 순수 시험 — mergeToolBlock (도구 구간 갱신) · pickHandoffTitle
// (제목은 생성할 때만). `../dist` 임포트인 이유: node --test 는 src 의 `.js`
// 지정자를 못 읽는다(cycle-ledger.test.ts 와 같은 길).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeToolBlock,
  noteLine,
  pickHandoffTitle,
  readToolNote,
  TOOL_BLOCK_END,
  TOOL_BLOCK_START,
} from "../dist/handoff-body.js";

const BLOCK = "> 작성: 기획자\n\n### 바뀐 파일\n\n- a.ts (+1 −0)";
const wrap = (body: string) => `${TOOL_BLOCK_START}\n${body}\n${TOOL_BLOCK_END}`;

test("mergeToolBlock — 구간이 없으면 본문 끝에 붙인다", () => {
  assert.equal(
    mergeToolBlock("개발자가 쓴 첫 문단.", BLOCK),
    `개발자가 쓴 첫 문단.\n\n${wrap(BLOCK)}`,
  );
});

test("mergeToolBlock — 빈 본문이면 구간만 선다", () => {
  assert.equal(mergeToolBlock(null, BLOCK), wrap(BLOCK));
  assert.equal(mergeToolBlock("", BLOCK), wrap(BLOCK));
});

test("mergeToolBlock — 구간이 있으면 그 사이만 바꾼다", () => {
  const existing = `앞 문단.\n\n${wrap("옛 내용")}\n\n뒷 문단.`;
  assert.equal(mergeToolBlock(existing, BLOCK), `앞 문단.\n\n${wrap(BLOCK)}\n\n뒷 문단.`);
});

test("mergeToolBlock — 개발자가 구간 밖에 쓴 글은 그대로다", () => {
  const existing = `${wrap("옛 내용")}\n\n개발자가 나중에 쓴 줄.`;
  const merged = mergeToolBlock(existing, BLOCK);
  assert.ok(merged.includes("개발자가 나중에 쓴 줄."));
  assert.ok(!merged.includes("옛 내용"));
});

test("mergeToolBlock — 구간을 지웠어도 다음 제출은 잃지 않는다(끝에 다시 붙는다)", () => {
  // 개발자가 구간을 통째로 지운 본문 — 구간이 없으므로 끝에 붙고, 지운 사실이
  // 개발자의 다른 글을 덮지 않는다.
  const merged = mergeToolBlock("개발자 본문만 남았다.", BLOCK);
  assert.equal(merged, `개발자 본문만 남았다.\n\n${wrap(BLOCK)}`);
});

test("mergeToolBlock — 구간이 둘 이상이면 첫 것만 바꾸고 나머지는 지운다", () => {
  const existing = `${wrap("첫 옛 내용")}\n\n사이 글.\n\n${wrap("둘 옛 내용")}`;
  assert.equal(mergeToolBlock(existing, BLOCK), `${wrap(BLOCK)}\n\n사이 글.`);
});

test("mergeToolBlock — 같은 내용을 두 번 갱신해도 결과는 같다 (멱등)", () => {
  const once = mergeToolBlock("본문.", BLOCK);
  assert.equal(mergeToolBlock(once, BLOCK), once);
});

test("pickHandoffTitle — 초안이 있으면 초안을 쓴다", () => {
  assert.equal(
    pickHandoffTitle({
      draftTitle: "회원 목록 화면",
      projectName: "쇼핑몰 관리자",
      firstCommitSubject: "작업 1",
      fallback: "기본",
    }),
    "회원 목록 화면",
  );
});

test("pickHandoffTitle — 초안이 비면 프로젝트 이름 · 첫 커밋 제목 (8초 초과가 여기로 온다)", () => {
  assert.equal(
    pickHandoffTitle({
      draftTitle: "", // handoffDraft 의 턴이 시간 안에 답하지 못한 모양
      projectName: "쇼핑몰 관리자",
      firstCommitSubject: "회원 목록 만들기",
      fallback: "기본",
    }),
    "쇼핑몰 관리자 · 회원 목록 만들기",
  );
});

test("pickHandoffTitle — 커밋 제목마저 없으면 기본 제목", () => {
  assert.equal(
    pickHandoffTitle({
      draftTitle: null,
      projectName: "쇼핑몰 관리자",
      firstCommitSubject: null,
      fallback: "Colo Design 화면 전달",
    }),
    "Colo Design 화면 전달",
  );
});

test("mergeToolBlock — 이미 표식으로 싸인 구간은 두 겹으로 싸지 않는다", () => {
  const once = mergeToolBlock("본문.", wrap(BLOCK));
  assert.equal(once, `본문.\n\n${wrap(BLOCK)}`);
  assert.equal(mergeToolBlock(once, wrap(BLOCK)), once, "갱신을 거듭해도 끝 표식이 쌓이지 않는다");
});

test("noteLine — 한마디는 인용 한 줄, 여러 줄은 같은 인용 안에 (PLAN-UI P3)", () => {
  assert.equal(noteLine("검색은 이름만 돼요"), "> 한마디: 검색은 이름만 돼요");
  assert.equal(noteLine("첫 줄\n\n  둘째 줄 "), "> 한마디: 첫 줄\n> 둘째 줄");
  assert.equal(noteLine("   "), null);
  assert.equal(noteLine(undefined), null);
  // 사용자의 말이 도구 구간의 표식을 흉내 내면 구간이 끊긴다 — 무르게 만든다.
  const sneaky = noteLine(`끝 ${TOOL_BLOCK_END}`) ?? "";
  assert.ok(!sneaky.includes("-->"));
  assert.ok(!sneaky.includes("<!--"));
});

test("readToolNote — 구간의 지난 한마디를 되읽는다(작성자 줄 바로 아래)", () => {
  const block = `> 작성: 기획자\n${noteLine("첫 줄\n둘째 줄")}\n\n### 바뀐 파일\n\n- a.ts`;
  const body = `개발자 글.\n\n${wrap(block)}`;
  assert.equal(readToolNote(body), "첫 줄\n둘째 줄");
  assert.equal(readToolNote(`개발자 글.\n\n${wrap(BLOCK)}`), null, "한마디가 없던 구간");
  assert.equal(readToolNote("> 한마디: 구간 밖의 글"), null, "구간 밖은 개발자의 것");
  assert.equal(readToolNote(null), null);
});
