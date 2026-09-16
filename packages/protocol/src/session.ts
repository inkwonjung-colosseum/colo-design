import type { EffortLevel, PermissionMode, SessionState } from "./shared.js";

// ---------------------------------------------------------------------------
// Normalized chat events (daemon translates SDKMessage into these)
// ---------------------------------------------------------------------------

/**
 * One send waiting in the daemon's wait room (PLAN D86), as the composer's
 * list shows it: the planner's own words, plus how many pictures rode along.
 */
export interface QueuedSend {
  id: string;
  text: string;
  images: number;
}

/**
 * One send the wait room lost without delivering (the query died, the daemon
 * was restarted under it). The words survive on the daemon's disk; the
 * pictures survive too unless they exceeded the persist cap, where
 * `truncated` says the composer must ask for them again.
 */
export interface LostSend {
  id: string;
  text: string;
  images: number;
  truncated?: boolean;
  /** Epoch ms — when the room lost it. The 30-day prune reads this. */
  lostAt: number;
}

/**
 * `session.queue.remove` / `session.queue.takeDropped` — the payload as it
 * was sent, handed back so the composer can restore the field exactly.
 * `null` when the send had already gone (delivered, or no longer stored).
 */
export type QueuedSendPayload = {
  text: string;
  images: Array<{ mediaType: string; data: string }>;
} | null;

