/**
 * 사이클 관찰 시험 하네스 (PLAN 단계 2b) — 서버 없이 RepoCore 를 세우고,
 * 실제 git 임시 저장소와 메모리 속 GitHub 으로 감독자의 눈(cycle-observe)이
 * 보는 세계를 만든다. 단계 2~9 시험의 바닥이다(PLAN 단계 2 의 하네스).
 *
 * 실제 git 을 만지는 방식은 shelf-recover · cycle-branch 시험과 같다:
 * execFile 로 직접. 형제를 `.js` 지정자로 부르는 모듈은 dist 에서 싣는다
 * (`pnpm test` 가 빌드를 먼저 돌린다).
 *
 * 다섯 도구:
 * - makeRemote() — 임시 bare 원격 + main 의 첫 커밋.
 * - makeClone(remote) — 도구의 클론으로 쓰는 작업 사본(user.name/email 설정).
 * - makeCore(clone, remote, opts) — 서버 없이 세운 RepoCore.
 * - developer(remote) — 개발자 쪽 손: 별도 임시 클론으로 base · PR 브랜치에
 *   커밋해 올린다.
 * - MemoryGitHub — RestTransport 를 구현하는 메모리 속 GitHub. 조종판
 *   (merge · close · addComment · expireAuth)이 개발자의 손을 흉내 낸다.
 * makeScene() 은 다섯 도구를 얹어 observe 까지 한 번에 쓰는 몸통이다.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { HandoffShot } from "@colo-design/protocol";
import { type CycleLedger, emptyLedger } from "../../dist/cycle-ledger.js";
import { type ObserveDeps, observeCycle } from "../../dist/cycle-observe.js";
import type { CycleSnapshot } from "../../dist/cycle-reconcile.js";
import { CycleSupervisor } from "../../dist/cycle-supervisor.js";
import { GitHubClient } from "../../dist/github.js";
import { RepoWorkspace } from "../../dist/repo.js";
import { RepoCore } from "../../dist/repo-core.js";

const exec = promisify(execFile);
const execAt = (cwd: string) => (args: string[]) =>
  exec("git", args, { cwd }).then((done) => done.stdout as string);

/** 지우면 임시 폴더 전부가 사라지는 임시 루트 — 하네스의 모든 조각이 이것을 나른다. */
export interface TempRoot {
  dir: string;
  dispose(): void;
}

function tempRoot(prefix: string): TempRoot {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 임시 bare 원격 — 첫 커밋이 main 에 있다. */
export interface RemoteRepo extends TempRoot {
  /** bare 저장소의 경로 — origin url 로 쓴다. */
  path: string;
}

export async function makeRemote(): Promise<RemoteRepo> {
  const root = tempRoot("colo-cycle-remote-");
  const path = join(root.dir, "remote.git");
  const git = execAt(root.dir);
  await git(["init", "--bare", "-b", "main", path]);
  // bare 는 커밋을 못 만든다 — 씨앗 클론에서 첫 커밋을 올리고 치운다.
  const seed = join(root.dir, "seed");
  await exec("git", ["clone", path, seed], { cwd: root.dir });
  const seedGit = execAt(seed);
  await seedGit(["config", "user.email", "test@colo-design"]);
  await seedGit(["config", "user.name", "테스트"]);
  writeFileSync(join(seed, "README.md"), "# 하네스\n");
  await seedGit(["add", "-A"]);
  await seedGit(["commit", "-m", "첫 커밋"]);
  await seedGit(["push", "-u", "origin", "main"]);
  rmSync(seed, { recursive: true, force: true });
  return { ...root, path };
}

/** 도구의 클론으로 쓰는 작업 사본. */
export interface ToolClone extends TempRoot {
  path: string;
}

export async function makeClone(remote: RemoteRepo): Promise<ToolClone> {
  const root = tempRoot("colo-cycle-clone-");
  const path = join(root.dir, "repo");
  await exec("git", ["clone", remote.path, path], { cwd: root.dir });
  const git = execAt(path);
  await git(["config", "user.email", "test@colo-design"]);
  await git(["config", "user.name", "테스트"]);
  return { ...root, path };
}

/** HandoffStatus 의 시험용 모양 — protocol 타입을 직접 들이지 않아도 구조가 같다. */
export interface HandoffLike {
  number: number;
  url: string;
  title: string;
  state: "open" | "changes_requested" | "merged" | "closed";
  branch: string;
}

export interface HarnessCoreOptions {
  baseBranch?: string;
  /** 레지스트리가 기억하는 사이클 브랜치. */
  branch?: string | null;
  /** 레지스트리가 기억하는 넘긴 요청. */
  handoff?: HandoffLike | null;
  /** 메모리 GitHub — 없으면 GitHub 클라이언트 없는 코어. */
  github?: MemoryGitHub | null;
}

/**
 * 서버 없이 세운 RepoCore — url 은 로컬 bare 원격, onStatus 는 무동작.
 * repoSlug() 는 url 이나 COLO_DESIGN_GITHUB_SLUG 에서 읽는다(repo-core.ts) —
 * 원격이 로컬 경로이므로 시험 슬롯인 환경변수로 고정한다. 시험 파일마다
 * 프로세스가 따로 도니 한 파일 안의 장면끼리만 겹친다.
 */
export function makeCore(
  clone: ToolClone,
  remote: RemoteRepo,
  opts: HarnessCoreOptions = {},
): RepoCore {
  process.env.COLO_DESIGN_GITHUB_SLUG ??= "colo-design/harness";
  return new RepoCore({
    root: clone.path,
    url: remote.path,
    onStatus: () => {},
    baseBranch: opts.baseBranch ?? "main",
    cycle: { branch: opts.branch ?? null, handoff: opts.handoff ?? null },
    gitHubClient: opts.github ? () => new GitHubClient("harness-token", opts.github) : undefined,
  });
}

// ---------------------------------------------------------------------------
// MemoryGitHub — RestTransport 를 구현하는 메모리 속 GitHub
// ---------------------------------------------------------------------------

interface MemPull {
  number: number;
  title: string;
  body: string;
  base: string;
  head: string;
  /** 병합 순간의 head(L4) — openPull 때 기록하고 merge 가 갱신한다. */
  headSha: string;
  state: "open" | "closed";
  merged: boolean;
  mergeableState: string | null;
  /** 닫힘(병합 · 반려) 시각 — 반려 이유의 7일 창 재료 (PLAN L9). */
  closedAt: string | null;
}

interface MemIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
}
interface MemComment {
  id: number;
  login: string;
  body: string;
  /** GitHub 의 계정 종류 — "Bot" 행은 봇 거르기(isBotRow)의 재료다. */
  type: string;
  /** 만든 시각(ISO) — 반려 이유의 7일 창이 읽는다 (PLAN L9). */
  at: string;
}

