/**
 * 사이클 원장 (PLAN L10 · 단계 2a) — 프로젝트의 사이클 상태가 사는
 * `~/.colo-design/projects/<slug>/cycle.json` 의 모양과 읽기 · 원자 쓰기.
 * 메모리에만 있던 것들(끝난 PR · 코멘트 장부 · 밀린 푸시)이 디스크로 옮겨
 * 어디서 끊겨도 다음 시작이 이어받게 한다(I5).
 *
 * 계약:
 * - parseLedger 는 절대 던지지 않는다 — 모르는 필드는 무시하고 깨진 필드는
 *   버린다. 원장은 자동화의 판단 재료이므로, 반쯤 적힌 파일이 시작을 막아서는
 *   안 된다(review-ledger.ts 와 같은 관용).
 * - 쓰기는 원자다 — 같은 폴더의 임시 파일 + rename. 모드 0600: 원장에 사용자
 *   작업의 흔적(PR 번호 · 브랜치 이름)이 있으므로 남이 읽는 기본 모드로
 *   두지 않는다(config 파일과 같은 규칙).
 * - pendingOp — 도구가 시작한 병합 · cherry-pick · stash 복원이 충돌로 멈춘
 *   것. 이것이 있으면 "도구의 작업", 없는데 git 이 진행 중이면 "남의 작업"
 *   이다(조정 표 L3 의 1행과 2행을 가르는 기준).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BUDGETS, type BudgetEntry, backoffDelay } from "./budgets.js";

/** 원장 파일의 자리 — 프로젝트 폴더(<slug>) 아래의 cycle.json. */
export function cycleLedgerFile(projectRoot: string): string {
  return `${projectRoot}/cycle.json`;
}

export interface CyclePendingOp {
  kind: "merge" | "cherry-pick" | "stash-pop";
  /** 그 조작이 건드리기로 한 파일 — 표식 검사의 범위다. */
  files: string[];
  startedAt: string;
  /** 충돌 정리 브리프를 이미 보낸 수 — 예산(L7 충돌)의 소비 기록. */
  briefs: number;
}

export interface CyclePushState {
  /** 밀림이 처음 관찰된 순간 — 1시간 알림의 기준점. */
  behindSince: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: "auth" | "network" | "rejected" | "other";
}

export interface CycleLedger {
  v: 1;
  /** 끝난 PR — 재시작 뒤 같은 반영을 두 번 알리지 않는다. */
  ended: { pr: number; state: "merged" | "closed"; headSha: string; seenAt: string } | null;
  submit: { requestedAt: string; via: "button" | "chat"; step?: string } | null;
  push: CyclePushState | null;
  pendingOp: CyclePendingOp | null;
  /** 리뷰 장부(L9) — known 은 센 것, briefed 는 턴으로 낸 것. */
  reviews: Record<string, { known: number[]; briefed: number[]; rounds: number }>;
  budgets: Record<string, BudgetEntry>;
  /** 서 있는 개발자 알림(L11) — raise 의 중복 억제 잣체. 조정자가 올리고 지운다. */
  notices: Record<
    string,
    {
      via: "pr" | "issue" | "slack";
      ref?: number;
      raisedAt: string;
      count: number;
    }
  >;
  branches: Array<{ name: string; endedAt: string; state: "merged" | "closed" }>;
  hygiene: { gcAt?: string; fsckAt?: string; pruneAt?: string };
}

export function emptyLedger(): CycleLedger {
  return {
    v: 1,
    ended: null,
    submit: null,
    push: null,
    pendingOp: null,
    reviews: {},
    budgets: {},
    notices: {},
    branches: [],
    hygiene: {},
  };
}

// ————— 관용 읽기 도우미 — 깨진 값은 null, 절대 던지지 않는다 —————

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const asIdList = (value: unknown): number[] | null =>
  Array.isArray(value)
    ? value.filter((id): id is number => typeof id === "number" && Number.isInteger(id))
    : null;

function parseEnded(raw: unknown): CycleLedger["ended"] {
  const record = asRecord(raw);
  if (record === null) return null;
  const pr = asInt(record.pr);
  const state = asString(record.state);
  const headSha = asString(record.headSha);
  const seenAt = asString(record.seenAt);
  if (pr === null || pr <= 0) return null;
  if (state !== "merged" && state !== "closed") return null;
  if (headSha === null || seenAt === null) return null;
  return { pr, state, headSha, seenAt };
}

