/**
 * 이번 사이클이 만진 화면 (PLAN-UI U2 · P2) — `RepoStatus.cycleScreens` 의 재료.
 * 출처는 데몬이 커밋마다 적는 라우트↔파일 지도(screen-map.jsonl)다: 사이클의
 * 커밋(베이스 이후)마다 그 커밋의 행을 찾아, 행이 가리킨 화면을 제목과 함께
 * 내려 준다. `note` 는 그 커밋의 제목(=사용자의 말 첫 줄)이다.
 *
 * - 화면을 만지지 않은 커밋(지도에 행이 없거나 제목을 끝내 모르는 화면)은
 *   목록에서 빠진다 — 제출 확인의 「화면 밖 변경 N건」 은 웹이 센다.
 * - 한 항목은 (커밋 × 화면) 하나, 최근 커밋부터. 같은 화면이 여러 커밋에
 *   나오면 여러 번 선다 — 접는 것은 읽는 쪽의 몫이다.
 * - route 는 미리보기 안의 경로(`/member/list`, 루트는 `/`)다.
 *
 * 값은 HEAD 가 움직였을 때만 다시 읽는다 — 열쇠는 파일로 읽는 HEAD sha 와
 * 지도 파일의 시각이라, 상태 방송마다 git 을 띄우지 않는다.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RepoCore } from "./repo-core.js";
import { readScreenMap, type ScreenMapRow } from "./screen-map.js";

export interface CycleScreen {
  route: string;
  title: string;
  note: string;
  at: string;
}

/** 사이클의 커밋 하나 — git log 의 sha · 제목 · 커밋 시각. */
export interface CycleCommit {
  sha: string;
  subject: string;
  at: string;
}

/** 한 번에 읽는 커밋의 상한 — 사이클 하나가 이보다 길 일은 드물다. */
const MAX_COMMITS = 200;

/** 마크다운 링크 `[제목](주소)` — 웹의 turn-screens 와 같은 모양. */
const MD_LINK = /\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** 끝 슬래시와 해시는 화면을 바꾸지 않는다 — 웹의 screenKey 와 같은 잣대. */
function normalizePath(path: string): string {
  const noHash = path.split("#")[0] ?? "";
  const [rawPath = "", query] = noHash.split("?");
  const trimmed = rawPath.replace(/\/+$/, "");
  const base = trimmed === "" ? "/" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return query ? `${base}?${query}` : base;
}

/**
 * 게이트 입력의 날것(전체 주소 · 핀의 화면 id)을 미리보기 안의 경로로. 미리보기
 * 밖의 주소는 null — 외부 문서 링크는 화면이 아니다. origin 을 모르면(서버가
 * 꺼진 순간의 저장) 이 기계의 주소만 받는다.
 */
export function screenPathOf(raw: string, origin: string | null): string | null {
  const text = raw.trim();
  if (text === "") return null;
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (origin !== null ? url.origin !== origin : !LOOPBACK.has(url.hostname)) return null;
    return normalizePath(url.pathname + url.search);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  // 핀의 화면 id — 앞 슬래시 없는 경로, 루트는 `index`.
  return normalizePath(text === "index" ? "/" : text);
}

