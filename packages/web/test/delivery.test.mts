import assert from "node:assert/strict";
import { test } from "node:test";
import { type DeliveryInput, deriveDelivery } from "../src/lib/delivery.ts";

const base: DeliveryInput = {
  pendingChanges: 0,
  branch: null,
  handoff: null,
  running: false,
  phase: "ready",
};
const at = (patch: Partial<DeliveryInput>) => deriveDelivery({ ...base, ...patch });
const pr = (state: "open" | "changes_requested" | "merged" | "closed", number = 12) =>
  ({
    number,
    url: "",
    title: "",
    state,
    branch: "colo-design/1",
  }) as DeliveryInput["handoff"];

test("phase 가 없거나 진행 중이면 null — ProgressPanel 이 열을 갖는다", () => {
  assert.equal(at({ phase: "installing" }), null);
  assert.equal(at({ phase: null }), null);
});

test("closed: 개발자의 반려는 저장됨으로 위장되지 않는다", () => {
  const d = at({ handoff: pr("closed"), branch: "colo-design/20260915-1" });
  assert.equal(d?.state, "closed", "반려 행이 없으면 `if (branch)` 로 떨어져 저장됨이 된다");
  assert.equal(d?.chip.label, "개발자가 반려함");
  assert.equal(d?.primary, "check", "다음 수는 닫은 이유를 읽는 것이다");
  assert.equal(
    d?.actions.handoff.enabled,
    false,
    "닫힌 요청의 제목·본문을 덮어쓰는 길이 열려 있으면 안 된다",
  );
  assert.ok(d?.actions.check?.enabled, "반려 이유는 상태 확인으로 읽는다");

  const withChanges = at({
    handoff: pr("closed"),
    branch: "colo-design/20260915-1",
    pendingChanges: 2,
  });
  assert.equal(withChanges?.state, "closed", "칩은 반려를 유지한다");
  assert.equal(withChanges?.actions.save.enabled, true, "반려 뒤에도 고쳐 저장할 수 있다");
});

test("phase error 도 칩을 그린다 — 미리보기는 죽어도 워크트리는 살아 있다", () => {
  const d = at({ phase: "error", pendingChanges: 3 });
  assert.equal(d?.state, "unsaved");
  // 칩의 숫자는 그만두었다: 파일 수는 기획자
  // 체감과 역상관 — 개수는 저장 검토의 `자세히 보기`가 말한다.
  assert.equal(d?.chip.label, "저장 안 함");
  assert.equal(d?.primary, "save");
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
  assert.equal(d?.chip.label, "저장 안 함");
  assert.equal(d?.primary, "save");
  assert.equal(d?.actions.save.enabled, true);
  assert.equal(d?.actions.handoff.enabled, false);
  assert.equal(d?.actions.check, null, "PR 이 없으면 상태 확인도 없다");
});

test("unsaved + running: 저장이 잠기고 칩은 고치는 중으로 말한다", () => {
  const d = at({ pendingChanges: 3, running: true });
  assert.equal(d?.chip.label, "고치는 중");
  assert.equal(d?.actions.save.enabled, false);
  assert.equal(d?.actions.save.reason, "Claude가 고치는 중 — 끝나면 저장할 수 있습니다");
});

test("unsaved 가 넘긴 요청보다 앞선다 — 요청은 칩 title 과 상태 확인으로 남는다", () => {
  const d = at({ pendingChanges: 2, handoff: pr("open") });
  assert.equal(d?.state, "unsaved", "칩은 하나고 지금 눌러야 할 것은 저장이다");
  assert.equal(d?.chip.title, "저장하면 넘긴 요청에 함께 담깁니다");
  assert.equal(d?.primary, "save", "PR 이 열려 있어도 다음 수는 저장이다");
  assert.ok(d?.actions.check, "넘긴 요청이 있으니 상태 확인이 그려진다");
  assert.equal(d?.actions.handoff.enabled, false);
});

test("saved: 넘기기가 열린다 — 이 표의 유일한 열린 넘기기 외의 자리", () => {
  const d = at({ branch: "colo-design/20260911-1" });
  assert.equal(d?.state, "saved");
  assert.equal(d?.chip.label, "저장됨");
  assert.equal(d?.chip.title, "이번 저장은 아직 개발자에게 전달되지 않았습니다");
  assert.equal(d?.primary, "handoff", "저장 뒤의 다음 수는 넘기기다");
  assert.equal(d?.actions.handoff.enabled, true);
  assert.equal(d?.actions.save.enabled, false);
  assert.equal(d?.actions.check, null);
});

test("handed: 상태 확인이 열리고 넘기기는 잠긴다", () => {
  const d = at({ handoff: pr("open") });
  assert.equal(d?.state, "handed");
  assert.equal(d?.chip.label, "개발자 검토 중");
  assert.equal(d?.chip.title, "넘긴 요청 12번을 개발자가 검토하는 중입니다");
  assert.equal(d?.primary, "check");
  assert.ok(d?.actions.check?.enabled);
  assert.equal(d?.actions.handoff.reason, "이미 넘겼습니다 — 새로 저장하면 같은 요청에 합쳐집니다");
  assert.equal(d?.actions.save.enabled, false);
});

