import { useEffect, useMemo, useRef, useState } from "react";
import type { GitHubRepo, GitHubRepoInspection } from "@cds-design/protocol";
import type { Daemon } from "./daemon-client";

/** `https://github.com/o/r(.git)` → `o/r`, for matching a project's stored url. */
function normalizeUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

/** The picker's one timestamp, in the coarse units a planner scans by. */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (Number.isNaN(days)) return "";
  if (days <= 0) return "오늘";
  if (days < 7) return `${days}일 전`;
  if (days < 35) return `${Math.floor(days / 7)}주 전`;
  if (days < 365) return `${Math.floor(days / 30)}달 전`;
  return `${Math.floor(days / 365)}년 전`;
}

/**
 * A github.com url's owner/repo, or null for anything else. The manual path
 * uses it to run the same pre-clone inspection the list rows get (PLAN D31):
 * a url the token can inspect is a url whose `cds-design.json` we can check
 * before the download, and whose default branch we can name.
 */
function githubSlugOf(url: string): { owner: string; repo: string } | null {
  const match = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  const owner = match?.[1];
  const repo = match?.[2];
  return owner && repo ? { owner, repo } : null;
}

/** The last `o/r` segment, as the manual path pre-fills the project name. */
function nameFromUrl(url: string): string {
  return (normalizeUrl(url).split("/").pop() ?? "").replace(/\.git$/i, "");
}

type Inspection =
  | { phase: "checking" }
  | { phase: "ready"; result: GitHubRepoInspection }
  | { phase: "error"; error: string };

/**
 * Adding a project: not a url field but the list of repos the stored token
 * can push to — a read-only clone could start work but never hand it over,
 * so those rows never render. Picking one judges it before any
 * clone — `cds-design.json` presence is what separates a project from
 * minutes of downloading into a dead end — and a repo the list cannot see
 * still gets in through the folded manual url.
 *
 * This is the whole body of the workspace when no project exists yet, and the
 * contents of 프로젝트 추가 when one does (PLAN D16). Both hosts pass
 * `onCreated`; the daemon's own `repo.status` draws the clone that follows.
 */
