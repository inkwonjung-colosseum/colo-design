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
 * - 위생(16행)은 기한이 지난 항목만 한 번씩 돈다 — 판정과 도우미는
 *   cycle-hygiene 에 있다 (단계 9).
 * - 클론 손상(손상 행)은 구해 두기 → 옮기기 → 새로 받기 → 되살리기를 원장의
 *   reclone 으로 잇는다 — 몸통은 clone-salvage 에 있다 (단계 9).
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type AttentionParts,
  type ChatEvent,
  type DeveloperReview,
  type HandoffShot,
  type HandoffStatus,
  markTurn,
  reviewToTurn,
} from "@colo-design/protocol";
import { BUDGETS, backoffDelay, markEscalated, resetBudget, spend } from "./budgets.js";
import {
  commitCorruptionSignal,
  restoreSalvage,
  salvageClone,
  salvageStamp,
} from "./clone-salvage.js";
import {
  DEFAULT_KEEP_REJECTED_DAYS,
  DISK_LOW_BYTES,
  type DiskStats,
  dueHygiene,
  endedBranchesDue,
  freeBytesOf,
  fsckClone,
  gigabytes,
  type HygieneItem,
  type HygieneStamp,
  measureAssets,
  movedRepoUrl,
  pruneTempFolders,
} from "./cycle-hygiene.js";
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
import { extractDeveloperReplies, replyFooter } from "./developer-replies.js";
import { COLO_DESIGN_DIR } from "./environment.js";
import type { GitHubClient, PullRequestRef } from "./github.js";
import { mergeToolBlock, pickHandoffTitle } from "./handoff-body.js";
import { type DaemonLogger, sanitizeText } from "./log.js";
import type { RepoWorkspace } from "./repo.js";
import type { RepoCore } from "./repo-core.js";
import {
  conflictBrief,
  DEFAULT_HANDOFF_TITLE,
  detailOf,
  SAVE_CONFLICT_OPEN_DETAIL,
  STASH_MESSAGE,
} from "./repo-core.js";
import { alignCycleBranch, pickCycleBranchName } from "./repo-publish.js";

export type TickReason =
  | "timer"
  | "turn-idle"
  | "before-send"
  | "start"
  | "activate"
  | "session-start"
  | "tool-conflict"
  | "reclone"
  | "manual";

