/**
 * PlanTracker 의 provider 스코핑, 오프라인 단위: rate-limit 이벤트는 그
 * provider 의 유휴 세션으로만 읽고, 없으면 owed 를 소비하지 않는다.
 * `COLO_DESIGN_PLAN_USAGE` 로 캐시 파일을 임시 디렉터리로 돌린다.
 *
 * Usage: node --test packages/daemon/test/plan-tracker.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "plan-tracker-"));
process.env.COLO_DESIGN_PLAN_USAGE = join(dir, "plan-usage.json");

const { PlanTracker } = await import("../dist/plan-tracker.js");

function deps({ idleSession = () => null, claudeExecutable = () => null } = {}) {
  return {
    idleSession,
    claudeExecutable,
    probeCwd: () => dir,
    signal: new AbortController().signal,
    onChanged: () => {},
  };
}

test("noteRateLimit(provider) asks only that provider's idle session", async () => {
  const asked = [];
  const tracker = new PlanTracker(
    deps({
      idleSession: (provider) => {
        asked.push(provider);
        return provider === "codex" ? { usage: async () => null } : null;
      },
    }),
  );
  tracker.noteRateLimit("codex");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, ["codex"]);
});

test("refresh(provider) with no matching idle session leaves the reading owed", async () => {
  const asked = [];
  const tracker = new PlanTracker(
    deps({
      idleSession: (provider) => {
        asked.push(provider);
        return null;
      },
    }),
  );
  tracker.refresh("codex");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, ["codex"]);
  // owed stays true — the next natural window tries again.
  assert.equal(tracker.current(), null);
});

test("rememberPlanUsage absorbs the refresh backoff so a raced read does not re-ask", async () => {
  const asked = [];
  const tracker = new PlanTracker(
    deps({
      idleSession: () => {
        asked.push("asked");
        return { usage: async () => null };
      },
    }),
  );
  tracker.rememberPlanUsage({
    provider: "claude",
    subscriptionType: "max",
    fiveHour: { utilization: 10, resetsAt: null },
    sevenDay: null,
    modelWeekly: [],
  });
  tracker.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, []);
});

test("a pre-tag cache without provider is stamped claude on load", () => {
  writeFileSync(
    process.env.COLO_DESIGN_PLAN_USAGE,
    JSON.stringify({
      subscriptionType: "max",
      fiveHour: { utilization: 7, resetsAt: null },
      sevenDay: { utilization: 90, resetsAt: null },
      modelWeekly: [],
    }),
  );
  const tracker = new PlanTracker(deps());
  assert.equal(tracker.current()?.provider, "claude");
});

test("cleanup", () => {
  rmSync(dir, { recursive: true, force: true });
});
