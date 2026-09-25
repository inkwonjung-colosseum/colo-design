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
import type { DeveloperReview } from "@colo-design/protocol";
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
  /**
   * stash 복원이 멈춘 자리의 stash ref (PLAN L3 2행) — 마무리의
   * `stash drop` 이 겨눌 것. 병합 · cherry-pick 에는 없다.
   */
  stashRef?: string;
  /**
   * 랜딩 도중 멈춘 조작의 착지 문맥 (PLAN L4) — 충돌이 나도 착지의 나머지
   * (옛 브랜치 정리 · setCycle · 원장 branches · 이월 사건)는 마무리가
   * 이어받는다. 없으면 finishToolOp 는 git 만 끝내고 랜딩은 다시 시작돼
   * 같은 충돌을 반복한다.
   */
  land?: {
    outcome: "merged" | "closed";
    pr: number;
    oldBranch: string | null;
    newBranch: string;
    carried: number;
  };
}

/**
 * 아직 보내지 못한 반려 이유 반영 턴 (PLAN L9 · 단계 7) — 랜딩이 모은 이유를
 * 적어 두고, 턴을 실제로 보낸 뒤에야 지운다. 대화를 못 열어도 조정 표
 * 14b행이 같은 이유로 다시 보낸다 — 랜딩은 다시 오지 않으므로 이 기록이
 * 없으면 반영 턴이 로그 한 줄로 사라진다. since 는 처음 적힌 시각.
 */
export interface CyclePendingRejection {
  reasons: DeveloperReview[];
  since: string;
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
  /**
   * 관찰이 마지막으로 본 열린 PR 의 번호와 코멘트 수 (PLAN L2 흡수표 — 옛
   * 폴러의 lastReviewCount 의 원장 판). reviewCount null 은 "아직 한 번도
   * 성공적으로 읽지 못함" — 0 으로 세우면 다음 성공 읽기가 옛 코멘트 전부를
   * 새 코멘트로 울린다(옛 `beforeReviews === null` 규칙). 상태 변화의
   * 잣대는 원장이 아니라 레지스트리의 handoff 상태다 — 재시작을 넘는
   * 기준선은 그쪽이 이미 들고 있다.
   */
  lastPr: { number: number; reviewCount: number | null } | null;
  /**
   * 제출 의도 (PLAN L6) — 네 단계가 모두 서면 지워진다. 단계의 재시도 상태
   * (attempts · nextAttemptAt)와 요청한 리뷰어도 여기에 산다: 바뀐 경우에만
   * 다시 요청한다.
   */
  submit: {
    requestedAt: string;
    via: "button" | "chat";
    /** 마지막으로 실패한 단계 — pr · commit. */
    step?: string;
    /** 그 단계의 연속 실패 수 — 백오프의 축(12행과 같은 backoffDelay). */
    attempts?: number;
    /** 그 단계의 다음 시도 시각 — 창 안에서는 13행이 발동하지 않는다. */
    nextAttemptAt?: string;
    /** 요청한 리뷰어 — 이 목록이 바뀐 경우에만 다시 요청한다. */
    reviewers?: string[];
  } | null;
  push: CyclePushState | null;
  pendingOp: CyclePendingOp | null;
  /**
   * 리뷰 장부(L9) — known 은 센 것, briefed 는 턴으로 낸 것. replied 는 자동
   * 답장을 이미 올린 코멘트 — 같은 코멘트에 두 번 답하지 않는 잣체다(단계 7).
   * 반려된 PR 의 두 표식도 여기 산다: rejectionAsked 는 이유를 청구하는
   * 코멘트를 이미 남겼다는 한 번만의 표식이고(notices 에 두면 주의가 영원히
   * developer-notified 를 말한다 — L8), pendingRejection 은 아직 보내지 못한
   * 반영 턴이다.
   */
  reviews: Record<
    string,
    {
      known: number[];
      briefed: number[];
      rounds: number;
      replied?: number[];
      rejectionAsked?: boolean;
      pendingRejection?: CyclePendingRejection;
    }
  >;
  budgets: Record<string, BudgetEntry>;
  /**
   * 서 있는 개발자 알림(L11) — raise 의 중복 억제 잣체. 조정자가 올리고 지운다.
   * 주의(developer-notified)의 재료이므로 실제 알림이 아닌 표식은 두지 않는다.
   */
  notices: Record<
    string,
    {
      via: "pr" | "issue" | "slack";
      ref?: number;
      raisedAt: string;
      count: number;
    }
  >;
  /**
   * 끝난 사이클 브랜치의 기록 — 반려는 keepRejectedDays 정리(단계 9)가,
   * 병합의 지연 삭제 표식은 12행 푸시가 읽는다. 표식 없는 병합 기록은 읽는
   * 곳이 없으므로 같은 날수 뒤 위생이 원장에서만 걷는다(원장이 사이클마다
   * 한 줄씩 영원히 자라지 않게).
   */
  branches: Array<{
    name: string;
    endedAt: string;
    state: "merged" | "closed";
    /**
     * 원격 브랜치 삭제를 미루는 표식 (PLAN L4) — 값은 이월이 올라갈 새
     * 브랜치 이름. 이월이 있는 병합에서 옛 원격 브랜치를 새 브랜치가
     * 올라가기 전에 지우면, 푸시가 오래 실패하는 동안 옮긴 커밋이 원격
     * 어디에도 없다. 12행 푸시가 성공한 뒤에 지운다.
     */
    deleteRemoteAfterPush?: string;
  }>;
  /**
   * 끝난 재클론의 흔적 (PLAN 단계 9) — 위생의 prune 이 기한 뒤 지운다.
   * 되살리기가 실패한 것(restored=false)은 지우지 않는다: 개발자가 구해 둔
   * 폴더에서 손으로 꺼내야 하므로 원장이 결과를 적어 가른다.
   */
  salvages: Array<{
    at: string;
    /** 옮겨진 옛 클론(`repo.corrupt-<시각>`)의 자리 — 옮기지 못했으면 null. */
    movedTo: string | null;
    /** 구해 둔 폴더(`salvage/<시각>`)의 자리 — 구해 두지 못했으면 null. */
    salvageDir: string | null;
    /** 되살리기가 성공했는가 — 실패한 흔적은 영원히 남는다. */
    restored: boolean;
  }>;
  /**
   * 위생의 시각 (PLAN 단계 9) — 항목마다 마지막으로 시도한 때. 기한은
   * cycle-hygiene 의 표가 정한다. assets 는 캡처 브랜치(colo-design-assets)
   * 끝 트리의 파일 수 · 대략 크기다 — 정리는 하지 않고 기록만 한다(O4).
   */
  hygiene: {
    gcAt?: string;
    fsckAt?: string;
    pruneAt?: string;
    assetsAt?: string;
    moveAt?: string;
    diskAt?: string;
    assets?: { files: number; bytes: number };
  };
  /**
   * 클론 손상 (PLAN 단계 9) — 관찰의 탐침이나 fsck 가 본 신호. 조정 표의
   * 손상 행이 재클론으로 푼다. 신호가 한 번 서면 재클론이 끝날 때까지 남는다
   * — fsck 가 본 깊은 손상은 다음 관찰의 탐침에 다시 보이지 않는다.
   */
  corrupt: { since: string; detail: string } | null;
  /**
   * 재클론의 이어받기 (PLAN 단계 9) — 손상 행이 절차를 시작하며 적고, 되살리기가
   * 끝나면 지운다. 구해 두기 · 옮기기 · 새로 받기 · 되살리기 사이 어디서 끊겨도
   * 다음 틱이 남은 걸음부터 잇는다(I5) — 예산을 두 번 쓰지 않는다.
   */
  reclone: CycleReclone | null;
}