export type ChatEvent =
  | {
      kind: "init";
      sessionId: string;
      model: string;
      cwd: string;
      tools: string[];
      apiKeySource: string;
      /** Slash commands and agents available, for UI affordances. */
      permissionMode: string;
    }
  | {
      kind: "text.delta";
      blockId: string;
      text: string;
      agentId: string | null;
    }
  | { kind: "text.done"; blockId: string; text: string; agentId: string | null }
  | {
      kind: "thinking.delta";
      blockId: string;
      text: string;
      agentId: string | null;
    }
  | {
      kind: "tool.start";
      toolUseId: string;
      name: string;
      input: unknown;
      agentId: string | null;
    }
  | {
      kind: "tool.end";
      toolUseId: string;
      isError: boolean;
      content: unknown;
      agentId: string | null;
    }
  /**
   * `thumbs` (D87) holds the JPEG crops the view took of the pinned elements,
   * capped at six — live-only echoes the chat card draws as thumbnails; a
   * replayed transcript keeps the words, not the bytes.
   */
  | {
      kind: "user.echo";
      text: string;
      images: number;
      thumbs?: string[];
    }
  | {
      kind: "turn.end";
      subtype: string;
      isError: boolean;
      costUsd: number | null;
      numTurns: number | null;
      durationMs: number | null;
      /** Present when the turn ended because the model declined. */
      resultText: string | null;
    }
  | {
      kind: "retry";
      attempt: number;
      maxRetries: number;
      delayMs: number;
      error: string;
    }
  /**
   * 다음 턴에 보내기 (PLAN D86): what is waiting in the daemon's wait room
   * right now, oldest first — empty when the room empties. Not a transcript
   * event: the composer's list above the field reads it, and `foldEvent`
   * must NOT build a chat block from it. A waiting send has NOT entered the
   * transcript yet — its `user.echo` comes when the daemon delivers it, so
   * the transcript only ever shows what Claude was actually handed.
   *
   * The room is the DAEMON's, on purpose. The SDK's input stream is not a
   * waiting room — anything written into it mid-turn is folded by the CLI
   * into the RUNNING turn between tool rounds — so the wait is the daemon's
   * to keep, and only the daemon knows when it ends.
   */
  | { kind: "queued"; items: QueuedSend[] }
  /**
   * The lost room, as STATE (PLAN D86 의 확장): sends the daemon could not
   * deliver — the query died, or a restart orphaned the wait room. They never
   * reached the transcript, so the daemon keeps them on disk until the
   * planner restores (`session.queue.takeDropped`) or dismisses each; every
   * change announces the whole list, and `session.history` replays it, so a
   * new window sees the recovery panel too. `foldEvent` must NOT build a
   * chat block from it.
   */
  | { kind: "queue.lost"; items: LostSend[] }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { kind: "compact"; trigger: string }
  /**
   * 도구가 도는 동안 (PLAN D97). 기록이 아니라 그 도구 행의 상태다 —
   * `foldEvent` 는 새 블록을 만들지 않고 이름한 행에 붙인다. 재생된 기록에는
   * 없다.
   */
  | {
      kind: "tool.progress";
      toolUseId: string;
      elapsedSeconds: number;
      agentId: string | null;
      /** A subagent whose API call failed and is being retried. */
      retry?: { attempt: number; maxRetries: number; delayMs: number };
    }
  /**
   * 보조 작업의 생애 (PLAN D97): 시작 · 진행 · 상태 변화 · 끝. `toolUseId` 는
   * 그 작업을 띄운 도구 호출이다. 붙을 행이 없는 작업은 조용히 버려진다.
   * ambient · skip_transcript 작업은 데몬이 여기까지 올리지 않는다 — 활동
   * 표시에 섞이면 안 되는 집안일이다.
   */
  | {
      kind: "task.start";
      taskId: string;
      toolUseId: string | null;
      description: string;
      subagentType: string | null;
      backgrounded: boolean;
    }
  | {
      kind: "task.progress";
      taskId: string;
      toolUseId: string | null;
      description: string;
      /** 모델이 쓴 한 줄 근황(`agentProgressSummaries`), 없으면 null. */
      summary: string | null;
      lastTool: string | null;
      tokens: number;
      toolUses: number;
      durationMs: number;
    }
  | {
      kind: "task.update";
      taskId: string;
      status: string | null;
      backgrounded: boolean | null;
      error: string | null;
    }
  | {
      kind: "task.end";
      taskId: string;
      toolUseId: string | null;
      status: "completed" | "failed" | "stopped";
      summary: string;
      tokens: number | null;
      toolUses: number | null;
      durationMs: number | null;
    }
  /**
   * 지금 살아 있는 백그라운드 작업 전부 (PLAN D101). REPLACE 시맨틱: 받은
   * 목록으로 통째로 갈아 끼운다. 기록이 아니라 세션의 현재 상태다.
   */
  | { kind: "tasks"; tasks: Array<{ taskId: string; type: string; description: string }> }
  /**
   * 다음에 물어볼 만한 말 (PLAN D99): 턴이 끝난 뒤 CLI 가 예측한 한 문장.
   * 기록이 아니다 — 입력창 위 칩으로 한 번 떴다가 보내면 사라진다.
   */
  | { kind: "suggestion"; text: string }
  /**
   * 답이 나오기 전의 상태 (PLAN D100): 대화를 정리하는 중(`compacting`),
   * 모델의 답을 기다리는 중(`requesting`), 또는 아무것도 아님(null).
   */
  | { kind: "status"; status: "compacting" | "requesting" | null }
  /**
   * CLI 가 스스로 내려간다고 알린 순간 (`worker_shutting_down`). 기록도 상태도
   * 아니고 데몬만 읽는 귀띔이다: 이 뒤의 스트림 끝은 고장이 아니라 종료이므로
   * 크래시 카드가 다른 말을 한다.
   */
  | { kind: "shutdown"; reason: string }
  /**
   * 구독 한도의 상태가 바뀌었다 (`rate_limit_event`). 데몬이 요금 칩의 다음
   * 읽기를 앞당기는 방아쇠 — 숫자 자체는 usage 가 들고 온다.
   */
  | { kind: "ratelimit"; status: string; resetsAt: number | null }
  /**
   * Claude opened a screen in the hidden preview (`screen_open`, PLAN D91).
   * Not a transcript event — `foldEvent` must NOT build a chat block from
   * it; the web keeps it as the session's `lastOpened` and follows at
   * turn end.
   */
  | { kind: "preview.opened"; route: string; state: string | null };

// ---------------------------------------------------------------------------
// Session summaries and replies
// ---------------------------------------------------------------------------

export interface SessionSummary {
  sessionId: string;
  title: string;
  lastModified: number;
  /** True when this daemon currently holds a live query() for the session. */
  live: boolean;
  state: SessionState;
  /**
   * 도는 턴이 시작한 시각 (epoch ms), 없으면 null. 재접속한 창이 진행 시계를
   * 0 부터 다시 세지 않게 하는 자리 — 목록이 데몬의 진실이므로 시작 시각도
   * 여기서 온다.
   */
  turnStartedAt: number | null;
  /** Which agent provider owns the thread — resume and history route by it. */
  provider?: string;
}

