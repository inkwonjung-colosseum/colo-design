/**
 * Wire protocol between the daemon (runs on the planner's own machine,
 * drives their own Claude Code login) and the planner UI.
 *
 * Messages that mean "the repo" mean THE ACTIVE PROJECT's — one connected
 * repo. No message names a directory: the daemon resolves every path from
 * the project registry itself, which also means a client can never point a
 * session at an arbitrary folder. `project.activate` is what moves that
 * target.
 *
 * The sidebar (PLAN D16) is the one exception: `project.changed` carries
 * per-project `phase · pendingChanges · working · handoff`, so an INACTIVE
 * project's row can badge itself without the planner switching to it.
 *
 * Client -> daemon messages are validated with zod because they arrive over a
 * socket. Daemon -> client messages are produced by us, so they are plain types.
 */

export * from "./messages.js";
export * from "./preview.js";
export * from "./project.js";
export * from "./repo.js";
export * from "./repo-guidance.js";
export * from "./session.js";
export * from "./shared.js";
export * from "./shortcuts.js";
export * from "./tool-names.js";
export * from "./turn-marker.js";
export * from "./update.js";
