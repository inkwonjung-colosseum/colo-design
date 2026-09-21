/**
 * 리뷰 장부 (P0, 2026-09-21): 폴러가 AI 에게 이미 내려준 개발자 코멘트의
 * id 들 — 데몬이 재시작해도 같은 코멘트가 다시 턴으로 나가지 않게 하는
 * 디스크 영속화. 슬라이스 2 의 `briefedReviewIds` 가 메모리뿐이어서, 열린
 * PR 이 코멘트를 하나라도 가진 세계에서는 재시동마다 옛 코멘트 전체가
 * unseen 으로 다시 브리프되고 자동 저장까지 반복됐다.
 *
 * 생김새: `<project>/review-ledger.json` 에 `{ "entries": { "<PR번호>": [id…] } }`.
 * 키는 PR 번호 — 같은 저장소에서 PR 번호는 단조 증가하므로, 읽을 때 열린
 * 넘김의 번호가 아닌 항목은 (그 사이클이 끝났으므로) 덜어낸다.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The ledger file a project's reviews are recorded in. */
export function reviewLedgerFile(projectRoot: string): string {
  return join(projectRoot, "review-ledger.json");
}

interface LedgerFile {
  entries: Record<string, number[]>;
}

/** Tolerant read — a hand-edited or absent file reads as empty. */
export function readReviewLedger(file: string): Map<number, number[]> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LedgerFile>;
    const entries = parsed?.entries;
    if (entries === null || typeof entries !== "object") return new Map();
    const map = new Map<number, number[]>();
    for (const [key, ids] of Object.entries(entries)) {
      const pr = Number(key);
      if (!Number.isInteger(pr) || pr <= 0) continue;
      if (Array.isArray(ids))
        map.set(
          pr,
          ids.filter((id) => Number.isInteger(id)),
        );
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Atomic swap — the ledger guards a turn from being sent twice, so a
 * half-written file must never stand in for a full one (comments.ts
 * writeStore 와 같은 그릇).
 */
export function writeReviewLedger(file: string, map: Map<number, number[]>): void {
  mkdirSync(dirname(file), { recursive: true });
  const entries: Record<string, number[]> = {};
  for (const [pr, ids] of map) entries[String(pr)] = ids;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ entries }, null, 2)}\n`);
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
