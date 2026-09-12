import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Path containment that a symlink cannot talk its way past.
 *
 * Lexical prefix checks (/a/b starts with /a) fail in both directions on a
 * real machine: macOS hands out /tmp and /private/tmp for the same folder,
 * so the lexical check refuses legitimate work; and a symlink created inside
 * the workspace but pointing outside passes the check while writing somewhere
 * else entirely. Every containment decision therefore resolves both sides
 * through the filesystem first.
 */

/**
 * realpath where it exists; otherwise realpath of the deepest existing
 * ancestor with the missing tail appended — so a not-yet-created target
 * inside the root still compares inside, and one outside still doesn't.
 */
export function realpathBestEffort(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    // fall through to the ancestor walk
  }
  const parts = absolute.split(sep).filter(Boolean);
  for (let depth = parts.length; depth > 0; depth -= 1) {
    const prefix = `${sep}${parts.slice(0, depth).join(sep)}`;
    try {
      const real = realpathSync(prefix);
      const tail = parts.slice(depth);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      // that ancestor does not exist either — try one level up
    }
  }
  return absolute;
}

/**
 * True when `target` is `root` or inside it, after resolving both sides.
 * A relative target is resolved against `root` first, as callers always
 * intend it.
 */
export function containsPath(root: string, target: string): boolean {
  const realRoot = realpathBestEffort(root);
  const candidate =
    target.startsWith(sep) || /^[A-Za-z]:[\\/]/.test(target) ? target : resolve(root, target);
  const realTarget = realpathBestEffort(candidate);
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep);
}
