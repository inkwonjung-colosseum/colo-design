/**
 * 턴 통계 (AI 작업 시간 측정, 2026-09-20): 한 턴이 끝날 때마다 사실 한 줄을
 * `~/.colo-design/logs/turn-stats-YYYY-MM-DD.jsonl` 에 남긴다.
 *
 * 무엇이 턴을 느리게 하는지는 측정이 먼저다 — 방향 잡기 tool call 수,
 * 브라우저 확인, 게이트 재시작, 컨텍스트 크기. 같은 날 네 필드가 갈라 들었다:
 * `firstEditMs`(방향 잡기: 첫 편집까지), `waitMs`(사람이 카드 앞에서 기다린
 * 시간 — durationMs 에서 갈라 낸다), `scanMs`(보내기 문에서 핀 강화가 걸린
 * 시간), `sincePrevTurnMs`(이전 턴 종료 뒤 재보내기의 틈 — 교정 턴의 재료).
 * 게이트는 turn.end 뒤에야 판정이 나오므로 턴 행이 아닌 제 행(kind
 * "gateset")으로 내려앉는다. 이 측정은 `undo.jsonl` 과 같은 결이다: 종류와
 * 숫자만 남고, 사용자의 말·화면·파일 이름은 조금도 남지 않는다. 로그가 도구를
 * 죽일 수는 없다 — 무엇을 써도 조용히 삼킨다.
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChatEvent } from "@colo-design/protocol";
import { daemonLogDir } from "./log.js";

/** 보존 일수 — 데몬 하루 로그와 같은 창. */
const RETENTION_DAYS = 7;
const FILE_PREFIX = "turn-stats-";
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
/** contextUsage 류의 부가 조회가 기록 자체를 지연시키지 않게 하는 상한. */
const CONTEXT_READ_MS = 800;
/** 문에서 잰 강화 시간이 턴에 얹히는 유효기간 — 잃어낸 보내기가 나중 턴에 몰래 붙는 것을 막는다. */
const SCAN_TTL_MS = 10 * 60 * 1000;
/** 세션마다 물려둘 수 있는 강화 시간의 수 — 대기 줄이 길어져도 첫 턴의 것만 산다. */
const MAX_QUEUED_SCANS = 4;

/** 도구 이름 → 통계 묶음. 프로바이더마다 이름이 다르니 모양으로 잡는다. */
const READ_TOOLS: Record<string, true> = {
  Read: true,
  Grep: true,
  Glob: true,
  LS: true,
  view: true,
  view_file: true,
  read_file: true,
  web_search: true,
};
const EDIT_TOOLS: Record<string, true> = {
  Edit: true,
  Write: true,
  MultiEdit: true,
  NotebookEdit: true,
  apply_patch: true,
  edit_file: true,
  write_file: true,
};
const EXEC_TOOLS: Record<string, true> = {
  Bash: true,
  Shell: true,
  shell: true,
  exec_command: true,
  run_command: true,
};

/** 한 턴의 측정 — 세션이 말을 내놓는 순간 태어나 turn.end 에서 한 줄이 된다. */
interface InFlight {
  kind: "user" | "comments" | "brief" | "gate";
  pins: number;
  images: number;
  files: number;
  gate: boolean;
  read: number;
  edit: number;
  exec: number;
  browser: number;
  other: number;
  /** user.echo 를 본 데몬 시계(ms) — firstEditMs 의 시작점. */
  startedAt: number;
  /** 첫 편집 도구가 뜬 시각 — 편집이 없던 턴은 null. */
  firstEditAt: number | null;
  /** 카드 대기(waiting_*)의 누적(ms) — 서버가 구간을 밀어 온다. */
  waitMs: number;
  /** 보내기 문에서 잰 핀 강화 시간 — 시작 때 물려받는다. */
  scanMs: number | null;
  /** 이전 턴이 끝난 뒤 이 턴까지의 틈(ms) — 첫 턴은 null. */
  sincePrevTurnMs: number | null;
}

/** The turn row as it lands in the file — numbers and kinds only. */
interface TurnStatsRow {
  at: string;
  sessionId: string;
  project: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  kind: "user" | "comments" | "brief" | "gate";
  pins: number;
  images: number;
  files: number;
  durationMs: number | null;
  isError: boolean;
  subtype: string;
  numTurns: number | null;
  tools: { read: number; edit: number; exec: number; browser: number; other: number };
  gate: boolean;
  contextTokens: number | null;
  /** user.echo → 첫 편집 도구 — 방향 잡기 비용. 없으면 null. */
  firstEditMs: number | null;
  /** 카드 대기(waiting_*)의 누적 — durationMs 에 섞인 사람 시간. */
  waitMs: number;
  /** 보내기 문에서 핀 강화(파일 후보)가 걸린 시간 — 핀 턴만 값이 있다. */
  scanMs: number | null;
  /** 이전 턴 종료 직후의 재보내기라면 작은 수 — 교정 턴의 재료. */
  sincePrevTurnMs: number | null;
}

