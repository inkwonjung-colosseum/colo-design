/**
 * The marker that turns a machine-authored turn into a card (PLAN D9).
 *
 * The format has to survive a round trip nobody controls: the text is written
 * here, stored by the Claude Code SDK verbatim, and read back when a planner
 * reopens a thread days later. So the parser is tested on what it will
 * actually meet — its own output, output from an older build, and text that
 * merely looks like a marker.
 *
 * Run: node --experimental-transform-types --test packages/web/test/turn-marker.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alignThumbs,
  type CommentMarkerItem,
  markTurn,
  readTurn,
  type TurnMarker,
} from "../../protocol/src/turn-marker.ts";

const COMMENTS: TurnMarker = {
  kind: "comments",
  screen: "member/MemberList",
  state: "default",
  items: [
    { label: "정진수", comment: "이름 열을 가입일 역순으로 정렬해 주세요." },
    { label: "검색", comment: "상세 버튼을 보조 스타일로 바꿔 주세요." },
  ],
};

test("round trips a marker and leaves the body untouched", () => {
  const body = "화면 수정 요청 2건 — member/MemberList (default 상태)\n위치: div > table";
  const read = readTurn(markTurn(COMMENTS, body));
  assert.deepEqual(read.marker, COMMENTS);
  assert.equal(read.body, body);
});

test("every kind survives the round trip", () => {
  const markers: TurnMarker[] = [
    COMMENTS,
    { kind: "brief", title: "회원 관리 기획서" },
    { kind: "gate", step: "저장한 내용 올리기" },
    {
      kind: "error",
      route: "/member/MemberList",
      state: "오류",
      errorKind: "runtime",
    },
    {
      kind: "error",
      route: "/member/MemberList",
      state: "기본",
      errorKind: "build",
    },
  ];
  for (const marker of markers) {
    assert.deepEqual(readTurn(markTurn(marker, "본문")).marker, marker, marker.kind);
  }
});

test("the plan's literal error marker parses — its kind is the failure, not the card", () => {
  // D49 writes the payload as {"route","state","kind"}: the tag already said
  // "error", so the payload's kind is free to mean runtime vs build.
  const text =
    '<!-- colo-design:error {"route":"/member/MemberList","state":"오류","kind":"build"} -->\n' +
    "Module build failed: …";
  assert.deepEqual(readTurn(text).marker, {
    kind: "error",
    route: "/member/MemberList",
    state: "오류",
    errorKind: "build",
  });
});

test("an error marker without a usable kind degrades to runtime", () => {
  const text = '<!-- colo-design:error {"route":"/a","state":"default"} -->\nTypeError: …';
  assert.deepEqual(readTurn(text).marker, {
    kind: "error",
    route: "/a",
    state: "default",
    errorKind: "runtime",
  });
});

test("a typed message passes through with no marker", () => {
  const text = "회원 목록에 상태 필터를 넣어 주세요.";
  assert.deepEqual(readTurn(text), { marker: null, body: text });
});

test("broken JSON leaves the original text alone", () => {
  // The whole text comes back, marker line included: hiding a line we failed
  // to understand would silently drop something the planner might need.
  const text = '<!-- colo-design:comments {"screen": -->\n화면 수정 요청';
  assert.deepEqual(readTurn(text), { marker: null, body: text });
});

test("an unknown kind is not a marker", () => {
  const text = '<!-- colo-design:sparkle {"a":1} -->\n본문';
  assert.equal(readTurn(text).marker, null);
  assert.equal(readTurn(text).body, text);
});

test("the wrong shape for a known kind is not a marker", () => {
  // `items` missing entirely: a comments card with nothing to list is a lie
  // about what the planner sent.
  const text = '<!-- colo-design:comments {"screen":"a","state":"b"} -->\n본문';
  assert.equal(readTurn(text).marker, null);
});

test("a marker in the middle of a turn is body, not a marker", () => {
  const text = `기획서를 봐 주세요.\n<!-- colo-design:brief {"title":"회원"} -->`;
  assert.deepEqual(readTurn(text), { marker: null, body: text });
});

test("an older build's extra fields are ignored, missing ones blank out", () => {
  const text = '<!-- colo-design:brief {"title":"회원 관리 기획서","path":"ENG/회원.md"} -->\n본문';
  assert.deepEqual(readTurn(text).marker, {
    kind: "brief",
    title: "회원 관리 기획서",
  });

  const bare = "<!-- colo-design:gate {} -->\n본문";
  assert.deepEqual(readTurn(bare).marker, { kind: "gate", step: "" });
});

test("a comment item that is not an object is dropped, not fatal", () => {
  const text =
    '<!-- colo-design:comments {"screen":"s","state":"default","items":["나쁨",{"label":"검색","comment":"고쳐 주세요"}]} -->\n본문';
  const marker = readTurn(text).marker;
  assert.equal(marker?.kind, "comments");
  assert.deepEqual(marker?.kind === "comments" ? marker.items : null, [
    { label: "검색", comment: "고쳐 주세요" },
  ]);
});

test("the crop flag survives the round trip, and its absence is not an empty one", () => {
  // D87: the view photographs what it can reach, so a marker's rows split
  // into flagged and unflagged. The flag has to come back exactly as written
  // — the card hands out thumbnails by counting flagged rows, and one row
  // that lost its flag would shift every image after it onto a wrong pin.
  const marker: TurnMarker = {
    kind: "comments",
    screen: "member/MemberList",
    state: "default",
    items: [
      { label: "정진수", comment: "정렬해 주세요.", shot: true },
      { label: "검색", comment: "보조 스타일로." },
    ],
  };
  assert.deepEqual(readTurn(markTurn(marker, "본문")).marker, marker);
});

test("a marker from before the crop flag reads as flagless, never half-flagged", () => {
  const text =
    '<!-- colo-design:comments {"screen":"s","state":"default","items":[{"label":"검색","comment":"고쳐 주세요","shot":"yes"}]} -->\n본문';
  const marker = readTurn(text).marker;
  assert.deepEqual(marker?.kind === "comments" ? marker.items : null, [
    { label: "검색", comment: "고쳐 주세요" },
  ]);
});

test("a body that itself contains a marker line is not re-split", () => {
  // Claude quoting our own marker back at us must not turn its answer into a
  // second card.
  const body = '앞줄\n<!-- colo-design:gate {"step":"x"} -->';
  const read = readTurn(markTurn({ kind: "brief", title: "회원" }, body));
  assert.equal(read.marker?.kind, "brief");
  assert.equal(read.body, body);
});

test("a skipped crop does not shift the pictures onto the wrong pins", () => {
  // The middle pin was off screen when the send ran, so only two images
  // travelled. Handing them out by position would file 상세's picture under
  // 검색's words — the quietest kind of wrong, and the one a planner would
  // believe.
  const items: CommentMarkerItem[] = [
    { label: "정진수", comment: "a", shot: true },
    { label: "검색", comment: "b" },
    { label: "상세", comment: "c", shot: true },
  ];
  assert.deepEqual(alignThumbs(items, ["첫장", "셋째장"]), ["첫장", null, "셋째장"]);
});

test("more pins than crops leaves the unphotographed ones bare", () => {
  // Seven pins, six crops (D87's ceiling): the seventh shows no image rather
  // than borrowing the sixth pin's.
  const items: CommentMarkerItem[] = Array.from({ length: 7 }, (_, index) => ({
    label: `핀${index + 1}`,
    comment: "고쳐 주세요",
    ...(index < 6 ? { shot: true as const } : {}),
  }));
  const aligned = alignThumbs(
    items,
    Array.from({ length: 6 }, (_, index) => `장${index + 1}`),
  );
  assert.equal(aligned[5], "장6");
  assert.equal(aligned[6], null);
});

test("a marker from before the flag still gets its pictures, by position", () => {
  const items: CommentMarkerItem[] = [
    { label: "정진수", comment: "a" },
    { label: "검색", comment: "b" },
  ];
  assert.deepEqual(alignThumbs(items, ["첫장", "둘째장"]), ["첫장", "둘째장"]);
});

test("a replayed transcript has no crops at all, and no rows break", () => {
  const items: CommentMarkerItem[] = [{ label: "정진수", comment: "a", shot: true }];
  assert.deepEqual(alignThumbs(items, []), [null]);
  assert.deepEqual(alignThumbs(items, undefined), [null]);
});
