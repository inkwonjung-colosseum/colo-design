/**
 * 클론 손상과 재클론 (PLAN 단계 9) — 손상 신호를 좁게 읽고, 옛 클론에서 사용자의
 * 작업(커밋 안 된 변경 · 올라가지 않은 커밋)을 `projects/<slug>/salvage/<시각>/` 에
 * 구해 둔 뒤, 새로 받은 클론에 되살린다. 절차의 순서와 원장 기록(reclone)은
 * 감독자(cycle-supervisor)가 쥐고, 여기에는 git 과 파일의 몸통만 있다 — 모두
 * 감독자 틱의 차선 칸 안에서 불린다고 가정한다.
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realpathBestEffort } from "./paths.js";
import type { RepoCore } from "./repo-core.js";
import { detailOf } from "./repo-core.js";
import { alignCycleBranch } from "./repo-publish.js";

/**
 * 손상의 말 — git 이 인덱스나 HEAD 를 읽지 못할 때만 이렇게 말한다. 짧게 깨진
 * 인덱스는 "smaller than expected", 긴 쓰레기는 "bad signature … index file
 * corrupt", 없는 HEAD 커밋은 "bad object HEAD", 없는 HEAD 트리는 "bad tree
 * object HEAD", 깨진 .git 은 "not a git repository" (2.53 실측).
 */
const CORRUPTION_SIGNALS = [
  "index file corrupt",
  "index file smaller than expected",
  "not a git repository",
  "bad object",
  "bad tree object",
];

/** 이 말이 손상 신호인가 — 탐침의 출력에만 쓴다(다른 명령의 말에 쓰면 넓어진다). */
export function corruptionSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return CORRUPTION_SIGNALS.some((signal) => lower.includes(signal));
}

/**
 * 도구의 보관(커밋)이 말하는 손상 — 인덱스가 가리키는 객체가 저장소에 없어
 * 트리를 짓지 못했다("invalid object … Error building trees"). 멀쩡한 클론에서는
 * 나지 않는 말이다. 탐침이 보지 않는 깊은 손상(없는 블롭 — fsck 의 몫)은 먼저
 * 보관을 막는데, 막힌 보관(5행)이 판정의 앞자리를 차지해 위생의 fsck 까지 틱이
 * 닿지 못하므로 여기서 알아본다.
 */
export function commitCorruptionSignal(text: string): boolean {
  return corruptionSignal(text) || /invalid object|error building trees/i.test(text);
}

/** 도장 — 폴더 이름에 쓰는 UTC 시각. 콜론이 없어 Windows 에서도 쓸 수 있다. */
export function salvageStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * 손상 탐침 (PLAN 단계 9) — HEAD 와 인덱스를 읽는 세 명령의 말만 본다. 없는
 * sha 를 가리킨 흔한 오류(로컬에 없는 PR head 같은)는 다른 명령에서 나고
 * 여기에는 오지 않는다 — 탐침을 좁힌 이유다. 멀쩡하면 null, 손상이면 git 의 말.
 */
export async function probeCorruption(core: RepoCore): Promise<string | null> {
  const gitDir = join(core.root, ".git");
  let isDir = false;
  try {
    isDir = statSync(gitDir).isDirectory();
  } catch {
    return null; // 클론이 없다 — 준비(bootstrap)의 몫이다.
  }
  const said = async (args: string[]): Promise<string | null> => {
    try {
      await core.git(args);
      return null;
    } catch (error) {
      return detailOf(error, core.pat);
    }
  };
  // 1) .git 을 저장소로 읽는가 — 깨진 .git 을 git 은 건너뛰고 부모 폴더의
  //    저장소를 찾는다. 그때는 오류 대신 남의 git 폴더를 답하므로 자리를 견준다.
  try {
    const answered = (await core.git(["rev-parse", "--absolute-git-dir"])).trim();
    if (isDir && realpathBestEffort(answered) !== realpathBestEffort(gitDir)) {
      return `not a git repository — git 이 이 클론의 .git 대신 ${answered} 를 읽습니다`;
    }
  } catch (error) {
    const detail = detailOf(error, core.pat);
    return corruptionSignal(detail) ? detail : null;
  }
  // 2) HEAD 의 커밋 — 첫 커밋 전(unborn)의 "does not have any commits" 는 손상이 아니다.
  const head = await said(["log", "-1", "--format=%H"]);
  if (head !== null && corruptionSignal(head)) return head;
  // 3) 인덱스와 HEAD 의 트리 — 종료 코드 1("다름")은 말이 없어 걸리지 않는다.
  const index = await said(["diff", "--cached", "--quiet"]);
  if (index !== null && corruptionSignal(index)) return index;
  return null;
}

