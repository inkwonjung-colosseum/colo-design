import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AskQuestion,
  ChatEvent,
  ContextUsage,
  EffortLevel,
  PermissionMode,
  PermissionSuggestion,
  PlanUsage,
  PlanWindow,
  SessionCommand,
  SessionSelectors,
  SessionState,
} from "@colo-design/protocol";
import { PLAN_TOOL, readTurn } from "@colo-design/protocol";
import { containsPath, realpathBestEffort } from "./paths.js";
import type { PreviewTools } from "./preview-tools.js";
import { type SpecFile, saveSpecFiles } from "./repo.js";
import { MessageTranslator } from "./translate.js";

/**
 * 중지가 답을 기다리는 유예. 이 안에 CLI 가 control 요청에 답하지 못하면 질의를
 * 강제로 끊는다 — 영원히 매달린 중지 버튼은 버튼이 아니다 (실사 결함).
 */
const INTERRUPT_GRACE_MS = 5_000;
/** close 의 짧은 관대함 — 여러 wedged 세션을 닫아도 종료가 늦어지지 않게. */
const CLOSE_GRACE_MS = 1_000;

/** An async iterable the daemon can push user turns into while the query runs. */
class PushQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    this.buffer.push(message);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const next = this.buffer.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

interface PendingRequest {
  requestId: string;
  kind: "permission" | "question" | "plan";
  toolName: string;
  resolve: (result: PermissionOutcome) => void;
  suggestions: PermissionUpdate[];
  /** Kept so an approval can echo the tool input back without the client resending it. */
  input: Record<string, unknown>;
}

type PermissionOutcome = PermissionResult;

// ---------------------------------------------------------------------------
// 항상 허용 memory (F7)
// ---------------------------------------------------------------------------

/**
 * The signature of one approved call: for Bash the command string, for
 * path-shaped tools the tool + path. Anything else falls back to a stable
 * JSON of the input. 항상 허용 means this exact call never prompts again in
 * this session — a different command or path still does.
 */
export function permissionSignature(toolName: string, input: Record<string, unknown>): string {
  if (typeof input.command === "string" && input.command.trim() !== "") {
    return `${toolName}:command:${input.command}`;
  }
  const path = [input.file_path, input.notebook_path, input.path].find(
    (value) => typeof value === "string" && value.length > 0,
  ) as string | undefined;
  if (path) return `${toolName}:path:${path}`;
  const keys = Object.keys(input).sort();
  return `${toolName}:json:${keys.map((key) => `${key}=${String(input[key])}`).join("|")}`;
}

/** What the session remembers about 항상 허용 answers. */
export class PermissionMemory {
  private readonly signatures = new Set<string>();

  record(toolName: string, input: Record<string, unknown>): void {
    this.signatures.add(permissionSignature(toolName, input));
  }

  allows(toolName: string, input: Record<string, unknown>): boolean {
    return this.signatures.has(permissionSignature(toolName, input));
  }
}

export interface SessionEvents {
  onEvent: (sessionId: string, event: ChatEvent) => void;
  onState: (sessionId: string, state: SessionState, detail?: string) => void;
  onPermissionRequest: (payload: {
    requestId: string;
    sessionId: string;
    toolName: string;
    input: unknown;
    suggestions: PermissionSuggestion[];
  }) => void;
  onQuestionRequest: (payload: {
    requestId: string;
    sessionId: string;
    questions: AskQuestion[];
  }) => void;
}

/**
 * What a session may do to a file its edit tools name, decided by whoever
 * created it:
 *
 * - `allow` — write it without asking (the repo's own working set).
 * - `ask`   — surface a permission card, as any non-edit tool would.
 * - `deny`  — refuse outright, with a Korean reason Claude can read. Used for
 *   files the tool owns and a session must never rewrite.
 */
type WriteDecision = "allow" | "ask" | "deny";
export type WritePolicy = (absolutePath: string) => WriteDecision;

