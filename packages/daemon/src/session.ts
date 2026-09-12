import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  query,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
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
  SessionModelInfo,
  SessionSelectors,
  SessionState,
} from "@cds-design/protocol";
import { readTurn } from "@cds-design/protocol";
import { saveSpecFiles, type SpecFile } from "./repo.js";
import type { PreviewTools } from "./preview-tools.js";
import { containsPath, realpathBestEffort } from "./paths.js";
import { MessageTranslator } from "./translate.js";

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
  kind: "permission" | "question";
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
export type WriteDecision = "allow" | "ask" | "deny";
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
   * The `cds-preview` in-process MCP server (PLAN D61), or null when the
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

  constructor(options: SessionOptions, events: SessionEvents) {
    this.events = events;
    this.title =
      options.title?.trim().slice(0, 80) || NEW_SESSION_TITLE;
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
          ? { mcpServers: { [this.previewTools.name]: this.previewTools.config } }
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
        this.setState("idle");
      } else if (!this.closed) {
        this.events.onEvent(this.id, { kind: "notice", level: "error", text: detail });
        this.setState("error", detail);
      }
    } finally {
      // A crashed or finished query can never answer a pending prompt.
      for (const request of this.pending.values()) {
        request.resolve({ behavior: "deny", message: "Session ended before approval" });
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
    if (toolName.startsWith("mcp__cds-preview__")) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    // The git nouns belong to the tool (README): a session committing or
    // pushing its own history puts words on the handoff branch the tool never
    // reviewed. Refused before alwaysAllowed — 항상 허용 cannot buy it back.
    if (toolName === "Bash" && writesGitHistory(String(input.command ?? ""))) {
      return Promise.resolve({ behavior: "deny", message: GIT_WRITE_REFUSAL });
    }
    if (EDIT_TOOLS.has(toolName)) {
      const paths = [input.file_path, input.notebook_path].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (paths.length > 0) {
        // Relative names resolve against cwd and symlinks resolve through,
        // so a policy compares prefixes without being talked past.
        const decisions = paths.map((value) =>
          this.writePolicy(
            realpathBestEffort(isAbsolute(value) ? value : join(this.cwd, value)),
          ),
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
        kind: toolName === "AskUserQuestion" ? "question" : "permission",
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

  listPending(): Array<{ requestId: string; kind: "permission" | "question"; toolName: string }> {
    return [...this.pending.values()].map(({ requestId, kind, toolName }) => ({
      requestId,
      kind,
      toolName,
    }));
  }

  respondPermission(
    requestId: string,
    decision: "allow" | "allowAlways" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): boolean {
    const request = this.pending.get(requestId);
    if (!request) return false;

    if (decision === "deny") {
      request.resolve({ behavior: "deny", message: message ?? "User denied this action" });
      return true;
    }

    const input = updatedInput ?? request.input;
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
      return true;
    }

    request.resolve({ behavior: "allow", updatedInput: input });
    return true;
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
    if (this.closed) throw new Error("session is closed");
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
              source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
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
    try {
      await this.run.interrupt();
    } catch {
      // Interrupt itself refused — nothing is being aborted, so the flag
      // would only mask the next genuine error.
      this.interrupting = false;
    }
    this.setState("idle");
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
    try {
      await this.run.interrupt();
    } catch {
      // Already finished; nothing to interrupt.
    }
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
      return { destination, label: `${String(s.mode)} 모드로 전환 (${scope})`, raw };
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
    return { destination, label: `${String(s?.type ?? "update")} (${scope})`, raw };
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