/** `session.locate` — which project holds a session (리뷰 B7). The OS
 * notification's click lands on a session id; the UI must reach its project
 * before it can open the conversation (resuming it in the WRONG project
 * would fork it there). */
export interface SessionLocation {
  /** The owning project's slug; null when the session is unknown. */
  slug: string | null;
}

/** `session.rewind` — the forked (or fresh) conversation to carry on in. */
export interface SessionRewound {
  sessionId: string;
  /** True when the fork was refused and only the FILES went back (D95). */
  memoryKept: boolean;
}

// ---------------------------------------------------------------------------
// Plan, context, model and command surfaces
// ---------------------------------------------------------------------------

/** One claude.ai plan-limit window, as the usage endpoint reports it. */
export interface PlanWindow {
  /** Percentage of the window used, 0–100. */
  utilization: number | null;
  /** ISO 8601 timestamp when the window resets. */
  resetsAt: string | null;
}

/**
 * A weekly window that belongs to one model rather than to the whole plan —
 * the Fable/Opus row of the usage dialog. The server names its own buckets,
 * so the label travels with the numbers instead of being spelled here.
 */
export interface PlanModelWindow extends PlanWindow {
  /** Server-supplied bucket name, e.g. 'Fable'. */
  label: string;
}

/**
 * The signed-in plan's rolling limits. Null for API-key and third-party
 * provider sessions, where plan limits do not apply.
 */
export interface PlanUsage {
  /** 'pro' | 'max' | 'team' | 'enterprise' | … */
  subscriptionType: string | null;
  fiveHour: PlanWindow | null;
  sevenDay: PlanWindow | null;
  /**
   * Per-model weekly windows, in the order the server sent them. Empty when
   * the plan has none — a Pro account, or a server that does not emit them.
   */
  modelWeekly: PlanModelWindow[];
}

export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  /**
   * What this session run has spent so far, as the SDK's own running total.
   * Null until a turn has settled — a thread that never answered has no
   * price to report, and `0` would be a number nobody measured.
   */
  sessionCostUsd: number | null;
  model: string;
  plan: PlanUsage | null;
}

/** One row of the CLI's model picker, as `supportedModels` reports it. */
export interface SessionModelInfo {
  /** Alias or id to send back to `setModel` (e.g. 'sonnet'). */
  value: string;
  displayName: string;
  /** Canonical id the alias resolves to, so a stored id still finds its row. */
  resolvedModel: string | null;
  description: string;
  supportsEffort: boolean;
  /** `null` when the row does not say — then offer every level. */
  supportedEffortLevels: EffortLevel[] | null;
  /**
   * 이 모델이 빠르게를 받는지. 받지 않는 모델 위에서는 토글이 눌리지 않는다
   * — 켤 수 없는 스위치를 켜 보이는 것이 이 줄이 막는 거짓말이다.
   */
  supportsFastMode: boolean;
}

/** What the composer's model·노력·권한 chips show and switch, per session. */
export interface SessionSelectors {
  /** Currently pinned model, or the CLI's own choice when never pinned. */
  model: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  /**
   * 빠르게가 지금 켜져 있는지. CLI 가 말해 준 상태이지 우리가 보낸 요청이
   * 아니다 — 요금제·모델·쿨다운 때문에 켜 달라는 부탁이 거절될 수 있고,
   * 그때 토글은 스스로 꺼진 자리로 돌아온다.
   */
  fastMode: boolean;
  /**
   * 왜 빠르게를 지금 쓸 수 없는지. `null` 이면 막는 것이 없다 — CLI 의
   * `fast_mode_disabled_reason` 을 그대로 나른다.
   */
  fastModeBlocked: string | null;
  models: SessionModelInfo[];
  /** Which provider this session runs on — the chips read it to pick their vocabulary. */
  provider?: string;
  /**
   * The provider's own mode rows (ACP agents name their own modes). When
   * present the mode chip lists these instead of the Claude enum, and
   * `mode` holds the current row's id.
   */
  modes?: Array<{ id: string; label: string; description?: string }>;
  /** The current provider-mode id — equals `permissionMode` for Claude. */
  mode?: string;
}

/** One row of the composer's /command palette. */
export interface SessionCommand {
  /** Command name without the leading slash. */
  name: string;
  description: string;
  /** Argument hint, e.g. "<file>"; empty when the command takes none. */
  argumentHint: string;
  /** Alternate names that resolve to the same command. */
  aliases: string[];
}
