import type { GitHubRepoList } from "@colo-design/protocol";
import { type CredentialStore, loadRepoPat, REPO_PAT_ITEM } from "./credentials.js";
import { createGitHubTransport, GitHubClient } from "./github.js";
import { runOnboardingChecks } from "./onboarding.js";
import type { RestTransport } from "./rest-transport.js";

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
  /**
   * 데몬 자신의 GitHub 읽기가 본 인증 판정이 바뀔 때 — true 는 401(만료·폐기),
   * false 는 그 뒤의 첫 성공 응답. 서버는 여기서 status 를 다시 방송해 웹의
   * 만료 카드를 연다. 판정의 근거는 `authState` 주석.
   */
  onAuthChange?(expired: boolean): void;
}

/**
 * 머신 하나의 GitHub 자격: 토큰 하나가 모든 프로젝트의 클론·푸시를
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
   * here — it is machine-wide, and rides on each client. Every response is
   * watched for the 401 that makes the token's expiry visible without
   * anybody asking (아래 authState).
   */
  private readonly transport: RestTransport;
  /**
   * 데몬 자신의 GitHub 읽기가 마지막으로 본 인증 판정. 401 이면 만료·폐기이고,
   * 그 외의 상태는 전부 통과한 증거다 — GitHub 은 인증을 마치기 전에는 숨긴
   * 레포에게도 404 가 아니라 401 로 답하는 일이 없으니(404 는 인증 뒤의
   * 대답이다), 여기만이 토큰의 상태를 묻지 않고 보는 자리다. 푸시 인증 거절은
   * 이 판정에 섞지 않는다 — 403 은 브랜치 보호일 수 있어 만료의 증거가
   * 아니고, 그쪽은 이미 `DiffStatus.reason: "push-auth"` 로 말한다.
   */
  private authState: "ok" | "expired" = "ok";

  constructor(private readonly deps: GitHubBridgeDeps) {
    const inner = createGitHubTransport().transport;
    // 모든 GitHub REST 응답이 지나는 하나의 감시점 — 클라이언트는 전부 여기서 온다.
    this.transport = {
      request: async (input) => {
        const response = await inner.request(input);
        this.noteAuth(response.status === 401);
        return response;
      },
    };
  }

  /** The armed token, or null before `load`/`setToken` ran. */
  get token(): string | null {
    return this.pat;
  }

  /** status.githubAuthExpired 의 원천 — 위 authState 주석이 판정의 전부다. */
  get authExpired(): boolean {
    return this.authState === "expired";
  }

  /** 인증 판정의 전파는 바뀔 때만 — 성공 읽기마다 방송하면 소음이다. */
  private noteAuth(expired: boolean): void {
    const next = expired ? "expired" : "ok";
    if (this.authState === next) return;
    this.authState = next;
    this.deps.onAuthChange?.(expired);
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
    // 새 자격의 생애가 시작됐다 — 이전 토큰이 본 401 은 증거가 아니다. 아래의
    // 게이트 재판정(whoAmI)이 새 토큰의 판정을 곧 다시 세운다.
    this.noteAuth(false);
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
