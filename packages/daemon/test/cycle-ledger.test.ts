import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// `../dist` 임포트인 이유: cycle-ledger 는 형제(budgets)를 `.js` 지정자로
// 부른다 — src 직접 로드는 그 지정을 못 고친다(revive-budget 와 같은 길).
import {
  type CycleLedger,
  cycleLedgerFile,
  emptyLedger,
  foldReviewLedger,
  notePushBehind,
  parseLedger,
  readLedger,
  recordPushResult,
  writeLedger,
} from "../dist/cycle-ledger.js";

const T0 = Date.parse("2026-09-24T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function fullLedger(): CycleLedger {
  return {
    v: 1,
    ended: { pr: 12, state: "merged", headSha: "abc1234", seenAt: iso(T0) },
    lastPr: { number: 12, reviewCount: 3 },
    submit: {
      requestedAt: iso(T0),
      via: "chat",
      step: "pr",
      attempts: 2,
      nextAttemptAt: iso(T0 + 60_000),
      reviewers: ["dev1", "dev2"],
    },
    push: {
      behindSince: iso(T0),
      attempts: 2,
      nextAttemptAt: iso(T0 + 60_000),
      lastError: "network",
    },
    pendingOp: {
      kind: "stash-pop",
      files: ["src/a.ts"],
      startedAt: iso(T0),
      briefs: 1,
      stashRef: "stash@{0}",
    },
    reviews: { "12": { known: [1, 2], briefed: [1], rounds: 1 } },
    budgets: {
      "conflict:deadbeef": { spent: 1, firstAt: iso(T0), lastAt: iso(T0), escalated: false },
    },
    notices: { "push:behind": { via: "pr", ref: 12, raisedAt: iso(T0), count: 1 } },
    branches: [{ name: "colo-design/20260924-1", endedAt: iso(T0), state: "merged" }],
    hygiene: {
      gcAt: iso(T0),
      assetsAt: iso(T0),
      moveAt: iso(T0),
      diskAt: iso(T0),
      assets: { files: 3, bytes: 4096 },
    },
    corrupt: { since: iso(T0), detail: "fatal: index file corrupt" },
    reclone: {
      at: iso(T0),
      salvage: {
        dir: "/p/salvage/20260924T090000Z",
        branch: "colo-design/20260924-1",
        bundleRef: "refs/heads/colo-design/20260924-1",
        patch: true,
      },
      movedTo: null,
    },
  };
}

