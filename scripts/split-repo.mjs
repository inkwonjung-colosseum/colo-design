// Phase 4: split packages/daemon/src/repo.ts into RepoCore + domain modules.
// Idempotent-safe is NOT required — run once against the pre-split file.
import { readFileSync, writeFileSync } from "node:fs";

const SRC_PATH = "packages/daemon/src/repo.ts";
const src = readFileSync(SRC_PATH, "utf8");
const lines = src.split("\n");

// ---------------------------------------------------------------------------
// 1. Slice the file into header / class body / tail
// ---------------------------------------------------------------------------
const classLine = lines.findIndex((l) => l.startsWith("export class RepoWorkspace"));
const classEnd = lines.findIndex((l, i) => i > classLine && l === "}");
const header = lines.slice(0, classLine);
const bodyLines = lines.slice(classLine + 1, classEnd); // between { and }
const tail = lines.slice(classEnd + 1);

// ---------------------------------------------------------------------------
// 2. Split the class body into members (signature line + attached comments)
// ---------------------------------------------------------------------------
const sigRe =
  /^ {2}(?:(?:private|public|protected|readonly|static|async|get|set|abstract|override)\s+)*[A-Za-z_$][\w$]*[!?]?\s*[(:=;]/;
const commentRe = /^\s*(\/\/|\/\*|\*)/;
const blankRe = /^\s*$/;
const separatorRe = /^\s*\/\/\s*-{5,}\s*$/;

// signature line indices (0-based inside bodyLines)
const sigIdx = [];
for (let i = 0; i < bodyLines.length; i++) {
  if (sigRe.test(bodyLines[i])) sigIdx.push(i);
}

// For each signature, walk up to collect its attached comment block.
function commentStart(s) {
  let top = s;
  for (let i = s - 1; i >= 0; i--) {
    if (commentRe.test(bodyLines[i]) || blankRe.test(bodyLines[i])) top = i;
    else break;
  }
  // drop leading blanks inside the walked region — they belong to the gap
  while (top < s && blankRe.test(bodyLines[top])) top++;
  return top;
}

const members = [];
for (let k = 0; k < sigIdx.length; k++) {
  const s = sigIdx[k];
  const c = commentStart(s);
  const nextC = k + 1 < sigIdx.length ? commentStart(sigIdx[k + 1]) : bodyLines.length;
  let e = nextC - 1;
  while (e > s && (blankRe.test(bodyLines[e]) || separatorRe.test(bodyLines[e]))) e--;
  const text = bodyLines
    .slice(c, e + 1)
    .join("\n")
    .replace(/\n+$/g, "");
  // member name: first identifier after modifiers on the signature line
  const name = bodyLines[s]
    .trim()
    .replace(
      /^(?:(?:private|public|protected|readonly|static|async|get|set|abstract|override)\s+)+/,
      "",
    )
    .match(/^[A-Za-z_$][\w$]*/)[0];
  members.push({ name, text });
}

const memberNames = new Set(members.map((m) => m.name));

// ---------------------------------------------------------------------------
// 3. Destination map
// ---------------------------------------------------------------------------
const DEST = {
  checkpoints: new Set([
    "checkpoint",
    "pruneCheckpoints",
    "clearCheckpoints",
    "checkpointRefs",
    "checkpoints",
    "checkpointRestore",
  ]),
  shelf: new Set(["shelve", "unshelve", "shelfConflictBrief"]),
  summary: new Set([
    "summarize",
    "handoffDraft",
    "claudeHandoffDraft",
    "summaryCwd",
    "oneTurn",
    "claudeSummary",
    "claudeMemo",
    "summaryCache",
    "handoffDraftCache",
  ]),
  publish: new Set([
    "runSave",
    "ensureCycleBranch",
    "runHandoff",
    "attachShots",
    "refreshHandoff",
    "peekHandoff",
    "landHandoffIfDue",
    "landCycle",
    "withReviews",
    "replyToReview",
    "failGate",
    "commitApproved",
    "endedHandoff",
    "lastReviews",
  ]),
  bringup: new Set([
    "bootstrap",
    "clearBringUpDebris",
    "installUpToDate",
    "installIfNeeded",
    "dependencyHash",
    "dependenciesMoved",
    "runCommand",
    "requirePnpmIfReferenced",
    "startPreview",
    "spawnOptions",
    "waitReady",
    "isServing",
    "killPreview",
    "killPortHolder",
    "bringUpErrorKind",
  ]),
  // facade members are hand-written in repo.ts — these are extracted then
  // dropped from core so the script's core set is exact.
  facade: new Set([
    "update",
    "stop",
    "settle",
    "pull",
    "sync",
    "save",
    "handoff",
    "restore",
    "discard",
    "handoffLandingDue",
    "busyRefreshing",
    "pendingChangeCount",
  ]),
};

const destOf = (name) => {
  for (const [dest, set] of Object.entries(DEST)) if (set.has(name)) return dest;
  return "core";
};

// ---------------------------------------------------------------------------
// 4. Per-file emission
// ---------------------------------------------------------------------------
// Members each module keeps public (facade / cross-module entry points).
const MODULE_PUBLIC = {
  checkpoints: new Set(["checkpoint", "checkpoints", "checkpointRestore", "clearCheckpoints"]),
  shelf: new Set(["shelve", "unshelve"]),
  summary: new Set(["summarize", "handoffDraft", "claudeMemo"]),
  publish: new Set([
    "runSave",
    "runHandoff",
    "ensureCycleBranch",
    "refreshHandoff",
    "peekHandoff",
    "landHandoffIfDue",
    "replyToReview",
  ]),
  bringup: new Set(["bootstrap", "killPreview", "installUpToDate", "dependenciesMoved"]),
};

// Cross-module calls inside publish that route through deps.
const PUBLISH_DEPS = new Set(["claudeMemo", "clearCheckpoints"]);

const stripPrivate = (text) =>
  text.replace(/^ {2}private readonly /gm, "  readonly ").replace(/^ {2}private /gm, "  ");

const rewriteThis = (text, own, deps = new Set()) =>
  text.replace(/this\.([A-Za-z_$][\w$]*)/g, (all, name) => {
    if (name === "core" || name === "deps") return all;
    if (own.has(name)) return all;
    if (deps.has(name)) return `this.deps.${name}`;
    return `this.core.${name}`;
  });

const emitMember = (m, dest) => {
  let t = m.text;
  if (dest === "core") return stripPrivate(t);
  const own = DEST[dest];
  t = rewriteThis(t, own, dest === "publish" ? PUBLISH_DEPS : new Set());
  if (MODULE_PUBLIC[dest]?.has(m.name)) t = stripPrivate(t);
  return t;
};

const buckets = {
  core: [],
  checkpoints: [],
  shelf: [],
  summary: [],
  publish: [],
  bringup: [],
  facade: [],
};
for (const m of members) {
  const d = destOf(m.name);
  buckets[d].push(emitMember(m, d));
}
for (const d of Object.keys(buckets)) {
  if (d === "facade") continue;
  console.log(`${d}: ${buckets[d].length} members`);
}

// ---------------------------------------------------------------------------
// 5. Imports — original import table, filtered by usage in emitted text
// ---------------------------------------------------------------------------
const IMPORTS = [
  { from: "node:child_process", names: { ChildProcess: 1, SpawnOptions: 1, spawn: 0 } },
  { from: "node:crypto", names: { createHash: 0, randomUUID: 0 } },
  {
    from: "node:fs",
    names: {
      existsSync: 0,
      mkdirSync: 0,
      readFileSync: 0,
      rmdirSync: 0,
      rmSync: 0,
      writeFileSync: 0,
    },
  },
  { from: "node:path", names: { dirname: 0, join: 0 } },
  { from: "node:timers/promises", names: { sleep: 0 } },
  { from: "@anthropic-ai/claude-agent-sdk", names: { query: 0 } },
  {
    from: "@colo-design/protocol",
    names: {
      DeveloperReview: 1,
      DiffFile: 1,
      DiffStatus: 1,
      HandoffShot: 1,
      HandoffStatus: 1,
      HandoffStatusReport: 1,
      RepoCheckpoint: 1,
      RepoCheckpointRestore: 1,
      RepoCheckpoints: 1,
      RepoDiscard: 1,
      RepoErrorKind: 1,
      RepoHandoffDraft: 1,
      RepoHistory: 1,
      RepoPhase: 1,
      RepoShelf: 1,
      RepoShelfRestore: 1,
      RepoStatus: 1,
      RepoSummary: 1,
      markTurn: 0,
    },
  },
  { from: "./comments.js", names: { readComments: 0 } },
  { from: "./credentials.js", names: { mergeNpmrc: 0, npmrcPath: 0 } },
  {
    from: "./environment.js",
    names: {
      currentPlatform: 0,
      detectsRegistryAuthFailure: 0,
      resolveGitExecutable: 0,
      resolvePnpmExecutable: 0,
    },
  },
  { from: "./github.js", names: { GitHubClient: 1, parseRepoSlug: 0 } },
  {
    from: "./preview-claim.js",
    names: {
      clearPreviewClaim: 0,
      foreignLivePreviewClaim: 0,
      killTree: 0,
      portAccepts: 0,
      portListenerPids: 0,
      portRefused: 0,
      respondsOk: 0,
      writePreviewClaim: 0,
    },
  },
  { from: "./claude-trust.js", names: { extraPathPrefix: 0, trustWorkspace: 0 } },
  { from: "./handoff-body.js", names: { buildCommentsSection: 0 } },
  {
    from: "./repo-diff.js",
    names: { fallbackSummary: 0, parseUnifiedDiff: 0, untrackedAsAdded: 0 },
  },
  { from: "./repo-paths.js", names: { restorePlan: 0, safeRepoPath: 0 } },
  {
    from: "./repo-config.js",
    names: {
      RepoConfig: 1,
      RepoRegistry: 1,
      readDeclaredPreviewPort: 0,
      resolveRepoConfig: 0,
      scopeOf: 0,
    },
  },
  {
    from: "./repo-prompts.js",
    names: {
      HANDOFF_BODY_MAX_CHARS: 0,
      HANDOFF_FILE_LIMIT: 0,
      HANDOFF_TITLE_MAX_CHARS: 0,
      handoffPrompt: 0,
      MEMO_MAX_CHARS: 0,
      memoPrompt: 0,
      renderSummaryFile: 0,
      SUMMARY_MAX_LINES: 0,
      summaryPrompt: 0,
    },
  },
];

function importsFor(text) {
  const out = [];
  for (const { from, names } of IMPORTS) {
    const used = Object.keys(names).filter((n) => new RegExp(`\\b${n}\\b`).test(text));
    if (used.length === 0) continue;
    const allType = used.every((n) => names[n]);
    if (allType) {
      out.push(`import type { ${used.join(", ")} } from "${from}";`);
    } else {
      out.push(
        `import { ${used.map((n) => (names[n] ? `type ${n}` : n)).join(", ")} } from "${from}";`,
      );
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 6. Constants + top-level helpers → repo-core.ts (all exported internally)
// ---------------------------------------------------------------------------
// const region sits between the import block and the class; the doc comment
// lines 99-107 describe the class — keep them out of the const block.
const constStart = header.findIndex((l) => l.startsWith("const INSTALL_MARKER"));
const constBlock = header
  .slice(constStart)
  .join("\n")
  .replace(/^const /gm, "export const ")
  .replace(/^export const PUSH_AUTH_FAILURE/, "export const PUSH_AUTH_FAILURE") // already export
  .replace(/^const export/, "export const");
// header already has `export const PUSH_AUTH_FAILURE` / `export const REPO_URL_MISSING_DETAIL`
// and `export function assertClonableRepoUrl` — the replace above is a no-op for them.

// tail helpers: GIT_MISSING_DETAIL, detailOf, dependencyHash(fn), error classes
const tailText = tail
  .join("\n")
  .replace(/^const GIT_MISSING_DETAIL/m, "export const GIT_MISSING_DETAIL")
  .replace(/^function detailOf/m, "export function detailOf")
  .replace(/^class BootstrapPrepareError/m, "export class BootstrapPrepareError")
  .replace(/^class PreviewPortBusyError/m, "export class PreviewPortBusyError")
  .replace(/^class PreviewHeldElsewhereError/m, "export class PreviewHeldElsewhereError");

// Top-level `function dependencyHash(root)` — the method wraps it; move the fn
// beside the method in bringup. detailOf stays in core (facade+publish use it).
const depHashFnMatch = tailText.match(/function dependencyHash\(root: string\)[\s\S]*?\n\}/);
const depHashFn = depHashFnMatch ? depHashFnMatch[0] : "";
const coreTail = tailText
  .replace(depHashFn, "")
  .replace(/export class BootstrapPrepareError[\s\S]*?\n\}/, "")
  .replace(/export class PreviewPortBusyError[\s\S]*?\n\}/, "")
  .replace(/export class PreviewHeldElsewhereError[\s\S]*?\n\}/, "");