export interface CycleReclone {
  /** 절차가 시작된 시각 — 구해 둘 폴더와 옮길 폴더 이름의 도장. */
  at: string;
  /** 구해 둔 것 — 구해 두기 전이면 null. */
  salvage: {
    dir: string;
    branch: string | null;
    bundleRef: string | null;
    patch: boolean;
  } | null;
  /** 옛 클론이 옮겨 간 자리 — 옮기기 전이면 null. */
  movedTo: string | null;
}

export function emptyLedger(): CycleLedger {
  return {
    v: 1,
    ended: null,
    lastPr: null,
    submit: null,
    push: null,
    pendingOp: null,
    reviews: {},
    budgets: {},
    notices: {},
    branches: [],
    salvages: [],
    hygiene: {},
    corrupt: null,
    reclone: null,
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
function parseLastPr(raw: unknown): CycleLedger["lastPr"] {
  const record = asRecord(raw);
  if (record === null) return null;
  const number = asInt(record.number);
  const reviewCount = asInt(record.reviewCount);
  if (number === null || number <= 0) return null;
  // reviewCount 는 null 을 허용한다 — "읽은 적 없음" 이 0 과 다른 값이다.
  if (reviewCount !== null && reviewCount < 0) return null;
  return { number, reviewCount };
}

function parseSubmit(raw: unknown): CycleLedger["submit"] {
  const record = asRecord(raw);
  if (record === null) return null;
  const requestedAt = asString(record.requestedAt);
  const via = asString(record.via);
  if (requestedAt === null || (via !== "button" && via !== "chat")) return null;
  const step = asString(record.step);
  const attempts = asInt(record.attempts);
  const nextAttemptAt = asString(record.nextAttemptAt);
  const reviewers = Array.isArray(record.reviewers)
    ? record.reviewers.filter((login): login is string => typeof login === "string")
    : null;
  const submit: CycleLedger["submit"] = { requestedAt, via };
  if (step !== null) submit.step = step;
  if (attempts !== null && attempts >= 0) submit.attempts = attempts;
  if (nextAttemptAt !== null) submit.nextAttemptAt = nextAttemptAt;
  if (reviewers !== null) submit.reviewers = reviewers;
  return submit;
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
  const stashRef = asString(record.stashRef);
  const land = parsePendingLand(record.land);
  const op: CyclePendingOp = { kind, files, startedAt, briefs };
  if (stashRef !== null) op.stashRef = stashRef;
  if (land !== null) op.land = land;
  return op;
}

/** 랜딩 도중 멈춘 조작의 착지 문맥 — 모르는 모양은 버린다(없는 랜딩으로). */
function parsePendingLand(raw: unknown): NonNullable<CyclePendingOp["land"]> | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const outcome = asString(record.outcome);
  const pr = asInt(record.pr);
  const newBranch = asString(record.newBranch);
  const carried = asInt(record.carried);
  if ((outcome !== "merged" && outcome !== "closed") || pr === null || pr <= 0) return null;
  if (newBranch === null || carried === null || carried < 0) return null;
  const oldBranch = asString(record.oldBranch);
  return { outcome, pr, oldBranch, newBranch, carried };
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
    // replied · rejectionAsked · pendingRejection 은 이후 판(단계 7)이 쓴 선택
    // 필드 — 없거나 깨져도 항목은 산다.
    const replied = asIdList(record?.replied);
    const pendingRejection = parsePendingRejection(record?.pendingRejection);
    reviews[key] = {
      known,
      briefed,
      rounds,
      ...(replied !== null ? { replied } : {}),
      ...(record?.rejectionAsked === true ? { rejectionAsked: true } : {}),
      ...(pendingRejection !== null ? { pendingRejection } : {}),
    };
  }
  return reviews;
}

