import { z } from "zod";
import type { AgentInstallKind, DaemonStatus, ProjectSummary } from "./project.js";
import type { DiffStatus, RepoStatus } from "./repo.js";
import type { ChatEvent } from "./session.js";
import { effortLevelSchema, type SessionState } from "./shared.js";

// ---------------------------------------------------------------------------
// Client -> daemon
// ---------------------------------------------------------------------------

/**
 * 모든 클라이언트 명령의 신원 — 응답 상관이자 **멱등 키**. 데몬은 같은 id 의
 * 실행을 한 번만 하고(command-dedupe.ts), 끝난 실행의 답(ok·error 다 함께)을
 * 기억해 재전송에 되돌려준다. 그러므로 id 는 재시도 사이에 바뀌지 않는 값이어야
 * 하고, 다른 명령은 다른 id 를 쓴다.
 */
const withId = { id: z.string().min(1) };

/**
 * 핀 하나의 정체 (빠른 수정, 2026-09-20): what the daemon greps the clone
 * with. A comments-marked turn already NAMES each pinned element in prose the
 * planner reads; this is the same identity as data, so the daemon can find
 * `파일 후보` lines before the turn reaches the agent — the search the
 * agent's first tool calls would otherwise repeat. `id` joins the hint to
 * the turn marker's item rows(2026-09-21 레포 마커 철거 — `data-colo-src`
 * 의 `file` 힌트는 폐지했다; 정체는 글자·owners·testId 뿐이다).
 */
const sessionPinHintSchema = z.object({
  id: z.string().min(1),
  /** The element's own text — a JSX-text or string-literal needle. */
  text: z.string().optional(),
  /** React component names, nearest first (the pin envelope's own order). */
  owners: z.array(z.string().min(1)).optional(),
  /** The repo's test id, when the element carries one. */
  testId: z.string().min(1).optional(),
  /** The pin's screen (route id) — the observed map's key when identity search comes up empty. */
  screen: z.string().min(1).optional(),
});

