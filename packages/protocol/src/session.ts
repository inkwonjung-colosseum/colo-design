import type { DeveloperReview } from "./repo.js";
import type { EffortLevel, SessionState } from "./shared.js";

// ---------------------------------------------------------------------------
// Normalized chat events (daemon translates SDKMessage into these)
// ---------------------------------------------------------------------------

/**
 * One send waiting in the daemon's wait room (PLAN D86), as the composer's
 * list shows it: the planner's own words, plus how many pictures and other
 * files rode along.
 */
export interface QueuedSend {
  id: string;
  text: string;
  images: number;
  /** Non-image attachments — text files, documents, binaries. */
  files: number;
}

/**
 * One send the wait room lost without delivering (the query died, the daemon
 * was restarted under it). The words survive on the daemon's disk; the
 * attachments survive too unless they exceeded the persist cap, where
 * `truncated` says the composer must ask for them again.
 */
export interface LostSend {
  id: string;
  text: string;
  images: number;
  files: number;
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
  attachments: Array<{ name: string; mediaType: string; data: string }>;
  /** 표식과 함께 보낸 말 — 되살릴 때 같이 돌려준다(게이트의 입력). */
  pins?: Array<{ screen: string }>;
} | null;

export type ChatEvent =
  | {
      kind: "init";
      sessionId: string;
      model: string;
      cwd: string;
      tools: string[];
      apiKeySource: string;
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
      /**
       * 도구가 뜬 시각 (데몬 시계, ms) — 도는 동안의 경과 시계가 여기서
       * 센다. 재생된 기록에는 대화록의 시각이, 아주 오래된 대화록에는 없을
       * 수 있다(그때는 창이 받은 시각으로 센다).
       */
      startedAt?: number;
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
      /** Non-image attachment names — the card lists what it cannot thumb. */
      files?: string[];
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
   * 사이클 사건의 기록 (hero-synthesis D1): 저장 · 넘김 · 반영 · 개발자 코멘트
   * 도착이, 그리고 저장할 것이 없어 멈춘 제출이 세션 테이프에 영구로 남는다 —
   * 지금까지 `diffStatus`·`devReviews` 는 창의 휘발 상태라 리로드하면 대화에서
   * 사라졌다. `foldEvent` 는 이 종류들을 블록으로 접는다(기록이므로). 발송은
   * 기존 호출의 부수효과 — `api.save`/`api.handoff` 가 받은 `sessionId` 로,
   * 없으면 마지막 활성 세션으로 귀속된다.
   */
  | {
      kind: "cycle.saved";
      at: string;
      commit: string;
      message: string;
      files: string[];
    }
  /**
   * 제출이 저장 게이트(diff)에서 멈춘 사실 — 다른 게이트(commit · push · pr)와
   * 달리 이 실패에는 AI 에게 갈 브리프가 없다(사람 안내의 문제다). 배너만으로는
   * 리로드와 함께 사라져, 누른 손이 무엇에 막혔는지 기록에 남지 않았다(베타
   * 테스트 B6). 테이프의 한 줄로 남아 연대기의 일부가 된다.
   */
  | { kind: "cycle.saveBlocked"; at: string; detail: string }
  | { kind: "cycle.handed"; at: string; pr: number; reviewer?: string }
  | { kind: "cycle.merged"; at: string; pr: number }
  /**
   * 넘긴 요청이 병합 없이 닫혔다(반려, PLAN L4) — 작업은 새 사이클 브랜치로
   * 이월됐으므로 대화록은 한 줄로 그 사실만 말한다.
   */
  | { kind: "cycle.closed"; at: string; pr: number }
  /**
   * 끝난 요청의 남은 커밋이 새 사이클 브랜치로 옮겨졌다(PLAN L4 이월) —
   * from 은 끝난 브랜치, to 는 새 브랜치, commits 는 옮긴 커밋 수. 대화록은
   * 그리지 않는다(기록 전용).
   */
  | { kind: "cycle.carried"; at: string; from: string; to: string; commits: number }
  | { kind: "review.arrived"; reviews: DeveloperReview[] };

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
 * A budget window that is neither the plan's 5-hour nor its whole-week row —
 * a per-model cap (the Fable/Opus row of the usage dialog) or a provider's
 * own longer window. The label travels with the numbers fully spelled
 * ("Fable 주간", "이번 달"), because only the producing driver knows the
 * period the row actually runs on.
 */
interface PlanModelWindow extends PlanWindow {
  /** Fully spelled row label, e.g. 'Fable 주간'. */
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
  /**
   * Which provider's account this reading belongs to (`claude`, `codex`, …)
   * — the same 43% means a different budget from a different account, so the
   * usage chip says whose numbers these are. Stamped by the producing
   * driver; a reading without one is a pre-tag cache the tracker stamps at
   * load, and the chip then omits the line.
   */
  provider?: string;
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

/** What the composer's model·노력 chips show and switch, per session. */
export interface SessionSelectors {
  /** Currently pinned model, or the CLI's own choice when never pinned. */
  model: string | null;
  effort: EffortLevel | null;
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