/**
 * 메모리 속 GitHub — GitHubClient 가 진짜로 돌게 하는 RestTransport(녹화
 * fixture 대신 살아 있는 상태). 조종판은 개발자의 손을 흉내 낸다: merge 는
 * bare 원격에 실제로 병합해 올린다(임시 클론에서 base 에 `merge --no-ff`
 * 또는 스쿼시 커밋 후 push).
 */
export class MemoryGitHub implements RestTransport {
  private expired = false;
  private pullCreatesFail = false;
  /** 저장소가 옮겨진 뒤의 이름 — 없으면 물은 이름 그대로 답한다. */
  private movedTo: string | null = null;
  private nextNumber = 1;
  private nextCommentId = 1;
  /** /user 호출 수 — whoAmI 캐시(PLAN L9) 시험의 잣자리. */
  private userCallCount = 0;
  private readonly pulls = new Map<number, MemPull>();
  private readonly pullComments = new Map<number, MemComment[]>();
  private readonly reviews = new Map<number, Array<MemComment & { state: string }>>();
  private readonly issueComments = new Map<number, MemComment[]>();
  /** 개발자 알림의 이슈 (PLAN L11) — 번호는 PR 과 같은 열을 쓴다(GitHub 과 같다). */
  private readonly issues = new Map<number, MemIssue>();

  private readonly remote: RemoteRepo;

  constructor(remote: RemoteRepo) {
    this.remote = remote;
  }

