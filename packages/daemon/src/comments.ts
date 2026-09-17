/**
 * 코멘트 저장소 (PLAN D57): the pins a planner sends from the preview land in
 * the project's own `comments.json` (`~/.colo-design/projects/<slug>/`), one
 * row per comment. 자동 정리 made delivery the row's birth: every row is
 * written resolved, because the turn carrying the words IS the delivery. The
 * store is an append-only log of what went to the agent — a second send of the
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
    // 표식 없는 페이지의 핀은 state 가 null 이다 — 합성값으로 되살리지 않는다.
    (row.state === null || typeof row.state === "string") &&
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
 * is normalized to the `[data-screen]` spelling — no leading slash
 * (틀리기 쉬운 자리): the row must match what the overlay read off the DOM.
 */
export function recordComments(
  file: string,
  items: Array<{
    /** The pin's overlay UUID (커미티 2차 판정 5) — kept when carried, minted when not. */
    id?: string;
    screen: string;
    /** 표식 없는 페이지의 핀은 null — 합성값으로 되살리지 않는다. */
    state: string | null;
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
 * 넘기기 캡처의 대상 (브리지 폐지): 이 사이클에 사람이 핀으로 가리킨
 * 화면·상태 쌍. 선언된 화면 목록은 없다 — "보낸 화면"의 유일한 원천은
 * 사용자가 실제로 짚은 곳이다. `sinceIso` 는 사이클 앵커(`RepoCore.cycleAnchor`)
 * — buildCommentsSection 과 같은 판정으로 이 사이클의 행만 고르고, 철자도
 * 같다(`/${screen}`, 슬래시 없는 행의 screen 에 슬래시를 얹는다). 같은 곳을
 * 여러 핀이 가리켰으면 한 장만 담는다. 순서는 기록 순서 — 사람이 본 순서다.
 */
export function captureTargets(
  rows: Array<Pick<CommentItem, "screen" | "state" | "at">>,
  sinceIso: string | null,
): Array<{ route: string; state: string | null }> {
  const sinceMs = sinceIso === null ? null : Date.parse(sinceIso);
  const seen = new Set<string>();
  const targets: Array<{ route: string; state: string | null }> = [];
  for (const row of rows) {
    if (!row.screen) continue;
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) continue;
    if (sinceMs !== null && !Number.isNaN(sinceMs) && at < sinceMs) continue;
    const route = `/${row.screen.replace(/^\/+/, "")}`;
    // 표식 없는 화면은 null 그대로 간다 — "default" 로 사칭하면 게이트·드라이버의
    // 자리 잡음 판정이 없는 표식을 3초 기다린다. 파일 이름은 쓰는 곳에서 정한다.
    const state = row.state;
    const key = `${route}\n${state}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ route, state });
  }
  return targets;
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
