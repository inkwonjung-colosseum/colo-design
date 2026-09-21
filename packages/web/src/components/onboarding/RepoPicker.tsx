import type { GitHubRepo, GitHubRepoInspection } from "@colo-design/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { composing } from "../../lib/ime";
import { FolderIcon, FolderPlusIcon } from "../icons";
import { Tip } from "../shell/Tip";

/** `https://github.com/o/r(.git)(/)` → `o/r`, for matching a project's stored url. */
function normalizeUrl(url: string): string {
  // 꼬리 슬래시를 먼저 깎는다 — .git 을 먼저 깎으면 `…/r.git/` 이 그대로 남아
  // 같은 레포가 둘로 읽힌다.
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
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
 * uses it to run the same pre-clone inspection the list rows get:
 * a url whose dev script, push access and default branch we can name
 * before the download.
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
 * clone — a dev script and push access are what separate a project from
 * minutes of downloading into a dead end — and a repo the list cannot see
 * still gets in through the folded manual url.
 *
 * This is the whole body of the workspace when no project exists yet, and the
 * contents of 프로젝트 추가 when one does. Both hosts pass
 * `onCreated`; the daemon's own `repo.status` draws the clone that follows.
 */
export function RepoPicker({
  daemon,
  onCreated,
  onInspection,
}: {
  daemon: Daemon;
  onCreated?: () => void;
  /** 검사가 답하면 호스트에 알린다 — 시작 마법사가 레포 단계의 주의 배지를
      붙이는 근거. 고르기 전·해제 때는 null. */
  onInspection?: (result: Pick<GitHubRepoInspection, "hasDevScript" | "canPush"> | null) => void;
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
    // Pushable repos only: what this token cannot push to it can
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
    onInspection?.(null);
    daemon.api
      .githubRepoInspect(repo.owner, repo.name)
      .then((result) => {
        // Only the still-selected repo may paint the answer; a fast earlier
        // response must not outrun a slower one for a repo picked later.
        setSelected((current) => {
          if (current?.fullName === repo.fullName) {
            setInspection({ phase: "ready", result });
            onInspection?.({ hasDevScript: result.hasDevScript, canPush: result.canPush });
          }
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
      });
      onCreated?.();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  /**
   * 만들기 문은 검사 응답 하나다 — 준비(설치 · 미리보기) 명령의 동의는
   * 만들기 클릭이 곧 담는다.
   */
  const blocked = inspection === null || inspection.phase !== "ready";
  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    // Composition keys pass straight through: Enter would pick a repo off a
    // half-typed word.
    if (composing(e)) return;
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
      // 검색창의 지움은 검색의 몫이다 — 같은 키가 위 대화상자까지 닫지 않게
      // 전파를 끊는다.
      e.stopPropagation();
      setSelected(null);
      setInspection(null);
      onInspection?.(null);
    }
  };

  const addManually = async () => {
    setManualBusy(true);
    setManualError(null);
    const url = manualUrl.trim();
    try {
      // A GitHub url gets the list rows' inspection first: the dev-script
      // check and the default branch cost one request and save a planner
      // from a download that could not have worked. 다만 검사의 실패는
      // 만들기의 실패가 아니다 — baseBranch 를 비워 두면 데몬의 뒤스캔이
      // 기본 가지를 대신 밝힌다.
      const slug = githubSlugOf(url);
      let baseBranch: string | undefined;
      if (slug) {
        try {
          baseBranch = (await daemon.api.githubRepoInspect(slug.owner, slug.repo)).defaultBranch;
        } catch {
          baseBranch = undefined;
        }
      }
      await daemon.api.projectCreate({
        name: nameFromUrl(url) || url,
        repoUrl: url,
        ...(baseBranch ? { baseBranch } : {}),
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
        <div className="menuempty">
          <span className="ic ic--quiet">
            <FolderIcon />
          </span>
          <span>개발자에게 초대 파일을 요청하세요 — 받은 파일을 시작 화면에서 열면 연결됩니다</span>
        </div>
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
                <span className="ic ic--lg ic--quiet">
                  <FolderIcon />
                </span>
                개발자에게 받은 코드가 이 레포에 닿지 않습니다 — 개발자에게 다시 요청하세요.
                <details className="repopicker__devnote">
                  <summary>개발자용 ▾</summary>
                  <span className="hint">
                    읽기만 가능한 레포는 개발자에게 넘길 수 없어 목록에서 제외됩니다. 코드를 만들 때
                    레포 접근 범위와 Contents: Read and write 권한을, 조직이 SSO를 쓴다면 코드
                    승인을 확인해 주세요.
                  </span>
                </details>
              </li>
            )}
            {phase === "ready" && rows.length === 0 && query.trim() !== "" && (
              <li className="repopicker__empty">
                <span className="ic ic--lg ic--quiet">
                  <FolderIcon />
                </span>
                &apos;{query.trim()}&apos;와 맞는 레포가 없습니다 — 아래 개발자용에서 주소로
                추가하세요.
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
            <p className="onboarding__detail repopicker__inspect">
              {!inspection.result.hasDevScript && (
                <span className="repopicker__warnline">
                  ! 미리보기 명령이 없습니다 — 준비 중에 AI가 추가합니다.
                </span>
              )}
              {!inspection.result.canPush && (
                <span className="repopicker__warnline">
                  ! 이 코드로는 개발자에게 넘길 수 없습니다 — 화면 작업은 계속할 수 있습니다.
                </span>
              )}
            </p>
          )}
          <div className="repopicker__confirmrow">
            <input
              value={name}
              placeholder="프로젝트 이름 (예: 결제)"
              aria-label="프로젝트 이름"
              disabled={creating}
              onChange={(e) => setName(e.target.value)}
            />
            <Tip label={blocked ? "레포를 확인하는 중입니다" : undefined}>
              <button
                type="button"
                className="primary"
                disabled={Boolean(blocked)}
                onClick={() => void create()}
              >
                <FolderPlusIcon />
                {creating ? "만드는 중…" : "프로젝트 만들기"}
              </button>
            </Tip>
          </div>
          <p className="hint">
            레포를 내려받고 설치·미리보기까지 합니다 — 처음에는 몇 분 걸립니다.
          </p>
          {createError && (
            <div className="notice notice--error">
              <span className="notice__text">{createError}</span>
            </div>
          )}
        </div>
      )}

      {/* 주소로 추가는 개발자의 길이다 — 비개발자가 밟을 단계가 아니므로
          개발자용 폴드 안에 접어 둔다(기본 닫힘). */}
      <details className="repopicker__devnote">
        <summary>개발자용 ▾</summary>
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
                if (e.key === "Enter" && manualUrl.trim() && !manualBusy) {
                  void addManually();
                }
              }}
            />
            <button
              type="button"
              className="primary"
              disabled={!manualUrl.trim() || manualBusy}
              onClick={() => void addManually()}
            >
              {manualBusy ? "만드는 중…" : "추가"}
            </button>
          </div>
          {!manualBusy && !manualUrl.trim() && (
            <p className="hint">연결 레포의 git 주소를 입력하면 추가 버튼이 켜집니다.</p>
          )}
          <p className="hint">코드 없이 접근할 수 있는 주소나, GitHub 밖의 git 주소를 쓸 때만.</p>
          {manualError && (
            <div className="notice notice--error">
              <span className="notice__text">{manualError}</span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
