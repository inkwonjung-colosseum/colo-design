import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * 0.4.0 저장 위치 이주 (RENAME-NOVA-PLAN §3.3) — 개명(Colo Design → Nova
 * Design)으로 데이터 폴더가 `~/.colo-design` 에서 `~/.nova-design` 으로 옮겨질
 * 때, 폴더만 바꾸면 끝이 아닌 것들을 함께 고친다:
 *
 * 1. 폴더째 rename(클론 · node_modules · 설정 · update-result.json 이 함께 간다).
 * 2. `config/projects.json` 과 프로젝트마다의 `cycle.json` 에 박힌 절대 경로 접두.
 * 3. 각 클론의 `.git/config` 이 절대 경로로 적은 `core.hooksPath`.
 * 4. 세 공급자의 대화 저장소 — 모두 **클론의 경로**로 지난 대화를 찾는다.
 *    Claude(`~/.claude/projects/<경로의 영숫자 밖 글자를 - 로>`) ·
 *    omp(`~/.omp/agent/sessions/<홈 상대 경로의 구분자를 - 로>`) ·
 *    Codex(`~/.codex/sessions` 롤아웃 첫 줄의 `cwd`).
 *
 * 전부 멱원이다 — 두 번째 실행은 아무 것도 하지 않는다. 어느 단계가 실패해도
 * 예외를 밖으로 던지지 않는다: 이주가 남은 것과 앱이 죽는 것 중 전자가 싸고,
 * 남은 이주는 다음 실행이 다시 시도한다. `~/.claude.json` 의 신뢰 항목은
 * 시작마다 다시 쓰므로 손볼 것이 없다.
 */

/** 파일 시스템 손잡이 — 시험이 가짜로 갈아끼운다. */
export interface MigrationIo {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
  read(path: string): string;
  write(path: string, text: string): void;
  /** 폴더의 직속 폴더 이름들 — 없으면 빈 배열. */
  dirs(dir: string): string[];
  /** 폴더의 직속 파일 이름들 — 없으면 빈 배열. */
  files(dir: string): string[];
}

