import { z } from "zod";
import type { DaemonStatus, ProjectSummary } from "./project.js";
import type { DiffStatus, RepoStatus } from "./repo.js";
import type { ChatEvent } from "./session.js";
import { effortLevelSchema, permissionModeSchema, type SessionState } from "./shared.js";

// ---------------------------------------------------------------------------
// Client -> daemon
// ---------------------------------------------------------------------------

const withId = { id: z.string().min(1) };

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
    /** Optional base64 image attachments — pasted or dropped pictures. */
    images: z.array(z.object({ mediaType: z.string().min(1), data: z.string().min(1) })).optional(),
    /**
     * The screens this turn points at — pins and 화면 캡처 (게이트 재배선
     * 2026-09-17). The screen gate re-opens exactly these after the turn;
     * a turn that names none is a turn the gate skips.
     */
    pins: z.array(z.object({ screen: z.string().min(1), state: z.string().nullable() })).optional(),
  }),
  z.object({
    ...withId,
    type: z.literal("preview.capture"),
    /** The screen to shoot; omitted shoots the view the preview shows now. */
    route: z.string().min(1).optional(),
    state: z.string().nullable().optional(),
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
   * 되감기 (PLAN D95): discard the k-th answer and receive it again — files
   * (the turn's checkpoint) and memory (a truncating fork) go back together.
   * `turn` is the 1-based answer index; `text` is what goes out again (the
   * same words for 다시 요청, edited words for 고쳐서 다시 보내기). The reply
   * carries the NEW session id.
   */
  z.object({
    ...withId,
    type: z.literal("session.rewind"),
    sessionId: z.string().min(1),
    turn: z.number().int().positive(),
    text: z.string().min(1),
    images: z.array(z.object({ mediaType: z.string().min(1), data: z.string().min(1) })).optional(),
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
    type: z.literal("session.setPermissionMode"),
    sessionId: z.string().min(1),
    mode: permissionModeSchema,
  }),
  z.object({
    ...withId,
    /**
     * The provider's own mode ids (ACP `session/set_mode` or a `mode`
     * config option) — `session.setPermissionMode` covers only the Claude
     * enum, so drivers with their own modes ride this message.
     */
    type: z.literal("session.setMode"),
    sessionId: z.string().min(1),
    mode: z.string().min(1),
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
   */
  z.object({
    ...withId,
    type: z.literal("project.create"),
    name: z.string().min(1).max(64),
    repoUrl: z.string().min(1).nullable(),
    /** What a handoff PR will target. Defaults to `main`. */
    baseBranch: z.string().min(1).max(128).optional(),
    /**
     * The planner saw this repo's `install`/`preview` commands and said they
     * may run on this machine. Absent means not yet approved: the workspace
     * stops after clone with errorKind `commands` until an update approves.
     */
    approveCommands: z.boolean().optional(),
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
    /** Approves this repo's commands post-hoc — the error card's button. */
    approveCommands: z.boolean().optional(),
    /** 프로젝트별 지침(설정 문서 P1#8) — 세션의 시스템 프롬프트에 붙는다. */
    instructions: z.string().max(10_000).nullable().optional(),
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
  /**
   * 레포 최신화: bring the clone current with the remote without the planner
   * reading git. Unsaved work rides along (stashed, moved onto, replayed);
   * what git cannot combine by itself briefs the named session as its next
   * turn, exactly like a failing gate. Resolves with the resulting
   * `RepoStatus`.
   */
  z.object({
    ...withId,
    type: z.literal("repo.refresh"),
    /** Live thread that receives a conflict brief; absent = report only. */
    sessionId: z.string().min(1).optional(),
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
    kind: z.enum(["install-claude", "login-claude", "install-git", "install-node", "install-pnpm"]),
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
   * `.colo-design/shots/<route>--<state>.<ext>` — out of the handoff branch
   * with `git show`, so the frozen stage shows what was sent even after the
   * worktree moved on. Null when the shot was never committed.
   */
  z.object({
    ...withId,
    type: z.literal("repo.handoffShot"),
    /** The screen's route — the pin's `data-screen` id, slash-restored. */
    route: z.string().min(1),
    /** The state the shot was captured in — 표식 없는 화면의 커밋은 null. */
    state: z.string().min(1).nullable(),
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
   * 변경 버리기 (PLAN D53): throw away every unsaved worktree change — the
   * paths a 저장 would have carried, and only paths inside the clone. The
   * confirmation dialog is the UI's job; this side just refuses to reach
   * outside the repo.
   */
  z.object({ ...withId, type: z.literal("repo.discard") }),
  /**
   * The turn-start snapshots (PLAN D52): one per 화면 turn, oldest last.
   * The planner sees these as `이 답변 이전으로 되돌리기` on a turn card.
   */
  z.object({ ...withId, type: z.literal("repo.checkpoints") }),
  /**
   * Put the worktree back the way it stood when a turn started (PLAN D52).
   * Only paths the write policy allows move; files the snapshot never had
   * are removed.
   */
  z.object({
    ...withId,
    type: z.literal("repo.checkpoint.restore"),
    /**
     * The `id` of one `repo.checkpoints` entry. Named apart from the
     * correlation `id` on purpose (실사 결함): one field carrying both erased
     * the reply's return address — the daemon did the restore, the reply
     * matched no pending call, and every 되돌리기 timed out as
     * "daemon did not respond" while the worktree had already moved.
     */
    checkpoint: z.string().min(1),
  }),
  /**
   * 잠깐 치워두기: snapshot every unsaved worktree change into the ONE shelf
   * ref and clear the worktree through 버리기's path rule. One slot — a
   * second call is refused until the first is 꺼내기'd. The clear, not the
   * snapshot, is the promise: a parked work must never read as lost.
   */
  z.object({ ...withId, type: z.literal("repo.shelve") }),
  /**
   * 치워둔 작업 꺼내기: re-apply the shelved work on top of whatever HEAD is
   * now — a 3-way apply, never a rewind. Refuses while the worktree is
   * dirty; a conflict lands as Claude's brief in the named thread and the
   * slot survives until the cleanup drops it.
   */
  z.object({
    ...withId,
    type: z.literal("repo.unshelve"),
    /** Where a conflict brief goes; absent, the refusal line is the reply. */
    sessionId: z.string().min(1).optional(),
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
   * Repos the stored token can reach, most recently pushed first. Answered
   * from a short-lived cache; `refresh` re-asks GitHub. This is the project
   * picker's list, with a manual url as the fallback for what a token
   * cannot see.
   */
  z.object({
    ...withId,
    type: z.literal("github.repos.list"),
    refresh: z.boolean().optional(),
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
   * `screen`/`state` (재설계 C6). Nothing in the tool reads the store back —
   * the pins were consumed in the conversation; the pull request body is the
   * one reader, for the developer who never saw that conversation.
   */
  z.object({
    ...withId,
    type: z.literal("comments.record"),
    items: z
      .array(
        z.object({
          /** The screen the pin sat on — `[data-screen]` or the pathname id. */
          screen: z.string().min(1),
          /** The screen state the pin sat on — 표식 없는 페이지의 핀은 null. */
          state: z.string().min(1).nullable(),
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
