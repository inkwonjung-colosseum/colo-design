/**
 * Projects (PLAN D2[프로젝트]): one project is one connected repo. It is the unit
 * everything else is scoped to — the clone the agent edits, the preview server
 * that runs, and (because the Agent SDK stores transcripts per directory) the
 * session list.
 *
 * Layout, one folder per project:
 *
 *   ~/.colo-design/config/projects.json
 *   ~/.colo-design/projects/<slug>/repo/   the clone
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { HandoffStatus } from "@colo-design/protocol";
import { COLO_DESIGN_DIR, CONFIG_DIR } from "./environment.js";

export interface ProjectRepo {
  url: string | null;
  /** What a handoff PR targets (PLAN D5[넘기기]). `main` unless the repo says otherwise. */
  baseBranch: string;
  /**
   * The open work cycle (PLAN D5[넘기기]): the branch 저장 pushes to and the pull
   * request a developer received. It lives in the registry rather than in the
   * clone because a re-clone must not lose track of a PR somebody is already
   * reviewing, and because the UI has to show 넘김/반영됨 before the repo
   * workspace has finished starting.
   */
  branch: string | null;
  handoff: HandoffStatus | null;
  /**
   * 이 사이클의 핀 앵커 (D93 후속): 이 시각 이후에 찍힌 코멘트가 이 사이클의
   * 것이다 — 넘긴 요청 본문의 `### 수정 요청` 절이 여기부터 읽는다. 사이클이
   * 태어난 시각(프로젝트 생성 · 이전 요청의 착지)에 새로 쓰이고, 레지스트리만이
   * 재시작을 살아남는다. 없으면(업그레이드 전에 시작한 사이클) 넘기기는 예전처럼
   * 브랜치 첫 커밋 시각으로 대신한다.
   */
  commentsSince?: string;
}

export interface Project {
  /** Stable id: folder name, credential-store item suffix, wire identity. */
  slug: string;
  /** What the planner named it. Korean is normal here. */
  name: string;
  repo: ProjectRepo;
  /**
   * Whether the planner said this repo's `install`/`preview` commands may
   * run on this machine. `undefined` is a project created before the gate —
   * approval read as given, since its commands have already run here.
   */
  commandsApproved?: boolean;
  /**
   * 이 프로젝트에서 AI 가 지켜 줄 것(설정 문서 P1#8) — 브랜치·커밋·PR
   * 규칙을 사용자의 말로 적는 한 줄 상자. 세션의 시스템 프롬프트 끝에
   * 붙는다. 비면 붙지 않는다.
   */
  instructions?: string;
}

/** Every path a project owns. */
export interface ProjectPaths {
  /** `~/.colo-design/projects/<slug>` */
  root: string;
  /** The connected repo's clone. */
  repoRoot: string;
}

interface ProjectsFile {
  active: string | null;
  projects: Project[];
}

const DEFAULT_BASE_BRANCH = "main";

/** The slug a pre-projects installation migrates into. */
const LEGACY_SLUG = "default";

/** `COLO_DESIGN_PROJECTS_SETTINGS` points a test at a throwaway registry. */
function projectsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLO_DESIGN_PROJECTS_SETTINGS ?? join(CONFIG_DIR, "projects.json");
}

function projectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLO_DESIGN_PROJECTS_DIR ?? join(COLO_DESIGN_DIR, "projects");
}
// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * A folder- and item-safe id derived from the name.
 *
 * Only path-hostile characters are removed — the same set page filenames
 * drop — because the slug becomes a directory a human will one day stare at,
 * and `~/.colo-design/projects/결제/` is findable where `project-2` is not.
 * Every filesystem this ships on stores UTF-8 names.
 *
 * Uniqueness is the caller's set of taken slugs.
 */
function slugify(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 제어 문자가 경로에 못 쓰이게 strip 하는 게 이 정규식의 목적이다.
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "")
      .trim()
      // 점 벗기기는 trim 뒤여야 한다 — " .. " 같은 이름을 trim 전에 벗기면
      // 문자열이 공백으로 시작해 strip 이 비고, slug 가 "." 또는 ".." 로 남아
      // join 이 projects 부모(=~/.colo-design)를 가리키고, 삭제가 전체를
      // 지우는 자리가 된다.
      .replace(/^\.+/, "")
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 32) || "project";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The shape a baseBranch may take. It reaches `git fetch origin <branch>` and
 * `git checkout <branch>` as an argv word, so a wire value that is not a
 * plain refname — a leading `-` reads as a flag, `..` as a range, a space as
 * two words — is refused at the registry boundary instead of at git's.
 */
