/**
 * 명령 멱등 답변 (2026-09-22): the daemon answers one id once.
 *
 * 웹의 재시도가 같은 명령을 두 번 실행하지 않게 하는 데몬 쪽 절반. 같은 id의
 * 실행은 첫 도착자만 시작하고(도는 중 재도착은 같은 약속을 기다린다), 끝난
 * 실행의 답은 잠시 기억해 재전송에 되돌려준다. 타임아웃 뒤의 다시 보내기,
 * 소켓이 끊겼다 다시 붙은 뒤의 재전송, 더블클릭이 전부 이 한 곳에서 흡수된다
 * — 개별 명령의 실행부는 중복을 몰라도 된다.
 *
 * 답은 ok 와 error 를 다 함께 기억한다. 실패도 정산이다: 실패한 실행을
 * 재실행하면 git 커밋이나 PR 같은 부수효과가 두 번 닿을 수 있으므로, 재전송은
 * 같은 실패 답을 다시 보는 것이 옳다. 새로 시도는 새 id가 하는 일이다.
 *
 * 기억은 이 데몬 생애의 것이다 — 재시작 뒤의 재전송은 새 실행이 된다. 상한
 * 512·하루는 zcode 참조의 같은 값: 한 세션의 멱등 테이블 크기와 답의 수명.
 */

/** 정산(끝난) 답의 기억 — 도는 중인 약속은 `at` 이 아직 null 이다. */
interface Entry {
  readonly run: Promise<unknown>;
  /** 답이 정산된 데몬 시계(ms). 도는 중에는 null. */
  at: number | null;
}

export interface CommandDedupeOptions {
  /** 기억할 정산 답의 상한 — 넘치면 가장 오래된 정산부터 잊는다. */
  capacity?: number;
  /** 정산 답이 재전송에 답해 주는 수명. */
  ttlMs?: number;
  /** 테스트가 시계를 흘려 보내는 주사바늘. */
  now?: () => number;
}

export class CommandDedupe {
  private readonly entries = new Map<string, Entry>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options?: CommandDedupeOptions) {
    this.capacity = options?.capacity ?? 512;
    this.ttlMs = options?.ttlMs ?? 24 * 60 * 60 * 1000;
    this.now = options?.now ?? (() => Date.now());
  }

  /**
   * 같은 id 의 실행. 도는 중이면 그 약속을 그대로 돌려주고, 수명 안의 정산
   * 답이면 그것을 다시 돌려준다 — `task` 는 첫 도착자만 부른다. 수명이 지난
   * 정산 답은 잊힌 것으로, 새 실행이 된다.
   */
  run<T>(id: string, task: () => Promise<T>): Promise<T> {
    const seen = this.entries.get(id);
    if (seen !== undefined) {
      // 도는 중인 실행(at === null)은 수명과 무관하게 함께 기다린다.
      if (seen.at === null) return seen.run as Promise<T>;
      if (this.now() - seen.at <= this.ttlMs) {
        // LRU 접촉 — 답을 쓴 재전송이 그 자리를 다시 쓴다(오래된 것부터 잊는
        // 판정의 기준이 된다).
        this.entries.delete(id);
        this.entries.set(id, seen);
        return seen.run as Promise<T>;
      }
      this.entries.delete(id);
    }
    const run = this.start(id, task);
    this.entries.set(id, { run, at: null });
    this.evict();
    return run;
  }

  /** 지금 기억 중인 정산 답의 수 — 단위 검사의 창. */
  get settledSize(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.at !== null) count += 1;
    return count;
  }

  private start<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = task();
    // stamp 가 비교하는 것은 기억되는 약속(래핑된 것)이다 — 원시 run 이 아니라.
    let settled!: Promise<T>;
    const stamp = (): void => {
      // 사이에 잊혔으면(상한·수명) 손대지 않는다 — 새 실행의 자리다.
      const entry = this.entries.get(id);
      if (entry !== undefined && entry.run === settled) entry.at = this.now();
    };
    settled = run.then(
      (value) => {
        stamp();
        return value;
      },
      (error: unknown) => {
        stamp();
        throw error;
      },
    );
    return settled;
  }

  /** 상한 넘침 — 가장 오래된 정산부터 잊는다. 전부 도는 중이면 맨 앞 하나. */
  private evict(): void {
    while (this.entries.size > this.capacity) {
      let victim: string | null = null;
      for (const [key, entry] of this.entries) {
        if (entry.at !== null) {
          victim = key;
          break;
        }
      }
      const fallback = victim ?? this.entries.keys().next().value;
      if (fallback === undefined) return;
      this.entries.delete(fallback);
    }
  }
}