// Everything repo-core.ts exports that a sibling module may need — consts,
// helpers, error classes. `redact` stays unexported (core-internal).
const CORE_EXPORTS = [
  "INSTALL_MARKER",
  "READY_TIMEOUT_MS",
  "DETAIL_THROTTLE_MS",
  "DEFAULT_COMMIT_MESSAGE",
  "DEFAULT_HANDOFF_TITLE",
  "SHOTS_DIR",
  "SHOTS_COMMIT_MESSAGE",
  "BRANCH_PREFIX",
  "GATE_OUTPUT_TAIL_LINES",
  "COMMAND_STALL_MS",
  "CHECKPOINT_REF_PREFIX",
  "CHECKPOINTS_PER_SESSION",
  "SHELF_REF",
  "SHELF_COMMIT_MESSAGE",
  "SUMMARY_TIMEOUT_MS",
  "MACHINE_MODEL",
  "MEMO_TIMEOUT_MS",
  "HANDOFF_DRAFT_TIMEOUT_MS",
  "GATE_BRIEF",
  "BOOTSTRAP_FAILED_DETAIL",
  "PUSH_AUTH_FAILURE",
  "GATE_STEP",
  "STASH_MESSAGE",
  "REFRESH_CONFLICT_DETAIL",
  "RECOVER_CONFLICT_DETAIL",
  "SHELF_ALREADY_DETAIL",
  "SHELF_EMPTY_DETAIL",
  "SHELF_DIRTY_DETAIL",
  "SHELF_NONE_DETAIL",
  "SHELF_CONFLICT_OPEN_DETAIL",
  "SHELF_CONFLICT_DETAIL",
  "SAVE_CONFLICT_OPEN_DETAIL",
  "COMMANDS_UNAPPROVED_DETAIL",
  "REFRESH_DIVERGED_DETAIL",
  "PNPM_MISSING_DETAIL",
  "REGISTRY_AUTH_DETAIL",
  "REPO_URL_MISSING_DETAIL",
  "CLONABLE_SCHEMES",
  "CLONE_URL_REFUSED_DETAIL",
  "GIT_MISSING_DETAIL",
  "detailOf",
  "assertClonableRepoUrl",
  "BootstrapPrepareError",
  "PreviewPortBusyError",
  "PreviewHeldElsewhereError",
];

