/**
 * 관찰 (PLAN L2 · 단계 2b) — 감독자의 눈. 클론의 git 상태와 GitHub 의 PR
 * 상태를 읽어 CycleSnapshot 을 만든다. 판정(nextCycleAction)이 순수 함수로
 * 살 수 있는 이유가 이 몸통이다: 모든 읽기가 여기 몰려 있다.
 *
 * 계약:
 * - 쓰기는 fetch 하나뿐이다 — observeCycle 은 차선 작업 안(감독자의
 *   `lane.run("supervise", …)`)에서 불린다고 가정한다. 네트워크 실패는
 *   삼키고 관찰은 지난 원격으로 계속된다(githubReachable 판단과 별개다).
 * - 원장을 바꾸지 않는다. 읽기만 한다.
 * - git 이 답하지 않는 필드는 중립값(0 · null · [])으로 내려앉는다 — 관찰이
 *   실패해서 감독자가 죽는 일이 없어야 한다(I5).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { conflictMarkers } from "./conflict-markers.js";
import type { CycleLedger } from "./cycle-ledger.js";
import type { CycleSnapshot } from "./cycle-reconcile.js";
import type { GitHubClient } from "./github.js";
import { type RepoCore, STASH_MESSAGE } from "./repo-core.js";

/**
 * 관찰이 스스로 읽을 수 없는 것들 — 감독자가 프로젝트의 살아 있는 부분에서
 * 가져다 준다. 전부 함수라 관찰 순간의 값을 읽는다.
 */
export interface ObserveDeps {
  /** 이 클론에서 턴이 도는 중 — SessionManager.busyIn(root) 를 넣는다. */
  turnRunning: () => boolean;
  /** 설치 해시가 바뀌었거나 node_modules 가 없음 — RepoWorkspace 의 bringup.dependenciesMoved() 같은 것. */
  installStale: () => boolean;
  /** RepoCore 의 gitHubClient 팩토리 — 토큰이 없으면 null. */
  github: () => GitHubClient | null;
  /** 연결 코드가 만료됐다는 기록 — 만료면 GitHub 의 말을 믿지 않는다. */
  githubAuthExpired: () => boolean;
  /** GitHub 의 owner/repo — RepoCore.repoSlug() 를 넣는다. */
  slug: () => { owner: string; repo: string } | null;
}

/** 관찰 안에서만 쓰는 git 읽기 — 실패는 빈 문자열로 흘린다. */
async function gitText(core: RepoCore, args: string[]): Promise<string> {
  return await core.git(args).catch(() => "");
}

/** `rev-list --count` 같은 한 수 — 실패는 null(모름)이다. */
async function gitCount(core: RepoCore, args: string[]): Promise<number | null> {
  const out = await gitText(core, args);
  const value = Number(out.trim());
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** `rev-list --left-right --count` 의 두 수 — 실패는 null. */
async function gitCountPair(core: RepoCore, args: string[]): Promise<[number, number] | null> {
  const out = await gitText(core, args);
  const [left = "", right = ""] = out.trim().split(/\s+/);
  const a = Number(left);
  const b = Number(right);
  return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 ? [a, b] : null;
}

/**
 * 진행 중인 git 조작의 표식 — `rev-parse --git-path` 가 워크트리에서도
 * 맞는 경로를 준다. 표식이 없는 이름도 경로를 돌려주므로 실존 여부를 본다.
 */
async function detectGitOp(core: RepoCore): Promise<CycleSnapshot["gitOp"]> {
  const marks: Array<[string, NonNullable<CycleSnapshot["gitOp"]>]> = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
  ];
  for (const [name, op] of marks) {
    const path = (await gitText(core, ["rev-parse", "--git-path", name])).trim();
    if (path !== "" && existsSync(resolve(core.root, path))) return op;
  }
  return null;
}

/**
 * 표식이 남은 파일 — 미해결 파일과 원장이 기억하는 조작 대상(pendingOp.files)
 * 의 합집합을 읽는다. 지워졌거나 바이너리라 읽지 못하는 파일은 건너뛴다.
 */
function markersLeftIn(root: string, files: string[]): string[] {
  const left: string[] = [];
  for (const file of files) {
    try {
      if (conflictMarkers(readFileSync(join(root, file), "utf8"))) left.push(file);
    } catch {
      // 지워진 파일 · 바이너리 — 표식이 없는 것으로 친다.
    }
  }
  return left;
}

