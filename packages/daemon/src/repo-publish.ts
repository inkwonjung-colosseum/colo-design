// 저장 → 개발자에게 넘기기 → 반영됨: the publish cycle (PLAN D5[넘기기]).
// Owns the in-flight cycle's handoff bookkeeping and the review replies.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { replyFooter } from "./developer-replies.js";
import {
  buildCommentsSection,
  buildFilesSection,
  noteLine,
  TOOL_BLOCK_END,
  TOOL_BLOCK_START,
} from "./handoff-body.js";
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
import { saveablePaths } from "./saveable-paths.js";
import { SUBMIT_LOG_TEXT } from "./submit-state.js";

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

/** 캡처가 올라가는 병합되지 않는 브랜치 (PLAN L6 · O4) — 사이클 브랜치가
 *  아니므로 반영돼도 main 에 캡처가 쌓이지 않고, 지워져도 링크(sha)는 산다. */
export const ASSETS_BRANCH = "colo-design-assets";
/** 그 브랜치 안에서 캡처가 사는 폴더 — `<폴더>/<사이클 브랜치>/<이름>`. */
const ASSETS_SHOTS_DIR = "shots";
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
 * 새 사이클 브랜치의 이름 고르기 (PLAN L4) — `<YYYYMMDD>-<n>` 을 올려 가며
 * 로컬 · 원격 어느 쪽에도 없는 첫 번호를 고른다. ensureCycleBranch 와
 * 감독자의 랜딩 이월이 함께 쓴다 — 두 곳이 같은 규칙으로 골라야 두 기계가
 * 같은 이름을 두고 다투지 않는다. 원격이 닿지 않으면 로컬만으로 고른다 —
 * 이름을 못 고르는 것이 저장을 막을 이유는 아니다(뒤의 push 가 진짜 문제를
 * 말한다).
 */
export async function pickCycleBranchName(
  git: (args: string[]) => Promise<string>,
  remote: string,
): Promise<string> {
  const today = new Date();
  let name = cycleBranchName(today, 1);
  for (let n = 1; n <= 99; n += 1) {
    name = cycleBranchName(today, n);
    const takenRemote = await git(["ls-remote", "--heads", remote, name]).catch(() => "");
    if (takenRemote.trim() !== "") continue;
    const takenLocal = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).catch(
      () => "",
    );
    if (takenLocal.trim() === "") break;
  }
  return name;
}

