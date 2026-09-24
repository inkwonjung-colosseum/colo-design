/**
 * 조정 표 (PLAN L3 · 단계 2a) — 관찰 스냅샷(cycle-observe)과 원장(cycle-ledger)을
 * 받아 다음 조치 하나를 고르는 순수 함수. 표를 위에서부터 읽어 첫 어긋남을
 * 고친다. 부작용은 없다: 원장을 고치면 새 원장을 돌려주고, 알림은 의도(intent)만
 * 돌려준다 — 올리는 일은 감독자(cycle-supervisor)가 developer-notice 로 한다.
 *
 * 턴 중 규칙(L3): "턴 중 아니요" 행이 맞았는데 그 클론에서 턴이 돌면 그 행을
 * 건너뛰고 "예" 행(7 · 12 · 13 · 14)만 계속 본다. 단 손상 행과 1~4행(클론의
 * 무결성)은 예 행도 보지 않고 none — 깨진 클론에서 푸시 · 제출을 하지 않는다. 예외는
 * 하나: 12행 푸시는 이미 커밋된 것을 올리는 일이라 작업 트리를 건드리지
 * 않으므로 2행(도구의 병합 충돌) 동안에도 된다.
 *
 * 알림의 "한 번"(L7): 예산 소진으로 올리는 알림(conflict:stuck · review:*:rounds ·
 * base-missing · clone:corrupt)은 예산 항목의 escalated 표식으로, 밀림 · 인증 알림(push:behind ·
 * push:auth)은 원장의 서 있는 알림(notices) 기록으로 여기서 억제한다. 조정자가
 * 실제로 올린 뒤 notices 에 적고, 풀리면 지운다 — 이 함수는 그 기록을 읽기만
 * 한다. 반려 반영 턴의 예산 소진 알림(review:*:rejection)은 올리는 판정이 보낼
 * 기록(pendingRejection)을 함께 지우는 것으로 한 번이다(14b행).
 */

import type { DeveloperReview } from "@colo-design/protocol";
import { BUDGETS, markEscalated, spend } from "./budgets.js";
import { type CycleLedger, type CyclePendingOp, notePushBehind } from "./cycle-ledger.js";

export interface CycleSnapshot {
  now: number;
  /** 이 클론에서 턴이 도는 중 — "턴 중 아니요" 조치는 기다린다(L1). */
  turnRunning: boolean;
  gitOp: null | "merge" | "cherry-pick" | "rebase" | "revert";
  /** 미해결(unmerged) 파일. */
  conflictFiles: string[];
  /** 충돌 표식이 남은 파일(conflictFiles 또는 pendingOp.files 중). */
  markersLeft: string[];
  /** 도구 태그 stash 의 ref. */
  taggedStash: string | null;
  /** null = detached. */
  headBranch: string | null;
  /** 레지스트리의 사이클 브랜치. */
  registryBranch: string | null;
  baseBranch: string;
  originBaseExists: boolean;
  /** GitHub 이 말하는 기본 가지(모르면 null). */
  defaultBranch: string | null;
  dirtyFiles: number;
  /** 사이클 없이 HEAD 가 origin/base 보다 앞선 커밋 수. */
  aheadOfBase: number;
  /** HEAD 에 없는 origin/base 커밋 수. */
  behindBase: number;
  remoteBranchExists: boolean;
  localAheadOfRemote: number;
  remoteAheadOfLocal: number;
  pr: null | {
    number: number;
    state: "open" | "changes_requested" | "merged" | "closed";
    headSha: string;
    mergeableState: string | null;
  };
  /** 병합은 rev-list <prHead>..HEAD 수, 반려는 브랜치 전체 커밋 수. */
  commitsAfterPrHead: number | null;
  /** 레지스트리가 기억하는 넘긴 요청의 상태 — ended 판정의 한 축(옛 폴러의 handoff.state). */
  handoffState: "open" | "changes_requested" | "merged" | "closed" | null;
  /** 이번 관찰이 새로 본 개발자 코멘트(전체 객체 — review.arrived 사건이 실어 나른다). */
  newReviews: DeveloperReview[];
  /** 아직 브리프하지 않은 개발자 코멘트 — 14행의 대상(옛 폴러의 unseen 판정). */
  pendingReviews: DeveloperReview[];
  /** 열린 PR 의 코멘트 총수 — 읽기 실패는 null(모름)이며 원장의 지난 수를 지킨다. */
  reviewCount: number | null;
  installStale: boolean;
  hygieneDue: boolean;
  githubReachable: boolean;
  githubAuthExpired: boolean;
  /**
   * 손상 탐침의 말 (PLAN 단계 9) — HEAD 나 인덱스를 읽는 명령이 손상을 말했다.
   * null 이면 탐침은 멀쩡했다(fsck 가 본 깊은 손상은 원장의 corrupt 에 산다).
   */
  corruption: string | null;
}