/** 링크 제목에서 강조만 벗긴다 — `**회원 목록**` 은 `회원 목록` 이다. */
function cleanTitle(raw: string): string {
  return raw.replace(/[*`]/g, "").trim();
}

/**
 * 한 턴의 화면들 — 그 턴이 가리킨 주소(routes)를 경로로 모으고, 답변의
 * `[제목](주소)` 에서 제목을 입힌다. 같은 화면은 한 번, 나온 순서대로.
 */
export function screensOfTurn(
  routes: readonly string[],
  answer: string | null,
  origin: string | null,
): Array<{ route: string; title: string }> {
  const titles = new Map<string, string>();
  for (const match of (answer ?? "").matchAll(MD_LINK)) {
    const path = screenPathOf(match[2] ?? "", origin);
    const title = cleanTitle(match[1] ?? "");
    if (path !== null && title !== "") titles.set(path, title);
  }
  const out: Array<{ route: string; title: string }> = [];
  const seen = new Set<string>();
  for (const raw of routes) {
    const route = screenPathOf(raw, origin);
    if (route === null || seen.has(route)) continue;
    seen.add(route);
    out.push({ route, title: titles.get(route) ?? "" });
  }
  return out;
}

/** `git log --format=%H%x1f%s%x1f%cI` 의 출력 — 최근 커밋부터. */
export function parseCycleLog(output: string): CycleCommit[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.split("\x1f"))
    .filter((fields) => (fields[0] ?? "").trim() !== "")
    .map(([sha = "", subject = "", at = ""]) => ({ sha: sha.trim(), subject, at: at.trim() }));
}

/** 행의 화면 — 새 행은 screens 를, 옛 행은 날 routes 를 경로로 읽는다(제목 없음). */
function rowScreens(row: ScreenMapRow): Array<{ route: string; title: string }> {
  return row.screens ?? screensOfTurn(row.routes, null, null);
}

/**
 * 순수 판정 — 사이클의 커밋(최근부터)과 지도의 행(오래된 것부터)에서 바뀐 화면
 * 목록을 짓는다. 제목이 비는 화면은 같은 경로의 가장 최근 제목을 빌리고, 그래도
 * 없으면 뺀다(화면을 만졌다고 말할 이름이 없다).
 */
export function deriveCycleScreens(
  commits: readonly CycleCommit[],
  rows: readonly ScreenMapRow[],
): CycleScreen[] {
  const bySha = new Map<string, ScreenMapRow>();
  const titleByRoute = new Map<string, string>();
  for (const row of rows) {
    bySha.set(row.sha, row);
    for (const screen of rowScreens(row)) {
      if (screen.title !== "") titleByRoute.set(screen.route, screen.title);
    }
  }
  const out: CycleScreen[] = [];
  for (const commit of commits) {
    const row = bySha.get(commit.sha);
    if (row === undefined) continue;
    const seen = new Set<string>();
    for (const screen of rowScreens(row)) {
      if (seen.has(screen.route)) continue;
      seen.add(screen.route);
      const title = screen.title || titleByRoute.get(screen.route) || "";
      if (title === "") continue;
      out.push({ route: screen.route, title, note: commit.subject, at: commit.at });
    }
  }
  return out;
}

/**
 * HEAD 의 sha 를 git 없이 읽는다 — `.git/HEAD` 와 그 ref(느슨한 파일 또는
 * packed-refs). 못 읽으면 null(부르는 쪽이 시간으로 열쇠를 대신한다).
 */
export function readHeadSha(repoRoot: string): string | null {
  const gitDir = join(repoRoot, ".git");
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
    const ref = head.slice("ref: ".length).trim();
    try {
      return readFileSync(join(gitDir, ref), "utf8").trim();
    } catch {
      const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
      const line = packed.split(/\r?\n/).find((row) => row.endsWith(` ${ref}`));
      return line?.split(" ")[0] ?? null;
    }
  } catch {
    return null;
  }
}

/** 열쇠를 못 읽는 클론의 다시 읽기 간격 — 방송마다 git 을 띄우지 않는 상한. */
const FALLBACK_KEY_MS = 30_000;

/**
 * 프로젝트 하나의 바뀐 화면 캐시. `current()` 는 동기다(스냅샷이 부른다) —
 * 열쇠가 움직였으면 뒤에서 다시 읽고, 값이 바뀌면 onChange 로 다시 방송한다.
 */
export class CycleScreens {
  private key: string | null = null;
  private value: CycleScreen[] = [];
  private inFlight = false;

  constructor(
    private readonly deps: {
      core: RepoCore;
      /** 프로젝트 폴더 — screen-map.jsonl 이 사는 곳. */
      projectRoot: string;
      onChange: () => void;
    },
  ) {}

  current(): CycleScreen[] {
    if (!this.inFlight && this.keyNow() !== this.key) void this.refresh();
    return this.value;
  }

  private keyNow(): string {
    const core = this.deps.core;
    let mapAt = 0;
    try {
      mapAt = statSync(join(this.deps.projectRoot, "screen-map.jsonl")).mtimeMs;
    } catch {
      // 지도가 아직 없다 — 0 이 곧 "없음" 의 열쇠다.
    }
    const head = readHeadSha(core.root) ?? `t${Math.floor(Date.now() / FALLBACK_KEY_MS)}`;
    return `${head}|${core.baseBranch}|${mapAt}`;
  }

  private async refresh(): Promise<void> {
    this.inFlight = true;
    try {
      // 읽는 사이에 열쇠가 또 움직이면 한 번 더 — 마지막 모습을 싣는다.
      for (let round = 0; round < 3; round++) {
        const key = this.keyNow();
        const next = await this.compute().catch(() => this.value);
        this.key = key;
        if (JSON.stringify(next) !== JSON.stringify(this.value)) {
          this.value = next;
          this.deps.onChange();
        }
        if (this.keyNow() === key) break;
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async compute(): Promise<CycleScreen[]> {
    const core = this.deps.core;
    if (!core.isCloned()) return [];
    const output = await core
      .git([
        "log",
        "-n",
        String(MAX_COMMITS),
        "--format=%H%x1f%s%x1f%cI",
        `origin/${core.baseBranch}..HEAD`,
      ])
      .catch(() => "");
    const commits = parseCycleLog(output);
    if (commits.length === 0) return [];
    return deriveCycleScreens(commits, await readScreenMap(this.deps.projectRoot));
  }
}
