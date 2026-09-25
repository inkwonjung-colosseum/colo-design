import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-journey.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import { agentUpdateEvents, updateRowCopy } from "../src/next/lib/update-row.ts";
import { hasNewerVersion, plainDotted } from "../src/next/lib/version.ts";

const t = L.update;

test("hasNewerVersion: 점찍은 숫자끼리 비교한다", () => {
  assert.equal(hasNewerVersion("2.1.4", "2.2.0"), true);
  assert.equal(hasNewerVersion("2.1.4", "2.1.4"), false);
  assert.equal(hasNewerVersion("2.2.0", "2.1.4"), false);
  // 자릿수가 다른 버전 — 1.0.10 이 1.0.9 를 앞선다(글자 비교의 함정).
  assert.equal(hasNewerVersion("1.0.10", "1.0.9"), false);
  assert.equal(hasNewerVersion("0.46", "0.46.1"), true);
});

test("hasNewerVersion: 문장 속의 버전을 읽고, 못 읽으면 거짓", () => {
  assert.equal(hasNewerVersion("2.1.4 (Claude Code)", "2.2.0"), true);
  assert.equal(hasNewerVersion("codex-cli 0.46.0", "codex-cli 0.46.0"), false);
  assert.equal(hasNewerVersion(null, "2.2.0"), false);
  assert.equal(hasNewerVersion("2.1.4", null), false);
  assert.equal(hasNewerVersion("버전 없음", "2.2.0"), false);
});

test("plainDotted: 문장 속의 첫 버전만 뽑는다", () => {
  assert.equal(plainDotted("2.1.4 (Claude Code)"), "2.1.4");
  assert.equal(plainDotted("codex-cli 0.46.0"), "0.46.0");
  assert.equal(plainDotted("rust-v0.46.0"), "0.46.0");
  assert.equal(plainDotted(null), null);
  assert.equal(plainDotted("숫자가 없는 글"), null);
});

test("updateRowCopy: 새 버전이 있으면 화살표 문장과 업데이트 단추", () => {
  assert.deepEqual(updateRowCopy({ id: "claude", version: "2.1.4", latestVersion: "2.2.0" }, t), {
    state: "available",
    version: "2.1.4 → 2.2.0 있어요",
    note: null,
    action: "update",
  });
  // 문장 속 버전도 같은 잣대로 읽는다.
  assert.equal(
    updateRowCopy({ id: "claude", version: "2.1.4 (Claude Code)", latestVersion: "2.2.0" }, t)
      .state,
    "available",
  );
});

test("updateRowCopy: 같은 버전이면 최신, 확인 전에는 현재만", () => {
  assert.deepEqual(updateRowCopy({ id: "claude", version: "2.2.0", latestVersion: "2.2.0" }, t), {
    state: "latest",
    version: "2.2.0",
    note: null,
    action: "none",
  });
  assert.deepEqual(updateRowCopy({ id: "claude", version: "2.1.4", latestVersion: null }, t), {
    state: "unknown",
    version: "현재 2.1.4",
    note: null,
    action: "none",
  });
});

test("updateRowCopy: 도는 중 · 미루기는 현재 버전만 보인다", () => {
  assert.deepEqual(
    updateRowCopy({ id: "codex", version: "0.46.0", latestVersion: "0.47.0", phase: "running" }, t),
    { state: "running", version: "0.46.0", note: null, action: "none" },
  );
  assert.deepEqual(
    updateRowCopy({ id: "codex", version: "0.46.0", latestVersion: "0.47.0", phase: "pending" }, t),
    { state: "pending", version: "0.46.0", note: t.deferred, action: "none" },
  );
});

test("updateRowCopy: 끝나면 깐 버전과 시각, 실패하면 이유와 다시 시도", () => {
  assert.deepEqual(
    updateRowCopy(
      {
        id: "claude",
        version: "2.1.4",
        latestVersion: "2.2.0",
        phase: "done",
        at: "2026-09-25T11:27:00",
        versionAfter: "2.2.0",
      },
      t,
    ),
    { state: "latest", version: "2.2.0", note: "11:27에 업데이트했어요", action: "none" },
  );
  assert.deepEqual(
    updateRowCopy(
      {
        id: "claude",
        version: "2.1.4",
        latestVersion: "2.2.0",
        phase: "failed",
        detail: "내려받은 파일을 확인하지 못했어요",
      },
      t,
    ),
    {
      state: "failed",
      version: "2.1.4",
      note: "내려받은 파일을 확인하지 못했어요",
      action: "retry",
    },
  );
});

test("agentUpdateEvents: 끝난 업데이트만 한 줄씩, 이름은 프로바이더의 것, 최신이 위", () => {
  const providers = [
    { id: "claude", label: "Claude Code" },
    { id: "codex", label: "Codex" },
  ];
  const rows = agentUpdateEvents(
    {
      claude: { phase: "done", at: "2026-09-25T02:27:00Z", version: "2.2.0 (Claude Code)" },
      codex: { phase: "running", at: "2026-09-25T02:30:00Z" },
    },
    providers,
    L.update.doneEvent,
  );
  assert.deepEqual(
    rows.map((row) => row.text),
    ["Claude Code 를 2.2.0 으로 업데이트했어요"],
  );
  // 버전을 모르는 끝 · 없는 표는 줄이 없다.
  assert.deepEqual(
    agentUpdateEvents({ codex: { phase: "done", at: "x" } }, providers, L.update.doneEvent),
    [],
  );
  assert.deepEqual(agentUpdateEvents(undefined, providers, L.update.doneEvent), []);
  const two = agentUpdateEvents(
    {
      claude: { phase: "done", at: "2026-09-25T01:00:00Z", version: "2.2.0" },
      codex: { phase: "done", at: "2026-09-25T03:00:00Z", version: "0.47.0" },
    },
    providers,
    L.update.doneEvent,
  );
  assert.deepEqual(
    two.map((row) => row.id),
    ["codex", "claude"],
  );
});
