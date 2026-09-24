// 차선 (PLAN L1): 프로젝트마다 하나인 git 쓰기의 줄. 클론을 바꾸는 모든 git
// 명령은 이 줄에 서서 하나씩 돈다 — 약속 슬롯(inFlight · publishing ·
// refreshing · shelving)을 손으로 기다리던 질서의 대체품이고, 슬롯 없이 돌던
// 랜딩 · 보관본 복구 · 배경 푸시 · 준비의 최신화까지 같은 줄에 태운다.
//
// 이 모듈은 형제를 import 하지 않는다 — 순수하게 유지해 시험이 `../src` 에서
// 곧바로 싣는다(형제를 `.js` 로 부르는 모듈은 dist 를 거쳐야 한다).
import { AsyncLocalStorage } from "node:async_hooks";

/** 차선 작업의 이름 — 관찰(누가 줄을 잡았나)과 합류 짝짓기에 쓰인다. */
export type LaneKind =
  | "save"
  | "submit"
  | "refresh"
  | "land"
  | "push"
  | "restore"
  | "recover"
  | "diff"
  | "preview"
  | "hygiene"
  | "supervise";

/** 작업 문맥의 표식 — 차선의 "지금 도는 작업" 목록과 겹쳐야 holding 이다. */
interface LaneContext {
  token: symbol;
}

/** 줄의 항목 — 시작 게이트가 열리기를 기다리는, 아직 시작하지 않은 작업. */
interface LaneEntry {
  kind: LaneKind;
  promise: Promise<unknown>;
  open: () => void;
}

export class GitLane {
  /**
   * "지금 이 차선의 작업 안" 의 문맥 (PLAN L1). 문맥은 작업이 시작한 사슬에
   * 그대로 번지지만, 표식의 수명은 작업의 수명이다 — 끝난 작업의 문맥을
   * 물려받은 사슬(콜백이 살려 둔 세션 · 타이머)은 더 이상 holding 이 아니다.
   */
  private readonly inside = new AsyncLocalStorage<LaneContext>();
  private readonly queue: LaneEntry[] = [];
  private runningKind: LaneKind | null = null;
  private idleWaiters: Array<() => void> = [];
  /** 지금 실제로 도는 작업의 표식 — callJob 에서 더하고 작업이 끝나면 뺀다. */
  private readonly liveTokens = new Set<symbol>();

  /**
   * 작업 하나를 줄에 세운다. FIFO — 도는 작업이 없으면 즉시 시작한다.
   *
   * - 재진입: 이미 이 차선의 작업 안에서 불리면 줄에 서지 않고 그 자리에서
   *   곧바로 실행한다. 이게 없으면 감독자의 틱 안에서 부르는 save 처럼
   *   작업 안의 작업이 자기 줄을 기다리며 교착한다.
   * - 합류(join): 같은 종류의 작업이 아직 시작하지 않고 줄에 있으면 그 약속을
   *   돌려준다 — 보관을 두 번 부르면 한 번만 돈다. 이미 도는 작업에는 합류하지
   *   않는다: 도는 보관 뒤에 생긴 변경은 다음 보관이 담아야 한다. 합류는 같은
   *   종류가 같은 결과 모양을 돌려준다는 호출자의 약속 위에 있다.
   */
  run<T>(kind: LaneKind, job: () => Promise<T>, opts?: { join?: boolean }): Promise<T> {
    if (this.holding) {
      // 재진입: 새 표식을 만들지 않는다 — 바깥 작업의 문맥과 수명을 그대로
      // 탄다. 안쪽 작업이 끝나도 바깥이 도는 동안엔 여전히 holding 이다.
      return Promise.resolve().then(job);
    }
    if (opts?.join) {
      const waiting = this.queue.find((entry) => entry.kind === kind);
      if (waiting) return waiting.promise as Promise<T>;
    }
    const gate = Promise.withResolvers<void>();
    const promise = gate.promise.then(() => this.callJob(job));
    this.queue.push({ kind, promise, open: gate.resolve });
    this.pump();
    return promise;
  }

  /**
   * 나가는 문 — 차선 작업 안에서 git 밖으로 나가는 콜백을 문맥 없이 부른다.
   * 콜백이 세션을 만들거나(fleet·dispatch 의 자동 브리프) 사슬을 오래 살리면,
   * 그 사슬이 작업의 문맥을 물려받아 holding 인 체하며 줄을 비켜가는 일을
   * 여기서 끊는다. 동기 함수도 받는다 — 반환값은 그대로 흘러간다.
   */
  outside<T>(fn: () => T): T {
    return this.inside.exit(fn);
  }

  /** 지금 도는 작업의 종류 — 도는 것이 없으면 null. */
  get current(): LaneKind | null {
    return this.runningKind;
  }

  /**
   * 지금 이 호출이 이 차선의 작업 안에서 돌고 있는가. 문맥만으로는 답하지
   * 않는다: 끝난 작업이 번져 준 문맥(표식이 이미 목록에서 빠졌다)은 거짓이다.
   */
  get holding(): boolean {
    const store = this.inside.getStore();
    return store !== undefined && this.liveTokens.has(store.token);
  }

