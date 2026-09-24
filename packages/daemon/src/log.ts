import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 데몬의 파일 로그. 데스크톱 앱이 데몬을 in-process 로 키우므로 console 은
 * 사용자에게 존재하지 않는 출력이다 — 지원에 필요한 흔적은 파일로 남는다.
 * 하루 한 파일(`daemon-YYYY-MM-DD.log`), 7일 보존. 로깅 자체가 도구를 죽일
 * 수는 없다: 무엇을 써도 삼키고, 최악은 console 로 한 줄 떨어지는 것까지다.
 */

type LogLevel = "info" | "warn" | "error";

/** 데몬 안팎이 공유하는 최소한의 싱크. `fields` 값은 JSON 으로 직렬화된다. */
export interface DaemonLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** 하루 치 파일을 만들 때까지의 날짜와, 그 이름이 따르는 모양. */
const FILE_PREFIX = "daemon-";
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.log$/;

/** 보존 일수 — 문서가 약속한 값(설정 화면 없음, 상수로 굳는다). */
const RETENTION_DAYS = 7;

/** 기록 위치. e2e 스위트가 임시 폴더로 돌리는 오버라이드. */
export function daemonLogDir(): string {
  return process.env.COLO_DESIGN_LOG_DIR ?? join(homedir(), ".colo-design", "logs");
}

function dayStamp(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** 하루가 지나면 그동안 쌓인 지난 파일을 지운다. 이름이 아니라 날짜로 판단한다. */
function pruneOldLogs(dir: string, today: Date, keepDays: number): void {
  const horizon = today.getTime() - keepDays * 24 * 60 * 60 * 1000;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // 폴더가 없으면 지울 것도 없다.
  }
  for (const name of names) {
    const day = name.slice(FILE_PREFIX.length);
    if (!name.startsWith(FILE_PREFIX) || !DAY_FILE.test(day)) continue;
    // `2026-08-20.log` 에서 날짜만 — 확장자가 붙은 채로는 Date.parse 가 NaN 이다.
    const parsed = Date.parse(day.slice(0, "YYYY-MM-DD".length));
    if (Number.isNaN(parsed) || parsed >= horizon) continue;
    try {
      rmSync(join(dir, name));
    } catch {
      // 지우지 못한 옛 파일은 다음 날 다시 후보가 된다.
    }
  }
}

/** Error 는 이름·메시지·지문만 — stack 전체는 잡음보다 줄거리가 아니다. */
function serializable(fields: Record<string, unknown>): Record<string, unknown> {
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    plain[key] = sanitizeValue(value);
  }
  return plain;
}

/**
 * 로그의 값이 되는 말에서 비밀·주소를 눌러 닫는다 — 로그는 지원의 흔적이지
 * 자료의 사본이 아니다 (zcode error-sanitizer 참조). 오류 문장은 SDK·git·
 * GitHub 을 지나오며 토큰과 사용자 경로를 그대로 실어 오는 자리라, 여기서
 * 한 번 걷는 것이 유일한 걸러마다.
 */
const SECRET_PATTERN =
  /(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{8,}|rk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{10,}|xox[bp]-[A-Za-z0-9-]+|hooks\.slack\.com\/services\/[A-Za-z0-9/]+|Bearer\s+[A-Za-z0-9._~+/=-]+)/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 계정 이름이 사는 절대 경로의 머리 — ~ 로 눌러 닫는다. 나머지 경로는 지원의 단서로 남는다. */
const USER_ROOT_PATTERNS: Array<[RegExp, string]> = [
  [/\/Users\/[^/\\\s"':]+/g, "~"],
  [/\/home\/[^/\\\s"':]+/g, "~"],
  [/C:\\Users\\[^/\\\s"':]+/g, "~"],
];

export function sanitizeText(text: string): string {
  // Bearer 쪽은 어휘(Bearer )를 남긴다 — 어떤 종류의 비밀인지의 단서다.
  let out = text.replace(SECRET_PATTERN, (matched) =>
    matched.startsWith("Bearer ") ? "Bearer {secret}" : "{secret}",
  );
  out = out.replace(EMAIL_PATTERN, "{email}");
  for (const [pattern, replacement] of USER_ROOT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (value instanceof Error) return { name: value.name, message: sanitizeText(value.message) };
  if (depth >= 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  const plain: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) plain[key] = sanitizeValue(item, depth + 1);
  return plain;
}

/**
 * 파일 로거를 만든다. `now` 는 테스트가 날짜를 흘려 보내는 주사바늘 — 제품
 * 코드는 건드리지 않는다. 폴더는 첫 줄이 나갈 때 생기고, 날짜가 바뀌는 첫
 * 쓰기에서 보존 창을 넘긴 파일을 치운다.
 */
export function createFileLogger(options?: { dir?: string; now?: () => Date }): DaemonLogger {
  const dir = options?.dir ?? daemonLogDir();
  const now = options?.now ?? ((): Date => new Date());
  let lastDay: string | null = null;
  let complained = false;

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    try {
      const at = now();
      const day = dayStamp(at);
      if (lastDay === null) {
        mkdirSync(dir, { recursive: true });
        pruneOldLogs(dir, at, RETENTION_DAYS);
      } else if (day !== lastDay) {
        pruneOldLogs(dir, at, RETENTION_DAYS);
      }
      lastDay = day;
      // 한 줄에 실을 수 없는 말은 한 줄로 눌러 담는다 — 파일은 줄 단위로 읽힌다.
      const line =
        `${at.toISOString()}\t${level}\t${message.replace(/\r?\n/g, " ⏎ ")}` +
        (fields && Object.keys(fields).length > 0
          ? `\t${JSON.stringify(serializable(fields))}`
          : "") +
        "\n";
      appendFileSync(join(dir, `${FILE_PREFIX}${day}.log`), line);
    } catch (error) {
      // 로깅의 실패를 로깅하다 무한히 외치지는 않는다 — 한 번만.
      if (!complained) {
        complained = true;
        console.error(`[log] 파일 로그를 쓰지 못했습니다: ${String(error)}`);
      }
    }
  };

  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
