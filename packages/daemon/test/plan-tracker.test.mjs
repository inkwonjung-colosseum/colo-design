/**
 * PlanTracker 의 provider 스코핑, 오프라인 단위: 읽기는 provider 별로
 * 쌓이고, rate-limit 이벤트는 그 provider 의 유휴 세션으로만 읽으며, 없으면
 * owed 를 소비하지 않는다. `COLO_DESIGN_PLAN_USAGE` 로 캐시 파일을 임시
 * 디렉터리로 돌린다.
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

const claudePlan = (utilization = 10) => ({
  provider: "claude",
  subscriptionType: "max",
  fiveHour: { utilization, resetsAt: null },
  sevenDay: null,
  modelWeekly: [],
});

const codexPlan = {
  provider: "codex",
  subscriptionType: "free",
  fiveHour: null,
  sevenDay: null,
  modelWeekly: [{ label: "이번 달", utilization: 0, resetsAt: null }],
};

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
  assert.equal(tracker.currentAll(["codex"]).codex, undefined);
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
  tracker.rememberPlanUsage(claudePlan());
  tracker.refresh("claude");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, []);
});

test("readings land per provider — codex's account never clobbers claude's", () => {
  const tracker = new PlanTracker(deps());
  tracker.rememberPlanUsage(claudePlan(42));
  tracker.rememberPlanUsage(codexPlan);
  const all = tracker.currentAll(["claude", "codex"]);
  assert.equal(all.claude.fiveHour.utilization, 42);
  assert.equal(all.codex.modelWeekly[0].label, "이번 달");
});

test("a provider with no reading yet is owed one — the first idle session answers", async () => {
  const asked = [];
  const tracker = new PlanTracker(
    deps({
      idleSession: (provider) => {
        asked.push(provider);
        return provider === "codex" ? { usage: async () => codexPlan } : null;
      },
    }),
  );
  tracker.currentAll(["claude", "codex"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, ["claude", "codex"]);
  assert.equal(tracker.currentAll(["codex"]).codex.provider, "codex");
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
  assert.equal(tracker.currentAll(["claude"]).claude.provider, "claude");
});

test("a modelWeekly-only reading survives the cache — codex free has no weekly window", () => {
  writeFileSync(process.env.COLO_DESIGN_PLAN_USAGE, JSON.stringify({ codex: codexPlan }));
  const tracker = new PlanTracker(deps());
  assert.equal(tracker.currentAll(["codex"]).codex.modelWeekly[0].label, "이번 달");
});

test("cleanup", () => {
  rmSync(dir, { recursive: true, force: true });
});
