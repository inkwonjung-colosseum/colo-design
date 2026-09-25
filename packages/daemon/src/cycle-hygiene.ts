/**
 * 위생 (PLAN L3 16행 · 단계 9) — 몇 달의 사용이 클론과 프로젝트 폴더에 남기는
 * 것을 치운다. 판정(dueHygiene · hygieneDue · endedBranchesDue)은 순수하고,
 * 조치의 몸통은 감독자(cycle-supervisor)의 hygiene 이 차선 안에서 항목마다
 * 부른다 — 여기의 git 도우미도 그 차선 칸 안에서 불린다고 가정한다.
 *
 * 기한은 원장 hygiene 의 시각이 잣대다. 시각이 없으면(한 번도 안 함) 지난 것이다.
 * - gc · fsck · 캡처 브랜치 크기 — 7일
 * - prune(반려 브랜치 정리 · 임시 폴더) · 저장소 이동 · 디스크 여유 — 1일
 */
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pruneStagedAttachments } from "./agent/attachments.js";
import type { CycleLedger } from "./cycle-ledger.js";
import { parseRepoSlug } from "./github.js";
import type { RepoCore } from "./repo-core.js";
import { detailOf } from "./repo-core.js";
import { ASSETS_BRANCH } from "./repo-publish.js";
import { summaryDirOf } from "./repo-summary.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 항목마다의 간격 — 이만큼 지나면 다시 돈다. */
export const HYGIENE_PERIODS = {
  gc: 7 * DAY_MS,
  fsck: 7 * DAY_MS,
  prune: DAY_MS,
  assets: 7 * DAY_MS,
  move: DAY_MS,
  disk: DAY_MS,
} as const;

export type HygieneItem = keyof typeof HYGIENE_PERIODS;

/** 원장 hygiene 에서 그 항목의 시각이 사는 자리. */
export type HygieneStamp = `${HygieneItem}At`;

/** 항목을 도는 차례 — origin 을 바꾸는 저장소 이동(move)은 origin 을 쓰는
 *  항목(prune 의 원격 삭제 · assets 의 읽기)보다 뒤에 선다. */
export const HYGIENE_ORDER: readonly HygieneItem[] = [
  "disk",
  "prune",
  "gc",
  "fsck",
  "assets",
  "move",
];

/** 반려 브랜치를 남기는 날 — 초대 v4 의 lifecycle.keepRejectedDays 기본값(O3). */
export const DEFAULT_KEEP_REJECTED_DAYS = 14;

/** 임시 파일의 수명 — 요약 폴더와 그 대화 기록(첨부의 7일과 같다). */
export const TEMP_TTL_MS = 7 * DAY_MS;

/**
 * 재클론 흔적의 수명 — 되살리기가 *성공한* 흔적만 기한 뒤 지운다. 옛 클론
 * (`repo.corrupt-<시각>`, node_modules 까지 남아 디스크를 두 배로 쓴다)은
 * 7일, 구해 둔 폴더(`salvage/<시각>`)는 30일. 디스크 부족 정리는 같은 규칙을
 * 1일로 줄인다. 실패한 흔적은 지우지 않는다 — 개발자가 손으로 꺼내야 한다.
 */
export const SALVAGE_MOVED_TTL_MS = 7 * DAY_MS;
export const SALVAGE_DIR_TTL_MS = 30 * DAY_MS;
export const SALVAGE_TTL_DISK_LOW_MS = DAY_MS;

/**
 * 지울 재클론 흔적의 자리들 — 원장의 salvages 기록에서 기한이 지난 것만.
 * 되살리기가 실패한 기록은 어떤 경우에도 내놓지 않는다(모듈 머리 참고).
 */
export function salvageCleanupPlan(
  traces: CycleLedger["salvages"],
  now: number,
  diskLow: boolean,
): string[] {
  const remove: string[] = [];
  for (const trace of traces) {
    if (!trace.restored) continue;
    const age = now - Date.parse(trace.at);
    if (!Number.isFinite(age) || age < 0) continue; // 깨진 시각은 다음으로 미룬다
    const movedDue = diskLow ? SALVAGE_TTL_DISK_LOW_MS : SALVAGE_MOVED_TTL_MS;
    const salvageDue = diskLow ? SALVAGE_TTL_DISK_LOW_MS : SALVAGE_DIR_TTL_MS;
    if (trace.movedTo !== null && age >= movedDue) remove.push(trace.movedTo);
    if (trace.salvageDir !== null && age >= salvageDue) remove.push(trace.salvageDir);
  }
  return remove;
}

