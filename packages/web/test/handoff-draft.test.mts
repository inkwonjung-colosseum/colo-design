/**
 * The 넘기기 draft the browser contributes (PLAN D5/D7): the screens this cycle
 * hands over and the states each one implements, one line per screen that
 * names the 기획서 it was built from.
 *
 * Run: node --experimental-transform-types --test packages/web/test/handoff-draft.test.mts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffDraft } from "../src/handoff-draft.ts";

const screen = (over: Partial<Parameters<typeof handoffDraft>[1][number]> = {}) => ({
  route: "/inventory-audit/InventoryAuditList",
  title: "재고 실사 목록",
  states: ["default", "empty"],
  spec: "specs/재고 실사 기획서.md",
  ...over,
});

test("the draft tells the developer which states the mock actually implements", () => {
  const { body } = handoffDraft("재고 실사 화면", [screen()]);

  // The states are handed over unjudged: deciding how far the mock went means
  // reading the 기획서, and the developer is the one who reads it next.
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

test("the draft names no screen that declares no 기획서", () => {
  // A screen with no spec has nothing to say about what it was built from —
  // a hole, not information.
  const stranger = handoffDraft("결제", [screen({ spec: null })]);
  assert.equal(stranger.body, "");

  // Nothing declared at all: an empty field, so the daemon's own proposal
  // (which can name the screens behind the work) is what gets sent.
  assert.equal(handoffDraft("결제", []).body, "");
});

test("the draft does not say 화면 twice", () => {
  assert.equal(handoffDraft("재고 실사 화면", []).title, "재고 실사 화면");
  assert.equal(handoffDraft("결제", []).title, "결제 화면");
  assert.equal(handoffDraft("", []).title, "");
});