/**
 * 랜딩이 남겨 둬야 할 것(L4) — 병합이면 PR head 이후의 로컬 커밋 수, 반려면
 * 브랜치 전체 커밋 수. 안전 규칙: headSha 를 못 믿으면(없거나 로컬에 그 객체가
 * 없으면) origin/base 기준으로 넉넉하게 센다. 적게 세면 랜딩의 reset 이 남은
 * 작업을 지우므로, 어긋날 때는 항상 크게 세는 쪽이다.
 */
async function countAfterPrHead(
  core: RepoCore,
  pr: NonNullable<CycleSnapshot["pr"]>,
): Promise<number> {
  let count: number | null = null;
  if (pr.state === "merged" && pr.headSha !== "") {
    const known = await core.git(["cat-file", "-e", `${pr.headSha}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (known) count = await gitCount(core, ["rev-list", "--count", `${pr.headSha}..HEAD`]);
  }
  if (count === null) {
    // 반려거나 headSha 를 못 믿는 경우 — 남은 것은 브랜치 전체다(L4).
    count = await gitCount(core, ["rev-list", "--count", `origin/${core.baseBranch}..HEAD`]);
  }
  if (count === null) {
    // origin/base 마저 없는 세계(베이스 이름 변경 등) — 그래도 0 은 아니다.
    count = (await gitCount(core, ["rev-list", "--count", "HEAD"])) ?? 1;
  }
  return count;
}

/**
 * 새 개발자 코멘트(L9) — 세 목록(인라인 · 리뷰 본문 · 요청 코멘트)에서 내
 * 로그인과 원장이 아는 id 를 뺀다. 봇 거르기 · 페이지네이션 · whoAmI 캐시는
 * 단계 7 의 일이다.
 */
async function collectNewReviews(
  client: GitHubClient,
  slug: { owner: string; repo: string },
  number: number,
  ledger: CycleLedger,
): Promise<number[]> {
  const known = new Set(ledger.reviews[String(number)]?.known ?? []);
  let mine: string | null = null;
  const who = await client.whoAmI().catch(() => null);
  if (who?.ok) mine = who.login;
  const rows: Array<Record<string, any>> = [
    ...(await client.listPullComments({ owner: slug.owner, repo: slug.repo, number })),
    // 리뷰는 본문이 있는 것만 — verdict 만 있는 리뷰는 개발자의 말이 아니다.
    ...(await client.listReviews({ owner: slug.owner, repo: slug.repo, number })).filter(
      (row) => String(row.body ?? "").trim() !== "",
    ),
    ...(await client.listIssueComments({ owner: slug.owner, repo: slug.repo, number })),
  ];
  const ids = new Set<number>();
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isInteger(id) || known.has(id)) continue;
    const login = String(row.user?.login ?? "");
    if (mine !== null && login === mine) continue;
    ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * 클론과 GitHub 을 읽어 스냅샷 하나를 만든다. `opts.fetch` 가 참이면 먼저
 * `git fetch origin <base>` 와(사이클 브랜치가 있으면) `origin <branch>` 를
 * 한다 — fetch 는 쓰기이므로 호출자가 차선 안에서 부른다고 가정한다.
 */
export async function observeCycle(
  core: RepoCore,
  ledger: CycleLedger,
  deps: ObserveDeps,
  opts: { fetch: boolean; now: number },
): Promise<CycleSnapshot> {
  if (opts.fetch) {
    // 네트워크 실패는 삼킨다 — 지난 origin 으로 관찰이 계속된다.
    await core.git(["fetch", "origin", core.baseBranch]).catch(() => undefined);
    if (core.branch !== null) {
      await core.git(["fetch", "origin", core.branch]).catch(() => undefined);
    }
  }

  const gitOp = await detectGitOp(core);
  const conflictFiles = (
    await gitText(core, ["-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=U"])
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const markersLeft = markersLeftIn(core.root, [
    ...new Set([...conflictFiles, ...(ledger.pendingOp?.files ?? [])]),
  ]);

  // 도구 태그의 stash — %gd(ref)와 %s(제목)를 NUL 로 갈라 읽는다.
  let taggedStash: string | null = null;
  for (const row of (await gitText(core, ["stash", "list", "--format=%gd%x00%s"])).split(/\r?\n/)) {
    if (row.trim() === "") continue;
    const [ref = "", ...subject] = row.split("\x00");
    if (subject.join("\x00").includes(STASH_MESSAGE)) {
      taggedStash = ref.trim();
      break;
    }
  }

  const headBranch =
    (await gitText(core, ["symbolic-ref", "--short", "-q", "HEAD"])).trim() || null;
  const originBaseExists =
    (
      await gitText(core, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${core.baseBranch}`])
    ).trim() !== "";

  // 기존 변경 수 세기와 같은 기준 — 칩의 숫자와 같은 잣대로 센다.
  await core.refreshPendingChanges();
  const dirtyFiles = core.pendingChanges;

  const [aheadOfBase, behindBase] = await core
    .aheadBehindBase()
    .catch((): [number, number] => [0, 0]);

  // 사이클 브랜치의 원격 대비 — 원격 브랜치가 없으면 올라갈 커밋의 잣대는
  // origin/base 다(L3 12행).
  let remoteBranchExists = false;
  let localAheadOfRemote = 0;
  let remoteAheadOfLocal = 0;
  if (core.branch !== null) {
    remoteBranchExists =
      (
        await gitText(core, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${core.branch}`])
      ).trim() !== "";
    if (remoteBranchExists) {
      const pair = await gitCountPair(core, [
        "rev-list",
        "--left-right",
        "--count",
        `${core.branch}...origin/${core.branch}`,
      ]);
      if (pair !== null) [localAheadOfRemote, remoteAheadOfLocal] = pair;
      else localAheadOfRemote = aheadOfBase;
    } else {
      localAheadOfRemote = aheadOfBase;
    }
  }

  // GitHub — 인증 만료면 API 의 말을 믿지 않는다(판정이 pr 없는 세계로 읽는다).
  let githubReachable = true;
  let pr: CycleSnapshot["pr"] = null;
  const client = deps.github();
  const slug = deps.slug();
  const needsClient = core.openHandoff !== null || !originBaseExists;
  if (needsClient && client === null) githubReachable = false;

  if (core.openHandoff !== null && !deps.githubAuthExpired() && client !== null && slug !== null) {
    try {
      const detail = await client.getPullRequest({
        owner: slug.owner,
        repo: slug.repo,
        number: core.openHandoff.number,
      });
      pr = {
        number: detail.number,
        state: detail.state,
        // 없는 sha 는 빈 문자열로 — countAfterPrHead 의 넉넉한 규칙이 이어받는다.
        headSha: detail.headSha ?? "",
        mergeableState: detail.mergeableState,
      };
    } catch {
      pr = null;
      githubReachable = false;
    }
  }

  // 기본 가지는 origin/base 가 없을 때만 묻는다 — 조정 표 7행의 재겨눔 재료.
  let defaultBranch: string | null = null;
  if (!originBaseExists && client !== null && slug !== null) {
    try {
      defaultBranch = (await client.inspectRepo({ owner: slug.owner, repo: slug.repo }))
        .defaultBranch;
    } catch {
      githubReachable = false;
    }
  }

  let commitsAfterPrHead: number | null = null;
  if (pr !== null) {
    commitsAfterPrHead = await countAfterPrHead(core, pr);
    // 커밋 안 된 변경도 남은 것이다(L4) — 수가 아니라 "있음"만 필요하므로 1로 둔다.
    if (dirtyFiles > 0) commitsAfterPrHead = Math.max(commitsAfterPrHead, 1);
  }

  let newReviewIds: number[] = [];
  if (
    pr !== null &&
    (pr.state === "open" || pr.state === "changes_requested") &&
    client !== null &&
    slug !== null
  ) {
    newReviewIds = await collectNewReviews(client, slug, pr.number, ledger);
  }

  return {
    now: opts.now,
    turnRunning: deps.turnRunning(),
    gitOp,
    conflictFiles,
    markersLeft,
    taggedStash,
    headBranch,
    registryBranch: core.branch,
    baseBranch: core.baseBranch,
    originBaseExists,
    defaultBranch,
    dirtyFiles,
    aheadOfBase,
    behindBase,
    remoteBranchExists,
    localAheadOfRemote,
    remoteAheadOfLocal,
    pr,
    commitsAfterPrHead,
    newReviewIds,
    installStale: deps.installStale(),
    hygieneDue: false, // 단계 9 — 위생 기한을 세는 자리가 아직 없다
    githubReachable,
    githubAuthExpired: deps.githubAuthExpired(),
  };
}