const fsIo: MigrationIo = {
  exists: existsSync,
  rename: renameSync,
  read: (path) => readFileSync(path, "utf8"),
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.nova-design-migrate-${process.pid}`;
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  },
  dirs: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  files: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
};

export interface MigrationReport {
  /** 데이터 폴더를 옮겼다(이번 실행에). */
  renamedDataDir: boolean;
  /** 옛·새 폴더가 둘 다 있어 새 것을 쓰고 경고를 남겼다. */
  bothExist: boolean;
  /** 접두를 다시 쓴 파일 수(projects.json · cycle.json · .git/config). */
  rewrotePaths: number;
  /** 옮긴 Claude 대화 폴더 수. */
  claudeMoved: number;
  /** 옮긴 omp 대화 폴더 수. */
  ompMoved: number;
  /** `cwd` 를 다시 쓴 Codex 롤아웃 파일 수. */
  codexRewritten: number;
  /** 경고 · 실패 — 로그로 한 줄씩 나갈 말. */
  notes: string[];
}

const EMPTY_REPORT: MigrationReport = {
  renamedDataDir: false,
  bothExist: false,
  rewrotePaths: 0,
  claudeMoved: 0,
  ompMoved: 0,
  codexRewritten: 0,
  notes: [],
};

/** Claude Code 의 프로젝트 폴더 이름 — 경로의 영숫자 밖 글자를 전부 `-` 로. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * omp 세션 폴더 이름(홈 아래 분기만 — 클론은 늘 홈 아래에 있다). 홈 상대
 * 경로의 `/` · `\` · `:` 를 `-` 로 바꾸고 앞에 `-` 를 붙인다(omp/store.ts 의
 * 규칙과 바이트 단위로 같아야 목록이 보인다). 홈 밖 경로는 null — 이주 대상
 * 아니다.
 */
export function ompSessionDirName(cwd: string, home: string): string | null {
  const rel = relative(home, resolve(cwd));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return `-${rel.replace(/[/\\:]/g, "-")}`;
}

/**
 * 저장된 값 트리에서 옛 접두를 새 것으로 바꾼다 — projects.json · cycle.json 의
 * 절대 경로가 대상이다. 문자열 값만 보고, 바뀐 것이 있을 때만 true.
 */
function rewritePrefixes(value: unknown, from: string, to: string, out: unknown[]): boolean {
  if (typeof value === "string") {
    if (value.startsWith(from)) {
      out.push(to + value.slice(from.length));
      return true;
    }
    out.push(value);
    return false;
  }
  if (value === null || typeof value !== "object") {
    out.push(value);
    return false;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    let changed = false;
    for (const item of value) changed = rewritePrefixes(item, from, to, items) || changed;
    out.push(items);
    return changed;
  }
  const record: Record<string, unknown> = {};
  let changed = false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const field: unknown[] = [];
    changed = rewritePrefixes(item, from, to, field) || changed;
    record[key] = field[0];
  }
  out.push(record);
  return changed;
}

/** JSON 파일의 접두 다시 쓰기 — 바뀌었을 때만 쓰고 true. */
function rewriteJsonFile(path: string, from: string, to: string, io: MigrationIo): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(io.read(path));
  } catch {
    return false;
  }
  const out: unknown[] = [];
  if (!rewritePrefixes(parsed, from, to, out)) return false;
  try {
    io.write(path, `${JSON.stringify(out[0], null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 텍스트 파일의 옛 접두 치환 — `.git/config` 의 hooksPath 용. */
function rewriteTextFile(path: string, from: string, to: string, io: MigrationIo): boolean {
  let text: string;
  try {
    text = io.read(path);
  } catch {
    return false;
  }
  if (!text.includes(from)) return false;
  try {
    io.write(path, text.split(from).join(to));
    return true;
  } catch {
    return false;
  }
}

export interface MigrationOptions {
  /** 홈 폴더 — 기본 실제 홈. */
  home?: string;
  io?: MigrationIo;
  /** 결과의 한 줄들을 받는 싱크(로그). */
  onNote?: (line: string) => void;
}

/**
 * 이주를 돌리고 보고를 돌려준다. daemon 시작 맨 앞(index.ts main) 과 데스크톱
 * bootApp 의 첫줄에서 부른다 — CONFIG_DIR/projects.json 을 읽는 그 무엇보다
 * 먼저.
 */
export function migrateLegacyDataHome(options: MigrationOptions = {}): MigrationReport {
  const io = options.io ?? fsIo;
  const home = options.home ?? homedir();
  const note = (line: string): void => options.onNote?.(line);
  // read-legacy — 옛 데이터 폴더. 새 폴더는 NOVA_DESIGN_DATA_DIR 와 같은 규칙
  // (nova-names 시험이 두 표기의 일치를 지킨다).
  const from = join(home, ".colo-design"); // read-legacy
  const to = join(home, ".nova-design");
  const report: MigrationReport = { ...EMPTY_REPORT, notes: [] };

  // 1. 폴더째 rename — 새 것이 이미 있으면 건드리지 않고 경고 한 줄.
  const oldExists = io.exists(from);
  const newExists = io.exists(to);
  if (oldExists && !newExists) {
    try {
      io.rename(from, to);
      report.renamedDataDir = true;
    } catch (error) {
      report.notes.push(`데이터 폴더 이주 실패: ${String(error)}`);
      note(report.notes[report.notes.length - 1] ?? "");
      return report;
    }
  } else if (oldExists && newExists) {
    report.bothExist = true;
    report.notes.push(
      "옛 데이터 폴더(~/.colo-design)가 새 폴더(~/.nova-design) 옆에 남아 있습니다 — 새 폴더를 씁니다.", // read-legacy
    );
  }

  // 이주할 클론 후보 — 폴더 열거가 원천이다(레지스트리를 읽기 전에 옮겨졌을
  // 수 있으므로). `<dataDir>/projects/<slug>/repo` 와 옛 설치 모양 `<dataDir>/repo`.
  const clones: Array<[old: string, fresh: string]> = [];
  if (io.exists(to)) {
    for (const slug of io.dirs(join(to, "projects"))) {
      clones.push([join(from, "projects", slug, "repo"), join(to, "projects", slug, "repo")]);
    }
    clones.push([join(from, "repo"), join(to, "repo")]);
  }

  // 2 · 3. 설정과 클론 안의 절대 경로 접두.
  try {
    if (rewriteJsonFile(join(to, "config", "projects.json"), from, to, io)) {
      report.rewrotePaths += 1;
    }
  } catch (error) {
    report.notes.push(`projects.json 경로 이주 실패: ${String(error)}`);
  }
  for (const [, fresh] of clones) {
    try {
      if (rewriteJsonFile(join(dirname(fresh), "cycle.json"), from, to, io)) {
        report.rewrotePaths += 1;
      }
    } catch {
      // cycle.json 이 없는 프로젝트는 그뿐이다.
    }
    try {
      if (rewriteTextFile(join(fresh, ".git", "config"), from, to, io)) {
        report.rewrotePaths += 1;
      }
    } catch {
      // .git 이 없는 클론(아직 클론 전)도 그뿐이다.
    }
  }

  // 4. 세션 저장소 — 폴더 rename 두 개는 existsSync 짝이어서 매번 돌아도
  // 싸지만, Codex 롤아웃 훑기는 비싸므로 완료 표식으로 한 번만 돈다.
  const marker = join(to, "run", "storage-migrated");
  if (!io.exists(marker)) {
    const claudeProjects = join(home, ".claude", "projects");
    const ompSessions = join(home, ".omp", "agent", "sessions");
    for (const [old, fresh] of clones) {
      try {
        const oldName = claudeProjectDirName(old);
        const newName = claudeProjectDirName(fresh);
        if (io.exists(join(claudeProjects, oldName)) && !io.exists(join(claudeProjects, newName))) {
          io.rename(join(claudeProjects, oldName), join(claudeProjects, newName));
          report.claudeMoved += 1;
        }
      } catch (error) {
        report.notes.push(`Claude 대화 폴더 이주 실패(${old}): ${String(error)}`);
      }
      try {
        const oldName = ompSessionDirName(old, home);
        const newName = ompSessionDirName(fresh, home);
        if (
          oldName &&
          newName &&
          io.exists(join(ompSessions, oldName)) &&
          !io.exists(join(ompSessions, newName))
        ) {
          io.rename(join(ompSessions, oldName), join(ompSessions, newName));
          report.ompMoved += 1;
        }
      } catch (error) {
        report.notes.push(`omp 대화 폴더 이주 실패(${old}): ${String(error)}`);
      }
    }
    report.codexRewritten = rewriteCodexRollouts(home, from, to, io, report.notes);
    try {
      io.write(marker, new Date().toISOString());
    } catch {
      // 표식을 못 적으면 다음 시작이 세션 이주를 다시 본다 — 멱원이라 비싸기만 하다.
    }
  }

  for (const line of report.notes) note(line);
  return report;
}

/**
 * 개명(0.4.0) 뒤 개발자 셸에 남은 옛 환경 변수(`COLO_DESIGN_*`)가 조용히
 * 무시되지 않게 한다 — 값은 읽지 않고, 새 이름을 알리는 경고 한 줄만 남긴다.
 * 앱 사용자의 기계에서는 앱이 스스로 세우는 값이므로 이 경고는 뜨지 않는다.
 */
export function warnLegacyEnv(env: NodeJS.ProcessEnv, warn: (line: string) => void): string[] {
  // read-legacy — 옛 접두로 남은 변수를 알아본다.
  const stale = Object.keys(env).filter((key) => key.startsWith("COLO_DESIGN_")); // read-legacy
  if (stale.length > 0) {
    warn(`무시된 옛 환경 변수가 있습니다 — 새 이름은 NOVA_DESIGN_* 입니다: ${stale.join(", ")}`);
  }
  return stale;
}

/**
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 의 첫 줄(`session_meta`)이
 * 옛 접두의 `cwd` 를 적고 있으면 그 필드만 다시 쓴다.Codex 는 롤아웃 첫 줄의
 * `cwd` 가 클론 경로와 같은 것만 목록에 보이므로(드라이버 store.list), 경로가
 * 바뀌면 지난 대화가 전부 사라진다.
 */
function rewriteCodexRollouts(
  home: string,
  from: string,
  to: string,
  io: MigrationIo,
  notes: string[],
): number {
  const sessionsRoot = join(home, ".codex", "sessions");
  let rewritten = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const name of io.files(dir)) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const text = io.read(path);
        const newline = text.indexOf("\n");
        const first = newline === -1 ? text : text.slice(0, newline);
        const rest = newline === -1 ? "" : text.slice(newline);
        const line = JSON.parse(first) as { type?: string; payload?: { cwd?: unknown } };
        if (line?.type !== "session_meta") continue;
        const cwd = line.payload?.cwd;
        if (typeof cwd !== "string" || !cwd.startsWith(from)) continue;
        line.payload = { ...line.payload, cwd: to + cwd.slice(from.length) };
        io.write(path, `${JSON.stringify(line)}${rest}`);
        rewritten += 1;
      } catch (error) {
        notes.push(`Codex 롤아웃 이주 실패(${path}): ${String(error)}`);
      }
    }
    for (const name of io.dirs(dir)) visit(join(dir, name), depth + 1);
  };
  visit(sessionsRoot, 0);
  return rewritten;
}