const coreImportsFor = (text) => {
  const used = CORE_EXPORTS.filter((n) => new RegExp(`\\b${n}\\b`).test(text));
  return used.length === 0 ? "" : `import {\n  ${used.join(",\n  ")},\n} from "./repo-core.js";\n`;
};

// ---------------------------------------------------------------------------
// 7. repo-core.ts
// ---------------------------------------------------------------------------
const coreBody = buckets.core.join("\n\n");
const coreText = `// Shared state and plumbing behind RepoWorkspace — the clone's status,
// git capture, emit machinery and the conflict/refresh vocabulary every
// domain module speaks. Package-internal: only repo.ts and the repo-*.ts
// modules import this.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
__IMPORTS__
${constBlock}

/** Options the facade hands straight through — see RepoWorkspace. */
export interface RepoWorkspaceOptions {
  /** Absolute path of the clone. */
  root: string;
  /** Remote url; the owning project decided it, this class never reads it back. */
  url: string | null;
  onStatus: (status: RepoStatus) => void;
  /** Publish progress; optional because not every host shows it. */
  onDiffStatus?: (status: DiffStatus) => void;
  /** The machine-wide GitHub token — see \`loadRepoPat\` in credentials. */
  pat?: string | null;
  /** Defaults to "main"; a project that forks elsewhere says so. */
  baseBranch?: string;
  /** Persistence hook for a moved url — see onUrlChange in update(). */
  onUrlChange?: (url: string | null) => void;
  /** Cycle state restored from the project registry, if any. */
  cycle?: { branch: string | null; handoff: HandoffStatus | null };
  /** Where the cycle is written back; the registry is the only store. */
  onCycleChange?: (cycle: { branch: string | null; handoff: HandoffStatus | null }) => void;
  /** Built per call so a PAT changed mid-run reaches the next request. */
  gitHubClient?: () => GitHubClient | null;
  /** Claude Code CLI executable for the summarizer's one turn (D51). */
  claudeExecutable?: string | null;
  /** D94: 연결 준비 — sync 가 설정 없음에서 막히면 Claude 가 계약을 쓴다. */
  bootstrap?: boolean;
  /** The preparation turn: brief → Claude writes the contract → validate. */
  prepareBootstrap?: () => Promise<boolean>;
  /**
   * Whether the planner said this repo's commands may run here. Absent
   * (a direct construction, a pre-gate project) reads as approved — the
   * gate is for repos nobody has vouched for yet.
   */
  commandsApproved?: boolean;
  /**
   * Whether this workspace's project is the one on screen. Only the active
   * project may take its preview port: a switch away abandons an in-flight
   * bring-up instead of letting it finish late and SIGKILL the listener the
   * NEXT project just started (or outlive the daemon on another port).
   */
  active?: boolean;
}

export class RepoCore {
${coreBody}
}

${coreTail}
`;
// fix the self-import placeholder — not needed
const coreFinal = coreText
  .replace('import type { RepoCore as _Self } from "./repo-core.js";\n', "")
  .replace("__IMPORTS__", importsFor(coreBody + constBlock + coreTail));