/** 구해 둔 것의 목록 — 원장의 reclone.salvage 와 폴더의 salvage.json 이 같은 모양이다. */
export interface SalvageRecord {
  /** 구해 둔 폴더 — `projects/<slug>/salvage/<시각>`. */
  dir: string;
  /** 되살릴 사이클 브랜치 — 없으면 null. */
  branch: string | null;
  /** unpushed.bundle 이 담은 ref — `refs/heads/<branch>` 또는 `HEAD`. 묶을 커밋이 없었으면 null. */
  bundleRef: string | null;
  /** changes.patch 가 있는가. */
  patch: boolean;
}

/**
 * 구해 두기 — 옛 클론에서 사용자의 작업을 dir 에 옮겨 적는다. 실패하면 던진다
 * (호출자는 재클론하지 않고 개발자에게 알린다 — 구하지 못한 작업을 버리는 재클론은
 * 하지 않는다).
 *
 * - 커밋 안 된 변경 → changes.patch. 깨진 인덱스를 읽지 않도록 HEAD 로 새로 만든
 *   임시 인덱스(GIT_INDEX_FILE)에 견준다 — 인덱스가 손상의 가장 흔한 자리다.
 *   고친 파일의 옛 블롭까지 없으면 패치를 만들 수 없어 실패한다.
 * - 추적되지 않은 파일 → untracked/ 에 같은 경로로 복사. node_modules 는 설치가
 *   다시 만들므로 옮기지 않는다.
 * - 올라가지 않은 커밋 → unpushed.bundle (`origin/<base>..<branch>`, 원격 추적
 *   ref 가 없으면 브랜치 전체). 사이클 브랜치가 없으면 HEAD 의 앞선 커밋을 묶는다.
 */
