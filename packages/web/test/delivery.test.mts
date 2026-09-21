import assert from "node:assert/strict";
import { test } from "node:test";
import { type DeliveryInput, deriveDelivery } from "../src/lib/delivery.ts";

/**
 * 칩 표의 다섯 행 (P2-1). `clean` · `unsaved` · `saved` 셋은 `unsubmitted`
 * 하나로 접혔다 — 자동 저장이 셋을 가르던 유일한 사실(사람이 저장을 눌렀는가)
 * 을 없앴으므로. 이 파일이 지키는 것은 하나: 어느 칸에서든 사용자가 읽는 말은
 * `변경 없음` · `만드는 중` · `제출 전` · `개발자 검토 중` · `변경 요청` ·
 * `반영됨` · `개발자가 반려함` 뿐이고, 그 안에 `저장` 은 없다.
 */
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

test("어느 행에서도 `저장` 이라는 말은 나오지 않는다 — P2-1 의 어휘 계약", () => {
  const rows = [
    at({}),
    at({ branch: "colo-design/20260921-1" }),
    at({ pendingChanges: 2, running: true }),
    at({ handoff: pr("open"), branch: "colo-design/1" }),
    at({ handoff: pr("changes_requested"), branch: "colo-design/1" }),
    at({ handoff: pr("merged") }),
    at({ handoff: pr("closed"), branch: "colo-design/1" }),
  ];
  for (const row of rows) {
    const words = [
      row?.chip.label,
      row?.chip.title,
      row?.chip.docLabel,
      row?.next.line,
      row?.actions.submit.reason,
    ]
      .filter(Boolean)
      .join(" | ");
    assert.ok(!words.includes("저장"), `저장이 남아 있다: ${words}`);
  }
});

test("closed: 개발자의 반려는 `제출 전` 으로 위장되지 않는다", () => {
  const d = at({ handoff: pr("closed"), branch: "colo-design/20260915-1" });
  assert.equal(d?.state, "closed", "반려 행이 없으면 아래로 떨어져 제출 전이 된다");
  assert.equal(d?.chip.label, "개발자가 반려함");
  assert.equal(d?.primary, "check", "다음 수는 닫은 이유를 읽는 것이다");
  assert.ok(d?.actions.check?.enabled, "반려 이유는 상태 확인으로 읽는다");
  assert.equal(d?.actions.submit.enabled, true, "고쳐서 다시 제출하면 새 요청이 열린다");
});

test("phase error 도 칩을 그린다 — 미리보기는 죽어도 워크트리는 살아 있다", () => {
  const d = at({ phase: "error", pendingChanges: 3 });
  assert.equal(d?.state, "unsubmitted");
  assert.equal(d?.chip.label, "제출 전");
  assert.equal(d?.primary, "submit");
  assert.equal(d?.actions.submit.enabled, true, "a dead preview must not strand done work");
});

test("변경 없음: 커밋도 잔여도 PR 도 없다 — 제출은 잠기고 이유가 있다", () => {
  const d = at({});
  assert.equal(d?.state, "unsubmitted");
  assert.equal(d?.chip.label, "변경 없음");
  assert.equal(d?.chip.tone, "none");
  assert.equal(d?.primary, null);
  assert.equal(d?.actions.submit.enabled, false);
  assert.equal(d?.actions.submit.reason, "제출할 변경이 없습니다");
  assert.equal(d?.actions.check, null);
});

test("제출 전: 이번 사이클에 커밋이 쌓였다 — 자동 저장이 만드는 정상 상태", () => {
  const d = at({ branch: "colo-design/20260921-1" });
  assert.equal(d?.state, "unsubmitted");
  assert.equal(d?.chip.label, "제출 전");
  assert.equal(d?.chip.tone, "saved");
  assert.equal(d?.primary, "submit");
  assert.equal(d?.actions.submit.enabled, true);
  assert.equal(d?.actions.check, null, "PR 이 없으면 상태 확인도 없다");
});

test("커밋 전의 잔여(턴이 걸린 순간)도 제출 전으로 읽힌다 — `변경 없음` 은 거짓말이다", () => {
  const d = at({ pendingChanges: 3 });
  assert.equal(d?.chip.label, "제출 전");
  assert.equal(d?.actions.submit.enabled, true);
});

test("턴이 도는 동안의 칩은 언제나 `만드는 중` 이고 제출은 잠긴다", () => {
  const d = at({ pendingChanges: 3, running: true });
  assert.equal(d?.chip.label, "만드는 중");
  assert.equal(d?.chip.tone, "pending");
  assert.equal(d?.chip.docLabel, "만드는 중");
  assert.equal(d?.actions.submit.enabled, false);
  assert.equal(d?.actions.submit.reason, "AI가 고치는 중 — 끝나면 제출할 수 있습니다");
});

