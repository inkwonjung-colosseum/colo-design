/**
 * Driver contract: every registered provider answers the same invariants —
 * a well-formed descriptor, a store that exists iff the driver claims one,
 * and capabilities that agree with the methods the driver actually carries.
 * Runs offline; no CLI is spawned.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeDriver } from "../dist/agent/drivers/claude/driver.js";
import { CodexDriver } from "../dist/agent/drivers/codex/driver.js";
import { OmpDriver } from "../dist/agent/drivers/omp/driver.js";

const TIERS = new Set(["safe", "moderate", "planning", "dangerous"]);

const drivers = [new ClaudeDriver(() => null), new CodexDriver(), new OmpDriver()];

test("every driver describes a well-formed descriptor", () => {
  for (const driver of drivers) {
    const d = driver.describe();
    assert.equal(d.id, driver.id, `${driver.id}: descriptor id must match`);
    assert.ok(d.label.length > 0, `${driver.id}: label`);
    for (const mode of d.modes) {
      assert.ok(mode.id.length > 0, `${driver.id}: mode id`);
      assert.ok(mode.label.length > 0, `${driver.id}: mode label`);
      assert.ok(TIERS.has(mode.tier), `${driver.id}: mode ${mode.id} tier`);
    }
    assert.ok(
      d.defaultModeId === "" || d.modes.some((m) => m.id === d.defaultModeId),
      `${driver.id}: defaultModeId "${d.defaultModeId}" is not a declared mode`,
    );
  }
});

test("capabilities.branch agrees with store.branchCut", () => {
  for (const driver of drivers) {
    const caps = driver.describe().capabilities;
    assert.equal(
      caps.branch,
      Boolean(driver.store?.branchCut),
      `${driver.id}: branch capability must match store.branchCut`,
    );
  }
});

test("planMode names a declared planning mode or is null", () => {
  for (const driver of drivers) {
    const d = driver.describe();
    const planMode = d.capabilities.planMode;
    if (planMode === null) continue;
    const row = d.modes.find((m) => m.id === planMode);
    assert.ok(row, `${driver.id}: planMode "${planMode}" is not a declared mode`);
    assert.equal(row.tier, "planning", `${driver.id}: planMode must be the planning-tier mode`);
  }
});

test("listModels exists exactly where a session-less catalog does", () => {
  // omp (`omp models --json`) can answer without a thread; Claude and Codex
  // cannot — their cache waits for the first live session's report.
  const withCatalog = ["omp"];
  for (const driver of drivers) {
    assert.equal(
      typeof driver.listModels === "function",
      withCatalog.includes(driver.id),
      `${driver.id}: listModels presence must match its session-less catalog`,
    );
  }
});

test("every provider declares browser tool injectability", () => {
  // The in-app browser is a flagship feature: each driver must consciously
  // own its injection path (claude·codex mcpServers record/table fields, omp
  // the `set_host_tools` wire). A new provider flipping this false hides
  for (const driver of drivers) {
    assert.equal(
      driver.describe().capabilities.browserTools,
      true,
      `${driver.id}: browserTools must be declared`,
    );
  }
});

test("ompModelRows maps both catalog shapes into picker rows", async () => {
  const { ompModelRows } = await import("../dist/agent/drivers/omp/catalog.js");
  const rows = ompModelRows([
    // The live RPC's `get_available_models` hands back whole Model objects.
    {
      provider: "zai",
      id: "glm-5.3-flash",
      name: "GLM 5.3 Flash",
      reasoning: true,
      thinking: { efforts: ["low", "high"] },
    },
    // `omp models --json` trims it: `thinking` IS the effort list, and the
    // list may name levels the composer has no word for.
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      thinking: ["minimal", "low", "high", "xhigh"],
    },
    { provider: "", id: "bare-id", name: "Bare" },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].value, "zai/glm-5.3-flash");
  assert.equal(rows[0].displayName, "GLM 5.3 Flash");
  assert.equal(rows[0].resolvedModel, "glm-5.3-flash");
  assert.equal(rows[0].supportsEffort, true);
  assert.deepEqual(rows[0].supportedEffortLevels, ["low", "high"]);
  // zai has no service-tier family — `/fast` refuses it, so the row says so
  // before the toggle is pressed.
  assert.equal(rows[0].supportsFastMode, false);
  // The trimmed shape reads the same, minus the levels the wire cannot carry.
  assert.deepEqual(rows[1].supportedEffortLevels, ["low", "high", "xhigh"]);
  assert.equal(rows[1].supportsFastMode, true, "anthropic is a service-tier family");
  // A provider-less row keeps the bare id — no phantom "undefined/" prefix.
  assert.equal(rows[2].value, "bare-id");
  assert.equal(rows[2].supportsEffort, false);
  assert.equal(rows[2].supportedEffortLevels, null);
});

test("실사용 데몬은 Claude · Codex 만 올리고, 개발용 에이전트는 devAgents 뒤에서만", async () => {
  const { registerAgentDrivers } = await import("../dist/server.js");
  const { DriverRegistry } = await import("../dist/agent/registry.js");
  const ids = (devAgents) => {
    const registry = new DriverRegistry();
    registerAgentDrivers(registry, { claudeExecutable: () => null, devAgents });
    return registry.all().map((driver) => driver.id);
  };
  // 패키징된 앱 · 변수 없는 CLI — 실사용자가 받는 목록. omp 는 없다.
  assert.deepEqual(ids(false), ["claude", "codex"]);
  // 개발 실행 — 같은 순서 뒤에 omp 가 붙는다(등록 순서 = 고르개 순서).
  assert.deepEqual(ids(true), ["claude", "codex", "omp"]);
});
