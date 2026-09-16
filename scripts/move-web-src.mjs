/**
 * Phase 1 — web/src flat → grouped directories.
 *
 * Moves each file with `git mv` (rename survives in the index), then rewrites
 * every relative specifier in src/ and test/ whose target moved. Resolution
 * works on the OLD logical tree (reconstructed via the inverse move map), so
 * re-running after a partial apply stays correct — already-moved files are
 * found at their new path but their specifiers still resolve against where
 * everything used to live.
 *
 * Dry run by default; --apply performs the moves and rewrites.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve("packages/web/src");
const TEST = resolve("packages/web/test");
const APPLY = process.argv.includes("--apply");

/** old path (rel. to src/) → new path (rel. to src/). Unlisted files stay. */
const MOVES = {
  // components/chat — conversation column and its chrome
  "ChatColumn.tsx": "components/chat/ChatColumn.tsx",
  "Composer.tsx": "components/chat/Composer.tsx",
  "ContextRing.tsx": "components/chat/ContextRing.tsx",
  "SelectorChip.tsx": "components/chat/SelectorChip.tsx",
  "UsageChip.tsx": "components/chat/UsageChip.tsx",
  // components/preview — the live preview and its controls
  "PreviewHost.tsx": "components/preview/PreviewHost.tsx",
  "IframeHost.tsx": "components/preview/IframeHost.tsx",
  "NativeHost.tsx": "components/preview/NativeHost.tsx",
  "PinTray.tsx": "components/preview/PinTray.tsx",
  "TurnClock.tsx": "components/preview/TurnClock.tsx",
  // components/panels — right-side and overlay panels
  "ScreenPanel.tsx": "components/panels/ScreenPanel.tsx",
  "DiffPanel.tsx": "components/panels/DiffPanel.tsx",
  "HandoffPanel.tsx": "components/panels/HandoffPanel.tsx",
  // components/dialogs — modal surfaces
  "SettingsDialog.tsx": "components/dialogs/SettingsDialog.tsx",
  "ConfirmDialog.tsx": "components/dialogs/ConfirmDialog.tsx",
  "AddProjectDialog.tsx": "components/dialogs/AddProjectDialog.tsx",
  "ShortcutsSheet.tsx": "components/dialogs/ShortcutsSheet.tsx",
  // components/onboarding — first-run and repo attach
  "Onboarding.tsx": "components/onboarding/Onboarding.tsx",
  "GitHubTokenForm.tsx": "components/onboarding/GitHubTokenForm.tsx",
  "RepoPicker.tsx": "components/onboarding/RepoPicker.tsx",
  "RepoProgress.tsx": "components/onboarding/RepoProgress.tsx",
  // components/shell — the app frame
  "Shell.tsx": "components/shell/Shell.tsx",
  "PageWorkspace.tsx": "components/shell/PageWorkspace.tsx",
  "Sidebar.tsx": "components/shell/Sidebar.tsx",
  "HistoryDrawer.tsx": "components/shell/HistoryDrawer.tsx",
  "Palette.tsx": "components/shell/Palette.tsx",
  "Splitter.tsx": "components/shell/Splitter.tsx",
  "Tip.tsx": "components/shell/Tip.tsx",
  // components/ root — shared primitives
  "Markdown.tsx": "components/Markdown.tsx",
  "icons.tsx": "components/icons.tsx",
  // hooks/
  "use-modal-focus.ts": "hooks/use-modal-focus.ts",
  "use-preview-cover.ts": "hooks/use-preview-cover.ts",
  "usePins.ts": "hooks/usePins.ts",
  "useSessions.ts": "hooks/useSessions.ts",
  // lib/ — non-component modules
  "chat-options.ts": "lib/chat-options.ts",
  "cover-reconciler.ts": "lib/cover-reconciler.ts",
  "daemon-client.ts": "lib/daemon-client.ts",
  "delivery.ts": "lib/delivery.ts",
  "error-words.ts": "lib/error-words.ts",
  "format.ts": "lib/format.ts",
  "handoff-draft.ts": "lib/handoff-draft.ts",
  "ime.ts": "lib/ime.ts",
  "labels.ts": "lib/labels.ts",
  "preview-address.ts": "lib/preview-address.ts",
  "preview-turns.ts": "lib/preview-turns.ts",
  "progress.ts": "lib/progress.ts",
  "repo-guidance.ts": "lib/repo-guidance.ts",
  "session-activity.ts": "lib/session-activity.ts",
  "settings.ts": "lib/settings.ts",
  "suggestions.ts": "lib/suggestions.ts",
  "tape-visibility.ts": "lib/tape-visibility.ts",
  "transcript-export.ts": "lib/transcript-export.ts",
  "turn-numbering.ts": "lib/turn-numbering.ts",
};

