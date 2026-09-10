import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStage, type StageInput } from "../src/stage.ts";

// PLAN D45 — the stepper's judgement is one pure function, and its labels are
// the table's. Every row a planner can meet lands in one of these cases.

const base: StageInput = {
  screens: [],
  pendingChanges: 0,
  branch: null,
  handoff: null,
  running: false,
  phase: "ready",
};

const at = (patch: Partial<StageInput>) => deriveStage({ ...base, ...patch });

const handedOff = (state: "open" | "changes_requested" | "merged") =>
  ({
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "회원 관리",
    state,
    branch: "cds-design/x",
  }) satisfies NonNullable<StageInput["handoff"]>;

// --- the table's five rows ---------------------------------------------------

test("화면 만들기: nothing in flight asks for a conversation", () => {
  const stage = at({});
  assert.equal(stage.step, "create");
  assert.deepEqual(stage.primary, { label: "새 대화" });
  assert.equal(stage.why, "기획서를 첨부하고 화면을 시켜 보세요.");
  // A repo that already declares screens rests here too: 저장할 것도 넘길 것도
  // 없으면 다음 행동은 화면을 시키는 것이다.
  assert.equal(
    at({ screens: [{ route: "/member/list", title: "회원 목록", states: ["default"], spec: null }] }).step,
    "create",
  );
});

test("검토·수정: unsaved changes put 저장 on the primary button", () => {
  const stage = at({ pendingChanges: 3 });
  assert.equal(stage.step, "review");
  assert.deepEqual(stage.primary, { label: "저장" });
  assert.equal(
    stage.why,
    "저장하지 않은 변경 3건 — 미리보기에서 검토하고 저장하면 이 사이클의 브랜치에 올라갑니다.",
  );
});

test("저장: a saved branch with nothing pending asks for the handoff", () => {
  const stage = at({ branch: "cds-design/x" });
  assert.equal(stage.step, "save");
  assert.deepEqual(stage.primary, { label: "개발자에게 넘기기" });
  assert.equal(stage.why, "저장한 것을 개발자가 볼 수 있게 보냅니다.");
});

test("넘기기: the developer is looking, or has asked for changes", () => {
  const open = at({ branch: "cds-design/x", handoff: handedOff("open") });
  assert.equal(open.step, "handoff");
  assert.deepEqual(open.primary, { label: "상태 다시 확인" });
  assert.equal(open.why, "개발자가 보고 있습니다");

  const changes = at({ branch: "cds-design/x", handoff: handedOff("changes_requested") });
  assert.equal(changes.step, "handoff");
  assert.deepEqual(changes.primary, { label: "상태 다시 확인" });
  assert.equal(changes.why, "변경 요청이 왔습니다 — 대화에서 이어 가세요");
});

test("반영됨: merged ends the cycle with no primary button", () => {
  const stage = at({ branch: "cds-design/x", handoff: handedOff("merged") });
  assert.equal(stage.step, "merged");
  assert.equal(stage.primary, null);
  assert.equal(stage.why, "개발자가 받아 갔습니다. 다음 저장은 새 사이클을 시작합니다.");
  // 머지가 사이클의 끝이다: 머지 뒤에 생긴 변경도 다음 사이클의 것이므로
  // 반영됨이 검토·수정을 이긴다.
  assert.equal(at({ handoff: handedOff("merged"), pendingChanges: 2 }).step, "merged");
});

// --- the boundaries ----------------------------------------------------------

test("경계: 넘긴 뒤의 새 변경은 검토·수정으로 돌아온다 — 같은 PR 에 쌓인다", () => {
  const stage = at({ branch: "cds-design/x", handoff: handedOff("open"), pendingChanges: 2 });
  assert.equal(stage.step, "review");
  assert.deepEqual(stage.primary, { label: "저장" });
  assert.equal(
    stage.why,
    "저장하지 않은 변경 2건 — 미리보기에서 검토하고 저장하면 넘긴 PR 에 계속 쌓입니다.",
  );
});

test("경계: 도는 턴은 저장 버튼을 작업 중… 으로 잠근다", () => {
  const stage = at({ pendingChanges: 2, running: true });
  assert.equal(stage.step, "review");
  assert.deepEqual(stage.primary, { label: "작업 중…", disabled: true });
  assert.equal(stage.why, "Claude 가 고치는 중 — 끝나면 변경 수가 다시 세어지고 저장할 수 있습니다.");
});

test("경계: 준비되지 않은 레포에서는 스테퍼가 말하지 않는다", () => {
  for (const phase of ["missing", "cloning", "pulling", "installing", "starting", "error", null] as const) {
    const stage = at({ phase });
    assert.equal(stage.step, null, `phase=${String(phase)}`);
    assert.equal(stage.primary, null);
    assert.equal(stage.why, null);
  }
});
