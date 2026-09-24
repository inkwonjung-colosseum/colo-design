// 저장 → 개발자에게 넘기기 → 반영됨: the publish cycle (PLAN D5[넘기기]).
// Owns the in-flight cycle's handoff bookkeeping and the review replies.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ChatEvent,
  type DeveloperReview,
  type DiffFile,
  type DiffStatus,
  type HandoffShot,
  type HandoffStatus,
  type HandoffStatusReport,
  markTurn,
} from "@colo-design/protocol";
import { readComments } from "./comments.js";
import { buildCommentsSection, buildFilesSection } from "./handoff-body.js";
import type { RepoCore } from "./repo-core.js";
import {
  BRANCH_PREFIX,
  DEFAULT_COMMIT_MESSAGE,
  DEFAULT_HANDOFF_TITLE,
  detailOf,
  GATE_BRIEF,
  GATE_STEP,
  PUSH_AUTH_FAILURE,
  SAVE_CONFLICT_OPEN_DETAIL,
  SHOTS_COMMIT_MESSAGE,
  SHOTS_DIR,
} from "./repo-core.js";

/** The `<img>` needs a media type; the committed file's extension is the
 *  capture's own (see HandoffShot.extension). */
const SHOT_MEDIA_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

/**
 * 사이클 브랜치 이름 — 로컬 날짜로 짓는다(PLAN L4 · 단계 0). UTC 였을 때 아침
 * 9시 전의 이름이 어제 날짜로 남았다: 하루의 경계는 기계의 시간대가 아니라
 * 사용자의 것이다. 순수 함수 — 시험이 자정 경계를 직접 만든다.
 */
export function cycleBranchName(date: Date, n: number): string {
  const yyyymmdd = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
  return `${BRANCH_PREFIX}/${yyyymmdd}-${n}`;
}

/**
 * 레지스트리가 기억하는 사이클 브랜치로 HEAD 를 맞춘다(PLAN L4 · 단계 0).
 * 이름이 있어도 돌려주기만 하면 재시작 등으로 HEAD 가 딴 곳에 있을 때 저장이
 * 딴 브랜치에 커밋되고 그 이름으로 푸시됐다. 로컬에 있으면 checkout, 원격
 * 추적 ref 만 있으면 checkout -b <name> origin/<name>, 둘 다 없으면 지금
 * HEAD 에서 checkout -b. GitRun 계약((args) => stdout)으로 시험이 실제
 * 임시 저장소를 돌린다.
 */