test("PR 상태가 앞선다 — 넘긴 뒤에 쌓인 것은 같은 요청에 합쳐지므로 칩은 검토 중을 지킨다", () => {
  const d = at({ branch: "colo-design/1", pendingChanges: 2, handoff: pr("open") });
  assert.equal(d?.state, "handed");
  assert.equal(d?.chip.label, "개발자 검토 중");
  assert.equal(d?.primary, "check");
  assert.ok(d?.actions.check, "넘긴 요청이 있으니 상태 확인이 그려진다");
});

test("handed: 상태 확인이 열리고, 제출은 조용한 푸시 실패의 유일한 손으로 남는다", () => {
  const d = at({ handoff: pr("open"), branch: "colo-design/1" });
  assert.equal(d?.state, "handed");
  assert.equal(d?.chip.label, "개발자 검토 중");
  assert.equal(d?.chip.title, "넘긴 요청 12번을 개발자가 검토하는 중입니다");
  assert.equal(d?.primary, "check");
  assert.ok(d?.actions.check?.enabled);
  assert.equal(
    d?.actions.submit.enabled,
    true,
    "자동 저장의 푸시는 백그라운드라 조용히 실패한다 — 밀린 커밋을 올릴 손이 하나는 있어야 한다",
  );
});

test("changes_requested: 칩의 title 이 개발자 코멘트로 이어 준다", () => {
  const d = at({ handoff: pr("changes_requested"), branch: "colo-design/1" });
  assert.equal(d?.state, "changes_requested");
  assert.equal(d?.chip.label, "변경 요청");
  assert.equal(
    d?.chip.title,
    "개발자가 넘긴 요청 12번에 코멘트를 남겼습니다 — 도구가 반영을 맡깁니다",
  );
  assert.ok(d?.actions.check?.enabled);
  // 바늘 보정: 개발자가 기획자를 기다리는 이
  // 상태에서 상태 확인이 회색이면 바의 버튼이 전부 잠긴 채 며칠이 흐른다.
  assert.equal(d?.primary, "check");
});

test("merged: 넘길 것이 없으면 반영됨 — 새 사이클이 시작되면 제출 전이 앞선다", () => {
  const merged = at({ handoff: pr("merged") });
  assert.equal(merged?.state, "merged");
  assert.equal(merged?.chip.label, "반영됨");
  assert.equal(merged?.primary, null, "기다릴 것이 없으면 강조도 없다");
  assert.equal(merged?.actions.submit.enabled, false);
  assert.equal(merged?.actions.check, null);

  // 데몬은 병합을 착지시키며 branch 를 비운다 — 다음 커밋이 새 브랜치를 연다.
  const nextCycle = at({ handoff: pr("merged"), branch: "colo-design/20260921-2" });
  assert.equal(nextCycle?.state, "merged", "사이클의 사실은 아직 merged 다");
  assert.equal(
    nextCycle?.chip.label,
    "제출 전",
    "머지 뒤에 만든 것을 반영됨이 가리면 넘길 일감이 칩에서 사라진다",
  );
  assert.equal(nextCycle?.chip.title, "이번 제출은 새 사이클을 시작합니다");
  assert.equal(nextCycle?.primary, "submit");
  assert.equal(nextCycle?.actions.submit.enabled, true);
});

test("반영됨·넘김에서 턴이 도는 동안 칩도 만드는 중을 말한다 — 행과 칩이 어긋나지 않는다", () => {
  const started = at({ handoff: pr("merged"), running: true });
  assert.equal(started?.state, "merged", "잠김은 표가 정한 그대로 — 사이클은 아직 merged");
  assert.equal(
    started?.chip.label,
    "만드는 중",
    "사이드바 행이 작업 중을 말할 때 칩이 반영됨을 말하면 두 표식이 어긋난다",
  );
  assert.equal(started?.chip.tone, "pending");
  assert.equal(started?.actions.submit.enabled, false, "도는 턴의 제출은 반쯤 고친 화면을 넘긴다");

  const redrawing = at({ handoff: pr("merged"), running: true, branch: "colo-design/20260921-2" });
  assert.equal(redrawing?.chip.label, "만드는 중");
  assert.equal(
    redrawing?.chip.title,
    "이번 제출은 새 사이클을 시작합니다",
    "말이 바뀌어도 칩이 말 못한 사이클의 사실은 title 이 전한다",
  );

  const handedTurn = at({ handoff: pr("open"), running: true });
  assert.equal(handedTurn?.chip.label, "만드는 중", "규칙은 넘김 행에도 같다");
});

test("merged 뒤 handoff 가 비면 평범한 제출 전 행이다", () => {
  const d = at({ branch: "colo-design/20260911-2", handoff: null });
  assert.equal(d?.state, "unsubmitted");
  assert.equal(d?.chip.label, "제출 전");
});