export interface SessionOptions {
  cwd: string;
  claudeExecutable: string;
  /** Resume an existing transcript. */
  resume?: string;
  /**
   * A custom session id — with `resume` + `forkSession` it names the FORK
   * (PLAN D95); without a resume it is what a new session is born as.
   */
  sessionId?: string;
  /** D95: truncating resume → a new session instead of rewriting history. */
  forkSession?: boolean;
  /**
   * Verdict for every edit-class tool call. Defaults to the historical rule:
   * silent inside cwd, a card everywhere else.
   */
  writePolicy?: WritePolicy;
  /**
   * A name for a thread the tool opened on the planner's behalf. The first
   * turn only names an UNNAMED thread, so a handoff — whose first turn is a
   * sentence this tool wrote, not the planner's — reads as its 기획서 instead
   * of as the file path inside that sentence.
   */
  title?: string;
  /** Model the query starts on (SDK alias or id); omitted = CLI default. */
  model?: string;
  /** Reasoning effort the query starts on; omitted = CLI default. */
  effort?: EffortLevel;
  /** D95: with `resume` — the chain uuid the truncated resume keeps up to. */
  resumeSessionAt?: string;
  /** D95: with `resumeSessionAt` — the discarded turn's prompt uuid. */
  resumeDropsTurn?: string;
  /**
   * The `colo-preview` in-process MCP server (PLAN D61), or null when the
   * daemon runs without a preview driver or the planner turned the tools
   * off. The session only carries it: the capture quota resets here at turn
   * starts, and its lifetime (destroy) belongs to whoever injected the
   * driver.
   */
  previewTools?: PreviewTools | null;
}

/**
 * File-edit tools that `acceptEdits` mode used to silence. Under the pinned
 * `default` mode the CLI asks about them like anything else, so the daemon
 * answers here instead, through the session's own `writePolicy`.
 */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/**
 * git 의 명사는 도구가 합니다 (README · PLAN D5): 커밋과 푸시는 저장·넘기기
 * 버튼의 몫이라, 세션이 직접 만들면 개발자에게 가는 풀 리퀘스트가 도구가
 * 검토하지 못한 역사를 실어 나른다(실측: 핸드오프 브랜치에 무의미한 커밋).
 * 상태 읽기(status·log·diff·fetch)와 충돌 정리(add·stash)는 그대로 —
 * 막는 것은 역사를 쓰는 동사뿐이다.
 */
const GIT_WRITE_REFUSAL =
  "커밋과 푸시는 이 도구가 합니다 — 완성된 화면은 저장 버튼으로, 개발자에게는 넘기기 버튼으로 전달해 주세요.";

function writesGitHistory(command: string): boolean {
  return /\bgit\b/.test(command) && /\b(commit|push)\b/.test(command);
}
/**
 * The name a session carries until its first turn supplies one. Also the
 * sentinel for "nobody has named this yet" — a resumed thread inherits its
 * stored title only while the placeholder is still in place.
 */
export const NEW_SESSION_TITLE = "새 화면";

export class Session {
  readonly id: string;
  readonly cwd: string;
  state: SessionState = "idle";
  permissionMode: PermissionMode = "default";
  /**
   * 계획 모드로 들어가기 전의 작업 모드. 계획은 한 턴의 자세라 승인 순간
   * 여기로 되돌아간다(`respondPermission`) — 승인된 계획 뒤의 편집이 계획
   * 모드의 제약 아래 갇히지 않게. `setPermissionMode` 가 기록하고 지운다.
   */
  modeBeforePlan: PermissionMode | null = null;
  model: string | null = null;
  /** Composer chip selections; `null` = the CLI's own default. */
  private selectedModel: string | null = null;
  private selectedEffort: EffortLevel | null = null;
  lastActivity = Date.now();
  /** Replaced by the first turn's own words; also the "untouched" sentinel. */
  title: string;

  private readonly writePolicy: WritePolicy;
  private readonly previewTools: PreviewTools | null;

  private readonly queue = new PushQueue();
  private readonly alwaysAllowed = new PermissionMemory();
  private readonly translator = new MessageTranslator();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: SessionEvents;
  private run: Query;
  private consumer: Promise<void>;
  private closed = false;
  /**
   * 결함① (PLAN 0단계): set by `interrupt()` so the abort the SDK throws in
   * the consume loop reads as the planner's own 중지 — a turn end, not a
   * crash. Cleared on the next `send()`, so a later real error still surfaces.
   */
  private interrupting = false;
  /**
   * 중지가 유예 안에 답을 받지 못해 질의를 강제로 끊었다 — 그 CLI 는 죽었고,
   * 이 세션은 더는 보낸 말을 삼키지 않는다. consume 루프가 대화를 닫는
   * 표식으로 읽는다.
   */
  private aborted = false;
  /**
   * 질의가 저 혼자 죽었다 — 중지도 종료도 아닌 예외(CLI 크래시). aborted 와
   * 같은 규칙이 이 사유에도 걸린다: 죽은 질의의 큐를 소비할 이는 없으니
   * 직접 send 하면 조용히 삼켜지는 대신 거절로 돌아간다. 서버는 이 사유를
   * 알아차려 같은 id 의 재개로 대신 전달한다(deliverTurn) — 크래시 카드의
   * "다시 보내면 이어집니다" 약속을 데몬이 이행하는 길이다.
   */
  private crashed = false;
  /** SDK 질의의 취소 수단 — 생성자에서 질의에 묶는다. */
  private readonly abort = new AbortController();

