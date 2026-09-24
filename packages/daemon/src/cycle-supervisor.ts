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
 * - 아직 실행하지 않는 조치(land · mergeBase · pullRemoteBranch ·
 *   retargetBase · submitStep · briefReviews · reinstall · hygiene)는 로그 한
 *   줄만 남기고 그 틱을 멈춘다 — 다음 위임이 옮긴다.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type CycleLedger,
  type CyclePendingOp,
  emptyLedger,
  foldReviewLedger,
  readLedger,
  recordPushResult,
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
import { alignCycleBranch } from "./repo-publish.js";

export type TickReason =
  | "timer"
  | "turn-idle"
  | "before-send"
  | "start"
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
  "base-missing": "베이스 브랜치가 원격에 없습니다 — 반영된 것으로 보고 새 사이클을 엽니다",
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
  /** 알림 해소 — 지금은 원장에서 지우는 것뿐, 해결 알림은 보내지 않는다. */
  resolveNotice?: (key: string) => void;
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

      for (let round = 0; round < MAX_TICK_ROUNDS; round++) {
        const decision = nextCycleAction(snapshot, this.ledger);
        this.ledger = decision.ledger;
        this.lastAttention = decision.attention;
        writeLedger(this.ledgerPath, this.ledger);
        this.applyNotices(decision);
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

  /** fetch 는 틱마다가 아니다 — before-send · start 는 늘, timer 는 활성이면
   * 늘 · 비활성이면 10분에 한 번. 그 밖(turn-idle · tool-conflict · manual)은
   * 로컬 관찰만으로 판정한다. */
  private shouldFetch(reason: TickReason): boolean {
    if (reason === "before-send" || reason === "start") return true;
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
   * 조치 실행 — true 면 고리가 다시 판정하고, false 면 그 틱을 멈춘다.
   * 차선 작업 안에서 불리므로 save 같은 차선 호출은 재진입으로 즉시 돈다.
   */
  private async runAction(action: CycleAction, _snapshot: CycleSnapshot): Promise<boolean> {
    const core = this.deps.core;
    switch (action.kind) {
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
      default: {
        // land · mergeBase · pullRemoteBranch · retargetBase · submitStep ·
        // briefReviews · reinstall · hygiene — 이번 위임이 실행하지 않는
        // 조치는 로그만 남기고 멈춘다(다음 위임이 옮긴다).
        this.log(`아직 실행하지 않는 조치: ${action.kind}`);
        return false;
      }
    }
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
    try {
      if (existsSync(this.ledgerPath)) {
        return readLedger(readFileSync(this.ledgerPath, "utf8"));
      }
    } catch {
      // 깨진 원장은 빈 원장으로 — 복구는 멱등이다 (I5).
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
