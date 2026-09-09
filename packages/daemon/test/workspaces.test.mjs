/**
 * The two workspaces as contracts, offline.
 *
 * 기획 runs in the Confluence mirror and 디자인 in the repo clone, and what
 * separates them is not a tab: it is what each one may write, and what the
 * planning half is told the folder is. Both are decided before any model
 * turn happens, so both are checkable without one.
 *
 * Run: node --test packages/daemon/test/workspaces.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathBestEffort } from "../dist/paths.js";
import { MIRROR_STATE_FILE, planningRules, writePolicyFor } from "../dist/workspaces.js";
import { parseDrafthouseConfig } from "../dist/repo.js";

/** Two realpath'd roots that are siblings, as the daemon hands them over. */
function roots() {
  const dir = mkdtempSync(join(tmpdir(), "drafthouse-workspaces-"));
  const repoRoot = join(dir, "repo");
  const mirrorRoot = join(dir, "confluence");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(join(mirrorRoot, "ENG"), { recursive: true });
  writeFileSync(join(mirrorRoot, "ENG", MIRROR_STATE_FILE), "{}");
  return {
    dir,
    repoRoot: realpathBestEffort(repoRoot),
    mirrorRoot: realpathBestEffort(mirrorRoot),
  };
}

// ---------------------------------------------------------------------------
// write policy
// ---------------------------------------------------------------------------

test("a planning session writes pages silently and is refused the sync state", () => {
  const { dir, repoRoot, mirrorRoot } = roots();
  try {
    const policy = writePolicyFor("planning", { repoRoot, mirrorRoot });

    assert.equal(policy(join(mirrorRoot, "ENG", "회원 관리 기획서.md")), "allow");
    assert.equal(policy(join(mirrorRoot, "ENG", "attachments", "101", "구성도.png")), "allow");
    assert.equal(
      policy(join(mirrorRoot, "ENG", MIRROR_STATE_FILE)),
      "deny",
      "rewriting the sync state would silently break the optimistic lock",
    );
    assert.equal(
      policy(join(repoRoot, "src", "screens", "MemberList.tsx")),
      "ask",
      "the 기획 half does not write screens without the planner seeing it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a design session writes the clone silently and never the mirror", () => {
  const { dir, repoRoot, mirrorRoot } = roots();
  try {
    const policy = writePolicyFor("design", { repoRoot, mirrorRoot });

    assert.equal(policy(join(repoRoot, "src", "screens", "MemberList.tsx")), "allow");
    assert.equal(
      policy(join(mirrorRoot, "ENG", "회원 관리 기획서.md")),
      "ask",
      "the mirror is mounted read-only for 디자인 — a write is a card, not a silent edit",
    );
    assert.equal(policy(join(mirrorRoot, "ENG", MIRROR_STATE_FILE)), "ask");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a path that only looks like a root prefix is not inside it", () => {
  const { dir, repoRoot, mirrorRoot } = roots();
  try {
    const policy = writePolicyFor("design", { repoRoot, mirrorRoot });
    assert.equal(policy(`${repoRoot}-elsewhere/x.tsx`), "ask");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// planning instructions
// ---------------------------------------------------------------------------

test("the planning rules name the frontmatter fields a session must not touch", () => {
  const rules = planningRules(null);
  for (const needle of ["pageId", "version", MIRROR_STATE_FILE, "confluence", "new-"]) {
    assert.ok(rules.includes(needle), `planning rules mention ${needle}`);
  }
});

test("the planning rules forbid answering in mirror paths (PLAN D9)", () => {
  // A planner knows a 기획서 by its Confluence title. Every path in an answer
  // is a string they cannot search for, click, or correct — and the tool now
  // renders the paths it sends as cards, so an answer that quotes one back is
  // the only place they would still meet one.
  const rules = planningRules(null);
  assert.match(rules, /파일 경로를 쓰지 않는다/);
  assert.match(rules, /페이지 제목으로만 문서를 안다/);
  // The card markers are ours; a session that echoes them would render a
  // second card out of Claude's own answer.
  assert.ok(rules.includes("drafthouse:"), "the rules name the marker to ignore");
});

test("the repo's own 기획 rules ride below the tool's invariants", () => {
  const withRepo = planningRules("모든 기획서는 '배경' 절로 시작한다.");
  const invariantsEnd = withRepo.indexOf("게시는 기획자가 누른다");
  const repoRules = withRepo.indexOf("모든 기획서는 '배경' 절로 시작한다.");

  assert.ok(repoRules > invariantsEnd, "repo rules come after the tool's own");
  assert.match(withRepo, /위 불변식과 충돌하면 위가 이긴다/);
  assert.equal(
    planningRules("   "),
    planningRules(null),
    "blank repo rules add no section at all",
  );
});

test("drafthouse.json carries planning.rules, and rejects a malformed one in Korean", () => {
  const base = { preview: { command: "pnpm dev", port: 5274 } };

  assert.equal(parseDrafthouseConfig(JSON.stringify(base)).planning, undefined);
  assert.equal(
    parseDrafthouseConfig(JSON.stringify({ ...base, planning: { rules: "배경 절로 시작" } })).planning
      ?.rules,
    "배경 절로 시작",
  );
  assert.throws(
    () => parseDrafthouseConfig(JSON.stringify({ ...base, planning: { rules: "" } })),
    /planning\.rules/,
  );
  assert.throws(
    () => parseDrafthouseConfig(JSON.stringify({ ...base, planning: "배경 절로 시작" })),
    /planning/,
  );
});
