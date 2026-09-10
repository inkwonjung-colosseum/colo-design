/**
 * The ~/.cds-design home migration (PLAN D1) — offline unit checks.
 *
 * One machine, one move: an early installation's `~/cds-design` becomes
 * `~/.cds-design` on the first start after the rename. Everything here runs
 * against a throwaway home directory, so the real home is never touched.
 *
 * Run: node --test packages/daemon/test/home-dir.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateHomeDir } from "../dist/environment.js";

function scratchHome() {
  return mkdtempSync(join(tmpdir(), "cds-design-home-"));
}

test("an old folder alone moves onto the dot-prefixed name", () => {
  const home = scratchHome();
  try {
    mkdirSync(join(home, "cds-design", "config"), { recursive: true });
    writeFileSync(join(home, "cds-design", "config", "projects.json"), "{}");

    const warning = migrateHomeDir(home);

    assert.equal(warning, null);
    assert.ok(existsSync(join(home, ".cds-design", "config", "projects.json")));
    assert.ok(!existsSync(join(home, "cds-design")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a fresh home has nothing to move", () => {
  const home = scratchHome();
  try {
    assert.equal(migrateHomeDir(home), null);
    assert.ok(!existsSync(join(home, ".cds-design")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("both folders present means no choice is made — a warning names each", () => {
  const home = scratchHome();
  try {
    mkdirSync(join(home, "cds-design"), { recursive: true });
    mkdirSync(join(home, ".cds-design"), { recursive: true });

    const warning = migrateHomeDir(home);

    assert.ok(typeof warning === "string" && warning.includes("cds-design"));
    assert.ok(existsSync(join(home, "cds-design")));
    assert.ok(existsSync(join(home, ".cds-design")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a symlinked old folder moves as the link; its target is untouched", () => {
  const home = scratchHome();
  try {
    const target = join(home, "elsewhere", "cds-data");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "marker"), "x");
    symlinkSync(target, join(home, "cds-design"), "dir");

    const warning = migrateHomeDir(home);

    assert.equal(warning, null);
    assert.ok(existsSync(join(home, ".cds-design")));
    assert.ok(existsSync(join(target, "marker")), "the data behind the link must not move");
  } finally {
    rmSync(join(home, "elsewhere"), { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