function parseSubmit(raw: unknown): CycleLedger["submit"] {
  const record = asRecord(raw);
  if (record === null) return null;
  const requestedAt = asString(record.requestedAt);
  const via = asString(record.via);
  if (requestedAt === null || (via !== "button" && via !== "chat")) return null;
  const step = asString(record.step);
  return step === null ? { requestedAt, via } : { requestedAt, via, step };
}

function parsePush(raw: unknown): CyclePushState | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const behindSince = asString(record.behindSince);
  const attempts = asInt(record.attempts);
  const nextAttemptAt = asString(record.nextAttemptAt);
  const lastError = asString(record.lastError);
  if (behindSince === null || attempts === null || attempts < 0 || nextAttemptAt === null) {
    return null;
  }
  if (
    lastError !== null &&
    lastError !== "auth" &&
    lastError !== "network" &&
    lastError !== "rejected" &&
    lastError !== "other"
  ) {
    return null;
  }
  return lastError === null
    ? { behindSince, attempts, nextAttemptAt }
    : { behindSince, attempts, nextAttemptAt, lastError };
}

function parsePendingOp(raw: unknown): CyclePendingOp | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const kind = asString(record.kind);
  const files = Array.isArray(record.files)
    ? record.files.filter((file): file is string => typeof file === "string")
    : null;
  const startedAt = asString(record.startedAt);
  const briefs = asInt(record.briefs);
  if (kind === null || (kind !== "merge" && kind !== "cherry-pick" && kind !== "stash-pop")) {
    return null;
  }
  if (files === null || startedAt === null || briefs === null || briefs < 0) return null;
  return { kind, files, startedAt, briefs };
}

function parseReviews(raw: unknown): CycleLedger["reviews"] {
  const root = asRecord(raw);
  if (root === null) return {};
  const reviews: CycleLedger["reviews"] = {};
  for (const [key, value] of Object.entries(root)) {
    const record = asRecord(value);
    const known = record === null ? null : asIdList(record.known);
    const briefed = record === null ? null : asIdList(record.briefed);
    const rounds = record === null ? null : asInt(record.rounds);
    if (known === null || briefed === null || rounds === null || rounds < 0) continue;
    reviews[key] = { known, briefed, rounds };
  }
  return reviews;
}

function parseBudgets(raw: unknown): Record<string, BudgetEntry> {
  const root = asRecord(raw);
  if (root === null) return {};
  const budgets: Record<string, BudgetEntry> = {};
  for (const [key, value] of Object.entries(root)) {
    const record = asRecord(value);
    if (record === null) continue;
    const spent = asInt(record.spent);
    const firstAt = asString(record.firstAt);
    const lastAt = asString(record.lastAt);
    if (spent === null || spent < 0 || firstAt === null || lastAt === null) continue;
    if (typeof record.escalated !== "boolean") continue;
    budgets[key] = { spent, firstAt, lastAt, escalated: record.escalated };
  }
  return budgets;
}

function parseNotices(raw: unknown): CycleLedger["notices"] {
  const root = asRecord(raw);
  if (root === null) return {};
  const notices: CycleLedger["notices"] = {};
  for (const [key, value] of Object.entries(root)) {
    const record = asRecord(value);
    if (record === null) continue;
    const via = asString(record.via);
    const raisedAt = asString(record.raisedAt);
    const count = asInt(record.count);
    if ((via !== "pr" && via !== "issue" && via !== "slack") || raisedAt === null) continue;
    if (count === null || count < 0) continue;
    const ref = asInt(record.ref);
    notices[key] = ref === null ? { via, raisedAt, count } : { via, ref, raisedAt, count };
  }
  return notices;
}

function parseBranches(raw: unknown): CycleLedger["branches"] {
  if (!Array.isArray(raw)) return [];
  const branches: CycleLedger["branches"] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) continue;
    const name = asString(record.name);
    const endedAt = asString(record.endedAt);
    const state = asString(record.state);
    if (name === null || endedAt === null || (state !== "merged" && state !== "closed")) continue;
    branches.push({ name, endedAt, state });
  }
  return branches;
}

