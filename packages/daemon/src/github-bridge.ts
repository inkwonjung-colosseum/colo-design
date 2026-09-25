import type { GitHubRepoList } from "@colo-design/protocol";
import { type CredentialStore, loadRepoPat, REPO_PAT_ITEM } from "./credentials.js";
import { createGitHubTransport, GitHubClient } from "./github.js";
import { parseTokenExpiration } from "./github-expiry.js";
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
  /**
   * 연결 코드의 만료 예정(U17) — GitHub 이 모든 응답에 실어 주는 머리글에서
   * 읽은 ISO 시각. 값이 바뀔 때만 오고, 새 토큰이 오면 null 로 되돌아온다.
   * 서버는 이 값을 machine.json 에 견줘 두고 만료 예고를 건넨다.
   */
  onExpiryChange?(iso: string | null): void;
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
  /**
   * 만료일이 있는 코드의 만료 예정(ISO) — 머리글이 오지 않으면 null(만료일 없는
   * 코드). setToken 이 새 자격의 생애를 시작하며 null 로 되돌린다.
   */
  private tokenExpiry: string | null = null;

  constructor(private readonly deps: GitHubBridgeDeps) {
    const inner = createGitHubTransport().transport;
    // 모든 GitHub REST 응답이 지나는 하나의 감시점 — 클라이언트는 전부 여기서 온다.
    this.transport = {
      request: async (input) => {
        const response = await inner.request(input);
        this.noteAuth(response.status === 401);
        // 머리글을 아예 실을 수 없는 전송의 응답은 지나간다 — 「만료일이 없다」와
        // 「못 보았다」가 다른 답이므로 알고 있던 값을 지우지 않는다.
        if (response.headers !== undefined) {
          this.noteExpiry(parseTokenExpiration(response.headers));
        }
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

  /** status.githubTokenExpiresAt 의 원천 — 위 tokenExpiry 주석이 판정의 전부다. */
  get tokenExpiresAt(): string | null {
    return this.tokenExpiry;
  }

  /** 인증 판정의 전파는 바뀔 때만 — 성공 읽기마다 방송하면 소음이다. */
  private noteAuth(expired: boolean): void {
    const next = expired ? "expired" : "ok";
    if (this.authState === next) return;
    this.authState = next;
    this.deps.onAuthChange?.(expired);
  }

  /** 만료 예정의 전파도 값이 바뀔 때만 — GitHub 은 모든 응답에 같은 값을 실어 보낸다. */
  private noteExpiry(iso: string | null): void {
    if (this.tokenExpiry === iso) return;
    this.tokenExpiry = iso;
    this.deps.onExpiryChange?.(iso);
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
    this.noteAuth(false);
    // 새 자격의 생애가 시작됐다 — 이전 토큰의 만료 예고도 지운다. 다음 응답이
    // 새 토큰의 만료일을 다시 쓴다.
    this.noteExpiry(null);
    // Every live workspace re-arms at once; a project the planner has not
    // touched this run gets the token when it is next activated.
    this.deps.onToken(this.pat);
    const steps = await runOnboardingChecks({
      claudeExecutableOverride: this.deps.claudeExecutableOverride(),
      gitHubClient: () => this.client(),
      // 폼이 다시 채색되는 이 같은 판정이 쓰기 레포 0개도 말하게 한다(P1-2).
      githubWriteRepoCount: () => this.writeRepoCount(),
    });
    return steps.find((step) => step.id === "github") ?? null;
  }

  /**
   * 이 토큰으로 접근 가능한 쓰기 레포 수(P1-2) — onboarding.check 의 github 게이트가
   * 묻는다. listRepos 와 같은 캐시를 읽으므로 피커가 열리기 전의 이 한 번이
   * 유일한 비용이다. 목록을 못 읽으면 null — 게이트는 판정을 유보한다.
   */
  async writeRepoCount(): Promise<number | null> {
    try {
      const list = await this.listRepos(false);
      return list.repos.filter((repo) => repo.canPush).length;
    } catch {
      return null;
    }
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
