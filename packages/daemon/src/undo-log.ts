/**
 * 되돌리기 측정 — 측정이 먼저다(권한 카드 로그와 같은 자세, permission-log.ts).
 *
 * 저장 기록의 되돌리기(repo.restore)가 이 로그의 유일한 문이다. 요청
 * 되돌리기(다시 요청 · 체크포인트 복원)는 기능이 은퇴하며 함께 빠졌다 —
 * `retry` · `turn` 종류는 더 오지 않는다.
 *
 * 읽는 법:
 *   jq -r .kind ~/.colo-design/config/undo.jsonl | sort | uniq -c | sort -rn
 *
 * 기록하는 것은 행동의 사실뿐이다(종류 · 프로젝트) — 사용자의 말도,
 * 화면의 내용도, 파일 경로도 남기지 않는다.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./environment.js";

/** 유지하는 줄의 상한. 넘으면 최근 절반만 남긴다 — 측정이 골동품이 되지 않게. */
const MAX_LINES = 4000;

export type UndoKind = "save";

export interface UndoEvent {
  ts: number;
  kind: UndoKind;
  /** 되돌린 프로젝트 — 레포마다 빗나가는 정도가 다를 수 있다. */
  slug: string;
}

/** `COLO_DESIGN_UNDO_LOG` 가 테스트를 일회용 파일로 가리키게 한다. */
function undoLogFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLO_DESIGN_UNDO_LOG ?? join(CONFIG_DIR, "undo.jsonl");
}

export class UndoLog {
  private lines: UndoEvent[];

  constructor(private readonly file: string) {
    this.lines = UndoLog.read(file);
  }

  record(event: Omit<UndoEvent, "ts">): void {
    const line: UndoEvent = { ts: Date.now(), ...event };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.trim();
  }

  /** 한 종류가 몇 번 기록됐는지 — 단위 검사의 창. */
  countOf(kind: UndoKind): number {
    return this.lines.filter((line) => line.kind === kind).length;
  }

  private trim(): void {
    this.lines = this.lines.slice(Math.floor(MAX_LINES / 2));
    // 통째로 다시 쓰는 순간에도 찢어짐은 없게 — tmp+rename 으로 원자적으로.
    const temporary = `${this.file}.colo-design-${process.pid}`;
    writeFileSync(temporary, `${this.lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    renameSync(temporary, this.file);
  }

  private static read(file: string): UndoEvent[] {
    if (!existsSync(file)) return [];
    const events: UndoEvent[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as UndoEvent);
      } catch {
        // 깨진 줄 하나가 측정 전부를 죽이지 않게 — 없던 것으로 한다.
      }
    }
    return events;
  }
}

let shared: UndoLog | null = null;

/** 프로세스가 함께 쓰는 하나의 로그 — 파일은 한 번만 읽는다. */
export function undoLog(): UndoLog {
  shared ??= new UndoLog(undoLogFile());
  return shared;
}