export async function salvageClone(
  core: RepoCore,
  dir: string,
  branch: string | null,
): Promise<SalvageRecord> {
  mkdirSync(dir, { recursive: true });
  const index = join(dir, "index.tmp");
  const env = { GIT_INDEX_FILE: index };
  let patch = false;
  let untracked = 0;
  try {
    await core.git(["read-tree", "HEAD"], core.root, env);
    // 작업 파일의 해시로 임시 인덱스를 맞춘다 — 그대로인 파일은 객체를 읽지 않고
    // 지나가므로, fsck 가 본 "없는 블롭" 이 고치지 않은 파일의 것이면 구해 두기가
    // 선다(맞추지 않으면 diff 가 그 블롭을 읽으려다 멈춘다). -q: 고친 파일이 있어도
    // 멈추지 않는다.
    await core.git(["update-index", "-q", "--refresh"], core.root, env);
    // 바이트 그대로 — 텍스트로 읽으면 UTF-8 이 아닌 파일의 변경이 망가진다.
    const diff = await core.git(
      [
        "diff",
        "HEAD",
        "--binary",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
      ],
      core.root,
      env,
      true,
    );
    if (diff !== "") {
      writeFileSync(join(dir, "changes.patch"), Buffer.from(diff, "base64"));
      patch = true;
    }
    const listed = await core.git(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      core.root,
      env,
    );
    for (const rel of listed.split("\0")) {
      // 빈 조각 · 안쪽 저장소(끝이 /) · 설치물은 옮기지 않는다.
      if (rel === "" || rel.endsWith("/") || rel.split("/").includes("node_modules")) continue;
      const target = join(dir, "untracked", rel);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(core.root, rel), target, { verbatimSymlinks: true });
      untracked += 1;
    }
  } finally {
    rmSync(index, { force: true });
  }

  const refExists = async (ref: string) =>
    (await core.git(["rev-parse", "--verify", "-q", ref]).catch(() => "")).trim() !== "";
  const tip =
    branch !== null && (await refExists(`refs/heads/${branch}`)) ? `refs/heads/${branch}` : "HEAD";
  const base = `refs/remotes/origin/${core.baseBranch}`;
  const range = (await refExists(base)) ? `${base}..${tip}` : tip;
  const ahead = Number((await core.git(["rev-list", "--count", range])).trim()) || 0;
  let bundleRef: string | null = null;
  if (ahead > 0) {
    await core.git(["bundle", "create", join(dir, "unpushed.bundle"), range]);
    bundleRef = tip;
  }
  const record: SalvageRecord = { dir, branch, bundleRef, patch };
  // 사람이 읽는 목록 — 되살리기가 실패하면 개발자가 이 폴더를 연다.
  writeFileSync(
    join(dir, "salvage.json"),
    `${JSON.stringify({ ...record, untracked, base: core.baseBranch }, null, 2)}\n`,
  );
  return record;
}

/**
 * 되살리기 — 새 클론에 구해 둔 것을 다시 얹는다. 성공이면 null, 실패면 한국어
 * 이유(호출자가 개발자 알림 clone:restore 의 자세히에 싣는다). 실패해도 구해 둔
 * 폴더는 그대로 남는다.
 *
 * 1. 묶음을 fetch 해 사이클 브랜치를 되살리고 checkout(묶음이 HEAD 면 베이스를
 *    fast-forward — 6행이 새 사이클로 입양한다).
 * 2. changes.patch 를 `git apply --binary`, 안 되면 `--3way`. 그래도 안 되면 반쯤
 *    얹힌 변경과 충돌 표식을 걷는다 — 5행이 표식을 보관하지 않게.
 * 3. 추적되지 않은 파일을 제자리로 복사한다.
 */
export async function restoreSalvage(
  core: RepoCore,
  record: SalvageRecord,
): Promise<string | null> {
  const git = (args: string[]) => core.git(args);
  const bundle = join(record.dir, "unpushed.bundle");
  try {
    if (record.bundleRef !== null) {
      if (record.bundleRef.startsWith("refs/heads/")) {
        await git(["fetch", bundle, `${record.bundleRef}:${record.bundleRef}`]);
      } else {
        await git(["fetch", bundle, record.bundleRef]);
        await git(["merge", "--ff-only", "FETCH_HEAD"]);
      }
    }
    if (record.branch !== null) await alignCycleBranch(git, record.branch);
  } catch (error) {
    return `올라가지 않은 커밋을 되살리지 못했습니다 — ${detailOf(error, core.pat)}`;
  }
  let failure: string | null = null;
  if (record.patch) {
    const patch = join(record.dir, "changes.patch");
    try {
      await git(["apply", "--binary", patch]);
    } catch {
      try {
        await git(["apply", "--binary", "--3way", patch]);
      } catch (error) {
        await git(["reset", "--hard", "-q"]).catch(() => "");
        failure = `커밋 안 된 변경을 다시 얹지 못했습니다 — ${detailOf(error, core.pat)}`;
      }
    }
  }
  const untracked = join(record.dir, "untracked");
  if (existsSync(untracked)) {
    cpSync(untracked, core.root, { recursive: true, force: true, verbatimSymlinks: true });
  }
  return failure;
}
