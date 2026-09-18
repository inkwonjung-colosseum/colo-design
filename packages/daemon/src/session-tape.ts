/**
 * 세션 테이프 (hero-synthesis D1): the daemon's own ChatEvents — 사이클 사건
 * (저장 · 넘김 · 반영 · 개발자 코멘트 도착) — appended per session, one JSONL
 * file per project (`session-tape.jsonl` beside `comments.json`). The vendor
 * transcript never holds these: they are the daemon's record, so the daemon
 * keeps them, and `session.history` splices them into the replay.
 *
 * A row anchors to the turn it followed (`afterTurn` = the session's prompt
 * count at the moment the daemon learned the fact). Replayed transcripts
 * carry no timestamps, so position — not clock — is what puts a 저장 카드
 * between the turn that made the work and the turn that came after.
 *
 * The file dies with the project folder (project.delete removes `paths.root`),
 * and `dropTape` removes one session's rows when the thread itself is
 * deleted — 사람 메시지도 세션 소속이다.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatEvent } from "@colo-design/protocol";

/** One tape line: the event plus where in the conversation it happened. */
export interface TapeRow {
  sessionId: string;
  /** How many prompts the transcript held when the daemon learned this. */
  afterTurn: number;
  event: ChatEvent;
}

function tapeFile(projectRoot: string): string {
  return join(projectRoot, "session-tape.jsonl");
}

/** Append-only, one line per event — a torn tail line loses itself, nothing else. */
export function appendTape(projectRoot: string, row: TapeRow): void {
  const file = tapeFile(projectRoot);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

/** One session's rows, in the order they were written. Torn lines are skipped. */
export function readTape(projectRoot: string, sessionId: string): TapeRow[] {
  let text: string;
  try {
    text = readFileSync(tapeFile(projectRoot), "utf8");
  } catch {
    return [];
  }
  const rows: TapeRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as TapeRow;
      if (row?.sessionId === sessionId && row.event && typeof row.afterTurn === "number") {
        rows.push(row);
      }
    } catch {
      // A torn tail line is not a reason to drop the whole tape.
    }
  }
  return rows;
}

/** 세션 삭제: the thread's rows go with it — 대화가 단위다. */
export function dropTape(projectRoot: string, sessionId: string): void {
  const file = tapeFile(projectRoot);
  let kept: string[];
  try {
    kept = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          return (JSON.parse(line) as TapeRow)?.sessionId !== sessionId;
        } catch {
          return true; // a line we cannot read is not ours to delete
        }
      });
  } catch {
    return;
  }
  const temporary = `${file}.colo-design-${process.pid}`;
  writeFileSync(temporary, kept.length > 0 ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * Splice a session's tape rows into the replayed transcript. A row recorded
 * after turn N lands after that turn's events — before the (N+1)th
 * `user.echo`. Rows past the last echo (the common case: the cycle moved
 * after the conversation's latest turn) append at the tail, before the
 * caller's live-state trailers.
 */
export function spliceTape(events: ChatEvent[], rows: TapeRow[]): ChatEvent[] {
  if (rows.length === 0) return events;
  const out: ChatEvent[] = [];
  let echoes = 0;
  let cursor = 0;
  const flush = (afterTurn: number): void => {
    while (cursor < rows.length) {
      const row = rows[cursor];
      if (!row || row.afterTurn > afterTurn) break;
      out.push(row.event);
      cursor += 1;
    }
  };
  for (const event of events) {
    if (event.kind === "user.echo") {
      flush(echoes);
      echoes += 1;
    }
    out.push(event);
  }
  flush(Number.MAX_SAFE_INTEGER);
  return out;
}