  constructor(options: SessionOptions, events: SessionEvents) {
    this.events = events;
    this.title = options.title?.trim().slice(0, 80) || NEW_SESSION_TITLE;
    // /tmp vs /private/tmp: the resolved spelling, so workspace containment
    // and the SDK's own cwd agree with what the filesystem calls the folder.
    // The CLI reports tool paths already resolved, so an unresolved cwd makes
    // it read its own workspace as foreign and card every Read in it.
    this.cwd = realpathBestEffort(options.cwd);
    // Containment is the floor, not the whole rule: a policy may refuse files
    // inside the cwd itself.
    this.writePolicy =
      options.writePolicy ?? ((path) => (containsPath(this.cwd, path) ? "allow" : "ask"));
    this.selectedModel = options.model ?? null;
    this.selectedEffort = options.effort ?? null;
    this.previewTools = options.previewTools ?? null;

    // `sessionId` lets us name the session up front. Without it the id only
    // arrives with the init event, which the CLI does not emit until the first
    // user turn is pushed.
    this.id = options.sessionId ?? options.resume ?? randomUUID();

    this.run = query({
      prompt: this.queue,
      options: {
        cwd: this.cwd,
        pathToClaudeCodeExecutable: options.claudeExecutable,
        // 중지의 이행 보장: 유예 안에 interrupt 가 답하지 못하는 질의는 이
        // 컨트롤러로 끊는다 — SDK 가 자원을 정리하고 CLI 를 내린다.
        abortController: this.abort,
        // `default` is pinned on purpose: current CLI builds auto-approve
        // safe Bash under acceptEdits/auto without ever consulting
        // `canUseTool`, which would let a session run shell commands with no
        // planner in the loop. The daemon answers edit-class tools itself
        // (see canUse), so the UX stays "edits are silent, everything else
        // surfaces".
        permissionMode: "default",
        // The launch flag — not the mode — is what the CLI checks before it
        // accepts a later `setPermissionMode("bypassPermissions")`; without
        // it every 전부 맡기기 switch dies with "was not launched with
        // --dangerously-skip-permissions". The starting mode above stays
        // `default`, so nothing widens until the planner picks it themselves.
        allowDangerouslySkipPermissions: true,
        // Policy tier beats a user's own `defaultMode` (e.g. `"auto"`) in
        // ~/.claude/settings.json — without it that setting silently widens
        // every hub session.
        managedSettings: { permissions: { defaultMode: "default" } },
        includePartialMessages: true,
        // Load the same user/project configuration the terminal would, so
        // CLAUDE.md, skills, and permission rules behave identically. (The
        // project tier is the repo's own files — a repo that ships
        // pre-approved tool rules surfaces as a header warning; see
        // repoSettingsWarning.)
        settingSources: ["user", "project", "local"],
        // The preview tools ride the query as an in-process MCP server
        // (PLAN D61), keyed by the server's own name.
        ...(this.previewTools
          ? {
              mcpServers: {
                [this.previewTools.name]: this.previewTools.config,
              },
            }
          : {}),
        // A fresh query starts on the chips' choices; mid-session switches
        // go through the control methods below instead.
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.resume
          ? {
              resume: options.resume,
              // D95: a fork keeps the old transcript and continues as OUR id.
              ...(options.sessionId ? { sessionId: options.sessionId, forkSession: true } : {}),
              ...(options.resumeSessionAt ? { resumeSessionAt: options.resumeSessionAt } : {}),
              ...(options.resumeDropsTurn ? { resumeDropsTurn: options.resumeDropsTurn } : {}),
            }
          : { sessionId: this.id }),
        canUseTool: (toolName, input, opts) => this.canUse(toolName, input, opts),
      },
    });

