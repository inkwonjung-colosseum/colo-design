/**
 * 되돌리기 측정 — 측정이 먼저다(권한 카드 로그와 같은 자세, permission-log.ts).
 *
 * 되돌리기는 이 제품의 품질을 직접 말하는 유일한 사용자 행동이다: 답이
 * 맞았으면 아무도 되돌리지 않는다. 그런데 지금 도구는 그것을 세지 않아
 * "AI 가 얼마나 자주 빗나가는가"에 답할 근거가 없다 — 사용자가 불평한
 * 기억뿐이다. 세 개의 문이 모두 여기로 들어온다:
 *
 *   - `retry`  다시 요청 (session.rewind) — 답을 통째로 버리고 같은 말을 다시
 *   - `turn`   이 요청 이전으로 되돌리기 (repo.checkpoint.restore)
 *   - `save`   저장 기록의 되돌리기 (repo.restore)
 *
 * 읽는 법:
 *   jq -r .kind ~/.colo-design/config/undo.jsonl | sort | uniq -c | sort -rn
 *   # 첫 답이 자주 빗나가는가 — 되돌린 턴 번호의 분포
 *   jq -r 'select(.kind!="save") | .turn' ~/.colo-design/config/undo.jsonl \
 *     | sort -n | uniq -c
 *
 * 기록하는 것은 행동의 사실뿐이다(종류 · 프로젝트 · 대화 id · 턴 번호) —
 * 사용자의 말도, 화면의 내용도, 파일 경로도 남기지 않는다.
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

export type UndoKind = "retry" | "turn" | "save";

export interface UndoEvent {
  ts: number;
  kind: UndoKind;
  /** 되돌린 프로젝트 — 레포마다 빗나가는 정도가 다를 수 있다. */
  slug: string;
  /** 대화 id (`save` 에는 없다 — 저장은 대화의 것이 아니다). */
  sessionId?: string;
  /** 되돌린 턴 번호, k 번째 프롬프트 (`save` 에는 없다). */
  turn?: number;
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