  async request(input: {
    method: "GET" | "POST" | "PUT" | "PATCH";
    url: string;
    headers: Record<string, string>;
    body?: Uint8Array;
  }): Promise<{ status: number; body: Uint8Array; headers: Record<string, string> }> {
    if (this.expired) return this.json(401, { message: "Bad credentials" });
    const path = input.url.split("?")[0] ?? input.url;
    const seg = path.split("/").filter(Boolean);
    const json = (status: number, payload: unknown) => this.json(status, payload);

    if (input.method === "GET" && path === "/user") {
      this.userCallCount += 1;
      return json(200, { login: "colo-planner" });
    }
    if (seg[0] === "repos" && seg.length >= 3) {
      const rest = seg.slice(3);
      if (input.method === "GET" && rest.length === 0) {
        return json(200, {
          full_name: this.movedTo ?? `${seg[1]}/${seg[2]}`,
          default_branch: "main",
          permissions: { push: true },
        });
      }
      if (input.method === "GET" && rest[0] === "contents") {
        return json(404, { message: "Not Found" });
      }
      if (rest[0] === "pulls") {
        // GET /pulls?head=owner:branch&state=open — 제출의 입양 찾기(PLAN L6).
        // 쿼리를 여기서 푼다: request() 는 path 만 보고 들어온다.
        if (input.method === "GET" && rest.length === 1) {
          const query = new URL(input.url, "https://github.test").searchParams;
          const head = query.get("head") ?? "";
          const state = query.get("state") ?? "open";
          const branch = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
          const rows = [...this.pulls.values()].filter((pull) => {
            if (branch !== "" && pull.head !== branch) return false;
            if (state === "open") return pull.state === "open";
            return true;
          });
          return json(
            200,
            rows.map((pull) => this.pullJson(pull)),
          );
        }
        if (input.method === "POST" && rest.length === 1) {
          if (this.pullCreatesFail) return json(500, { message: "Internal Error" });
          const payload = JSON.parse(new TextDecoder().decode(input.body ?? new Uint8Array()));
          const number = await this.openPull({
            head: String(payload.head),
            base: String(payload.base ?? "main"),
            title: String(payload.title ?? ""),
          });
          const pull = this.pulls.get(number);
          if (pull === undefined) return json(500, { message: "pull not stored" });
          pull.body = String(payload.body ?? "");
          return json(201, this.pullJson(pull));
        }
        const number = Number(rest[1]);
        const pull = this.pulls.get(number);
        if (rest.length === 2) {
          if (pull === undefined) return json(404, { message: "Not Found" });
          if (input.method === "GET") return json(200, this.pullJson(pull));
          if (input.method === "PATCH") {
            const payload = JSON.parse(new TextDecoder().decode(input.body ?? new Uint8Array()));
            if (typeof payload.title === "string") pull.title = payload.title;
            if (typeof payload.body === "string") pull.body = payload.body;
            return json(200, this.pullJson(pull));
          }
        }
        if (rest.length === 3 && rest[2] === "requested_reviewers" && input.method === "POST") {
          return json(201, {});
        }
        if (rest.length === 3 && rest[2] === "comments" && input.method === "GET") {
          return this.paged(input.url, path, this.commentJson(this.pullComments.get(number) ?? []));
        }
        if (rest.length === 3 && rest[2] === "reviews" && input.method === "GET") {
          return this.paged(
            input.url,
            path,
            (this.reviews.get(number) ?? []).map((row) => ({
              id: row.id,
              user: { login: row.login, type: row.type },
              body: row.body,
              state: row.state,
              submitted_at: row.at,
            })),
          );
        }
        // POST …/comments/{id}/replies — 자동 답장(PLAN L9)이 스레드 답글을
        // 올리는 말단. 답장은 인라인 목록 끝에 붙는다(GitHub 과 같은 모양).
        if (
          rest.length === 5 &&
          rest[2] === "comments" &&
          rest[4] === "replies" &&
          input.method === "POST"
        ) {
          const payload = JSON.parse(new TextDecoder().decode(input.body ?? new Uint8Array()));
          const id = this.nextCommentId++;
          const row: MemComment = {
            id,
            login: "colo-planner",
            body: String(payload.body ?? ""),
            type: "User",
            at: new Date().toISOString(),
          };
          this.pullComments.set(number, [...(this.pullComments.get(number) ?? []), row]);
          return json(201, this.commentJson([row])[0]);
        }
      }
      if (rest[0] === "issues") {
        // 목록 — 개발자 알림이 같은 문제의 이슈를 다시 찾는 길. PR 도 같은
        // 열에 서므로 pull_request 표식을 달아 내어 준다(GitHub 과 같다).
        if (input.method === "GET" && rest.length === 1) {
          const rows = [...this.issues.values()]
            .filter((issue) => issue.state === "open")
            .map((issue) => this.issueJson(issue));
          const pulls = [...this.pulls.values()]
            .filter((pull) => pull.state === "open")
            .map((pull) => ({ ...this.pullJson(pull), pull_request: {} }));
          return json(200, [...rows, ...pulls]);
        }
        if (input.method === "POST" && rest.length === 1) {
          const payload = JSON.parse(new TextDecoder().decode(input.body ?? new Uint8Array()));
          const number = this.nextNumber++;
          const issue: MemIssue = {
            number,
            title: String(payload.title ?? ""),
            body: String(payload.body ?? ""),
            state: "open",
            labels: [],
            assignees: [],
          };
          this.issues.set(number, issue);
          return json(201, this.issueJson(issue));
        }
        const number = Number(rest[1]);
        const issue = this.issues.get(number);
        if (rest.length === 2 && input.method === "PATCH") {
          if (issue === undefined) return json(404, { message: "Not Found" });
          const payload = JSON.parse(new TextDecoder().decode(input.body ?? new Uint8Array()));
          if (typeof payload.state === "string") issue.state = payload.state;
          if (Array.isArray(payload.labels)) issue.labels = payload.labels.map(String);
          if (Array.isArray(payload.assignees)) issue.assignees = payload.assignees.map(String);
          return json(200, this.issueJson(issue));
        }

        if (rest.length === 3 && rest[2] === "comments") {
          if (input.method === "GET") {
            return this.paged(
              input.url,
              path,
              this.commentJson(this.issueComments.get(number) ?? []),
            );
          }
          if (input.method === "POST") {
            const payload = JSON.parse(new TextDecoder().decode(input.body ?? new Uint8Array()));
            const id = this.nextCommentId++;
            const row: MemComment = {
              id,
              login: "colo-planner",
              body: String(payload.body ?? ""),
              type: "User",
              at: new Date().toISOString(),
            };
            this.issueComments.set(number, [...(this.issueComments.get(number) ?? []), row]);
            return json(201, this.commentJson([row])[0]);
          }
        }
        // PATCH /issues/comments/{id} — rest 는 ["issues","comments","<id>"].
        if (rest.length === 3 && rest[1] === "comments" && input.method === "PATCH") {
          const commentId = Number(rest[2]);
          const payload = JSON.parse(new TextDecoder().decode(input.body ?? new Uint8Array()));
          for (const rows of this.issueComments.values()) {
            const row = rows.find((entry) => entry.id === commentId);
            if (row) {
              row.body = String(payload.body ?? row.body);
              return json(200, { id: row.id, user: { login: row.login }, body: row.body });
            }
          }
          return json(404, { message: "Not Found" });
        }
        if (rest.length === 3 && rest[1] === "comments" && input.method === "GET") {
          const commentId = Number(rest[2]);
          for (const rows of this.issueComments.values()) {
            const row = rows.find((entry) => entry.id === commentId);
            if (row) return json(200, { id: row.id, user: { login: row.login }, body: row.body });
          }
          return json(404, { message: "Not Found" });
        }
      }
    }
    return json(404, { message: `Not Found: ${input.method} ${path}` });
  }

