#!/usr/bin/env node
// Split packages/protocol/src/index.ts into domain modules; index.ts becomes
// a re-export facade so `dist/index.js` consumers keep the same surface.
// Slices are 1-based inclusive line ranges verified by anchors before writing.

import { readFileSync, writeFileSync } from "node:fs";

const SRC = "packages/protocol/src/index.ts";
const lines = readFileSync(SRC, "utf8").split("\n");
// split("\n") leaves a trailing "" after the final newline; drop it so ranges
// line up with the numbered view.
if (lines.at(-1) === "") lines.pop();

const anchors = [
  [3, "/**"],
  [21, "export const PROTOCOL_VERSION = 15;"],
  [27, "export const permissionModeSchema = z.enum(["],
  [49, "// Client -> daemon"],
  [52, "const withId = { id: z.string().min(1) };"],
  [54, 'export const clientMessageSchema = z.discriminatedUnion("type", ['],
  [631, "]);"],
  [633, "// ---------------------------------------------------------------------------"],
  [634, "// 코멘트 저장소 (PLAN D57)"],
  [686, "}"],
  [688, "export type ClientMessage = z.infer<typeof clientMessageSchema>;"],
  [690, "// ---------------------------------------------------------------------------"],
  [691, "// Normalized chat events (daemon translates SDKMessage into these)"],
  [909, '  | { kind: "preview.opened"; route: string; state: string | null };'],
  [915, "/**"],
  [972, "}"],
  [974, "export interface SessionSummary {"],
  [996, "}"],
  [998, "/**"],
  [1066, "}"],
  [1068, "/** One claude.ai plan-limit window, as the usage endpoint reports it. */"],
  [1163, "}"],
  [1165, "// ---------------------------------------------------------------------------"],
  [1166, "// Connected repo workspace"],
  [1305, "}"],
  [1307, "// ---------------------------------------------------------------------------"],
  [1308, "// Preview envelopes (PLAN D64–D69) — two contracts live here."],
  [1435, "}"],
  [1437, "/**"],
  [1462, "}"],
  [1464, "/** `session.rewind` — the forked (or fresh) conversation to carry on in. */"],
  [1469, "}"],
  [1471, "/**"],
  [1516, "}"],
  [1518, "// ---------------------------------------------------------------------------"],
  [1519, "// Onboarding (DESIGN §8)"],
  [1588, "}"],
  [1590, "// ---------------------------------------------------------------------------"],
  [1591, "// Publish path (diff review → gates → commit → push)"],
  [1719, "}"],
  [1721, "export interface PermissionSuggestion {"],
  [1784, "    };"],
  [1786, "// ---------------------------------------------------------------------------"],
  [1787, "// Helpers"],
  [1816, "}"],
  [1817, 'export * from "./shortcuts.js";'],
];
for (const [n, want] of anchors) {
  const got = lines[n - 1];
  if (got !== want) {
    console.error(
      `anchor mismatch line ${n}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`,
    );
    process.exit(1);
  }
}

const slice = (a, b) => lines.slice(a - 1, b).join("\n");

const files = {
  "shared.ts": [
    'import { z } from "zod";',
    "",
    "/** Wire enums both message directions share. */",
    slice(21, 21),
    "",
    "// ---------------------------------------------------------------------------",
    "// Shared enums",
    "// ---------------------------------------------------------------------------",
    "",
    slice(27, 46),
  ].join("\n"),

  "messages.ts": [
    'import { z } from "zod";',
    'import type { DaemonStatus, ProjectSummary } from "./project.js";',
    'import type { DiffStatus, RepoStatus } from "./repo.js";',
    'import type { ChatEvent } from "./session.js";',
    'import { effortLevelSchema, permissionModeSchema, type SessionState } from "./shared.js";',
    "",
    slice(48, 631),
    "",
    slice(688, 688),
    "",
    "// ---------------------------------------------------------------------------",
    "// Daemon -> client",
    "// ---------------------------------------------------------------------------",
    "",
    slice(1721, 1784),
    "",
    slice(1786, 1816),
  ].join("\n"),

  "session.ts": [
    'import type { EffortLevel, PermissionMode, SessionState } from "./shared.js";',
    "",
    slice(690, 909),
    "",
    "// ---------------------------------------------------------------------------",
    "// Session summaries and replies",
    "// ---------------------------------------------------------------------------",
    "",
    slice(974, 996),
    "",
    slice(1464, 1469),
    "",
    "// ---------------------------------------------------------------------------",
    "// Plan, context, model and command surfaces",
    "// ---------------------------------------------------------------------------",
    "",
    slice(1068, 1163),
  ].join("\n"),

  "repo.ts": [
    slice(633, 686),
    "",
    slice(1165, 1305),
    "",
    slice(1437, 1462),
    "",
    slice(1590, 1719),
  ].join("\n"),

  "preview.ts": [slice(1307, 1435), "", slice(1471, 1516)].join("\n"),

  "project.ts": [
    'import type { HandoffStatus, RepoPhase } from "./repo.js";',
    'import type { PlanUsage, SessionModelInfo } from "./session.js";',
    "",
    "// ---------------------------------------------------------------------------",
    "// Daemon -> client",
    "// ---------------------------------------------------------------------------",
    "",
    slice(915, 972),
    "",
    slice(998, 1066),
    "",
    slice(1518, 1588),
  ].join("\n"),

  "index.ts": [
    "/**",
    " * Wire protocol between the daemon (runs on the planner's own machine,",
    " * drives their own Claude Code login) and the planner UI.",
    " *",
    ' * Messages that mean "the repo" mean THE ACTIVE PROJECT\'s — one connected',
    " * repo. No message names a directory: the daemon resolves every path from",
    " * the project registry itself, which also means a client can never point a",
    " * session at an arbitrary folder. `project.activate` is what moves that",
    " * target.",
    " *",
    " * The sidebar (PLAN D16) is the one exception: `project.changed` carries",
    " * per-project `phase · pendingChanges · working · handoff`, so an INACTIVE",
    " * project's row can badge itself without the planner switching to it.",
    " *",
    " * Client -> daemon messages are validated with zod because they arrive over a",
    " * socket. Daemon -> client messages are produced by us, so they are plain types.",
    " */",
    'export * from "./shared.js";',
    'export * from "./messages.js";',
    'export * from "./session.js";',
    'export * from "./repo.js";',
    'export * from "./project.js";',
    'export * from "./preview.js";',
    'export * from "./shortcuts.js";',
    'export * from "./tool-names.js";',
    'export * from "./turn-marker.js";',
    'export * from "./update.js";',
  ].join("\n"),
};

for (const [name, body] of Object.entries(files)) {
  writeFileSync(`packages/protocol/src/${name}`, body.endsWith("\n") ? body : body + "\n");
  console.log(`wrote packages/protocol/src/${name} (${body.split("\n").length} lines)`);
}
