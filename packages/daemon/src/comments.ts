/**
 * 코멘트 저장소 (PLAN D57): the pins a planner sends from the preview land in
 * the project's own `comments.json` (`~/.cds-design/projects/<slug>/`), one
 * row per comment. The turn ends and the pins disappear; the rows stay — and
 * a resolved row stays too, as history. A re-send of one screen·state
 * replaces that pair's UNRESOLVED rows only: the overlay sends what is still
 * pinned, so writing it verbatim twice must never double a comment.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CommentItem } from "@cds-design/protocol";

/** A row is kept only when every field the wire promises is really there. */
function isCommentItem(value: unknown): value is CommentItem {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.screen === "string" &&
    typeof row.state === "string" &&
    typeof row.text === "string" &&
    typeof row.elementText === "string" &&
    typeof row.at === "string" &&
    typeof row.resolved === "boolean"
  );
}

/** Reads the store, tolerating anything a hand edit could do to it. */
export function readComments(file: string): CommentItem[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCommentItem);
  } catch {
    return [];
  }
}

/**
 * Writes one screen·state's comment set: that pair's unresolved rows go, the
 * new rows (and every other row — resolved ones included) stay. Returns how
 * many rows it wrote.
 */
export function recordComments(
  file: string,
  screen: string,
  state: string,
  items: Array<{ text: string; elementText: string }>,
  now = new Date(),
): number {
  const kept = readComments(file).filter(
    (row) => row.resolved || row.screen !== screen || row.state !== state,
  );
  const at = now.toISOString();
  const written = items.map((item) => ({
    id: randomUUID(),
    screen,
    state,
    text: item.text,
    elementText: item.elementText,
    at,
    resolved: false,
  }));
  writeStore(file, [...kept, ...written]);
  return written.length;
}

/** Marks one row resolved or not; false when the id names nothing. */
export function resolveComment(file: string, id: string, resolved: boolean): boolean {
  const rows = readComments(file);
  const row = rows.find((entry) => entry.id === id);
  if (!row) return false;
  row.resolved = resolved;
  writeStore(file, rows);
  return true;
}

function writeStore(file: string, rows: CommentItem[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
}
