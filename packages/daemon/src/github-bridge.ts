import type { GitHubRepoList } from "@colo-design/protocol";
import { type CredentialStore, loadRepoPat, REPO_PAT_ITEM } from "./credentials.js";
import { createGitHubTransport, GitHubClient } from "./github.js";
import { runOnboardingChecks } from "./onboarding.js";

/**
 * 서버가 주는 것 — 브리지는 토큰의 생애(디스크에서 읽기·저장·폐기·캐시 무효화)와
 * 그 토큰이 무엇을 살 수 있는가(클라이언트·레포 목록)만 안다. 토큰이 바뀌면
 * 살아있는 워크스페이스에 다시 무장시키는 일은 `onToken` 너머의 일이다.
 */
export interface GitHubBridgeDeps {
  credentials: CredentialStore;
  /** github.check 가 읽는 CLI 경로 오버라이드 — 설정값, 해석된 값이 아니다. */
  claudeExecutableOverride(): string | undefined;
  /** 새 토큰이 오면 모든 살아있는 워크스페이스가 다시 무장한다. */
  onToken(pat: string | null): void;
}

/**
 * 머신 하나의 GitHub 자격 (DESIGN §5): 토큰 하나가 모든 프로젝트의 클론·푸시를
 * 이루고, 피커의 레포 목록은 그 토큰으로 캐시된다. 서버에는 브리지로의 위임만
 * 남는다.
 */
export class GitHubBridge {
  /** The machine-wide GitHub token, loaded once per run and on github.token.set. */
  private pat: string | null = null;
  /** The picker's list, cached per token; a token change invalidates it. */
  private repoListCache: { token: string; list: GitHubRepoList } | null = null;
  /**
   * One GitHub transport for the whole daemon: the fixture one when a test
   * points at recorded pairs, `api.github.com` otherwise. The token is not
   * here — it is machine-wide, and rides on each client.
   */
  private readonly transport = createGitHubTransport().transport;

  constructor(private readonly deps: GitHubBridgeDeps) {}

  /** The armed token, or null before `load`/`setToken` ran. */
  get token(): string | null {
    return this.pat;
  }

  /**
   * A GitHub client on the machine-wide token — the same credential that
   * clones and pushes every project's repo, and the one the repo list comes
   * from. Built per call because a token set mid-run must reach the next
   * request without a restart.
   */
  client(): GitHubClient | null {
    if (!this.pat) return null;
    return new GitHubClient(this.pat, this.transport);
  }

  /** 기동 시 디스크에서 읽은 토큰을 무장한다 — 저장도 재무장도 없다(그 일은 start 가 한다). */
  async load(): Promise<void> {
    this.pat = await loadRepoPat(this.deps.credentials);
  }

  /**
   * github.token.set: persist (or delete) the machine-wide token, drop the
   * picker cache, re-arm every live workspace, then answer with the
   * recomputed `github` gate alone — the form turns its card green (or shows
   * the refusal) without touching the rest.
   */
  async setToken(token: string | null) {
    this.pat = token;
    if (this.pat) await this.deps.credentials.save(REPO_PAT_ITEM, this.pat);
    else await this.deps.credentials.delete(REPO_PAT_ITEM).catch(() => undefined);
    this.repoListCache = null;
    // Every live workspace re-arms at once; a project the planner has not
    // touched this run gets the token when it is next activated.
    this.deps.onToken(this.pat);
    const steps = await runOnboardingChecks({
      claudeExecutableOverride: this.deps.claudeExecutableOverride(),
      gitHubClient: () => this.client(),
    });
    return steps.find((step) => step.id === "github") ?? null;
  }

  /** The picker's repo list — cached per token until `refresh` or a setToken. */
  async listRepos(refresh: boolean): Promise<GitHubRepoList> {
    if (!this.pat) {
      throw new Error("GitHub 토큰이 없습니다 — 먼저 토큰을 연결해 주세요.");
    }
    if (refresh || this.repoListCache?.token !== this.pat) {
      const client = this.client();
      if (!client) {
        throw new Error("GitHub 토큰이 없습니다 — 먼저 토큰을 연결해 주세요.");
      }
      const { repos, truncated } = await client.listRepos();
      this.repoListCache = { token: this.pat, list: { repos, truncated } };
    }
    return this.repoListCache.list;
  }

  /** 후보 하나의 상세 — 온보딩 피커의 inspect 카드. */
  async inspectRepo(owner: string, repo: string) {
    const client = this.client();
    if (!client) {
      throw new Error("GitHub 토큰이 없습니다 — 먼저 토큰을 연결해 주세요.");
    }
    return await client.inspectRepo({ owner, repo });
  }
}
