/**
 * 사이클 감독자 (PLAN L2 · L3 · 단계 2c) — 한 프로젝트의 사이클을 스스로
 * 제자리로 되돌리는 심장. 틱 한 번은 차선의 "supervise" 칸 안에서
 * 관찰(observeCycle) → 판정(nextCycleAction) → 원장 저장 → 알림 → 조치 실행을
 * 돌고, 조치가 이어지는 한 같은 틱 안에서 다시 판정한다(한 틱 최대 5회).
 *
 * - 세션을 여는 일(openThread · 브리프 보내기)은 반드시 lane.outside 로
 *   부른다 — 차선 문맥이 세션에 번지면 그 세션의 저장이 줄을 비켜간다 (L1).
 * - 도구가 시작한 git 조작의 충돌은 RepoCore.onToolConflict 로 들어와 원장의
 *   pendingOp 에 곧바로 적히고 틱("tool-conflict")이 뒤를 잇는다 (단계 3).
 * - 아직 실행하지 않는 조치(submitStep · hygiene)는 로그 한 줄만 남기고 그
 *   틱을 멈춘다 — 다음 위임이 옮긴다.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ChatEvent, type DeveloperReview, markTurn } from "@colo-design/protocol";
import {
  type CycleLedger,
  type CyclePendingOp,
  emptyLedger,
  foldReviewLedger,
  readLedger,
  recordPushResult,
  unmarkBriefed,
  writeLedger,
} from "./cycle-ledger.js";
import { type ObserveDeps, observeCycle } from "./cycle-observe.js";
import {
  type CycleAction,
  type CycleAttention,
  type CycleDecision,
  type CycleSnapshot,
  nextCycleAction,
} from "./cycle-reconcile.js";
import type { GitHubClient } from "./github.js";
import type { DaemonLogger } from "./log.js";
import type { RepoWorkspace } from "./repo.js";
import type { RepoCore } from "./repo-core.js";
import { conflictBrief, detailOf, STASH_MESSAGE } from "./repo-core.js";
import { alignCycleBranch, pickCycleBranchName } from "./repo-publish.js";

export type TickReason =
  | "timer"
  | "turn-idle"
  | "before-send"
  | "start"
  | "activate"
  | "session-start"
  | "tool-conflict"
  | "manual";

/** 한 틱이 판정-조치 고리를 도는 상한 — 조치가 계속 이어지는 세계에서도 멈춘다. */
const MAX_TICK_ROUNDS = 5;
/** 비활성 프로젝트의 timer 틱이 원격을 읽는 간격 (PLAN L7: 10분에 한 번). */
const INACTIVE_FETCH_MS = 10 * 60 * 1000;
/** 같은 알림을 다시 보내는 간격 — escalation 의 문장 기준 10분과 맞춘다. */
const NOTICE_REPEAT_MS = 10 * 60 * 1000;

/** 알림 키 → 사용자가 읽는 한국어 한 문장. */
const NOTICE_TEXT: Record<string, string> = {
  "push:behind": "저장한 작업을 1시간 넘게 올리지 못하고 있습니다",
  "push:auth": "연결 코드(GitHub 로그인)가 만료돼 저장한 작업을 올리지 못하고 있습니다",
  "conflict:stuck": "충돌 정리가 두 번 안내해도 끝나지 않았습니다",
  "base-missing":
    "베이스 브랜치가 원격에 없고 GitHub 의 기본 가지도 알 수 없습니다 — 개발자 확인이 필요합니다",
};

/** 알림 키의 문장 — 표에 없는 review:<pr>:rounds 는 이 한 줄로 읽힌다. */
function noticeText(key: string): string {
  if (key.startsWith("review:"))
    return "코멘트 반영이 라운드 상한에 닿았습니다 — 개발자가 확인할 차례입니다";
  return NOTICE_TEXT[key] ?? key;
}

