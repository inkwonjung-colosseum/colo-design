/**
 * 기계 잔일 담당의 설정 (machine.json) — 비밀이 아닌 설정은 파일에 살게
 * 한다(OS 저장소는 비밀의 자리 — escalation 참조). 문자열 몇 개를 키·값으로
 * 저장한다: `{"provider": "codex", "authorName": "김기획"}`. 파일이 없거나
 * 읽을 수 없으면 모든 키가 null — 자동이 기본값이므로 망가진 파일이 선택을
 * 지어먹지 않는다.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./environment.js";

const FILE = join(CONFIG_DIR, "machine.json");

export class MachineSetting {
  /** 테스트는 임시 폴더의 파일을 넣어 실제 읽기·쓰기를 그대로 돈다. */
  constructor(private readonly file: string = FILE) {}

  private value: Record<string, string> = {};

  /**
   * 시작 시 한 번 — 못 읽는 파일은 자동으로 내려앉는다(키 없음 = 기본값).
   * 예전 한 쌍 포맷(`{"provider": …}`)도 그대로 읽힌다: 파일은 처음부터
   * JSON 객체였고, 레코드화는 "키가 하나 더 늘어난다"일 뿐이라 하위 호환이다.
   */
  load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      this.value = {};
      for (const [key, raw] of Object.entries(parsed)) {
        if (typeof raw === "string" && raw) this.value[key] = raw;
      }
    } catch {
      this.value = {};
    }
  }

  get(key: string): string | null {
    return this.value[key] ?? null;
  }

  /** 한 키 저장(빈 값이나 `null` 이면 잊기) — queue-store 와 같은 원자적 쓰기. */
  set(key: string, value: string | null): void {
    if (value === null || value === "") delete this.value[key];
    else this.value[key] = value;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.colo-design-${process.pid}`;
    const fd = openSync(temporary, "w");
    try {
      writeSync(fd, `${JSON.stringify(this.value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.file);
  }
}
