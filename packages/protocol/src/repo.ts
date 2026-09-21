// ---------------------------------------------------------------------------
// 코멘트 저장소 (PLAN D57)
// ---------------------------------------------------------------------------

/**
 * One row of the project's `comments.json`. The store's reader is the pull
 * request body (`buildCommentsSection`): the planner's pins are consumed in
 * the conversation, so nothing in the tool lists them again — the developer,
 * who never sees that conversation, reads them as `### 수정 요청`.
 */
export interface CommentItem {
  /**
   * The pin's overlay UUID when the send carried one (커미티 2차 판정 5) —
   * the tray, the badge, the marker item and this row meet on it. Older
   * sends mint a row id instead, as rows always did.
   */
  id: string;
  /** The screen the pin sat on, as the overlay's envelope named it. */
  screen: string;

  /** What the planner wrote on this pin — empty means no memo was written. */
  text: string;
  /** The commented element's own text, as the overlay captured it. */
  elementText: string;
  /**
   * Where the pin sat (PLAN D78) — the recorded pin's anchor. Old rows and
   * anchorless comments have no `element`; they read as 자리 없는 코멘트.
   */
  element?: {
    component: string;
    path: string;
    rect: { x: number; y: number; width: number; height: number };
  };
  /**
   * What the planner asked of this pin (재설계 C10): absent reads as
   * `change` — rows written before the field existed were all changes, or
   * were titled as one.
   */
  intent?: "change" | "question";
  /** When the row was written, ISO 8601. */
  at: string;
  /**
   * Delivered mark. Every row is now written resolved — the send IS the
   * delivery — and nothing reads it as a work state any more; the field
   * survives because stores written before 자동 정리 carry it.
   */
  resolved: boolean;
}

// ---------------------------------------------------------------------------
// Connected repo workspace
// ---------------------------------------------------------------------------

/**
 * Lifecycle of the connected repo clone:
 * `missing → cloning → pulling → installing (when needed) → starting → ready`,
 * with `error` reachable from every working phase.
 */
export type RepoPhase =
  | "missing"
  | "cloning"
  | "pulling"
  | "installing"
  | "starting"
  | "ready"
  | "error";

/**
 * A pull request the planner handed to a developer (PLAN D5).
 *
 * The planner never sees the words "브랜치" or "PR": the UI reads `state` as
 * 넘김 / 변경 요청 / 반영됨. The url is here so the developer's link can be
 * copied out, not so the planner has to follow it.
 */
export interface HandoffStatus {
  number: number;
  url: string;
  title: string;
  /** `changes_requested` is a review verdict, not a PR state; GitHub reports both. */
  state: "open" | "changes_requested" | "merged" | "closed";
  /** Branch the PR is from — the same one 저장 pushes to. */
  branch: string;
  /**
   * 리뷰어 보고 (커미티 2026-09-15): the logins GitHub reports as
   * `requested_reviewers` — the repo's CODEOWNERS·team rules filled them, not
   * this tool. Empty means the repo auto-assigns nobody; the planner is told
   * to carry the link themselves. Absent on older fixtures reads as "unknown"
   * (`undefined`), which the UI treats like empty.
   */
  reviewers?: string[];
}

/**
 * One screen capture riding a 넘기기 (PLAN D56). The daemon's server opens
 * each pinned screen·state in the preview driver — a desktop host injects
 * one; the browser dev path has none — and hands the captures to the
 * workspace, which commits them under `.colo-design/shots/` and links them
 * from the pull request body's `### 화면 미리보기` section.
 */
export interface HandoffShot {
  /** Route the screen is served at — the pin's pathname id, slash-restored. */
  route: string;

  /** The capture's bytes; `Buffer` on the daemon side, `Uint8Array` here. */
  image: Uint8Array;
  /**
   * The extension the bytes really are, leading dot included (`.webp`). The
   * driver picks the encoder, so the committed file must be named after what
   * it holds — a capture written as `.png` while holding something else is a
   * file browsers only render by sniffing.
   */
  extension: string;
}

export type RepoErrorKind =
  | "clone"
  | "install"
  | "registry-auth"
  | "pnpm-missing"
  | "preview"
  | "port-undetected"
  | "no-preview-command"
  | "conflict"
  | "commands";