function isSafeRefname(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes("..");
}

const HANDOFF_STATES: Record<string, true> = {
  open: true,
  changes_requested: true,
  merged: true,
  closed: true,
};

function parseHandoff(raw: unknown): HandoffStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const state = cleanString(value.state);
  const url = cleanString(value.url);
  const branch = cleanString(value.branch);
  if (typeof value.number !== "number" || !url || !branch || !state || !HANDOFF_STATES[state]) {
    return null;
  }
  return {
    number: value.number,
    url,
    branch,
    state: state as HandoffStatus["state"],
    title: cleanString(value.title) ?? "",
  };
}

function parseProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const slug = cleanString(value.slug);
  if (!slug) return null;
  const repo = (value.repo ?? {}) as Record<string, unknown>;
  return {
    slug,
    name: cleanString(value.name) ?? slug,
    ...(typeof value.commandsApproved === "boolean"
      ? { commandsApproved: value.commandsApproved }
      : {}),
    ...(typeof value.instructions === "string" && value.instructions.trim()
      ? { instructions: value.instructions.trim() }
      : {}),
    repo: {
      url: cleanString(repo.url),
      baseBranch: cleanString(repo.baseBranch) ?? DEFAULT_BASE_BRANCH,
      branch: cleanString(repo.branch),
      // A handoff is echoed back as the daemon wrote it. A hand edit that
      // breaks its shape reads as "no open handoff", which is recoverable —
      // 넘기기 simply opens a new pull request.
      handoff: parseHandoff(repo.handoff),
      // D93 후속: the pin anchor rides the same persistence. A hand edit
      // that breaks it reads as "no anchor" — 넘기기 then falls back to the
      // branch's first commit time, which under-reads but never fails.
      ...(typeof repo.commentsSince === "string" && repo.commentsSince
        ? { commentsSince: repo.commentsSince }
        : {}),
    },
  };
}

/** Reads the registry file, tolerating anything a hand edit could do to it. */
function loadProjectsFile(env: NodeJS.ProcessEnv = process.env): ProjectsFile {
  const path = projectsFile(env);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects.map(parseProject).filter((project): project is Project => project !== null)
      : [];
    const active = cleanString(parsed.active);
    return {
      projects,
      active:
        active && projects.some((project) => project.slug === active)
          ? active
          : (projects[0]?.slug ?? null),
    };
  } catch (error) {
    // A file that exists but cannot be read is news, not absence: the next
    // create would atomically REPLACE it and take every project's registry
    // row (clone folders and PR state included) with it. Keep a copy the
    // planner can recover from(설정 → 문제 해결 → 폴더 열기) and start
    // empty — the daemon must still boot. A missing file is the normal
    // first run and needs no ceremony.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      try {
        if (existsSync(path)) copyFileSync(path, `${path}.corrupt`);
      } catch {
        // The backup is best effort — an unwritable disk has bigger
        // problems, and refusing to boot helps nobody.
      }
    }
    return { active: null, projects: [] };
  }
}