export type CycleAction =
  | { kind: "none" }
  | { kind: "abortForeignOp"; op: "merge" | "cherry-pick" | "rebase" | "revert" }
  | { kind: "finishToolOp"; op: "merge" | "cherry-pick" | "stash-pop" }
  | { kind: "briefConflict"; op: "merge" | "cherry-pick" | "stash-pop"; files: string[] }
  | { kind: "clearPendingOp" }
  | { kind: "popParkedStash"; ref: string }
  | { kind: "alignBranch"; name: string }
  | { kind: "branchFromHead" }
  | { kind: "commitPending" }
  | { kind: "adoptStrayCommits" }
  | { kind: "fastForwardBase" }
  | { kind: "retargetBase"; to: string }
  | { kind: "land"; outcome: "merged" | "closed"; pr: number; headSha: string; carry: boolean }
  | { kind: "pullRemoteBranch" }
  | { kind: "mergeBase"; reason: "behind" | "dirty-pr" }
  | { kind: "push" }
  | { kind: "submitStep" }
  | { kind: "briefReviews"; pr: number; reviews: DeveloperReview[] }
  | { kind: "briefRejection"; pr: number; reasons: DeveloperReview[] }
  | { kind: "reinstall" }
  | { kind: "hygiene" }
  | { kind: "reclone" }
  | { kind: "restoreSalvage" };

export interface NoticeIntent {
  op: "raise" | "resolve";
  key: string;
  reason?: string;
}

/** 화면의 문제 문장(L8) — 세 문장 중 무엇을 말할지. */
export type CycleAttention = "ai-fixing" | "developer-notified" | "reconnect" | null;

export interface CycleDecision {
  action: CycleAction;
  notices: NoticeIntent[];
  attention: CycleAttention;
  /**
   * 판정이 세운 주의의 날 목록 (PLAN L8) — `attention` 은 그중 고른 하나이고,
   * 이 목록은 "developer-notified 가 실제 배달을 못 했을 때 reconnect 로
   * 내려앉는" 같은 후속 판정의 재료다.
   */
  attentions: CycleAttention[];
  /** AI 가 고치는 중인가 — 주의 목록에 없는 셋째 문장의 재료. */
  aiFixing: boolean;
  ledger: CycleLedger;
  /**
   * 대화록에 적을 사건 (PLAN L2 흡수표 — 옛 폴러의 cycle.merged ·
   * review.arrived 와 L4 의 cycle.closed · cycle.carried). 감독자가
   * 조치를 마친 뒤 한 번에 싣는다.
   */
  tapeEvents: Array<
    | { kind: "cycle.merged"; pr: number }
    | { kind: "cycle.closed"; pr: number }
    | { kind: "cycle.carried"; from: string; to: string; commits: number }
    | { kind: "review.arrived"; reviews: DeveloperReview[] }
  >;
  /**
   * 사이드바의 lastEventKind/lastEventAt 과 OS 알림의 재료 (옛 폴러의
   * notices.ts `handoff`). state 는 DaemonNotice 의 event 값 그대로다 —
   * 감독자가 fleet 콜백으로 올린다.
   */
  handoffEvents: Array<{
    state: "merged" | "closed" | "changes_requested" | "comments";
    pr: number;
    count?: number;
  }>;
}

/** base-missing 알림의 억제 — 한 번만 올린다(L3 7행의 예산 키). */
const BASE_MISSING_ONCE = { max: 1, windowMs: null };

/**
 * 같은 충돌을 가리키는 예산 키 — 정렬한 파일 목록의 짧은 해시(L3 2행).
 * FNV-1a 32비트: 키는 원장 안에서만 사는 별명이므로 해시 충돌은 예산 하나가
 * 일찍 다하는 쪽으로만 날 수 있다(사람이 겪는 일이 아니다).
 */