  /** 줄이 빌 때 풀린다 — 종료·정리(settle)가 기다리는 문. */
  async idle(): Promise<void> {
    if (this.runningKind === null && this.queue.length === 0) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /**
   * 작업 몸통 — 문맥에 표식을 심고, 동기 throw 도 약속으로 받는다. 표식의
   * 수명이 작업의 수명이다: 작업이 끝나는(성공이든 실패든) 순간 목록에서
   * 빼, 그 뒤로 이어지는 사슬이 holding 인 체하지 않게 한다.
   */
  private callJob<T>(job: () => Promise<T>): Promise<T> {
    const token = Symbol("lane");
    this.liveTokens.add(token);
    return this.inside
      .run({ token }, () => Promise.resolve().then(job))
      .finally(() => {
        this.liveTokens.delete(token);
      });
  }

  private pump(): void {
    if (this.runningKind !== null) return;
    const next = this.queue.shift();
    if (next === undefined) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    this.runningKind = next.kind;
    next.open();
    // 한 작업의 실패는 그 호출자에게만 간다 — 줄은 다음 작업으로 넘어간다.
    void next.promise.then(
      () => this.finished(),
      () => this.finished(),
    );
  }

  private finished(): void {
    this.runningKind = null;
    this.pump();
  }
}

// ---------------------------------------------------------------------------
// 쓰기 판정 — 순수 함수
// ---------------------------------------------------------------------------

/**
 * 결과가 참이면 클론의 상태(refs · 인덱스 · 작업 트리)를 바꾸는 명령이다.
 * `RepoCore.git` 이 차선 위반을 판정하는 잣자리(session.ts 의 writesGitHistory
 * 와 같은 눈으로, 그 함수는 건드리지 않는다).
 *
 * 읽기 목록에 없는 동사는 쓰기로 둔다 — 놓친 쓰기가 줄을 비켜가는 것이 읽기
 * 한 번의 거짓 경고보다 비싸다(애매하면 쓰기).
 */
export function isGitWrite(args: string[]): boolean {
  return gitWriteVerb(args) !== null;
}

/** 쓰기면 그 동사를, 읽기면 null — 경고 문장이 동사를 말하게 하려고 나눴다. */
export function gitWriteVerb(args: string[]): string | null {
  const rest = argsAfterGlobals(args);
  const verb = rest[0];
  if (verb === undefined) return null; // 전역 옵션뿐인 호출 — 사용법 출력이 전부
  const tail = rest.slice(1);
  if (verb in GIT_WRITE_VERBS) return verb;
  if (verb in GIT_READ_VERBS) return null;
  switch (verb) {
    case "hash-object":
      // -w 없이는 객체를 계산만 한다.
      return tail.includes("-w") ? verb : null;
    case "symbolic-ref": {
      // 인자 하나(또는 플래그만)는 읽기 — 값까지 있으면 ref 를 심는 쓰기다.
      const operands = tail.filter((token) => !token.startsWith("-"));
      return operands.length >= 2 ? verb : null;
    }
    case "config": {
      // 조회형(--get* · --list · -l)만 읽기 — session.ts 의 writesGitHistory 와
      // 같은 보수적 판정: `config user.email` 처럼 키만 있는 호출도 쓰기로 본다.
      const readForm = /^(--get(-all|-regexp|-urlmatch|-color|-colorbool)?|--list|-l)$/;
      return tail.some((token) => readForm.test(token)) ? null : verb;
    }
    case "stash":
      // 맨 `stash` 는 push 와 같다.
      return tail[0] === "list" || tail[0] === "show" ? null : verb;
    case "tag": {
      const next = tail[0];
      return next !== undefined && next !== "-l" && next !== "--list" && !/^-n/.test(next)
        ? verb
        : null;
    }
    case "branch": {
      const next = tail[0];
      return next !== undefined &&
        next !== "--list" &&
        next !== "--show-current" &&
        !/^-[alrv]+$/.test(next)
        ? verb
        : null;
    }
    case "worktree":
      return tail[0] === "list" ? null : verb;
    case "remote": {
      const next = tail[0];
      // 맨 `remote` · `remote -v` 는 목록 — set-url 등이 쓰기다.
      return next !== undefined && next !== "get-url" && next !== "show" && !next.startsWith("-")
        ? verb
        : null;
    }
    default:
      // 모르는 동사 — 쓰기로 둔다.
      return verb;
  }
}
const GIT_WRITE_VERBS: Record<string, true> = {
  add: true,
  am: true,
  apply: true,
  checkout: true,
  "cherry-pick": true,
  clean: true,
  clone: true,
  commit: true,
  fetch: true, // refs 와 FETCH_HEAD 를 쓴다 — 동시 fetch 는 잠금 충돌이 난다
  gc: true,
  init: true,
  merge: true,
  mv: true,
  notes: true,
  pull: true,
  push: true,
  rebase: true,
  reset: true,
  restore: true,
  rm: true,
  revert: true,
  switch: true,
  "update-ref": true,
};

const GIT_READ_VERBS: Record<string, true> = {
  blame: true,
  "cat-file": true,
  "commit-tree": true, // 객체만 쓰고 ref 를 움직이지 않는다 (PLAN L1 의 표)
  describe: true,
  diff: true,
  "diff-tree": true, // headCommitFiles 가 턴 끝의 차선 밖에서 읽는다
  "for-each-ref": true,
  grep: true,
  log: true,
  "ls-files": true,
  "ls-remote": true,
  "ls-tree": true,
  "merge-base": true,
  "read-tree": true, // 위와 같은 이유 — 인덱스를 갈아끼우지만 ref 를 안 움직인다
  "rev-list": true,
  "rev-parse": true,
  show: true,
  status: true,
  "update-index": true, // 같은 이유 — 인덱스 파일만 쓰고 ref 를 안 움직인다
};

/** 전역 옵션(-C <dir> · -c k=v · --git-dir <dir> …)을 건너뛰고 동사 자리를 찾는다. */
function argsAfterGlobals(args: string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === undefined) break;
    if (
      token === "-C" ||
      token === "-c" ||
      token === "--git-dir" ||
      token === "--work-tree" ||
      token === "--namespace" ||
      token === "--super-prefix"
    ) {
      i += 2;
    } else if (token.startsWith("-")) {
      i += 1;
    } else {
      break;
    }
  }
  return args.slice(i);
}