export interface SupervisorDeps {
  core: RepoCore;
  /** save · pull · 넘기기 — 차선과 diff 를 나눠 쓰는 같은 뿌리의 워크스페이스. */
  workspace: RepoWorkspace;
  /** 원장 파일 — `~/.colo-design/projects/<slug>/cycle.json`. */
  ledgerPath: string;
  /** SessionManager.busyIn(root) — 턴이 도는 동안은 기다리는 판정이 앞선다. */
  busy: () => boolean;
  /** RepoWorkspace 의 bringup.dependenciesMoved — 설치가 낡았는지. */
  installStale: () => boolean;
  /** RepoCore 의 GitHub 손잡이들 — observeCycle 에 그대로 건넨다. */
  github: () => GitHubClient | null;
  githubAuthExpired: () => boolean;
  slug: () => { owner: string; repo: string } | null;
  /** 활성 프로젝트인가 — timer 틱의 fetch 빈도를 가른다. */
  isActive: () => boolean;
  /**
   * 자동 대화 열기 — fleet 의 autoFixThreadFor 를 넘긴다. 반환된 손잡이의
   * send 는 lane.outside 안에서만 부른다.
   */
  openThread: (title: string) => { send(text: string): void } | null;
  /** 개발자 알림 — 지금은 escalation 한 줄; 단계 4 가 GitHub 경로로 바꾼다. */
  raiseNotice: (key: string, text: string) => void;
  onPrTransition: (
    kind: "merged" | "closed" | "changes_requested" | "comments",
    at: string,
    count?: number,
  ) => void;
  resolveNotice?: (key: string) => void;
  /**
   * 대화록 사건 (PLAN L2 흡수표 — 옛 폴러의 emitCycleEvent). 감독자가
   * 판정의 tapeEvents 와 랜딩의 cycle.carried 를 싣는다. lane.outside 안에서
   * 부른다.
   */
  cycleEvent?: (event: ChatEvent) => void;
  /**
   * 14행의 실행 — 옛 폴러의 리뷰 브리프(reviewToTurn + 자동 저장 정산)를
   * fleet 이 그대로 한다. false 를 돌리면(대화를 못 열었거나 보내기가
   * 거절됨) 감독자가 장부의 briefed 를 되감아 다음 틱이 다시 시도한다.
   * lane.outside 안에서 부른다.
   */
  onNewReviews?: (pr: number, reviews: DeveloperReview[]) => boolean;
  /** 7행 — 레지스트리의 baseBranch 를 옮긴다(fleet 이 registry.update 를 부른다). */
  onRetargetBase?: (to: string) => void;
  /** 수명 설정 — 병합된 원격 브랜치를 지울지(기본 true). */
  deleteMergedBranches?: () => boolean;
  logger: DaemonLogger;
  now?: () => number;
}