/** 턴이 끝난 뒤 게이트의 한 바퀴 — 판정이 turn.end 뒤에야 나오므로 제 행이다. */
interface TurnGateRow {
  at: string;
  sessionId: string;
  project: string | null;
  kind: "gateset";
  gateMs: number;
  screens: number;
  reopened: boolean;
}

/** 하루 파일의 한 줄 — 턴 행이거나 게이트 행. */
export type TurnStatsFileRow = TurnStatsRow | TurnGateRow;

/** 세션의 부가 사실 — 서버가 아는 것을 통계만의 좁은 창으로 내어준다. */
export interface TurnStatsDeps {
  /** 이 세션이 사는 프로젝트의 slug — 없으면 null. */
  projectOf(sessionId: string): string | null;
  /** 프로바이더·모델·노력 — 없음은 null 로 솔직히. */
  chipsOf(sessionId: string): {
    provider: string | null;
    model: string | null;
    effort: string | null;
  };
  /** 턴 끝의 컨텍스트 사용량 — 못 읽으면 null. */
  contextTokens(sessionId: string): Promise<number | null>;
}

function freshTurn(text: string): InFlight {
  // 마커 턴의 종류 — readTurn 까지 갈 것 없이, 첫 줄의 표식 접두만 본다.
  const kind = text.startsWith("<!-- colo-design:comments ")
    ? "comments"
    : text.startsWith("<!-- colo-design:gate ")
      ? "gate"
      : text.startsWith("<!-- colo-design:")
        ? "brief"
        : "user";
  return {
    kind,
    pins: 0,
    images: 0,
    files: 0,
    gate: false,
    read: 0,
    edit: 0,
    exec: 0,
    browser: 0,
    other: 0,
    startedAt: Date.now(),
    firstEditAt: null,
    waitMs: 0,
    scanMs: null,
    sincePrevTurnMs: null,
  };
}

/** 하루 치 파일 정리 — 데몬 로그와 같은 판정, 이 파일의 접두만 담당한다. */
function prune(dir: string, today: Date): void {
  const horizon = today.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(FILE_PREFIX)) continue;
    const day = name.slice(FILE_PREFIX.length);
    if (!DAY_FILE.test(day)) continue;
    const parsed = Date.parse(day.slice(0, "YYYY-MM-DD".length));
    if (Number.isNaN(parsed) || parsed >= horizon) continue;
    try {
      rmSync(join(dir, name));
    } catch {
      // 다음 쓰기가 다시 후보로 올린다.
    }
  }
}

/** 측정의 임자 — 서버가 세션 사건을 흘려 보내는 창구. */
export class TurnStats {
  private readonly flying = new Map<string, InFlight>();
  /** 보내기 문에서 잰 핀 강화 시간 — 턴 시작(user.echo) 때 하나씩 묻는다. */
  private readonly scans = new Map<string, Array<{ at: number; ms: number }>>();
  /** 세션의 마지막 turn.end 정산 시각 — 다음 턴의 sincePrevTurnMs 의 짝. */
  private readonly lastEndAt = new Map<string, number>();

  constructor(
    private readonly deps: TurnStatsDeps,
    private readonly options?: { dir?: string; now?: () => Date },
  ) {}

  /** 세션 사건 하나 — 필요한 것만 골라 먹고 나머지는 그냥 흘린다. */
  observe(sessionId: string, event: ChatEvent): void {
    if (event.kind === "user.echo") {
      // 턴의 시작: deliver 직후의 메아리. 핀 턴이면 마커 첫 줄에서 핀 수만
      // 센다 — 본문은 읽지 않는다(사용자의 말이 거기 산다).
      const turn = freshTurn(event.text);
      const firstLine = event.text.split("\n", 1)[0] ?? "";
      if (firstLine.startsWith("<!-- colo-design:comments ")) {
        try {
          const marker = JSON.parse(
            firstLine.slice("<!-- colo-design:comments ".length, firstLine.length - " -->".length),
          ) as { items?: unknown };
          turn.pins = Array.isArray(marker.items) ? marker.items.length : 0;
        } catch {
          turn.pins = 0;
        }
      }
      turn.images = event.images;
      turn.files = event.files?.length ?? 0;
      // 보내기 문에서 잰 강화 시간과 이전 턴과의 틈을 여기서 묻는다 — 대기 줄이
      // 여러 건이면 먼저 들어온 쪽이 먼저 나가므로 줄의 머리가 이 턴의 것이다.
      turn.scanMs = this.takeScan(sessionId);
      const prevEnd = this.lastEndAt.get(sessionId);
      turn.sincePrevTurnMs = prevEnd === undefined ? null : Math.max(0, Date.now() - prevEnd);
      this.flying.set(sessionId, turn);
      return;
    }
    if (event.kind === "tool.start") {
      const turn = this.flying.get(sessionId);
      if (turn === undefined) return;
      if (event.name.startsWith("browser_") || event.name.includes("colo-browser"))
        turn.browser += 1;
      else if (READ_TOOLS[event.name] === true) turn.read += 1;
      else if (EDIT_TOOLS[event.name] === true) turn.edit += 1;
      else if (EXEC_TOOLS[event.name] === true) turn.exec += 1;
      else turn.other += 1;
      // 첫 편집의 시각 — 방향 잡기(읽기만 하던 구간)가 끝난 자리다.
      if (turn.firstEditAt === null && EDIT_TOOLS[event.name] === true)
        turn.firstEditAt = event.startedAt ?? Date.now();
      return;
    }
    if (event.kind === "turn.end") {
      this.settle(sessionId, event).catch(() => undefined);
    }
  }

