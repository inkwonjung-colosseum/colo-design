import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDelivery, type DeliveryInput } from "../src/delivery.ts";

const base: DeliveryInput = {
  pendingChanges: 0,
  branch: null,
  handoff: null,
  running: false,
  phase: "ready",
};
const at = (patch: Partial<DeliveryInput>) => deriveDelivery({ ...base, ...patch });
const pr = (state: "open" | "changes_requested" | "merged", number = 12) =>
  ({ number, url: "", title: "", state, branch: "cds-design/1" }) as DeliveryInput["handoff"];

test("phase 가 없거나 진행 중이면 null — ProgressPanel 이 열을 갖는다", () => {
  assert.equal(at({ phase: "installing" }), null);
  assert.equal(at({ phase: null }), null);
});

test("phase error 도 칩을 그린다 — 미리보기는 죽어도 워크트리는 살아 있다", () => {
  const d = at({ phase: "error", pendingChanges: 3 });
  assert.equal(d?.state, "unsaved");
  assert.equal(d?.chip.label, "저장 안 함 3건");
  assert.equal(d?.actions.save.enabled, true, "a dead preview must not strand done work");
});

test("clean: 변경 0 · 브랜치 없음 · PR 없음 — 둘 다 잠기고 이유가 있다", () => {
  const d = at({});
  assert.equal(d?.state, "clean");
  assert.equal(d?.chip.label, "변경 없음");
  assert.equal(d?.actions.save.enabled, false);
  assert.equal(d?.actions.save.reason, "저장할 변경이 없습니다");
  assert.equal(d?.actions.handoff.enabled, false);
  assert.equal(d?.actions.handoff.reason, "먼저 저장해 주세요");
  assert.equal(d?.actions.check, null);
});

test("unsaved: 저장이 열리고 넘기기는 잠긴다 — 지금 눌러야 할 것은 저장", () => {
  const d = at({ pendingChanges: 3 });
  assert.equal(d?.state, "unsaved");
  assert.equal(d?.chip.label, "저장 안 함 3건");
  assert.equal(d?.actions.save.enabled, true);
  assert.equal(d?.actions.handoff.enabled, false);
  assert.equal(d?.actions.check, null, "PR 이 없으면 상태 확인도 없다");
});

test("unsaved + running: 저장이 잠기고 칩은 고치는 중으로 말한다", () => {
  const d = at({ pendingChanges: 3, running: true });
  assert.equal(d?.chip.label, "고치는 중 · 3건");
  assert.equal(d?.actions.save.enabled, false);
  assert.equal(d?.actions.save.reason, "Claude 가 고치는 중 — 끝나면 저장할 수 있습니다");
});

test("unsaved 가 PR 상태보다 앞선다 — PR 은 칩 title 과 상태 확인으로 남는다", () => {
  const d = at({ pendingChanges: 2, handoff: pr("open") });
  assert.equal(d?.state, "unsaved", "칩은 하나고 지금 눌러야 할 것은 저장이다");
  assert.equal(d?.chip.title, "저장하면 PR #12 에 쌓입니다");
  assert.ok(d?.actions.check, "PR 이 있으니 상태 확인이 그려진다");
  assert.equal(d?.actions.handoff.enabled, false);
});

test("saved: 넘기기가 열린다 — 이 표의 유일한 열린 넘기기 외의 자리", () => {
  const d = at({ branch: "cds-design/20260911-1" });
  assert.equal(d?.state, "saved");
  assert.equal(d?.chip.label, "저장됨");
  assert.equal(d?.chip.title, "cds-design/20260911-1", "칩의 title 은 브랜치 이름");
  assert.equal(d?.actions.handoff.enabled, true);
  assert.equal(d?.actions.save.enabled, false);
  assert.equal(d?.actions.check, null);
});

test("handed: 상태 확인이 열리고 넘기기는 잠긴다", () => {
  const d = at({ handoff: pr("open") });
  assert.equal(d?.state, "handed");
  assert.equal(d?.chip.label, "개발자 검토 중 · #12");
  assert.ok(d?.actions.check?.enabled);
  assert.equal(d?.actions.handoff.reason, "이미 넘겼습니다 — 저장하면 같은 PR 에 쌓입니다");
  assert.equal(d?.actions.save.enabled, false);
});

test("changes_requested: 칩의 title 이 개발자 코멘트로 이어 준다", () => {
  const d = at({ handoff: pr("changes_requested") });
  assert.equal(d?.state, "changes_requested");
  assert.equal(d?.chip.label, "변경 요청 · #12");
  assert.equal(d?.chip.title, "개발자 코멘트가 왔습니다 — 상태 확인에서 이어 가세요");
  assert.ok(d?.actions.check?.enabled);
});

test("merged: 칩은 반영됨 — 변경이 생기면 저장이 열리고 넘기기는 잠긴다", () => {
  const merged = at({ handoff: pr("merged") });
  assert.equal(merged?.state, "merged");
  assert.equal(merged?.chip.label, "반영됨");
  assert.equal(merged?.actions.save.enabled, false);
  assert.equal(merged?.actions.handoff.enabled, false);
  assert.equal(merged?.actions.check, null);

  const withChanges = at({ handoff: pr("merged"), pendingChanges: 1 });
  assert.equal(withChanges?.state, "merged", "칩은 반영됨을 유지한다");
  assert.equal(withChanges?.actions.save.enabled, true, "변경이 있으면 저장이 열린다");
  assert.equal(withChanges?.actions.handoff.enabled, false);
});

test("D84 의 전제: merged 뒤 새 브랜치의 handoff 는 null 이어야 saved 가 성립한다", () => {
  // The daemon clears the merged handoff at ensureCycleBranch (D84); this is
  // the row the table draws once that holds — 새 사이클의 saved.
  const d = at({ branch: "cds-design/20260911-2", handoff: null });
  assert.equal(d?.state, "saved");
});
