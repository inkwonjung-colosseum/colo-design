/**
 * 코멘트 저장소 (PLAN D57): the pins a planner sends from the preview land in
 * the project's own `comments.json` (`~/.colo-design/projects/<slug>/`), one
 * row per comment. 자동 정리 made delivery the row's birth: every row is
 * written resolved, because the turn carrying the words IS the delivery. The
 * store is an append-only log of what went to Claude — a second send of the
 * same words is a second request, and both stay. Old stores with
 * `resolved: false` rows read fine; nothing writes that state again.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CommentItem } from "@colo-design/protocol";

/** A row is kept only when every field the wire promises is really there. */
function isCommentItem(value: unknown): value is CommentItem {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  // PLAN D78: `element` is optional — old rows read as 자리 없는 코멘트 — but
  // a row that CARRIES one must carry it whole, or the overlay would try to
  // anchor a pin on a half identity.
  if (!elementOk(row.element)) return false;
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

function elementOk(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  const element = value as Record<string, unknown>;
  if (typeof element.component !== "string" || typeof element.path !== "string") return false;
  const rect = element.rect as Record<string, unknown> | undefined;
  return (
    typeof rect === "object" &&
    rect !== null &&
    ["x", "y", "width", "height"].every((key) => typeof rect[key] === "number")
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
 * Appends one screen·state's comment batch as delivered rows. `screen` is
 * normalized to the `[data-screen]` spelling — no leading slash (PLAN §9
 * 틀리기 쉬운 자리): the row must match what the overlay read off the DOM.
 */
export function recordComments(
  file: string,
  screen: string,
  state: string,
  items: Array<{
    text: string;
    elementText: string;
    element?: CommentItem["element"];
  }>,
  now = new Date(),
): void {
  const id = screen.startsWith("/") ? screen.slice(1) : screen;
  const at = now.toISOString();
  const written = items.map((item) => ({
    id: randomUUID(),
    screen: id,
    state,
    text: item.text,
    elementText: item.elementText,
    ...(item.element ? { element: item.element } : {}),
    at,
    resolved: true,
  }));
  writeStore(file, [...readComments(file), ...written]);
}

/**
 * The store is an append-only log, so a half-written file is lost history:
 * `readComments` cannot tell truncated JSON from an empty store and returns
 * `[]`. Write a sibling temp file and rename it over the store — same
 * directory means same filesystem, so the swap is atomic.
 */
function writeStore(file: string, rows: CommentItem[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`);
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
