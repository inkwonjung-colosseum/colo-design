/**
 * 증분 타입 진단 (PLAN-HARNESS §3.C, H-7 · H-8) — `repo_diagnostics` 의 몸.
 * 상주 `tsc --watch` 가 아니라 호출마다의 증분 `tsc --noEmit --incremental`:
 * 빌드 정보 파일을 클론 밖(<projectRoot>/tsc.tsbuildinfo)에 두어 상주 메모리는
 * 0, 신선도 문제 없음, `git status` 깨끗하다. 실패는 예외가 아니라 결과다 —
 * 턴도 데몬도 죽이지 않는다.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** tsc 한 줄의 진단 — file 은 레포 루트 상대(슬래시). 파일 없는 오류는 "". */
export interface TscDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

export type TypeCheckResult =
  | { status: "ok"; diagnostics: TscDiagnostic[]; ms: number }
  | { status: "unavailable"; reason: string }
  | { status: "timeout"; ms: number }
  | { status: "failed"; reason: string };

/** 한 번의 검사 상한 — 첫 검사(가장 느린 한 번)도 이 안에 끝나야 한다. */
export const TYPE_CHECK_TIMEOUT_MS = 120_000;

/** 도구 답에 실리는 진단 줄의 상한 — 나머지는 줄 수로만 알린다. */
const ANSWER_MAX_LINES = 30;

/** 진단 메시지와 failed 이유의 상한 — 답 한 줄이 차지하는 폭의 울타리. */
const REASON_MAX_CHARS = 200;

/** tsc 출력을 잡아 두는 상한 — 진단 수세기에 충분하고 판은 못 짓게 하는 크기. */
const OUTPUT_TAIL_CHARS = 200_000;

/**
 * 무엇을 돌릴지 — 레포 루트에 tsconfig.json 과 node_modules/typescript/bin/tsc
 * 가 둘 다 있어야 한다. 실행 파일은 "node" 다: 데스크톱에서 process.execPath 는
 * Electron 이라 쓰면 안 된다.
 */
export function typeCheckPlan(
  repoRoot: string,
  buildInfoFile: string,
): { command: "node"; args: string[] } | { unavailable: string } {
  if (!existsSync(join(repoRoot, "tsconfig.json"))) {
    return { unavailable: "tsconfig.json 이 없습니다" };
  }
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) {
    return { unavailable: "typescript 가 설치돼 있지 않습니다" };
  }
  return {
    command: "node",
    args: [
      tsc,
      "--noEmit",
      "--pretty",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      buildInfoFile,
      "-p",
      "tsconfig.json",
    ],
  };
}

/** tsc 의 `--pretty false` 진단 줄 — file(line,col): error TSxxxx: message. */
const DIAGNOSTIC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
/** 파일 없는 오류 줄 — `error TS5083: …` 처럼 진단 앞에 주소가 없는 것. */
const FILELESS_LINE = /^error (TS\d+): (.*)$/;

/**
 * `--pretty false` 출력 → 진단. 순수. 들여 쓴 다음 줄들은 앞 진단의 이어진
 * 말이다 — message 에는 첫 줄만 두고 버린다. 경로의 `\` 는 `/` 로.
 */
export function parseTscOutput(text: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    // 들여 쓴 줄은 앞 진단의 이어진 말이다.
    if (line.startsWith(" ") || line.startsWith("\t")) continue;
    const hit = DIAGNOSTIC_LINE.exec(line);
    if (hit) {
      diagnostics.push({
        file: (hit[1] ?? "").replace(/\\/g, "/"),
        line: Number(hit[2] ?? 0),
        col: Number(hit[3] ?? 0),
        code: hit[4] ?? "",
        message: hit[5] ?? "",
      });
      continue;
    }
    const bare = FILELESS_LINE.exec(line);
    if (bare) {
      diagnostics.push({
        file: "",
        line: 0,
        col: 0,
        code: bare[1] ?? "",
        message: bare[2] ?? "",
      });
    }
  }
  return diagnostics;
}

/**
 * 도구의 답 문장. 순수. changed 는 레포 루트 상대 경로 — 그 파일의 진단을
 * 먼저 실는다. 어느 상태든 사실을 알리는 답이다 (isError 가 아니다).
 */
export function diagnosticsAnswer(result: TypeCheckResult, changed: string[]): string {
  if (result.status === "unavailable") {
    return `이 레포에는 타입 검사가 없습니다 — ${result.reason}`;
  }
  if (result.status === "timeout") {
    return `타입 검사가 ${Math.round(result.ms / 1_000)}초 안에 끝나지 않았습니다 — 레포의 검사 명령으로 확인하십시오`;
  }
  if (result.status === "failed") {
    return `타입 검사를 실행하지 못했습니다 — ${result.reason}`;
  }
  if (result.diagnostics.length === 0) {
    return `타입 오류 없음 (${Math.round(result.ms / 1_000)}초)`;
  }
  const changedSet = new Set(changed.map((path) => path.replace(/\\/g, "/")));
  const ofChanged = (d: TscDiagnostic): boolean => d.file !== "" && changedSet.has(d.file);
  const mine = result.diagnostics.filter(ofChanged);
  const rest = result.diagnostics.filter((d) => !ofChanged(d));
  const lines = [...mine, ...rest]
    .slice(0, ANSWER_MAX_LINES)
    .map((d) => `- ${d.file}:${d.line}:${d.col} ${d.code} ${d.message.slice(0, REASON_MAX_CHARS)}`);
  const omitted = result.diagnostics.length - lines.length;
  return [
    `타입 오류 ${result.diagnostics.length}건 — 이번에 바뀐 파일에서 ${mine.length}건`,
    ...lines,
    ...(omitted > 0 ? [`… 나머지 ${omitted}건`] : []),
  ].join("\n");
}

