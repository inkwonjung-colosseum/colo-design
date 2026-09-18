/**
 * Codex `account/rateLimits/read` → `PlanUsage` 매핑, 오프라인 단위:
 * 창은 지속시간으로 분류되고(≤12h → fiveHour, ≤주 → sevenDay, 나머지 →
 * modelWeekly), provider 는 "codex" 로 찍힌다. app-server 없이 순수 함수만
 * 검사한다.
 *
 * Usage: node --test packages/daemon/test/codex-usage.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { toPlanUsage } = await import("../dist/agent/drivers/codex/session.js");

test("toPlanUsage stamps provider codex and classifies windows by duration", () => {
  const plan = toPlanUsage({
    rateLimits: {
      limitId: "codex",
      planType: "pro",
      primary: { usedPercent: 40, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      secondary: { usedPercent: 12, resetsAt: 1_800_100_000, windowDurationMins: 10080 },
    },
  });
  assert.equal(plan.provider, "codex");
  assert.equal(plan.subscriptionType, "pro");
  assert.equal(plan.fiveHour?.utilization, 40);
  assert.equal(plan.sevenDay?.utilization, 12);
  assert.equal(plan.modelWeekly.length, 0);
});

test("toPlanUsage lands extra metered limits in modelWeekly under their own name", () => {
  const plan = toPlanUsage({
    rateLimits: {
      limitId: "codex",
      planType: "pro",
      primary: { usedPercent: 5, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      secondary: { usedPercent: 12, resetsAt: 1_800_100_000, windowDurationMins: 10080 },
    },
    rateLimitsByLimitId: {
      codex: { limitId: "codex" }, // same id — skipped
      fable: {
        limitId: "fable",
        limitName: "Fable",
        primary: { usedPercent: 68, resetsAt: 1_800_200_000, windowDurationMins: 10080 },
      },
    },
  });
  assert.equal(plan.modelWeekly.length, 1);
  assert.equal(plan.modelWeekly[0].label, "Fable");
  assert.equal(plan.modelWeekly[0].utilization, 68);
});
test("toPlanUsage names the plan's unnamed monthly window by its period", () => {
  const plan = toPlanUsage({
    rateLimits: {
      limitId: "codex",
      planType: "free",
      primary: { usedPercent: 0, resetsAt: 1_800_000_000, windowDurationMins: 43200 },
      secondary: null,
    },
  });
  assert.equal(plan.subscriptionType, "free");
  assert.equal(plan.fiveHour, null);
  assert.equal(plan.sevenDay, null);
  assert.equal(plan.modelWeekly.length, 1);
  assert.equal(plan.modelWeekly[0].label, "이번 달");
});

test("toPlanUsage returns a null-window plan when the answer carries no limits", () => {
  const plan = toPlanUsage({});
  assert.equal(plan.provider, "codex");
  assert.equal(plan.fiveHour, null);
  assert.equal(plan.sevenDay, null);
  assert.equal(plan.modelWeekly.length, 0);
});
