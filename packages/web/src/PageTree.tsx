import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ConfluencePhase,
  DrafthouseScreen,
  ConfluenceStatus,
  DocSummary,
} from "@drafthouse/protocol";
import type { Daemon } from "./daemon-client";
import { pageMark } from "./stage";
import { timeAgo } from "./format";

const COLLAPSED_KEY = "drafthouse.pagetree.collapsed";

/**
 * The space/page tree (DESIGN §4.1): one collapsible section per mirrored
 * space with its sync state, a hierarchy from frontmatter parentPageId, a
 * 수정됨 marker for locally-modified pages, and a Confluence 웹 링크 per page.
 * The planner never opens the remote themselves — the link is for showing
 * colleagues, not for editing.
 *
 * Each page also carries how far down the pipeline it has come (PLAN §2.4):
 * a 기획서, then a screen built from it, then a developer holding it. Every
 * stage below is decided from something mechanical — a screen the repo itself
 * declared, a pull request GitHub itself reports — never from an opinion
 * about whether the work is "done".
 */

export function PageTree({
  daemon,
  selected,
  onSelect,
  refreshKey,
  onConnect,
  screens,
}: {
  daemon: Daemon;
  selected: string | null;
  onSelect: (path: string) => void;
  /** Bumped whenever a doc.changed or sync status suggests a refresh. */
  refreshKey: number;
  /** Opens the onboarding wizard — where Confluence itself gets connected. */
  onConnect: () => void;
  /**
   * What the connected repo declared it can render. Empty until the preview
   * app has loaded once, which is why a page with a screen can read 기획 중
   * for a moment after launch — the alternative is claiming a stage nothing
   * has confirmed.
   */
  screens: DrafthouseScreen[];
}) {
  const [pagesBySpace, setPagesBySpace] = useState<Array<{ space: string; pages: DocSummary[] }>>([]);
  const [query, setQuery] = useState("");
  const [onlyModified, setOnlyModified] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const [pulling, setPulling] = useState<string[]>([]);

  const spaces = daemon.confluenceStatuses
    .map((status) => status.space)
    .filter((space): space is string => space !== null);
  const spaceKeys = spaces.join(",");

  const refresh = useCallback(async () => {
    const keys = spaceKeys ? spaceKeys.split(",") : [];
    if (keys.length === 0) {
      setPagesBySpace([]);
      return;
    }
    const listed = await Promise.all(
      keys.map((space) =>
        daemon.api
          .docList(space)
          .then((pages) => ({ space, pages }))
          .catch(() => ({ space, pages: [] as DocSummary[] })),
      ),
    );
    setPagesBySpace(listed);
  }, [daemon.api, spaceKeys]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey, selected]);

  /**
   * A page's mark comes from the same function as the stepper above the
   * document (PLAN D8). Before that function existed this file had its own
   * copy of the rules, and a badge that disagreed with the button was only a
   * matter of time.
   */
  const handoff = daemon.repo?.handoff ?? null;
  const markOf = useCallback(
    (page: DocSummary) => pageMark(page, screens, handoff),
    [screens, handoff],
  );

  const siteUrl = daemon.confluenceSettings?.siteUrl ?? null;
  const total = pagesBySpace.reduce((sum, entry) => sum + entry.pages.length, 0);
  const filtering = query.trim().length > 0 || onlyModified;
  const connected = Boolean(siteUrl && daemon.confluenceSettings?.apiTokenConfigured);

  const sections = useMemo(
    () =>
      pagesBySpace.map((entry) => ({
        space: entry.space,
        roots: pruneTree(buildTree(entry.pages), query.trim().toLowerCase(), onlyModified),
      })),
    [pagesBySpace, query, onlyModified],
  );
  const visible = sections.reduce((sum, section) => sum + countNodes(section.roots), 0);

  const toggleCollapsed = (space: string) => {
    setCollapsed((prev) => {
      const next = prev.includes(space) ? prev.filter((key) => key !== space) : [...prev, space];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // A private-mode browser refusing storage costs the memory of a fold.
      }
      return next;
    });
  };

  const pull = async (space: string) => {
    setPulling((prev) => [...prev, space]);
    try {
      await daemon.api.confluencePull(space);
    } catch {
      // The failure comes back as the space's own error status and detail.
    } finally {
      setPulling((prev) => prev.filter((key) => key !== space));
    }
  };

  if (total === 0) {
    return (
      <div className="pagetree">
        <EmptyTree daemon={daemon} connected={connected} onConnect={onConnect} />
      </div>
    );
  }

  return (
    <div className="pagetree">
      <div className="pagetree__filter">
        <input
          type="search"
          className="pagetree__search"
          aria-label="페이지 검색"
          placeholder="페이지 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={onlyModified ? "pagetree__toggle pagetree__toggle--on" : "pagetree__toggle"}
          aria-pressed={onlyModified}
          title="수정된 페이지만 보기"
          onClick={() => setOnlyModified((on) => !on)}
        >
          수정됨
        </button>
        {connected && <MirrorRefresh daemon={daemon} />}
      </div>

      {visible === 0 ? (
        <p className="hint">일치하는 페이지가 없습니다.</p>
      ) : (
        sections.map(({ space, roots }) => {
          const status = daemon.confluenceStatuses.find((entry) => entry.space === space);
          // The site's own name ("결제 서비스") leads; the raw key (~63DCB…)
          // stays in the tooltip — it is an identifier, not a label.
          const label = status?.spaceTitle ?? space;
          const folded = collapsed.includes(space) && !filtering;
          return (
            <section key={space} className="pagetree__space">
              <div className="pagetree__space-head">
                <button
                  type="button"
                  className="pagetree__space-name"
                  aria-expanded={!folded}
                  title={`${label} (${space})`}
                  onClick={() => toggleCollapsed(space)}
                >
                  <span className="pagetree__caret">{folded ? "▸" : "▾"}</span>
                  {label}
                </button>
                <SpaceMeta status={status} busy={pulling.includes(space)} />
                <button
                  type="button"
                  className="pagetree__sync"
                  aria-label={`${space} 지금 동기화`}
                  title="Confluence에서 지금 가져오기"
                  disabled={pulling.includes(space) || Boolean(status && WORKING_PHASE[status.phase])}
                  onClick={() => void pull(space)}
                >
                  ↻
                </button>
              </div>
              {!folded && roots.length > 0 && (
                <ul className="pagetree__list">
                  {roots.map((node) => (
                    <TreeRow
                      key={node.page.path}
                      node={node}
                      depth={0}
                      selected={selected}
                      onSelect={onSelect}
                      siteUrl={siteUrl}
                      space={space}
                      markOf={markOf}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}

/** Why the tree is empty, and the one control that fixes it. */
function EmptyTree({
  daemon,
  connected,
  onConnect,
}: {
  daemon: Daemon;
  connected: boolean;
  onConnect: () => void;
}) {
  const cloning = daemon.confluenceStatuses.find((status) => status.phase === "cloning");
  if (cloning) {
    return (
      <p className="hint">
        {cloning.space} 스페이스를 복제하는 중입니다…
        {cloning.detail ? ` ${cloning.detail}` : ""}
      </p>
    );
  }
  if (!connected) {
    return (
      <div className="pagetree__empty">
        <p className="hint">Confluence가 아직 연결되지 않았습니다.</p>
        <button type="button" className="ghost" onClick={onConnect}>
          Confluence 연결
        </button>
      </div>
    );
  }
  // A mirrored space with no pages is not a missing mirror: the project owns a
  // subtree nobody has written a 기획서 in yet, and telling the planner to
  // clone something would send them looking for a control that no longer
  // exists.
  const mirrored = daemon.confluenceStatuses.length > 0;
  return (
    <div className="pagetree__empty">
      <p className="hint">
        {mirrored
          ? "이 프로젝트에 기획서가 아직 없습니다. 기획 대화로 첫 기획서를 만들어 보세요."
          : "이 프로젝트의 기획서를 아직 가져오지 않았습니다."}
      </p>
      <MirrorRefresh daemon={daemon} label="기획서 다시 가져오기" className="ghost" />
    </div>
  );
}

/**
 * Re-fetch what THIS project declares it owns.
 *
 * There used to be a space picker here, and it has to be gone: a project's
 * roots are the only thing allowed to decide what its mirror holds. A space
 * cloned ad-hoc would be a folder no registry entry claims, invisible to the
 * overlap rule — so two projects could end up mirroring the same pages, and
 * the optimistic lock that keeps a push from overwriting somebody's edit
 * would quietly split in two. Changing what a project covers is a change to
 * the project.
 */
function MirrorRefresh({
  daemon,
  label = "다시 가져오기",
  className = "pagetree__toggle",
}: {
  daemon: Daemon;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      // The daemon clones every root the active project declares; a clone that
      // failed mid-transfer comes back as the space's own error status rather
      // than a rejection, so it has to be read out of the reply.
      const status = (await daemon.api.onboardingFix("confluence-sync")) as {
        phase?: string;
        detail?: string | null;
      };
      if (status?.phase === "error") setError(status.detail ?? "기획서를 가져오지 못했습니다");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={className}
        title="이 프로젝트의 Confluence 기획서를 다시 가져옵니다"
        disabled={busy}
        onClick={() => void refresh()}
      >
        {busy ? "가져오는 중…" : label}
      </button>
      {error && <p className="pagetree__cloner-error">{error}</p>}
    </>
  );
}

/** Phases during which a space is mid-transfer and must not be pulled again. */
const WORKING_PHASE: Partial<Record<ConfluencePhase, true>> = {
  cloning: true,
  pulling: true,
  pushing: true,
};

/** Right side of a space header: what it is doing, or when it last pulled. */
function SpaceMeta({ status, busy }: { status: ConfluenceStatus | undefined; busy: boolean }) {
  if (busy || (status && WORKING_PHASE[status.phase])) {
    return (
      <span className="pagetree__space-meta" title={status?.detail ?? undefined}>
        <span className="dot dot--busy" />
        동기화 중
      </span>
    );
  }
  if (status?.phase === "error") {
    return (
      <span className="pagetree__space-meta pagetree__space-meta--error" title={status.detail ?? undefined}>
        동기화 실패
      </span>
    );
  }
  return (
    <span className="pagetree__space-meta">
      {status?.pulledAt ? timeAgo(status.pulledAt) : "—"}
    </span>
  );
}

interface TreeNode {
  page: DocSummary;
  children: TreeNode[];
  /** True when the node itself failed the filter and only carries children. */
  dim?: boolean;
}

function buildTree(pages: DocSummary[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(pages.map((page) => [page.pageId, { page, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.page.parentPageId ? nodes.get(node.page.parentPageId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * Keep every node that matches, plus the ancestors that lead to one — a hit
 * three levels down is useless without the path that reaches it. Ancestors
 * kept only as a path render dimmed.
 */
function pruneTree(nodes: TreeNode[], query: string, onlyModified: boolean): TreeNode[] {
  if (!query && !onlyModified) return nodes;
  const keep: TreeNode[] = [];
  for (const node of nodes) {
    const children = pruneTree(node.children, query, onlyModified);
    const hit =
      (!query || node.page.title.toLowerCase().includes(query)) &&
      (!onlyModified || node.page.modified || node.page.conflict);
    if (hit || children.length > 0) keep.push({ page: node.page, children, dim: !hit });
  }
  return keep;
}

function countNodes(nodes: TreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

function readCollapsed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
  siteUrl,
  space,
  markOf,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
  siteUrl: string | null;
  /** The Confluence space key - not always the path's folder name. */
  space: string;
  markOf: (page: DocSummary) => { mark: string; title: string };
}) {
  const { page } = node;
  const stage = markOf(page);
  const webUrl =
    siteUrl && page.pageId
      ? `${siteUrl}/wiki/spaces/${encodeURIComponent(space)}/pages/${page.pageId}`
      : null;
  const rowClass = [
    "pagetree__row",
    page.path === selected ? "pagetree__row--active" : "",
    node.dim ? "pagetree__row--dim" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <li>
      <div className={rowClass} style={{ paddingLeft: 8 + depth * 14 }}>
        {/* Before the title, not after: the planner scans this column to find
            what still needs work, and a mark that trails a variable-length
            title cannot be scanned. */}
        <span className="pagetree__stage" title={stage.title}>
          {stage.mark}
        </span>
        <button type="button" className="pagetree__title" onClick={() => onSelect(page.path)}>
          {page.title}
        </button>
        {page.conflict && <span className="pagetree__flag pagetree__flag--conflict" title="충돌">!</span>}
        {page.isNew && !page.conflict && (
          <span className="pagetree__flag pagetree__flag--new" title="아직 Confluence에 없는 새 페이지">
            신규
          </span>
        )}
        {page.modified && !page.isNew && !page.conflict && (
          <span className="pagetree__flag" title="수정됨 (아직 반영 전)">수정됨</span>
        )}
        {webUrl && (
          <a className="pagetree__link" href={webUrl} target="_blank" rel="noreferrer" title="Confluence에서 보기">
            ↗
          </a>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="pagetree__list">
          {node.children.map((child) => (
            <TreeRow
              key={child.page.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              siteUrl={siteUrl}
              space={space}
              markOf={markOf}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
