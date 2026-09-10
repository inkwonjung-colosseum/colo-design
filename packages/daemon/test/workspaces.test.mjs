/**
 * The session write policy as a contract, offline.
 *
 * What separates "silent" from "asked" is not a setting: it is what the repo
 * clone contains, decided before any model turn happens, so it is checkable
 * without one.
 *
 * Run: node --test packages/daemon/test/workspaces.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathBestEffort } from "../dist/paths.js";
import { repoWritePolicy } from "../dist/workspaces.js";

/** A realpath'd clone root, as the daemon hands it over. */
function repoRoot() {
  const dir = mkdtempSync(join(tmpdir(), "cds-design-workspaces-"));
  const root = join(dir, "repo");
  mkdirSync(join(root, "src", "screens"), { recursive: true });
  return { dir, root: realpathBestEffort(root) };
}

test("a session writes the clone silently", () => {
  const { dir, root } = repoRoot();
  try {
    const policy = repoWritePolicy(root);

    assert.equal(policy(join(root, "src", "screens", "MemberList.tsx")), "allow");
    assert.equal(policy(join(root, "src", "screens", "member", "Order.tsx")), "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a write anywhere outside the clone surfaces as a card", () => {
  const { dir, root } = repoRoot();
  try {
    const policy = repoWritePolicy(root);

    assert.equal(
      policy(join(dir, "elsewhere", "notes.md")),
      "ask",
      "only the clone is the session's own working set",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a path that only looks like a root prefix is not inside it", () => {
  const { dir, root } = repoRoot();
  try {
    const policy = repoWritePolicy(root);
    assert.equal(policy(`${root}-elsewhere/x.tsx`), "ask");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