export type SessionPinHint = z.infer<typeof sessionPinHintSchema>;

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...withId, type: z.literal("daemon.status") }),
  z.object({
    ...withId,
    type: z.literal("session.list"),
    limit: z.number().int().positive().max(200).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.locate"),
    sessionId: z.string().min(1),
  }),
  z.object({
    ...withId,
    type: z.literal("session.history"),
    sessionId: z.string().min(1),
  }),
  z.object({
    ...withId,
    type: z.literal("session.create"),
    /** Which agent provider runs the thread; omitted = the daemon default. */
    provider: z.string().min(1).optional(),
    /** Model the query starts on (SDK alias or id); omitted = CLI default. */
    model: z.string().min(1).optional(),
    /** Reasoning effort the query starts on; omitted = CLI default. */
    effort: effortLevelSchema.optional(),
    /**
     * A name for a thread the tool is opening on the planner's behalf. The
     * first turn names an unnamed thread, so a handoff — whose first turn is
     * a sentence the tool wrote — would otherwise be titled with the file
     * path inside it.
     */
    title: z.string().min(1).max(80).optional(),
    /** Continue an existing thread by id. */
    resume: z.string().optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.send"),
    sessionId: z.string().min(1),
    text: z.string(),
    /**
     * Optional base64 attachments — pasted or dropped files. `mediaType`
     * decides the delivery: `image/*` rides as a vision block, decodable
     * text is inlined into the turn, and anything else is staged on disk
     * for the agent to read.
     */
    attachments: z
      .array(z.object({ name: z.string().min(1), mediaType: z.string(), data: z.string().min(1) }))
      .optional(),
    /**
     * The screens this turn points at — pins and 화면 캡처 (게이트 재배선
     * 2026-09-17). The screen gate re-opens exactly these after the turn;
     * a turn that names none is a turn the gate skips.
     */
    pins: z.array(z.object({ screen: z.string().min(1) })).optional(),
    /**
     * The pins' element identity (빠른 수정, 2026-09-20) — the daemon greps
     * the clone with this and appends `파일 후보:` to each block of the
     * marked turn before the agent reads it. Absent on plain sends.
     */
    pinHints: z.array(sessionPinHintSchema).optional(),
    /**
     * 도는 턴에 온 말의 길. `queue`(기본)는 대기 줄에 세워 다음 턴에
     * 보내고, `steer`는 도는 턴에 그대로 실어 보낸다 — 드라이버가 그 길을
     * 내주지 않으면(codex 외) 데몬이 대기 줄로 물러난다.
     */
    mode: z.enum(["queue", "steer"]).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("preview.screenCheck"),
    /**
     * The screen a held pane error report names — re-opened in the
     * daemon's isolated verification window (게이트와 같은 드라이버·같은
     * 판정) so the pane can tell a fixed transient from a real break.
     */
    route: z.string().min(1),
  }),
  z.object({
    ...withId,
    type: z.literal("session.interrupt"),
    sessionId: z.string().min(1),
  }),
  /**
   * 대기 줄 다루기 (PLAN D86 의 확장). `remove` takes one waiting send back
   * out of the daemon's wait room and returns its original payload, so the
   * composer can put the words — and the attachments — back in the field.
   * `sendNow` cuts the running turn and delivers THAT send first; the rest
   * of the room keeps waiting for the turn it starts to end.
   */
  z.object({
    ...withId,
    type: z.literal("session.queue.remove"),
    sessionId: z.string().min(1),
    itemId: z.string().min(1),
  }),
  z.object({
    ...withId,
    type: z.literal("session.queue.sendNow"),
    sessionId: z.string().min(1),
    itemId: z.string().min(1),
  }),
  /**
   * The lost room (queue.lost) — `takeDropped` hands one lost send back
   * whole, bytes included when they survived the persist cap; `dismiss`
   * lets it go. Both work whether or not the session is live: the store is
   * the daemon's, keyed by session id.
   */
  z.object({
    ...withId,
    type: z.literal("session.queue.takeDropped"),
    sessionId: z.string().min(1),
    itemId: z.string().min(1),
  }),
  z.object({
    ...withId,
    type: z.literal("session.queue.dismissDropped"),
    sessionId: z.string().min(1),
    itemId: z.string().min(1),
  }),
  z.object({
    ...withId,
    type: z.literal("session.close"),
    sessionId: z.string().min(1),
  }),
  /**
   * 대화 분기: keep this answer and everything before it as the memory of a
   * NEW conversation — the current one stays as it is. `turn` is the 1-based
   * answer index (되감기의 셈과 같다). Files are not touched: one worktree
   * cannot hold two file states, so a branch carries the memory cut alone.
   * The reply carries the NEW session id and whether its memory survived
   * (false = the provider cannot fork the transcript, so the branch starts
   * empty — 되감기의 폴백과 같은 정직함).
   */
  z.object({
    ...withId,
    type: z.literal("session.branch"),
    sessionId: z.string().min(1),
    turn: z.number().int().positive(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.delete"),
    sessionId: z.string().min(1),
  }),
  /**
   * A project's every conversation at once — the tree's 대화 모두 지우기.
   * `slug` names the project so the delete lands in that clone's transcript
   * store even when it is not the active one (session.delete alone resolves
   * inside the active clone).
   */
  z.object({
    ...withId,
    type: z.literal("session.deleteAll"),
    slug: z.string().min(1),
  }),
  z.object({
    ...withId,
    type: z.literal("session.setModel"),
    sessionId: z.string().min(1),
    /** `null` returns the model to the CLI default. */
    model: z.string().min(1).nullable(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.setEffort"),
    sessionId: z.string().min(1),
    /** `null` clears the override. */
    effort: effortLevelSchema.nullable(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.setFastMode"),
    sessionId: z.string().min(1),
    /** 빠르게: 같은 모델을 더 빠른 응답으로 돌린다. 세션의 자세다. */
    fast: z.boolean(),
  }),
  z.object({
    ...withId,
    type: z.literal("session.selectors"),
    sessionId: z.string().min(1),
  }),
  z.object({
    ...withId,
    type: z.literal("session.commands"),
    sessionId: z.string().min(1),
  }),
  /**
   * The palette with no thread open. The daemon answers from its own CLI
   * probe (one boot, cached), so an empty workspace still reads like the
   * terminal's `/`.
   */
  z.object({ ...withId, type: z.literal("cli.commands") }),
  z.object({
    ...withId,
    type: z.literal("session.contextUsage"),
    sessionId: z.string().min(1),
  }),
  /**
   * 이 작업만 중지 (PLAN D101): kill ONE background task — a runaway command
   * or a subagent — without interrupting the turn that spawned it. The id is
   * the one `task.start` carried.
   */
  z.object({
    ...withId,
    type: z.literal("session.stopTask"),
    sessionId: z.string().min(1),
    taskId: z.string().min(1),
  }),
  /**
   * 뒤로 보내기 (PLAN D101): move the task a tool call is blocking on into the
   * background so the turn carries on. The reply says whether anything moved.
   */
  z.object({
    ...withId,
    type: z.literal("session.backgroundTask"),
    sessionId: z.string().min(1),
    toolUseId: z.string().min(1),
  }),
  z.object({
    ...withId,
    type: z.literal("repo.files"),
    /** Substring filter for @-mention autocomplete. */
    query: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("permission.respond"),
    requestId: z.string().min(1),
    decision: z.enum(["allow", "allowAlways", "deny"]),
    /** Reason shown to Claude on deny. */
    message: z.string().optional(),
    /** Edited tool input on allow. */
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("question.respond"),
    requestId: z.string().min(1),
    /** question text -> selected label(s) */
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    /** Freeform reply instead of answering the structured questions. */
    response: z.string().optional(),
    /**
     * 선택 옆의 메모 (PLAN D96): what the planner wrote about their pick,
     * keyed by the question's own text, together with the preview they were
     * looking at when they picked. Rides the tool's own `annotations` field
     * back to Claude — the words are the point, the preview is the evidence.
     */
    annotations: z
      .record(
        z.string(),
        z.object({ preview: z.string().optional(), notes: z.string().optional() }),
      )
      .optional(),
  }),
  /**
   * The registry: every project plus which one is active. Cheap and
   * side-effect free — the switcher asks for it on every connect.
   */
  z.object({ ...withId, type: z.literal("project.list") }),
  /**
   * Registers a project and brings it up: clones the repo, installs when the
   * dependency hash moved, starts the preview command. Progress arrives as
   * `repo.status`; the reply is the created project.
   *
   * 선택 필드가 늘어나도 선로 버전은 오르지 않는다 — 스키마가 모르는 필드는
   * 버리고, 앱과 데몬은 함께 배포된다.
   */
  z.object({
    ...withId,
    type: z.literal("project.create"),
    name: z.string().min(1).max(64),
    repoUrl: z.string().min(1).nullable(),
    /** What a handoff PR will target. Defaults to `main`. */
    baseBranch: z.string().min(1).max(128).optional(),
    /**
     * E4(초대 v2): 넘긴 요청의 리뷰를 부탁할 개발자들(GitHub 로그인).
     * 초대 파일이 실어 오고, 넘기기가 GitHub 에 요청한다.
     */
    reviewers: z.array(z.string().min(1).max(80)).max(10).optional(),
    /**
     * The planner saw this repo's `install`/`preview` commands and said they
     * may run on this machine. Absent means not yet approved: the workspace
     * stops after clone with errorKind `commands` until an update approves.
     */
    approveCommands: z.boolean().optional(),
    /**
     * false 면 등록만 하고 전환·내려받기를 하지 않는다 — 초대장이 여러 프로젝트를
     * 한 번에 등록할 때 화면이 튀지 않고 보던 미리보기를 끄지 않게. 활성 프로젝트가
     * 하나도 없으면 무시하고 연다.
     */
    activate: z.boolean().optional(),
    /** 프로젝트별 지침(설정 문서 P1#8) — project.update 의 것과 같은 한도·뜻. */
    instructions: z.string().max(10_000).optional(),
    /**
     * 초대 v4(PLAN 단계 5): 개발자가 실어 보낸 새 대화의 처음 값 — 칩이나
     * 선로가 말하지 않았을 때만 쓰인다.
     */
    defaults: z
      .object({
        provider: z.string().min(1).max(64).optional(),
        model: z.string().min(1).max(64).optional(),
        effort: effortLevelSchema.optional(),
      })
      .optional(),
    /** 초대 v4: 사이클의 수명 규칙 — 없으면 각 소비자의 기본값. */
    lifecycle: z
      .object({
        deleteMergedBranches: z.boolean().optional(),
        keepRejectedDays: z.number().int().min(1).max(365).optional(),
        autoReply: z.boolean().optional(),
        submitFromChat: z.boolean().optional(),
      })
      .optional(),
  }),
  /**
   * Switches which project everything else means. The outgoing project's
   * preview server stops before the incoming one starts — two repos may
   * declare the same `preview.port`, so they can never run at once.
   */
  z.object({
    ...withId,
    type: z.literal("project.activate"),
    slug: z.string().min(1).max(64),
  }),
  z.object({
    ...withId,
    type: z.literal("project.update"),
    slug: z.string().min(1).max(64),
    name: z.string().min(1).max(64).optional(),
    repoUrl: z.string().min(1).nullable().optional(),
    baseBranch: z.string().min(1).max(128).optional(),
    /** E4(초대 v2): 리뷰를 부탁할 개발자들 — 프로젝트 설정에서도 고친다. */
    reviewers: z.array(z.string().min(1).max(80)).max(10).nullable().optional(),
    /** Approves this repo's commands post-hoc — the error card's button. */
    approveCommands: z.boolean().optional(),
    /** 프로젝트별 지침(설정 문서 P1#8) — 세션의 시스템 프롬프트에 붙는다. */
    instructions: z.string().max(10_000).nullable().optional(),
    /** 초대 v4(PLAN 단계 5): 개발자의 값이라 덮는다 — null 이면 지운다. */
    defaults: z
      .object({
        provider: z.string().min(1).max(64).optional(),
        model: z.string().min(1).max(64).optional(),
        effort: effortLevelSchema.optional(),
      })
      .nullable()
      .optional(),
    lifecycle: z
      .object({
        deleteMergedBranches: z.boolean().optional(),
        keepRejectedDays: z.number().int().min(1).max(365).optional(),
        autoReply: z.boolean().optional(),
        submitFromChat: z.boolean().optional(),
      })
      .nullable()
      .optional(),
  }),
  /**
   * Forgets a project. Its folder survives unless `deleteFiles` — unpushed
   * screen work lives in the clone, and a mis-click must not take it.
   */
  z.object({
    ...withId,
    type: z.literal("project.remove"),
    slug: z.string().min(1).max(64),
    deleteFiles: z.boolean().optional(),
  }),
  /**
   * Opens the project's clone folder in the OS file manager — the hover
   * card's 폴더 열기 row. The daemon spawns the platform's opener detached;
   * the reply only says the request was accepted.
   */
  z.object({
    ...withId,
    type: z.literal("project.openFolder"),
    slug: z.string().min(1).max(64),
  }),
  /** Connected repo state. Reads disk and process state; no side effects. */
  z.object({ ...withId, type: z.literal("repo.status") }),
  /**
   * Idempotent bootstrap of the connected repo: clone when missing, pull,
   * install when the dependency hash moved, start the repo's preview
   * command. Resolves when it settles; progress arrives
   * as `repo.status`.
   */
  z.object({
    ...withId,
    type: z.literal("repo.sync"),
    /**
     * 다시 시작: when the declared preview port is already taken, kill the
     * program holding it instead of reporting. Only the error screen's
     * button sends this — a plain sync must never kill.
     */
    force: z.boolean().optional(),
  }),
  /** Uncommitted worktree changes vs HEAD, for the publish review panel. */
  z.object({ ...withId, type: z.literal("diff.get") }),
  /** Runs the machine-wide onboarding checks; read-only. `provider` picks the agent gate. */
  z.object({
    ...withId,
    type: z.literal("onboarding.check"),
    provider: z.string().min(1).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("onboarding.fix"),
    kind: z.enum([
      "install-claude",
      "install-codex",
      "login-claude",
      "install-git",
      "install-node",
      "install-pnpm",
    ]),
    /**
     * 로그인 고침이 어느 에이전트의 것인지(P1-1) — 각 드라이버가 자기 로그인
     * 명령을 선언한다(loginCommand). 없으면 claude 게이트의 역사적 기본.
     */
    provider: z.string().min(1).optional(),
  }),
  /**
   * 로그인 코드 붙여넣기 (P1-1): 웹이 받은 코드를 데몬이 로그인 자식의 stdin
   * 으로 흘려 보낸다. 진행 중인 로그인이 없으면 데몬이 한국어로 거절한다.
   */
  z.object({
    ...withId,
    type: z.literal("agent.login.code"),
    code: z.string().min(1).max(400),
  }),
  /**
   * 저장 (PLAN D5[넘기기]): gate, commit and push the reviewed worktree diff onto the
   * project's own `colo-design/…` branch, created on the first save of a cycle.
   * The base branch is never written to — a developer receives this work as a
   * pull request, not as a push past them.
   */
  z.object({
    ...withId,
    type: z.literal("repo.save"),
    /** Commit message; the daemon falls back to a Korean default. */
    message: z.string().min(1).max(500).optional(),
    /**
     * Live session that receives the failing gate's output as a user turn,
     * so Claude can fix the repo and the planner can save again.
     */
    sessionId: z.string().min(1).optional(),
  }),
  /**
   * 개발자에게 넘기기: run `build`, then open (or update) the pull request for
   * the current branch. Subsequent saves accumulate on the same PR.
   */
  z.object({
    ...withId,
    type: z.literal("repo.handoff"),
    /** PR title; the daemon proposes one from the branch's commits. */
    title: z.string().min(1).max(200).optional(),
    /** PR body; the daemon proposes one naming the screens behind the work. */
    body: z.string().max(20_000).optional(),
    sessionId: z.string().min(1).optional(),
  }),
  /**
   * Re-read the open pull request from GitHub: merged, closed, or still open.
   * Asked for rather than polled — a timer would hit the API every minute for
   * a state that only moves when a human acts on it.
   */
  z.object({ ...withId, type: z.literal("repo.handoffStatus") }),
  /**
   * 보낸 화면 동결: read one committed handoff capture —
   * `.colo-design/shots/<route>.<ext>` — out of the handoff branch
   * with `git show`, so the frozen stage shows what was sent even after the
   * worktree moved on. Null when the shot was never committed.
   */
  z.object({
    ...withId,
    type: z.literal("repo.handoffShot"),
    /** The screen's route — the pin's pathname id, slash-restored. */
    route: z.string().min(1),
  }),
  /**
   * 시점 빌드 재현: the handed-off moment's REAL
   * build. The daemon checks the open handoff's branch tip out into a
   * throwaway worktree and serves the repo's own preview command on a second
   * port. Absence answers as a `ready:false` info (HandoffPreviewInfo), not
   * an error — the committed capture is the frozen stage's floor.
   */
  z.object({
    ...withId,
    type: z.literal("repo.handoffPreview"),
    /**
     * The conversation asking — its close is what reaps the worktree and
     * the port, so the build outlives no conversation that nobody reads.
     */
    sessionId: z.string().min(1).optional(),
  }),
  /**
   * 개발자에게 넘기기의 초안 (비개발자 넘기기): the daemon asks Claude one
   * turn — no tools, an 8-second leash — for the title and the paragraph a
   * developer reads first, from the cycle's own save memos and changed
   * files. Empty strings mean "use the browser's proposal", which is what
   * the dialog already opens with. Cached per cycle tip, so reopening the
   * dialog is free.
   */
  z.object({ ...withId, type: z.literal("repo.handoffDraft") }),
  /**
   * 저장 기록 (PLAN D53): the cycle's commits, `git log <base>..HEAD`. This
   * is what the `저장 기록` drawer lists — messages and times, no git words.
   */
  z.object({ ...withId, type: z.literal("repo.history") }),
  /**
   * 되돌리기 (PLAN D53): bring the worktree back to a saved point as a NEW
   * commit on the cycle branch — never reset · revert · force-push, because
   * a developer may be reading that branch right now. Progress rides the
   * same `diff.status` stream a 저장 uses (`pushing → published`).
   */
  z.object({
    ...withId,
    type: z.literal("repo.restore"),
    /** A sha from `repo.history`. */
    sha: z.string().min(1),
  }),
  /**
   * Store (or clear) the machine-wide GitHub token — the one gate of the
   * onboarding list the planner answers with a value rather than an install.
   * The daemon saves it to the OS credential store and never echoes it back;
   * the reply is the recomputed `github` onboarding step.
   */
  z.object({
    ...withId,
    type: z.literal("github.token.set"),
    /** `null` forgets the stored token. */
    token: z.string().min(1).nullable(),
  }),
  /**
   * 개발자 에스컬레이션 (슬라이스 5): AI 가 고칠 수 없는 환경 실패를 도구
   * 밖(Slack)으로 보내는 길. 두 가지 붙는 법 — incoming webhook URL 하나,
   * 또는 bot token + 채널. 비밀은 GitHub 토큰과 같은 저장소에 살고 화면으로
   * 절대 돌아오지 않는다 — 상태는 `DaemonStatus.escalationConfigured` 한 단어다.
   */
  z.object({
    ...withId,
    type: z.literal("escalation.set"),
    /** `null` forgets the stored config. */
    config: z
      .union([
        z.object({ kind: z.literal("webhook"), url: z.string().min(1).max(2000) }),
        z.object({
          kind: z.literal("bot"),
          token: z.string().min(1).max(500),
          channel: z.string().min(1).max(200),
        }),
      ])
      .nullable(),
  }),
  /** Sends one test message through the stored config — 설정의 시험 버튼. */
  z.object({ ...withId, type: z.literal("escalation.test") }),
  /**
   * 사용자의 `개발자 부르기`(P3-3) — 막다른 카드에서 사람이 직접 누르는 길.
   * 설정의 시험 버튼과 같은 채널을 쓰되, 문구는 화면이 짓는다: 어느
   * 프로젝트의 어느 실패인지는 화면만 알고, 데몬은 그것을 조립할 자리가 없다.
   * 미설정이면 거절 — 화면은 `escalationConfigured` 로 버튼을 미리 잠근다.
   */
  z.object({ ...withId, type: z.literal("escalation.notify"), text: z.string().min(1).max(4000) }),
  /**
   * 설정창의 저장 메모 담당: 빈 메모의 커밋 문장과 넘기기 초안을 쓰는
   * 에이전트. `null` 은 자동(기본) — machine-provider 의 등록 순서 규칙.
   * 저장 시점에 검사해 못 쓰는 선택은 한국어 한 줄로 거절한다.
   */
  z.object({
    ...withId,
    type: z.literal("machine.set"),
    provider: z.string().min(1).max(64).nullable(),
  }),
  /**
   * 넘긴 요청에 적을 작성자 이름(P1-3): 모든 요청이 봇 계정으로 열리므로
   * 본문의 `> 작성:` 줄과 커밋 이름이 유일한 구분이다. `null` 이면 지운다.
   */
  z.object({
    ...withId,
    type: z.literal("machine.author.set"),
    name: z.string().min(1).max(80).nullable(),
  }),
  /**
   * One repo, judged before any clone: does package.json carry a dev-family
   * script, may this token open pull requests against it, and what branch
   * would it target.
   */
  z.object({
    ...withId,
    type: z.literal("github.repo.inspect"),
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  /**
   * 코멘트 기록 (PLAN D57): the pins the planner sent from the preview land
   * in the project's own `comments.json` — every row is born resolved. The
   * record's clock is ACCEPTANCE, not delivery (커미티 판정 3, 2026-09-14):
   * `markSent` runs once the daemon has taken the turn, so a send that later
   * drops from the waiting room (PLAN D86) keeps its rows here — the words
   * come back to the composer as 전달되지 못한 말, and this log is the
   * planner's "what I asked", not a courier's receipt. The store is an
   * append-only log: a second send of the same words is a second request,
   * and both stay. A batch may span screens — each item carries its own
   * `screen` (재설계 C6). Nothing in the tool reads the store back —
   * the pins were consumed in the conversation; the pull request body is the
   * one reader, for the developer who never saw that conversation.
   */
  z.object({
    ...withId,
    type: z.literal("comments.record"),
    items: z
      .array(
        z.object({
          /** The screen the pin sat on — the pathname id. */
          screen: z.string().min(1),
          /**
           * The pin's overlay UUID (커미티 2차 판정 5): the one stable key the
           * pin is born with — chip, badge, marker item and store row all
           * meet on it. Absent on sends from older clients; the daemon then
           * mints one, as it always did.
           */
          id: z.string().min(1).optional(),
          /**
           * What the planner wrote on THIS pin — its memo, nothing else
           * (커미티 2차 판정 3). Empty is a real value: a pin sent without a
           * memo, displayed as (메모 없음). The turn's sentence used to be
           * borrowed into every memo-less row, which made the log — and the
           * PR body — count one sentence N times.
           */
          text: z.string(),
          /** The commented element's own text, as the overlay captured it. */
          elementText: z.string(),
          /**
           * What the planner asked OF this pin (재설계 C10, 커미티 2차 판정 4):
           * a change (default — absent reads as `change`) or a question.
           * Without it the PR body titles a planner's question a 수정 요청.
           */
          intent: z.enum(["change", "question"]).optional(),
          /**
           * Where the pin sat (PLAN D78): the identity the overlay resolved
           * for the element, recorded so the pin can be drawn again — the
           * comment lives on the screen, not only in this list. Old rows
           * without it read as 자리 없는 코멘트.
           */
          element: z
            .object({
              component: z.string(),
              path: z.string(),
              rect: z.object({
                x: z.number(),
                y: z.number(),
                width: z.number(),
                height: z.number(),
              }),
            })
            .optional(),
        }),
      )
      .min(1),
  }),
  /**
   * 답하기 (PLAN D88): the planner's answer to ONE developer comment, from
   * inside the tool. The daemon picks the endpoint by the id's cached kind —
   * an inline thread's replies, or an issue comment on the pull request.
   */
  z.object({
    ...withId,
    type: z.literal("comments.reply"),
    /** `reviewId`, never `id`: the wire's `id` is the CORRELATION id every
        reply echoes — a payload field named `id` would overwrite it and the
        reply would land on nobody. */
    reviewId: z.number(),
    body: z.string().min(1),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Daemon -> client
// ---------------------------------------------------------------------------

export interface PermissionSuggestion {
  destination: string;
  label: string;
  raw: unknown;
}

interface AskQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}

export type ServerMessage =
  | { type: "hello"; protocolVersion: number; status: DaemonStatus }
  | { type: "ok"; id: string; data: unknown }
  | { type: "error"; id: string | null; message: string; code?: string }
  | { type: "session.event"; sessionId: string; event: ChatEvent }
  | {
      type: "session.state";
      sessionId: string;
      state: SessionState;
      detail?: string;
      /**
       * 이 턴이 시작한 시각 (epoch ms) — 도는 턴이 있을 때만 붙는다. 진행
       * 시계가 읽는 하나의 진실이다: 시작을 창이 아니라 데몬이 기억하므로,
       * 새로고침해도 두 번째 창에서도 같은 초를 센다. 확인 카드를 기다리는
       * 동안에도 살아 있다 — 사람이 기다린 시간도 그 요청의 시간이다.
       */
      startedAt?: number;
    }
  | {
      type: "permission.request";
      requestId: string;
      sessionId: string;
      toolName: string;
      input: unknown;
      suggestions: PermissionSuggestion[];
      /**
       * 이 요청이 답 없이는 일이 못 가는가 — 도구 호출이 이 응답을 기다리며
       * 멈춰 있는가. 알림 위계(조용한 로그 → 뱃지 → 네이티브 알림)의 세 번째
       * 단계는 이 판정만 읽는다: 판정은 데몬이 내리고, 화면은 데이터로
       * 분기한다(홈 계획 P3-3).
       */
      blocking?: boolean;
      /** 요청이 만들어진 시각 (epoch ms) — 홈 카드의 "N분 전"이 읽는다. */
      requestedAt?: number;
    }
  /**
   * 에이전트 로그인의 진행 (P1-1): 데몬이 파이프로 띄운 로그인 CLI 가 내놓은
   * 주소 — 앱은 브라우저로 열어 주고, `wantsCode` 일 때만 코드 붙여넣기 칸을
   * 보인다(claude 는 코드를 stdin 으로 받고, codex 는 콜백만 기다린다).
   * 주소보다 코드 프롬프트가 늦게 오면 같은 판이 다시 방송된다.
   */
  | { type: "agent.login.url"; url: string; wantsCode: boolean }
  /**
   * 로그인의 끝(P1-1): ok 면 클라이언트가 게이트를 다시 묻고, 아니면 detail
   * 이 이유로 선다(자식의 마지막 출력 줄).
   */
  | { type: "agent.login.done"; ok: boolean; detail: string }
  /**
   * 에이전트 설치의 진행(1단계) — 데몬이 끝까지 지켜보는 설치가 내놓은 마지막
   * 의미 있는 줄. PATH 안내 문단은 앱이 절대 경로로 찾으므로 실리지 않는다.
   */
  | { type: "onboarding.install.progress"; kind: AgentInstallKind; line: string }
  /**
   * 설치의 끝(1단계): ok 면 클라이언트가 게이트를 다시 묻고, 아니면 detail 이
   * 이유로 선다. 프로토콜 버전은 올리지 않는다 — 앱과 데몬이 함께 배포된다.
   */
  | { type: "onboarding.install.done"; kind: AgentInstallKind; ok: boolean; detail: string }
  | {
      type: "question.request";
      requestId: string;
      sessionId: string;
      questions: AskQuestion[];
      /** permission.request 의 `blocking` 과 같은 판정, 같은 소비자. */
      blocking?: boolean;
      /** permission.request 의 `requestedAt` 과 같은 시계. */
      requestedAt?: number;
    }
  | { type: "status"; status: DaemonStatus }
  | { type: "repo.status"; status: RepoStatus }
  | { type: "diff.status"; status: DiffStatus }
  /**
   * The registry moved: a project was created, renamed, removed, or activated.
   * Every open client re-points at once — two windows on one daemon must never
   * disagree about which project they are showing.
   */
  | {
      type: "project.changed";
      projects: ProjectSummary[];
      activeSlug: string | null;
    }
  /**
   * 에이전트의 브라우저 도구가 pane의 탭을 조작 중이다(4단계) — 탭 스트립의
   * "에이전트 조작 중" 표시. on:false는 그 조작이 끝났다는 뜻.
   */
  | {
      type: "browser.driving";
      sessionId: string;
      on: boolean;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseClientMessage(
  raw: string,
): { ok: true; value: ClientMessage } | { ok: false; error: string; id: string | null } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: "보낸 메시지를 해석하지 못했습니다 — 잠시 후 다시 시도해 주세요.",
      id: null,
    };
  }
  const id =
    json && typeof json === "object" && typeof (json as { id?: unknown }).id === "string"
      ? (json as { id: string }).id
      : null;
  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      id,
    };
  }
  return { ok: true, value: parsed.data };
}