export function RepoPicker({
  daemon,
  onCreated,
  onOpenSettings,
}: {
  daemon: Daemon;
  /** Runs once `project.create` answered — the dialog closes on it. */
  onCreated?: () => void;
  /** Opens 설정 where a missing token is entered. */
  onOpenSettings?: () => void;
}) {
  // A token that never passed the gate cannot list anything; saying so beats
  // an empty list that looks like "no repos".
  const hasToken =
    daemon.onboarding?.some((step) => step.id === "github" && step.status === "pass") ?? false;

  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [selected, setSelected] = useState<GitHubRepo | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /**
   * Whether the planner folded or opened the manual form themselves; null
   * until they touch it. The default follows hasToken live rather than its
   * mount-time value: a fast 시작하기 can land this picker before the
   * token's status arrives, and a stale no would pin the address form open
   * under a token that already works.
   */
  const [manualPreference, setManualPreference] = useState<boolean | null>(null);
  const manualOpen = manualPreference ?? !hasToken;
  const [manualUrl, setManualUrl] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = (refresh = false) => {
    setPhase("loading");
    setListError(null);
    daemon.api
      .githubReposList(refresh)
      .then((list) => {
        setRepos(list.repos);
        setTruncated(list.truncated);
        setPhase("ready");
      })
      .catch((e) => {
        setListError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      });
  };

  useEffect(() => {
    if (!hasToken) return;
    load();
    searchRef.current?.focus();
    // Mounts once per opening; the daemon caches the list, so a remount costs
    // one local read rather than one GitHub crawl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken]);

  const rows = useMemo(() => {
    // Pushable repos only (PLAN D29): what this token cannot push to it can
    // never hand over, so the picker leaves it out rather than badging it.
    const pushable = repos.filter((repo) => repo.canPush);
    const q = query.trim().toLowerCase();
    if (!q) return pushable;
    return pushable.filter((repo) => repo.fullName.toLowerCase().includes(q));
  }, [repos, query]);

  // A repo already registered as a project cannot be added twice — the same
  // clone twice would fork one repo's screen work into two registries.
  const addedUrls = useMemo(
    () =>
      new Set(
        daemon.projects
          .map((project) => project.repoUrl)
          .filter((url): url is string => Boolean(url))
          .map(normalizeUrl),
      ),
    [daemon.projects],
  );

  useEffect(() => {
    // Filtering must never leave the highlight on a row that is gone.
    setHighlight((current) => Math.min(current, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const pick = (repo: GitHubRepo) => {
    setSelected(repo);
    setName(repo.name);
    setCreateError(null);
    setInspection({ phase: "checking" });
    daemon.api
      .githubRepoInspect(repo.owner, repo.name)
      .then((result) => {
        // Only the still-selected repo may paint the answer; a fast earlier
        // response must not outrun a slower one for a repo picked later.
        setSelected((current) => {
          if (current?.fullName === repo.fullName) setInspection({ phase: "ready", result });
          return current;
        });
      })
      .catch((e) => {
        const error = e instanceof Error ? e.message : String(e);
        setSelected((current) => {
          if (current?.fullName === repo.fullName) setInspection({ phase: "error", error });
          return current;
        });
      });
  };

  const create = async () => {
    if (!selected) return;
    setCreating(true);
    setCreateError(null);
    try {
      await daemon.api.projectCreate({
        name: name.trim(),
        repoUrl: selected.cloneUrl,
        ...(inspection?.phase === "ready" ? { baseBranch: inspection.result.defaultBranch } : {}),
        ...(bootstrapCreate ? { bootstrap: true } : {}),
        ...(approveRun ? { approveCommands: true } : {}),
      });
      onCreated?.();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };


  /**
   * The 만들기 gate (PLAN D28 → D94): the inspection must have answered, and
   * the answer must be a repo this tool can work in — OR one Claude can
   * prepare, which is a choice now, not a wall.
   */
  const needsBootstrap = inspection !== null && inspection.phase === "ready" && !inspection.result.hasCdsDesign;
  const [bootstrapCreate, setBootstrapCreate] = useState(false);
  /** The one explicit yes a new repo's install · preview commands need. */
  const [approveRun, setApproveRun] = useState(false);
  /** Same explicit yes, for the address-typed path. */
  const [manualApprove, setManualApprove] = useState(false);
  const blocked =
    inspection === null ||
    inspection.phase !== "ready" ||
    (!inspection.result.hasCdsDesign && !bootstrapCreate) ||
    !approveRun;
  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((current) => Math.min(current + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
    } else if (e.key === "Enter" && rows[highlight]) {
      e.preventDefault();
      const repo = rows[highlight];
      if (!addedUrls.has(normalizeUrl(repo.cloneUrl))) pick(repo);
    } else if (e.key === "Escape") {
      setSelected(null);
      setInspection(null);
    }
  };

  const addManually = async () => {
    setManualBusy(true);
    setManualError(null);
    const url = manualUrl.trim();
    try {
      // A GitHub url gets the list rows' inspection first (PLAN D31): the
      // cds-design.json check and the default branch cost one request and
      // save a planner from a download that could not have worked.
      const slug = githubSlugOf(url);
      const baseBranch = slug
        ? (await daemon.api.githubRepoInspect(slug.owner, slug.repo)).defaultBranch
        : undefined;
      await daemon.api.projectCreate({
        name: nameFromUrl(url) || url,
        repoUrl: url,
        ...(baseBranch ? { baseBranch } : {}),
        ...(manualApprove ? { approveCommands: true } : {}),
      });
      setManualUrl("");
      onCreated?.();
    } catch (e) {
      setManualError(e instanceof Error ? e.message : String(e));
    } finally {
      setManualBusy(false);
    }
  };

  return (
    <div className="repopicker">
      {!hasToken ? (
        <p className="onboarding__detail">
          GitHub에 연결하면 목록에서 고를 수 있습니다 —{" "}
          {onOpenSettings ? (
            <button type="button" className="ghost repopicker__settingslink" onClick={onOpenSettings}>
              설정 → GitHub
            </button>
          ) : (
            "설정 → GitHub"
          )}
        </p>
      ) : phase === "error" ? (
        <div className="repopicker__listerror">
          <p className="onboarding__detail">{listError}</p>
          <button type="button" className="ghost" onClick={() => load(true)}>
            다시 시도
          </button>
        </div>
      ) : (
        <>
          <input
            ref={searchRef}
            className="repopicker__search"
            value={query}
            placeholder="레포 이름으로 찾기"
            aria-label="레포 이름으로 찾기"
            role="combobox"
            aria-expanded="true"
            aria-controls="repopicker-list"
            aria-activedescendant={rows[highlight] ? `repopicker-opt-${highlight}` : undefined}
            disabled={phase === "loading"}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onSearchKeyDown}
          />
          <ul className="repopicker__list" id="repopicker-list" role="listbox" ref={listRef}>
            {phase === "loading" &&
              [0, 1, 2].map((index) => <li key={index} className="repopicker__row--ghost" />)}
            {phase === "ready" && rows.length === 0 && query.trim() === "" && (
              <li className="repopicker__empty">
                이 토큰에 쓰기 권한이 있는 레포가 없습니다.
                <span className="hint">
                  읽기만 가능한 레포는 개발자에게 넘길 수 없어 목록에서 제외됩니다. fine-grained
                  토큰이라면 레포 접근 범위와 Contents: Read and write 권한을, 조직이 SSO를 쓴다면
                  토큰 승인을 확인해 주세요. 아래에서 주소로 직접 추가할 수도 있습니다.
                </span>
              </li>
            )}
            {phase === "ready" && rows.length === 0 && query.trim() !== "" && (
              <li className="repopicker__empty">
                &apos;{query.trim()}&apos;와 맞는 레포가 없습니다 — 아래에서 주소로 추가하세요.
              </li>
            )}
            {rows.map((repo, index) => {
              const added = addedUrls.has(normalizeUrl(repo.cloneUrl));
              return (
                <li
                  key={repo.fullName}
                  id={`repopicker-opt-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={selected?.fullName === repo.fullName}
                  aria-disabled={added}
                  className={[
                    "repopicker__row",
                    index === highlight ? "repopicker__row--on" : "",
                    added ? "repopicker__row--off" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => !added && pick(repo)}
                >
                  <span className="repopicker__owner">{repo.owner} /</span>
                  <span className="repopicker__name">{repo.name}</span>
                  <span className="repopicker__time">{relativeTime(repo.pushedAt)}</span>
                  {added && (
                    <span className="repopicker__badge repopicker__badge--muted">추가됨</span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="hint">
            {phase === "loading"
              ? "레포 목록을 가져오는 중…"
              : truncated
                ? `최근 ${rows.length}개만 보여줍니다 — 이름으로 찾거나 주소로 추가하세요`
                : `접근 가능한 레포 ${rows.length}개`}
          </p>
        </>
      )}

      {selected && (
        <div className="repopicker__confirm">
          {inspection === null || inspection.phase === "checking" ? (
            <p className="onboarding__detail">레포를 확인하는 중…</p>
          ) : inspection.phase === "error" ? (
            <p className="onboarding__detail">{inspection.error}</p>
          ) : (
            <p
              className={`onboarding__detail repopicker__inspect repopicker__inspect--${
                inspection.result.hasCdsDesign ? "ok" : "miss"
              }`}
            >
              {inspection.result.hasCdsDesign
                ? `✓ cds-design.json 있음 · 기본 브랜치 ${inspection.result.defaultBranch}`
                : "✗ 이 레포에는 cds-design.json이 없습니다 — Claude 가 연결을 준비할 수 있어요."}
              {!inspection.result.canPush && (
                <span className="repopicker__warnline">
                  ! 이 토큰으로는 이 레포에 넘길 수 없습니다 — 화면 작업은 되지만 PR은 열지 못합니다.
                </span>
              )}
            </p>
          )}
          {inspection?.phase === "ready" && (
            <label className="repopicker__approve">
              <input
                type="checkbox"
                data-testid="approve-commands"
                checked={approveRun}
                disabled={creating}
                onChange={(e) => setApproveRun(e.target.checked)}
              />
              이 레포가 정의한 설치 · 미리보기 명령을 이 기기에서 실행하는 것을 허용합니다
            </label>
          )}
          <div className="repopicker__confirmrow">
            <input
              value={name}
              placeholder="프로젝트 이름 (예: 결제)"
              aria-label="프로젝트 이름"
              disabled={creating}
              onChange={(e) => setName(e.target.value)}
            />
            {bootstrapCreate && (
              <button
                type="button"
                className="primary"
                disabled={Boolean(blocked)}
                onClick={() => void create()}
              >
                {creating ? "준비하는 중…" : "Claude 가 연결 준비하기"}
              </button>
            )}
            {!bootstrapCreate && (
              <button
                type="button"
                className="primary"
                disabled={Boolean(blocked)}
                onClick={() => void create()}
              >
                {creating ? "만드는 중…" : "프로젝트 만들기"}
              </button>
            )}
          </div>
          {needsBootstrap && !bootstrapCreate && (
            <button
              type="button"
              className="ghost"
              data-testid="bootstrap-choice"
              onClick={() => setBootstrapCreate(true)}
            >
              Claude 가 연결 준비하기
            </button>
          )}
          <p className="hint">
            {bootstrapCreate
              ? "Claude 가 레포에 연결 파일을 쓰고, 개발자는 첫 넘기기 PR 로 받아 봅니다."
              : "레포를 내려받고 설치·미리보기까지 합니다 — 처음에는 몇 분 걸립니다."}
          </p>
          {createError && (
            <div className="notice notice--error">
              <span className="notice__text">{createError}</span>
            </div>
          )}
        </div>
      )}

      {manualOpen ? (
        <div className="repopicker__manual">
          <div className="ghtoken__row">
            <input
              value={manualUrl}
              spellCheck={false}
              placeholder="https://github.com/<조직>/<레포>.git"
              aria-label="연결 레포 주소"
              disabled={manualBusy}
              onChange={(e) => setManualUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && manualUrl.trim() && !manualBusy && manualApprove) {
                  void addManually();
                }
              }}
            />
            <button
              type="button"
              className="primary"
              disabled={!manualUrl.trim() || manualBusy || !manualApprove}
              onClick={() => void addManually()}
            >
              {manualBusy ? "만드는 중…" : "추가"}
            </button>
          </div>
          <label className="repopicker__approve">
            <input
              type="checkbox"
              data-testid="approve-commands-manual"
              checked={manualApprove}
              disabled={manualBusy}
              onChange={(e) => setManualApprove(e.target.checked)}
            />
            이 레포가 정의한 설치 · 미리보기 명령을 이 기기에서 실행하는 것을 허용합니다
          </label>
          <p className="hint">토큰 없이 접근할 수 있는 주소나, GitHub 밖의 git 주소를 쓸 때만.</p>
          {manualError && (
            <div className="notice notice--error">
              <span className="notice__text">{manualError}</span>
            </div>
          )}
        </div>
      ) : (
        phase !== "loading" && (
          <button
            type="button"
            className="ghost repopicker__manualtoggle"
            onClick={() => setManualPreference(true)}
          >
            목록에 없나요? 주소로 추가
          </button>
        )
      )}
    </div>
  );
}