    this.consumer = this.consume();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.run) {
        this.lastActivity = Date.now();
        for (const event of this.translator.translate(message)) {
          if (event.kind === "init") {
            this.model = event.model;
            this.permissionMode = event.permissionMode;
          }
          if (event.kind === "turn.end") {
            // 결함① 의 두 번째 길: interrupt() 를 부른 뒤 SDK 가 abort 예외를
            // 던지는 대신 에러 결과로 그 턴을 끝내면, 이 turn.end 는 그대로면
            // "잠시 문제가 있었습니다" 카드로 내려간다 — 계획자가 누른 중지를
            // 고장으로 읽히게 하는 것. 성공으로 끝난 턴은 건드리지 않고,
            // 플래그는 어떤 턴 끝이든 소비해 다음 진짜 오류를 가리지 않는다.
            if (event.isError && this.interrupting) {
              this.interrupting = false;
              this.events.onEvent(this.id, {
                kind: "turn.end",
                subtype: "interrupted",
                isError: false,
                costUsd: event.costUsd,
                numTurns: event.numTurns,
                durationMs: event.durationMs,
                resultText: null,
              });
              this.setState(this.pending.size > 0 ? this.state : "idle");
              continue;
            }
            if (event.isError) this.interrupting = false;
            this.setState(this.pending.size > 0 ? this.state : "idle");
          }
          this.events.onEvent(this.id, event);
        }
      }
      this.setState("closed");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // The deliberate shutdown in close() aborts the in-flight query; that
      // abort must not read as a crash — no error card, no error state.
      // Same for the planner's own 중지 (결함①): the SDK surfaces it as an
      // abort exception, and the card vocabulary already has the word.
      if (this.interrupting && !this.closed) {
        this.interrupting = false;
        this.events.onEvent(this.id, {
          kind: "turn.end",
          subtype: "interrupted",
          isError: false,
          costUsd: null,
          numTurns: null,
          durationMs: null,
          resultText: null,
        });
        // A forced abort killed the CLI: record the 멈춤 above, then take the
        // thread down — the next open resumes it with a fresh CLI instead of
        // feeding sends to a dead query.
        this.setState(this.aborted ? "closed" : "idle");
      } else if (!this.closed) {
        this.crashed = true;
        this.events.onEvent(this.id, {
          kind: "notice",
          level: "error",
          // The SDK detail is an English message string, not an error id —
          // the retry dictionary can't match it (리뷰 C3). A Korean lead rides
          // in front, the raw line stays below for 자세히.
          text: `Claude가 예상 밖으로 멈췄습니다 — 대화를 다시 보내면 이어집니다.\n\n${detail}`,
        });
        this.setState("error", detail);
      }
    } finally {
      // A crashed or finished query can never answer a pending prompt.
      for (const request of this.pending.values()) {
        request.resolve({
          behavior: "deny",
          message: "Session ended before approval",
        });
      }
      this.pending.clear();
    }
  }

  private setState(state: SessionState, detail?: string): void {
    // A closing session is quiet: the planner closed it themselves, so
    // neither the aborted turn's end nor the shutdown's aftermath is news.
    // `closed` itself still goes out — it is what takes the thread down.
    if (this.closed && state !== "closed") return;
    if (this.state === state) return;
    this.state = state;
    this.events.onState(this.id, state, detail);
  }

  /**
   * The hub's single permission choke point. Edit-class tools are answered by
   * the session's `writePolicy`: silent for the repo's own working set, a
   * card for anything ambiguous, a refusal for the files the tool owns.
   * Everything else goes to the planner as a permission (or question) card.
   */
  private canUse(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
  ): Promise<PermissionResult> {
    // The preview tools are the daemon's own in-process server (PLAN D61):
    // they only look at the hidden preview window, so they never surface as
    // cards — and they must not fall through to the edit-tool branch either.
    if (toolName.startsWith("mcp__colo-preview__")) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    // The git nouns belong to the tool (README): a session committing or
    // pushing its own history puts words on the handoff branch the tool never
    // reviewed. Refused before alwaysAllowed — 항상 허용 cannot buy it back.
    // One door opens: the commit that CONCLUDES a merge this tool itself
    // started(최신화 충돌). The conflict card asks Claude for exactly that
    // commit, and this gate must not refuse the tool's own recovery
    // instruction(브리프 ↔ 게이트 모순). A push stays the tool's verb even
    // mid-merge, and a commit outside an open merge is still refused.
    const command = String(input.command ?? "");
    if (toolName === "Bash" && writesGitHistory(command)) {
      const mergeOpen = existsSync(join(this.cwd, ".git", "MERGE_HEAD"));
      const pushes = /\bgit\b/.test(command) && /\bpush\b/.test(command);
      if (!mergeOpen || pushes) {
        return Promise.resolve({ behavior: "deny", message: GIT_WRITE_REFUSAL });
      }
    }
    if (EDIT_TOOLS.has(toolName)) {
      const paths = [input.file_path, input.notebook_path].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (paths.length > 0) {
        // Relative names resolve against cwd and symlinks resolve through,
        // so a policy compares prefixes without being talked past.
        const decisions = paths.map((value) =>
          this.writePolicy(realpathBestEffort(isAbsolute(value) ? value : join(this.cwd, value))),
        );
        const denied = decisions.indexOf("deny");
        if (denied !== -1) {
          return Promise.resolve({
            behavior: "deny",
            message: `${paths[denied]} 은(는) 도구가 관리하는 파일이라 수정할 수 없습니다.`,
          });
        }
        if (decisions.every((decision) => decision === "allow")) {
          return Promise.resolve({ behavior: "allow", updatedInput: input });
        }
      }
    }
    // A call the planner answered with 항상 허용 must not become a card again.
    // 계획의 승인은 그 앞에서 갈라 놓는다 — 읽고 답하는 일이라 기억이 대신
    // 답하지 못하게 한다(기억은 어차피 이 경로로 채워지지 않는다).
    if (toolName === PLAN_TOOL) {
      return this.handlePermission(toolName, input, opts);
    }
    if (this.alwaysAllowed.allows(toolName, input)) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    return this.handlePermission(toolName, input, opts);
  }

  private handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
  ): Promise<PermissionOutcome> {
    const requestId = randomUUID();
    const suggestions = opts.suggestions ?? [];

    return new Promise<PermissionOutcome>((resolve) => {
      const settle = (outcome: PermissionOutcome) => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        if (this.pending.size === 0 && this.state !== "closed" && this.state !== "error") {
          this.setState("running");
        }
        resolve(outcome);
      };

      this.pending.set(requestId, {
        requestId,
        kind:
          toolName === "AskUserQuestion"
            ? "question"
            : toolName === PLAN_TOOL
              ? "plan"
              : "permission",
        toolName,
        resolve: settle,
        suggestions,
        input,
      });

      // If the query is torn down while a human is deciding, stop waiting.
      opts.signal.addEventListener(
        "abort",
        () => settle({ behavior: "deny", message: "Request cancelled" }),
        { once: true },
      );

      if (toolName === "AskUserQuestion") {
        this.setState("waiting_question");
        this.events.onQuestionRequest({
          requestId,
          sessionId: this.id,
          questions: normalizeQuestions(input),
        });
      } else {
        this.setState("waiting_permission");
        this.events.onPermissionRequest({
          requestId,
          sessionId: this.id,
          toolName,
          input,
          suggestions: describeSuggestions(suggestions),
        });
      }
    });
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Whether a send can still land in this session's own query. False once the
   * query died any way it can — a crash (the card's own state), a force-aborted
   * stop, a CLI that ended on its own. The server reads this to resurrect the
   * thread (same id, fresh CLI) before delivering the planner's words.
   */
  get sendable(): boolean {
    return !(this.crashed || this.aborted || this.state === "error" || this.state === "closed");
  }

  /** The chips the session is running on — what a resurrection must carry. */
  get chosen(): { model: string | null; effort: EffortLevel | null } {
    return { model: this.selectedModel, effort: this.selectedEffort };
  }

  /**
   * Re-sendable copies of the pending requests (재접속 복원): the exact shapes
   * `onPermissionRequest` / `onQuestionRequest` emit, so a reconnecting window
   * can rebuild the cards it missed. The old listPending() returned bare ids
   * nothing ever read — the replays carry the input the card draws.
   */
  pendingReplays(): Array<
    | {
        type: "permission.request";
        requestId: string;
        sessionId: string;
        toolName: string;
        input: Record<string, unknown>;
        suggestions: PermissionSuggestion[];
      }
    | {
        type: "question.request";
        requestId: string;
        sessionId: string;
        questions: AskQuestion[];
      }
  > {
    return [...this.pending.values()].map((entry) =>
      entry.kind === "question"
        ? {
            type: "question.request" as const,
            requestId: entry.requestId,
            sessionId: this.id,
            questions: normalizeQuestions(entry.input),
          }
        : {
            type: "permission.request" as const,
            requestId: entry.requestId,
            sessionId: this.id,
            toolName: entry.toolName,
            input: entry.input,
            suggestions: describeSuggestions(entry.suggestions),
          },
    );
  }

  respondPermission(
    requestId: string,
    decision: "allow" | "allowAlways" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<boolean> {
    const request = this.pending.get(requestId);
    if (!request) return Promise.resolve(false);

    if (decision === "deny") {
      request.resolve({
        behavior: "deny",
        message: message ?? "User denied this action",
      });
      return Promise.resolve(true);
    }

    const input = updatedInput ?? request.input;
    if (request.kind === "plan") {
      // 승인은 곧 착수다: 모드를 먼저 작업 모드로 되돌린 뒤 승인을 내린다 —
      // CLI 가 승인 직후의 편집에 들어가도 계획 모드의 제약 아래 갇히지 않게.
      // 복귀가 거절돼도 승인은 나간다: 갇힌 계획보다 조심스러운 착수가 낫다.
      const restore = this.modeBeforePlan ?? "default";
      return this.setPermissionMode(restore)
        .catch(() => undefined)
        .then(() => {
          request.resolve({ behavior: "allow", updatedInput: input });
          return true;
        });
    }
    if (decision === "allowAlways") {
      // Remember the exact call so the daemon itself never re-prompts it;
      // the CLI's own suggestions cover future sessions' rules.
      this.alwaysAllowed.record(request.toolName, input);
      // Echo the CLI's own suggestions back so the same call stops prompting.
      // Bash-style calls offer an `addRules` update destined for
      // .claude/settings.local.json; Write and Edit instead offer a session
      // `setMode` switch to acceptEdits. Both are valid "stop asking" answers.
      request.resolve({
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: request.suggestions,
      });
      return Promise.resolve(true);
    }

    request.resolve({ behavior: "allow", updatedInput: input });
    return Promise.resolve(true);
  }

  respondQuestion(
    requestId: string,
    answers: Record<string, string | string[]>,
    response: string | undefined,
  ): boolean {
    const request = this.pending.get(requestId);
    if (!request) return false;
    // The tool requires the original questions array back alongside the answers.
    const updatedInput: Record<string, unknown> = {
      questions: request.input.questions,
      answers,
    };
    if (response) updatedInput.response = response;
    request.resolve({ behavior: "allow", updatedInput });
    return true;
  }

  send(
    text: string,
    images?: Array<{ mediaType: string; data: string }>,
    files?: SpecFile[],
  ): void {
    if (this.closed) throw new Error("닫힌 대화입니다 — 목록에서 다시 열면 이어갑니다.");
    if (this.aborted)
      throw new Error("중지 요청에 답하지 않은 CLI를 끊었습니다 — 대화를 다시 열면 이어갑니다");
    if (this.crashed)
      throw new Error(
        "Claude가 예상 밖으로 멈춰 이 대화의 연결이 끊겼습니다 — 대화를 다시 열면 이어갑니다",
      );
    // A new turn starts the screenshot quota over (PLAN D61 — 턴당 12장).
    this.previewTools?.resetTurnQuota();
    // A fresh send is a fresh failure domain: an old interrupt's flag must
    // not swallow this turn's real error (결함①).
    this.interrupting = false;
    // Documents go to disk and reach Claude as `@specs/…` mentions: its Read
    // tool handles PDF page ranges and image downscaling, and the clone keeps
    // the source document for later sessions.
    const saved = files && files.length > 0 ? saveSpecFiles(this.cwd, files) : [];
    const prompt = saved.reduce((acc, path) => `${acc}\n\n첨부 기획서: @${path}`, text);
    const content =
      images && images.length > 0
        ? [
            { type: "text" as const, text: prompt },
            ...images.map((image) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.mediaType,
                data: image.data,
              },
            })),
          ]
        : prompt;

    /**
     * A thread names itself after its first turn — unless the tool wrote that
     * turn. A marked turn (PLAN D9) is a bundle of pins, a brief, a gate
     * failure: text composed for Claude, in Claude's vocabulary. The tab strip
     * is the one place a planner navigates by reading, so it keeps its
     * placeholder rather than taking a machine's words. A thread the tool
     * opens on purpose is named at `session.create` instead.
     */
    const machine = readTurn(text).marker !== null;
    const title = text.trim() || saved.join(", ");
    const unnamed = this.title === NEW_SESSION_TITLE;
    if (unnamed && title && !machine) {
      this.title = title.slice(0, 80);
    }

    this.queue.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.id,
    } as SDKUserMessage);

    this.lastActivity = Date.now();
    this.setState("running");
    // The echo carries the person's own words; the appended mentions are
    // plumbing, and the saved paths render as attachment chips instead.
    // D87: the pin crops ride back (capped) so the chat card can draw its
    // thumbnails — live only; a replayed transcript keeps the words.
    const thumbs = (images ?? [])
      .filter((image) => image.mediaType === "image/jpeg")
      .slice(0, 6)
      .map((image) => image.data);
    this.events.onEvent(this.id, {
      kind: "user.echo",
      text,
      images: images?.length ?? 0,
      files: saved,
      ...(thumbs.length > 0 ? { thumbs } : {}),
    });
  }

  async interrupt(): Promise<void> {
    // Mark first: the abort the CLI throws back in the consume loop is THIS
    // planner action, and the catch must turn it into `멈추었습니다` (결함①).
    this.interrupting = true;
    const outcome = await this.settleInterrupt();
    if (outcome === "refused") {
      // Interrupt itself refused — nothing is being aborted, so the flag
      // would only mask the next genuine error.
      this.interrupting = false;
      this.setState("idle");
      return;
    }
    if (outcome === "timeout") {
      // The CLI never answered the control request — 실사 결함: 네트워크 대기에
      // 걸린 턴에서 중지를 두 번 눌러도 아무 일도 일어나지 않았다. 유예가 지났으면
      // 질의를 끊는다. consume 루프가 같은 깃발을 읽어 멈춤으로 기록하고,
      // `aborted` 로 대화를 닫는다 — 죽은 CLI 가 이후의 보낸 말을 조용히 삼키지
      // 않게.
      this.aborted = true;
      this.abort.abort();
    }
    this.setState("idle");
  }

  /**
   * A control request's grace. The CLI answers an interrupt quickly when it
   * can, and a refusal is still an answer (it is alive enough to talk —
   * nothing to abort). `timeout` is the wedged case: the caller must abort
   * the query outright. `close` passes a shorter courtesy: a shutdown with
   * several wedged sessions must not pay the full grace for each of them.
   */
  private settleInterrupt(
    graceMs = INTERRUPT_GRACE_MS,
  ): Promise<"answered" | "refused" | "timeout"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), graceMs);
      this.run.interrupt().then(
        () => {
          clearTimeout(timer);
          resolve("answered");
        },
        () => {
          clearTimeout(timer);
          resolve("refused");
        },
      );
    });
  }
  async contextUsage(): Promise<ContextUsage | null> {
    try {
      const usage = await this.run.getContextUsage({ detail: "summary" });
      return {
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        percentage: usage.percentage,
        model: usage.model,
        plan: await this.planUsage(),
      };
    } catch {
      return null;
    }
  }

  /**
   * The signed-in plan's 5-hour and weekly windows, from the SDK's /usage
   * control call. API-key sessions answer `rate_limits_available: false` and
   * any failure just means the composer shows nothing — the context ring
   * above still works, so a broken experimental call must not take it down.
   */
  private async planUsage(): Promise<PlanUsage | null> {
    try {
      const usage = await this.run.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      });
      if (!usage.rate_limits_available || !usage.rate_limits) return null;
      return {
        subscriptionType: usage.subscription_type,
        fiveHour: this.toPlanWindow(usage.rate_limits.five_hour),
        sevenDay: this.toPlanWindow(usage.rate_limits.seven_day),
      };
    } catch {
      return null;
    }
  }

  /** The SDK's wire shape for one limit window, narrowed to the protocol's. */
  private toPlanWindow(
    value: { utilization: number | null; resets_at: string | null } | null | undefined,
  ): PlanWindow | null {
    if (!value) return null;
    return { utilization: value.utilization, resetsAt: value.resets_at };
  }

  // -------------------------------------------------------------------------
  // Composer selector chips — mid-session switches (SDK control requests)
  // -------------------------------------------------------------------------

  /** Effective from the next response. `null` returns to the CLI default. */
  async setModel(model: string | null): Promise<void> {
    await this.run.setModel(model ?? undefined);
    this.selectedModel = model;
  }

  /** Effective from the next response. `null` clears the override. */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    await this.run.applyFlagSettings({ effortLevel: effort ?? null });
    this.selectedEffort = effort;
  }

  /** Widening past `default` is the planner's own explicit choice here. */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.run.setPermissionMode(mode);
    // 계획은 자세가 아니라 한 번의 승인이다: 들어갈 때의 작업 모드를 기억해
    // 두었다가 승인 순간 되돌린다(위 respondPermission). 이미 계획인 채의
    // 재진입은 첫 기억을 지키고, 다른 모드로의 나들이는 기억을 지운다.
    if (mode === "plan") {
      if (this.permissionMode !== "plan") this.modeBeforePlan = this.permissionMode;
    } else {
      this.modeBeforePlan = null;
    }
    this.permissionMode = mode;
  }

  /** Everything the composer's chips display, plus the model picker rows. */
  async selectors(): Promise<SessionSelectors> {
    const models = await this.run.supportedModels();
    return {
      model: this.selectedModel ?? this.model,
      effort: this.selectedEffort,
      permissionMode: this.permissionMode,
      models: models.map((model) => ({
        value: model.value,
        displayName: model.displayName,
        resolvedModel: model.resolvedModel ?? null,
        description: model.description,
        supportsEffort: model.supportsEffort ?? false,
        supportedEffortLevels: model.supportedEffortLevels ?? null,
      })),
    };
  }

  /** The composer's /command palette: names, descriptions, argument hints. */
  async commands(): Promise<SessionCommand[]> {
    const commands = await this.run.supportedCommands();
    return commands.map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint ?? "",
      aliases: command.aliases ?? [],
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      request.resolve({ behavior: "deny", message: "Session closed by user" });
    }
    this.pending.clear();
    this.queue.close();
    // The same grace as 중지, only shorter: a shutdown must not hang on a
    // wedged CLI either — and it must not pay the full grace per session.
    if ((await this.settleInterrupt(CLOSE_GRACE_MS)) === "timeout") this.abort.abort();
    await this.consumer.catch(() => undefined);
    this.setState("closed");
  }
}

