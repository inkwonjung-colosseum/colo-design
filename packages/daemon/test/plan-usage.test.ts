/**
 * 사용량 칸의 읽기 (2026-09-28) — 칩이 창을 모두 세우도록 바꾼 자리의 시험.
 * 세 축을 누른다: 두 드라이버의 답 → 창 분류(Codex 의 무료 · 유료 · 모델별
 * 한도, Claude 의 모델별 주간), 대화 없이 Codex 계정을 읽는 probe(가짜
 * app-server 로), 쉬는 대화가 없을 때 그 AI 의 probe 로 읽는 추적기.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// 컴파일된 dist 를 읽는다 — `@nova-design/protocol` 의 import 가 얽혀 있다.
import { toPlanUsage as claudePlan } from "../dist/agent/drivers/claude/session.js";
import { toPlanUsage as codexPlan, probeCodexUsage } from "../dist/agent/drivers/codex/session.js";
import { PlanTracker } from "../dist/plan-tracker.js";

/** 2026-09-28 실측의 무료 요금제 답 — 30일 창 하나. */
const FREE = {
  limitId: "codex",
  limitName: null,
  primary: { usedPercent: 1, windowDurationMins: 43200, resetsAt: 1792275214 },
  secondary: null,
  planType: "free",
};

const window = (usedPercent: number, windowDurationMins: number) => ({
  usedPercent,
  windowDurationMins,
  resetsAt: 1790000000,
});

test("Codex 무료 요금제 — 이름 없는 한 달 창 하나(이번 달)", () => {
  const plan = codexPlan({ rateLimits: FREE, rateLimitsByLimitId: { codex: FREE } });
  assert.equal(plan.subscriptionType, "free");
  assert.equal(plan.fiveHour, null);
  assert.equal(plan.sevenDay, null);
  assert.deepEqual(plan.modelWeekly, [
    {
      utilization: 1,
      resetsAt: "2026-10-17T22:13:34.000Z",
      label: "이번 달",
      name: null,
      period: "month",
    },
  ]);
});

test("Codex 유료 요금제 — 5시간 · 주간 칸, 모델별 한도는 5시간과 주간이 두 줄", () => {
  const main = {
    limitId: "codex",
    limitName: null,
    primary: window(12, 300),
    secondary: window(5, 10080),
    planType: "plus",
  };
  const spark = {
    limitId: "codex_bengalfox",
    limitName: "GPT-5.3-Codex-Spark",
    primary: window(30, 300),
    secondary: window(9, 10080),
  };
  const plan = codexPlan({
    rateLimits: main,
    // 요금제 자신의 답이 id 맵에도 한 번 더 온다 — 두 번 세지 않는다.
    rateLimitsByLimitId: { codex: main, codex_bengalfox: spark },
  });
  assert.equal(plan.subscriptionType, "plus");
  assert.equal(plan.fiveHour?.utilization, 12);
  assert.equal(plan.sevenDay?.utilization, 5);
  assert.deepEqual(
    plan.modelWeekly.map((row) => [row.label, row.name, row.period, row.utilization]),
    [
      ["GPT-5.3-Codex-Spark 5시간", "GPT-5.3-Codex-Spark", "fiveHour", 30],
      ["GPT-5.3-Codex-Spark 주간", "GPT-5.3-Codex-Spark", "week", 9],
    ],
  );
});

test("Codex — 모델별 한도의 창은 요금제 자신의 빈 칸을 채우지 않는다", () => {
  const plan = codexPlan({
    rateLimits: FREE,
    rateLimitsByLimitId: {
      codex: FREE,
      // 이름 없는 한도는 제 id 로 선다 — 이름이 없다고 줄이 사라지지 않는다.
      extra_pool: { limitId: "extra_pool", limitName: null, primary: window(40, 300) },
    },
  });
  assert.equal(plan.fiveHour, null);
  assert.deepEqual(
    plan.modelWeekly.map((row) => [row.label, row.name, row.period]),
    [
      ["이번 달", null, "month"],
      ["extra_pool 5시간", "extra_pool", "fiveHour"],
    ],
  );
});

test("Codex — 세 기간 밖의 창은 기간 없이, 이름에 날 수를 적는다", () => {
  const plan = codexPlan({
    rateLimits: { limitId: "codex", primary: window(3, 3 * 1440), secondary: null },
  });
  assert.deepEqual(
    plan.modelWeekly.map((row) => [row.label, row.period]),
    [["3일", null]],
  );
});

