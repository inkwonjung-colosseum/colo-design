/**
 * 권한 카드 반복 측정 (커미티 판정 2026-09-14, 의장 판정 2) — 측정이 먼저다.
 *
 * `alwaysAllowed` 는 세션 인스텐스 하나의 기억이라(session.ts), 사용자는
 * 새 대화마다 이미 "항상 허용"이라 답한 같은 카드를 다시 받는다. 그 반복이
 * 실제로 얼마나, 어떤 서명에서 일어나는지 측정하기 전에는 앱이 제공하는
 * 권한 번들(managedSettings)의 목록을 정할 근거가 없다 — 그래서 이 로그가
 * 번들 도입 여부·내용을 결정하는 게이트다.
 *
 * 읽는 법(반복 왕관부터):
 *   jq -r 'select(.kind=="ask" and .repeat==true) | .signature' \
 *     ~/.colo-design/config/permission-repeat.jsonl | sort | uniq -c | sort -rn
 *
 * 기록하는 것은 카드의 사실뿐이다(도구·서명·프로젝트 경로·반복 여부) —
 * 입력 전문은 기록하지 않는다. 서명은 permissionSignature 의 축약형으로,
 * 카드가 이미 물어본 적 있는 질문인지만 말한다.
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

export interface PermissionAskEvent {
  ts: number;
  kind: "ask" | "always";
  tool: string;
  /** permissionSignature 와 같은 축약: `Tool:kind:값` — 카드의 동일성 판별자. */
  signature: string;
  /** 카드가 뜬 세션의 cwd — 프로젝트별 반복을 갈라 본다. */
  cwd: string;
  /** 이 서명에 "항상 허용"을 답한 적이 있다(이전 세션에서). */
  repeat?: boolean;
}

/** `COLO_DESIGN_PERMISSION_LOG` 가 테스트를 일회용 파일로 가리키게 한다. */
function permissionLogFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLO_DESIGN_PERMISSION_LOG ?? join(CONFIG_DIR, "permission-repeat.jsonl");
}

export class PermissionRepeatLog {
  private lines: PermissionAskEvent[];
  private readonly always = new Set<string>();

  constructor(private readonly file: string) {
    this.lines = PermissionRepeatLog.read(file);
    for (const line of this.lines) {
      if (line.kind === "always") this.always.add(line.signature);
    }
  }

  /** 카드 하나가 떴다 — 같은 서명에 옛 "항상 허용"이 있었으면 반복이다. */
  ask(tool: string, signature: string, cwd: string): void {
    this.write({
      ts: Date.now(),
      kind: "ask",
      tool,
      signature,
      cwd,
      repeat: this.always.has(signature),
    });
  }

  /** 사용자가 "항상 허용"이라 답했다 — 다음 세션부터 이 서명은 반복이 된다. */
  alwaysAllowedAnswer(tool: string, signature: string, cwd: string): void {
    this.always.add(signature);
    this.write({ ts: Date.now(), kind: "always", tool, signature, cwd });
  }

  /** 같은 서명의 반복 카드가 몇 번 기록됐는지 — 단위 검사의 창. */
  repeatsOf(signature: string): number {
    return this.lines.filter(
      (line) => line.kind === "ask" && line.repeat && line.signature === signature,
    ).length;
  }

  private write(event: PermissionAskEvent): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    this.lines.push(event);
    if (this.lines.length > MAX_LINES) this.trim();
  }

  /** 상한을 넘으면 최근 절반을 남기고 always 집합도 살아있는 줄에서 다시 자란다. */
  private trim(): void {
    this.lines = this.lines.slice(Math.floor(MAX_LINES / 2));
    // 통째로 다시 쓰는 순간에도 찢어짐은 없게 — tmp+rename 으로 원자적으로.
    const temporary = `${this.file}.colo-design-${process.pid}`;
    writeFileSync(temporary, `${this.lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    renameSync(temporary, this.file);
    this.always.clear();
    for (const line of this.lines) {
      if (line.kind === "always") this.always.add(line.signature);
    }
  }

  private static read(file: string): PermissionAskEvent[] {
    if (!existsSync(file)) return [];
    const events: PermissionAskEvent[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as PermissionAskEvent);
      } catch {
        // 깨진 줄 하나가 측정 전부를 죽이지 않게 — 없던 것으로 한다.
      }
    }
    return events;
  }
}

let shared: PermissionRepeatLog | null = null;

/** 세션들이 함께 쓰는 하나의 로그 — 프로세스마다 한 번만 파일을 읽는다. */
export function permissionLog(): PermissionRepeatLog {
  shared ??= new PermissionRepeatLog(permissionLogFile());
  return shared;
}