test("원장 왕복 — 쓴 그대로 읽는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "cycle-ledger-"));
  const file = cycleLedgerFile(dir);
  const ledger = fullLedger();
  writeLedger(file, ledger);
  assert.deepEqual(readLedger(file), ledger);
  // 원자 쓰기의 임시 파일이 남지 않는다.
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("submit 의 재시도 상태와 리뷰어도 왕복한다 — 모르는 값은 버린다", () => {
  const base = {
    requestedAt: "2026-09-24T10:00:00.000Z",
    via: "button",
    step: "pr",
    attempts: 3,
    nextAttemptAt: "2026-09-24T10:01:00.000Z",
    reviewers: ["dev1"],
  };
  assert.deepEqual(parseLedger({ submit: base }).submit, base);
  // 깨진 재시도 상태는 의도만 살린다.
  assert.deepEqual(
    parseLedger({ submit: { requestedAt: base.requestedAt, via: "button" } }).submit,
    { requestedAt: base.requestedAt, via: "button" },
  );
  // via 를 모르면 의도 자체가 없다.
  assert.equal(
    parseLedger({ submit: { requestedAt: base.requestedAt, via: "voice" } }).submit,
    null,
  );
});

test("없거나 깨진 파일은 빈 원장 — 시작이 실패할 이유가 아니다", () => {
  const dir = mkdtempSync(join(tmpdir(), "cycle-ledger-"));
  assert.deepEqual(readLedger(join(dir, "cycle.json")), emptyLedger());
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ 깨진 json");
  assert.deepEqual(readLedger(broken), emptyLedger());
});

test("모르는 필드는 무시하고 깨진 필드만 버린다 — 나머지는 산다", () => {
  const parsed = parseLedger({
    v: 99,
    mystery: true,
    ended: { pr: 12, state: "merged", headSha: "abc", seenAt: iso(T0) },
    push: { behindSince: iso(T0) }, // attempts · nextAttemptAt 없음 — push 전체가 깨진 것
    pendingOp: { kind: "rebase", files: [], startedAt: iso(T0), briefs: 0 },
    reviews: { ok: { known: [1], briefed: [], rounds: 0 }, bad: { known: "x" } },
    branches: [{ name: "b", endedAt: iso(T0), state: "merged" }, { name: 3 }],
    future: { anything: 1 },
  });
  assert.equal(parsed.v, 1);
  assert.deepEqual(parsed.ended, { pr: 12, state: "merged", headSha: "abc", seenAt: iso(T0) });
  assert.equal(parsed.push, null);
  assert.equal(parsed.pendingOp, null); // 도구가 시작할 수 없는 종류는 버린다
  assert.deepEqual(parsed.reviews, { ok: { known: [1], briefed: [], rounds: 0 } });
  assert.deepEqual(parsed.branches, [{ name: "b", endedAt: iso(T0), state: "merged" }]);
});

test("review-ledger.json 을 reviews[pr].briefed 로 합친다 — 두 번 돌아도 같다", () => {
  const raw = JSON.stringify({ entries: { "12": [1, 2, 3], bad: [1], "13": [7] } });
  const once = foldReviewLedger(emptyLedger(), raw);
  assert.deepEqual(once.reviews["12"], { known: [1, 2, 3], briefed: [1, 2, 3], rounds: 0 });
  assert.ok(!("bad" in once.reviews));
  const twice = foldReviewLedger(once, { entries: { "12": [2, 9] } });
  assert.deepEqual(twice.reviews["12"]?.briefed, [1, 2, 3, 9]); // 합집합 — 이관 멱등(I5)
  assert.deepEqual(twice.reviews["13"], { known: [7], briefed: [7], rounds: 0 });
  // 모르는 모양은 그대로 돌려온다.
  assert.deepEqual(foldReviewLedger(once, "not json"), once);
});

/** 반려 이유 한 건 — DeveloperReview 의 모양. */
const reason = {
  id: 31,
  kind: "review" as const,
  author: "dev1",
  body: "목록으로",
  pr: 7,
  at: iso(T0),
};

test("review-ledger 접기는 항목의 다른 필드를 지우지 않는다 — 재시작이 반려 대기를 잃지 않게", () => {
  const pendingRejection = { reasons: [reason], since: iso(T0) };
  const ledger: CycleLedger = {
    ...emptyLedger(),
    reviews: {
      "7": {
        known: [1],
        briefed: [1],
        rounds: 1,
        replied: [1],
        rejectionAsked: true,
        pendingRejection,
      },
    },
  };
  assert.deepEqual(foldReviewLedger(ledger, { entries: { "7": [2] } }).reviews["7"], {
    known: [1, 2],
    briefed: [1, 2],
    rounds: 1,
    replied: [1],
    rejectionAsked: true,
    pendingRejection,
  });
});

test("rejectionAsked · pendingRejection 이 왕복한다 — 깨진 이유는 버리고 항목은 산다", () => {
  const inline = { ...reason, id: 32, kind: "inline" as const, path: "src/a.ts", line: 3 };
  const pendingRejection = { reasons: [reason, inline], since: iso(T0) };
  const parsed = parseLedger({
    reviews: {
      "7": {
        known: [],
        briefed: [],
        rounds: 0,
        rejectionAsked: true,
        pendingRejection: {
          since: iso(T0),
          reasons: [reason, inline, { id: "x" }, { ...reason, id: 33, kind: "bot" }],
        },
      },
      // 참이 아닌 표식 · 살아남은 이유가 없는 대기는 없는 것으로 친다.
      "8": {
        known: [],
        briefed: [],
        rounds: 0,
        rejectionAsked: "yes",
        pendingRejection: { since: iso(T0), reasons: [{ id: 1 }] },
      },
    },
  });
  assert.deepEqual(parsed.reviews["7"], {
    known: [],
    briefed: [],
    rounds: 0,
    rejectionAsked: true,
    pendingRejection,
  });
  assert.deepEqual(parsed.reviews["8"], { known: [], briefed: [], rounds: 0 });
  assert.deepEqual(parseLedger(JSON.parse(JSON.stringify(parsed))), parsed);
});

test("옛 reject:<pr> 표식 — 읽을 때 notices 에서 걷어 reviews[pr].rejectionAsked 로 옮긴다", () => {
  const notice = { via: "pr", ref: 7, raisedAt: iso(T0), count: 1 };
  const parsed = parseLedger({
    notices: { "reject:7": notice, "reject:9": notice, "push:behind": notice },
    reviews: { "7": { known: [1], briefed: [1], rounds: 1 } },
  });
  // 서 있는 알림만 남는다 — 청구 표식은 주의(developer-notified)의 재료가 아니다.
  assert.deepEqual(Object.keys(parsed.notices), ["push:behind"]);
  assert.deepEqual(parsed.reviews["7"], {
    known: [1],
    briefed: [1],
    rounds: 1,
    rejectionAsked: true,
  });
  // 장부가 없던 PR 은 빈 장부에서 시작한다.
  assert.deepEqual(parsed.reviews["9"], {
    known: [],
    briefed: [],
    rounds: 0,
    rejectionAsked: true,
  });
  // 옮긴 원장을 다시 읽어도 같다(I5).
  assert.deepEqual(parseLedger(JSON.parse(JSON.stringify(parsed))), parsed);
});

test("푸시 실패는 백오프(30초에서 두 배, 최대 10분)로 다음 시도를 미룬다", () => {
  let ledger = notePushBehind(emptyLedger(), T0);
  assert.deepEqual(ledger.push, { behindSince: iso(T0), attempts: 0, nextAttemptAt: iso(T0) });
  // 이미 밀림이 기록돼 있으면 기준점을 다시 찍지 않는다.
  assert.equal(notePushBehind(ledger, T0 + 5_000), ledger);

  ledger = recordPushResult(ledger, { ok: false, error: "auth" }, T0 + 10_000);
  assert.equal(ledger.push?.attempts, 1);
  assert.equal(ledger.push?.nextAttemptAt, iso(T0 + 10_000 + 30_000));
  assert.equal(ledger.push?.lastError, "auth");

  ledger = recordPushResult(ledger, { ok: false, error: "network" }, T0 + 60_000);
  assert.equal(ledger.push?.attempts, 2);
  assert.equal(ledger.push?.nextAttemptAt, iso(T0 + 60_000 + 60_000));
  assert.equal(ledger.push?.behindSince, iso(T0)); // 밀림 기준점은 그대로

  const ok = recordPushResult(ledger, { ok: true }, T0 + 120_000);
  assert.equal(ok.push, null); // 올라가면 밀림 · 백오프 · 오류 흔적을 함께 지운다
});

test("push 가 없던 원장의 실패는 지금을 밀림 기준점으로 찍는다", () => {
  const ledger = recordPushResult(emptyLedger(), { ok: false, error: "rejected" }, T0);
  assert.deepEqual(ledger.push, {
    behindSince: iso(T0),
    attempts: 1,
    nextAttemptAt: iso(T0 + 30_000),
    lastError: "rejected",
  });
});

test("쓴 파일의 본문은 JSON 이다 — 사람이 열어 읽을 수 있게", () => {
  const dir = mkdtempSync(join(tmpdir(), "cycle-ledger-"));
  const file = join(dir, "cycle.json");
  writeLedger(file, emptyLedger());
  const text = readFileSync(file, "utf8");
  assert.equal(JSON.parse(text).v, 1);
  assert.ok(text.endsWith("\n"));
});
