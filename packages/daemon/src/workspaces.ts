/**
 * The one write policy every session runs under: edits inside the project's
 * repo clone are silent (acceptEdits semantics, moved in-process), and a
 * write anywhere else surfaces as a permission card the planner answers.
 */

import { containsPath } from "./paths.js";
import type { WritePolicy } from "./session.js";

/**
 * Both sides must already be realpath-resolved, as must the path the policy
 * is asked about; `Session` does that before calling.
 */
export function repoWritePolicy(repoRoot: string): WritePolicy {
  return (path) => (containsPath(repoRoot, path) ? "allow" : "ask");
}