writeFileSync("packages/daemon/src/repo-core.ts", coreFinal);

// ---------------------------------------------------------------------------
// 8. Module files
// ---------------------------------------------------------------------------
const writeModule = (file, cls, comment, bucket, extra = "", extraScan = "") => {
  const body = buckets[bucket].join("\n\n");
  const imports = importsFor(body + extra + extraScan);
  const coreImports = coreImportsFor(body + extra + extraScan);
  const text = `${comment}\n${imports}\nimport {\n  type RepoCore,\n} from "./repo-core.js";\n${coreImports}\nexport class ${cls} {\n  constructor(private readonly core: RepoCore) {}\n\n${body}\n}\n${extra}`;
  writeFileSync(`packages/daemon/src/${file}`, text);
};

writeModule(
  "repo-checkpoints.ts",
  "CheckpointStore",
  `// PLAN D52 checkpoints: snapshot refs under refs/colo-design/checkpoints,
// kept out of the worktree so a snapshot can never dirty the diff it saves.`,
  "checkpoints",
);

writeModule(
  "repo-shelf.ts",
  "ShelfStore",
  `// 잠깐 치워두기: one parked-work ref per clone, written and popped through
// the same conflict vocabulary the refresh path uses.`,
  "shelf",
);

writeModule(
  "repo-summary.ts",
  "RepoSummarizer",
  `// The summary and 넘기기-draft voices (PLAN D51): one Claude turn on the
// same SDK the sessions ride, cached against the diff it answered for.`,
  "summary",
);