function parseHygiene(raw: unknown): CycleLedger["hygiene"] {
  const record = asRecord(raw);
  if (record === null) return {};
  const hygiene: CycleLedger["hygiene"] = {};
  for (const field of ["gcAt", "fsckAt", "pruneAt"] as const) {
    const value = asString(record[field]);
    if (value !== null) hygiene[field] = value;
  }
  return hygiene;
}

/** 모르는 모양 · 깨진 필드는 버리고 나머지를 살린다 — 절대 던지지 않는다. */
export function parseLedger(raw: unknown): CycleLedger {
  const record = asRecord(raw);
  if (record === null) return emptyLedger();
  return {
    v: 1,
    ended: parseEnded(record.ended),
    submit: parseSubmit(record.submit),
    push: parsePush(record.push),
    pendingOp: parsePendingOp(record.pendingOp),
    reviews: parseReviews(record.reviews),
    budgets: parseBudgets(record.budgets),
    notices: parseNotices(record.notices),
    branches: parseBranches(record.branches),
    hygiene: parseHygiene(record.hygiene),
  };
}

/** 없거나 깨진 파일은 빈 원장 — 시작이 실패할 이유가 아니다. */
export function readLedger(file: string): CycleLedger {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return emptyLedger();
  }
  try {
    return parseLedger(JSON.parse(raw));
  } catch {
    return emptyLedger();
  }
}

/** 원자 쓰기 — 반쯤 적힌 원장이 온전한 것으로 서면 안 된다(review-ledger 방식). */
export function writeLedger(file: string, ledger: CycleLedger): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// ————— 순수 도우미 — 푸시 밀림의 기록(L10 · L3 12행) —————

export type PushOutcome =
  | { ok: true }
  | { ok: false; error: "auth" | "network" | "rejected" | "other" };

/** 밀림이 처음 관찰된 순간만 찍는다 — 1시간 알림(push:behind)의 기준점이다. */
export function notePushBehind(ledger: CycleLedger, now: number): CycleLedger {
  if (ledger.push !== null) return ledger;
  const at = new Date(now).toISOString();
  return { ...ledger, push: { behindSince: at, attempts: 0, nextAttemptAt: at } };
}

/**
 * 푸시 결과를 원장에 적는다 — 성공은 밀림 · 백오프 · 오류 흔적을 함께 지우고,
 * 실패는 시도를 올려 다음 시도를 백오프(L7 푸시: 30초에서 두 배, 최대 10분)
 * 뒤로 미룬다.
 */
export function recordPushResult(
  ledger: CycleLedger,
  result: PushOutcome,
  now: number,
): CycleLedger {
  if (result.ok) {
    if (ledger.push === null) return ledger;
    return { ...ledger, push: null };
  }
  const prev = ledger.push;
  const attempts = (prev?.attempts ?? 0) + 1;
  const delay = backoffDelay(attempts, BUDGETS.push.baseMs, BUDGETS.push.capMs);
  return {
    ...ledger,
    push: {
      behindSince: prev?.behindSince ?? new Date(now).toISOString(),
      attempts,
      nextAttemptAt: new Date(now + delay).toISOString(),
      lastError: result.error,
    },
  };
}

/**
 * 옛 review-ledger.json(`{ "entries": { "<pr>": [id…] } }`)을 reviews[pr].briefed
 * 로 합친다(L9 의 이관). raw 는 파싱된 값이나 파일 본문 문자열이나 다 받는다 —
 * 이관은 두 번 돌아도 같은 결과여야 한다(I5).
 */
export function foldReviewLedger(ledger: CycleLedger, raw: unknown): CycleLedger {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return ledger;
    }
  }
  const entries = asRecord(asRecord(value)?.entries);
  if (entries === null) return ledger;
  const reviews = { ...ledger.reviews };
  for (const [key, ids] of Object.entries(entries)) {
    const pr = Number(key);
    const briefed = asIdList(ids);
    if (!Number.isInteger(pr) || pr <= 0 || briefed === null) continue;
    const prev = reviews[key];
    const mergedBriefed = [...new Set([...(prev?.briefed ?? []), ...briefed])];
    reviews[key] = {
      known: [...new Set([...(prev?.known ?? []), ...mergedBriefed])],
      briefed: mergedBriefed,
      rounds: prev?.rounds ?? 0,
    };
  }
  return { ...ledger, reviews };
}