/** 디스크 여유의 문턱 (O8) — 이 아래면 도구의 것부터 치운다. */
export const DISK_LOW_BYTES = 2 * 1024 ** 3;

/** `fs.statfs` 의 두 값 — 시험이 주입하는 가짜도 이 모양이다. */
export interface DiskStats {
  bavail: number | bigint;
  bsize: number | bigint;
}

/** 쓸 수 있는 여유(바이트) — 일반 사용자에게 남은 블록 수 × 블록 크기. */
export function freeBytesOf(stats: DiskStats): number {
  return Number(stats.bavail) * Number(stats.bsize);
}

/** 사람이 읽는 크기 — 알림과 로그의 한 조각. */
export function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

/**
 * 기한이 지난 위생 항목 — HYGIENE_ORDER 차례로. 시각이 미래에 있으면(시계가
 * 뒤로 갔다) 지난 것으로 친다: 그렇지 않으면 잘못 앞서 있던 시계만큼 위생이
 * 몇 달이고 멈춘다.
 */
export function dueHygiene(hygiene: CycleLedger["hygiene"], now: number): HygieneItem[] {
  return HYGIENE_ORDER.filter((item) => {
    const stamp = hygiene[`${item}At` as HygieneStamp];
    if (stamp === undefined) return true;
    const elapsed = now - Date.parse(stamp);
    return Number.isNaN(elapsed) || elapsed < 0 || elapsed >= HYGIENE_PERIODS[item];
  });
}

/** 16행의 관찰 — 하나라도 기한이 지났으면 참(PLAN 단계 9). */
export function hygieneDue(ledger: CycleLedger, now: number): boolean {
  return dueHygiene(ledger.hygiene, now).length > 0;
}

type BranchRecord = CycleLedger["branches"][number];

/**
 * 끝난 브랜치 기록 중 정리할 것 — 반려는 keepDays 가 지나면 로컬 · 원격에서
 * 지운다(L4 · O3). 병합의 지연 삭제 표식(deleteRemoteAfterPush)은 12행의 것이라
 * 건드리지 않고, 표식 없는 병합 기록은 같은 날수 뒤 원장에서만 걷는다 —
 * 그 브랜치는 랜딩이 이미 지웠다.
 */
export function endedBranchesDue(
  branches: BranchRecord[],
  keepDays: number,
  now: number,
): { rejected: BranchRecord[]; staleMerged: BranchRecord[] } {
  const cutoff = now - keepDays * DAY_MS;
  const old = (entry: BranchRecord) => {
    const ended = Date.parse(entry.endedAt);
    return !Number.isNaN(ended) && ended <= cutoff;
  };
  return {
    rejected: branches.filter((entry) => entry.state === "closed" && old(entry)),
    staleMerged: branches.filter(
      (entry) =>
        entry.state === "merged" && entry.deleteRemoteAfterPush === undefined && old(entry),
    ),
  };
}

/**
 * 옮겨진 저장소의 새 주소 — 레지스트리 주소의 `owner/repo` 자리만 GitHub 이
 * 말하는 full_name 으로 바꾼다. 스킴 · 호스트 · `.git` 꼬리 같은 나머지 철자는
 * 그대로 둔다(https · scp · ssh 어느 모양이든). GitHub 주소가 아니거나 이름이
 * 올바르지 않으면 null — 모르는 모양을 추측으로 고치지 않는다.
 */
export function movedRepoUrl(url: string, fullName: string): string | null {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return null;
  const slug = parseRepoSlug(url);
  if (slug === null) return null;
  const at = url.lastIndexOf(`${slug.owner}/${slug.repo}`);
  if (at < 0) return null;
  return `${url.slice(0, at)}${fullName}${url.slice(at + slug.owner.length + slug.repo.length + 1)}`;
}

// ————— 임시 폴더 —————