/** 보내지 못한 반려 반영 턴 — 이유가 하나도 살아남지 못하면 없는 것으로 친다. */
function parsePendingRejection(raw: unknown): CyclePendingRejection | null {
  const record = asRecord(raw);
  if (record === null || !Array.isArray(record.reasons)) return null;
  const since = asString(record.since);
  if (since === null) return null;
  const reasons = record.reasons
    .map(parseReason)
    .filter((reason): reason is DeveloperReview => reason !== null);
  return reasons.length > 0 ? { reasons, since } : null;
}

/** 반려 이유 한 건 — DeveloperReview 의 모양 그대로(reviewToTurn 이 다시 읽는다). */
function parseReason(raw: unknown): DeveloperReview | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const id = asInt(record.id);
  const kind = asString(record.kind);
  const author = asString(record.author);
  const body = asString(record.body);
  const pr = asInt(record.pr);
  const at = asString(record.at);
  if (id === null || pr === null || author === null || body === null || at === null) return null;
  if (kind !== "inline" && kind !== "review") return null;
  const path = asString(record.path);
  const line = asInt(record.line);
  return {
    id,
    kind,
    author,
    body,
    pr,
    ...(path !== null ? { path } : {}),
    ...(line !== null ? { line } : {}),
    at,
  };
}

/**
 * 옛 판(3263c45a)의 반려 이유 청구 표식 — notices 의 `reject:<pr>` 를 걷어
 * reviews[pr].rejectionAsked 로 옮긴다. notices 는 서 있는 개발자 알림이라
 * 주의의 재료다: 한 번만의 표식이 거기 남으면 반려 한 번 뒤로 화면이 영원히
 * "개발자에게 알렸어요" 를 말한다(PLAN L8). 읽을 때마다 돌아도 같다(I5).
 */
function liftRejectMarkers(
  notices: CycleLedger["notices"],
  reviews: CycleLedger["reviews"],
): Pick<CycleLedger, "notices" | "reviews"> {
  const keys = Object.keys(notices).filter((key) => key.startsWith("reject:"));
  if (keys.length === 0) return { notices, reviews };
  const nextNotices = { ...notices };
  const nextReviews = { ...reviews };
  for (const key of keys) {
    delete nextNotices[key];
    const pr = Number(key.slice("reject:".length));
    if (!Number.isInteger(pr) || pr <= 0) continue;
    const prev = nextReviews[String(pr)] ?? { known: [], briefed: [], rounds: 0 };
    nextReviews[String(pr)] = { ...prev, rejectionAsked: true };
  }
  return { notices: nextNotices, reviews: nextReviews };
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
    const deleteRemoteAfterPush = asString(record.deleteRemoteAfterPush);
    branches.push(
      deleteRemoteAfterPush === null
        ? { name, endedAt, state }
        : { name, endedAt, state, deleteRemoteAfterPush },
    );
  }
  return branches;
}

