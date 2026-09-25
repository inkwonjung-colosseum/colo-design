import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { deriveDelivery, HANDOFF_BADGE } from "../src/lib/delivery.ts";
import { FOCUS_READ_THROTTLE_MS, focusReadDue } from "../src/lib/quiet-read.ts";

const BASE = {
  pendingChanges: 0,
  branch: null,
  phase: "ready" as const,
  handoff: null,
  running: false,
};

const handoff = (state: "open" | "changes_requested" | "merged" | "closed", extra = {}) =>
  ({
    url: "https://github.com/o/r/pull/7",
    number: 7,
    state,
    reviewers: ["dev1"],
    ...extra,
  }) as const;

test("칩 문장은 요청 번호 · 저장소 이름 없이 상태만 말한다 (PLAN 단계 10)", () => {
  const open = deriveDelivery({ ...BASE, handoff: handoff("open") });
  assert.ok(open);
  assert.equal(open.chip.label, "개발자가 보고 있어요");
  // 요청 번호(7번)는 사람이 셀 필요가 없다 — 문장에 남지 않는다.
  assert.ok(!open.chip.title?.includes("7"), open.chip.title);
  assert.ok(!open.next.line.includes("7"), open.next.line);

  const closed = deriveDelivery({ ...BASE, handoff: handoff("closed") });
  assert.ok(closed);
  // 상태 확인은 없다 — 이유는 도구가 대화로 가져온다.
  assert.ok(!closed.chip.title?.includes("상태 확인"), closed.chip.title);
  assert.ok(!closed.next.line.includes("상태 확인"), closed.next.line);

  const changes = deriveDelivery({ ...BASE, handoff: handoff("changes_requested") });
  assert.ok(changes);
  assert.ok(!changes.chip.title?.includes("7"), changes.chip.title);
});

test("검토 중 세 행의 다음 수는 제출뿐이다 — 상태 확인 동작은 없다", () => {
  for (const state of ["open", "changes_requested", "closed"] as const) {
    const row = deriveDelivery({
      ...BASE,
      branch: "colo-design/20260925-1",
      handoff: handoff(state),
    });
    assert.ok(row);
    assert.equal(row.primary, "submit", state);
    assert.ok(!("check" in row.actions), state);
  }
  const quiet = deriveDelivery({ ...BASE, handoff: handoff("open") });
  assert.ok(quiet);
  assert.equal(quiet.primary, null);
});

test("사이드바 배지의 말은 제출함 — 넘김이라는 옛말은 없다", () => {
  assert.equal(HANDOFF_BADGE, "제출함");
});

test("창 포커스의 조용한 읽기는 20분 스로틀 — 시간당 세 번 이하", () => {
  assert.equal(FOCUS_READ_THROTTLE_MS, 20 * 60_000);
  const last = 1_000_000;
  assert.equal(focusReadDue(last, last + FOCUS_READ_THROTTLE_MS - 1), false);
  assert.equal(focusReadDue(last, last + FOCUS_READ_THROTTLE_MS), true);
  // 한 시간 안의 여섯 번 방문(10분마다) 중 첫 방문 포함 세 번만 읽는다 —
  // lastQuietRead 는 0(에포크)에서 시작하므로 첫 방문은 언제나 읽는다.
  let reads = 0;
  let at = -60 * 60_000;
  for (let i = 0; i < 6; i += 1) {
    const now = i * 10 * 60_000;
    if (focusReadDue(at, now)) {
      reads += 1;
      at = now;
    }
  }
  assert.equal(reads, 3);
});