/**
 * Claude CLI 가 그 cwd 의 대화 기록을 두는 폴더 — `<설정 폴더>/projects/<인코딩>`.
 * 인코딩은 CLI 의 것(실경로의 영숫자 아닌 글자를 `-` 로) — claude/driver.ts 의
 * deleteAll 과 같은 규칙이다. 다른 공급자의 기계 턴은 기록을 남기지 않는다
 * (codex 의 --ephemeral · omp 의 --no-session).
 */
export function claudeTranscriptDir(cwd: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // 폴더가 이미 없다 — 받은 철자로 인코딩한다.
  }
  return join(configDir, "projects", resolve(real).replace(/[^a-zA-Z0-9]/g, "-"));
}

/** 폴더 바로 아래에서 mtime 이 cutoff 보다 오래된 것을 지운다 — 지운 수. */
function pruneOlderThan(dir: string, cutoff: number): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // 폴더가 없다 — 치울 것도 없다.
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (lstatSync(path).mtimeMs >= cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // 한 항목의 실패가 나머지를 막지 않는다 — 다음 날 다시 본다.
    }
  }
  return removed;
}

/**
 * 도구의 임시 파일을 치운다 (PLAN 단계 9) — 요약 턴(repo-summary)의 작업 폴더
 * `summary/` 와 그 대화 기록 중 7일 넘은 것, 그리고 첨부의 7일 거둠을 한 번.
 * 지운 수를 돌려준다(첨부는 세지 않는다 — 그쪽이 스스로 센다).
 */
export function pruneTempFolders(cloneRoot: string, now: number): number {
  const cutoff = now - TEMP_TTL_MS;
  const summary = summaryDirOf(cloneRoot);
  const removed =
    pruneOlderThan(summary, cutoff) + pruneOlderThan(claudeTranscriptDir(summary), cutoff);
  pruneStagedAttachments(cloneRoot);
  return removed;
}

// ————— git 도우미 — 감독자의 차선 칸 안에서 부른다 —————

/**
 * `git fsck --connectivity-only` — 손상이면 그 말(생니타이저는 알림 쪽이
 * 거친다), 멀쩡하면 null. 매달린 객체는 손상이 아니다(--no-dangling).
 */
export async function fsckClone(core: RepoCore): Promise<string | null> {
  try {
    await core.git(["fsck", "--connectivity-only", "--no-progress", "--no-dangling"]);
    return null;
  } catch (error) {
    return detailOf(error, core.pat);
  }
}

/**
 * 캡처 브랜치의 크기 (O4 — 기록만) — 원격 `colo-design-assets` 끝 트리의 파일
 * 수와 크기 합. 원격에 그 브랜치가 없으면 null, 원격에 닿지 못했으면
 * undefined(모름 — 호출자는 지난 기록을 지킨다).
 */
export async function measureAssets(
  core: RepoCore,
): Promise<{ files: number; bytes: number } | null | undefined> {
  // 전체 ref 이름으로 묻는다 — 짧은 이름은 꼬리 일치라 `x/colo-design-assets` 도 잡는다.
  const listed = await core
    .git(["ls-remote", "origin", `refs/heads/${ASSETS_BRANCH}`])
    .catch(() => undefined);
  if (listed === undefined) return undefined;
  const remoteSha = listed.trim().split(/\s+/)[0] ?? "";
  if (remoteSha === "") return null;
  const ref = `refs/remotes/origin/${ASSETS_BRANCH}`;
  const localSha = (await core.git(["rev-parse", "--verify", "-q", ref]).catch(() => "")).trim();
  if (localSha !== remoteSha) {
    // 제출이 캡처를 올릴 때 이미 받아 둔다 — 다른 기계가 올린 뒤에만 받는다.
    const fetched = await core
      .git(["fetch", "origin", `refs/heads/${ASSETS_BRANCH}:${ref}`])
      .then(() => true)
      .catch(() => false);
    if (!fetched) return undefined;
  }
  const tree = await core
    .git(["-c", "core.quotepath=false", "ls-tree", "-r", "-l", "--full-tree", ref])
    .catch(() => undefined);
  if (tree === undefined) return undefined;
  let files = 0;
  let bytes = 0;
  for (const line of tree.split("\n")) {
    const [meta = ""] = line.split("\t");
    const [, type, , size] = meta.trim().split(/\s+/);
    if (type !== "blob") continue;
    files += 1;
    bytes += Number(size) || 0;
  }
  return { files, bytes };
}