const publishExtra = `
/** Cross-module services the cycle needs — wired by the facade. */
export interface PublishDeps {
  /** The save-time memo the PR body quotes — the summarizer's one turn. */
  claudeMemo(files: DiffFile[]): Promise<string | null>;
  /** A merged cycle's snapshots are history, not exits. */
  clearCheckpoints(): Promise<void>;
}
`;
{
  const body = buckets.publish.join("\n\n");
  const imports = importsFor(body + publishExtra);
  const coreImports = coreImportsFor(body + publishExtra);
  const text = `// 저장 → 개발자에게 넘기기 → 반영됨: the publish cycle (PLAN D5[넘기기]).
// Owns the in-flight cycle's handoff bookkeeping and the review replies.
${imports}
import type { RepoCore } from "./repo-core.js";
${coreImports}
export class PublishCycle {
  constructor(
    private readonly core: RepoCore,
    private readonly deps: PublishDeps,
  ) {}

  /** 내려앉을 사이클의 끝이 밀려 있는가 — 폴링이 같은 알림을 반복하지 않게. */
  get landingDue(): boolean {
    return this.endedHandoff !== null;
  }

${body}
}
${publishExtra}`;
  writeFileSync("packages/daemon/src/repo-publish.ts", text);
}

{
  const body = buckets.bringup.join("\n\n");
  const all = body + depHashFn;
  const imports = importsFor(all);
  const coreImports = coreImportsFor(all);
  const text = `// Bring-up: clone → config → install → preview. Owns the preview
// process itself (startPreview/killPreview) and the port fence around it,
// plus the install short-circuit and the bring-up error taxonomy.
${imports}
import type { RepoCore } from "./repo-core.js";
${coreImports}
export class BringUp {
  constructor(private readonly core: RepoCore) {}

${body}
}

${depHashFn}
`;
  writeFileSync("packages/daemon/src/repo-bringup.ts", text);
}

console.log("done — core/module files written; repo.ts facade still pending");