/** 한 repoRoot 의 검사 차선 — 도는 것과 줄 선 것 하나. */
interface Lane {
  running: Promise<TypeCheckResult>;
  queued: Promise<TypeCheckResult> | null;
}

/** 출력의 비지 않은 마지막 줄 — failed 의 이유. */
function lastLineOf(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? (lines[lines.length - 1] ?? null) : null;
}

/**
 * 호출마다의 증분 검사기. 같은 repoRoot 에 도는 검사가 있으면 하나만 뒤에
 * 줄을 세운다 — 줄 선 동안 온 호출은 모두 그 줄 선 검사의 결과를 받는다
 * (편집이 그 사이 있었을 수 있으니 도는 검사의 결과를 재사용하지 않는다).
 */
export class TypeChecker {
  private readonly spawnFn: typeof spawn;
  private readonly timeoutMs: number;
  private readonly lanes = new Map<string, Lane>();
  private readonly children = new Set<ChildProcess>();

  constructor(deps?: { spawn?: typeof spawn; timeoutMs?: number }) {
    this.spawnFn = deps?.spawn ?? spawn;
    this.timeoutMs = deps?.timeoutMs ?? TYPE_CHECK_TIMEOUT_MS;
  }

  check(repoRoot: string, projectRoot: string, env: NodeJS.ProcessEnv): Promise<TypeCheckResult> {
    const lane = this.lanes.get(repoRoot);
    if (lane?.queued) return lane.queued;
    if (lane) {
      // 도는 검사가 있다 — 하나의 뒤따르는 검사를 세우고 그 결과를 함께 준다.
      const queued = lane.running
        .catch(() => undefined)
        .then(() => {
          const run = this.runOnce(repoRoot, projectRoot, env);
          lane.running = run;
          lane.queued = null;
          void run.finally(() => this.settle(repoRoot, lane, run));
          return run;
        });
      lane.queued = queued;
      return queued;
    }
    const run = this.runOnce(repoRoot, projectRoot, env);
    const fresh: Lane = { running: run, queued: null };
    this.lanes.set(repoRoot, fresh);
    void run.finally(() => this.settle(repoRoot, fresh, run));
    return run;
  }

  /** 차선 거두기 — 아무도 줄 서지 않았고 도는 것도 이것이 마지막이면 지운다. */
  private settle(repoRoot: string, lane: Lane, run: Promise<TypeCheckResult>): void {
    if (this.lanes.get(repoRoot) === lane && lane.queued === null && lane.running === run) {
      this.lanes.delete(repoRoot);
    }
  }

  /** 빌드 정보 파일이 아직 없고 도는 검사가 없을 때만 한 번 돈다. 실패는 삼킨다. */
  prewarm(repoRoot: string, projectRoot: string, env: NodeJS.ProcessEnv): void {
    if (this.lanes.has(repoRoot)) return;
    // 클론 밖의 빌드 정보 파일 — 이미 있으면 데울 이유가 없다.
    if (existsSync(join(projectRoot, "tsc.tsbuildinfo"))) return;
    void this.check(repoRoot, projectRoot, env).catch(() => undefined);
  }

  /** 도는 자식을 모두 끝낸다(데몬 stop). */
  dispose(): void {
    for (const child of this.children) {
      try {
        child.kill();
      } catch {
        // 이미 간 자식 — 끝낼 일이 없다.
      }
    }
    this.children.clear();
  }

  /** 자식 하나의 일생 — 계획이 없으면 unavailable, 상한을 넘으면 timeout. */
  private runOnce(
    repoRoot: string,
    projectRoot: string,
    env: NodeJS.ProcessEnv,
  ): Promise<TypeCheckResult> {
    const started = Date.now();
    const plan = typeCheckPlan(repoRoot, join(projectRoot, "tsc.tsbuildinfo"));
    if ("unavailable" in plan) {
      return Promise.resolve({ status: "unavailable", reason: plan.unavailable });
    }
    return new Promise<TypeCheckResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(plan.command, plan.args, {
          cwd: repoRoot,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({
          status: "failed",
          reason: String((error as Error)?.message ?? error).slice(0, REASON_MAX_CHARS),
        });
        return;
      }
      this.children.add(child);
      let output = "";
      let settled = false;
      const finish = (result: TypeCheckResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 이미 간 자식 — 상한의 답은 그대로 간다.
        }
        finish({ status: "timeout", ms: Date.now() - started });
      }, this.timeoutMs);
      // 상한의 시계가 데몬의 환록을 붙들지 않게 한다.
      timer.unref();
      const absorb = (chunk: Buffer) => {
        output = (output + String(chunk)).slice(-OUTPUT_TAIL_CHARS);
      };
      child.stdout?.on("data", absorb);
      child.stderr?.on("data", absorb);
      child.once("error", (error) => {
        finish({ status: "failed", reason: error.message.slice(0, REASON_MAX_CHARS) });
      });
      child.once("close", (code) => {
        const ms = Date.now() - started;
        const diagnostics = parseTscOutput(output);
        if (code === 0 || diagnostics.length > 0) {
          finish({ status: "ok", diagnostics, ms });
          return;
        }
        finish({
          status: "failed",
          reason: (lastLineOf(output) ?? `종료 코드 ${code ?? "없음"}`).slice(0, REASON_MAX_CHARS),
        });
      });
    });
  }
}