  private json(status: number, payload: unknown) {
    return {
      status,
      body: new TextEncoder().encode(JSON.stringify(payload)),
      headers: {} as Record<string, string>,
    };
  }

  /**
   * 목록의 한 페이지 (PLAN L9) — per_page · page 를 읽고 남은 페이지가 있으면
   * `Link` 의 next 로 알린다. 클라이언트의 페이지네이션(listPages)이 이
   * 헤더를 따라간다.
   */
  private paged(url: string, path: string, rows: unknown[]) {
    const query = new URL(url, "https://github.test").searchParams;
    const perPage = Math.max(1, Number(query.get("per_page")) || 30);
    const page = Math.max(1, Number(query.get("page")) || 1);
    const slice = rows.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < rows.length) {
      headers.link = `<${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
    }
    return {
      status: 200,
      body: new TextEncoder().encode(JSON.stringify(slice)),
      headers,
    };
  }

  private pullJson(pull: MemPull) {
    return {
      number: pull.number,
      html_url: `https://github.test/colo-design/harness/pull/${pull.number}`,
      title: pull.title,
      // GitHub 은 빈 본문을 null 로 돌려준다 — 클라이언트의 null 판정을
      // 시험이 같은 눈으로 보게 한다.
      body: pull.body === "" ? null : pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.merged ? "2026-09-24T00:00:00Z" : null,
      mergeable_state: pull.mergeableState,
      requested_reviewers: [],
      head: { ref: pull.head, sha: pull.headSha },
      base: { ref: pull.base },
      closed_at: pull.closedAt,
    };
  }

  private commentJson(rows: MemComment[]) {
    return rows.map((row) => ({
      id: row.id,
      user: { login: row.login, type: row.type },
      body: row.body,
      created_at: row.at,
    }));
  }

  /** /user 를 몇 번 불렀나 — whoAmI 캐시(PLAN L9)의 잣대. */
  get userCalls(): number {
    return this.userCallCount;
  }

  /** PR 생성 실패를 푼다 — 예산 시험의 복구 축. */
  healPullCreates(): void {
    this.pullCreatesFail = false;
  }
  private issueJson(issue: MemIssue) {
    return {
      number: issue.number,
      html_url: `https://github.test/colo-design/harness/issues/${issue.number}`,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      user: { login: "colo-planner" },
    };
  }
  /** 이후의 PR 생성(POST /pulls)은 전부 500 — 단계 예산 시험이 쓴다. */
  failPullCreates(): void {
    this.pullCreatesFail = true;
  }

  /** PR 을 읽는다 — 제목 · 본문 · 상태의 시험 잣대. */
  pull(number: number): { title: string; body: string; state: string; head: string } | undefined {
    const found = this.pulls.get(number);
    if (found === undefined) return undefined;
    return { title: found.title, body: found.body, state: found.state, head: found.head };
  }

  /** 열린 PR 의 본문을 개발자가 고친다 — 도구 구간 백업 시험의 손. */
  editPull(number: number, changes: { title?: string; body?: string }): void {
    const found = this.pulls.get(number);
    if (found === undefined) throw new Error(`MemoryGitHub: PR #${number} 이 없습니다`);
    if (changes.title !== undefined) found.title = changes.title;
    if (changes.body !== undefined) found.body = changes.body;
  }

  // ————— 조종판 — 개발자의 손 —————

  /** PR 을 연다 — head.sha 는 지금 원격의 브랜치 끝이다. */
  async openPull(input: { head: string; base?: string; title?: string }): Promise<number> {
    const headSha = (
      await execAt(this.remote.path)(["rev-parse", `refs/heads/${input.head}`])
    ).trim();
    const number = this.nextNumber++;
    this.pulls.set(number, {
      number,
      title: input.title ?? "하네스 요청",
      body: "",
      base: input.base ?? "main",
      head: input.head,
      headSha,
      state: "open",
      merged: false,
      mergeableState: null,
      closedAt: null,
    });
    return number;
  }

  /**
   * bare 원격에 실제로 병합해 올린다 — 임시 클론에서 base 에 `merge --no-ff`
   * 또는 스쿼시 커밋 후 push. head.sha 는 병합 순간의 PR 브랜치 끝으로 갱신된다.
   */
  async merge(number: number, method: "merge" | "squash" = "merge"): Promise<void> {
    const pull = this.pulls.get(number);
    if (pull === undefined) throw new Error(`MemoryGitHub: PR #${number} 이 없습니다`);
    const tmp = tempRoot("colo-cycle-merge-");
    try {
      const work = join(tmp.dir, "m");
      await exec("git", ["clone", this.remote.path, work], { cwd: tmp.dir });
      const git = execAt(work);
      await git(["config", "user.email", "developer@colo-design"]);
      await git(["config", "user.name", "개발자"]);
      await git(["fetch", "origin", pull.head]);
      // 병합 순간의 PR 브랜치 끝 — 스쿼시 · 리베이스 병합에서도 랜딩의 잣대다(L4).
      pull.headSha = (await git(["rev-parse", "FETCH_HEAD"])).trim();
      await git(["checkout", "-B", pull.base, `origin/${pull.base}`]);
      if (method === "merge") {
        await git(["merge", "--no-ff", "FETCH_HEAD", "-m", `Merge pull request #${number}`]);
      } else {
        await git(["merge", "--squash", "FETCH_HEAD"]);
        await git(["commit", "-m", `Pull request #${number} (스쿼시)`]);
      }
      await git(["push", "origin", pull.base]);
    } finally {
      tmp.dispose();
    }
    pull.state = "closed";
    pull.merged = true;
    pull.closedAt = new Date().toISOString();
  }

  /** 병합 없이 닫는다 — 반려. */
  close(number: number): void {
    const pull = this.pulls.get(number);
    if (pull === undefined) throw new Error(`MemoryGitHub: PR #${number} 이 없습니다`);
    pull.state = "closed";
    pull.closedAt = new Date().toISOString();
  }

  setMergeableState(number: number, state: string | null): void {
    const pull = this.pulls.get(number);
    if (pull === undefined) throw new Error(`MemoryGitHub: PR #${number} 이 없습니다`);
    pull.mergeableState = state;
  }

  /** 코멘트를 단다 — kind: 인라인(pull) · 리뷰 본문(review) · 요청 코멘트(issue).
   *  review 의 state 는 GitHub 의 판정 단어다 — CHANGES_REQUESTED 가
   *  getPullRequest 의 changes_requested 를 만든다. bot 을 켜면 CI 봇의
   *  말이 되어 봇 거르기(PLAN L9)의 시험 재료가 된다. */
  addComment(
    number: number,
    opts: {
      kind?: "pull" | "review" | "issue";
      login?: string;
      body?: string;
      state?: string;
      bot?: boolean;
    } = {},
  ): number {
    const id = this.nextCommentId++;
    const login = opts.login ?? "dev1";
    const row: MemComment = {
      id,
      login,
      body: opts.body ?? "이 부분 고쳐 주세요",
      type: opts.bot === true || login.endsWith("[bot]") ? "Bot" : "User",
      at: new Date().toISOString(),
    };
    const kind = opts.kind ?? "issue";
    if (kind === "pull") {
      this.pullComments.set(number, [...(this.pullComments.get(number) ?? []), row]);
    } else if (kind === "review") {
      this.reviews.set(number, [
        ...(this.reviews.get(number) ?? []),
        { ...row, state: opts.state ?? "COMMENTED" },
      ]);
    } else {
      this.issueComments.set(number, [...(this.issueComments.get(number) ?? []), row]);
    }
    return id;
  }

  /** 인라인 코멘트(스레드 답장 포함) — 자동 답장 시험의 잣대. */
  pullCommentsFor(number: number): MemComment[] {
    return this.pullComments.get(number) ?? [];
  }

  /** 이후의 요청은 전부 401 — 연결 코드가 만료된 세계. */
  expireAuth(): void {
    this.expired = true;
  }

  /** 저장소를 옮긴다 — 옛 이름으로 물어도 새 full_name 을 답한다(GitHub 의 되돌림). */
  moveRepo(fullName: string): void {
    this.movedTo = fullName;
  }

  /** 개발자 알림이 연 이슈 — 시험이 상태 · 본문 · 코멘트를 읽는다. */
  issue(number: number): (MemIssue & { comments: MemComment[] }) | undefined {
    const found = this.issues.get(number);
    if (found === undefined) return undefined;
    return { ...found, comments: this.issueComments.get(number) ?? [] };
  }

  /** 열린 이슈 수 — "다시 raise 는 새 이슈를 만들지 않는다" 의 잣대. */
  get openIssueCount(): number {
    return [...this.issues.values()].filter((issue) => issue.state === "open").length;
  }

  /** 이슈 · PR 에 달린 코멘트 — 개발자 알림의 갱신 · 해결 표식을 읽는다. */
  commentsFor(number: number): MemComment[] {
    return this.issueComments.get(number) ?? [];
  }
}

