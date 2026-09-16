/**
 * Driver contract: every registered provider answers the same invariants —
 * a well-formed descriptor, a store that exists iff the driver claims one,
 * and capabilities that agree with the methods the driver actually carries.
 * Runs offline; no CLI is spawned.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpDriver } from "../dist/agent/drivers/acp/driver.js";
import { OPENCODE_ACP } from "../dist/agent/drivers/acp/opencode.js";
import { ClaudeDriver } from "../dist/agent/drivers/claude/driver.js";
import { CodexDriver } from "../dist/agent/drivers/codex/driver.js";
import { OmpDriver } from "../dist/agent/drivers/omp/omp.js";

const TIERS = new Set(["safe", "moderate", "planning", "dangerous"]);

const drivers = [
  new ClaudeDriver(() => null),
  new CodexDriver(),
  new AcpDriver(OPENCODE_ACP),
  new OmpDriver(),
];

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

test("capabilities.rewind agrees with store.rewind", () => {
  for (const driver of drivers) {
    const caps = driver.describe().capabilities;
    assert.equal(
      caps.rewind,
      Boolean(driver.store?.rewind),
      `${driver.id}: rewind capability must match store.rewind`,
    );
  }
});

test("a store that exists answers list; rewind implies promptCount", () => {
  for (const driver of drivers) {
    if (!driver.store) continue;
    assert.equal(typeof driver.store.list, "function", `${driver.id}: store.list`);
    if (driver.store.rewind) {
      // A truncating fork needs the prompt count to renumber turns after a
      // restart — a store that can cut but cannot count is half a rewind.
      assert.equal(
        typeof driver.store.promptCount,
        "function",
        `${driver.id}: rewind without promptCount`,
      );
    }
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