export interface RepoStatus {
  /** Absolute path of the clone on this machine. */
  root: string;
  phase: RepoPhase;
  /** Last progress line while working, or the reason for `error`. */
  detail: string | null;
  /**
   * Why the clone is in `phase: "error"` — decided at the failure site by the
   * daemon, so the UI routes a fix without sniffing `detail` text (PLAN D41).
   */
  errorKind?: RepoErrorKind | null;
  /**
   * The commands the clone resolved to (PLAN D37) — derived from the repo's
   * lockfile and `package.json` scripts. The transcript matches a Bash call
   * against these to say `검사 실행` instead of printing the command line.
   */
  commands?: {
    install?: string;
    check?: string;
    build?: string;
    preview?: string;
  };
  /** Preview origin once the preview port accepts connections. */
  previewUrl: string | null;
  /** The port the preview is serving on — detected at startup. */
  previewPort: number | null;
  /**
   * Which server process answers at `previewUrl` — a new number every time
   * the preview is started. The desktop keeps a page per preview across
   * project switches; a page loaded under an earlier epoch is stale (the
   * server was restarted, or the port fence handed the port to another
   * project) and reloads instead of trusting what it kept.
   */
  previewEpoch: number | null;
  /** Configured remote url, without any embedded credentials. */
  url: string | null;
  /**
   * The `colo-design/…` branch this cycle's work lives on, or `null` before the
   * first 저장 of a cycle. The base branch is never checked out for writing.
   */
  branch: string | null;
  /** What a handoff PR would target, from the project's registry entry. */
  baseBranch: string;
  /** The open (or just-merged) pull request, once 넘기기 has run. */
  handoff: HandoffStatus | null;
  /**
   * 아직 커밋되지 않은 파일 수 (PLAN D8).
   *
   * Counted with one `git status --porcelain` when a 화면 turn settles and when
   * a save finishes — never on a timer. 자동 저장(P2-1) 뒤로 이 수는 턴이 도는
   * 동안과 커밋이 걸린 순간에만 0 이 아니다.
   *
   * 파일 **목록**(`changedFiles`)은 선로에서 빠졌다 — 그것을 그리던 변경 점
   * 스트립이 사라져 읽는 화면이 하나도 없다. 데몬 안에는 남아 재검수의
   * 같음 비교에 쓰인다.
   */
  pendingChanges: number;
  /**
   * 치워둔 작업 — null when the slot is empty. While it is filled the
   * `변경 없음` chip must not exist: parked is a state, not an absence
   * (보관함 토론 — 분실은 가시성 부재로 시작된다).
   */
  shelf: RepoShelf | null;
}

/**
 * One developer comment (PLAN D88), as 상태 확인 lists it: an inline code
 * comment or a review body — the 답하기 endpoint differs, so the kind rides
 * along. `path`·`line` are the developer's own location words; the card's
 * 자세히 is where they show (D37·D38).
 */
export interface DeveloperReview {
  id: number;
  kind: "inline" | "review";
  author: string;
  body: string;
  pr: number;
  path?: string;
  line?: number;
  at: string;
}

/** `repo.handoffStatus` — the pull request plus the developer's comments. */
export interface HandoffStatusReport extends HandoffStatus {
  reviews?: DeveloperReview[];
}

/**
 * `repo.handoffPreview` — the handed-off moment's REAL build: the open
 * handoff's branch tip checked out into a throwaway
 * worktree and served by the repo's own preview command on a second port.
 * `ready: false` is the honest answer for every absence — no open handoff,
 * a worktree that would not check out, a server that would not come up —
 * and the frozen stage falls back to the committed capture. It is not an
 * error: the capture is the feature's floor, not a failure.
 */