export class CycleSupervisor {
  private readonly deps: SupervisorDeps;
  private readonly ledgerPath: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private ledger: CycleLedger;
  private running: Promise<void> | null = null;
  private againReason: TickReason | null = null;
  private lastFetchAt = 0;
  private lastAttention: CycleAttention | null = null;
  private reviewLedgerFolded = false;

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
    this.ledgerPath = deps.ledgerPath;
    this.now = deps.now ?? (() => Date.now());
    this.log = (line) => deps.logger.info(`[cycle] ${line}`);
    this.ledger = this.loadLedger();
    // 도구가 시작한 조작의 충돌은 브리프가 아니라 원장 행으로 들어온다
    // (PLAN L5) — 감독자가 없는 실행(시험)은 core 가 옛 길을 그대로 간다.
    deps.core.onToolConflict = (op) => this.recordToolOp(op);
  }

  /** 마지막 판정의 주의 — 화면에 싣는 일은 단계 4. */
  get attention(): CycleAttention | null {
    return this.lastAttention;
  }

  /** 원장의 pendingOp — 충돌 중 자동 보관 건너뛰기가 읽는다. */
  get pendingOp(): CyclePendingOp | null {
    return this.ledger.pendingOp;
  }

  /** 패키지 내부 공유 — 시험 하네스가 같은 core 를 겨눌 때 쓴다. */
  get repoCore(): RepoCore {
    return this.deps.core;
  }

  /**
   * 도구가 시작한 병합 · cherry-pick · stash 복원이 충돌로 멈췄다 — 원장에
   * 곧바로 적고(관찰을 기다리지 않는다) 틱을 돌린다. RepoCore 가 lane.outside
   * 로 부르므로 여기서는 차선 문맥이 없다.
   */
  recordToolOp(op: CyclePendingOp): void {
    this.ledger = { ...this.ledger, pendingOp: op };
    writeLedger(this.ledgerPath, this.ledger);
    this.log(`pendingOp 기록: ${op.kind} (${op.files.join(", ")})`);
    void this.tick("tool-conflict");
  }

  /**
   * 한 번에 하나 — 도는 중이면 "한 번 더" 표시만 하고 같은 약속을 돌려준다.
   * 약속은 절대 reject 하지 않는다(틱 안의 실패는 로그로만 간다).
   */
  tick(reason: TickReason): Promise<void> {
    if (this.running) {
      this.againReason = reason;
      return this.running;
    }
    const run = this.runLoop(reason);
    this.running = run;
    return run;
  }

  /** 도는 틱이 있으면 그 약속 — 시험과 종료가 새 틱을 일으키지 않고 기다린다. */
  async settled(): Promise<void> {
    await this.running;
  }

  private async runLoop(reason: TickReason): Promise<void> {
    let current: TickReason | null = reason;
    try {
      while (current !== null) {
        const next = this.againReason;
        this.againReason = null;
        await this.tickBody(current);
        current = next;
      }
    } catch (error) {
      this.log(`틱 실패 (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = null;
    }
  }

  /** 틱의 몸통 — 차선의 supervise 칸 안에서 돈다. */
  private async tickBody(reason: TickReason): Promise<void> {
    await this.deps.core.lane.run("supervise", async () => {
      // 옛 review-ledger.json 이 남아 있으면 첫 틱에서 원장으로 접는다 —
      // 마이그레이션 실패가 틱을 막지 않는다.
      if (!this.reviewLedgerFolded) {
        this.reviewLedgerFolded = true;
        try {
          this.ledger = foldReviewLedger(this.ledger, this.readReviewLedger());
          writeLedger(this.ledgerPath, this.ledger);
        } catch {
          // 접기 실패는 다음 틱이 다시 본다.
          this.reviewLedgerFolded = false;
        }
      }

      const fetch = this.shouldFetch(reason);
      const snapshot = await observeCycle(this.deps.core, this.ledger, this.observeDeps(), {
        fetch,
        now: this.now(),
      });
      if (fetch) this.lastFetchAt = this.now();

      // 열린 요청의 상태 변화는 레지스트리에도 적는다 — 칩이 읽는 곳이고,
      // 판정의 변화 감지(handoffState)가 다음 관찰의 기준선이다. 끝난 상태는
      // 여기서 쓰지 않는다 — 랜딩이 적는다(먼저 쓰면 판정이 끝을 모른다).
      const openHandoff = this.deps.core.openHandoff;
      if (
        snapshot.pr !== null &&
        snapshot.pr.state !== "merged" &&
        snapshot.pr.state !== "closed" &&
        openHandoff !== null &&
        snapshot.pr.state !== snapshot.handoffState
      ) {
        this.deps.core.setCycle(this.deps.core.branch, {
          ...openHandoff,
          state: snapshot.pr.state,
        });
      }
      for (let round = 0; round < MAX_TICK_ROUNDS; round++) {
        const decision = nextCycleAction(snapshot, this.ledger);
        this.ledger = decision.ledger;
        this.lastAttention = decision.attention;
        writeLedger(this.ledgerPath, this.ledger);
        this.applyNotices(decision);
        this.emitEvents(decision);
        if (decision.action.kind === "none") return;
        const acted = await this.runAction(decision.action, snapshot);
        if (!acted) return;
        // 조치가 세계를 바꿨다 — 같은 틱 안에서 다시 읽고 판정한다. fetch 는
        // 틱의 첫 관찰에서만 한다(조치가 만든 로컬 변화는 fetch 없이 읽힌다).
        const next = await observeCycle(this.deps.core, this.ledger, this.observeDeps(), {
          fetch: false,
          now: this.now(),
        });
        Object.assign(snapshot, next);
      }
      this.log(`틱이 ${MAX_TICK_ROUNDS}회 판정에 닿아 멈췄습니다 (${reason})`);
    });
  }

  /** fetch 는 틱마다가 아니다 — before-send · start · activate ·
   * session-start · manual 은 늘(도구가 받아 오는 자리), timer 는 활성이면
   * 늘 · 비활성이면 10분에 한 번. 그 밖(turn-idle · tool-conflict)은
   * 로컬 관찰만으로 판정한다. */
  private shouldFetch(reason: TickReason): boolean {
    if (
      reason === "before-send" ||
      reason === "start" ||
      reason === "activate" ||
      reason === "session-start" ||
      reason === "manual"
    ) {
      return true;
    }
    if (reason === "timer") {
      return this.deps.isActive() || this.now() - this.lastFetchAt >= INACTIVE_FETCH_MS;
    }
    return false;
  }

  private observeDeps(): ObserveDeps {
    return {
      turnRunning: this.deps.busy,
      installStale: this.deps.installStale,
      github: this.deps.github,
      githubAuthExpired: this.deps.githubAuthExpired,
      slug: this.deps.slug,
    };
  }

  /** 알림 의도 처리 — raise 는 문장 표로 보내고 원장에 적고, resolve 는
   * 원장에서 지운다(해결 알림은 아직 없다). */
  private applyNotices(decision: CycleDecision): void {
    const now = this.now();
    for (const notice of decision.notices) {
      if (notice.op === "raise") {
        const existing = this.ledger.notices[notice.key];
        if (existing && now - Date.parse(existing.raisedAt) < NOTICE_REPEAT_MS) continue;
        this.deps.raiseNotice(notice.key, noticeText(notice.key));
        this.ledger = {
          ...this.ledger,
          notices: {
            ...this.ledger.notices,
            [notice.key]: {
              via: "slack",
              ref: noticePrNumber(notice.key) ?? undefined,
              raisedAt: new Date(now).toISOString(),
              count: (existing?.count ?? 0) + 1,
            },
          },
        };
        writeLedger(this.ledgerPath, this.ledger);
      } else {
        if (!this.ledger.notices[notice.key]) continue;
        const notices = { ...this.ledger.notices };
        delete notices[notice.key];
        this.ledger = { ...this.ledger, notices };
        writeLedger(this.ledgerPath, this.ledger);
        this.deps.resolveNotice?.(notice.key);
      }
    }
  }

  /**
   * 판정이 적은 사건을 세상에 낸다 — 대화록(tapeEvents)은 cycleEvent 로,
   * 사이드바 · OS 알림(handoffEvents)은 handoffEvent 로. 둘 다 세션을
   * 만질 수 있으므로 반드시 차선 밖에서 부른다(PLAN L1).
   */
  private emitEvents(decision: CycleDecision): void {
    const core = this.deps.core;
    for (const event of decision.handoffEvents) {
      core.lane.outside(() =>
        this.deps.onPrTransition(event.state, new Date(this.now()).toISOString(), event.count),
      );
    }
    for (const event of decision.tapeEvents) {
      const at = new Date(this.now()).toISOString();
      const chat: ChatEvent =
        event.kind === "cycle.merged"
          ? { kind: "cycle.merged", at, pr: event.pr }
          : event.kind === "cycle.closed"
            ? { kind: "cycle.closed", at, pr: event.pr }
            : event.kind === "cycle.carried"
              ? {
                  kind: "cycle.carried",
                  at,
                  from: event.from,
                  to: event.to,
                  commits: event.commits,
                }
              : { kind: "review.arrived", reviews: event.reviews };
      core.lane.outside(() => this.deps.cycleEvent?.(chat));
    }
  }

  /**
   * 조치 실행 — true 면 고리가 다시 판정하고, false 면 그 틱을 멈춘다.
   * 차선 작업 안에서 불리므로 save 같은 차선 호출은 재진입으로 즉시 돈다.
   */
  private async runAction(action: CycleAction, _snapshot: CycleSnapshot): Promise<boolean> {
    const core = this.deps.core;
    switch (action.kind) {
      case "clearPendingOp": {
        this.ledger = { ...this.ledger, pendingOp: null };
        writeLedger(this.ledgerPath, this.ledger);
        return true;
      }
      case "abortForeignOp": {
        // 남의 조작(사람이 손으로 시작한 merge · rebase 등)은 도구가 끝내지
        // 않는다 — 되돌려 놓고 원장을 비운다.
        await core.git([action.op, "--abort"]).catch(() => "");
        this.log(`남의 ${action.op} 를 중단했습니다`);
        this.ledger = { ...this.ledger, pendingOp: null };
        writeLedger(this.ledgerPath, this.ledger);
        return true;
      }
      case "finishToolOp": {
        const pending = this.ledger.pendingOp;
        if (pending === null) return true;
        await this.finishToolOp(pending);
        this.ledger = { ...this.ledger, pendingOp: null };
        writeLedger(this.ledgerPath, this.ledger);
        // 마무리가 워크트리를 바꿨다 — 변경 수를 다시 센다.
        await core.refreshPendingChanges().catch(() => undefined);
        return true;
      }
      case "briefConflict": {
        // 브리프는 세션을 연다 — 반드시 차선 밖에서 (PLAN L1). 판정이 원장의
        // briefs 를 이미 올렸다. 브리프가 나간 뒤 틱은 멈춘다 — 같은 틱에서
        // 다시 판정하면 표식이 아직 있는 같은 충돌에 브리프가 두 번 나간다.
        const pending = this.ledger.pendingOp;
        if (pending === null) return false;
        const step =
          pending.kind === "merge"
            ? "최신 변경 합치기"
            : pending.land
              ? "작업 이어 붙이기"
              : "임시 보관 되돌리기";
        const brief = markTurn(
          { kind: "gate", step },
          conflictBrief(pending.files, pending.kind, await core.conflictSides(pending.kind)),
        );
        await core.lane.outside(async () => {
          this.deps.openThread("최신 변경 합치기")?.send(brief);
        });
        return false;
      }
      case "popParkedStash": {
        await core.recoverParkedWork();
        return true;
      }
      case "alignBranch": {
        const name = core.branch;
        if (name !== null) await alignCycleBranch((args) => core.git(args), name);
        return true;
      }
      case "branchFromHead": {
        await this.deps.workspace.ensureCycleBranch();
        return true;
      }
      case "commitPending": {
        // 자동 보관이 놓친 것(실패 · 중단된 턴, 강제 종료)을 줍는다 — 관찰과
        // 저장 사이에 변경이 사라졌으면 saveBlocked 카드를 띄우지 않게 한 번
        // 더 읽는다.
        if ((await core.diff()).length === 0) return true;
        await this.deps.workspace.save({
          message: "작업 이어 보관",
          backgroundPush: true,
        });
        return true;
      }
      case "adoptStrayCommits": {
        await this.deps.workspace.ensureCycleBranch();
        await core.git(["branch", "-f", core.baseBranch, `origin/${core.baseBranch}`]);
        return true;
      }
      case "fastForwardBase": {
        await core.git(["checkout", core.baseBranch]);
        await core.git(["merge", "--ff-only", `origin/${core.baseBranch}`]);
        return true;
      }
      case "push": {
        return await this.pushOnce();
      }
      case "land": {
        return await this.land(action);
      }
      case "pullRemoteBranch": {
        // 개발자가 PR 브랜치에 직접 올린 커밋을 받는다 — ff-only 가 안 되면
        // 병합으로, 충돌은 원장에 적어 2행이 브리프한다.
        const branch = core.branch;
        if (branch === null) return false;
        try {
          await core.git(["merge", "--ff-only", `origin/${branch}`]);
        } catch {
          try {
            await core.git([
              ...(await core.identityArgs()),
              "merge",
              "--no-edit",
              `origin/${branch}`,
            ]);
          } catch (error) {
            if (await core.mergeInProgress()) {
              this.setPendingOp({
                kind: "merge",
                files: await core.conflictedFiles(),
                startedAt: new Date(this.now()).toISOString(),
                briefs: 0,
              });
              return true;
            }
            this.log(`원격 브랜치 받아오기 실패: ${detailOf(error, core.pat)}`);
            return false;
          }
        }
        return true;
      }
      case "mergeBase": {
        // 사이클 브랜치 위에서 베이스를 합친다 — 트리는 5행 덕에 깨끗하다.
        // 더러우면 아무것도 하지 않고 멈춘다(다음 틱이 다시 본다).
        if ((await core.git(["status", "--porcelain"])).trim() !== "") {
          this.log("mergeBase: 작업 트리가 더러워 건너뜁니다");
          return false;
        }
        try {
          await core.git([
            ...(await core.identityArgs()),
            "merge",
            "--no-edit",
            `origin/${core.baseBranch}`,
          ]);
        } catch (error) {
          if (await core.mergeInProgress()) {
            this.setPendingOp({
              kind: "merge",
              files: await core.conflictedFiles(),
              startedAt: new Date(this.now()).toISOString(),
              briefs: 0,
            });
            return true;
          }
          this.log(`베이스 병합 실패: ${detailOf(error, core.pat)}`);
          return false;
        }
        return true;
      }
      case "retargetBase": {
        // 레지스트리가 기록하는 베이스를 옮기고 클론의 읽기도 맞춘다 —
        // 관찰의 baseBranch 는 core 가 읽는다.
        core.baseBranch = action.to;
        this.deps.onRetargetBase?.(action.to);
        this.log(`베이스 브랜치를 ${action.to} 로 옮겼습니다`);
        return true;
      }
      case "briefReviews": {
        // 브리프는 세션을 연다 — 반드시 차선 밖에서 (PLAN L1). 판정이 원장의
        // briefed 를 이미 적었다. 보내기가 거절되면(반환 false) 되감아 다음
        // 틱이 다시 시도한다 — 옛 폴러의 seen.delete 와 같은 규칙이다.
        // 나간 뒤 틱은 멈춘다 — 같은 틱에서 다시 판정하면 같은 코멘트의
        // 브리프가 두 번 나간다.
        const reviews = action.reviews;
        const sent = await core.lane.outside(async () =>
          this.deps.onNewReviews?.(action.pr, reviews),
        );
        if (sent === false) {
          this.ledger = unmarkBriefed(
            this.ledger,
            action.pr,
            reviews.map((r) => r.id),
          );
          writeLedger(this.ledgerPath, this.ledger);
        }
        return false;
      }
      case "reinstall": {
        // 설치는 몇 분이 걸린다 — 차선 안에서 돌리지 않고 밖에서 띄운다
        // (PLAN L1). 그 틱은 멈추고, 설치가 끝난 뒤의 다음 틱이 이어간다.
        const workspace = this.deps.workspace;
        core.lane.outside(() => void workspace.sync());
        return false;
      }
      default: {
        // submitStep · hygiene — 이번 위임이 실행하지 않는 조치는 로그만
        // 남기고 멈춘다(다음 위임이 옮긴다).
        this.log(`아직 실행하지 않는 조치: ${action.kind}`);
        return false;
      }
    }
  }

  /** 도구가 시작한 조작의 충돌을 원장에 적는다 — 다음 판정의 2행이 브리프한다. */
  private setPendingOp(op: CyclePendingOp): void {
    this.ledger = { ...this.ledger, pendingOp: op };
    writeLedger(this.ledgerPath, this.ledger);
  }

  /**
   * 8 · 9행 — 끝난 요청의 착지 (PLAN L4). 병합이면 베이스로 돌아가 남은
   * 커밋을 새 사이클 브랜치로 옮기고, 반려면 브랜치 전체를 새 브랜치로
   * 이어 베이스를 합친다. 옛 브랜치는 로컬에서 지우고, 병합된 것은 수명
   * 설정이 허락하면 원격에서도 지운다(반려의 원격 브랜치는 원장에 남긴다 —
   * 단계 9 의 정리가 읽는다).
   */
  private async land(action: Extract<CycleAction, { kind: "land" }>): Promise<boolean> {
    const core = this.deps.core;
    const oldBranch = core.branch ?? core.openHandoff?.branch ?? null;
    const base = core.baseBranch;
    const endedHandoff = core.openHandoff ? { ...core.openHandoff, state: action.outcome } : null;

    // 끝난 브랜치의 팁 — 로컬 브랜치가 없으면 원격 추적 ref 가 대신한다.
    const cycleTip = async (): Promise<string | null> => {
      if (oldBranch === null) return null;
      const local = await core.git(["rev-parse", "--verify", "--quiet", oldBranch]).catch(() => "");
      if (local.trim() !== "") return oldBranch;
      const remote = await core
        .git(["rev-parse", "--verify", "--quiet", `origin/${oldBranch}`])
        .catch(() => "");
      return remote.trim() !== "" ? `origin/${oldBranch}` : null;
    };

    // 옛 브랜치 정리 — 로컬은 항상 지우고, 원격은 병합 + 수명 설정이 허락할
    // 때만 지운다. 반려의 원격 브랜치는 원장의 branches 에 남아 단계 9 의
    // 정리(keepRejectedDays)가 읽는다.
    const deleteOldBranch = async (): Promise<void> => {
      if (oldBranch === null) return;
      await core.git(["branch", "-D", oldBranch]).catch(() => "");
      if (action.outcome === "merged" && (this.deps.deleteMergedBranches?.() ?? true)) {
        const remote = await core
          .git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${oldBranch}`])
          .catch(() => "");
        if (remote.trim() !== "") {
          await core.git(["push", "origin", "--delete", oldBranch]).catch((error) => {
            this.log(`원격 브랜치 정리 실패(삼킴): ${detailOf(error, core.pat)}`);
          });
        }
      }
    };

    if (action.outcome === "merged" && !action.carry) {
      // 병합 · 남은 것 없음 — 베이스로 돌아간다. 더러운 트리는 아무것도 하지
      // 않는다(5행이 먼저 보관하므로 보통 깨끗하다).
      if ((await core.git(["status", "--porcelain"])).trim() !== "") {
        this.log("랜딩: 작업 트리가 더러워 건너뜁니다");
        return false;
      }
      try {
        await core.git(["fetch", "origin", base]);
        await core.git(["checkout", base]);
        await core.git(["reset", "--hard", `origin/${base}`]);
      } catch (error) {
        this.log(`랜딩 실패: ${detailOf(error, core.pat)}`);
        return false;
      }
      await deleteOldBranch();
      // 남은 것 없는 병합은 handoff 를 merged 로 남긴다 — 상태 칩이
      // "반영됐어요" 를 말하고, 다음 사이클의 첫 보관이 지운다.
      core.setCycle(null, endedHandoff);
      core.rotateCommentsCycle();
      this.log(`랜딩 완료: PR #${action.pr} 병합 — 베이스로 돌아왔습니다`);
      return true;
    }

    // 이월이 있는 착지 — 새 사이클 브랜치를 연다. 충돌이 나면 착지 문맥을
    // pendingOp.land 에 얹어 둔다: 2행이 브리프하고 마무리(finishToolOp)가
    // git 뒤의 나머지(브랜치 정리 · setCycle · 원장 · 사건)를 이어받는다.
    // 문맥 없이 멈추면 다음 틱이 랜딩을 처음부터 다시 시작해 같은 충돌을
    // 반복한다.
    const tip = await cycleTip();
    if (tip === null) {
      this.log("랜딩 실패: 끝난 사이클의 브랜치를 찾을 수 없습니다");
      return false;
    }
    const newBranch = await pickCycleBranchName((args) => core.git(args), core.url ?? "origin");
    let carried = 0;
    const pendingLand = (): NonNullable<CyclePendingOp["land"]> => ({
      outcome: action.outcome,
      pr: action.pr,
      oldBranch,
      newBranch,
      carried,
    });
    if (action.outcome === "merged") {
      // 병합 · 남은 것 있음 — PR head 뒤의 커밋만 새 브랜치로 옮긴다.
      // headSha 가 로컬에 없으면(넉넉한 규칙의 세계) 브랜치 전체를 이어
      // 베이스를 합치는 쪽으로 간다.
      const headLocal = await core
        .git(["cat-file", "-e", action.headSha])
        .then(() => true)
        .catch(() => false);
      try {
        if (headLocal) {
          await core.git(["fetch", "origin", base]);
          await core.git(["checkout", "-b", newBranch, `origin/${base}`]);
          carried = Number(
            (await core.git(["rev-list", "--count", `${action.headSha}..${tip}`])).trim(),
          );
          if (carried > 0) {
            await core.git(["cherry-pick", `${action.headSha}..${tip}`]);
          }
        } else {
          await core.git(["branch", newBranch, tip]);
          await core.git(["checkout", newBranch]);
          carried = Number(
            (await core.git(["rev-list", "--count", `origin/${base}..${tip}`])).trim(),
          );
          await core.git(["fetch", "origin", base]);
          await core.git([...(await core.identityArgs()), "merge", "--no-edit", `origin/${base}`]);
        }
      } catch (error) {
        if (await core.mergeInProgress()) {
          this.setPendingOp({
            kind: "merge",
            files: await core.conflictedFiles(),
            startedAt: new Date(this.now()).toISOString(),
            briefs: 0,
            land: pendingLand(),
          });
          return true;
        }
        if (await core.cherryPickInProgress()) {
          this.setPendingOp({
            kind: "cherry-pick",
            files: await core.conflictedFiles(),
            startedAt: new Date(this.now()).toISOString(),
            briefs: 0,
            land: pendingLand(),
          });
          return true;
        }
        this.log(`랜딩 이월 실패: ${detailOf(error, core.pat)}`);
        return false;
      }
      await this.completeLand(pendingLand());
      this.log(`랜딩 완료: PR #${action.pr} 병합 — ${carried}개 커밋을 ${newBranch} 로 이월`);
    } else {
      // 반려 — 남은 것은 브랜치 전체다. 새 브랜치를 옛 팁에서 만들고 베이스를
      // 합친다. 옛 원격 브랜치는 지우지 않고 원장에 남긴다.
      try {
        await core.git(["branch", newBranch, tip]);
        await core.git(["checkout", newBranch]);
        carried = Number(
          (await core.git(["rev-list", "--count", `origin/${base}..${tip}`])).trim(),
        );
        await core.git(["fetch", "origin", base]);
        await core.git([...(await core.identityArgs()), "merge", "--no-edit", `origin/${base}`]);
      } catch (error) {
        if (await core.mergeInProgress()) {
          this.setPendingOp({
            kind: "merge",
            files: await core.conflictedFiles(),
            startedAt: new Date(this.now()).toISOString(),
            briefs: 0,
            land: pendingLand(),
          });
          return true;
        }
        this.log(`반려 이월 실패: ${detailOf(error, core.pat)}`);
        return false;
      }
      await this.completeLand(pendingLand());
      this.log(`랜딩 완료: PR #${action.pr} 반려 — 브랜치 전체를 ${newBranch} 로 이월`);
    }
    return true;
  }

  /**
   * 랜딩의 나머지 — 이월이 끝난 뒤(충돌 없이, 또는 finishToolOp 가 충돌을
   * 마무리한 뒤) 옛 브랜치를 정리하고 새 사이클을 레지스트리에 싣는다.
   * 원장의 branches 와 이월 사건도 여기서 난다.
   */
  private async completeLand(land: NonNullable<CyclePendingOp["land"]>): Promise<void> {
    const core = this.deps.core;
    const oldBranch = land.oldBranch;
    if (oldBranch !== null) {
      await core.git(["branch", "-D", oldBranch]).catch(() => "");
      if (land.outcome === "merged" && (this.deps.deleteMergedBranches?.() ?? true)) {
        const remote = await core
          .git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${oldBranch}`])
          .catch(() => "");
        if (remote.trim() !== "") {
          await core.git(["push", "origin", "--delete", oldBranch]).catch((error) => {
            this.log(`원격 브랜치 정리 실패(삼킴): ${detailOf(error, core.pat)}`);
          });
        }
      }
      this.ledger = {
        ...this.ledger,
        branches: [
          ...this.ledger.branches,
          {
            name: oldBranch,
            endedAt: new Date(this.now()).toISOString(),
            state: land.outcome,
          },
        ],
      };
      writeLedger(this.ledgerPath, this.ledger);
    }
    // 이월이 있는 착지는 새 사이클의 시작이다 — handoff 는 null 로 둔다
    // (다음 제출이 새 요청을 연다).
    core.setCycle(land.newBranch, null);
    core.rotateCommentsCycle();
    if (land.carried > 0) {
      const event: ChatEvent = {
        kind: "cycle.carried",
        at: new Date(this.now()).toISOString(),
        from: oldBranch ?? "",
        to: land.newBranch,
        commits: land.carried,
      };
      core.lane.outside(() => this.deps.cycleEvent?.(event));
    }
  }

  /** finishToolOp — AI 가 파일만 정리한 뒤의 git 마무리 (PLAN L5). 랜딩
   *  도중 멈춘 조작이면(pending.land) 착지의 나머지도 여기서 끝낸다 —
   *  그래야 다음 틱이 랜딩을 처음부터 다시 시작하지 않는다. */
  private async finishToolOp(pending: CyclePendingOp): Promise<void> {
    const core = this.deps.core;
    if (pending.kind === "merge") {
      await core.git(["add", "--", ...pending.files]);
      await core.git(["commit", "--no-edit"]);
    } else if (pending.kind === "cherry-pick") {
      await core.git(["add", "--", ...pending.files]);
      await core.git(["-c", "core.editor=true", "cherry-pick", "--continue"]);
    } else {
      // stash-pop — add 로 해결을 표시하고 reset 으로 index 를 풀어 변경을
      // unstaged 로 남긴 뒤, 도구 태그의 stash 만 drop 한다(남의 stash 는
      // 건드리지 않는다).
      await core.git(["add", "--", ...pending.files]);
      await core.git(["reset", "-q"]);
      const ref = (await core.taggedStashRef()) ?? pending.stashRef ?? null;
      if (ref !== null) {
        const list = await core.git(["stash", "list"]).catch(() => "");
        const stillOurs = list
          .split("\n")
          .some((line) => line.startsWith(`${ref}:`) && line.includes(STASH_MESSAGE));
        if (stillOurs) await core.git(["stash", "drop", ref]).catch(() => "");
      }
    }
    this.log(`도구 조작 마무리: ${pending.kind}`);
    if (pending.land) await this.completeLand(pending.land);
  }
  /** 12행 — 밀린 커밋을 한 번 민다. 결과는 원장의 push 로 돌아간다. */
  private async pushOnce(): Promise<boolean> {
    const core = this.deps.core;
    const branch = core.branch;
    if (!branch) return false;
    try {
      await core.git(["push", "--set-upstream", "origin", branch]);
      this.ledger = recordPushResult(this.ledger, { ok: true }, this.now());
      writeLedger(this.ledgerPath, this.ledger);
      // 성공은 판정을 다시 돌지 않고도 밀림 알림을 거둔다 — push 가 null 이
      // 되면 조정이 resolve 를 내지 않으므로 여기서 지운다.
      if (this.ledger.notices["push:behind"] || this.ledger.notices["push:auth"]) {
        const notices = { ...this.ledger.notices };
        delete notices["push:behind"];
        delete notices["push:auth"];
        this.ledger = { ...this.ledger, notices };
        writeLedger(this.ledgerPath, this.ledger);
      }
      return true;
    } catch (error) {
      const outcome = classifyPushError(error);
      this.ledger = recordPushResult(this.ledger, { ok: false, error: outcome }, this.now());
      writeLedger(this.ledgerPath, this.ledger);
      this.log(`push 실패 (${outcome}): ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private loadLedger(): CycleLedger {
    // 깨진 원장은 빈 원장으로 — 복구는 멱등이다 (I5). readLedger 는 경로를
    // 받아 스스로 읽는다(내용을 넘기면 경로로 읽으려 해 항상 빈 원장이 된다).
    try {
      if (existsSync(this.ledgerPath)) {
        return readLedger(this.ledgerPath);
      }
    } catch {
      // 아래의 빈 원장으로.
    }
    return emptyLedger();
  }

  /** 옛 review-ledger.json — 첫 틱의 마이그레이션이 읽는다. */
  private readReviewLedger(): unknown {
    try {
      const path = `${dirname(this.ledgerPath)}/review-ledger.json`;
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }
}

/** push 실패의 분류 — 원장의 백오프와 알림 키가 이 값을 읽는다. */
function classifyPushError(error: unknown): "auth" | "network" | "rejected" | "other" {
  const text = error instanceof Error ? error.message : String(error);
  if (/Authentication failed|could not read Username|Permission denied|403|401/.test(text)) {
    return "auth";
  }
  if (/could not resolve host|connection|timed out|unable to access|network/i.test(text)) {
    return "network";
  }
  if (/rejected|non-fast-forward|fetch first/.test(text)) {
    return "rejected";
  }
  return "other";
}

/** review:<pr>:rounds 같은 알림 키에서 PR 번호를 꺼낸다 — 없으면 null. */
function noticePrNumber(key: string): number | null {
  const m = key.match(/^review:(\d+)/);
  return m ? Number(m[1]) : null;
}
