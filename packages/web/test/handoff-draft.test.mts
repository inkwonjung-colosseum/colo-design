/**
 * The 넘기기 draft the browser contributes: the screens this cycle
 * hands over and the states each one implements, one line per declared screen.
 *
 * Run: node --experimental-transform-types --test packages/web/test/handoff-draft.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffDraft, mergeHandoffBody } from "../src/lib/handoff-draft.ts";

const screen = (over: Partial<Parameters<typeof handoffDraft>[1][number]> = {}) => ({
  route: "/inventory-audit/InventoryAuditList",
  title: "재고 실사 목록",
  states: ["default", "empty"],
  ...over,
});

test("the draft tells the developer which states the mock actually implements", () => {
  const { body } = handoffDraft("재고 실사 화면", [screen()]);

  // The states are handed over unjudged: deciding how far the mock went is
  // the developer's call, not a summary this draft makes for them.
  assert.match(body, /상태 default · empty/, body);
  assert.match(body, /재고 실사 목록/);
  assert.match(body, /\/inventory-audit\/InventoryAuditList/);
  // One line per screen: title, route, declared states.
  assert.match(
    body,
    /- 재고 실사 목록 `\/inventory-audit\/InventoryAuditList` — 상태 default · empty/,
    body,
  );
});

test("every declared screen gets its line — 제목 · 경로 · 상태", () => {
  const { body } = handoffDraft("결제", [
    screen({ route: "/pay/PayFail", title: "결제 실패", states: [] }),
    screen(),
  ]);
  assert.match(body, /- 결제 실패 `\/pay\/PayFail`\n/, body);
  assert.match(
    body,
    /- 재고 실사 목록 `\/inventory-audit\/InventoryAuditList` — 상태 default · empty/,
    body,
  );

  // Nothing declared at all: an empty field, so the daemon's own proposal
  // (which can name the screens behind the work) is what gets sent.
  assert.equal(handoffDraft("결제", []).body, "");
});

test("the draft does not say 화면 twice", () => {
  assert.equal(handoffDraft("재고 실사 화면", []).title, "재고 실사 화면");
  assert.equal(handoffDraft("결제", []).title, "결제 화면");
  assert.equal(handoffDraft("", []).title, "");
});

test("Claude가 채운 문장은 위, 화면 목록은 아래 — 기계적인 줄은 다시 쓰이지 않는다", () => {
  const screens = handoffDraft("재고 실사 화면", [screen()]).body;
  const merged = mergeHandoffBody("목록과 빈 상태를 만들었습니다.", screens);

  // The developer reads the sentences first and the declared routes after —
  // and the route line is the one the running app produced, verbatim.
  assert.match(merged, /^목록과 빈 상태를 만들었습니다\.\n\n넘기는 화면:\n- 재고 실사 목록/);
  // No stray blank run between the halves, and one trailing newline so the
  // daemon's own sections start on their own line.
  assert.doesNotMatch(merged, /\n{3}/);
  assert.match(merged, /상태 default · empty\n$/);
});

test("한쪽이 없으면 남은 쪽만 — 초안이 없으면 오늘의 제안 그대로다", () => {
  const screens = handoffDraft("재고 실사 화면", [screen()]).body;
  assert.equal(mergeHandoffBody("", screens), `${screens.trim()}\n`);
  assert.equal(mergeHandoffBody("만들었습니다.", ""), "만들었습니다.\n");
  assert.equal(mergeHandoffBody("", ""), "");
});