test("changes_requested: 칩의 title 이 개발자 코멘트로 이어 준다", () => {
  const d = at({ handoff: pr("changes_requested") });
  assert.equal(d?.state, "changes_requested");
  assert.equal(d?.chip.label, "변경 요청");
  assert.equal(
    d?.chip.title,
    "개발자가 넘긴 요청 12번에 코멘트를 남겼습니다 — 상태 확인에서 이어 가세요",
  );
  assert.ok(d?.actions.check?.enabled);
  // 바늘 보정: 개발자가 기획자를 기다리는 이
  // 상태에서 상태 확인이 회색이면 바의 세 버튼이 전부 잠긴 채 며칠이 흐른다.
  assert.equal(d?.primary, "check");
});

test("merged: 칩은 반영됨 — 변경이 생기면 저장이 열리고 넘기기는 잠긴다", () => {
  const merged = at({ handoff: pr("merged") });
  assert.equal(merged?.state, "merged");
  assert.equal(merged?.chip.label, "반영됨");
  assert.equal(merged?.primary, null, "기다릴 것이 없으면 강조도 없다");
  assert.equal(merged?.actions.save.enabled, false);
  assert.equal(merged?.actions.handoff.enabled, false);
  assert.equal(merged?.actions.check, null);

  const withChanges = at({ handoff: pr("merged"), pendingChanges: 1 });
  assert.equal(withChanges?.state, "merged", "칩은 반영됨을 유지한다");
  assert.equal(withChanges?.primary, "save", "변경이 쌓였으면 다음 사이클의 저장이 다음 수다");
  assert.equal(withChanges?.actions.save.enabled, true, "변경이 있으면 저장이 열린다");
  assert.equal(withChanges?.actions.handoff.enabled, false);
});

test("반영됨에서 턴이 도는 동안 칩도 작업 중을 말한다 — 행과 칩이 어긋나지 않는다", () => {
  const started = at({ handoff: pr("merged"), running: true });
  assert.equal(started?.state, "merged", "잠김은 표가 정한 그대로 — 사이클은 아직 merged");
  assert.equal(
    started?.chip.label,
    "작업 중",
    "사이드바 행이 작업 중을 말할 때 칩이 반영됨을 말하면 두 표식이 어긋난다",
  );
  assert.equal(started?.chip.tone, "pending");
  assert.equal(started?.actions.save.enabled, false, "저장할 변경이 없으니 잠겨 있다");
  assert.equal(started?.actions.handoff.enabled, false, "개발자가 이미 받아 갔습니다");

  const redrawing = at({ handoff: pr("merged"), running: true, pendingChanges: 2 });
  assert.equal(redrawing?.chip.label, "고치는 중");
  assert.equal(
    redrawing?.chip.title,
    "다음 저장은 새 사이클을 시작합니다",
    "말이 바뀌어도 칩이 말 못한 사이클의 사실은 title 이 전한다",
  );
  assert.equal(redrawing?.actions.save.enabled, false, "도는 동안 저장은 잠긴다");
  assert.equal(redrawing?.actions.save.reason, "Claude가 고치는 중 — 끝나면 저장할 수 있습니다");

  const handedTurn = at({ handoff: pr("open"), running: true });
  assert.equal(handedTurn?.chip.label, "작업 중", "규칙은 넘김 행에도 같다");
});

test("merged 뒤 새 브랜치의 handoff 는 null 이어야 saved 가 성립한다", () => {
  // The daemon clears the merged handoff at ensureCycleBranch; this is
  // the row the table draws once that holds — 새 사이클의 saved.
  const d = at({ branch: "colo-design/20260911-2", handoff: null });
  assert.equal(d?.state, "saved");
});

test("치워둔 작업이 있으면 clean 행의 `변경 없음` 칩은 존재하지 않는다", () => {
  const d = at({ shelf: { at: "2026-09-15T00:00:00Z" } });
  assert.equal(d?.state, "clean");
  assert.equal(d?.chip.label, "치워둔 작업 1건");
  assert.equal(d?.chip.tone, "shelf", "warning 색이 아니다 — 치워둔 작업은 안전하다");
  assert.ok(d?.chip.title?.includes("다시 꺼내면"), "title 이 돌아오는 문을 말한다");
  assert.equal(d?.actions.save.enabled, false);
  assert.equal(
    d?.actions.save.reason,
    "치워둔 작업이 있습니다 — 더 보기 메뉴에서 꺼내 주세요",
    "`없다`는 문장은 치워둔 순간 거짓말이 된다",
  );
  assert.equal(d?.actions.handoff.reason, "치워둔 작업을 먼저 꺼내 저장해 주세요");
});

test("치워둔 작업은 다른 행의 칩을 빼앗지 않는다 — 칩 하나 계약", () => {
  // 저장 안 함 2건 + 치워둔 1건: 칩은 지금 눌러야 할 것(저장)을 말하고,
  // 치워둔 작업은 더 보기 메뉴와 저장 잠금 이유로만 산다.
  const d = at({ pendingChanges: 2, shelf: { at: "2026-09-15T00:00:00Z" } });
  assert.equal(d?.state, "unsaved");
  assert.equal(d?.chip.label, "저장 안 함");
  assert.equal(d?.actions.save.enabled, true);

  // 저장됨 행에서도 마찬가지 — 칩은 저장됨을 지키고, 저장 버튼의 잠금
  // 이유만 치워둔 곳을 가리킨다.
  const saved = at({ branch: "colo-design/20260915-1", shelf: { at: "2026-09-15T00:00:00Z" } });
  assert.equal(saved?.state, "saved");
  assert.equal(saved?.chip.label, "저장됨");
  assert.equal(saved?.actions.save.reason, "치워둔 작업이 있습니다 — 더 보기 메뉴에서 꺼내 주세요");
});