function conflictKey(files: string[]): string {
  const joined = [...files].sort().join("\n");
  let hash = 0x811c9dc5;
  for (let i = 0; i < joined.length; i += 1) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `conflict:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** 도구가 시작한 조작이 git 의 진행 표식과 같은 종류인가 — 같으면 2행, 아니면 1행. */
function isToolOpInprogress(snapshot: CycleSnapshot, pending: CyclePendingOp): boolean {
  if (pending.kind === "stash-pop") {
    // stash 복원은 git 의 진행 표식이 없다 — 세 신호로 판다: 미해결 파일,
    // 표식이 남은 파일(add 로 unmerged 가 풀려도 표식은 남는다), 그리고
    // 아직 drop 되지 않은 그 stash 자체. 셋 다 없으면 조작은 끝났다(0행).
    const stashStillThere =
      pending.stashRef === undefined
        ? snapshot.taggedStash !== null
        : snapshot.taggedStash === pending.stashRef;
    return (
      snapshot.gitOp === null &&
      (snapshot.conflictFiles.length > 0 || snapshot.markersLeft.length > 0 || stashStillThere)
    );
  }
  return snapshot.gitOp === pending.kind;
}

/**
 * 주의의 우선순위 — 개발자에게 알렸다는 사실이 가장 먼저다: 이미 사람이
 * 알고 있는 문제를 다른 문장으로 덮으면 문제가 둘로 보인다. 다음은 다시
 * 연결(사용자의 손이 필요한 문제), 마지막이 AI 고침.
 */
function pickAttention(attentions: CycleAttention[], aiFixing: boolean): CycleAttention {
  if (attentions.includes("developer-notified")) return "developer-notified";
  if (attentions.includes("reconnect")) return "reconnect";
  return aiFixing ? "ai-fixing" : null;
}

export function nextCycleAction(snapshot: CycleSnapshot, ledger: CycleLedger): CycleDecision {
  const { now, turnRunning, gitOp } = snapshot;
  const notices: NoticeIntent[] = [];
  const attentions: CycleAttention[] = [];
  const tapeEvents: CycleDecision["tapeEvents"] = [];
  const handoffEvents: CycleDecision["handoffEvents"] = [];
  // 판정 안에서만 갱신하는 원장 조각 — 입력 원장은 그대로 둔다.
  let budgets = ledger.budgets;
  let pendingOp = ledger.pendingOp;
  let push = ledger.push;
  let reviews = ledger.reviews;
  let ended = ledger.ended;
  let lastPr = ledger.lastPr;
  let corrupt = ledger.corrupt;
  let reclone = ledger.reclone;
  let aiFixing = false;

  const decide = (action: CycleAction): CycleDecision => ({
    action,
    notices,
    attention: pickAttention(attentions, aiFixing),
    attentions: [...attentions],
    aiFixing,
    ledger: { ...ledger, budgets, pendingOp, push, reviews, ended, lastPr, corrupt, reclone },
    tapeEvents,
    handoffEvents,
  });
  /** 무결성 문제(1~4행)를 턴 중에 만났다 — 예 행도 보지 않고 기다린다(L3). */
  const integrityWait = (): CycleDecision => decide({ kind: "none" });

  // GitHub 인증이 만료되면 API 의 말을 믿지 않는다 — pr 이 없는 세계로 판다.
  const pr = snapshot.githubAuthExpired ? null : snapshot.pr;
  if (snapshot.githubAuthExpired) attentions.push("reconnect");

  // ————— PR 상태 변화의 알림 (PLAN L2 흡수표 — 옛 폴러의 몫) —————
  // 상태의 기준선은 레지스트리의 handoff 상태(사람이 마지막으로 본 것)이고,
  // 코멘트 수의 기준선은 원장의 lastPr 이다. 알림은 판정 순간에 적는다 —
  // 랜딩이 실패해도 소식은 이미 나갔고, ended 가 같은 PR 의 재알림을 막는다
  // (옛 endedHandoff 와 같은 자리).
  if (pr !== null) {
    const seen = snapshot.handoffState;
    const alreadyEnded = ended?.pr === pr.number;
    if (pr.state === "merged" && seen !== "merged" && !alreadyEnded) {
      handoffEvents.push({ state: "merged", pr: pr.number });
      tapeEvents.push({ kind: "cycle.merged", pr: pr.number });
      ended = {
        pr: pr.number,
        state: "merged",
        headSha: pr.headSha,
        seenAt: new Date(now).toISOString(),
      };
    } else if (pr.state === "closed" && seen !== "closed" && !alreadyEnded) {
      handoffEvents.push({ state: "closed", pr: pr.number });
      tapeEvents.push({ kind: "cycle.closed", pr: pr.number });
      ended = {
        pr: pr.number,
        state: "closed",
        headSha: pr.headSha,
        seenAt: new Date(now).toISOString(),
      };
    } else if (pr.state === "changes_requested" && seen === "open") {
      handoffEvents.push({ state: "changes_requested", pr: pr.number });
    } else if (
      pr.state === "open" &&
      lastPr?.number === pr.number &&
      lastPr.reviewCount !== null &&
      snapshot.reviewCount !== null &&
      snapshot.reviewCount > lastPr.reviewCount
    ) {
      handoffEvents.push({
        state: "comments",
        pr: pr.number,
        count: snapshot.reviewCount - lastPr.reviewCount,
      });
    }
    // 새 코멘트의 도착은 대화록의 몫이다 — 브리프(14행)의 예산과 무관하게
    // 관찰된 순간 한 번 적고, known 에 올려 같은 코멘트가 다시 세지 않게 한다.
    if (snapshot.newReviews.length > 0) {
      tapeEvents.push({ kind: "review.arrived", reviews: snapshot.newReviews });
      const entryKey = String(pr.number);
      const prev = reviews[entryKey] ?? { known: [], briefed: [], rounds: 0 };
      reviews = {
        ...reviews,
        [entryKey]: {
          ...prev,
          known: [...new Set([...prev.known, ...snapshot.newReviews.map((r) => r.id)])],
        },
      };
    }
    // 다른 PR 번호가 오면 기준선은 새로 세운다 — 첫 관찰은 알리지 않는다.
    lastPr = {
      number: pr.number,
      reviewCount: snapshot.reviewCount ?? lastPr?.reviewCount ?? null,
    };
  } else if (snapshot.handoffState === null) {
    // 열린 넘김이 없다 — 기준선을 비운다(다음 사이클의 첫 관찰이 옛 수와
    // 비교해 울리는 일을 막는다).
    lastPr = null;
  }

  const pending = ledger.pendingOp;

  // conflict:stuck 알림은 pendingOp 가 비는 순간 풀린다 — finishToolOp ·
  // clearPendingOp · abortForeignOp 어느 길로든 흔적이 지워지면 다음 판정이
  // 여기서 거둔다. 서 있는 동안은 그대로 둔다(판정이 모르는 키는 건드리지 않는다).
  if (pending === null && ledger.notices["conflict:stuck"] !== undefined) {
    notices.push({ op: "resolve", key: "conflict:stuck" });
  }

  // ————— 손상 행 — 클론이 손상됐다 (PLAN 단계 9) —————
  // 무결성 행(0~4)보다 앞선다: 손상된 클론의 git 읽기는 믿을 수 없고, 그 위의
  // 어떤 조치(abort · checkout · 보관)도 손상을 넓힐 뿐이다. 재클론은 작업
  // 트리를 통째로 옮기므로 턴이 돌면 기다린다 — 예 행(푸시 · 제출)도 보지
  // 않는다(깨진 클론에서 올리지 않는다).
  if (reclone !== null) {
    // 절차가 진행 중 — 옮기기 전이면 이어서 옮기고, 옮긴 뒤면(새 클론이 섰다)
    // 되살린다. 예산은 절차를 시작할 때 한 번만 쓴다.
    if (turnRunning) return integrityWait();
    return decide({ kind: reclone.movedTo === null ? "reclone" : "restoreSalvage" });
  }
  const signal = snapshot.corruption ?? null;
  if (corrupt === null && signal !== null) {
    corrupt = { since: new Date(now).toISOString(), detail: signal };
  }
  if (corrupt !== null) {
    if (turnRunning) return integrityWait();
    const once = spend(budgets, "reclone", BUDGETS.reclone, now);
    budgets = once.ledger;
    if (once.allowed) {
      // 절차의 시작을 판정 순간에 적는다 — 판정과 실행 사이에 끊겨도 다음 틱이
      // 같은 절차를 이어받고 예산을 두 번 쓰지 않는다(I5).
      reclone = { at: new Date(now).toISOString(), salvage: null, movedTo: null };
      return decide({ kind: "reclone" });
    }
    // 하루 한 번을 다 썼다 — 알림은 한 번, 주의는 "개발자에게 알렸어요"(L7).
    attentions.push("developer-notified");
    if (!budgets.reclone?.escalated) {
      notices.push({ op: "raise", key: "clone:corrupt", reason: corrupt.detail });
      budgets = markEscalated(budgets, "reclone");
    }
    return decide({ kind: "none" });
  }

  // ————— 0행 — 도구의 조작 흔적(pendingOp)이 남았는데 git 은 이미 끝났다 —————
  // 마무리한 실행부가 흔적을 지우는 것이 원칙이지만, 그 사이에 끊긴 실행은
  // 흔적만 남긴다(L3 "표를 구현하며 정한 것"). stash-pop 은 그 stash 까지
  // 없어야 끝난 것이다 — stash 가 남았는데 지우면 3행이 다시 pop 해 같은
  // 충돌을 다시 만든다.
  if (pending !== null && !isToolOpInprogress(snapshot, pending)) {
    pendingOp = null;
    return decide({ kind: "clearPendingOp" });
  }

  // ————— 1행 — 도구가 시작하지 않은 git 조작이 진행 중이다(L3 1행) —————
  if (gitOp !== null && ledger.pendingOp?.kind !== gitOp) {
    if (turnRunning) return integrityWait();
    return decide({ kind: "abortForeignOp", op: gitOp });
  }
  // ————— 2행 — 도구가 시작한 병합 · cherry-pick · stash 복원이 멈춰 있다 —————
  if (pending !== null && isToolOpInprogress(snapshot, pending)) {
    if (snapshot.markersLeft.length === 0) {
      // 표식이 없다 — AI 가 정리를 마쳤거나 애초에 충돌이 아니었다. 도구가 마무리한다.
      if (turnRunning) return integrityWait();
      return decide({ kind: "finishToolOp", op: pending.kind });
    }
    if (turnRunning) {
      // 브리프가 이미 나갔고 AI 가 고치는 중이다 — 12행 푸시만 계속 본다(예외).
      aiFixing = true;
    } else {
      const key = conflictKey(snapshot.markersLeft);
      const spent = spend(budgets, key, BUDGETS.conflict, now);
      budgets = spent.ledger;
      if (spent.allowed) {
        // 브리프 수는 판정 순간에 적는다 — 판정과 실행 사이에 끊겨도 같은 충돌의
        // 셈이 두 번 오르지 않게(I5).
        pendingOp = { ...pending, briefs: pending.briefs + 1 };
        aiFixing = true;
        return decide({ kind: "briefConflict", op: pending.kind, files: snapshot.markersLeft });
      }
      // 예산이 다했다 — 알림은 한 번, 주의는 계속 "개발자에게 알렸어요"(L7).
      attentions.push("developer-notified");
      if (!budgets[key]?.escalated) {
        notices.push({
          op: "raise",
          key: "conflict:stuck",
          reason: "충돌 표식이 두 번의 정리 뒤에도 남아 있습니다",
        });
        budgets = markEscalated(budgets, key);
      }
      return decide({ kind: "none" });
    }
  }

  // ————— 3행 — 도구 태그의 stash 가 남아 있다(L3 3행) —————
  if (snapshot.taggedStash !== null && pending === null) {
    if (turnRunning) return integrityWait();
    return decide({ kind: "popParkedStash", ref: snapshot.taggedStash });
  }

  // ————— 4행 — HEAD 가 레지스트리 브랜치가 아니다(L3 4행) —————
  if (snapshot.registryBranch !== null && snapshot.headBranch !== snapshot.registryBranch) {
    if (turnRunning) return integrityWait();
    return decide({ kind: "alignBranch", name: snapshot.registryBranch });
  }
  if (snapshot.registryBranch === null && snapshot.headBranch === null) {
    if (turnRunning) return integrityWait();
    return decide({ kind: "branchFromHead" });
  }

  // ————— 5행 — 커밋 안 된 변경이 있다(L3 5행) —————
  // "턴 중 아니요" 행 — 턴이 돌면 건너뛰고 예 행만 계속 본다.
  if (!turnRunning && snapshot.dirtyFiles > 0) {
    return decide({ kind: "commitPending" });
  }

  // ————— 6행 — 사이클 없이 HEAD 가 origin/base 보다 앞선다(L3 6행) —————
  if (!turnRunning && snapshot.registryBranch === null && snapshot.aheadOfBase > 0) {
    return decide({ kind: "adoptStrayCommits" });
  }

  // ————— 7행(턴 중 예) — origin/base 가 원격에 없다(L3 7행) —————
  if (!snapshot.originBaseExists) {
    if (snapshot.defaultBranch !== null && snapshot.defaultBranch !== snapshot.baseBranch) {
      return decide({ kind: "retargetBase", to: snapshot.defaultBranch });
    }
    if (snapshot.defaultBranch === null) {
      // 기본 가지도 모른다 — 개발자에게 한 번만 알린다.
      attentions.push("developer-notified");
      const once = spend(budgets, "base-missing", BASE_MISSING_ONCE, now);
      budgets = once.ledger;
      if (once.allowed) {
        notices.push({
          op: "raise",
          key: "base-missing",
          reason: "원격에 베이스 브랜치가 없고 GitHub 의 기본 가지도 알 수 없습니다",
        });
      }
      return decide({ kind: "none" });
    }
    // defaultBranch === baseBranch — GitHub 은 그 가지가 있다고 말한다. 로컬
    // remote-tracking 이 늦은 것이다: 다음 관찰의 fetch 가 채운다.
  }
  // 베이스가 원격에 돌아왔다 — base-missing 알림을 거둔다.
  if (snapshot.originBaseExists && ledger.notices["base-missing"] !== undefined) {
    notices.push({ op: "resolve", key: "base-missing" });
  }

  // review:<pr>:rounds 알림은 그 PR 이 더 이상 열려 있지 않을 때 풀린다 —
  // 병합 · 반려 · (인증이 살아 있는 한) 사라짐. changes_requested 도 열린
  // 상태다. 인증 만료로 pr 을 못 읽는 세계에서는 거두지 않는다 — 문제가
  // 풀린 게 아니라 못 보는 것이다.
  if (!snapshot.githubAuthExpired) {
    for (const key of Object.keys(ledger.notices)) {
      const match = /^review:(\d+):rounds$/.exec(key);
      if (match === null) continue;
      const gone =
        pr === null ||
        pr.number !== Number(match[1]) ||
        pr.state === "merged" ||
        pr.state === "closed";
      if (gone) notices.push({ op: "resolve", key });
    }
  }
  // review:<pr>:rejection 알림(14b행)은 다음 요청이 서면 풀린다 — 반려된 작업이
  // 새 요청으로 개발자에게 다시 갔다. 그 PR 은 올릴 때 이미 닫혀 있으므로 위의
  // "열려 있지 않음" 잣대로는 올리자마자 풀린다. 인증 만료로 pr 을 못 읽는
  // 세계(pr === null)에서는 거두지 않는다.
  for (const key of Object.keys(ledger.notices)) {
    const match = /^review:(\d+):rejection$/.exec(key);
    if (match === null) continue;
    if (pr !== null && pr.number !== Number(match[1])) notices.push({ op: "resolve", key });
  }

  // ————— 8 · 9행 — PR 이 병합되거나 닫혔다(L4 랜딩) —————
  // 레지스트리가 이미 그 끝을 들고 있으면(handoffState === pr.state) 착지는
  // 끝난 것이다 — 원장의 ended 와 함께 재착지를 막는 두 번째 잣대(옛
  // landCycleJob 의 seated 판정과 같은 규칙).
  if (
    pr !== null &&
    (pr.state === "merged" || pr.state === "closed") &&
    snapshot.handoffState !== pr.state
  ) {
    if (!turnRunning) {
      const carry = (snapshot.commitsAfterPrHead ?? 0) > 0;
      return decide({
        kind: "land",
        outcome: pr.state,
        pr: pr.number,
        headSha: pr.headSha,
        carry,
      });
    }
  }

  // ————— 10행 — 원격 브랜치가 로컬보다 앞선다(L3 10행) —————
  if (!turnRunning && snapshot.remoteAheadOfLocal > 0) {
    return decide({ kind: "pullRemoteBranch" });
  }

  // ————— 11행 — 사이클 브랜치가 베이스에서 멀어졌다(L3 11행) —————
  if (!turnRunning && snapshot.registryBranch !== null) {
    if (snapshot.behindBase > 0) return decide({ kind: "mergeBase", reason: "behind" });
    if (pr?.mergeableState === "dirty") return decide({ kind: "mergeBase", reason: "dirty-pr" });
  }

  // ————— 11b 행 — 사이클 없는 클론이 곧은 채로 베이스보다 뒤처졌다 —————
  // 없으면 다음 사이클이 낡은 베이스에서 시작한다(PLAN L3 11b).
  if (
    !turnRunning &&
    snapshot.registryBranch === null &&
    snapshot.aheadOfBase === 0 &&
    snapshot.behindBase > 0 &&
    snapshot.dirtyFiles === 0 &&
    snapshot.conflictFiles.length === 0
  ) {
    return decide({ kind: "fastForwardBase" });
  }

  // ————— 12행(턴 중 예) — 올라갈 커밋이 있다(L3 12행) —————
  // 턴 중에도 된다 — 커밋된 것을 올리는 일이라 작업 트리를 건드리지 않는다.
  // 2행(도구의 병합 충돌) 동안에도 되는 이유가 같다.
  const pushDue =
    snapshot.localAheadOfRemote > 0 ||
    (snapshot.registryBranch !== null && !snapshot.remoteBranchExists);
  if (pushDue) {
    // 밀림이 처음 보이는 순간을 찍는다 — 1시간 알림의 기준점은 첫 실패가
    // 아니라 첫 관찰이다(L3 12행).
    if (push === null) push = notePushBehind(ledger, now).push;
    if (push !== null) {
      // 밀림이 1시간을 넘으면 한 번 알린다(L7 푸시) — 서 있는 알림이 잣대다.
      if (
        now - Date.parse(push.behindSince) >= BUDGETS.push.behindAlarmMs &&
        ledger.notices["push:behind"] === undefined
      ) {
        notices.push({
          op: "raise",
          key: "push:behind",
          reason: "푸시가 1시간 넘게 올라가지 못하고 있습니다",
        });
        attentions.push("developer-notified");
      }
      if (push.lastError === "auth") {
        attentions.push("reconnect");
        if (ledger.notices["push:auth"] === undefined) {
          notices.push({
            op: "raise",
            key: "push:auth",
            reason: "GitHub 인증이 만료되어 푸시할 수 없습니다",
          });
        }
      }
    }
    if (push === null || Date.parse(push.nextAttemptAt) <= now) {
      return decide({ kind: "push" });
    }
    // 백오프 창 안이다 — 이 행을 건너뛴다.
  } else if (push !== null) {
    // 밀림이 풀렸다 — 서 있는 알림을 지우고 원장의 푸시 흔적을 치운다.
    notices.push({ op: "resolve", key: "push:behind" });
    notices.push({ op: "resolve", key: "push:auth" });
    push = null;
  }

  // ————— 13행(턴 중 예) — 제출 의도가 남아 있다(L6) —————
  // 백오프 창을 안다: 단계 자신의 창(submit.nextAttemptAt)과, 올라갈
  // 커밋이 남아 있는 동안의 12행 푸시 창이다. 창 안이면 이 행을 건너뛴다 —
  // submitStep 이 매 틱 발동했다가 곧 멈추는 것만으로 아래 행(코멘트 반영 ·
  // 위생)이 밀리지 않게. 의도는 그대로 남아 다음 틱이 이어받는다(I5).
  if (ledger.submit !== null) {
    const stepWait =
      ledger.submit.nextAttemptAt !== undefined && Date.parse(ledger.submit.nextAttemptAt) > now;
    const pushDue =
      snapshot.localAheadOfRemote > 0 ||
      (snapshot.registryBranch !== null && !snapshot.remoteBranchExists);
    const pushWait = pushDue && ledger.push !== null && Date.parse(ledger.push.nextAttemptAt) > now;
    if (!stepWait && !pushWait) return decide({ kind: "submitStep" });
  }

  // ————— 14행(턴 중 예) — 새 개발자 코멘트(L9) —————
  if (
    snapshot.pendingReviews.length > 0 &&
    pr !== null &&
    (pr.state === "open" || pr.state === "changes_requested")
  ) {
    const key = `review:${pr.number}`;
    const round = spend(budgets, key, BUDGETS.reviewRounds, now);
    budgets = round.ledger;
    if (round.allowed) {
      // 브리프를 내리는 순간 장부에 적는다 — 판정과 실행 사이에 끊겨도 같은
      // 코멘트가 두 번 턴으로 나가지 않게(I5). 장부의 키는 PR 번호(L9),
      // 예산의 키는 review:<pr>(L3 14행) — 서로 다른 표의 키다.
      const entryKey = String(pr.number);
      const prev = reviews[entryKey] ?? { known: [], briefed: [], rounds: 0 };
      const ids = snapshot.pendingReviews.map((review) => review.id);
      // 항목의 다른 필드(replied — 이미 답한 코멘트, 반려 표식)는 그대로 둔다 —
      // 지우면 다음 라운드의 정산이 앞 라운드의 답장 기록을 잃는다.
      reviews = {
        ...reviews,
        [entryKey]: {
          ...prev,
          known: [...new Set([...prev.known, ...ids])],
          briefed: [...new Set([...prev.briefed, ...ids])],
          rounds: budgets[key]?.spent ?? prev.rounds + 1,
        },
      };
      aiFixing = true;
      return decide({ kind: "briefReviews", pr: pr.number, reviews: snapshot.pendingReviews });
    }
    attentions.push("developer-notified");
    if (!budgets[key]?.escalated) {
      notices.push({
        op: "raise",
        key: `${key}:rounds`,
        reason: "코멘트 반영이 PR 당 라운드 상한에 닿았습니다",
      });
      budgets = markEscalated(budgets, key);
    }
    // 조치는 없다 — 아래 위생 행은 계속 본다.
  }

  // ————— 14b 행 — 보내지 못한 반려 이유 반영 턴(L9 · 단계 7) —————
  // 랜딩(9행)은 이유를 reviews[pr].pendingRejection 에 적고 떠난다 — 턴은
  // 여기서 나가고, 대화를 못 열었으면 기록이 남아 다음 틱이 다시 보낸다.
  // 턴 중 아니요: 도는 대화 사이에 반려 턴을 끼우지 않는다. 예산은 14행과 같은
  // review:<pr> — 반려 반영도 그 PR 의 반영 한 라운드다. 시도하는 순간 쓴다:
  // 못 연 대화도 한 번이다(14행의 보내기 거절과 같다). 다하면 알림 한 번을
  // 올리고 기록을 지운다 — 도구가 손을 놓았으니 남겨 봐야 틱마다 같은 판정이
  // 되풀이될 뿐이고, 지우는 것이 곧 알림의 "한 번"이다. 14행의 escalated
  // 표식을 쓰지 않는 이유: 라운드 초과 알림이 이미 그 표식을 세웠을 수 있다.
  if (!turnRunning) {
    for (const [entryKey, entry] of Object.entries(reviews)) {
      const pendingRejection = entry.pendingRejection;
      if (pendingRejection === undefined) continue;
      const key = `review:${entryKey}`;
      const round = spend(budgets, key, BUDGETS.reviewRounds, now);
      budgets = round.ledger;
      if (round.allowed) {
        aiFixing = true;
        return decide({
          kind: "briefRejection",
          pr: Number(entryKey),
          reasons: pendingRejection.reasons,
        });
      }
      attentions.push("developer-notified");
      notices.push({
        op: "raise",
        key: `${key}:rejection`,
        reason: "반려 이유 반영 턴을 PR 당 라운드 상한 안에 보내지 못했습니다",
      });
      const { pendingRejection: _dropped, ...rest } = entry;
      reviews = { ...reviews, [entryKey]: rest };
    }
  }

  // ————— 15행 — 설치가 낡았다(L3 15행) —————
  if (!turnRunning && snapshot.installStale) {
    return decide({ kind: "reinstall" });
  }

  // ————— 16행 — 위생 기한이 됐다(L3 16행) —————
  if (!turnRunning && snapshot.hygieneDue) {
    return decide({ kind: "hygiene" });
  }

  return decide({ kind: "none" });
}