export interface HandoffPreviewInfo {
  /** The port the worktree's preview answers on; null while not serving. */
  port: number | null;
  /** True once the worktree's server actually answers on that port. */
  ready: boolean;
  /** The tip the worktree was checked out at — '넘긴 시점'의 커밋. */
  commit: string | null;
  /**
   * The exact loopback address the server answered on — a port alone cannot
   * say which loopback family bound it, and a framed page needs the URL.
   * Null while not serving.
   */
  url: string | null;
  /** Why there is no build, in the planner's words. Absent while serving. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Publish path (diff review → gates → commit → push)
// ---------------------------------------------------------------------------

/** One `@@ …` block of a file's unified diff, header line included. */
export interface DiffHunk {
  header: string;
  lines: string[];
}

export interface DiffFile {
  /** Path relative to the repo root, forward slashes. */
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Hunk bodies; empty for binary files. */
  hunks: DiffHunk[];
  /** True when git reported the file as binary; no hunks to show. */
  binary?: boolean;
}

/**
 * 저장하지 않은 변경 한 줄 — the 변경 점 strip's row. The same recount that
 * fills `RepoStatus.pendingChanges`, listed beside it so the chip's number
 * and the strip's rows can never disagree. No hunks: the full `DiffFile[]`
 * stays behind `diff.get`, which reads it only when someone opens a review.
 */
export interface ChangedFileLite {
  /** Path relative to the repo root, forward slashes. */
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /**
   * ± counts against HEAD. Null where git cannot count without reading
   * content: untracked files, renames, binaries — the row shows its word
   * and stays quiet about size instead of guessing one.
   */
  added: number | null;
  removed: number | null;
}

/** Where a 저장 or a 넘기기 stands. Broadcast as `diff.status` while it moves. */
export interface DiffStatus {
  stage: "computing" | "pushing" | "published" | "handing-off" | "handed-off" | "failed";
  /**
   * Which gate failed. The repo's own `check`/`build` commands are not gates
   * anymore — a 저장 or 넘기기 never runs them; problems land in the PR.
   */
  gate?: "commit" | "push" | "diff" | "pr";
  /**
   * Why a gate failed, when the tool already knows it is NOT Claude's to fix
   * (리뷰 C5): `push-auth` = the push was refused over credentials, so the
   * next move is the planner's token in 설정 — a turn would spin. Optional;
   * absent, the UI keeps the generic failed line.
   */
  reason?: "push-auth";
  /** Progress line, or the failing command's output tail when `failed`. */
  detail?: string | null;
  /** The saved commit sha, once `stage === "published"`. */
  commit?: string | null;
  /**
   * The commit message a 저장 actually used — the planner's memo verbatim,
   * or the one the machine turn wrote when the memo was empty (비개발자
   * 저장: the button alone must be enough, but what was written in their
   * name is still theirs to read). Present once `stage === "published"`.
   */
  message?: string | null;
  /** The pull request, once `stage === "handed-off"`. */
  handoff?: HandoffStatus | null;
}

// ---------------------------------------------------------------------------
// 넘기기 (비개발자 넘기기)
// ---------------------------------------------------------------------------

/** `repo.handoffDraft` — what the 넘기기 dialog opens filled with. */
export interface RepoHandoffDraft {
  /** One line for the pull request title. Empty when the machine turn could not answer. */
  title: string;
  /**
   * What was built and what to look at, in the planner's words — the prose
   * half of the body. The screen list under it stays the browser's, because
   * routes and states are mechanical facts, not a sentence to compose.
   */
  body: string;
  /**
   * 미리보기의 자동 첨부 (비개발자 넘기기): the sections the daemon appends to
   * the pull request body on its own — the planner's pin history as
   * `### 수정 요청`, the cycle branch's own numstat as `### 바뀐 파일`, and
   * the count of screen captures that ride along as `### 화면 미리보기`.
   * The dialog shows them so what the developer receives is never a
   * surprise; `null`/`0` means that section does not ship.
   */
  extras?: {
    commentsSection: string | null;
    /** `### 바뀐 파일` — the same string the body carries, or null. */
    filesSection: string | null;
    shotCount: number;
  };
  /** Who wrote it: the machine turn (machine-provider 의 담당), or nothing at all. */
  source: "machine" | "fallback";
}

/**
 * The pull request body a 넘기기 sends when the planner leaves the field
 * blank (비개발자 넘기기) — the daemon's fallback, shared so the dialog's
 * preview shows the same sentence the developer will read.
 */
export const DEFAULT_HANDOFF_BODY = "Colo Design에서 만든 화면입니다. 로직만 붙이면 됩니다.";

/** One saved point in `repo.history` (PLAN D53). */
export interface RepoHistoryEntry {
  sha: string;
  /** The planner's own 저장 memo, verbatim. */
  message: string;
  /** Committer time, ISO 8601. */
  at: string;
  /** Files the save carried, relative to the repo root. */
  files: string[];
}

/** `repo.history` — the cycle's saves, newest first (PLAN D53). */
export interface RepoHistory {
  /** What the entries are counted against, e.g. `origin/main`. */
  base: string;
  entries: RepoHistoryEntry[];
}

export interface RepoDiscard {
  /** Unsaved changes that were thrown away, relative to the repo root. */
  removed: string[];
}

/**
 * 치워둔 작업 (보관함 토론 2026-09-15): ONE slot, no names to manage — the
 * third door between 저장 (public, permanent) and 버리기 (gone). The work
 * lives in a ref of the tool's own (`refs/colo-design/shelf`), never a git
 * stash, so the refresh's transit stash machinery cannot touch it.
 */
export interface RepoShelf {
  /** When the work was parked, ISO 8601. */
  at: string;
}

/** `repo.unshelve` — what the 꺼내기 landed, named for the planner to read. */
export interface RepoShelfRestore {
  /** Paths the re-apply touched, relative to the repo root. */
  applied: string[];
}