  /** 게이트가 이 세션의 턴을 다시 열었다 — 그 턴의 사실에 새긴다. */
  noteGate(sessionId: string): void {
    const turn = this.flying.get(sessionId);
    if (turn !== undefined) turn.gate = true;
  }

  /** 보내기 문에서 핀 강화가 걸린 시간 — 턴이 시작될 때 소비된다. */
  noteScan(sessionId: string, ms: number): void {
    const queue = this.scans.get(sessionId) ?? [];
    const now = Date.now();
    // 문에서 잰 것이 오래 묵으면 턴에 얹지 않는다 — 잃어낸 보내기의 시간을
    // 나중 턴에 몰래 붙이는 일이 이 줄이 막는 거짓말이다.
    while (queue.length > 0 && now - (queue[0]?.at ?? now) > SCAN_TTL_MS) queue.shift();
    queue.push({ at: now, ms });
    if (queue.length > MAX_QUEUED_SCANS) queue.shift();
    this.scans.set(sessionId, queue);
  }

  private takeScan(sessionId: string): number | null {
    const queue = this.scans.get(sessionId);
    if (queue === undefined) return null;
    const head = queue.shift();
    if (queue.length === 0) this.scans.delete(sessionId);
    if (head === undefined) return null;
    return Date.now() - head.at > SCAN_TTL_MS ? null : head.ms;
  }

  /** 카드 대기의 한 구간(waiting_* 에 머문 시간) — 도는 턴에 더한다. */
  noteWait(sessionId: string, ms: number): void {
    const turn = this.flying.get(sessionId);
    if (turn !== undefined) turn.waitMs += ms;
  }

  /** 게이트의 한 바퀴 — 턴 행과는 따로 한 줄로 내려앉는다. */
  noteGateCheck(
    sessionId: string,
    outcome: { ms: number; screens: number; reopened: boolean },
  ): void {
    const row: TurnGateRow = {
      at: new Date().toISOString(),
      sessionId,
      project: this.deps.projectOf(sessionId),
      kind: "gateset",
      gateMs: outcome.ms,
      screens: outcome.screens,
      reopened: outcome.reopened,
    };
    this.write(row);
  }

  /** turn.end 의 정산 — 컨텍스트 읽기를 기다린 뒤 한 줄로 묶는다. */
  private async settle(sessionId: string, event: ChatEvent & { kind: "turn.end" }): Promise<void> {
    const turn = this.flying.get(sessionId);
    this.flying.delete(sessionId);
    if (turn === undefined) return;
    const context = await Promise.race([
      this.deps.contextTokens(sessionId).catch(() => null),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), CONTEXT_READ_MS);
        timer.unref();
      }),
    ]);
    const chips = this.deps.chipsOf(sessionId);
    const row: TurnStatsRow = {
      at: new Date().toISOString(),
      sessionId,
      project: this.deps.projectOf(sessionId),
      provider: chips.provider,
      model: chips.model,
      effort: chips.effort,
      kind: turn.kind,
      pins: turn.pins,
      images: turn.images,
      files: turn.files,
      durationMs: event.durationMs,
      isError: event.isError,
      subtype: event.subtype,
      numTurns: event.numTurns,
      tools: {
        read: turn.read,
        edit: turn.edit,
        exec: turn.exec,
        browser: turn.browser,
        other: turn.other,
      },
      gate: turn.gate,
      contextTokens: context,
      firstEditMs:
        turn.firstEditAt === null ? null : Math.max(0, turn.firstEditAt - turn.startedAt),
      waitMs: turn.waitMs,
      scanMs: turn.scanMs,
      sincePrevTurnMs: turn.sincePrevTurnMs,
    };
    this.lastEndAt.set(sessionId, Date.now());
    this.write(row);
  }

  private write(row: TurnStatsFileRow): void {
    try {
      const dir = this.options?.dir ?? daemonLogDir();
      const now = this.options?.now?.() ?? new Date();
      const day = now.toISOString().slice(0, 10);
      mkdirSync(dir, { recursive: true });
      prune(dir, now);
      appendFileSync(join(dir, `${FILE_PREFIX}${day}.jsonl`), `${JSON.stringify(row)}\n`);
    } catch {
      // 통계가 도구를 죽이는 일은 없다.
    }
  }
}