// new path (rel. to src/) → old path — for files that already moved.
const INV = Object.fromEntries(Object.entries(MOVES).map(([o, n]) => [n, o]));

function collect(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [...collect(SRC), ...collect(TEST)];

// oldLoc(abs current file) → its path rel. to src/ in the OLD tree (or null
// for test files, whose specifiers reach in via ../src/).
function oldLocOf(file) {
  const rel = relative(SRC, file);
  if (rel.startsWith("..")) return null;
  return INV[rel] ?? rel;
}

// The old tree's file set: every current src file mapped back, so specifier
// resolution never depends on whether the target has physically moved yet.
const OLD_SET = new Set(files.map(oldLocOf).filter(Boolean));

function resolveSpecOld(fromFileAbs, spec) {
  const oldRel = oldLocOf(fromFileAbs);
  let baseOld;
  if (oldRel) {
    // importer lives under src/ — spec is relative to its OLD location
    baseOld = join(dirname(oldRel), spec);
  } else {
    // importer is a test file — spec like ../src/x.ts lands in old src coords
    const abs = resolve(dirname(fromFileAbs), spec);
    if (!abs.startsWith(SRC + "/")) return null;
    baseOld = relative(SRC, abs);
  }
  for (const ext of ["", ".ts", ".tsx", ".mts", ".d.ts"]) {
    const cand = `${baseOld}${ext}`;
    if (OLD_SET.has(cand)) return cand;
  }
  return null;
}

const edits = [];
const SPEC_RE = /(from\s+["']|import\s+["'])(\.\.?\/[^"']+)(["'])/g;

for (const file of files) {
  const oldRel = oldLocOf(file);
  const newFileRel = oldRel && MOVES[oldRel] ? MOVES[oldRel] : oldRel;
  const text = readFileSync(file, "utf8");
  let changed = false;
  const next = text.replace(SPEC_RE, (m, pre, spec, post) => {
    const targetOld = resolveSpecOld(file, spec);
    if (!targetOld || !MOVES[targetOld]) return m;
    const targetNewAbs = join(SRC, MOVES[targetOld]);
    const fromAbs = oldRel ? join(SRC, dirname(newFileRel)) : dirname(file);
    let rel = relative(fromAbs, targetNewAbs).replaceAll("\\", "/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    const hadExt = /\.(ts|tsx|mts)$/.test(spec);
    const final = hadExt ? rel : rel.replace(/\.(tsx?|mts)$/, "");
    if (final === spec) return m;
    changed = true;
    return `${pre}${final}${post}`;
  });
  if (changed) edits.push({ file, next });
}

console.log(`moves: ${Object.keys(MOVES).length}, files to rewrite: ${edits.length}`);
for (const e of edits) console.log(`  rewrite ${relative(resolve("."), e.file)}`);

if (APPLY) {
  for (const [oldRel, newRel] of Object.entries(MOVES)) {
    const from = join(SRC, oldRel);
    const to = join(SRC, newRel);
    if (!existsSync(from) && existsSync(to)) continue; // already moved
    execSync(`mkdir -p ${JSON.stringify(dirname(to))}`);
    // git mv keeps the rename in the index; untracked files (new, uncommitted)
    // fall back to a plain mv — git detects the rename at commit time anyway.
    try {
      execSync(`git mv ${JSON.stringify(from)} ${JSON.stringify(to)}`, { stdio: "pipe" });
    } catch {
      execSync(`mv ${JSON.stringify(from)} ${JSON.stringify(to)}`);
    }
  }
  // Writes land at the file's POST-move path: a file collected at its old
  // location (not yet moved when collect ran) has been moved by the loop above.
  for (const e of edits) {
    const oldRel = oldLocOf(e.file);
    const dest = oldRel && MOVES[oldRel] ? join(SRC, MOVES[oldRel]) : e.file;
    writeFileSync(dest, e.next);
  }
  console.log("applied.");
}
