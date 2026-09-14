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
    // 재설계 C10: `intent` is optional — absent reads as change — but a row
    // that CARRIES one must carry a real one, or the PR body would title a
    // question by a word that means nothing.
    (row.intent === undefined || row.intent === "change" || row.intent === "question") &&
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
 * Appends delivered rows — one per pin, whichever screen it sat on. `screen`
 * is normalized to the `[data-screen]` spelling — no leading slash (PLAN §9
 * 틀리기 쉬운 자리): the row must match what the overlay read off the DOM.
 */
export function recordComments(
  file: string,
  items: Array<{
    /** The pin's overlay UUID (커미티 2차 판정 5) — kept when carried, minted when not. */
    id?: string;
    screen: string;
    state: string;
    text: string;
    elementText: string;
    intent?: CommentItem["intent"];
    element?: CommentItem["element"];
  }>,
  now = new Date(),
): void {
  const at = now.toISOString();
  const written = items.map((item) => ({
    // The pin's own key when the send carried one — the row joins back to the
    // tray, badge and card (커미티 2차 판정 5); older senders keep a minted id.
    id: item.id ?? randomUUID(),
    screen: item.screen.startsWith("/") ? item.screen.slice(1) : item.screen,
    state: item.state,
    text: item.text,
    elementText: item.elementText,
    ...(item.intent ? { intent: item.intent } : {}),
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