test("Claude — 5시간 · 주간 · 모델별 주간(Fable)은 이름과 기간을 함께 싣는다", () => {
  assert.equal(
    claudePlan({ rate_limits_available: false, rate_limits: null, subscription_type: null }),
    null,
  );
  const plan = claudePlan({
    rate_limits_available: true,
    subscription_type: "team",
    rate_limits: {
      five_hour: { utilization: 44, resets_at: "2026-09-28T09:00:00+00:00" },
      seven_day: { utilization: 11, resets_at: "2026-10-02T18:00:00+00:00" },
      model_scoped: [
        { display_name: "Fable", utilization: 11, resets_at: "2026-10-02T18:00:00+00:00" },
      ],
    },
  });
  assert.equal(plan?.provider, "claude");
  assert.equal(plan?.fiveHour?.utilization, 44);
  assert.equal(plan?.sevenDay?.utilization, 11);
  assert.deepEqual(plan?.modelWeekly, [
    {
      label: "Fable 주간",
      name: "Fable",
      period: "week",
      utilization: 11,
      resetsAt: "2026-10-02T18:00:00+00:00",
    },
  ]);
});

/** 줄마다 JSON-RPC 로 답하는 가짜 `codex app-server` — 한도 읽기에 `answer` 를 돌려준다. */
function fakeAppServer(dir: string, answer: unknown | "hang"): string {
  const path = join(dir, "codex");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const answer = ${JSON.stringify(answer)};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") reply(message.id, {});
  else if (message.method === "account/rateLimits/read" && answer !== "hang") reply(message.id, answer);
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`,
    { mode: 0o755 },
  );
  return path;
}

test("probeCodexUsage — 스레드 없이 핸드셰이크 뒤 한도를 읽는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-probe-"));
  try {
    const executable = fakeAppServer(dir, { rateLimits: FREE });
    const plan = await probeCodexUsage({ executable, cwd: dir });
    assert.equal(plan?.provider, "codex");
    assert.equal(plan?.modelWeekly[0]?.period, "month");
    assert.equal(await probeCodexUsage({ executable: null, cwd: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeCodexUsage — 답하지 않는 CLI 는 데몬의 종료 신호에 끊기고 읽기 없음", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-probe-"));
  try {
    const executable = fakeAppServer(dir, "hang");
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 200);
    assert.equal(await probeCodexUsage({ executable, cwd: dir, signal: stop.signal }), null);
    assert.ok(Date.now() - started < 5_000, "종료 신호가 probe 를 기다리게 두지 않는다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PlanTracker — 쉬는 대화가 없으면 그 AI 의 probe 로, 있으면 그 대화로 읽는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-tracker-"));
  const before = process.env.NOVA_DESIGN_PLAN_USAGE;
  process.env.NOVA_DESIGN_PLAN_USAGE = join(dir, "plan-usage.json");
  try {
    const asked: string[] = [];
    const reading = (provider: string) => ({
      provider,
      subscriptionType: null,
      fiveHour: { utilization: 10, resetsAt: null },
      sevenDay: null,
      modelWeekly: [],
    });
    let changed = 0;
    const idle = new Map<string, { usage: () => Promise<unknown> }>();
    const tracker = new PlanTracker({
      idleSession: (provider: string) => idle.get(provider) ?? null,
      usageProbes: [
        {
          provider: "codex",
          read: async () => {
            asked.push("probe:codex");
            return reading("codex");
          },
        },
      ],
      probeCwd: () => dir,
      signal: new AbortController().signal,
      onChanged: () => {
        changed += 1;
      },
      catalogSources: [],
    });
    // 읽기가 없는 AI 는 하나씩 빚진다 — codex 는 probe 가, omp 는 읽을 길이 없어 묻지 않는다.
    tracker.currentAll(["codex", "omp"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(asked, ["probe:codex"]);
    assert.equal(changed, 1);
    assert.equal(tracker.currentAll(["codex"]).codex?.fiveHour?.utilization, 10);
    // 쉬는 대화가 있으면 probe 를 띄우지 않고 그 대화가 답한다(간격의 하한은 새 AI 라 없다).
    idle.set("claude", {
      usage: async () => {
        asked.push("session:claude");
        return reading("claude");
      },
    });
    tracker.refresh("claude");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(asked, ["probe:codex", "session:claude"]);
    // 2분 안의 다시 읽기는 모인다 — 칸을 여닫을 때마다 CLI 를 띄우지 않는다.
    tracker.refresh("codex");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(asked, ["probe:codex", "session:claude"]);
  } finally {
    if (before === undefined) delete process.env.NOVA_DESIGN_PLAN_USAGE;
    else process.env.NOVA_DESIGN_PLAN_USAGE = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