/**
 * The `/` palette before any thread exists. A live session answers from its
 * own CLI (`Session.commands`); this boots the CLI just far enough to ask the
 * same question — the init handshake, no model turn, no transcript — so an
 * empty workspace still reads like the terminal's `/`. The prompt stream
 * never yields; `close` tears the process down.
 */
export async function probeCommands(options: {
  cwd: string;
  executable: string | null;
}): Promise<SessionCommand[]> {
  if (!options.executable) return [];
  const never: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  };
  const run = query({
    prompt: never,
    options: {
      cwd: realpathBestEffort(options.cwd),
      pathToClaudeCodeExecutable: options.executable,
      // The same user/project configuration a session loads, so the probe's
      // list is the one the first session will actually answer to.
      settingSources: ["user", "project", "local"],
    },
  });
  try {
    const commands = await run.supportedCommands();
    return commands.map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint ?? "",
      aliases: command.aliases ?? [],
    }));
  } finally {
    run.close();
  }
}

function describeSuggestions(suggestions: PermissionUpdate[]): PermissionSuggestion[] {
  return suggestions.map((raw) => {
    const s = raw as Record<string, any>;
    const destination = String(s?.destination ?? "session");
    const persisted = destination === "localSettings" || destination === "projectSettings";
    // 이 문장은 기획자가 읽는 권한 카드에 그대로 붙는다 — 기계 말이 아니라
    // 기획 말로 쓴다 (README: 기획자는 git 명사를 읽지 않는다).
    const scope = persisted ? "다음에도 유지" : "이 세션 동안만";

    if (s?.type === "setMode" && s?.mode) {
      return {
        destination,
        label: `${String(s.mode)} 모드로 전환 (${scope})`,
        raw,
      };
    }
    if (Array.isArray(s?.rules) && s.rules.length > 0) {
      const rules = s.rules
        .map((r: Record<string, any>) =>
          r?.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r?.toolName ?? ""),
        )
        .filter(Boolean)
        .join(", ");
      return { destination, label: `${rules} 허용 (${scope})`, raw };
    }
    return {
      destination,
      label: `${String(s?.type ?? "update")} (${scope})`,
      raw,
    };
  });
}

function normalizeQuestions(input: Record<string, unknown>): AskQuestion[] {
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions.map((raw) => {
    const q = raw as Record<string, any>;
    return {
      question: String(q?.question ?? ""),
      header: String(q?.header ?? ""),
      multiSelect: Boolean(q?.multiSelect),
      options: Array.isArray(q?.options)
        ? q.options.map((opt: Record<string, any>) => ({
            label: String(opt?.label ?? ""),
            description: String(opt?.description ?? ""),
            ...(opt?.preview ? { preview: String(opt.preview) } : {}),
          }))
        : [],
    };
  });
}