/** The committed file's name part — the route, made safe for a path segment. */
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

  /** D88: the developer comments the last 상태 확인 read — 답하기 resolves ids against this. */
  private lastReviews: DeveloperReview[] = [];

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

    // 끝난 요청의 착지는 감독자(cycle-supervisor)의 몫이다 — 저장은 여기서
    // 읽지 않는다. 끝난 PR 에 자동 보관이 먼저 커밋해도 괜찮다: 랜딩의 이월이
    // PR head 뒤의 커밋으로 옮긴다(PLAN L4).

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
    // 콜드 리뷰 N1 (2026-09-25, PLAN-UI 9.3 D1): 도구의 부산물 — 미리보기
    // 명령이 스스로 설치해 만든 락파일 · node_modules — 은 보관이 담지
    // 않는다. 담으면 아무 것도 만들지 않은 사용자에게 기계의 커밋이 남는다.
    // 턴의 자동 보관과 감독자의 commitPending 이 모두 이 자리를 지나므로,
    // 거름은 saveablePaths 하나로 여기서만 한다.
    const saveable = saveablePaths(files, await this.core.trackedPaths());
    const approved = saveable.map((file) => file.path);
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
      // N1: 나무에는 변경이 있으나 담을 것 전부가 도구의 부산물이다 — 조용한
      // 무동작으로 끝낸다(빈 커밋도, saveBlocked 카드도 없다). 이미 흘린
      // computing 상태를 그대로 돌려줄 뿐 다시 방송하지 않는다.
      if (files.length > 0) return { stage: "computing" as const };
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
      const detail = "보관할 변경사항이 없습니다 — 먼저 화면을 만들거나 고쳐 주세요.";
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
        (await this.deps.machineMemo(saveable).catch(() => null)) ||
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

    const name = await pickCycleBranchName(
      (args) => this.core.git(args),
      this.core.url ?? "origin",
    );

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
        detail: "제출할 변경사항이 없습니다 — 먼저 화면을 만들거나 고쳐 주세요.",
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
      // 끝난 요청(merged·closed)은 절대 PATCH 하지 않는다 — 감독자의 랜딩이
      // 늦어진 사이에 눌린 제출이 닫힌 요청의 제목·본문을 덮어쓰는 일을 막는다
      // (PLAN L4 — 끝난 요청은 새 요청으로만 이어진다).
      const open = this.core.openHandoff;
      const pull =
        open &&
        open.branch === branch &&
        (open.state === "open" || open.state === "changes_requested")
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
      // 넘기기가 성공했다 — 서 있던 submit:pr 알림을 거둔다(PLAN L11).
      this.deps.resolveNotice?.("submit:pr");
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
   * PR 본문의 도구 구간 (PLAN L6) — 작성자 줄 · 바뀐 파일 · 수정 요청 · 화면
   * 미리보기를 `<!-- colo-design:start/end -->` 로 감싼 한 덩어리로 조립한다.
   * 감독자의 제출 단계(ensurePullRequest)가 mergeToolBlock 으로 구간만 갱신할
   * 때 쓰고, 구간 밖의 개발자 글은 호출자가 지킨다. 빈 문자열은 "조립 불가" —
   * 브랜치가 없을 때뿐이다.
   */
  async handoffToolBlock(
    options: {
      shots?: HandoffShot[];
      /** D93: 코멘트 저장소 — `### 수정 요청` 절의 재료. */
      commentsFile?: string;
      /** 제출 확인의 `개발자에게 한마디`(PLAN-UI U3) — 작성자 줄 바로 아래. */
      note?: string;
    } = {},
  ): Promise<string> {
    const branch = this.core.branch;
    if (!branch) return "";
    const sections: string[] = [];
    // P1-3: 작성자 줄 — 요청은 봇 계정으로 열리므로 이름이 없으면 개발자가 누구
    // 작업인지 모른다. 한마디(P3)는 같은 인용 안의 다음 줄이다.
    const author = this.core.authorName?.();
    const byline = [author ? `> 작성: ${author}` : null, noteLine(options.note)]
      .filter((line): line is string => line !== null)
      .join("\n");
    if (byline) sections.push(byline);
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
      if (filesSection) sections.push(filesSection);
    } catch {
      // 제출 자체가 일을 싣는다 — 절 하나가 못 나오는 것은 조용하다.
    }
    try {
      const since = await this.core.cycleAnchor();
      if (options.commentsFile && since) {
        const section = buildCommentsSection(readComments(options.commentsFile), since);
        if (section) sections.push(section);
      }
    } catch {
      // 같은 이유.
    }
    const withShots = await this.attachShots(sections.join("\n\n"), options.shots, branch);
    return `${TOOL_BLOCK_START}\n${withShots.replace(/\n+$/, "")}\n${TOOL_BLOCK_END}`;
  }

  /**
   * D56 → PLAN L6 캡처(O4): 서버의 캡처를 병합되지 않는 브랜치
   * `colo-design-assets` 에 plumbing 으로 올리고, 본문에 `### 화면 미리보기`
   * 절(커밋 sha 로 링크)을 얹어 돌려준다. 사이클 브랜치에는 올리지 않는다 —
   * 반영될 때마다 이미지가 main 에 영구히 쌓이던 길이었다. 체크아웃도 없다:
   * 임시 인덱스(GIT_INDEX_FILE)와 hash-object · commit-tree 로 작업 트리를
   * 건드리지 않는다(repo-shelf 이후의 두 번째 plumbing 자리). 링크가 sha 를
   * 가리키므로 브랜치가 지워져도 산다. 못 올리면 캡처 절 없이 제출은 계속된다.
   */
  private async attachShots(
    body: string,
    shots: HandoffShot[] | undefined,
    branch: string,
  ): Promise<string> {
    if (!shots || shots.length === 0) return body;
    const slug = this.core.repoSlug();
    if (!slug) return body;
    // 부모 — 원격 자산 브랜치의 끝. fetch 가 실패하면(브랜치가 없으면) 없이 시작한다.
    await this.core
      .git(["fetch", "origin", `refs/heads/${ASSETS_BRANCH}:refs/remotes/origin/${ASSETS_BRANCH}`])
      .catch(() => "");
    const parent = (
      await this.core
        .git(["rev-parse", "--verify", `refs/remotes/origin/${ASSETS_BRANCH}`])
        .catch(() => "")
    ).trim();
    const scratch = mkdtempSync(join(tmpdir(), "colo-design-assets-"));
    try {
      // 임시 인덱스 — 이 클론의 index 는 한 번도 건드리지 않는다.
      const env = { GIT_INDEX_FILE: join(scratch, "index") };
      await this.core.git(
        parent === "" ? ["read-tree", "--empty"] : ["read-tree", parent],
        this.core.root,
        env,
      );
      const names: string[] = [];
      for (const [i, shot] of shots.entries()) {
        // 이름 규칙은 옛 캡처와 같다(2026-09-21 상태 축 철거 — 화면 하나에 이름 하나).
        const name = `${shotNamePart(shot.route)}${shot.extension}`;
        const file = join(scratch, `shot-${i}-${name}`);
        writeFileSync(file, shot.image);
        const sha = (await this.core.git(["hash-object", "-w", "--", file])).trim();
        await this.core.git(
          [
            "update-index",
            "--add",
            "--cacheinfo",
            "100644",
            sha,
            `${ASSETS_SHOTS_DIR}/${branch}/${name}`,
          ],
          this.core.root,
          env,
        );
        names.push(name);
      }
      const tree = (await this.core.git(["write-tree"], this.core.root, env)).trim();
      const commit = (
        await this.core.git([
          ...(await this.core.identityArgs()),
          "commit-tree",
          tree,
          ...(parent === "" ? [] : ["-p", parent]),
          "-m",
          SHOTS_COMMIT_MESSAGE,
        ])
      ).trim();
      await this.core.git(["push", "origin", `${commit}:refs/heads/${ASSETS_BRANCH}`]);
      const links = names.map(
        (name) =>
          `- [\`${name}\`](https://github.com/${slug.owner}/${slug.repo}/blob/${commit}/` +
          `${ASSETS_SHOTS_DIR}/${branch}/${name.replaceAll(" ", "%20")})`,
      );
      return `${body.replace(/\n+$/, "")}\n\n### 화면 미리보기\n\n${links.join("\n")}\n`;
    } catch {
      return body;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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
    const branch = this.core.openHandoff?.branch ?? null;
    if (!branch) return null;
    // The same name attachShots wrote — the route passes the same
    // normalization so the lookup matches what was committed
    // (2026-09-21 상태 축 철거 — 주소만이 이름이다).
    const name = shotNamePart(route);
    // 옛 캡처 — 사이클 브랜치의 `.colo-design/shots/` (2026-09-24 이전 제출).
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
    // 새 캡처 (PLAN L6) — 자산 브랜치의 `shots/<사이클 브랜치>/<이름>`. ref 는
    // 캡처를 올릴 때 생기지만 재시작 뒤엔 없을 수 있다 — 이때만 한 번 받는다.
    const assetsRef = `refs/remotes/origin/${ASSETS_BRANCH}`;
    const haveAssets = (
      await this.core.git(["rev-parse", "--verify", assetsRef]).catch(() => "")
    ).trim();
    if (haveAssets === "") {
      await this.core.lane
        .run("submit", () =>
          this.core.git([
            "fetch",
            "origin",
            `refs/heads/${ASSETS_BRANCH}:refs/remotes/origin/${ASSETS_BRANCH}`,
          ]),
        )
        .catch(() => "");
    }
    const assetsListing = await this.core
      .git([
        "-c",
        "core.quotepath=false",
        "ls-tree",
        "--name-only",
        assetsRef,
        `${ASSETS_SHOTS_DIR}/${branch}/`,
      ])
      .catch(() => "");
    const assetsFile = assetsListing
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(`${ASSETS_SHOTS_DIR}/${branch}/${name}.`));
    if (assetsFile) {
      const data = await this.core
        .git(["show", `${assetsRef}:${assetsFile}`], this.core.root, {}, true)
        .catch(() => "");
      if (data !== "") {
        const ext = assetsFile.slice(assetsFile.lastIndexOf("."));
        return { mediaType: SHOT_MEDIA_TYPES[ext] ?? "application/octet-stream", data };
      }
    }
    return null;
  }

  /**
   * 상태 확인의 읽기 (PLAN L2 흡수표): **읽기만 한다.** 사이클을 끝내는
   * 판정(반영됨·반려의 착지)은 감독자의 틱이 한다 — 여기서는 레지스트리에
   * 쓰지 않는다. 쓰면 감독자가 끝을 영영 모른다(관찰의 handoffState 가
   * 이미 끝이므로 사건이 나가지 않는다).
   */
  async peekHandoff(): Promise<HandoffStatusReport | null> {
    const current = this.core.openHandoff;
    const slug = this.core.repoSlug();
    const client = this.core.gitHubClient?.() ?? null;
    if (!current || !slug || !client) return current;

    const pull = await client.getPullRequest({ ...slug, number: current.number }).catch(() => null);
    if (!pull) return current;
    return await this.withReviews(pull);
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
      // 코멘트 도착 사건(review.arrived)은 감독자의 관찰이 낸다 — 여기서는
      // 읽기만 한다(상태 확인의 읽기는 사건을 만들지 않는다).
      await collect().catch(() => undefined);
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
   * U20(PLAN-UI §10): 한마디 더 — 영수증의 상자가 달리는 말. 답하기와 같은
   * 길(commentOnIssue)을 코멘트 id 없이 걷는다: 본문은 제출 확인의 한마디와
   * 같은 꼴(`> 한마디:` 인용 줄 + 대리 표기)로, 열린 요청에만 달린다.
   */
  async noteToDeveloper(text: string): Promise<void> {
    const handoff = this.core.openHandoff;
    if (handoff === null || handoff.state === "merged" || handoff.state === "closed") {
      throw new Error("열린 요청이 없어요 — 제출한 뒤에 보낼 수 있어요");
    }
    const line = noteLine(text.trim());
    if (line === null) {
      throw new Error("보낼 말이 없어요 — 한마디를 적어 주세요.");
    }
    const slug = this.core.repoSlug();
    const client = this.core.gitHubClient?.() ?? null;
    if (!slug || !client) {
      throw new Error("GitHub 에 답할 수 없습니다 — 설정에서 토큰을 확인해 주세요.");
    }
    const body = `${line}\n\n${replyFooter(this.core.authorName?.() ?? null)}`;
    await client.commentOnIssue({ ...slug, number: handoff.number, body });
    // 성공의 흔적 — 제출 기록(원장의 submitTrail)에 한 줄. 실패하면 남지
    // 않는다: 기록은 사용자가 한 말이 아니라 간 말의 영수증이다.
    this.deps.appendSubmitLog?.(SUBMIT_LOG_TEXT.noteSent);
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
  /**
   * 넘기기가 성공하면 서 있던 `submit:pr` 알림을 거둔다 — 알림이 영원히
   * 남지 않게 하는 풀림의 한 길(PLAN L11).
   */
  resolveNotice?(key: "submit:pr"): void;
  /**
   * 한마디 더(U20 · PLAN-UI §10) — 성공이 제출 기록(원장의 submitTrail)에
   * 남기는 줄. fleet 이 감독자의 원장으로 잇는다; 없으면(단독 구성 · 시험)
   * 기록 없이 보내기만 한다.
   */
  appendSubmitLog?(text: string): void;
}