function parseHygiene(raw: unknown): CycleLedger["hygiene"] {
  const record = asRecord(raw);
  if (record === null) return {};
  const hygiene: CycleLedger["hygiene"] = {};
  for (const field of ["gcAt", "fsckAt", "pruneAt", "assetsAt", "moveAt", "diskAt"] as const) {
    const value = asString(record[field]);
    if (value !== null) hygiene[field] = value;
  }
  const assets = asRecord(record.assets);
  const files = assets === null ? null : asInt(assets.files);
  const bytes = assets === null ? null : asInt(assets.bytes);
  if (files !== null && files >= 0 && bytes !== null && bytes >= 0) {
    hygiene.assets = { files, bytes };
  }
  return hygiene;
}

function parseReclone(raw: unknown): CycleReclone | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const at = asString(record.at);
  if (at === null) return null;
  const movedTo = asString(record.movedTo);
  const salvageRaw = asRecord(record.salvage);
  let salvage: CycleReclone["salvage"] = null;
  if (salvageRaw !== null) {
    const dir = asString(salvageRaw.dir);
    if (dir === null || typeof salvageRaw.patch !== "boolean") return null;
    salvage = {
      dir,
      branch: asString(salvageRaw.branch),
      bundleRef: asString(salvageRaw.bundleRef),
      patch: salvageRaw.patch,
    };
  }
  return { at, salvage, movedTo };
}

function parseCorrupt(raw: unknown): CycleLedger["corrupt"] {
  const record = asRecord(raw);
  if (record === null) return null;
  const since = asString(record.since);
  const detail = asString(record.detail);
  return since === null || detail === null ? null : { since, detail };
}

/** 모르는 모양 · 깨진 필드는 버리고 나머지를 살린다 — 절대 던지지 않는다. */
export function parseLedger(raw: unknown): CycleLedger {
  const record = asRecord(raw);
  if (record === null) return emptyLedger();
  const { notices, reviews } = liftRejectMarkers(
    parseNotices(record.notices),
    parseReviews(record.reviews),
  );
  return {
    v: 1,
    ended: parseEnded(record.ended),
    lastPr: parseLastPr(record.lastPr),
    submit: parseSubmit(record.submit),
    push: parsePush(record.push),
    pendingOp: parsePendingOp(record.pendingOp),
    reviews,
    budgets: parseBudgets(record.budgets),
    notices,
    branches: parseBranches(record.branches),
    salvages: parseSalvages(record.salvages),
    hygiene: parseHygiene(record.hygiene),
    corrupt: parseCorrupt(record.corrupt),
    reclone: parseReclone(record.reclone),
  };
}

function parseSalvages(raw: unknown): CycleLedger["salvages"] {
  if (!Array.isArray(raw)) return [];
  const traces: CycleLedger["salvages"] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) continue;
    const at = asString(record.at);
    if (at === null || typeof record.restored !== "boolean") continue;
    traces.push({
      at,
      movedTo: asString(record.movedTo),
      salvageDir: asString(record.salvageDir),
      restored: record.restored,
    });
  }
  return traces;
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
    // 옛 파일은 지워지지 않아 시작마다 다시 접힌다 — 항목의 다른 필드(replied ·
    // 반려 표식)를 지우면 재시작이 보내지 못한 반려 반영 턴을 잃는다.
    reviews[key] = {
      ...prev,
      known: [...new Set([...(prev?.known ?? []), ...mergedBriefed])],
      briefed: mergedBriefed,
      rounds: prev?.rounds ?? 0,
    };
  }
  return { ...ledger, reviews };
}

/**
 * 보내기가 거절된 브리프의 되감기 — 판정이 미리 적은 briefed 에서 그 id 들을
 * 뺀다. 옛 폴러의 `seen.delete` 와 같은 규칙이다: 되감긴 코멘트는 다음
 * 관찰의 pending 에 다시 올라 다음 틱이 재시도한다.
 */
export function unmarkBriefed(ledger: CycleLedger, pr: number, ids: number[]): CycleLedger {
  const key = String(pr);
  const prev = ledger.reviews[key];
  if (!prev) return ledger;
  const drop = new Set(ids);
  return {
    ...ledger,
    reviews: {
      ...ledger.reviews,
      [key]: { ...prev, briefed: prev.briefed.filter((id) => !drop.has(id)) },
    },
  };
}