// ---------------------------------------------------------------------------
// developer — 개발자 쪽 손: 별도 임시 클론으로 base · PR 브랜치에 올린다
// ---------------------------------------------------------------------------

export interface DeveloperHands {
  /** base 에 커밋해 올린다 — 개발자가 반영한 내용의 세계. */
  pushToBase(files: Record<string, string>, message: string): Promise<void>;
  /** PR 브랜치에 커밋해 올린다 — 개발자가 요청 브랜치에 올린 커밋(조정 표 10행). */
  pushToBranch(branch: string, files: Record<string, string>, message: string): Promise<void>;
  /** PR 브랜치를 base 위에서 새로 써 올린다 — headSha 가 로컬에 없는 세계를 만든다. */
  rewriteBranch(branch: string, files: Record<string, string>, message: string): Promise<void>;
  dispose(): void;
}

export function developer(remote: RemoteRepo): DeveloperHands {
  const root = tempRoot("colo-cycle-dev-");
  const path = join(root.dir, "dev");
  let ready: Promise<void> | null = null;
  const prepare = async () => {
    if (ready === null) {
      ready = (async () => {
        await exec("git", ["clone", remote.path, path], { cwd: root.dir });
        const git = execAt(path);
        await git(["config", "user.email", "developer@colo-design"]);
        await git(["config", "user.name", "개발자"]);
      })();
    }
    await ready;
  };
  const commitOn = async (
    branch: string,
    base: string,
    files: Record<string, string>,
    message: string,
    force: boolean,
  ) => {
    await prepare();
    const git = execAt(path);
    await git(["fetch", "origin"]);
    await git(["checkout", "-B", branch, base]);
    for (const [name, body] of Object.entries(files)) {
      const target = join(path, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    await git(["add", "-A"]);
    await git(["commit", "-m", message]);
    await git(["push", ...(force ? ["--force"] : []), "origin", branch]);
  };
  return {
    pushToBase: (files, message) => commitOn("main", "origin/main", files, message, false),
    pushToBranch: async (branch, files, message) => {
      await prepare();
      const git = execAt(path);
      await git(["fetch", "origin"]);
      const exists =
        (await git(["rev-parse", "-q", "--verify", `origin/${branch}`]).catch(() => "")).trim() !==
        "";
      await commitOn(branch, exists ? `origin/${branch}` : "origin/main", files, message, false);
    },
    rewriteBranch: (branch, files, message) =>
      commitOn(branch, "origin/main", files, message, true),
    dispose: root.dispose,
  };
}

// ---------------------------------------------------------------------------
// makeScene — 다섯 도구를 얹어 observe 까지 한 번에 쓰는 몸통
// ---------------------------------------------------------------------------

export interface Scene {
  remote: RemoteRepo;
  clone: ToolClone;
  core: RepoCore;
  github: MemoryGitHub;
  dev: DeveloperHands;
  /** 클론에서 직접 git — 도구의 손을 흉내 내는 길. */
  git: (args: string[]) => Promise<string>;
  /**
   * 감독자의 부름 그대로 — 차선(supervise) 안에서 관찰한다. fetch 는 쓰기라
   * observeCycle 의 계약이 차선 안을 요구한다(PLAN L1 · L2).
   */
  observe(opts?: {
    fetch?: boolean;
    now?: number;
    ledger?: CycleLedger;
    deps?: Partial<ObserveDeps>;
  }): Promise<CycleSnapshot>;
  dispose(): void;
}

export async function makeScene(opts: HarnessCoreOptions = {}): Promise<Scene> {
  const remote = await makeRemote();
  const clone = await makeClone(remote);
  const github = new MemoryGitHub(remote);
  const core = makeCore(clone, remote, { ...opts, github });
  const dev = developer(remote);
  const git = (args: string[]) =>
    exec("git", args, { cwd: clone.path }).then((done) => done.stdout as string);
  return {
    remote,
    clone,
    core,
    github,
    dev,
    git,
    observe: (o = {}) => {
      const deps: ObserveDeps = {
        turnRunning: () => false,
        installStale: () => false,
        github: () => new GitHubClient("harness-token", github),
        githubAuthExpired: () => false,
        slug: () => core.repoSlug(),
        ...o.deps,
      };
      return core.lane.run("supervise", () =>
        observeCycle(core, o.ledger ?? emptyLedger(), deps, {
          fetch: o.fetch ?? false,
          now: o.now ?? Date.now(),
        }),
      );
    },
    dispose: () => {
      dev.dispose();
      clone.dispose();
      remote.dispose();
    },
  };
}

// makeSupervisedScene — RepoWorkspace + CycleSupervisor 를 같은 뿌리에 세운다
// ---------------------------------------------------------------------------

export interface SupervisedScene extends Scene {
  /** 감독자가 겨누는 워크스페이스 — save · ensureCycleBranch 가 여기로 간다. */
  workspace: RepoWorkspace;
  supervisor: CycleSupervisor;
  /** openThread 가 모은 브리프 — 가짜 대화의 받은 편지함. */
  briefs: string[];
  /** raiseNotice 가 모은 알림 — [key, text] 쌍. */
  notices: Array<{ key: string; text: string }>;
  /** onPrTransition 이 모은 개발자 쪽 사건 — 옛 폴러의 알림 몫. */
  transitions: Array<{ kind: string; at: string; count?: number }>;
  /** onNewReviews 가 모은 브리프 요청 — [pr, ids]. */
  reviewBriefs: Array<{ pr: number; ids: number[] }>;
  /** cycleEvent 가 모은 대화록 사건. */
  chatEvents: Array<{ kind: string; [key: string]: unknown }>;
  /** onRetargetBase 가 옮긴 베이스 — 없으면 null. */
  retargetedTo: string | null;
  /** 감독자의 벽시계를 움직인다 — 백오프 · 1시간 알림의 시험축. */
  setNow: (ms: number) => void;
  /** 같은 뿌리에 감독자를 새로 세운다 — 재시작 흉내(S7 · S11). 수집기는
   *  장면의 것을 그대로 쓴다. */
  respawn(): CycleSupervisor;
  /** 수명 설정 — 병합된 원격 브랜치를 지울지(기본 true). */
  deleteMergedBranches: boolean;
  /** 활성 프로젝트인가 — timer 틱의 fetch 판정이 읽는다(기본 true). */
  /** 수명 설정 — 개발자 코멘트 자동 답장을 할지 (PLAN L9, 기본 true). */
  autoReply: boolean;
  /** 자동 답장의 대리 표기에 적을 작성자 이름 (기본 null → "사용자"). */
  authorName: string | null;
  active: boolean;
  /** L6 제출 — PR 제목의 프로젝트 이름 (기본 "하네스 프로젝트"). */
  projectName: string;
  /** L6 제출 — 감독자가 PR 본문에 얹을 캡처 (기본 없음). */
  shots: HandoffShot[];
  /** 원장 파일의 자리 — 재시작 흉내(S7)가 같은 경로로 다시 세운다. */
  ledgerPath: string;
  /** 켜면 openThread 가 null 을 돌린다 — 대화를 열 수 없는 세계(반려 반영 재시도의 시험축). */
  refuseThread: boolean;
  /** 수명 설정 — 반려 브랜치를 남기는 날(기본 14). 위생 시험이 바꾼다. */
  keepRejectedDays: number;
  /** onUrlChange 가 모은 주소 — 레지스트리에 적혔을 것들. */
  urlChanges: Array<string | null>;
  /** 가짜 statfs 가 답하는 디스크 여유(바이트, 기본 100GB) — 디스크 시험이 바꾼다. */
  freeBytes: number;
  /** raiseMachineNotice · resolveMachineNotice 가 모은 기계 전체 알림. */
  machineNotices: Array<{ op: "raise" | "resolve"; key: string; detail?: string }>;
  /** 설치 판정(15행) — 없으면 늘 최신. fleet 처럼 워크스페이스의 판정을 겨눌 수 있다. */
  installJudge: (() => boolean) | null;
}

/**
 * 서버 없이 세운 감독자 장면 — RepoWorkspace 가 만드는 core 를 repoCore() 로
 * 꺼내 감독자와 시험이 같은 뿌리를 공유한다. openThread · raiseNotice 는
 * 모으는 가짜다.
 */
export async function makeSupervisedScene(opts: HarnessCoreOptions = {}): Promise<SupervisedScene> {
  const remote = await makeRemote();
  const clone = await makeClone(remote);
  const github = new MemoryGitHub(remote);
  process.env.COLO_DESIGN_GITHUB_SLUG ??= "colo-design/harness";
  const urlChanges: Array<string | null> = [];
  const workspace = new RepoWorkspace({
    root: clone.path,
    url: remote.path,
    onStatus: () => {},
    onUrlChange: (url) => urlChanges.push(url),
    baseBranch: opts.baseBranch ?? "main",
    cycle: { branch: opts.branch ?? null, handoff: opts.handoff ?? null },
    gitHubClient: () => new GitHubClient("harness-token", github),
    commandsApproved: true,
  });
  const core = workspace.repoCore();
  const dev = developer(remote);
  const git = (args: string[]) =>
    exec("git", args, { cwd: clone.path }).then((done) => done.stdout as string);
  const scene = {
    retargetedTo: null as string | null,
    refuseReviewSend: false,
    refuseThread: false,
    deleteMergedBranches: true,
    active: true,
    projectName: "하네스 프로젝트",
    shots: [] as HandoffShot[],
    // PLAN L9 자동 답장의 재료 — 초대 v4 의 lifecycle.autoReply · machine 의 이름.
    autoReply: true,
    authorName: null as string | null,
    keepRejectedDays: 14,
    freeBytes: 100 * 1024 ** 3,
    installJudge: null as (() => boolean) | null,
  };
  const machineNotices: SupervisedScene["machineNotices"] = [];
  const briefs: string[] = [];
  const notices: Array<{ key: string; text: string }> = [];
  const transitions: Array<{ kind: string; at: string; count?: number }> = [];
  const reviewBriefs: Array<{ pr: number; ids: number[] }> = [];
  const chatEvents: Array<{ kind: string; [key: string]: unknown }> = [];
  const ledgerPath = join(clone.path, "..", "cycle.json");
  let nowMs = Date.now();
  const spawn = () =>
    new CycleSupervisor({
      core,
      workspace,
      ledgerPath,
      autoReply: () => scene.autoReply,
      authorName: () => scene.authorName,
      busy: () => false,
      installStale: () => scene.installJudge?.() ?? false,
      deleteMergedBranches: () => scene.deleteMergedBranches,
      keepRejectedDays: () => scene.keepRejectedDays,
      // 디스크 (O8) — 시험 기계의 실제 여유를 읽지 않는다.
      statfs: async () => ({ bavail: Math.floor(scene.freeBytes / 4096), bsize: 4096 }),
      raiseMachineNotice: (key, detail) => machineNotices.push({ op: "raise", key, detail }),
      resolveMachineNotice: (key) => machineNotices.push({ op: "resolve", key }),
      // L6 제출 — 장면이 갈아끼우는 재료들.
      projectName: () => scene.projectName,
      commentsFile: () => join(dirname(ledgerPath), "comments.json"),
      captureShots: () => Promise.resolve(scene.shots.slice()),
      github: () => new GitHubClient("harness-token", github),
      githubAuthExpired: () => false,
      slug: () => core.repoSlug(),
      isActive: () => scene.active,
      openThread: async () => (scene.refuseThread ? null : { send: (text) => briefs.push(text) }),
      raiseNotice: (key, text) => notices.push({ key, text }),
      onPrTransition: (kind, at, count) => transitions.push({ kind, at, count }),
      onNewReviews: async (pr, reviews) => {
        if (scene.refuseReviewSend) return false;
        reviewBriefs.push({ pr, ids: reviews.map((r) => r.id) });
        return true;
      },
      onRetargetBase: (to) => {
        scene.retargetedTo = to;
      },
      cycleEvent: (event) => chatEvents.push(event as { kind: string }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => nowMs,
    });
  const supervisor = spawn();
  return {
    remote,
    clone,
    core,
    github,
    dev,
    git,
    workspace,
    supervisor,
    briefs,
    notices,
    transitions,
    reviewBriefs,
    chatEvents,
    get retargetedTo() {
      return scene.retargetedTo;
    },
    get refuseReviewSend() {
      return scene.refuseReviewSend;
    },
    set refuseReviewSend(v: boolean) {
      scene.refuseReviewSend = v;
    },
    get refuseThread() {
      return scene.refuseThread;
    },
    set refuseThread(v: boolean) {
      scene.refuseThread = v;
    },
    get deleteMergedBranches() {
      return scene.deleteMergedBranches;
    },
    set deleteMergedBranches(v: boolean) {
      scene.deleteMergedBranches = v;
    },
    get autoReply() {
      return scene.autoReply;
    },
    set autoReply(v: boolean) {
      scene.autoReply = v;
    },
    get authorName() {
      return scene.authorName;
    },
    set authorName(v: string | null) {
      scene.authorName = v;
    },
    get active() {
      return scene.active;
    },
    set active(v: boolean) {
      scene.active = v;
    },
    get projectName() {
      return scene.projectName;
    },
    set projectName(v: string) {
      scene.projectName = v;
    },
    get shots() {
      return scene.shots;
    },
    set shots(v: HandoffShot[]) {
      scene.shots = v;
    },
    get keepRejectedDays() {
      return scene.keepRejectedDays;
    },
    set keepRejectedDays(v: number) {
      scene.keepRejectedDays = v;
    },
    get freeBytes() {
      return scene.freeBytes;
    },
    set freeBytes(v: number) {
      scene.freeBytes = v;
    },
    get installJudge() {
      return scene.installJudge;
    },
    set installJudge(v: (() => boolean) | null) {
      scene.installJudge = v;
    },
    machineNotices,
    setNow: (ms) => {
      nowMs = ms;
    },
    respawn: spawn,
    ledgerPath,
    urlChanges,
    observe: (o = {}) => {
      const deps: ObserveDeps = {
        turnRunning: () => false,
        installStale: () => false,
        github: () => new GitHubClient("harness-token", github),
        githubAuthExpired: () => false,
        slug: () => core.repoSlug(),
        ...o.deps,
      };
      return core.lane.run("supervise", () =>
        observeCycle(core, o.ledger ?? emptyLedger(), deps, {
          fetch: o.fetch ?? false,
          now: o.now ?? Date.now(),
        }),
      );
    },
    dispose: async () => {
      // 차선에 선 백그라운드 푸시가 클론을 만지는 동안 지우면 rm 이 진다 —
      // 줄이 빌 때까지 기다린 뒤 지운다.
      await core.lane.idle();
      dev.dispose();
      clone.dispose();
      remote.dispose();
    },
  };
}