export async function alignCycleBranch(
  git: (args: string[]) => Promise<string>,
  name: string,
): Promise<string> {
  // -q: detached HEAD 는 조용히 빈손 — 그대로 아래 맞춤으로 간다.
  const head = await git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
  if (head.trim() === name) return name;
  const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).catch(
    () => "",
  );
  const remote = await git([
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${name}`,
  ]).catch(() => "");
  try {
    if (local.trim() !== "") await git(["checkout", name]);
    else if (remote.trim() !== "") await git(["checkout", "-b", name, `origin/${name}`]);
    else await git(["checkout", "-b", name]);
  } catch (error) {
    // 한국어 한 문장이 먼저 나가고 git 의 말이 뒤따른다 — 호출자(runSave)는
    // failGate("commit") 으로 이 문장을 사람과 AI 에게 넘긴다.
    throw new Error(`작업 브랜치(${name})로 돌아가지 못했습니다 — ${detailOf(error, null)}`);
  }
  return name;
}

/**
 * A route becomes part of a committed filename: separators and `..` would
 * let it walk out of `.colo-design/shots/` (or simply fail to match on
 * read-back). Korean stays — the route keeps its own words.
 */
function shotNamePart(value: string): string {
  return value
    .replace(/[/\\]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^\.+/, "");
}

export class PublishCycle {
  constructor(
    private readonly core: RepoCore,
    private readonly deps: PublishDeps,
  ) {}

  /** 내려앉을 사이클의 끝이 밀려 있는가 — 폴링이 같은 알림을 반복하지 않게. */
  get landingDue(): boolean {
    return this.endedHandoff !== null;
  }

  /** D88: the developer comments the last 상태 확인 read — 답하기 resolves ids against this. */
  private lastReviews: DeveloperReview[] = [];
  /**
   * hero-synthesis D1: ids the daemon has already SEEN, for `review.arrived`.
   * `null` until the first successful read — a daemon that just booted must
   * not announce every old comment as new (the poll's own count guard makes
   * the same call for notices).
   */
  private knownReviewIds: Set<number> | null = null;

  /**
   * 커미티 2026-09-15 판정 1·2: 폴링이 **읽어서 본** 사이클의 끝(반영됨·반려).
   * 칩에는 아직 반영하지 않는다 — 끝을 칩에만 적고 착지를 미루면 `this.core.branch`
   * 가 살아 있어 다음 저장이 이미 닫힌 브랜치로 푸시된다(ensureCycleBranch 가
   * 이름이 있으면 그대로 쓴다). 그래서 끝은 여기 따로 세워 두고, 사람이 있는
   * 자리(상태 확인 · 프로젝트 활성화 · 다음 저장의 머리)에서만 내려앉힌다.
   */
  private endedHandoff: HandoffStatus | null = null;

  async runSave(options: {
    message?: string;
    onSessionTurn?: (brief: string) => void;
    /** hero-synthesis D1: the conversation this save belongs to. */
    sessionId?: string;
    /**
     * P2-1 자동 저장의 푸시 — 백그라운드(실패 무시). 커밋은 로컬에 끝난 것으로
     * 저장이 성립하고, 푸시는 조용히 따라간다: 오프라인에서도 턴의 끝이 멈추지
     * 않게. 밀린 커밋은 제출(넘기기)이 기다렸다 민다 — 푸시 실패를 게이트로
     * 올리는 길은 제출 쪽뿐이다.
     */
    backgroundPush?: boolean;
  }): Promise<DiffStatus> {
    if (!this.core.isCloned()) {
      return this.core.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "연결 레포가 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.",
      });
    }
    // 저장은 차선의 save 칸 안에서 돈다(PLAN L1) — 최신화·치워두기와의 순서는
    // 차선이 지키므로 손으로 슬롯을 기다리던 자리는 없다. 몸통의 diff 는
    // 재진입으로 곧바로 읽힌다.

    // 저장 직전 가드 (커미티 2026-09-15 판정 1): 기획자가 `상태 확인`을 한 번도
    // 누르지 않아도, 이미 반영되거나 반려된 요청의 브랜치에 커밋이 쌓이는 일은
    // 없어야 한다. 읽기와 착지를 여기서 한 번에 치른다 — 사람이 저장을 눌렀으니
    // 사람 있는 자리이고(되돌리기 기록이 조용히 지워지지 않는다), 끝난 사이클은
    // 여기서 닫혀 아래 ensureCycleBranch 가 새 브랜치를 연다. 실패는 저장을
    // 막지 않는다 — 네트워크가 없다고 저장을 막을 이유는 없다.
    if (this.core.openHandoff || this.endedHandoff) await this.refreshHandoff().catch(() => null);

    // A conflict left for the agent is not a save's ingredient: the unmerged
    // files count as changes awaiting 저장, and staging exactly the approved
    // paths would make git conclude the open merge (or, after a stash-pop
    // fight, commit) with the markers themselves baked in — then push them
    // to the cycle branch. The door reopens when the brief's cleanup lands.
    if ((await this.core.mergeInProgress()) || (await this.core.conflictedFiles()).length > 0) {
      return this.core.setDiff({
        stage: "failed",
        gate: "diff",
        detail: SAVE_CONFLICT_OPEN_DETAIL,
      });
    }

    this.core.setDiff({ stage: "computing" });
    const files = await this.core.diff();
    const approved = files.map((file) => file.path);
    /**
     * 올리기에서 멈춘 저장의 재시도 (비개발자 저장 검토): a save whose commit
     * landed and whose push did not leaves a CLEAN worktree with cycle
     * commits the remote never got. Read as "저장할 변경사항이 없습니다" that
     * state stranded the work — the review told the planner to go make
     * screens while their finished work sat unpushed, and the push-auth
     * card's own "다시 저장해 주세요" could not be obeyed. Pressing 저장
     * there means the one thing left to do: push what is already committed.
     * The branch's own remote ref is the yardstick when it exists; a first
     * push that never landed leaves none, so the base is.
     */
    let retryPush = false;
    let retryFiles: string[] = [];
    if (approved.length === 0 && this.core.branch) {
      const onRemote = (
        await this.core
          .git(["rev-parse", "--verify", `refs/remotes/origin/${this.core.branch}`])
          .catch(() => "")
      ).trim();
      const range = onRemote
        ? `origin/${this.core.branch}..${this.core.branch}`
        : `origin/${this.core.baseBranch}..${this.core.branch}`;
      const waiting = (await this.core.git(["rev-list", "--count", range]).catch(() => "")).trim();
      retryPush = Number(waiting) > 0;
      // A push retry carries no fresh diff — the saved card names the files
      // the waiting commits already hold.
      if (retryPush) {
        retryFiles = (
          await this.core
            .git(["-c", "core.quotepath=false", "diff", "--name-only", range])
            .catch(() => "")
        )
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean);
      }
    }
    if (approved.length === 0 && !retryPush) {
      // 이미 저장된 것의 다시 저장 (2026-09-21 실사): 성공한 저장 직후에 도는
      // 두 번째 저장 — 다시 누르기, 칩 카운트가 늦게 닫힌 창, 리뷰 정산 저장과
      // 손 저장의 경주 — 는 깨끗한 트리를 읽는다. 그것을 실패로 보내면 방금
      // 저장한 사람에게 "먼저 화면을 만들거나 고쳐 주세요" 가 뜬다. 사이클
      // 브랜치가 존재하고 밀릴 커밋도 없다는 것은 전부 저장돼 있다는 뜻이므로,
      // 저장은 멱등한 no-op 성공으로 끝난다 — 메모 턴도 커밋도 푸시도, 테이프
      // 카드의 재사도 없다. 실패는 한 번도 저장된 적 없는 깨끗한 트리에만 남는
      // 다 — 거기서만 이 안내가 참이다.
      if (this.core.branch) {
        const tip = (
          await this.core.git(["rev-parse", "--verify", this.core.branch]).catch(() => "")
        ).trim();
        if (tip) {
          const savedMessage = (
            await this.core.git(["log", "-1", "--pretty=%s", this.core.branch]).catch(() => "")
          ).trim();
          return this.core.setDiff({ stage: "published", commit: tip, message: savedMessage });
        }
      }
      // 이 실패만은 AI 에게 갈 브리프가 없다(failGate 의 게이트와 달리 사람
      // 안내의 문제) — 배너는 리로드와 함께 사라지므로, 누른 손이 무엇에
      // 막혔는지를 테이프의 한 줄로 남긴다(cycle.saveBlocked, 베타 테스트 B6).
      const detail = "저장할 변경사항이 없습니다 — 먼저 화면을 만들거나 고쳐 주세요.";
      // 나가는 문 (PLAN L1): 사이클 사건은 세션 테이프 · 방송으로 이어진다.
      this.core.lane.outside(() =>
        this.deps.onCycleEvent?.(
          { kind: "cycle.saveBlocked", at: new Date().toISOString(), detail },
          options.sessionId,
        ),
      );
      return this.core.setDiff({ stage: "failed", gate: "diff", detail });
    }

    // 비개발자 저장: an empty memo is not a question the planner must answer
    // before saving — the memo turn reads the diff and writes one sentence,
    // and the default message still catches a turn that cannot land (no
    // CLI, timeout, refusal). Whatever is committed is announced back on
    // the published status, so nothing is written in their name unseen.
    // A push retry writes no commit, so it asks for no memo turn: `null`
    // is what "nothing to commit here" means below.
    const memo = retryPush
      ? null
      : options.message?.trim() ||
        (await this.deps.machineMemo(files).catch(() => null)) ||
        DEFAULT_COMMIT_MESSAGE;

    // Commit exactly the paths the planner approved — never `git add -A`, so
    // unreviewed output cannot ride along in the save.
    this.core.setDiff({ stage: "pushing" });
    // 브랜치 준비와 커밋은 push 와 다른 단계다 — 둘을 한 gate 로 보내면
    // 커밋 실패의 원인을 "올리기" 에서 찾게 된다.
    let branch: string;
    try {
      branch = await this.ensureCycleBranch();
      if (memo !== null) await this.commitApproved(memo, approved);
    } catch (error) {
      return this.failGate("commit", error, options.onSessionTurn);
    }
    // 푸시 단계(P2-1): 자동 저장은 백그라운드 — 커밋이 로컬에 있으면 저장은
    // 끝난 것이고, 원격 백업은 되는 대로 따라간다. 실패를 기다리는 것은 제출의
    // 몫이니 여기선 삼킨다(밀린 커밋은 넘기기가 민다).
    if (options.backgroundPush === true) {
      // D6: 백그라운드 푸시도 바로 포기하지 않는다 — 30 초 간격 세 번. 턴의
      // 끝이 오프라인 때문에 밀리지 않게 실패를 삼키던 자리(P2-1)에 조용한
      // 재시도가 대신 선다. 세 번 다 지나면 제출이 기다려서 민다 — 제출만이
      // 푸시 실패를 게이트로 올리는 유일한 길이다.
      // 차선 밖으로 내보내 띄운다(PLAN L1): 저장 작업의 문맥 안에 남으면 각
      // 시도가 재진입 즉시실행이 되어 줄을 비켜간다 — 시도 하나는 push 작업
      // 하나로 다시 줄에 서야 한다.
      void this.core.lane.outside(() => this.retryBackgroundPush(branch));
    } else {
      try {
        await this.core.git(["push", "--set-upstream", "origin", branch]);
      } catch (error) {
        return this.failGate("push", error, options.onSessionTurn);
      }
    }

    const commit = (await this.core.git(["rev-parse", "HEAD"])).trim();
    // The worktree is clean now; the chip moves off unsaved on this.
    await this.core.refreshPendingChanges();
    const message =
      memo ?? (await this.core.git(["log", "-1", "--pretty=%s"]).catch(() => "")).trim();
    const status = this.core.setDiff({ stage: "published", commit, message });
    // hero-synthesis D1: the save lands on the session tape — a reloaded
    // window replays the quiet marker instead of losing it with `diffStatus`.
    this.core.lane.outside(() =>
      this.deps.onCycleEvent?.(
        {
          kind: "cycle.saved",
          at: new Date().toISOString(),
          commit,
          message,
          files: approved.length > 0 ? approved : retryFiles,
        },
        options.sessionId,
      ),
    );
    return status;
  }

  /**
   * The branch this cycle belongs on, checked out and created if this is the
   * first save since the last handoff was merged.
   *
   * `<YYYYMMDD>-<n>` rather than a name derived from the work: the planner
   * never reads it, and a title mined from the diff would be one more place a
   * rename could break. `n` walks up until neither the remote NOR the local
   * clone has such a branch, so two machines on one project cannot collide —
   * and a name the local clone still holds (원격은 지웠는데 로컬에 남은) is
   * not handed to `checkout -b`, which would refuse it (PLAN L4).
   */
  async ensureCycleBranch(): Promise<string> {
    if (this.core.branch) {
      // 이름이 있다는 것과 HEAD 가 거기 있다는 것은 다르다(PLAN L4 · 단계 0):
      // 재시작이 HEAD 를 어디에든 남겨 둔다. 돌려주기 전에 맞춘다 — repo.ts 의
      // 되돌리기 주석이 기대하는 바로 그 동작이다.
      return alignCycleBranch((args) => this.core.git(args), this.core.branch);
    }

    const today = new Date();
    let name = cycleBranchName(today, 1);
    for (let n = 1; n <= 99; n += 1) {
      name = cycleBranchName(today, n);
      // An empty ls-remote line means nobody has taken it. A remote that
      // cannot be reached is not a reason to refuse the save: the push right
      // after this will report the real problem, with git's own words.
      const takenRemote = await this.core
        .git(["ls-remote", "--heads", this.core.url ?? "origin", name])
        .catch(() => "");
      if (takenRemote.trim() !== "") continue;
      // 로컬 브랜치에도 없어야 한다(PLAN L4 · 단계 0): 로컬만 남은 이름을
      // 고르면 아래 `checkout -b` 가 그 이름을 거절한다.
      const takenLocal = await this.core
        .git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])
        .catch(() => "");
      if (takenLocal.trim() === "") break;
    }

    // `-b` 이지 `-B` 가 아니다(PLAN L4 · 단계 0): 위 고르기가 로컬 · 원격
    // 어느 쪽에도 없음을 확인한 이름만 여기 온다 — 실수로 같은 이름의 로컬
    // 브랜치를 덮어쓰는 문은 아예 닫는다.
    await this.core.git(["checkout", "-b", name]);
    // D84 + 커미티 2026-09-15 판정 2: 끝난 사이클의 넘김(반영됨·반려)은 그
    // 사이클의 것이다. 들고 오면 다음 넘기기가 이미 끝난 요청을
    // `updatePullRequest` 로 덮어쓰고(닫힌 요청이면 닫힌 채 제목·본문만 바뀐다),
    // 칩은 반영됨·반려를 말하는 채로 변경만 쌓인다. 새 사이클은 그 기록을
    // 저장소에 두고 시작한다.
    const ended =
      this.core.openHandoff?.state === "merged" || this.core.openHandoff?.state === "closed";
    this.core.setCycle(name, ended ? null : this.core.openHandoff);
    return name;
  }

  async runHandoff(options: {
    title?: string;
    body?: string;
    shots?: HandoffShot[];
    onSessionTurn?: (brief: string) => void;
    /** hero-synthesis D1: the conversation this handoff belongs to. */
    sessionId?: string;
    /** D93: the project's comment store, for the PR body. */
    commentsFile?: string;
  }): Promise<DiffStatus> {
    const branch = this.core.branch;
    if (!this.core.isCloned() || !branch) {
      return this.core.setDiff({
        stage: "failed",
        gate: "pr",
        detail: "넘길 변경사항이 없습니다 — 먼저 저장해 주세요.",
      });
    }
    // 넘기기도 차선의 submit 칸 안에서 돈다(PLAN L1) — 순서는 차선이 지킨다.
    // Two different problems with two different fixes: a repo that is not on
    // GitHub needs a different url, a repo with no token needs a token. One
    // sentence covering both leaves the planner guessing which.
    const slug = this.core.repoSlug();
    if (!slug) {
      return this.core.setDiff({
        stage: "failed",
        gate: "pr",
        detail:
          "GitHub 레포가 아니라 개발자에게 넘길 수 없습니다 — 프로젝트의 레포 주소를 확인해 주세요.",
      });
    }
    const client = this.core.gitHubClient?.() ?? null;
    if (!client) {
      return this.core.setDiff({
        stage: "failed",
        gate: "pr",
        detail: "개인 액세스 토큰이 없습니다 — 설정에서 연결 레포 토큰을 넣어 주세요.",
      });
    }

    this.core.setDiff({ stage: "handing-off" });
    const title = options.title?.trim() || DEFAULT_HANDOFF_TITLE;
    let body = options.body ?? "";
    // P1-3: 작성자 줄 — 요청은 봇 계정으로 열리므로 이름이 없으면 개발자가 누구
    // 작업인지 모른다. 본문 서두 다음, `### 바뀐 파일` 절보다 앞에 인용문 한 줄로.
    const author = this.core.authorName?.();
    if (author) body = `${body.replace(/\n*$/, "")}\n\n> 작성: ${author}`;
    // developer reads the scale before opening the Files tab, and the
    // preview card shows this same string so nothing is promised that does
    // not ship. A range that will not diff costs only the section.
    try {
      const filesSection = buildFilesSection(
        await this.core.git([
          "-c",
          "core.quotepath=false",
          "diff",
          "--numstat",
          `origin/${this.core.baseBranch}..${branch}`,
        ]),
      );
      if (filesSection) body = `${body.replace(/\n*$/, "")}\n\n${filesSection}`;
    } catch {
      // The handoff itself carries the work.
    }
    // D93: the planner's comment history rides the pull request body — the
    // developer reads what changed and why without leaving the PR.
    // D93 후속: the anchor is the CYCLE's birth (project creation or the
    // previous request's landing), not the branch's first commit — the pins
    // that motivated this cycle's changes are always logged BEFORE the first
    // 저장 lands, so a commit-time anchor silently dropped the section on
    // every first handoff. A cycle started before the anchor existed still
    // falls back to the commit time, which is no worse than before.
    try {
      const since = await this.core.cycleAnchor();
      if (options.commentsFile && since) {
        const section = buildCommentsSection(readComments(options.commentsFile), since);
        if (section) body = `${body.replace(/\n*$/, "")}\n\n${section}`;
      }
    } catch {
      // A history that will not read costs only the section — the handoff
      // itself carries the work.
    }
    try {
      // D56: the captures join the branch first, so the body can link files
      // the developer will really find in it.
      body = await this.attachShots(body, options.shots, branch);
      // The pull request is the REMOTE's word: a save whose push died after
      // the commit (runSave 의 push 재시도가 아는 상태) leaves cycle commits
      // origin never got, and a request opened from that stale head shows old
      // commits while the body lists files it does not contain — landCycle
      // could merge it as-is. 원격 추적 ref 가 기준이다(runSave 의 재시도와
      // 같은 잣대) — 없으면 첫 push 를 아직 못 받은 것이고, 밀렸으면 지금
      // 민다. 못 민 넘기기는 넘기기의 실패로 끝난다.
      const onRemote = (
        await this.core
          .git(["rev-parse", "--verify", `refs/remotes/origin/${branch}`])
          .catch(() => "")
      ).trim();
      // 못 센 밀림은 민 것으로 본다 — 확인 없이 요청을 여는 쪽이 더 비싸다.
      const waiting = Number(
        (
          await this.core
            .git(["rev-list", "--count", `origin/${branch}..${branch}`])
            .catch(() => "-1")
        ).trim(),
      );
      try {
        if (onRemote === "" || waiting !== 0) {
          await this.core.git(["push", "--set-upstream", "origin", branch]);
        }
      } catch (error) {
        // pr 이 아니라 push 다 — 인증 거절은 설정 안내로, 나머지는 AI 의
        // 과제로 갈라지는 failGate 의 판정을 그대로 받는다.
        return this.failGate("push", error, options.onSessionTurn);
      }
      // 열린 요청의 head 가 지금 브랜치일 때만 덮어쓴다 — 새 사이클 브랜치에서
      // reopened 요청의 옛 head 를 고쳐 쓰면 보이지 않는 곳의 커밋을 고른다.
      const open = this.core.openHandoff;
      const pull =
        open && open.branch === branch
          ? await client.updatePullRequest({
              ...slug,
              number: open.number,
              title,
              body,
            })
          : await client.createPullRequest({
              ...slug,
              head: branch,
              base: this.core.baseBranch,
              title,
              body,
            });
      const handoff: HandoffStatus = pull;
      // E4(초대 v2): 리뷰를 부탁할 개발자들이 정해져 있으면 GitHub 에 요청한다
      // — 최선의 노력. 실패해도 넘기기는 이미 끝났고 칩의 리뷰어 줄이 비는
      // 것이 전부다(레포의 자기 규칙이 있을 수 있는 자리).
      const reviewers = this.core.reviewers?.() ?? [];
      if (reviewers.length > 0) {
        await client.requestReviewers({ ...slug, number: handoff.number, reviewers });
      }
      this.core.setCycle(branch, handoff);
      const status = this.core.setDiff({ stage: "handed-off", handoff });
      // hero-synthesis D1: the milestone line — 넘겼어요 — joins the tape.
      this.core.lane.outside(() =>
        this.deps.onCycleEvent?.(
          {
            kind: "cycle.handed",
            at: new Date().toISOString(),
            pr: handoff.number,
            ...(handoff.reviewers?.[0] ? { reviewer: handoff.reviewers[0] } : {}),
          },
          options.sessionId,
        ),
      );
      return status;
    } catch (error) {
      return this.failGate("pr", error, options.onSessionTurn);
    }
  }

  /**
   * D56: writes the server's captures under `.colo-design/shots/`, commits and
   * pushes them on this cycle's branch, and returns the body with a
   * `### 화면 미리보기` section linking each one. Nothing here can fail the
   * handoff: the work is already saved — an empty set or a commit that would
   * not land quietly leaves the body without the section.
   */
  private async attachShots(
    body: string,
    shots: HandoffShot[] | undefined,
    branch: string,
  ): Promise<string> {
    if (!shots || shots.length === 0) return body;
    const slug = this.core.repoSlug();
    if (!slug) return body;
    const links: string[] = [];
    try {
      // The captures must join the branch the pull request is from — a
      // worktree sitting anywhere else would bury them in the wrong history
      // and every link in the body would dangle.
      await this.core.git(["checkout", branch]);
      mkdirSync(join(this.core.root, SHOTS_DIR), { recursive: true });
      for (const shot of shots) {
        // A route keeps its Korean; only its path separators become dashes.
        // The route passes the same gate as ever — `..` or a separator would
        // walk the name out of SHOTS_DIR. The extension is the capture's
        // own — see HandoffShot. (2026-09-21 상태 축 철거: `--state` 접미가
        // 사라지고 화면 하나에 이름 하나다.)
        const name = `${shotNamePart(shot.route)}${shot.extension}`;
        writeFileSync(join(this.core.root, SHOTS_DIR, name), shot.image);
        await this.core.git(["add", "--", `${SHOTS_DIR}/${name}`]);
        // Only the url's spaces are escaped — a Korean route reads as itself.
        const url =
          `https://github.com/${slug.owner}/${slug.repo}/blob/${branch}/` +
          `${SHOTS_DIR}/${name.replaceAll(" ", "%20")}`;
        links.push(`- [\`${shot.route}\`](${url})`);
      }
      // An identical set is a no-op: a re-handoff after a mere retitle must
      // not invent an empty commit.
      if ((await this.core.git(["diff", "--cached", "--name-only"])).trim() !== "") {
        await this.core.git([
          ...(await this.core.identityArgs()),
          "commit",
          "-m",
          SHOTS_COMMIT_MESSAGE,
        ]);
        await this.core.git(["push", "origin", branch]);
      }
    } catch {
      return body;
    }
    return `${body.replace(/\n*$/, "")}\n\n### 화면 미리보기\n\n${links.join("\n")}\n`;
  }

  /**
   * 보낸 화면 동결: one committed capture, read out of the
   * handoff branch with `git show` — never the worktree, so the frozen stage
   * keeps showing '보낸 그대로' after the work moved on, was 반려'd, or the
   * clone went back to the base. The remote ref is tried first: a merged
   * cycle's local branch may already be gone while `origin/` still holds it.
   * Null is the honest answer for every absence — a capture that failed, a
   * branch nobody pushed.
   */
  async handoffShot(route: string): Promise<{ mediaType: string; data: string } | null> {
    if (!this.core.isCloned()) return null;
    const branch = this.core.openHandoff?.branch ?? this.endedHandoff?.branch ?? null;
    if (!branch) return null;
    // The same name attachShots wrote — the route passes the same
    // normalization so the lookup matches what was committed
    // (2026-09-21 상태 축 철거 — 주소만이 이름이다).
    const name = shotNamePart(route);
    for (const ref of [`origin/${branch}`, branch]) {
      const listing = await this.core
        .git(["-c", "core.quotepath=false", "ls-tree", "--name-only", ref, `${SHOTS_DIR}/`])
        .catch(() => "");
      const file = listing
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith(`${SHOTS_DIR}/${name}.`));
      if (!file) continue;
      const data = await this.core
        .git(["show", `${ref}:${file}`], this.core.root, {}, true)
        .catch(() => "");
      if (data === "") continue;
      const ext = file.slice(file.lastIndexOf("."));
      return { mediaType: SHOT_MEDIA_TYPES[ext] ?? "application/octet-stream", data };
    }
    return null;
  }

  /**
   * Re-reads the pull request. 반영됨(merged)과 반려(closed) 둘 다 사이클을
   * 끝낸다: 클론은 베이스 브랜치로 돌아가고 다음 저장이 새 브랜치를 연다 —
   * 그래서 이것은 수동적인 상태 읽기가 아니다 (커미티 2026-09-15 판정 1·2).
   */
  async refreshHandoff(): Promise<HandoffStatusReport | null> {
    const current = this.core.openHandoff;
    // 폴링이 이미 본 끝 — 읽기에 실패해도 이것만으로 내려앉을 수 있다.
    const ended = this.endedHandoff;
    const target = current ?? ended;
    const slug = this.core.repoSlug();
    const client = this.core.gitHubClient?.() ?? null;
    if (!target) return null;
    if (!slug || !client) {
      if (ended) await this.landCycle(ended);
      return ended ?? current;
    }

    const pull = await client.getPullRequest({ ...slug, number: target.number }).catch(() => null);
    if (!pull) {
      // 못 읽었다고 끝나지 않은 것이 되지는 않는다: 폴링이 본 끝은 그대로 내려앉는다.
      if (ended) await this.landCycle(ended);
      return ended ?? current;
    }

    const handoff: HandoffStatus = pull;
    // hero-synthesis D1: 반영됨 is news the moment the daemon learns it —
    // here (상태 확인 · 저장의 머리) or in the poll below. The target's own
    // state is the guard: a handoff already staged or landed as merged does
    // not announce twice. 반려 has no tape event — the contract names only
    // `cycle.merged`; the notice and the review rows carry that story.
    // 폴러가 먼저 본 끝(`endedHandoff` 같은 요청·같은 끝)은 이미 테이프에
    // 내려앉은 소식이다 — `current` 가 아직 open 모양을 들고 있어도 다시
    // 울리면 같은 줄이 두 번 쌓인다 (베타 테스트 #5).
    const seenEnded = ended !== null && ended.number === pull.number && ended.state === pull.state;
    if (pull.state === "merged" && target.state !== "merged" && !seenEnded) {
      this.core.lane.outside(() =>
        this.deps.onCycleEvent?.(
          { kind: "cycle.merged", at: new Date().toISOString(), pr: pull.number },
          undefined,
        ),
      );
    }
    // 사이클을 끝내는 판정은 둘이다: 반영됨과 반려. 반려를 사이클로 계속 들고
    // 있으면 칩이 `저장됨` 으로 떨어져(넘기기까지 열린다) 저장은 아무도 읽지
    // 않는 브랜치에 쌓이고, 넘기기는 닫힌 요청의 제목·본문만 덮어쓴다 —
    // 개발자의 판정이 조용히 무효가 된다 (커미티 2026-09-15 C-3).
    if (pull.state !== "merged" && pull.state !== "closed") {
      // 닫혔다 다시 열린 요청 — 세워 둔 끝은 더 이상 끝이 아니다.
      this.endedHandoff = null;
      this.core.setCycle(this.core.branch, handoff);
      return await this.withReviews(handoff);
    }

    await this.landCycle(handoff);
    return await this.withReviews(handoff);
  }

  /**
   * 폴링의 읽기 (커미티 2026-09-15 판정 1): **읽기만 한다.**
   *
   * open ↔ changes_requested 사이의 움직임만 칩·배지에 반영한다. 사이클을
   * 끝내는 판정(반영됨·반려)은 워크트리를 베이스로 되돌리고 체크포인트까지
   * 건드리는 착지를 동반하므로, 타이머가 조용히 해서는 안 되는 일이다 —
   * 본 끝은 `endedHandoff` 에 세워만 두고, 사람이 있는 자리(상태 확인 ·
   * 프로젝트 활성화 · 다음 저장의 머리)가 내려앉힌다.
   */
  async peekHandoff(): Promise<HandoffStatusReport | null> {
    const current = this.core.openHandoff;
    const slug = this.core.repoSlug();
    const client = this.core.gitHubClient?.() ?? null;
    if (!current || !slug || !client) return current;

    const pull = await client.getPullRequest({ ...slug, number: current.number }).catch(() => null);
    if (!pull) return current;

    if (pull.state === "merged" || pull.state === "closed") {
      // hero-synthesis D1: the poll's fresh read of 반영됨 is the same news —
      // `endedHandoff` already holding a merged pull means it was announced.
      if (pull.state === "merged" && this.endedHandoff?.state !== "merged") {
        this.core.lane.outside(() =>
          this.deps.onCycleEvent?.(
            { kind: "cycle.merged", at: new Date().toISOString(), pr: pull.number },
            undefined,
          ),
        );
      }
      this.endedHandoff = pull;
    } else this.core.setCycle(this.core.branch, pull);
    return await this.withReviews(pull);
  }

  /** 사람이 온 자리 — 폴링이 세워 둔 사이클의 끝이 있으면 지금 내려앉힌다. */
  async landHandoffIfDue(): Promise<void> {
    if (!this.endedHandoff) return;
    await this.refreshHandoff().catch(() => undefined);
  }

  /**
   * 사이클의 끝 — 반영됨과 반려가 같은 모양으로 내려앉는다: 베이스 브랜치로
   * 돌아가고 브랜치를 잊는다. 반려에서 워크트리를 반려된 팁에 남겨 두면 다음
   * 저장의 `checkout -B` 가 그 위에서 새 사이클을 만들어 **반려된 커밋을 새
   * 요청으로 다시 제안한다** (커미티 2026-09-15 판정 2).
   */
  private landCycle(handoff: HandoffStatus): Promise<void> {
    // 착지는 차선의 land 칸에 선다(PLAN L1) — fetch · checkout · reset 이
    // 클론을 통째로 움직인다. 저장의 머리(runSave 안의 refreshHandoff)에서
    // 불리면 재진입으로 곧바로 돈다.
    return this.core.lane.run("land", () => this.landCycleJob(handoff));
  }

  /** landCycle 의 몸통 — 차선 작업 안에서만 돈다. */
  private async landCycleJob(handoff: HandoffStatus): Promise<void> {
    // 재착지 금지: branch 가 비었고 같은 요청이 이미 같은 끝 상태로 열려 있으면
    // 착지는 지난번에 끝났다 — refreshHandoff 가 매번 다시 부를 때마다
    // rotateCommentsCycle 이 핀 앵커를 옮기는 일을 한 번만 치른다.
    const seated = this.core.openHandoff;
    if (
      this.core.branch === null &&
      seated !== null &&
      (seated.state === "merged" || seated.state === "closed") &&
      seated.state === handoff.state &&
      seated.number === handoff.number
    ) {
      return;
    }
    try {
      await this.core.git(["fetch", "origin", this.core.baseBranch]);
      // 저장 안 한 변경은 실어 나르지 않는다: 병합 직후엔 양쪽 블롭이 같아
      // checkout 이 수정을 거부하지 않고, 이어지는 reset 이 그대로 지워버린다.
      // dirty 면 checkout 만 하고 reset 은 건너뛴다 — 다음 세션 시작의 최신화가
      // stash 로 그 변경을 지키며 따라간다.
      const dirty = (await this.core.git(["status", "--porcelain"])).trim().length > 0;
      await this.core.git(["checkout", this.core.baseBranch]);
      if (!dirty) await this.core.git(["reset", "--hard", `origin/${this.core.baseBranch}`]);
    } catch (error) {
      // A dirty worktree can refuse the checkout. Forgetting the cycle here
      // would strand HEAD on the ended branch — the next save's `checkout -B`
      // would carry its rejected commits into a new PR. The cycle stays, so
      // the next landing attempt retries the move to the base first.
      this.core.setDetail(detailOf(error, this.core.pat));
      return;
    }
    this.endedHandoff = null;
    this.core.setCycle(null, handoff);
    // D93 후속: the ended cycle's pins belonged to its request — 다음 넘기기의
    // `### 수정 요청` 절은 이 순간 이후의 핀만 읽는다. GitHub 가 merged_at 을
    // 주지 않으니 착지의 순간이 앵커다 — 반영 전의 늦은 핀 한두 개가 다음
    // 요청으로 넘어가는 것이 저장 때마다 묻는 것보다 싸다.
    this.core.rotateCommentsCycle();
  }

  /**
   * D88: the developer's words, read beside the pull request — 인라인 코멘트와
   * 말이 있는 리뷰 본문이 한 목록으로. A refused read costs the rows, not the
   * status: the badge stays quiet rather than failing 상태 확인.
   */
  private async withReviews(handoff: HandoffStatus): Promise<HandoffStatusReport> {
    const slug = this.core.repoSlug();
    const client = this.core.gitHubClient?.() ?? null;
    const reviews: DeveloperReview[] = [];
    if (slug && client) {
      // 앱 자신의 목소리 — 답하기(commentOnIssue · 답글)가 남긴 코멘트까지
      // 개발자의 말로 다시 브리프하면 되먹임이 된다. 이 토큰의 로그인과 같은
      // 행은 세 목록에서 모두 건너뛴다 (베타 테스트 #3).
      const me = await client
        .whoAmI()
        .then((answer) => (answer.ok ? answer.login : ""))
        .catch(() => "");
      const own = (row: Record<string, any>): boolean =>
        me !== "" && String(row.user?.login ?? "") === me;
      const collect = async (): Promise<void> => {
        for (const row of await client.listPullComments({
          ...slug,
          number: handoff.number,
        })) {
          if (own(row)) continue;
          reviews.push({
            id: Number(row.id),
            kind: "inline",
            author: String(row.user?.login ?? ""),
            body: String(row.body ?? ""),
            pr: handoff.number,
            ...(row.path ? { path: String(row.path) } : {}),
            ...(Number.isFinite(Number(row.line)) ? { line: Number(row.line) } : {}),
            at: String(row.created_at ?? ""),
          });
        }
        for (const row of await client.listReviews({
          ...slug,
          number: handoff.number,
        })) {
          const text = String(row.body ?? "").trim();
          if (text === "" || own(row)) continue;
          reviews.push({
            id: Number(row.id),
            kind: "review",
            author: String(row.user?.login ?? ""),
            body: text,
            pr: handoff.number,
            at: String(row.submitted_at ?? ""),
          });
        }
        // 요청 본문 코멘트(`gh pr comment`)도 개발자의 말이다 — 인라인이
        // 아니라 본문형이므로 kind 는 review 답한다: 화면에서 본문 행으로
        // 읽히고, 답하기도 commentOnIssue 로 향한다 (베타 테스트 #3).
        for (const row of await client.listIssueComments({
          ...slug,
          number: handoff.number,
        })) {
          const text = String(row.body ?? "").trim();
          if (text === "" || own(row)) continue;
          reviews.push({
            id: Number(row.id),
            kind: "review",
            author: String(row.user?.login ?? ""),
            body: text,
            pr: handoff.number,
            at: String(row.created_at ?? ""),
          });
        }
      };
      const collected = await collect()
        .then(() => true)
        .catch(() => false);
      // hero-synthesis D1: ids this read adds are the 사람 메시지's arrival —
      // the poll and 상태 확인 share this path, so both record the same rows.
      // A refused read seeds nothing: announcing every old comment as new on
      // the next successful read is worse than staying quiet once.
      if (collected) {
        const known = this.knownReviewIds;
        if (known !== null) {
          const arrived = reviews.filter((review) => !known.has(review.id));
          if (arrived.length > 0) {
            this.core.lane.outside(() =>
              this.deps.onCycleEvent?.({ kind: "review.arrived", reviews: arrived }, undefined),
            );
          }
        }
        this.knownReviewIds = new Set(reviews.map((review) => review.id));
      }
    }
    this.lastReviews = reviews;
    return { ...handoff, reviews };
  }

  /**
   * D88: 답하기 — the planner's words go to GitHub under their own name. The
   * id resolves against the last 상태 확인 read: 인라인이면 스레드의 답글로,
   * 리뷰 본문이면 이슈 코멘트로.
   */
  async replyToReview(id: number, body: string): Promise<void> {
    const review = this.lastReviews.find((entry) => entry.id === id);
    const slug = this.core.repoSlug();
    const client = this.core.gitHubClient?.() ?? null;
    if (!slug || !client) {
      throw new Error("GitHub 에 답할 수 없습니다 — 설정에서 토큰을 확인해 주세요.");
    }
    if (!review) {
      throw new Error("답할 코멘트를 찾을 수 없습니다 — 상태 확인을 다시 눌러 주세요.");
    }
    if (review.kind === "inline") {
      await client.replyToPullComment({
        ...slug,
        number: review.pr,
        commentId: review.id,
        body,
      });
    } else {
      await client.commentOnIssue({ ...slug, number: review.pr, body });
    }
  }

  /**
   * D6 → PLAN L7: 조용한 푸시는 한 번만 시도한다. 실패하면 조용히 두고
   * 감독자(cycle-supervisor)의 12행이 원장의 백오프로 계속 민다 — 무한,
   * 최대 10분 간격. 전경 푸시(제출)는 그대로다.
   */
  private async retryBackgroundPush(branch: string): Promise<void> {
    try {
      await this.core.lane.run("push", () =>
        this.core.git(["push", "--set-upstream", "origin", branch]),
      );
    } catch {
      // 밀린 커밋은 감독자의 push 행과 제출의 게이트가 잡는다.
    }
  }
  private failGate(
    gate: "commit" | "push" | "pr",
    error: unknown,
    onSessionTurn: ((brief: string) => void) | undefined,
  ): DiffStatus {
    const detail = detailOf(error, this.core.pat);
    // D90 ⓑ: `pr` 은 AI 에게 가지 않는다 — PR 열기 실패의 원인은 토큰
    // 권한 · 브랜치 보호 · 네트워크라 AI 가 고칠 게 없어 헛돈다. 웹이
    // 넘기기 대화상자의 안내(넘기지 못했습니다 + 설정 열기)로 응답한다.
    // `push` 는 갈라진다: 인증 · 권한 사유면 안내로, 그 외(non-fast-forward
    // 등)는 지금처럼 AI — 모르면 AI 쪽(보수적).
    const pushAuth = gate === "push" && PUSH_AUTH_FAILURE.test(detail);
    const skipClaude = gate === "pr" || pushAuth;
    if (!skipClaude) {
      // The failure is actionable by the agent, not by the planner: hand it over
      // the same wire a typed message uses, output tail included. The step is
      // named the way the planner's button is, not the way git is.
      // 나가는 문 (PLAN L1): 브리프가 만드는 세션(게이트 대화)이 이 작업의
      // 문맥을 물려받지 않게 한다.
      this.core.lane.outside(() =>
        onSessionTurn?.(
          markTurn(
            { kind: "gate", step: GATE_STEP[gate] },
            `${GATE_BRIEF[gate]} 아래 출력의 원인을 고친 뒤 다시 시도해 주세요.\n\n${detail}`,
          ),
        ),
      );
    } else {
      // 개발자 알림 (PLAN L11): AI 도 기획자도 고칠 수 없는 실패다 — 문제
      // 키와 함께 DeveloperNotice 로 간다. detail 은 PAT 가 이미 걷힌 한국어
      // 문장이고, 본문의 `자세히` 가 된다.
      const key = pushAuth ? "push:auth" : "submit:pr";
      this.core.lane.outside(() => this.deps.notice?.(key, detail));
    }
    // reason 이 없으면 저장 검토는 "멈췄습니다" 로만 끝났다.
    return this.core.setDiff({
      stage: "failed",
      gate,
      ...(pushAuth ? { reason: "push-auth" as const } : {}),
      detail,
    });
  }

  /** Stages and commits exactly the approved paths — the reviewed diff. */
  private async commitApproved(message: string, paths: string[]): Promise<void> {
    await this.core.git(["add", "--", ...paths]);
    await this.core.git([...(await this.core.identityArgs()), "commit", "-m", message]);
  }
}

/** Cross-module services the cycle needs — wired by the facade. */
export interface PublishDeps {
  /** The save-time memo the PR body quotes — the summarizer's one turn. */
  machineMemo(files: DiffFile[]): Promise<string | null>;
  /**
   * 사이클 사건의 기록 (hero-synthesis D1): 저장 · 넘김 · 반영 · 코멘트 도착을
   * 세션 채널로 보내고 테이프에 남긴다. `sessionId` 는 저장·넘기기를 부른
   * 대화 — 없으면 붙이는 쪽이 마지막 활성 세션으로 귀속한다.
   */
  onCycleEvent?(event: ChatEvent, sessionId?: string): void;
  /**
   * 개발자 알림 (PLAN L11) — 인증·권한 게이트 실패를 문제 키와 함께
   * DeveloperNotice 로 흘린다. 없으면 조용히 지나간다 — 알림은 언제나 부가물.
   */
  notice?(key: "push:auth" | "submit:pr", detail: string): void;
}