/** 한 틱이 판정-조치 고리를 도는 상한 — 조치가 계속 이어지는 세계에서도 멈춘다. */
const MAX_TICK_ROUNDS = 5;
/** 비활성 프로젝트의 timer 틱이 원격을 읽는 간격 (PLAN L7: 10분에 한 번). */
const INACTIVE_FETCH_MS = 10 * 60 * 1000;
/** 같은 알림을 다시 보내는 간격 — escalation 의 문장 기준 10분과 맞춘다. */
const NOTICE_REPEAT_MS = 10 * 60 * 1000;
/** 반려 이유로 읽는 창 — 닫힘 시각 이전 7일 (PLAN L9). */
const REJECTION_REASON_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 알림 키 → 사용자가 읽는 한국어 한 문장. */
const NOTICE_TEXT: Record<string, string> = {
  "push:behind": "저장한 작업을 1시간 넘게 올리지 못하고 있습니다",
  "push:auth": "연결 코드(GitHub 로그인)가 만료돼 저장한 작업을 올리지 못하고 있습니다",
  "conflict:stuck": "충돌 정리가 두 번 안내해도 끝나지 않았습니다",
  "submit:commit": "제출이 보관 단계에서 멈춰 있습니다",
  "submit:pr": "제출이 요청 열기 단계에서 멈춰 있습니다",
  "base-missing":
    "베이스 브랜치가 원격에 없고 GitHub 의 기본 가지도 알 수 없습니다 — 개발자 확인이 필요합니다",
  "clone:corrupt": "작업 폴더(클론)가 손상돼 다시 받아야 하는데 도구가 스스로 끝내지 못했습니다",
  "clone:restore": "작업 폴더를 다시 받았지만 구해 둔 작업을 다시 얹지 못했습니다",
};
/** 알림 키의 문장 — 표에 없는 review:<pr>:rounds · review:<pr>:rejection 은 이 두 줄로 읽힌다. */
function noticeText(key: string): string {
  if (/^review:\d+:rejection$/.test(key))
    return "반려 이유를 AI 에게 넘기지 못했습니다 — 개발자가 확인할 차례입니다";
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
  /** 설치가 낡았는지 — fleet 은 `!RepoWorkspace.installUpToDate()`(installStale)를 넣는다. */
  installStale: () => boolean;
  /** RepoCore 의 GitHub 손잡이들 — observeCycle 에 그대로 건넨다. */
  github: () => GitHubClient | null;
  githubAuthExpired: () => boolean;
  slug: () => { owner: string; repo: string } | null;
  /** 활성 프로젝트인가 — timer 틱의 fetch 빈도를 가른다. */
  isActive: () => boolean;
  /**
   * 자동 대화 열기 — fleet 의 autoFixThreadFor 를 넘긴다. 공급자를 고르느라
   * 비동기다(auto-thread.ts). 부르기와 반환된 손잡이의 send 는 lane.outside
   * 안에서만 하고, 기다린다. null 은 대화를 열 수 없었다는 뜻이다.
   */
  openThread: (title: string) => Promise<{ send(text: string): void } | null>;
  /** 개발자 알림 — fleet 의 DeveloperNotice 로 간다. `reason` 은 조정 표가
   *  붙인 사유로, 알림 본문의 `자세히` 가 된다. */
  raiseNotice: (key: string, text: string, reason?: string) => void;
  onPrTransition: (
    kind: "merged" | "closed" | "changes_requested" | "comments",
    at: string,
    count?: number,
  ) => void;
  /** 알림 해소 — DeveloperNotice.resolve 로 간다(원격 갱신 + 원장 정리). */
  resolveNotice?: (key: string) => void;
  /** 주의 재료가 바뀌었을 때 — fleet 이 상태를 다시 방송하는 신호. */
  onChange?: () => void;
  /** L6 제출 — PR 제목의 프로젝트 이름 (레지스트리의 이름). */
  projectName: () => string;
  /** L6 제출 — 코멘트 저장소(comments.json)의 경로. PR 본문의 수정 요청 절. */
  commentsFile: () => string;
  /** L6 제출 — 이번 사이클의 화면 캡처. 실패는 빈 목록으로 조용히. */
  captureShots: () => Promise<HandoffShot[]>;
  /**
   * 대화록 사건 (PLAN L2 흡수표 — 옛 폴러의 emitCycleEvent). 감독자가
   * 판정의 tapeEvents 와 랜딩의 cycle.carried 를 싣는다. lane.outside 안에서
   * 부른다.
   */
  cycleEvent?: (event: ChatEvent, sessionId?: string) => void;
  /**
   * 14행의 실행 — 옛 폴러의 리뷰 브리프(reviewToTurn + 자동 저장 정산)를
   * fleet 이 그대로 한다. false 를 돌리면(대화를 못 열었거나 보내기가
   * 거절됨) 감독자가 장부의 briefed 를 되감아 다음 틱이 다시 시도한다.
   * lane.outside 안에서 부르고 기다린다 — 대화 열기가 비동기다.
   */
  onNewReviews?: (pr: number, reviews: DeveloperReview[]) => Promise<boolean>;
  /** 7행 — 레지스트리의 baseBranch 를 옮긴다(fleet 이 registry.update 를 부른다). */
  onRetargetBase?: (to: string) => void;
  /** 수명 설정 — 개발자 코멘트에 AI 가 스스로 답할까 (PLAN L9 · O5, 기본 true). */
  autoReply?: () => boolean;
  /** 넘긴 요청에 적을 작성자 이름 — 자동 답장의 대리 표기가 읽는다(P1-3). */
  authorName?: () => string | null;
  deleteMergedBranches?: () => boolean;
  /** 수명 설정 — 반려 브랜치를 남기는 날(기본 14, O3). 위생이 읽는다. */
  keepRejectedDays?: () => number;
  /**
   * 기계 전체의 개발자 알림 — 한 프로젝트의 것이 아닌 문제(disk:low). fleet 이
   * DeveloperNotice 에 slug null 로 올린다(Slack · 로그). 화면 주의는 서지 않는다.
   */
  raiseMachineNotice?: (key: string, detail: string) => void;
  resolveMachineNotice?: (key: string) => void;
  /** 디스크 여유를 읽는 손 — 기본은 fs.statfs. 시험이 주입한다. */
  statfs?: (path: string) => Promise<DiskStats>;
  /** 여유를 볼 자리 — 기본은 `~/.colo-design`(그 폴더가 든 볼륨). */
  dataDir?: string;
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
  private lastAttentions: CycleAttention[] = [];
  /** reconnect · ai-fixing 이 처음 선 시각 — 주의의 since. */
  private reconnectSince: string | null = null;
  private aiFixingSince: string | null = null;
  private reviewLedgerFolded = false;
  /** 제출 완료 사건의 귀속 대화 — submit() 이 던져두는 줄. */
  private submitSessionId: string | null = null;

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

  /**
   * 주의의 재료 (PLAN L8) — 마지막 판정의 날 주의 목록과 서 있는 알림을
   * composeAttention 에 건네는 모양으로 돌려준다. developer-notified 는
   * 실제로 나간 알림(원장 notices)에서만 선다 — 조정 표의 의도가 아니라
   * 배달된 사실이 재료다(O9).
   */
  attentionParts(): AttentionParts {
    return {
      reconnect:
        this.reconnectSince === null ? null : { what: "github", since: this.reconnectSince },
      aiFixingSince: this.aiFixingSince,
      notices: this.ledger.notices,
    };
  }

  /** 원장의 notices — DeveloperNotice 가 읽고 쓰는 접근자. */
  notices(): CycleLedger["notices"] {
    return this.ledger.notices;
  }

  /** 원장의 notices 한 항목을 쓰거나(null) 지운다 — DeveloperNotice 의 쓰기 문. */
  setNotice(key: string, entry: CycleLedger["notices"][string] | null): void {
    const notices = { ...this.ledger.notices };
    if (entry === null) delete notices[key];
    else notices[key] = entry;
    this.ledger = { ...this.ledger, notices };
    writeLedger(this.ledgerPath, this.ledger);
    this.deps.onChange?.();
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

  /**
   * 제출의 진입 (PLAN L6) — 원장에 의도를 적고 곧바로 틱을 돈다. 이미 의도가
   * 있으면 다시 적지 않는다: 두 번 눌러도 제출은 하나고, 진행 중인 단계를
   * 처음부터 다시 시작하지도 않는다. 실행은 조정 표 13행의 submitStep 이
   * 멱등하게 이어받는다 — 어디서 멈춰도 다음 틱이 끝까지 간다(I5).
   * `sessionId` 는 완료 사건(cycle.handed)의 귀속줄 — 원장이 아니라 메모리에
   * 둔다(재시작 뒤엔 fleet 의 기본 귀속 규칙이 이어받는다).
   */
  submit(via: "button" | "chat", sessionId?: string): void {
    this.submitSessionId = sessionId ?? null;
    if (this.ledger.submit === null) {
      this.ledger = {
        ...this.ledger,
        submit: { requestedAt: new Date(this.now()).toISOString(), via },
      };
      writeLedger(this.ledgerPath, this.ledger);
      this.log(`제출 의도 (${via})`);
    }
    void this.tick("manual");
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
      // 클론이 없다 — 준비(bootstrap)가 받는 중이거나(재클론의 틈) 아직 받은 적이
      // 없다. 읽을 git 이 없으니 판정할 것도 없다: 없는 폴더를 관찰한 중립값으로
      // 조치(브랜치 만들기 따위)를 고르지 않게 한다.
      if (!this.deps.core.isCloned()) return;

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
        // 주의의 since — 처음 선 시각이 서고, 목록에서 빠지면 지운다.
        const nowIso = new Date(this.now()).toISOString();
        const wasAiFixing = this.aiFixingSince !== null;
        this.reconnectSince = decision.attentions.includes("reconnect")
          ? (this.reconnectSince ?? nowIso)
          : null;
        this.aiFixingSince = decision.aiFixing ? (this.aiFixingSince ?? nowIso) : null;
        const changed =
          JSON.stringify(decision.attentions) !== JSON.stringify(this.lastAttentions) ||
          decision.aiFixing !== wasAiFixing;
        this.lastAttentions = decision.attentions;
        writeLedger(this.ledgerPath, this.ledger);
        this.applyNotices(decision);
        this.emitEvents(decision);
        if (changed) this.deps.onChange?.();
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

  /**
   * 알림 의도 처리 (PLAN L11) — 올리고 거두는 실제 일은 DeveloperNotice 가
   * 한다: raise 는 그쪽으로 넘기고(원장 기록은 배달이 성공한 뒤 그쪽이 쓴다),
   * resolve 는 원격 갱신과 원장 정리를 함께 맡긴다. resolveNotice 가 없는
   * 실행(시험)은 원장에서 지우는 것으로 끝낸다.
   */
  private applyNotices(decision: CycleDecision): void {
    const now = this.now();
    for (const notice of decision.notices) {
      if (notice.op === "raise") {
        const existing = this.ledger.notices[notice.key];
        if (existing && now - Date.parse(existing.raisedAt) < NOTICE_REPEAT_MS) continue;
        this.deps.raiseNotice(notice.key, noticeText(notice.key), notice.reason);
      } else {
        if (!this.ledger.notices[notice.key]) continue;
        if (this.deps.resolveNotice) {
          this.deps.resolveNotice(notice.key);
        } else {
          const notices = { ...this.ledger.notices };
          delete notices[notice.key];
          this.ledger = { ...this.ledger, notices };
          writeLedger(this.ledgerPath, this.ledger);
        }
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
          (await this.deps.openThread("최신 변경 합치기"))?.send(brief);
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
        const saved = await this.deps.workspace.save({
          message: "작업 이어 보관",
          backgroundPush: true,
        });
        if (saved.stage === "published") return true;
        // 보관이 막혔다 — 없는 객체로 트리를 짓지 못했다면 클론의 손상이다: 원장에
        // 적고 같은 틱의 다음 판정(손상 행)이 재클론한다(PLAN 단계 9). 그 밖의
        // 실패는 틱을 멈춘다 — 이 행이 판정의 앞자리라 다시 판정하면 같은 보관만
        // 다섯 번 되풀이한다.
        if (saved.detail && commitCorruptionSignal(saved.detail)) {
          if (this.ledger.corrupt === null) {
            this.ledger = {
              ...this.ledger,
              corrupt: { since: new Date(this.now()).toISOString(), detail: saved.detail },
            };
            writeLedger(this.ledgerPath, this.ledger);
          }
          return true;
        }
        return false;
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
      case "submitStep": {
        return await this.submitStep();
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
      case "briefRejection": {
        // 14b행 — 반려 이유 반영 턴 (PLAN L9). 판정이 예산 review:<pr> 를 이미
        // 썼다. 기록은 실제로 보낸 뒤에만 지운다: 대화를 못 열었거나 보내기가
        // 던졌으면 남아서 다음 틱이 같은 이유로 다시 보낸다. 나간 뒤 틱은
        // 멈춘다 — 14행과 같은 이유다.
        if (await this.sendRejectionTurn(action.reasons)) {
          this.clearPendingRejection(action.pr);
          this.log(
            `반려 이유 반영 턴을 열었습니다 — PR #${action.pr}, 이유 ${action.reasons.length}건`,
          );
        } else {
          this.log(
            `반려 이유 반영 턴을 열지 못했습니다 — PR #${action.pr}, 다음 틱이 다시 보냅니다`,
          );
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
      case "hygiene": {
        return await this.hygiene();
      }
      case "reclone": {
        return await this.reclone();
      }
      case "restoreSalvage": {
        return await this.restoreFromSalvage();
      }
      case "none": {
        // 틱의 몸통이 이미 거른다 — 조치 없음은 고리를 멈춘다.
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
    /** 옮길 커밋이 없어진 병합의 끝 — 베이스로 돌아가 handoff 는 merged 로. */
    const finishMergedOnBase = async (): Promise<boolean> => {
      await core.git(["checkout", base]);
      await core.git(["reset", "--hard", `origin/${base}`]);
      await deleteOldBranch();
      core.setCycle(null, endedHandoff);
      core.rotateCommentsCycle();
      this.log(`랜딩 완료: PR #${action.pr} 병합 — 옮길 커밋이 없어 베이스로 돌아왔습니다`);
      return true;
    };
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
          // 옮길 커밋은 병합 커밋을 빼고 골라 하나씩 붙인다 — 범위
          // cherry-pick 은 병합 커밋에서 "-m 없음" 오류로(예: PR 을 읽기
          // 전 틱의 11행 mergeBase 가 base 를 합친 경우), 이미 베이스에 들어간
          // 변경은 빈 커밋에서 멈춘다. 둘 다 충돌이 아니라 실패라 틱마다
          // 되풀이된다. 병합 커밋의 내용은 베이스에 이미 있다(스쿼시 병합의
          // 이월이 정확히 이 세계다). --empty=drop 은 git 2.45+ — 이 도구가
          // 싣는 git(이동식 2.53 · MinGit 2.55)과 시스템 git 이 모두 위다.
          const picks = (
            await core.git(["rev-list", "--reverse", "--no-merges", `${action.headSha}..${tip}`])
          )
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          if (picks.length === 0) {
            // 옮길 것이 없다(병합 커밋뿐이거나 이미 베이스에 들어갔다) —
            // 남은 것 없는 병합처럼 베이스로 돌아간다.
            return await finishMergedOnBase();
          }
          await core.git(["checkout", "-b", newBranch, `origin/${base}`]);
          for (const sha of picks) {
            try {
              await core.git([...(await core.identityArgs()), "cherry-pick", "--empty=drop", sha]);
            } catch (pickError) {
              if (!(await core.cherryPickInProgress())) throw pickError;
              carried = await this.countOnBranch(core, base, newBranch);
              this.setPendingOp({
                kind: "cherry-pick",
                files: await core.conflictedFiles(),
                startedAt: new Date(this.now()).toISOString(),
                briefs: 0,
                land: pendingLand(),
              });
              return true;
            }
          }
          carried = await this.countOnBranch(core, base, newBranch);
          if (carried === 0) {
            // 고른 커밋이 모두 빈 커밋이었다(이미 베이스에 들어간 변경) —
            // 빈 새 사이클을 열지 않고 베이스로 돌아간다.
            await core.git(["checkout", base]).catch(() => "");
            await core.git(["branch", "-D", newBranch]).catch(() => "");
            return await finishMergedOnBase();
          }
        } else {
          await core.git(["branch", newBranch, tip]);
          await core.git(["checkout", newBranch]);
          carried = await this.countOnBranch(core, base, newBranch);
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
          carried = await this.countOnBranch(core, base, newBranch).catch(() => carried);
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
    // 마무리 시점의 실제 커밋 수 — 충돌을 겪은 이월은 멈춘 순간의 셈이
    // 낡았으므로 끝에서 다시 읽는다.
    const carried = await this.countOnBranch(core, core.baseBranch, land.newBranch).catch(
      () => land.carried,
    );
    if (oldBranch !== null) {
      // 로컬 옛 브랜치는 곧바로 지운다 — 커밋은 새 브랜치에 있다.
      await core.git(["branch", "-D", oldBranch]).catch(() => "");
      // 이월이 있는 병합의 원격 삭제는 새 브랜치가 올라간 뒤로 미룬다 —
      // 그 전에 지우면 12행 푸시가 실패하는 동안 옮긴 커밋이 원격 어디에도
      // 없다(옛 브랜치에 올라가 있던 것까지 지워진다). 미룰 표식은 원장
      // branches 의 deleteRemoteAfterPush — 푸시 성공 뒤의 정리가 읽는다.
      const mayDeleteRemote =
        land.outcome === "merged" && (this.deps.deleteMergedBranches?.() ?? true);
      const deferRemoteDelete = mayDeleteRemote && carried > 0;
      if (mayDeleteRemote && !deferRemoteDelete) {
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
            ...(deferRemoteDelete ? { deleteRemoteAfterPush: land.newBranch } : {}),
          },
        ],
      };
      writeLedger(this.ledgerPath, this.ledger);
    }
    // 이월이 있는 착지는 새 사이클의 시작이다 — handoff 는 null 로 둔다
    // (다음 제출이 새 요청을 연다).
    core.setCycle(land.newBranch, null);
    core.rotateCommentsCycle();
    if (carried > 0) {
      const event: ChatEvent = {
        kind: "cycle.carried",
        at: new Date(this.now()).toISOString(),
        from: oldBranch ?? "",
        to: land.newBranch,
        commits: carried,
      };
      core.lane.outside(() => this.deps.cycleEvent?.(event));
    }
    // 반려의 착지 — 닫힘 이유를 반영 턴으로 넘긴다(PLAN L4 · L9). 병합에는
    // 이유가 없다. 턴은 원장에 적힌 뒤 14b행이 보낸다 — 착지는 다시 오지 않는다.
    if (land.outcome === "closed") await this.briefRejection(land.pr);
  }

  /** 새 브랜치에 실제로 있는 커밋 수 — 빈 커밋 버림(--empty=drop)을 셈에
   *  반영한다. 실패는 호출자의 catch 에 맡긴다. */
  private async countOnBranch(core: RepoCore, base: string, branch: string): Promise<number> {
    const out = await core.git(["rev-list", "--count", `origin/${base}..${branch}`]);
    return Number(out.trim()) || 0;
  }

  /**
   * 답장할 코멘트를 찜는다 (PLAN L9) — 돌려준 id 는 아직 답장하지 않은
   * 것들이고, 찜하는 순간 원장 reviews[pr].replied 에 적힌다. 게시의 성패와
   * 무관하게 찜은 한 번뿐: 실패해도 다시 시도하지 않는다(같은 코멘트에 두
   * 번 답하지 않는다).
   */
  claimReviewReplies(pr: number, ids: number[]): number[] {
    if (ids.length === 0) return [];
    const key = String(pr);
    const prev = this.ledger.reviews[key] ?? { known: [], briefed: [], rounds: 0 };
    const replied = new Set(prev.replied ?? []);
    const fresh = ids.filter((id) => !replied.has(id));
    if (fresh.length === 0) return [];
    this.ledger = {
      ...this.ledger,
      reviews: {
        ...this.ledger.reviews,
        [key]: { ...prev, replied: [...replied, ...fresh] },
      },
    };
    writeLedger(this.ledgerPath, this.ledger);
    return fresh;
  }

  /**
   * L9 자동 답장 — 리뷰 반영 턴이 끝나 보관이 서면(fleet 의 settleAutoSave 가
   * 부른다) 답변의 마지막 문장에서 코멘트별 답장 줄을 뽑아 해당 스레드에
   * 올린다. 줄이 없는 코멘트는 보관 커밋의 유무로 두 문장 중 하나를 쓴다.
   * 모든 답장 끝에는 대리 표기가 붙고(O5), 본문은 생니타이저를 거친다.
   * lifecycle.autoReply 가 꺼져 있으면 답장만 건너뛴다 — 반영 턴 자체는 간다.
   */
  async settleReviewReplies(
    pr: number,
    reviews: DeveloperReview[],
    text: string,
    commit: string | null,
  ): Promise<void> {
    if (reviews.length === 0) return;
    if (this.deps.autoReply?.() === false) return;
    const client = this.deps.github();
    const slug = this.deps.slug();
    if (client === null || slug === null) return;
    const ids = this.claimReviewReplies(
      pr,
      reviews.map((review) => review.id),
    );
    if (ids.length === 0) return;
    const lines = extractDeveloperReplies(text, ids);
    const footer = replyFooter(this.deps.authorName?.() ?? null);
    for (const id of ids) {
      const review = reviews.find((entry) => entry.id === id);
      if (review === undefined) continue;
      const line = lines.get(id);
      const body =
        line !== undefined
          ? line
          : commit !== null
            ? `반영했습니다 · ${commit.slice(0, 7)}`
            : "확인했고 바꾼 것은 없습니다";
      const withFooter = sanitizeText(`${body}\n\n${footer}`);
      try {
        if (review.kind === "inline") {
          await client.replyToPullComment({ ...slug, number: pr, commentId: id, body: withFooter });
        } else {
          await client.commentOnIssue({ ...slug, number: pr, body: withFooter });
        }
      } catch (error) {
        // 답장 실패는 조용히 — 다시 시도하지 않는다(찜이 이미 원장에 있다).
        this.log(
          `코멘트 답장 실패(#${id}, 다시 시도하지 않음): ${detailOf(error, this.deps.core.pat)}`,
        );
      }
    }
  }

  /**
   * L9 반려 — 닫힌 PR 의 이유를 모아 새 사이클 브랜치의 반영 턴으로 넘긴다.
   * 이유는 닫힘 전후의 마지막 요청 코멘트와 마지막 리뷰 본문(봇 · 내 로그인
   * 제외, 닫힘 시각 이전 7일 안)이다. 이유가 없으면 턴을 열지 않고 닫힌 PR 에
   * 이유를 청구하는 코멘트 하나를 남긴다 — AI 가 짐작으로 고치지 않게. 둘 다
   * 원장 reviews[pr] 에 적힌다: 이유는 pendingRejection 으로(턴은 14b행이
   * 예산 review:<pr> 안에서 보내고, 보낸 뒤에 지운다), 청구는 rejectionAsked 로
   * 한 번뿐이다.
   */
  private async briefRejection(pr: number): Promise<void> {
    const client = this.deps.github();
    const slug = this.deps.slug();
    if (client === null || slug === null) return;

    // 닫힘 시각 — 착지 뒤 레지스트리는 이미 손을 놓았으므로 PR 을 직접 읽는다.
    // 못 읽으면 지금이 닫힘 직후라고 본다(창이 넉넉해지는 쪽으로만 어긋난다).
    let closedAt = this.now();
    try {
      const detail = await client.getPullRequest({ ...slug, number: pr });
      const parsed = Date.parse(detail.closedAt ?? "");
      if (Number.isFinite(parsed)) closedAt = parsed;
    } catch {
      // 닫힘 시각을 모른 채로 계속한다.
    }
    const since = closedAt - REJECTION_REASON_WINDOW_MS;
    const mine = await client
      .whoAmI()
      .then((who) => (who.ok ? who.login : ""))
      .catch(() => "");
    // 목록 읽기가 이미 봇을 거른다(github.ts) — 여기서는 내 로그인과 창만 본다.
    const reasons: DeveloperReview[] = [];
    const pick = (row: Record<string, any>, at: string) => {
      const body = String(row.body ?? "").trim();
      const when = Date.parse(at);
      if (body === "" || !Number.isFinite(when) || when < since) return;
      if (mine !== "" && String(row.user?.login ?? "") === mine) return;
      reasons.push({
        id: Number(row.id),
        kind: "review",
        author: String(row.user?.login ?? ""),
        body,
        pr,
        at,
      });
    };
    // 마지막 것만이 이유다 — 닫힘 전후의 말 중 가장 최근이 개발자의 결론이다.
    const lastOf = async (
      rows: Array<Record<string, any>>,
      at: (row: Record<string, any>) => string,
    ): Promise<void> => {
      let last: Record<string, any> | null = null;
      let lastAt = "";
      for (const row of rows) {
        const when = Date.parse(at(row));
        if (!Number.isFinite(when)) continue;
        if (last === null || when >= Date.parse(lastAt)) {
          last = row;
          lastAt = at(row);
        }
      }
      if (last !== null) pick(last, lastAt);
    };
    try {
      await lastOf(await client.listIssueComments({ ...slug, number: pr }), (row) =>
        String(row.created_at ?? ""),
      );
      await lastOf(await client.listReviews({ ...slug, number: pr }), (row) =>
        String(row.submitted_at ?? ""),
      );
    } catch {
      // 이유 읽기에 실패하면 없는 것으로 본다 — 청구 코멘트가 대신 선다.
      reasons.length = 0;
    }
    if (reasons.length === 0) {
      await this.askRejectionReason(pr, client, slug);
      return;
    }
    // 보내기 전에 적는다 — 착지는 다시 오지 않으므로, 대화를 못 열거나 그
    // 사이에 끊겨도 이 기록이 반영 턴을 살린다(14b행이 보낸다).
    this.updateReviewEntry(pr, (prev) => ({
      ...prev,
      pendingRejection: { reasons, since: new Date(this.now()).toISOString() },
    }));
    this.log(`반려 이유 ${reasons.length}건을 반영 대기로 적었습니다 — PR #${pr}`);
  }

  /**
   * 14b행의 보내기 — 반려 이유 반영 턴. 세션을 여는 일이라 차선 밖에서 (PLAN
   * L1). 대화를 못 열었거나(null) 열기 · 보내기가 던지면 false — 기록이 남아
   * 다음 틱이 다시 보낸다.
   */
  private async sendRejectionTurn(reasons: DeveloperReview[]): Promise<boolean> {
    const brief = reviewToTurn(reasons, {
      intro:
        "개발자가 이번 요청을 닫았습니다. 아래 이유를 반영해 고쳐 주세요. 다음 제출은 사용자가 합니다.",
    });
    return await this.deps.core.lane.outside(async () => {
      try {
        const thread = await this.deps.openThread("반려 반영");
        if (thread === null) return false;
        thread.send(brief);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** 반려 반영 턴이 실제로 나갔다 — 원장의 대기 기록을 지운다. */
  private clearPendingRejection(pr: number): void {
    if (this.ledger.reviews[String(pr)]?.pendingRejection === undefined) return;
    this.updateReviewEntry(pr, ({ pendingRejection: _sent, ...rest }) => rest);
  }

  /** 반려 이유가 없을 때의 청구 — 닫힌 PR 에 코멘트 하나, 원장에 한 번만. */
  private async askRejectionReason(
    pr: number,
    client: GitHubClient,
    slug: { owner: string; repo: string },
  ): Promise<void> {
    // 표식은 notices 가 아니라 reviews[pr] 에 둔다 — notices 는 서 있는 개발자
    // 알림이라 주의의 재료다(PLAN L8). 거기 두면 반려 한 번 뒤로 화면이 영원히
    // "개발자에게 알렸어요" 를 말한다.
    if (this.ledger.reviews[String(pr)]?.rejectionAsked === true) return;
    try {
      await client.commentOnIssue({
        ...slug,
        number: pr,
        body: "반려 이유를 남겨 주시면 AI 가 반영해 새 요청으로 다시 보냅니다. — Colo Design",
      });
    } catch (error) {
      this.log(`반려 이유 청구 실패(다시 시도하지 않음): ${detailOf(error, this.deps.core.pat)}`);
    }
    this.updateReviewEntry(pr, (prev) => ({ ...prev, rejectionAsked: true }));
  }

  /** reviews[pr] 한 항목을 고쳐 쓴다 — 없으면 빈 장부에서 시작한다. */
  private updateReviewEntry(
    pr: number,
    change: (prev: CycleLedger["reviews"][string]) => CycleLedger["reviews"][string],
  ): void {
    const key = String(pr);
    const prev = this.ledger.reviews[key] ?? { known: [], briefed: [], rounds: 0 };
    this.ledger = { ...this.ledger, reviews: { ...this.ledger.reviews, [key]: change(prev) } };
    writeLedger(this.ledgerPath, this.ledger);
  }

  /**
   * 미뤄 둔 원격 브랜치 삭제 (PLAN L4) — 12행 푸시가 새 브랜치를 무사히
   * 올린 뒤에야 옛 병합 브랜치를 지운다. 표식을 먼저 지우고 지운다:
   * 삭제 실패는 삼키고 로그만 남기며, 다음 틱이 같은 실패를 되풀이하지
   * 않게한다.
   */
  private async cleanupDeferredRemoteBranches(pushedBranch: string): Promise<void> {
    const core = this.deps.core;
    const due = this.ledger.branches.filter(
      (entry) => entry.deleteRemoteAfterPush === pushedBranch,
    );
    if (due.length === 0) return;
    if (!(this.deps.deleteMergedBranches?.() ?? true)) return;
    this.ledger = {
      ...this.ledger,
      branches: this.ledger.branches.map((entry) => {
        if (entry.deleteRemoteAfterPush !== pushedBranch) return entry;
        const { deleteRemoteAfterPush: _drop, ...rest } = entry;
        return rest;
      }),
    };
    writeLedger(this.ledgerPath, this.ledger);
    for (const entry of due) {
      const remote = await core
        .git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${entry.name}`])
        .catch(() => "");
      if (remote.trim() === "") continue;
      await core.git(["push", "origin", "--delete", entry.name]).catch((error) => {
        this.log(`원격 브랜치 정리 실패(삼킴): ${detailOf(error, core.pat)}`);
      });
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
      // 이월이 올라갔다 — 미뤄 둔 옛 원격 브랜치 삭제를 이제 한다(PLAN L4).
      await this.cleanupDeferredRemoteBranches(branch);
      // 성공은 판정을 다시 돌지 않고도 밀림 알림을 거둔다 — push 가 null 이
      // 되면 조정이 resolve 를 내지 않으므로 여기서 푼다. DeveloperNotice 가
      // 있으면 원격 갱신(코멘트 해결 표식 · 이슈 닫기)까지 간다.
      if (this.ledger.notices["push:behind"] || this.ledger.notices["push:auth"]) {
        if (this.deps.resolveNotice) {
          if (this.ledger.notices["push:behind"]) this.deps.resolveNotice("push:behind");
          if (this.ledger.notices["push:auth"]) this.deps.resolveNotice("push:auth");
        } else {
          const notices = { ...this.ledger.notices };
          delete notices["push:behind"];
          delete notices["push:auth"];
          this.ledger = { ...this.ledger, notices };
          writeLedger(this.ledgerPath, this.ledger);
        }
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

  // ————— 13행 — 제출의 네 단계 (PLAN L6 · 단계 6) —————

  /**
   * 제출 의도를 네 단계(보관 → 푸시 → PR → 리뷰어)로 끝까지 간다. 각 단계는
   * 멱등이고 한 틱에 가능한 데까지 진행하며, 막힌 단계는 의도를 남긴 채
   * false 로 틱을 멈춘다 — 다음 틱이 같은 단계부터 이어받는다. 네 단계가 모두
   * 서면 의도를 지운다.
   */
  private async submitStep(): Promise<boolean> {
    const core = this.deps.core;
    const intent = this.ledger.submit;
    if (intent === null) return true;

    // 턴이 도는 동안은 반쪽 작업을 보관하지 않는다(5행과 같은 규칙) — 의도는
    // 남고 turn-idle 틱이 이어받는다. 채팅 도구가 턴 안에서 제출을 부른 세계다.
    // 1) ensureCommitted — 남은 변경 보관. 충돌 정리 중이면 L5 가 끝날 때까지 기다린다.
    if (this.ledger.pendingOp !== null) return false;
    const dirty = (await core.git(["status", "--porcelain"]).catch(() => "?")).trim() !== "";
    if (dirty) {
      const saved = await this.deps.workspace.save({
        message: "작업 이어 보관",
        backgroundPush: true,
        // 보관의 게이트 브리프 — save 의 이 문은 동기라 기다리지 못한다. 열기 ·
        // 보내기의 실패는 여기서 삼킨다(처리되지 않은 거절이 데몬을 넘어뜨리지 않게).
        onSessionTurn: (brief) => {
          void core.lane.outside(async () => {
            try {
              (await this.deps.openThread("제출 마저하기"))?.send(brief);
            } catch {
              // 못 연 대화는 옛 길(null)과 같다 — 실패 단계는 save 가 이미 적었다.
            }
          });
        },
      });
      if (saved.stage !== "published") {
        if (saved.detail === SAVE_CONFLICT_OPEN_DETAIL) return false; // 2행이 브리프한다.
        return this.failSubmitStep("commit", saved.detail ?? "보관에 실패했습니다");
      }
    }
    const branch = core.branch;
    if (!branch) {
      // 사이클도 보관할 것도 없다 — 사용자 문장은 save 의 saveBlocked 카드가
      // 이미 냈다. 의도만 지운다(다시 누르면 같은 문장이 다시 선다).
      this.clearSubmitIntent();
      core.setDiff({
        stage: "failed",
        gate: "pr",
        detail: "제출할 변경사항이 없습니다 — 먼저 화면을 만들거나 고쳐 주세요.",
      });
      return false;
    }

    // 2) ensurePushed — 로컬 = 원격까지. 실패의 기록 · 백오프 · 알림(push:auth ·
    // push:behind)은 12행의 원장 push 가 소유한다 — 이 단계는 그 창을 존중한다.
    core.setDiff({ stage: "handing-off" });
    const onRemote = (
      await core.git(["rev-parse", "--verify", `refs/remotes/origin/${branch}`]).catch(() => "")
    ).trim();
    const waiting =
      onRemote === ""
        ? -1
        : Number(
            (
              await core
                .git(["rev-list", "--count", `origin/${branch}..${branch}`])
                .catch(() => "-1")
            ).trim(),
          );
    if (onRemote === "" || waiting !== 0) {
      const push = this.ledger.push;
      if (push !== null && Date.parse(push.nextAttemptAt) > this.now()) return false;
      try {
        await core.git(["push", "--set-upstream", "origin", branch]);
        this.ledger = recordPushResult(this.ledger, { ok: true }, this.now());
        writeLedger(this.ledgerPath, this.ledger);
        await this.cleanupDeferredRemoteBranches(branch);
      } catch (error) {
        this.ledger = recordPushResult(
          this.ledger,
          { ok: false, error: classifyPushError(error) },
          this.now(),
        );
        writeLedger(this.ledgerPath, this.ledger);
        this.log(`제출의 푸시 실패: ${detailOf(error, core.pat)}`);
        return false;
      }
    }

    // 3) ensurePullRequest — 열린 PR 보장. 4) ensureReviewers — 초대 파일의
    // 리뷰어(최선). 끝나면 의도를 지우고 사이클을 넘긴 상태로 적는다.
    const slug = core.repoSlug();
    const client = this.deps.github();
    if (!slug || !client) {
      return this.failSubmitStep("pr", "GitHub 에 닿을 수 없습니다 — 연결 코드를 확인해 주세요.");
    }
    try {
      const open = core.openHandoff;
      let pull: HandoffStatus | PullRequestRef | null =
        open &&
        open.branch === branch &&
        (open.state === "open" || open.state === "changes_requested")
          ? open
          : null;
      if (pull === null) {
        // 입양 — 레지스트리가 잃은 열린 요청을 head 로 찾는다. state=open 이므로
        // 끝난 요청(merged · closed)은 돌아오지 않는다: 끝난 요청은 PATCH 되지
        // 않고 새 요청으로만 이어진다(PLAN L4).
        const found = await client.findPullRequestByHead({
          ...slug,
          head: `${slug.owner}:${branch}`,
        });
        if (found && (found.state === "open" || found.state === "changes_requested")) pull = found;
      }
      const block = await this.submitToolBlock();
      let handoff: HandoffStatus;
      if (pull === null) {
        // 제목은 생성할 때만 정한다 — 입양 · 다시 제출에서는 개발자의 것이다.
        const draft = await this.deps.workspace
          .handoffDraft({ commentsFile: this.deps.commentsFile() })
          .catch(() => null);
        const opening = draft?.body?.trim() ? `${draft.body.trim()}\n\n` : "";
        handoff = await client.createPullRequest({
          ...slug,
          head: branch,
          base: core.baseBranch,
          title: await this.submitTitle(branch),
          body: `${opening}${block}`,
        });
      } else {
        // 본문은 도구 구간만 갱신한다. 호출 자체가 실패하면(current === null)
        // 덮어쓰지 않는다 — 개발자가 구간 밖에 쓴 글을 지키는 길이 이것뿐이다.
        // 빈 본문은 GitHub 이 null 로 돌려주는 정상 값이다: "" 로 보고 구간을
        // 쓴다(검토 결함 — null 을 실패로 읽어 입양한 PR 이 구간 없이 남았다).
        const current = await client
          .getPullRequest({ ...slug, number: pull.number })
          .catch(() => null);
        if (current === null) {
          handoff = pull;
        } else {
          const body = mergeToolBlock(current.body ?? "", block);
          handoff =
            (current.body ?? "") === body
              ? current
              : await client.updatePullRequest({ ...slug, number: pull.number, body });
        }
      }
      // 4) 리뷰어 — 요청한 목록이 바뀐 경우에만 다시 요청한다(최선 · 조용히).
      const reviewers = core.reviewers?.() ?? [];
      const asked = intent.reviewers ?? [];
      if (reviewers.length > 0 && asked.join("\u0000") !== reviewers.join("\u0000")) {
        await client.requestReviewers({ ...slug, number: handoff.number, reviewers });
        const fresh = this.ledger.submit;
        if (fresh !== null) {
          this.ledger = { ...this.ledger, submit: { ...fresh, reviewers } };
        }
      }
      // 네 단계가 모두 섰다 — 의도를 지우고, 성공은 예산도 되감는다(다음 제출은
      // 새 사건이다). 서 있던 submit:* 알림을 거둔다(PLAN L11).
      this.ledger = {
        ...this.ledger,
        submit: null,
        budgets: resetBudget(resetBudget(this.ledger.budgets, "submit:pr"), "submit:commit"),
      };
      writeLedger(this.ledgerPath, this.ledger);
      core.setCycle(branch, handoff);
      core.setDiff({ stage: "handed-off", handoff });
      this.deps.resolveNotice?.("submit:pr");
      this.deps.resolveNotice?.("submit:commit");
      const handedEvent: ChatEvent = {
        kind: "cycle.handed",
        at: new Date(this.now()).toISOString(),
        pr: handoff.number,
        ...(handoff.reviewers?.[0] ? { reviewer: handoff.reviewers[0] } : {}),
      };
      core.lane.outside(() =>
        this.deps.cycleEvent?.(handedEvent, this.submitSessionId ?? undefined),
      );
      this.log(`제출 완료: PR #${handoff.number}`);
      return true;
    } catch (error) {
      return this.failSubmitStep("pr", detailOf(error, core.pat));
    }
  }

  /** PR 본문의 도구 구간 — 캡처는 이때 잡는(미리보기가 살아 있는 동안). */
  private async submitToolBlock(): Promise<string> {
    const shots = await this.deps.captureShots().catch(() => []);
    return await this.deps.workspace.handoffToolBlock({
      commentsFile: this.deps.commentsFile(),
      ...(shots.length > 0 ? { shots } : {}),
    });
  }

  /** 생성할 때만 정하는 제목 — 초안 → 프로젝트 이름 · 첫 커밋 제목 → 기본. */
  private async submitTitle(branch: string): Promise<string> {
    const draft = await this.deps.workspace
      .handoffDraft({ commentsFile: this.deps.commentsFile() })
      .catch(() => null);
    const first = (
      await this.deps.core
        .git(["log", "--format=%s", "--reverse", `origin/${this.deps.core.baseBranch}..${branch}`])
        .catch(() => "")
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "");
    return pickHandoffTitle({
      draftTitle: draft?.title ?? null,
      projectName: this.deps.projectName(),
      firstCommitSubject: first ?? null,
      fallback: DEFAULT_HANDOFF_TITLE,
    });
  }

  /**
   * 단계 실패 — 예산을 쓰고 백오프를 적는다(간격은 푸시와 같은 backoffDelay).
   * 예산이 다하면 개발자 알림 한 번(L7): 시도는 백오프 간격으로 계속된다 —
   * "한 번 누르면 끝까지 간다"(L6)가 예산보다 앞선다.
   */
  private failSubmitStep(step: "commit" | "pr", reason: string): boolean {
    const key = `submit:${step}`;
    const spent = spend(this.ledger.budgets, key, BUDGETS.submitStep, this.now());
    this.ledger = { ...this.ledger, budgets: spent.ledger };
    const spentCount = this.ledger.budgets[key]?.spent ?? 1;
    const intent = this.ledger.submit;
    if (intent !== null) {
      this.ledger = {
        ...this.ledger,
        submit: {
          ...intent,
          step,
          attempts: spentCount,
          nextAttemptAt: new Date(
            this.now() + backoffDelay(spentCount, BUDGETS.push.baseMs, BUDGETS.push.capMs),
          ).toISOString(),
        },
      };
    }
    if (spent.exhausted && this.ledger.budgets[key]?.escalated !== true) {
      this.ledger = { ...this.ledger, budgets: markEscalated(this.ledger.budgets, key) };
      this.deps.raiseNotice(key, noticeText(key), reason);
    }
    writeLedger(this.ledgerPath, this.ledger);
    this.log(`제출 ${step} 단계 실패 (${spentCount}회 째): ${reason}`);
    return false;
  }

  /** 의도만 지운다 — 다른 원장 조각은 그대로. */
  private clearSubmitIntent(): void {
    if (this.ledger.submit === null) return;
    this.ledger = { ...this.ledger, submit: null };
    writeLedger(this.ledgerPath, this.ledger);
  }

  // ————— 손상 행 — 재클론 (PLAN 단계 9) —————

  /**
   * 재클론의 앞 걸음 — 구해 두기 → 미리보기 멈춤 → 옛 클론 옮기기 → 새로 받기.
   * 걸음마다 원장 reclone 에 적어, 어디서 끊겨도 다음 틱이 남은 걸음부터 잇는다.
   * 구해 두기나 옮기기가 실패하면 옛 클론을 그대로 두고 개발자에게 알린 뒤
   * 멈춘다(절차를 지우고 예산을 다 쓴 것으로 적어 틱마다 되풀이하지 않는다).
   * 새로 받기는 설치 · 미리보기가 따라오므로 차선 밖에서 띄우고 그 틱을 멈춘다
   * — 받기가 끝나면 다음 틱(reclone)이 되살린다.
   */
  private async reclone(): Promise<boolean> {
    const core = this.deps.core;
    const record = this.ledger.reclone;
    if (record === null) return true;
    // 준비가 도는 중(설치 · 미리보기 기동)에는 폴더를 옮기지 않는다 — 다음 틱.
    if (core.inFlight !== null) return false;
    const stamp = salvageStamp(Date.parse(record.at) || this.now());
    const parent = dirname(core.root);
    let salvage = record.salvage;
    if (salvage === null) {
      try {
        salvage = await salvageClone(core, join(parent, "salvage", stamp), core.branch);
      } catch (error) {
        this.stopReclone(`구해 두기에 실패해 다시 받지 않았습니다 — ${detailOf(error, core.pat)}`);
        return false;
      }
      this.setReclone({ ...record, salvage });
      this.log(`재클론: 작업을 ${salvage.dir} 에 구해 뒀습니다`);
    }
    if (record.movedTo === null) {
      const target = join(parent, `${basename(core.root)}.corrupt-${stamp}`);
      // 옮긴 뒤 원장에 적기 전에 끊긴 실행 — 옮긴 자리가 있고 클론이 없으면 옮긴 것이다.
      if (!(existsSync(target) && !existsSync(core.root))) {
        await this.deps.workspace.stop();
        try {
          renameSync(core.root, target);
        } catch (error) {
          this.stopReclone(
            `손상된 클론을 옮기지 못했습니다 — ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      }
      this.setReclone({ ...record, salvage, movedTo: target });
      this.log(`재클론: 손상된 클론을 ${target} 로 옮겼습니다 (지우지 않는다)`);
    }
    const workspace = this.deps.workspace;
    core.lane.outside(() => {
      void workspace.sync().finally(() => void this.tick("reclone"));
    });
    return false;
  }

  /**
   * 재클론의 뒷걸음 — 새 클론에 구해 둔 것을 되살린다. 성공이든 아니든 새 클론은
   * 멀쩡하므로 절차와 손상 기록을 지우고 clone:corrupt 를 거둔다. 다시 얹지
   * 못한 것은 clone:restore 로 개발자에게 — 구해 둔 폴더의 자리를 자세히에 싣는다.
   */
  private async restoreFromSalvage(): Promise<boolean> {
    const core = this.deps.core;
    const record = this.ledger.reclone;
    if (record === null) return true;
    // 준비가 아직 설치 · 기동 중이다 — 끝나면 reclone 틱이 다시 부른다. 설치 중의
    // checkout 은 설치 표식을 어긋나게 쓴다(끝난 뒤의 해시를 적는다).
    if (core.inFlight !== null) return false;
    const failure = record.salvage === null ? null : await restoreSalvage(core, record.salvage);
    this.ledger = { ...this.ledger, reclone: null, corrupt: null };
    writeLedger(this.ledgerPath, this.ledger);
    this.resolveNoticeKey("clone:corrupt");
    if (failure !== null) {
      this.deps.raiseNotice(
        "clone:restore",
        noticeText("clone:restore"),
        `${failure}\n구해 둔 폴더: ${record.salvage?.dir ?? "(없음)"}`,
      );
      this.log(`재클론: ${failure}`);
    } else {
      this.log("재클론: 새 클론에 구해 둔 작업을 되살렸습니다");
    }
    await core.refreshPendingChanges().catch(() => undefined);
    return true;
  }

  /** 원장의 재클론 절차를 갈아 적는다. */
  private setReclone(record: NonNullable<CycleLedger["reclone"]>): void {
    this.ledger = { ...this.ledger, reclone: record };
    writeLedger(this.ledgerPath, this.ledger);
  }

  /**
   * 재클론을 멈춘다 — 옛 클론은 그대로 두고(손상 기록도 남긴다) 절차를 지운 뒤,
   * 예산을 다 쓴 것으로 적어 손상 행이 같은 알림을 다시 올리지 않게 한다.
   * 예산의 창(하루)이 지나면 손상 행이 다시 시도한다.
   */
  private stopReclone(reason: string): void {
    this.ledger = {
      ...this.ledger,
      reclone: null,
      budgets: markEscalated(this.ledger.budgets, "reclone"),
    };
    writeLedger(this.ledgerPath, this.ledger);
    this.deps.raiseNotice("clone:corrupt", noticeText("clone:corrupt"), reason);
    this.log(`재클론: ${reason}`);
  }

  /** 서 있는 알림 하나를 거둔다 — DeveloperNotice 가 없는 실행(시험)은 원장에서만. */
  private resolveNoticeKey(key: string): void {
    if (!this.ledger.notices[key]) return;
    if (this.deps.resolveNotice) {
      this.deps.resolveNotice(key);
      return;
    }
    const notices = { ...this.ledger.notices };
    delete notices[key];
    this.ledger = { ...this.ledger, notices };
    writeLedger(this.ledgerPath, this.ledger);
  }

  // ————— 16행 — 위생 (PLAN 단계 9) —————

  /**
   * 기한이 지난 항목만 차례(HYGIENE_ORDER)대로 한 번씩 돈다. 항목마다 시도한
   * 뒤(성공 · 실패 무관) 원장의 시각을 갱신한다 — 계속 실패하는 항목이 2분마다
   * 다시 도는 일을 막는다. 모든 git 은 이 틱의 차선 칸 안에서 돈다.
   */
  private async hygiene(): Promise<boolean> {
    const core = this.deps.core;
    const now = this.now();
    const due = new Set(dueHygiene(this.ledger.hygiene, now));
    // 디스크 (O8) — 여유가 문턱 아래면 도구의 것(끝난 브랜치 · 임시 파일 · git
    // 정리)을 기한과 무관하게 한 번 치운다. 다시 본 여유는 맨 끝에서 판정한다.
    let diskBefore: number | null = null;
    if (due.has("disk")) {
      diskBefore = await this.freeDiskBytes();
      if (diskBefore !== null && diskBefore < DISK_LOW_BYTES) {
        this.log(`위생: 디스크 여유가 ${gigabytes(diskBefore)} — 도구의 것부터 치웁니다`);
        due.add("prune");
        due.add("gc");
      }
      this.stampHygiene("disk", now);
    }
    if (due.has("prune")) {
      await this.pruneEndedBranches(now);
      const removed = pruneTempFolders(core.root, now);
      if (removed > 0) this.log(`위생: 7일 넘은 임시 파일 ${removed}개를 치웠습니다`);
      this.stampHygiene("prune", now);
    }
    if (due.has("gc")) {
      // autoDetach 끔 — 뒤에서 도는 gc 는 차선을 비켜 다음 쓰기와 겹친다.
      await core
        .git(["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet"])
        .catch((error) => this.log(`위생: gc 실패(삼킴): ${detailOf(error, core.pat)}`));
      this.stampHygiene("gc", now);
    }
    if (due.has("fsck")) {
      const broken = await fsckClone(core);
      if (broken !== null) {
        this.log(`위생: fsck 가 손상을 봤습니다 — ${broken}`);
        // 손상 신호는 원장에 — 조정 표의 손상 행이 읽는다(재클론).
        if (this.ledger.corrupt === null) {
          this.ledger = {
            ...this.ledger,
            corrupt: { since: new Date(now).toISOString(), detail: broken },
          };
        }
      }
      this.stampHygiene("fsck", now);
    }
    if (due.has("assets")) {
      const measured = await measureAssets(core);
      if (measured !== undefined) {
        const { assets: _old, ...rest } = this.ledger.hygiene;
        this.ledger = {
          ...this.ledger,
          hygiene: measured === null ? rest : { ...rest, assets: measured },
        };
      }
      this.stampHygiene("assets", now);
    }
    // 저장소 이동은 origin 을 바꾼다 — origin 을 쓰는 위의 항목들이 모두 끝난 뒤.
    if (due.has("move")) {
      await this.followRepoMove();
      this.stampHygiene("move", now);
    }
    if (diskBefore !== null) await this.judgeDisk(diskBefore);
    return true;
  }

  /**
   * 치운 뒤의 디스크 판정 (O8) — 그래도 문턱 아래면 기계 전체 알림 disk:low 를
   * 올린다(개발자 쪽 Slack · 로그만, 화면 주의는 서지 않는다 — 사용자 기계의
   * 일이라 개발자도 고칠 수 없다). 여유가 돌아왔으면 서 있던 알림을 거둔다.
   */
  private async judgeDisk(before: number): Promise<void> {
    const after = before < DISK_LOW_BYTES ? await this.freeDiskBytes() : before;
    if (after === null) return;
    if (after < DISK_LOW_BYTES) {
      const detail = `디스크 여유 ${gigabytes(after)} (치우기 전 ${gigabytes(before)}) — 문턱 ${gigabytes(DISK_LOW_BYTES)}`;
      this.log(`위생: 치운 뒤에도 ${detail}`);
      this.deps.raiseMachineNotice?.("disk:low", detail);
      return;
    }
    this.deps.resolveMachineNotice?.("disk:low");
  }

  /** 여유 바이트 — 읽지 못하면 null(판정하지 않는다). */
  private async freeDiskBytes(): Promise<number | null> {
    const read = this.deps.statfs ?? ((path: string) => statfs(path));
    try {
      return freeBytesOf(await read(this.deps.dataDir ?? COLO_DESIGN_DIR));
    } catch {
      return null;
    }
  }

  /**
   * 저장소 이동 (PLAN 단계 9) — GitHub 이 말하는 full_name 이 레지스트리의
   * owner/repo 와 다르면(이름을 바꿨거나 다른 조직으로 옮겼다) origin 과
   * 레지스트리의 주소만 새 이름으로 옮긴다. 다시 클론하지 않는다: 주소를
   * 바꾸는 project.update 의 길(repo.ts 의 RepoWorkspace.update)은 새 주소를 다른
   * 저장소로 읽어 클론을 지우고 — 커밋 안 된 변경과 올라가지 않은 커밋까지 —
   * 사이클(열린 PR)을 잊은 채 새로 받는다. 옮겨진 저장소는 같은 저장소라 역사와
   * PR 번호가 그대로이고 바뀐 것은 주소뿐이다. GitHub 은 옛 주소를 한동안 새
   * 주소로 되돌려 주지만, 옛 이름으로 새 저장소가 생기는 순간 그 되돌림은 끊긴다.
   */
  private async followRepoMove(): Promise<void> {
    const core = this.deps.core;
    const slug = this.deps.slug();
    const client = this.deps.github();
    const url = core.url;
    if (slug === null || client === null || url === null) return;
    const fullName = await client.inspectRepo(slug).then(
      (inspection) => inspection.fullName ?? null,
      () => null,
    );
    // 이름의 대소문자만 다른 것은 같은 저장소다 — GitHub 주소는 대소문자를 가리지 않는다.
    if (
      fullName === null ||
      fullName.toLowerCase() === `${slug.owner}/${slug.repo}`.toLowerCase()
    ) {
      return;
    }
    const next = movedRepoUrl(url, fullName);
    if (next === null || next === url) return;
    try {
      await core.git(["remote", "set-url", "origin", next]);
    } catch (error) {
      this.log(`위생: origin 주소를 옮기지 못했습니다 — ${detailOf(error, core.pat)}`);
      return;
    }
    // 레지스트리는 fleet 의 onUrlChange 가 적는다 — 주소를 적는 유일한 자리다.
    core.url = next;
    core.onUrlChange?.(next);
    core.emit();
    this.log(`위생: 저장소가 ${fullName} 로 옮겨져 origin 과 레지스트리의 주소를 옮겼습니다`);
  }

  /** 위생 항목의 시각을 찍고 원장을 쓴다 — 항목 사이에 끊겨도 한 일은 남는다. */
  private stampHygiene(item: HygieneItem, now: number): void {
    const key: HygieneStamp = `${item}At`;
    this.ledger = {
      ...this.ledger,
      hygiene: { ...this.ledger.hygiene, [key]: new Date(now).toISOString() },
    };
    writeLedger(this.ledgerPath, this.ledger);
  }

  /**
   * 끝난 브랜치 정리 (PLAN L4 · O3) — keepRejectedDays 가 지난 반려 브랜치를
   * 로컬 · 원격에서 지우고 원장에서 뺀다. 원격 삭제의 실패는 삼키되, 네트워크
   * 실패만은 원장에 남겨 다음 날 다시 한다(원격에 닿지 못한 것은 지운 것이
   * 아니다). 병합의 지연 삭제 표식은 12행의 것이라 건드리지 않고, 표식 없는
   * 병합 기록은 원장에서만 걷는다.
   */
  private async pruneEndedBranches(now: number): Promise<void> {
    const core = this.deps.core;
    const keepDays = this.deps.keepRejectedDays?.() ?? DEFAULT_KEEP_REJECTED_DAYS;
    const { rejected, staleMerged } = endedBranchesDue(this.ledger.branches, keepDays, now);
    if (rejected.length === 0 && staleMerged.length === 0) return;
    const drop = new Set(staleMerged);
    for (const entry of rejected) {
      // 랜딩이 로컬을 이미 지웠으면 조용히 지나간다.
      await core.git(["branch", "-D", entry.name]).catch(() => "");
      const outcome = await core.git(["push", "origin", "--delete", entry.name]).then(
        () => "ok" as const,
        (error: unknown) => classifyPushError(error),
      );
      if (outcome === "network") {
        this.log(`위생: 반려 브랜치 ${entry.name} 의 원격 삭제를 다음으로 미룹니다(네트워크)`);
        continue;
      }
      drop.add(entry);
      this.log(`위생: ${keepDays}일 지난 반려 브랜치 ${entry.name} 를 정리했습니다`);
    }
    this.ledger = {
      ...this.ledger,
      branches: this.ledger.branches.filter((entry) => !drop.has(entry)),
    };
    writeLedger(this.ledgerPath, this.ledger);
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
