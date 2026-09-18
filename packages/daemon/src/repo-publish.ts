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
 * A route or state becomes part of a committed filename: separators and
 * `..` would let it walk out of `.colo-design/shots/` (or simply fail to
 * match on read-back). Korean stays — the route keeps its own words.
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
    /** hero-synthesis D1: the conversation this save belongs to (세션 테이프). */
    sessionId?: string;
  }): Promise<DiffStatus> {
    if (!this.core.isCloned()) {
      return this.core.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "연결 레포가 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.",
      });
    }
    // The worktree is the review's subject: a session-start refresh still
    // stashing and replaying must settle before the diff is computed.
    await this.core.refreshing?.catch(() => undefined);
    await this.core.shelving?.catch(() => undefined);

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
      return this.core.setDiff({
        stage: "failed",
        gate: "diff",
        detail: "저장할 변경사항이 없습니다 — 먼저 화면을 만들거나 고쳐 주세요.",
      });
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
        (await this.deps.claudeMemo(files).catch(() => null)) ||
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
    try {
      await this.core.git(["push", "--set-upstream", "origin", branch]);
    } catch (error) {
      return this.failGate("push", error, options.onSessionTurn);
    }

    const commit = (await this.core.git(["rev-parse", "HEAD"])).trim();
    // The worktree is clean now; the chip moves off unsaved on this.
    await this.core.refreshPendingChanges();
    const message =
      memo ?? (await this.core.git(["log", "-1", "--pretty=%s"]).catch(() => "")).trim();
    const status = this.core.setDiff({ stage: "published", commit, message });
    // hero-synthesis D1: the save lands on the session tape — a reloaded
    // window replays the card instead of losing it with `diffStatus`.
    this.deps.onCycleEvent?.(
      {
        kind: "cycle.saved",
        at: new Date().toISOString(),
        commit,
        message,
        files: approved.length > 0 ? approved : retryFiles,
      },
      options.sessionId,
    );
    return status;
  }

  /**
   * The branch this cycle belongs on, checked out and created if this is the
   * first save since the last handoff was merged.
   *
   * `<YYYYMMDD>-<n>` rather than a name derived from the work: the planner
   * never reads it, and a title mined from the diff would be one more place a
   * rename could break. `n` walks up until the remote has no such branch, so
   * two machines on one project cannot collide.
   */
  async ensureCycleBranch(): Promise<string> {
    if (this.core.branch) {
      const head = (await this.core.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (head !== this.core.branch) await this.core.git(["checkout", this.core.branch]);
      return this.core.branch;
    }

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `${BRANCH_PREFIX}/${today}`;
    let name = `${prefix}-1`;
    for (let n = 1; n <= 99; n += 1) {
      name = `${prefix}-${n}`;
      // An empty ls-remote line means nobody has taken it. A remote that
      // cannot be reached is not a reason to refuse the save: the push right
      // after this will report the real problem, with git's own words.
      const taken = await this.core
        .git(["ls-remote", "--heads", this.core.url ?? "origin", name])
        .catch(() => "");
      if (taken.trim() === "") break;
    }

    await this.core.git(["checkout", "-B", name]);
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
    // The same worktree contract as a save: wait out a refresh before
    // reading and writing the cycle.
    await this.core.refreshing?.catch(() => undefined);
    await this.core.shelving?.catch(() => undefined);

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
    // 저장·넘기기 목업 02: the cycle's own numstat rides the body — the
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
      this.core.setCycle(branch, handoff);
      const status = this.core.setDiff({ stage: "handed-off", handoff });
      // hero-synthesis D1: the milestone line — 넘겼어요 — joins the tape.
      this.deps.onCycleEvent?.(
        {
          kind: "cycle.handed",
          at: new Date().toISOString(),
          pr: handoff.number,
          ...(handoff.reviewers?.[0] ? { reviewer: handoff.reviewers[0] } : {}),
        },
        options.sessionId,
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
        // Route AND state pass the same gate — a state is a wire value too,
        // and `..` or a separator would walk the name out of SHOTS_DIR.
        // The extension is the capture's own — see HandoffShot. 파일 이름에서만
        // null 이 "default" 로 정착한다 — 커밋과 조회가 같은 규칙을 쓰면 된다.
        const name = `${shotNamePart(shot.route)}--${shotNamePart(shot.state ?? "default")}${shot.extension}`;
        writeFileSync(join(this.core.root, SHOTS_DIR, name), shot.image);
        await this.core.git(["add", "--", `${SHOTS_DIR}/${name}`]);
        // Only the url's spaces are escaped — a Korean route reads as itself.
        const url =
          `https://github.com/${slug.owner}/${slug.repo}/blob/${branch}/` +
          `${SHOTS_DIR}/${name.replaceAll(" ", "%20")}`;
        links.push(
          shot.state === null
            ? `- [\`${shot.route}\`](${url})`
            : `- [\`${shot.route} · ${shot.state}\`](${url})`,
        );
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
  async handoffShot(
    route: string,
    state: string | null,
  ): Promise<{ mediaType: string; data: string } | null> {
    if (!this.core.isCloned()) return null;
    const branch = this.core.openHandoff?.branch ?? this.endedHandoff?.branch ?? null;
    if (!branch) return null;
    // The same name attachShots wrote — route and state pass the same
    // normalization so the lookup matches what was committed. null 도 커밋
    // 쪽과 같은 규칙으로 "default" 에 정착한다.
    const name = `${shotNamePart(route)}--${shotNamePart(state ?? "default")}`;
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
    if (pull.state === "merged" && target.state !== "merged") {
      this.deps.onCycleEvent?.(
        { kind: "cycle.merged", at: new Date().toISOString(), pr: pull.number },
        undefined,
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
        this.deps.onCycleEvent?.(
          { kind: "cycle.merged", at: new Date().toISOString(), pr: pull.number },
          undefined,
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
  private async landCycle(handoff: HandoffStatus): Promise<void> {
    // 재착지 금지: branch 가 비었고 같은 요청이 이미 같은 끝 상태로 열려 있으면
    // 착지는 지난번에 끝났다 — refreshHandoff 가 매번 다시 부를 때마다
    // rotateCommentsCycle 이 핀 앵커를 옮기고 clearCheckpoints 가 새 턴의
    // 체크포인트를 지우는 일을 막는다.
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
    if (handoff.state === "merged") {
      // 반영됨 (PLAN D52): the cycle's checkpoints snapshot a worktree the
      // developer has already absorbed — restoring them now would move the work
      // backwards past a merge. Their refs go, quietly. 반려는 다르다: 흡수된
      // 적이 없으니 되돌릴 가치가 남는다 — 체크포인트를 유지한다 (판정 2).
      await this.deps.clearCheckpoints().catch(() => undefined);
    }
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
      const collect = async (): Promise<void> => {
        for (const row of await client.listPullComments({
          ...slug,
          number: handoff.number,
        })) {
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
          if (text === "") continue;
          reviews.push({
            id: Number(row.id),
            kind: "review",
            author: String(row.user?.login ?? ""),
            body: text,
            pr: handoff.number,
            at: String(row.submitted_at ?? ""),
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
            this.deps.onCycleEvent?.({ kind: "review.arrived", reviews: arrived }, undefined);
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
      onSessionTurn?.(
        markTurn(
          { kind: "gate", step: GATE_STEP[gate] },
          `${GATE_BRIEF[gate]} 아래 출력의 원인을 고친 뒤 다시 시도해 주세요.\n\n${detail}`,
        ),
      );
    }
    // 리뷰 C5: push 인증 거절은 화면이 다음 행동(토큰 확인)을 말해야 한다 —
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
  claudeMemo(files: DiffFile[]): Promise<string | null>;
  /** A merged cycle's snapshots are history, not exits. */
  clearCheckpoints(): Promise<void>;
  /**
   * 사이클 사건의 기록 (hero-synthesis D1): 저장 · 넘김 · 반영 · 코멘트 도착을
   * 세션 채널로 보내고 테이프에 남긴다. `sessionId` 는 저장·넘기기를 부른
   * 대화 — 없으면 붙이는 쪽이 마지막 활성 세션으로 귀속한다.
   */
  onCycleEvent?(event: ChatEvent, sessionId?: string): void;
}