function saveProjectsFile(file: ProjectsFile, env: NodeJS.ProcessEnv = process.env): void {
  const path = projectsFile(env);
  mkdirSync(dirname(path), { recursive: true });
  // No secrets live here (the PAT is in the OS store), but the repo urls are
  // still the user's business: same private mode, same atomic replace as the
  // other settings files. The previous good copy stays one rename away —
  // registry rows are the only map to clones and open PRs, so a bad write
  // must never be the last one on disk.
  try {
    if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  } catch {
    // Best effort: the atomic replace below is the real guarantee.
  }
  const temporary = `${path}.colo-design-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

/**
 * The loaded registry: the list, which one is active, and where each one's
 * files are. Every mutation persists immediately — a daemon that dies between
 * a clone and a save would otherwise leave a folder nobody claims.
 */
export class ProjectRegistry {
  private file: ProjectsFile;

  private constructor(
    private readonly env: NodeJS.ProcessEnv,
    file: ProjectsFile,
  ) {
    this.file = file;
  }

  /**
   * Loads the registry, migrating a pre-projects installation on the way in.
   */
  static load(env: NodeJS.ProcessEnv = process.env): ProjectRegistry {
    const loaded = loadProjectsFile(env);
    if (loaded.projects.length > 0) return new ProjectRegistry(env, loaded);
    const migrated = migrateLegacyLayout(env);
    if (migrated) {
      saveProjectsFile(migrated, env);
      return new ProjectRegistry(env, migrated);
    }
    return new ProjectRegistry(env, loaded);
  }

  list(): Project[] {
    return this.file.projects;
  }

  get(slug: string): Project | null {
    return this.file.projects.find((project) => project.slug === slug) ?? null;
  }

  activeSlug(): string | null {
    return this.file.active;
  }

  active(): Project | null {
    return this.file.active ? this.get(this.file.active) : null;
  }

  setActive(slug: string): Project {
    const project = this.get(slug);
    if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${slug}`);
    this.file.active = slug;
    this.save();
    return project;
  }

  /** Registers a new project. */
  create(input: {
    name: string;
    repoUrl: string | null;
    baseBranch?: string;
    commandsApproved?: boolean;
  }): Project {
    const name = input.name.trim();
    if (!name) throw new Error("프로젝트 이름을 입력해 주세요");
    const slug = slugify(name, new Set(this.file.projects.map((project) => project.slug)));
    const baseBranch = input.baseBranch?.trim() || DEFAULT_BASE_BRANCH;
    if (!isSafeRefname(baseBranch)) {
      throw new Error(`브랜치 이름이 올바르지 않습니다: ${baseBranch.slice(0, 64)}`);
    }
    const project: Project = {
      slug,
      name,
      // The gate's whole point: a fresh project is unapproved until the
      // picker says the planner saw the commands. `undefined` never persists
      // from here — only legacy entries carry it.
      commandsApproved: input.commandsApproved === true,
      repo: {
        url: input.repoUrl,
        baseBranch,
        branch: null,
        handoff: null,
        // D93 후속: the first cycle's pins are already this cycle's — the
        // anchor starts at birth so the first 넘기기 reads them all.
        commentsSince: new Date().toISOString(),
      },
    };
    this.file.projects.push(project);
    // The first project is the active one; nothing else could be.
    this.file.active ??= slug;
    this.save();
    return project;
  }

  /** Changes what a project points at. */
  update(
    slug: string,
    changes: {
      name?: string;
      repoUrl?: string | null;
      baseBranch?: string;
      commandsApproved?: boolean;
      instructions?: string | null;
    },
  ): Project {
    const project = this.get(slug);
    if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${slug}`);
    if (changes.name !== undefined) {
      const name = changes.name.trim();
      if (!name) throw new Error("프로젝트 이름을 입력해 주세요");
      project.name = name;
    }
    if (changes.commandsApproved !== undefined) {
      project.commandsApproved = changes.commandsApproved;
    }
    // 지침은 지우개가 있어야 한다: null 은 "없음"이고, 빈 문자열도 없음으로
    // 간다 — 사용자의 상자를 비우고 싶을 때 지워지지 않는 값이 되면 안 된다.
    if (changes.instructions !== undefined) {
      const instructions = changes.instructions?.trim();
      if (instructions) project.instructions = instructions;
      else delete project.instructions;
    }
    if (changes.repoUrl !== undefined) project.repo.url = changes.repoUrl;
    if (changes.baseBranch !== undefined) {
      const baseBranch = changes.baseBranch.trim() || DEFAULT_BASE_BRANCH;
      if (!isSafeRefname(baseBranch)) {
        throw new Error(`브랜치 이름이 올바르지 않습니다: ${baseBranch.slice(0, 64)}`);
      }
      project.repo.baseBranch = baseBranch;
    }
    this.save();
    return project;
  }

  /**
   * Forgets a project. Its folder stays on disk unless asked otherwise — a
   * mis-click must not take saved screen work with it.
   */
  remove(slug: string): void {
    const index = this.file.projects.findIndex((project) => project.slug === slug);
    if (index < 0) throw new Error(`프로젝트를 찾을 수 없습니다: ${slug}`);
    this.file.projects.splice(index, 1);
    if (this.file.active === slug) this.file.active = this.file.projects[0]?.slug ?? null;
    this.save();
  }

  /**
   * Where a project's files live.
   *
   * `COLO_DESIGN_REPO_DIR` overrides the ACTIVE project's clone root and
   * nothing else. That is how the offline suites keep driving fixture
   * remotes: they run one project, it is the active one, and the path they
   * prepared is the path it uses.
   */
  paths(slug: string): ProjectPaths {
    const root = join(projectsRoot(this.env), slug);
    const activeOverride = slug === this.file.active;
    const repoOverride = activeOverride ? this.env.COLO_DESIGN_REPO_DIR : undefined;
    return {
      root,
      repoRoot: repoOverride ?? join(root, "repo"),
    };
  }

  /**
   * The remote the active project's workspace should actually talk to.
   *
   * `COLO_DESIGN_REPO_URL` wins over the registry for the ACTIVE project, the
   * same rule the path override follows. It is how the offline suites point a
   * project at a fixture remote — and it has to be applied HERE rather than
   * written into the registry, because the registry is what `update()`
   * persists and a test's fixture url must never survive into a real config.
   */
  resolvedRepo(slug: string): ProjectRepo {
    const project = this.get(slug);
    if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${slug}`);
    const override = slug === this.file.active ? cleanString(this.env.COLO_DESIGN_REPO_URL) : null;
    return override ? { ...project.repo, url: override } : project.repo;
  }

  /**
   * Records where a project's work cycle stands. Called by the repo workspace
   * whenever a branch is created or a pull request moves — the registry is
   * the only thing that survives a restart, and a re-clone must not lose track
   * of a PR somebody is already reviewing.
   */
  setCycle(
    slug: string,
    cycle: { branch: string | null; handoff: HandoffStatus | null; commentsSince?: string | null },
  ): void {
    const project = this.get(slug);
    if (!project) return;
    project.repo.branch = cycle.branch;
    project.repo.handoff = cycle.handoff;
    if (cycle.commentsSince !== undefined) {
      project.repo.commentsSince = cycle.commentsSince ?? undefined;
    }
    this.save();
  }

  /** Creates the project's folders; callers clone into them. */
  ensureDirs(slug: string): ProjectPaths {
    const paths = this.paths(slug);
    mkdirSync(dirname(paths.repoRoot), { recursive: true });
    return paths;
  }

  private save(): void {
    saveProjectsFile(this.file, this.env);
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Turns a pre-projects installation into the single project it always was.
 *
 * Two shapes arrive here. A real installation has `~/.colo-design/repo`, and
 * that folder MOVES into `projects/default/`. A test (or a dev pointing the
 * daemon at scratch dirs) has `COLO_DESIGN_REPO_DIR` set, and nothing moves at
 * all: `paths()` keeps handing the active project exactly that directory.
 *
 * Migration reads only sources in the SAME configuration scope as the
 * registry it is filling. A run that redirected the registry
 * (`COLO_DESIGN_PROJECTS_SETTINGS`, which every offline suite sets) must not
 * inherit the developer's real `~/.colo-design` — that once produced a scratch
 * daemon that warm-started a clone of the developer's own remote and reported
 * a project nobody in that run had created.
 *
 * Returns null when there is nothing to migrate, which is what a genuinely
 * first run looks like.
 */
function migrateLegacyLayout(env: NodeJS.ProcessEnv): ProjectsFile | null {
  const scoped =
    env.COLO_DESIGN_PROJECTS_SETTINGS !== undefined || env.COLO_DESIGN_PROJECTS_DIR !== undefined;
  const legacyRepo = env.COLO_DESIGN_REPO_DIR ?? (scoped ? null : join(COLO_DESIGN_DIR, "repo"));
  const repoUrl = env.COLO_DESIGN_REPO_URL ?? legacyRepoUrl(env, scoped);

  const hasRepo = (legacyRepo !== null && existsSync(legacyRepo)) || repoUrl !== null;
  if (!hasRepo) return null;

  const target = join(projectsRoot(env), LEGACY_SLUG);
  // With the env override in play the legacy path IS the project's path;
  // moving it would break the very run that set it.
  if (!env.COLO_DESIGN_REPO_DIR && legacyRepo && existsSync(legacyRepo)) {
    moveInto(legacyRepo, join(target, "repo"));
  }

  return {
    active: LEGACY_SLUG,
    projects: [
      {
        slug: LEGACY_SLUG,
        name: "내 프로젝트",
        repo: {
          url: repoUrl,
          baseBranch: DEFAULT_BASE_BRANCH,
          branch: null,
          handoff: null,
          // D93 후속: the migrated project's first cycle begins here.
          commentsSince: new Date().toISOString(),
        },
      },
    ],
  };
}

/** The url the old single-repo settings file held, if it still exists. */
function legacyRepoUrl(env: NodeJS.ProcessEnv, scoped: boolean): string | null {
  const file = env.COLO_DESIGN_REPO_SETTINGS ?? (scoped ? null : join(CONFIG_DIR, "repo.json"));
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return cleanString(parsed.url);
  } catch {
    return null;
  }
}

/**
 * Moves a legacy folder under the project. A rename across devices fails on
 * some setups (a home directory on a different volume than a symlinked
 * `~/.colo-design`); there the migration is skipped rather than half-copied, and
 * the project starts empty — a re-clone, not a loss, because the folder is
 * reproducible from its remote.
 */
function moveInto(from: string, to: string): void {
  if (existsSync(to)) return;
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  } catch {
    // Left in place; the project re-clones on first use.
  }
}
