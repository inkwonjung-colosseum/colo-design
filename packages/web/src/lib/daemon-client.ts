import type {
  AgentInstallKind,
  AskQuestion,
  ChatEvent,
  ContextUsage,
  DaemonStatus,
  DeveloperReview,
  DiffFile,
  DiffStatus,
  EffortLevel,
  GitHubRepoInspection,
  HandoffPreviewInfo,
  HandoffStatusReport,
  LostSend,
  OnboardingFixKind,
  OnboardingStep,
  PermissionSuggestion,
  ProjectDefaults,
  ProjectLifecycle,
  ProjectList,
  ProjectSummary,
  QueuedSend,
  QueuedSendPayload,
  RepoHandoffDraft,
  RepoHistory,
  RepoHistoryEntry,
  RepoStatus,
  ScreenCheckReport,
  ServerMessage,
  SessionCommand,
  SessionLocation,
  SessionPinHint,
  SessionSelectors,
  SessionState,
  SessionSummary,
} from "@colo-design/protocol";
import { PROTOCOL_VERSION } from "@colo-design/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorWords } from "./error-words";
import { attachProgress, type ToolProgress } from "./progress";
import { currentNoticePrefs, LONG_TURN_MS } from "./settings";
import {
  type HiddenThreads,
  hideAllThreads as hideAllThreadsIn,
  hideThread as hideThreadIn,
  pruneHidden,
  unhideAllThreads as unhideAllThreadsIn,
  unhideThread as unhideThreadIn,
} from "./thread-visibility";

// ---------------------------------------------------------------------------
// Transcript model: ChatEvents folded into renderable blocks
// ---------------------------------------------------------------------------

export type Block =
  | {
      type: "user";
      id: string;
      text: string;
      images: number;
      /** Non-image attachment names — the card lists what it cannot thumb. */
      files?: string[];
      /** The pin crops, live-echo only; a replayed transcript has none. */
      thumbs?: string[];
    }
  | {
      type: "text";
      id: string;
      text: string;
      agentId: string | null;
      streaming: boolean;
    }
  | {
      type: "thinking";
      id: string;
      text: string;
      agentId: string | null;
      streaming: boolean;
    }
  | {
      type: "tool";
      id: string;
      name: string;
      input: unknown;
      agentId: string | null;
      result?: unknown;
      isError?: boolean;
      done: boolean;
      /**
       * 도구가 뜬 시각 — 도는 동안의 경과 시계가 여기서 센다. 라이브는
       * 데몬이 찍고, 재생은 대화록의 시각이 온다; 둘 다 없으면 이 창이
       * 받은 시각이 밑값이다.
       */
      startedAt?: number;
      /**
       * 도는 동안의 진행 — 라이브 전용. 재생된 기록에는 없다(도구 행의
       * 입력·결과만 남는다), 그러니 없는 것이 정상이다.
       */
      progress?: ToolProgress;
    }
  | {
      type: "turn";
      id: string;
      subtype: string;
      isError: boolean;
      costUsd: number | null;
      durationMs: number | null;
      /** The SDK's own closing line — a usage-limit refusal names
          itself here, and the failed card answers in kind. Raw text: it goes
          to the 자세히 fold only. */
      resultText: string | null;
      /** 사다리를 다 쓴 실패 (PLAN L12) — 개발자에게 알렸다는 표식. 카드가
       *  이유 옆에 한 줄로 싣는다. */
      escalated?: boolean;
    }
  | {
      type: "notice";
      id: string;
      level: "info" | "warn" | "error";
      text: string;
      /** 요약 경계(compacting.html cp-fold) — 양쪽 선 구분선으로 그린다. */
      subtype?: "compact";
    }
  | {
      /** 저장 한 건의 기록 (cycle.saved, hero-synthesis D1): 창의 휘발 상태가
       * 아니라 세션 테이프에 남는 것 — 상태 카드가 그릴 내용을 사건 필드
       * 그대로 운반한다(시각·커밋·문구·파일). */
      type: "save";
      id: string;
      at: string;
      commit: string;
      message: string;
      files: string[];
    }
  | {
      /** 제출이 저장 게이트(diff)에서 멈춘 기록 (cycle.saveBlocked): 다른 게이트
       * 와 달리 AI 의 과제가 아니라 사람 안내라 브리프가 없다 — 배너는 휘발하므로
       *  테이프의 한 줄이 흔적을 남긴다(베타 테스트 B6). */
      type: "saveBlocked";
      id: string;
      at: string;
      detail: string;
    }
  | {
      /** 넘김·반영·반려의 진행 한 줄 (cycle.handed·cycle.merged·cycle.closed):
       * subtype 이 어느 쪽인지 고른다. 같은 PR 의 재검토 라운드마다 줄이
       * 쌓이는 것이 목업의 의도다 — 대화의 연대기. */
      type: "milestone";
      id: string;
      subtype: "handed" | "merged" | "closed";
      at: string;
      pr: number;
      reviewer?: string;
    }
  | {
      /** 개발자 코멘트 도착 (review.arrived): 하나의 이벤트에 달려온 리뷰들을
       * 통째로 담는다 — 시각은 각 리뷰의 `at` 이 안다(이벤트 꼭대기엔 없음). */
      type: "human";
      id: string;
      reviews: DeveloperReview[];
    };

let noticeSeq = 0;

/**
 * 한 조각의 생각은 **다음 블록이 시작되는 순간** 끝난 생각이다. `thinking.done`
 * 이벤트가 없어 예전에는 턴이 끝날 때에만 접혔고, 도는 동안의 테이프에는 이미
 * 끝난 생각들이 나란히 "생각 중…" 이라 말하며 (peek 도 없이) 쌓였다 — 실사에서
 * 본 여덟 줄의 벽이 그것이다. 지금 도는 생각은 언제나 마지막 하나뿐이다.
 */
function settleThinking(blocks: Block[]): Block[] {
  if (!blocks.some((block) => block.type === "thinking" && block.streaming)) return blocks;
  return blocks.map((block) =>
    block.type === "thinking" && block.streaming ? { ...block, streaming: false } : block,
  );
}

function foldEvent(blocks: Block[], event: ChatEvent): Block[] {
  switch (event.kind) {
    case "user.echo":
      return [
        ...blocks,
        {
          type: "user",
          id: `u${++noticeSeq}`,
          text: event.text,
          images: event.images,
          ...(event.files && event.files.length > 0 ? { files: event.files } : {}),
          ...(event.thumbs && event.thumbs.length > 0 ? { thumbs: event.thumbs } : {}),
        },
      ];

    case "text.delta": {
      const index = blocks.findIndex((b) => b.type === "text" && b.id === event.blockId);
      if (index === -1) {
        return [
          ...settleThinking(blocks),
          {
            type: "text",
            id: event.blockId,
            text: event.text,
            agentId: event.agentId,
            streaming: true,
          },
        ];
      }
      const next = [...blocks];
      const current = next[index] as Extract<Block, { type: "text" }>;
      next[index] = { ...current, text: current.text + event.text };
      return next;
    }

    case "text.done": {
      const index = blocks.findIndex((b) => b.type === "text" && b.id === event.blockId);
      if (index !== -1) {
        const next = [...blocks];
        next[index] = {
          ...(next[index] as Extract<Block, { type: "text" }>),
          text: event.text,
          streaming: false,
        };
        return next;
      }
      // The block ids of the deltas and of the aggregated message can drift
      // apart — a stream that skips `message_start` has nothing to key on. The
      // API streams one text block at a time per agent, so a `done` with an
      // unfamiliar id is that streaming block under another name. Without this
      // the planner sees every sentence twice, once mid-stream and once final.
      const streaming = blocks.findLastIndex(
        (b) => b.type === "text" && b.streaming && b.agentId === event.agentId,
      );
      if (streaming !== -1) {
        const next = [...blocks];
        next[streaming] = {
          ...(next[streaming] as Extract<Block, { type: "text" }>),
          id: event.blockId,
          text: event.text,
          streaming: false,
        };
        return next;
      }
      if (!event.text.trim()) return blocks;
      return [
        ...blocks,
        {
          type: "text",
          id: event.blockId,
          text: event.text,
          agentId: event.agentId,
          streaming: false,
        },
      ];
    }

    case "thinking.delta": {
      const index = blocks.findIndex((b) => b.type === "thinking" && b.id === event.blockId);
      if (index === -1) {
        return [
          ...settleThinking(blocks),
          {
            type: "thinking",
            id: event.blockId,
            text: event.text,
            agentId: event.agentId,
            streaming: true,
          },
        ];
      }
      const next = [...blocks];
      const current = next[index] as Extract<Block, { type: "thinking" }>;
      next[index] = {
        ...current,
        text: current.text + event.text,
        streaming: true,
      };
      return next;
    }

    case "tool.start":
      return [
        ...settleThinking(blocks),
        {
          type: "tool",
          id: event.toolUseId,
          name: event.name,
          input: event.input,
          agentId: event.agentId,
          done: false,
          startedAt: event.startedAt ?? Date.now(),
        },
      ];

    case "tool.end": {
      const index = blocks.findIndex((b) => b.type === "tool" && b.id === event.toolUseId);
      if (index === -1) return blocks;
      const next = [...blocks];
      next[index] = {
        ...(next[index] as Extract<Block, { type: "tool" }>),
        result: event.content,
        isError: event.isError,
        done: true,
      };
      return next;
    }

    case "turn.end": {
      // 도는 동안의 조각들은 이미 자기 자리에서 접혔다(settleThinking); 턴의
      // 끝은 마지막 조각까지 접어 기록으로 남긴다.
      return [
        ...settleThinking(blocks),
        {
          type: "turn",
          id: `t${++noticeSeq}`,
          subtype: event.subtype,
          isError: event.isError,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          resultText: event.resultText,
          ...(event.escalated ? { escalated: true } : {}),
        },
      ];
    }

    case "retry":
      return [
        ...blocks,
        {
          type: "notice",
          id: `n${++noticeSeq}`,
          level: "warn",
          text:
            event.error === "rate_limit"
              ? `구독 사용량을 채웠습니다 — ${Math.round(event.delayMs / 1000)}초 후에 다시 시도해요 (${event.attempt}/${event.maxRetries}).`
              : `${errorWords(event.error) ?? "잠시 문제가 생겼습니다"} — ${Math.round(event.delayMs / 1000)}초 후에 다시 시도해요.`,
        },
      ];

    case "notice":
      return [
        ...blocks,
        {
          type: "notice",
          id: `n${++noticeSeq}`,
          level: event.level,
          text: event.text,
        },
      ];

    case "compact":
      // 요약 경계는 새로운 말이 아니다 — 이전 대화가 어디서 접혔는지의
      // 표식이다(compacting.html cp-fold). 문구도 고정이고 level 도 info
      // 의 색조가 아니라 표식의 것이다.
      return [
        ...blocks,
        {
          type: "notice",
          id: `n${++noticeSeq}`,
          level: "info",
          subtype: "compact",
          text: "이전 대화가 요약으로 이어졌습니다",
        },
      ];

    case "cycle.saved":
      // 사이클 기록 (hero-synthesis D1): 상태가 아니라 남는 이야기이므로
      // 블록으로 접는다 — 재생 테이프에서도 같은 길로 접힌다.
      return [
        ...settleThinking(blocks),
        {
          type: "save",
          id: `s${++noticeSeq}`,
          at: event.at,
          commit: event.commit,
          message: event.message,
          files: event.files,
        },
      ];

    case "cycle.saveBlocked":
      // 제출이 저장할 것이 없어 멈춘 자리 — 게이트 카드(AI 의 과제)와 달리
      // 사람 안내의 문제라 브리프가 없다. 연대기의 붉은 한 줄이 흔적이다.
      return [
        ...settleThinking(blocks),
        { type: "saveBlocked", id: `b${++noticeSeq}`, at: event.at, detail: event.detail },
      ];

    case "cycle.handed":
      return [
        ...settleThinking(blocks),
        {
          type: "milestone",
          id: `m${++noticeSeq}`,
          subtype: "handed",
          at: event.at,
          pr: event.pr,
          ...(event.reviewer !== undefined ? { reviewer: event.reviewer } : {}),
        },
      ];

    case "cycle.merged":
      return [
        ...settleThinking(blocks),
        {
          type: "milestone",
          id: `m${++noticeSeq}`,
          subtype: "merged",
          at: event.at,
          pr: event.pr,
        },
      ];

    case "cycle.closed":
      return [
        ...settleThinking(blocks),
        {
          type: "milestone",
          id: `m${++noticeSeq}`,
          subtype: "closed",
          at: event.at,
          pr: event.pr,
        },
      ];

    case "review.arrived":
      return [
        ...settleThinking(blocks),
        {
          type: "human",
          id: `h${++noticeSeq}`,
          reviews: event.reviews,
        },
      ];

    case "tool.progress":
    case "task.start":
    case "task.progress":
    case "task.update":
    case "task.end":
      // 새 행이 아니라 이름한 도구 행에 붙는다 (progress.ts).
      return attachProgress(blocks, event);

    case "init":
    case "queued":
    case "queue.lost":
    case "tasks":
    case "suggestion":
    case "status":
    case "shutdown":
    case "ratelimit":
      // The wait room's `queued` and `queue.lost` are the same kind of
      // news: what is waiting above the field, and what fell out of the
      // room — neither has entered the transcript (a waiting send echoes
      // only when delivered). 칩·상태·작업 목록도 같은 성질이다: 지금의
      // 상태이지 나중에 다시 읽을 기록이 아니다 (applyEvent 가 뷰에 담는다).
      return blocks;

    default:
      // A daemon newer than this client may send kinds this build does not
      // know — an unknown event folds to nothing, never a crash.
      return blocks;
  }
}

/**
 * 세션 하나에 사건 하나를 적용한다. 기록으로 남을 것은 `foldEvent` 가 블록으로
 * 접고, 지금의 상태일 뿐인 것(열린 화면 · 대기 줄 · 다음 칩 · 진행 · 작업)은
 * 뷰의 제 자리에 담긴다 — 이 갈림이 한 곳에 있어야 두 성질이 섞이지 않는다.
 */
function applyEvent(view: SessionView, event: ChatEvent): SessionView {
  switch (event.kind) {
    case "init":
      return { ...view, model: event.model };
    case "queued":
      // 대기 줄 — 기록이 아니라 입력창 위 목록.
      return { ...view, queue: event.items };
    case "queue.lost":
      // 잃은 말도 상태다: 데몬의 방이 진실이므로 통째로 갈아
      // 끼운다 — 이어 붙이면 재접속 한 번에 같은 말이 두 줄이 된다.
      return { ...view, dropped: event.items };
    case "tasks":
      // REPLACE — 받은 목록이 지금 살아 있는 전부다.
      return { ...view, tasks: event.tasks };
    case "suggestion":
      return { ...view, suggestion: event.text };
    case "status":
      // 진행 상태는 화면에 그리지 않는다 — 입력창 위 활동 줄이 없어졌다.
      return view;
    case "user.echo":
      // 보낸 순간 앞 턴의 칩은 지나간 말이 된다.
      return {
        ...view,
        suggestion: null,
        blocks: foldEvent(view.blocks, event),
      };
    case "turn.end":
      return {
        ...view,
        blocks: foldEvent(view.blocks, event),
      };
    default:
      return { ...view, blocks: foldEvent(view.blocks, event) };
  }
}

// ---------------------------------------------------------------------------
// Pending human-in-the-loop requests
// ---------------------------------------------------------------------------

export interface PendingPermission {
  kind: "permission";
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  suggestions: PermissionSuggestion[];
  /**
   * 이 요청이 답 없이는 일이 못 가는가 — 데몬이 내린 판정을 그대로 싣는다.
   * 3단계 알림 위계(로그→뱃지→네이티브)의 세 번째 단계가 이 필드만 읽는다.
   */
  blocking?: boolean;
  /** 요청이 만들어진 시각 (epoch ms) — 홈 카드의 "N분 전". */
  requestedAt?: number;
}

export interface PendingQuestion {
  kind: "question";
  requestId: string;
  sessionId: string;
  questions: AskQuestion[];
  /** PendingPermission.blocking 과 같은 판정, 같은 소비자. */
  blocking?: boolean;
  /** PendingPermission.requestedAt 과 같은 시계. */
  requestedAt?: number;
}

type Pending = PendingPermission | PendingQuestion;

type ConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

interface SessionView {
  blocks: Block[];
  state: SessionState;
  model: string | null;
  /** True once this daemon holds a live query for the session. */
  live: boolean;
  /**
   * 다음 턴에 보내기: the sends waiting in the DAEMON's wait
   * room, oldest first. The daemon owns this list because it owns the wait —
   * the SDK's input stream would fold a mid-turn send into the running turn,
   * so only the daemon knows what is still waiting and when it goes out.
   */
  queue: QueuedSend[];
  /**
   * Sends the room lost without delivering (the query died). They never
   * reached the transcript, so the composer keeps them above the field until
   * the planner restores or dismisses each — this list is the window's own.
   */
  dropped: LostSend[];
  /**
   * 지금 살아 있는 백그라운드 작업. 데몬이 통째로 갈아 끼운다.
   */
  tasks: Array<{ taskId: string; type: string; description: string }>;
  /**
   * 다음에 물어볼 만한 말 — 한 번 뜨고, 보내면 사라진다.
   */
  suggestion: string | null;
  /**
   * 이 턴이 시작한 시각 (epoch ms), 도는 턴이 없으면 null — 테이프의 진행
   * 시계가 읽는 자리. 창의 기억이 아니라 데몬의 것이다: 새로고침해도, 두 번째
   * 창에서도 같은 초를 센다. 확인 카드를 기다리는 동안에도 살아 있다.
   */
  turnStartedAt: number | null;
}

const EMPTY_SESSION: SessionView = {
  blocks: [],
  state: "idle",
  model: null,
  live: false,
  queue: [],
  dropped: [],
  tasks: [],
  suggestion: null,
  turnStartedAt: null,
};

/** Requests the UI can make. Every method resolves with the daemon's reply. */
/** The repo reply shapes are the protocol's, imported — this file once
 * re-declared them by hand and the copies drifted: `at` was a number here
 * while the daemon sends ISO 8601 strings, so the save history read
 * "Invalid Date". The web keeps its own names; the shape lives in one place.
 *   SaveHistoryEntry  ← RepoHistoryEntry (one saved commit) */
export type SaveHistoryEntry = RepoHistoryEntry;
type HandoffDraft = RepoHandoffDraft;
type SaveHistory = RepoHistory;

interface DaemonApi {
  /** Every thread of the one workspace, newest first. */
  listSessions: () => Promise<SessionSummary[]>;
  /** Which project owns a session — null when unknown. */
  locateSession: (sessionId: string) => Promise<SessionLocation>;
  history: (sessionId: string) => Promise<ChatEvent[]>;
  /**
   * Omit `resume` for a fresh thread. `model` and `effort` carry the
   * composer's chips into the new session — the daemon otherwise starts every
   * thread on the CLI's own defaults.
   */
  createSession: (opts?: {
    provider?: string;
    resume?: string;
    model?: string;
    effort?: EffortLevel;
    title?: string;
  }) => Promise<{ sessionId: string }>;
  send: (
    sessionId: string,
    text: string,
    attachments?: Array<{ name: string; mediaType: string; data: string }>,
    pins?: Array<{ screen: string }>,
    mode?: "queue" | "steer",
    pinHints?: SessionPinHint[],
  ) => Promise<unknown>;
  interrupt: (sessionId: string) => Promise<unknown>;
  /**
   * 대기 줄 다루기 (PLAN D86). `queueRemove` takes a waiting send back out
   * of the daemon's room and returns its payload, so the composer can put the
   * words — and the files — back in the field. `queueSendNow` cuts the running
   * turn and delivers THAT send first; the rest keep waiting for the turn it
   * starts.
   */
  queueRemove: (sessionId: string, itemId: string) => Promise<QueuedSendPayload>;
  queueSendNow: (sessionId: string, itemId: string) => Promise<unknown>;
  /**
   * 잃은 말 되살리기. `queueTakeDropped` hands a lost send back whole;
   * `queueDismissDropped` lets it go — the daemon's store is the one truth,
   * so both work whether or not the thread has been reopened.
   */
  queueTakeDropped: (sessionId: string, itemId: string) => Promise<QueuedSendPayload>;
  queueDismissDropped: (sessionId: string, itemId: string) => Promise<unknown>;
  contextUsage: (sessionId: string) => Promise<ContextUsage | null>;
  /** 모델·노력·권한 chips; switches apply from the next response. */
  selectors: (sessionId: string) => Promise<SessionSelectors>;
  /** The /command palette rows. */
  commands: (sessionId: string) => Promise<SessionCommand[]>;
  /** The same palette with no thread open: the daemon's own CLI probe. */
  cliCommands: () => Promise<SessionCommand[]>;
  setModel: (sessionId: string, model: string | null) => Promise<unknown>;
  setEffort: (sessionId: string, effort: EffortLevel | null) => Promise<unknown>;
  /** 빠르게 — 같은 모델을 더 빠른 응답으로. 이 세션에만 걸린다. */
  setFastMode: (sessionId: string, fast: boolean) => Promise<unknown>;
  /** @-mention autocomplete, over the connected repo's files. */
  findFiles: (query: string, limit?: number) => Promise<string[]>;
  closeSession: (sessionId: string) => Promise<unknown>;
  deleteSession: (sessionId: string) => Promise<unknown>;
  /** A project's every thread at once — the tree's 대화 모두 지우기. */
  deleteAllSessions: (slug: string) => Promise<unknown>;
  respondPermission: (
    requestId: string,
    decision: "allow" | "allowAlways" | "deny",
    message?: string,
  ) => Promise<unknown>;
  respondQuestion: (
    requestId: string,
    answers: Record<string, string | string[]>,
    /** 선택 옆의 메모와 그때 보던 시안, 질문 글자를 키로. */
    annotations?: Record<string, { preview?: string; notes?: string }>,
  ) => Promise<unknown>;
  /** 이 작업만 중지 — 턴은 그대로 두고 그 작업만 세운다. */
  stopTask: (sessionId: string, taskId: string) => Promise<unknown>;
  /** 뒤로 보내기 — 턴을 붙잡은 작업을 백그라운드로 옮긴다. */
  backgroundTask: (sessionId: string, toolUseId: string) => Promise<{ moved: boolean }>;
  refreshStatus: () => Promise<void>;
  /**
   * The registry, asked for on connect. `hello` already carries it, so the
   * switcher only needs this after a change it did not see broadcast.
   */
  projectList: () => Promise<ProjectList>;
  /**
   * Register a project and bring it up: clone the repo, install when needed,
   * start the preview. Resolves with the created project; progress arrives
   * as `repo.status`.
   */
  projectCreate: (input: {
    name: string;
    repoUrl: string | null;
    baseBranch?: string;
    approveCommands?: boolean;
    /** E4(초대 v2): 넘긴 요청의 리뷰를 부탁할 개발자들. */
    reviewers?: string[];
    /** 프로젝트별 지침 — 세션의 시스템 프롬프트에 붙는다. */
    instructions?: string;
    /** false 면 등록만 한다 — 초대장이 여러 프로젝트를 한 번에 등록할 때 화면이 튀지 않게. */
    activate?: boolean;
  }) => Promise<ProjectSummary>;
  /** Rename, or re-point the repo url/base branch. */
  projectUpdate: (
    slug: string,
    changes: {
      name?: string;
      repoUrl?: string | null;
      baseBranch?: string;
      approveCommands?: boolean;
      /** 프로젝트별 지침; null 이나 빈 문자열이면 지운다. */
      instructions?: string | null;
      /** E4(초대 v2): 리뷰를 부탁할 개발자들; null 이면 지운다. */
      reviewers?: string[] | null;
    },
  ) => Promise<ProjectList>;
  /** Switch the active project; the outgoing preview stays warm unless its port is needed. */
  projectActivate: (slug: string) => Promise<ProjectList>;
  /** Forget a project; its folder survives unless `deleteFiles`. */
  projectRemove: (slug: string, deleteFiles?: boolean) => Promise<ProjectList>;
  /** Open the project's clone folder in the OS file manager (hover card). */
  projectOpenFolder: (slug: string) => Promise<{ ok: boolean }>;
  repoStatus: () => Promise<RepoStatus>;
  /**
   * Clone when missing, pull, install when needed, start the preview. `force`
   * is the error screen's 다시 시작: kill whatever holds the declared preview
   * port before starting.
   */
  repoSync: (force?: boolean) => Promise<RepoStatus>;
  /** Worktree changes not saved yet, for the 저장 review panel. */
  diff: () => Promise<DiffFile[]>;
  /**
   * 저장: run the gates, then commit and push onto this cycle's own
   * `colo-design/…` branch. Progress arrives as `diff.status`.
   */
  save: (message?: string, sessionId?: string | null) => Promise<DiffStatus>;
  /**
   * 개발자에게 넘기기: the `build` gate, then open (or update) the pull request
   * for the saved branch. Progress arrives as `diff.status` like a save does.
   */
  handoff: (input: {
    title?: string;
    body?: string;
    sessionId?: string | null;
  }) => Promise<DiffStatus>;
  /**
   * 상태 확인 — the pull request plus the developer's comments. Asked for by
   * the planner, never polled — the state only moves when a developer acts on
   * it. Null is the "nothing to check" answer (no open handoff): the read
   * itself DID happen, so the caller records it as a check instead of
   * failing it.
   */
  handoffStatus: () => Promise<HandoffStatusReport | null>;
  /**
   * 보낸 화면 동결: one committed capture read out of the
   * handoff branch — the frozen stage's '보낸 그대로'. Null back means no
   * shot was committed. (2026-09-21 상태 축 철거 — 주소는 route 하나다.)
   */
  handoffShot: (route: string) => Promise<{ mediaType: string; data: string } | null>;
  /**
   * 시점 빌드 재현: the handed-off moment's REAL
   * build — the handoff branch's tip in a throwaway worktree, served on a
   * second port. `ready:false` is the honest answer (no open handoff, a
   * server that would not come up) and the frozen stage falls back to the
   * committed capture. The `sessionId` ties the build's life to the
   * conversation that opened it — its close reaps the worktree.
   */
  handoffPreview: (sessionId?: string | null) => Promise<HandoffPreviewInfo>;
  /**
   * 개발자에게 넘기기의 초안 (비개발자 넘기기): one no-tool agent turn over
   * this cycle's 저장 메모, answered as the title and the paragraph the
   * developer reads first. Empty strings keep the browser's own proposal.
   */
  handoffDraft: () => Promise<HandoffDraft>;
  /**
   * 저장 기록: the saved commits of this cycle, `base` → HEAD.
   */
  saveHistory: () => Promise<SaveHistory>;
  /**
   * 되돌리기: put the worktree back to `sha` as a NEW commit — no
   * reset, no force-push; a developer may be reading the branch. Refuses
   * while unsaved changes sit in the worktree. Progress arrives as
   * `diff.status`, like a save.
   */
  restore: (sha: string) => Promise<DiffStatus>;
  /**
   * 패인 오류의 판정: re-open one screen in the daemon's isolated
   * verification window (게이트와 같은 드라이버·같은 판정) — did the page
   * settle, and what did its console count as trouble. Null is "확인
   * 불능" (no driver, the server just died, the route is gone): not a
   * verdict, and the caller falls to the safe side — the card.
   */
  screenCheck: (route: string) => Promise<ScreenCheckReport | null>;
  /**
   * 코멘트 기록: a pin batch lands in the project's comments.json
   * at send time as DELIVERED — the turn carrying the words is the delivery,
   * so every row is born resolved and the store is an append-only log.
   */
  recordComments: (input: {
    items: Array<{
      /** The pin's overlay UUID — the row joins the tray/badge/card on it. */
      id?: string;
      screen: string;
      /** The pin's own memo, verbatim — empty when none was written. */
      text: string;
      elementText: string;
      /** 수정 ↔ 질문 — absent reads as change. */
      intent?: "change" | "question";
      element?: {
        component: string;
        path: string;
        rect: { x: number; y: number; width: number; height: number };
      };
    }>;
  }) => Promise<{ recorded: number }>;
  /** 답하기: the planner's answer to one developer comment. */
  replyToReview: (id: number, body: string) => Promise<{ ok: true }>;
  /**
   * 여기서 새 대화(분기): keep this answer's memory in a NEW conversation —
   * the old one stays. The reply is the NEW session id; `memoryKept: false`
   * names the provider that could not fork the transcript.
   */
  branch: (sessionId: string, turn: number) => Promise<{ sessionId: string; memoryKept: boolean }>;
  /** The four onboarding checks; read-only. `provider` picks the agent gate. */
  onboardingCheck: (provider?: string) => Promise<OnboardingStep[]>;
  /**
   * Store (or clear) the machine-wide GitHub token; resolves with the
   * recomputed `github` step.
   */
  githubTokenSet: (token: string | null) => Promise<OnboardingStep>;
  /** 슬라이스 5: 개발자 에스컬레이션(Slack) 설정 — 값은 돌아오지 않는다. */
  escalationSet: (
    config:
      | { kind: "webhook"; url: string }
      | { kind: "bot"; token: string; channel: string }
      | null,
  ) => Promise<{ ok: true }>;
  escalationTest: () => Promise<{ ok: true }>;
  /** 막다른 카드의 `개발자 부르기`(P3-3) — 화면이 지은 한 문장을 슬랙으로. */
  escalationNotify: (text: string) => Promise<{ ok: true }>;
  /** 설정창의 저장 메모 담당 — null 은 자동(기본). 거절은 한국어 한 줄이다. */
  machineSet: (provider: string | null) => Promise<{ ok: true }>;
  /** 넘긴 요청에 적을 작성자 이름 — null 이면 지운다(P1-3). */
  machineAuthorSet: (name: string | null) => Promise<{ ok: true }>;
  /** Judge one repo before any clone. */
  githubRepoInspect: (owner: string, repo: string) => Promise<GitHubRepoInspection>;
  /** Run a fix; resolves with whatever the fix returns (status/guidance). */
  onboardingFix: (
    kind: OnboardingFixKind,
    /** 로그인 고침이 어느 에이전트의 것인지 — 드라이버가 자기 명령을 선언한다. */
    provider?: string,
  ) => Promise<unknown>;
  /** 로그인 코드 붙여넣기 — 데몬이 자식 stdin 으로 흘려 보낸다(P1-1). */
  agentLoginCode: (code: string) => Promise<{ ok: true }>;
}

/** One connection to one daemon, as the views consume it. */
export interface Daemon {
  connection: ConnectionState;
  connectionError: string | null;
  /**
   * 지금 다시 시도 — 예약된 백오프를 버리고 즉시 connect()를 다시 돌린다.
   * url이 없어 연결 루프가 선 적 없으면 조용한 no-op.
   */
  reconnect: () => void;
  status: DaemonStatus | null;
  /**
   * Every registered project, and which one everything else means. Seeded
   * from `hello`, re-pointed by `project.changed` — two windows on one daemon
   * must never disagree about what they are showing.
   */
  projects: ProjectSummary[];
  activeSlug: string | null;
  /**
   * 대화 지우기의 낙관 숨김 (thread-visibility 참조). 확인 대화상자가 승인한
   * 순간 행을 먼저 거두고, 데몬의 `project.changed`가 따라오면 조정으로
   * 거둔다 — 저장 스캔과 브로드캐스트의 한 바퀴를 화면이 기다리지 않게.
   */
  hiddenThreads: HiddenThreads;
  hideThread: (slug: string, sessionId: string) => void;
  unhideThread: (slug: string, sessionId: string) => void;
  hideAllThreads: (slug: string) => void;
  unhideAllThreads: (slug: string) => void;
  sessions: Record<string, SessionView>;
  pending: Pending[];
  api: DaemonApi;
  /** Connected repo state; null until the daemon has reported it once. */
  repo: RepoStatus | null;
  /**
   * Where the current 저장 or 넘기기 stands; null until one starts. Both share
   * one channel — the daemon runs one at a time against one clone.
   */
  diffStatus: DiffStatus | null;
  /**
   * "에이전트 조작 중" 표시가 읽는다 — 조작 중인 세션 id 들.
   * `browser.driving` 브로드캐스트가 켜고 끄고, 세션 종료·연결 끊김에 함께
   * 거둔다.
   */
  browserDriving: ReadonlySet<string>;
  /**
   * 데몬이 몰고 있는 에이전트 로그인의 판(P1-1) — 주소와 코드 붙여넣기 칸
   * 여부. 진행 중이 아닐 때 null. `loginDone` 은 마지막 끝의 알림.
   */
  login: { url: string; wantsCode: boolean } | null;
  loginDone: { ok: boolean; detail: string } | null;
  /**
   * 데몬이 끝까지 지켜보는 에이전트 설치(1단계)의 마지막 진행 줄 — 진행 중이
   * 아닐 때 null. `installDone` 은 마지막 끝의 알림.
   */
  install: { kind: AgentInstallKind; line: string } | null;
  installDone: { kind: AgentInstallKind; ok: boolean; detail: string } | null;
  /** Latest onboarding checks; null until first check returns. */
  onboarding: OnboardingStep[] | null;
  /**
   * The provider `onboarding` was computed for — the cache's or the latest
   * check's. 설정에서 프로바이더를 바꾼 창이 이 값으로 재검사를 걸어 둔다.
   */
  onboardingProvider: string | null;
  resolvePending: (requestId: string) => void;
  ensureSession: (sessionId: string) => void;
  hydrate: (sessionId: string, events: ChatEvent[]) => void;
  markLive: (sessionId: string) => void;
  /** Forget one undelivered send the planner has restored or let go of. */
  dismissDropped: (sessionId: string, itemId: string) => void;
}

// ---------------------------------------------------------------------------
// Background-thread notifications — the web path of the desktop's
// Electron notices. The daemon knows nothing of windows here, so the client
// watches the session map itself and decides from the transition.
// ---------------------------------------------------------------------------

/** Asked once, after the planner's first send — never again. */
const NOTIFICATION_ASKED_KEY = "colo-design.notification-asked";

/**
 * The desktop asks nothing and notifies from its own main process (this is
 * the BROWSER path); a second voice would ring twice.
 */
function requestNotificationPermissionOnce(): void {
  if (typeof Notification === "undefined" || window.coloDesignDesktop) return;
  try {
    if (localStorage.getItem(NOTIFICATION_ASKED_KEY)) return;
    localStorage.setItem(NOTIFICATION_ASKED_KEY, "1");
    void Notification.requestPermission();
  } catch {
    // Storage can be blocked (private mode, embedded views); no ask, no harm.
  }
}

/**
 * The one notification's copy, worded like the desktop's notices: the
 * thread's name is the title, the body says what to check once the window
 * is open.
 */
function backgroundNotice(
  title: string,
  state: SessionState,
): { title: string; body: string } | null {
  switch (state) {
    case "idle":
      return {
        title: `${title} · 완료`,
        body: "AI가 답을 마쳤습니다. 열어서 확인해 보세요.",
      };
    case "error":
      return {
        title: `${title} · 중단`,
        body: "AI가 중단됐습니다. 대화에서 이유를 확인할 수 있습니다.",
      };
    case "waiting_permission":
      return {
        title: `${title} · 확인 필요`,
        body: "AI가 진행 허락을 기다리고 있습니다.",
      };
    case "waiting_question":
      return {
        title: `${title} · 답 필요`,
        body: "AI가 질문에 대한 답을 기다리고 있습니다.",
      };
    default:
      return null;
  }
}
/**
 * 3단계 알림 위계(홈 계획 P3-3)의 세 번째 문: 기다림 상태는 그 원인인 요청의
 * `blocking` 판정이 true일 때만 사람을 부른다. 완료(idle)·중단(error)는 판정
 * 없이 언제나 지나간다 — 조용한 요청은 홈의 로그와 뱃지에만 남는다. 데몬이
 * 요청을 상태보다 먼저 방송하므로(pending 생성 지점), 이 전환을 읽는 시점엔
 * 판정이 이미 도착해 있다.
 */
function blockingAsk(state: SessionState, sessionId: string, pending: Pending[]): boolean {
  if (state !== "waiting_permission" && state !== "waiting_question") return true;
  return pending.some((item) => item.sessionId === sessionId && item.blocking === true);
}
/**
 * A background thread finished or started waiting: look its name up and
 * raise the browser notification. Permission never granted (or a browser
 * without the API) makes this a no-op — the in-app strip still tells the
 * story.
 */
async function notifyBackgroundThread(
  findTitle: (sessionId: string) => Promise<string | null>,
  sessionId: string,
  state: SessionState,
  turnDurationMs?: number,
): Promise<void> {
  if (typeof Notification === "undefined" || window.coloDesignDesktop) return;
  if (Notification.permission !== "granted") return;
  // 알림 시점 정책: 완료만 3상태를 탄다. 확인 요청·중단은
  // 언제나 온다. 걸린 시간을 모르는 완료는 "오래 걸린" 쪽으로 묶는다.
  const prefs = currentNoticePrefs();
  if (state === "idle") {
    if (prefs.done === "off") return;
    if (prefs.done === "long" && (turnDurationMs ?? LONG_TURN_MS) < LONG_TURN_MS) return;
  }
  const stored = await findTitle(sessionId).catch(() => null);
  const notice = backgroundNotice(stored ?? "대화", state);
  if (!notice) return;
  try {
    new Notification(notice.title, { body: notice.body, silent: !prefs.sound });
  } catch {
    // Some browsers gate the constructor behind a service worker; the strip
    // is the fallback there too.
  }
}

/** The last check's verdict, kept across reloads: without it a planner who
 *  already passed every gate reloads into the wizard while the fresh check
 *  spawns real commands. The check still runs on every connect and
 *  overwrites this — a gate that broke since is caught a beat later. */
const ONBOARDING_CACHE_KEY = "colo-design.onboarding";

interface OnboardingCache {
  provider: string | null;
  steps: OnboardingStep[];
}

function readOnboardingCache(): OnboardingCache {
  try {
    const raw = localStorage.getItem(ONBOARDING_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<OnboardingCache> | OnboardingStep[] | null;
      // A pre-provider cache was a bare step list and always Claude's — the
      // only agent the gate knew then.
      if (Array.isArray(parsed)) return { provider: "claude", steps: parsed };
      if (parsed && Array.isArray(parsed.steps))
        return { provider: parsed.provider ?? null, steps: parsed.steps };
    }
  } catch {
    // Storage can be unavailable (private mode); the session works without
    // the cache — it only costs the reload a wizard beat.
  }
  return { provider: null, steps: [] };
}

/**
 * 요청의 멱등 키 — 응답 상관을 겸한다. 데몬이 id 로 같은 실행을 한 번만 하므로
 * 전역 유일해야 한다: 창끼리 `c1` 을 재사용하던 옛 발행은 서로의 답을 삼켰다.
 */
function mintRequestId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useDaemon(url: string | null): Daemon {
  const socket = useRef<WebSocket | null>(null);
  const pendingCalls = useRef(
    new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>(),
  );

  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [hiddenThreads, setHiddenThreads] = useState<HiddenThreads>({});
  const [sessions, setSessions] = useState<Record<string, SessionView>>({});
  const [pending, setPending] = useState<Pending[]>([]);
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  const [diffStatus, setDiffStatus] = useState<DiffStatus | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingStep[] | null>(() => {
    const cached = readOnboardingCache();
    return cached.steps.length > 0 ? cached.steps : null;
  });
  const [onboardingProvider, setOnboardingProvider] = useState<string | null>(
    () => readOnboardingCache().provider,
  );
  /**
   * 터미널 없는 에이전트 로그인(P1-1): 데몬이 파이프로 몰고 있는 로그인의
   * 판 — 주소와 코드 붙여넣기 칸 여부. `agent.login.url` 이 그리고
   * `agent.login.done` 이 지운다.
   */
  const [login, setLogin] = useState<{ url: string; wantsCode: boolean } | null>(null);
  /** 로그인의 끝 — ok 면 게이트 재검사가 뒤따르고, 아니면 detail 이 이유다. */
  const [loginDone, setLoginDone] = useState<{ ok: boolean; detail: string } | null>(null);
  /**
   * 데몬이 지켜보는 에이전트 설치(1단계)의 마지막 진행 줄. 설치 종류마다 하나씩
   * 도니 kind 를 싣는다. `onboarding.install.progress` 가 쓰고 done 이 지운다.
   */
  const [install, setInstall] = useState<{ kind: AgentInstallKind; line: string } | null>(null);
  /** 설치의 끝 — ok 면 게이트 재검사가 뒤따르고, 아니면 detail 이 이유다. */
  const [installDone, setInstallDone] = useState<{
    kind: AgentInstallKind;
    ok: boolean;
    detail: string;
  } | null>(null);
  /**
   * 에이전트가 브라우저를 조작 중인 세션들: `browser.driving` 브로드캐스트가
   * 켜고 끄는 세션 id 목록.
   */
  const [driving, setDriving] = useState<Set<string>>(new Set());
  /**
   * The thread the planner is looking at: the last one they opened or spoke
   * into. A DIFFERENT thread settling is what a notification is for;
   * the one on screen settles where they can see it.
   */
  const watched = useRef<string | null>(null);
  /** The states at the previous pass — the transition is the event. */
  const prevStates = useRef<Record<string, SessionState>>({});
  /** 세션별 최근 running 진입 시각 — 완료 알림의 "오래 걸린 턴"을 재는 시계. */
  const runningSince = useRef<Record<string, number>>({});
  /**
   * 연결 루프 안의 즉시 재시도 진입점 — effect가 닫힌 뒤에도 마지막 루프를
   * 가리키게 ref로 둔다. 루프가 없으면(null url) null이라 호출이 no-op.
   */
  const reconnectRef = useRef<(() => void) | null>(null);

  // --- 낙관 숨김 (대화 지우기) --------------------------------------------
  // 지우기 승인의 같은 커밋에서 행을 거둔다. 데몬의 목록(`projects`)이
  // 따라올 때마다 이미 무의미해진 숨김을 거둔다 — thread-visibility의 규칙.
  const hideThread = useCallback((slug: string, sessionId: string) => {
    setHiddenThreads((current) => hideThreadIn(current, slug, sessionId));
  }, []);
  const unhideThread = useCallback((slug: string, sessionId: string) => {
    setHiddenThreads((current) => unhideThreadIn(current, slug, sessionId));
  }, []);
  const hideAllThreads = useCallback((slug: string) => {
    setHiddenThreads((current) => hideAllThreadsIn(current, slug));
  }, []);
  const unhideAllThreads = useCallback((slug: string) => {
    setHiddenThreads((current) => unhideAllThreadsIn(current, slug));
  }, []);
  useEffect(() => {
    setHiddenThreads((current) => pruneHidden(current, projects));
  }, [projects]);

  // 프로젝트가 바뀌면 지난 프로젝트의 저장·넘기기 판정도 지난 것이다. 이 판정은
  // 전역에 하나뿐인데 데몬은 전환 때 repo.status 만 새로 주므로(diff.status 는
  // 활성 프로젝트의 저장·넘기기가 움직일 때만 온다), 비우지 않으면 새 프로젝트의
  // 대화가 옛 프로젝트의 실패 배너와 넘김 수령 화면을 입고 그린다(베타 테스트 B8).
  // 새 프로젝트의 판정은 그 저장·넘기기가 움직이는 순간 제 판으로 도착한다.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSlug 는 값이 아니라 트리거다 — 읽지 않고 바뀜에만 반응한다.
  useEffect(() => {
    setDiffStatus(null);
  }, [activeSlug]);

  useEffect(() => {
    if (!url) return;
    setConnection("connecting");
    setConnectionError(null);

    let ws: WebSocket | null = null;
    let disposed = false;
    let everOpen = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const flushPending = () => {
      for (const call of pendingCalls.current.values())
        call.reject(new Error("연결이 끊어졌습니다 — 잠시 뒤 대화나 화면을 다시 확인해 주세요"));
      pendingCalls.current.clear();
    };

    const connect = () => {
      if (disposed) return;
      setConnection("connecting");
      let sock: WebSocket;
      try {
        sock = new WebSocket(url);
      } catch (error) {
        setConnection("error");
        setConnectionError(error instanceof Error ? error.message : "invalid daemon url");
        return;
      }
      ws = sock;
      socket.current = sock;

      sock.onopen = () => {
        if (disposed) {
          sock.close();
          return;
        }
        everOpen = true;
        attempt = 0;
        setConnection("open");
      };
      sock.onerror = () => {
        // A dead socket always closes right after; the reconnect decision
        // lives in onclose so nothing has to be duplicated here.
      };
      sock.onclose = () => {
        // reconnect()가 새 소켓을 세운 뒤 늦게 도착한 옛 소켓의 onclose는
        // 무시한다 — 그대로 두면 새 소켓을 지우고 재시도를 한 번 더 건다.
        if (ws !== sock) return;
        socket.current = null;
        if (disposed) return;
        flushPending();
        // 데몬이 끊기면 조작 중 표시의 끝 신호도 함께 죽는다 — 재연결 뒤에도
        // 스피너가 남지 않게 여기서 전부 거둔다.
        setDriving(new Set());
        if (!everOpen) {
          // First attempt never got in: most likely a wrong url or the daemon
          // is genuinely down. Show the connect screen; the retry below still
          // brings the app back if the daemon appears afterwards.
          setConnection("error");
          setConnectionError("데몬에 연결하지 못했습니다 — 자동으로 다시 연결합니다.");
        } else {
          // 한 번은 붙었던 선이 끊긴 것 — 화면은 살아 있으니 ConnectScreen이
          // 아니라 "closed" 배너가 알린다. 백오프 재시도는 아래에서 계속 돈다.
          setConnection("closed");
        }
        const delay = Math.min(1000 * 2 ** attempt, 5000);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };

      sock.onmessage = handleMessage;
    };

    const handleMessage = (raw: MessageEvent) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.data as string) as ServerMessage;
      } catch {
        // A frame that is not JSON is not ours — drop it silently.
        return;
      }
      // The minimal envelope: an object carrying a string `type`. Anything
      // else on the wire is dropped without a word.
      if (typeof message !== "object" || message === null || typeof message.type !== "string")
        return;

      if (message.type === "ok" || message.type === "error") {
        const call = pendingCalls.current.get(message.id ?? "");
        if (call) {
          pendingCalls.current.delete(message.id!);
          if (message.type === "ok") call.resolve(message.data);
          else call.reject(new Error(message.message));
        }
        return;
      }

      if (message.type === "hello" || message.type === "status") {
        if (message.type === "hello" && message.protocolVersion !== PROTOCOL_VERSION) {
          // 선로 버전이 어긋난다 — 이 창이 아는 말과 데몬이 보내는 말이
          // 다르다. 연결은 둔 채 로그에만 남긴다: 모르는 프레임은 위에서
          // 조용히 버려지므로 대화는 이어진다.
          console.warn(
            `[daemon] protocol mismatch — daemon v${message.protocolVersion}, app v${PROTOCOL_VERSION}`,
          );
        }
        setStatus(message.status);
        // Status carries the registry, so a reconnect re-points the switcher
        // without a round trip of its own.
        setProjects(message.status.projects);
        setActiveSlug(message.status.activeProject);
        return;
      }

      if (message.type === "project.changed") {
        setProjects(message.projects);
        setActiveSlug(message.activeSlug);
        return;
      }

      if (message.type === "repo.status") {
        setRepo(message.status);
        return;
      }

      if (message.type === "diff.status") {
        setDiffStatus(message.status);
        return;
      }

      if (message.type === "session.event") {
        // The envelope's inner half: `event` must be an object carrying a
        // string `kind` before applyEvent reads it.
        if (
          typeof message.event !== "object" ||
          message.event === null ||
          typeof message.event.kind !== "string"
        )
          return;
        setSessions((prev) => {
          const view = prev[message.sessionId] ?? EMPTY_SESSION;
          const next = applyEvent(view, message.event);
          return { ...prev, [message.sessionId]: next };
        });
        return;
      }
      if (message.type === "browser.driving") {
        // "에이전트 조작 중" 표시. on:true는 그 세션의 조작 시작, on:false는 끝.
        setDriving((prev) => {
          const next = new Set(prev);
          if (message.on) next.add(message.sessionId);
          else next.delete(message.sessionId);
          return next;
        });
        return;
      }
      if (message.type === "agent.login.url") {
        // 데몬이 몰고 있는 로그인의 판 — 주소(wantsCode 일 때 코드 칸 포함).
        setLogin({ url: message.url, wantsCode: message.wantsCode });
        return;
      }
      if (message.type === "agent.login.done") {
        setLogin(null);
        setLoginDone({ ok: message.ok, detail: message.detail });
        return;
      }
      if (message.type === "onboarding.install.progress") {
        // 데몬이 지켜보는 설치의 마지막 의미 있는 줄 — 같은 줄은 다시 오지
        // 않는다(진행기가 억제한다).
        setInstall({ kind: message.kind, line: message.line });
        return;
      }
      if (message.type === "onboarding.install.done") {
        setInstall(null);
        setInstallDone({ kind: message.kind, ok: message.ok, detail: message.detail });
        return;
      }
      if (message.type === "session.state") {
        setSessions((prev) => ({
          ...prev,
          [message.sessionId]: {
            ...(prev[message.sessionId] ?? EMPTY_SESSION),
            state: message.state,
            // 데몬이 시작 시각을 붙여 보낸다 — 붙지 않은 상태는 도는 턴이
            // 없다는 뜻이므로 시계도 함께 꺼진다.
            turnStartedAt: message.startedAt ?? null,
          },
        }));
        // 기다림이 사라진 세션의 확인·질문 카드는 답을 받을 곳이 없다 —
        // 다른 창이 답했거나, 소켓이 끊긴 동안 답이 나갔다. 데몬의 방송에는
        // '해결됨'이 따로 없으므로 기다리지 않는 상태가 곧 해결의 신호다.
        if (message.state !== "waiting_permission" && message.state !== "waiting_question") {
          setPending((prev) => prev.filter((p) => p.sessionId !== message.sessionId));
        }
        // 죽은 세션의 조작 표시도 함께 걷어 낸다 — on:false를 놓친 채 죽은
        // 세션이 스피너를 남기지 않게.
        if (message.state === "error" || message.state === "closed") {
          setDriving((prev) => {
            if (!prev.has(message.sessionId)) return prev;
            const next = new Set(prev);
            next.delete(message.sessionId);
            return next;
          });
        }
        return;
      }

      if (message.type === "permission.request" || message.type === "question.request") {
        // Dedupe by requestId: the daemon replays pending requests
        // to a RECONNECTING socket, and a flapping socket can race its own
        // replay — without this, the same card stacks twice.
        const requestId = message.requestId;
        setPending((prev) => {
          if (prev.some((p) => p.requestId === requestId)) return prev;
          const entry: Pending =
            message.type === "permission.request"
              ? {
                  kind: "permission",
                  requestId,
                  sessionId: message.sessionId,
                  toolName: message.toolName,
                  input: message.input,
                  suggestions: message.suggestions,
                  blocking: message.blocking,
                  requestedAt: message.requestedAt,
                }
              : {
                  kind: "question",
                  requestId,
                  sessionId: message.sessionId,
                  questions: message.questions,
                  blocking: message.blocking,
                  requestedAt: message.requestedAt,
                };
          return [...prev, entry];
        });
      }
    };

    // 지금 다시 시도: 예약된 백오프를 버리고 곧장 connect()를 돌린다. 살아
    // 있는 소켓이 있으면 먼저 닫는다 — 그 onclose는 위의 ws!==sock 가드가
    // 걸러 이중 재시도가 생기지 않는다.
    reconnectRef.current = () => {
      if (disposed) return;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      attempt = 0;
      if (ws) {
        flushPending();
        ws.close();
      }
      connect();
    };

    connect();

    return () => {
      disposed = true;
      reconnectRef.current = null;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        // In-flight calls must hear the end now — onclose is already
        // detached, so without this they would hang to their timeouts.
        flushPending();
        ws.close();
      }
      socket.current = null;
    };
  }, [url]);

  // "지금 다시 시도" 버튼이 부른다 — 실제 재시도는 연결 루프(effect) 안에
  // 살고, 여기서는 그 진입점을 안정된 콜백으로 보낸다.
  const reconnect = useCallback(() => {
    reconnectRef.current?.();
  }, []);

  const call = useCallback(
    <T>(payload: Record<string, unknown>, timeoutMs = 60_000): Promise<T> => {
      const ws = socket.current;
      if (!ws || ws.readyState !== ws.OPEN)
        return Promise.reject(new Error("아직 연결되지 않았습니다"));
      const id = mintRequestId();
      return new Promise<T>((resolve, reject) => {
        pendingCalls.current.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        // The correlation id rides LAST: a payload carrying its own `id` must
        // never overwrite the return address the reply is matched by.
        ws.send(JSON.stringify({ ...payload, id }));
        setTimeout(() => {
          // Not "retry": a blind resend here would still double a command the
          // daemon has not answered yet. The honest line is that the reply is
          // late — go look, then decide. When a retry IS offered (실패 카드의
          // 다시 보내기), it must reuse the SAME id: the daemon dedupes by id
          // and answers the remembered reply instead of running twice.
          if (pendingCalls.current.delete(id))
            reject(new Error("응답이 늦어졌습니다 — 잠시 뒤 대화나 화면을 다시 확인해 주세요."));
        }, timeoutMs);
      });
    },
    [],
  );

  /** Keep the reply of a repo request as state, so a caller gets both. */
  const keepRepo = useCallback((next: RepoStatus) => {
    setRepo(next);
    return next;
  }, []);

  /**
   * Keep a registry reply as state. The reply and its `project.changed`
   * broadcast race, and whichever lands second carries the same registry.
   */
  const keepProjects = useCallback((next: ProjectList) => {
    setProjects(next.projects);
    setActiveSlug(next.activeSlug);
    return next;
  }, []);

  const api = useMemo<DaemonApi>(
    () => ({
      listSessions: () =>
        call<SessionSummary[]>({ type: "session.list" }).then((list) => {
          // 재접속 복원: a window that just reconnected starts from
          // an empty map, so a turn running on the daemon showed as a silent
          // transcript — no lamp, no spinner, no end signal. The list IS the
          // daemon's truth; adopt live+state for every session it names —
          // 진행 시계의 시작 시각까지. 그러지 않으면 새로고침한 창이 이미
          // 3분째인 턴을 0초부터 다시 센다.
          setSessions((prev) => {
            let next = prev;
            for (const summary of list) {
              const view = next[summary.sessionId];
              if (
                view &&
                view.live === summary.live &&
                view.state === summary.state &&
                view.turnStartedAt === summary.turnStartedAt
              )
                continue;
              if (next === prev) next = { ...prev };
              next[summary.sessionId] = {
                ...(next[summary.sessionId] ?? EMPTY_SESSION),
                live: summary.live,
                state: summary.state,
                turnStartedAt: summary.turnStartedAt,
              };
            }
            // The list is the daemon's truth in both directions: a session
            // it no longer names was deleted, and its view is a ghost.
            const alive = new Set(list.map((summary) => summary.sessionId));
            for (const sessionId of Object.keys(next)) {
              if (alive.has(sessionId)) continue;
              if (next === prev) next = { ...prev };
              delete next[sessionId];
            }
            return next;
          });
          return list;
        }),
      // The notification click names a session — the UI asks which
      // project owns it before it can reach the conversation.
      locateSession: (sessionId: string) =>
        call<SessionLocation>({ type: "session.locate", sessionId }, 15_000),
      history: (sessionId: string) => call<ChatEvent[]>({ type: "session.history", sessionId }),
      createSession: (opts?: {
        provider?: string;
        resume?: string;
        model?: string;
        effort?: EffortLevel;
        title?: string;
      }) =>
        call<{ sessionId: string }>({
          type: "session.create",
          ...(opts?.provider ? { provider: opts.provider } : {}),
          ...(opts?.resume ? { resume: opts.resume } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.effort ? { effort: opts.effort } : {}),
          ...(opts?.title ? { title: opts.title } : {}),
        }),
      send: (
        sessionId: string,
        text: string,
        attachments?: Array<{ name: string; mediaType: string; data: string }>,
        pins?: Array<{ screen: string }>,
        mode?: "queue" | "steer",
        pinHints?: SessionPinHint[],
      ) => {
        // Speaking into a thread is looking at it, and the first send
        // is the one moment the browser may ask about notifications.
        watched.current = sessionId;
        requestNotificationPermissionOnce();
        return call({
          type: "session.send",
          sessionId,
          text,
          ...(attachments?.length ? { attachments } : {}),
          ...(pins?.length ? { pins } : {}),
          ...(mode ? { mode } : {}),
          ...(pinHints?.length ? { pinHints } : {}),
        });
      },
      interrupt: (sessionId: string) => call({ type: "session.interrupt", sessionId }),
      queueRemove: (sessionId: string, itemId: string) =>
        call<QueuedSendPayload>({ type: "session.queue.remove", sessionId, itemId }),
      queueSendNow: (sessionId: string, itemId: string) =>
        call({ type: "session.queue.sendNow", sessionId, itemId }),
      queueTakeDropped: (sessionId: string, itemId: string) =>
        call<QueuedSendPayload>({ type: "session.queue.takeDropped", sessionId, itemId }),
      queueDismissDropped: (sessionId: string, itemId: string) =>
        call({ type: "session.queue.dismissDropped", sessionId, itemId }),
      contextUsage: (sessionId: string) =>
        call<ContextUsage | null>({ type: "session.contextUsage", sessionId }),
      selectors: (sessionId: string) =>
        call<SessionSelectors>({ type: "session.selectors", sessionId }),
      commands: (sessionId: string) =>
        call<SessionCommand[]>({ type: "session.commands", sessionId }),
      cliCommands: () =>
        call<SessionCommand[]>(
          { type: "cli.commands" },
          // The probe boots the CLI once — seconds, not the usual round trip.
          60_000,
        ),
      findFiles: (query: string, limit = 40) =>
        call<string[]>({ type: "repo.files", query, limit }),
      setModel: (sessionId: string, model: string | null) =>
        call({ type: "session.setModel", sessionId, model }),
      setEffort: (sessionId: string, effort: EffortLevel | null) =>
        call({ type: "session.setEffort", sessionId, effort }),
      setFastMode: (sessionId: string, fast: boolean) =>
        call({ type: "session.setFastMode", sessionId, fast }),
      respondPermission: (
        requestId: string,
        decision: "allow" | "allowAlways" | "deny",
        message?: string,
      ) => call({ type: "permission.respond", requestId, decision, message }),
      closeSession: (sessionId: string) => call({ type: "session.close", sessionId }),
      deleteSession: (sessionId: string) =>
        call(
          { type: "session.delete", sessionId },
          // A stored transcript is removed with the session.
          120_000,
        ).then((result) => {
          // The daemon forgot it; the window forgets it too — the view, the
          // transition memory, and the running clock all die with it.
          setSessions((prev) => {
            if (!prev[sessionId]) return prev;
            const next = { ...prev };
            delete next[sessionId];
            return next;
          });
          delete prevStates.current[sessionId];
          delete runningSince.current[sessionId];
          return result;
        }),
      deleteAllSessions: (slug: string) => call({ type: "session.deleteAll", slug }, 120_000),
      respondQuestion: (
        requestId: string,
        answers: Record<string, string | string[]>,
        annotations?: Record<string, { preview?: string; notes?: string }>,
      ) =>
        call({
          type: "question.respond",
          requestId,
          answers,
          ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
        }),
      stopTask: (sessionId: string, taskId: string) =>
        call({ type: "session.stopTask", sessionId, taskId }),
      backgroundTask: (sessionId: string, toolUseId: string) =>
        call<{ moved: boolean }>({ type: "session.backgroundTask", sessionId, toolUseId }),
      refreshStatus: () =>
        call<DaemonStatus>({ type: "daemon.status" }).then((status) => {
          // The status carries the registry like the broadcast does — a
          // refresh that skipped it would leave the switcher stale.
          setStatus(status);
          setProjects(status.projects);
          setActiveSlug(status.activeProject);
        }),
      projectList: () => call<ProjectList>({ type: "project.list" }).then(keepProjects),
      // Creating clones the repo and installs when needed: a first run is
      // minutes, not the minute a normal request gets.
      projectCreate: (input: {
        name: string;
        repoUrl: string | null;
        baseBranch?: string;
        approveCommands?: boolean;
        reviewers?: string[];
        instructions?: string;
        /** 초대 v4(PLAN 단계 5): 개발자가 실어 보낸 새 대화의 처음 값. */
        defaults?: ProjectDefaults;
        /** 초대 v4: 사이클의 수명 규칙. */
        lifecycle?: ProjectLifecycle;
        activate?: boolean;
      }) =>
        call<ProjectSummary>(
          {
            type: "project.create",
            name: input.name,
            repoUrl: input.repoUrl,
            ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
            // Absent reads as not approved daemon-side — the gate's default
            // is "nobody has vouched for these commands yet".
            ...(input.approveCommands ? { approveCommands: true } : {}),
            ...(input.reviewers ? { reviewers: input.reviewers } : {}),
            ...(input.instructions ? { instructions: input.instructions } : {}),
            ...(input.defaults ? { defaults: input.defaults } : {}),
            ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
            ...(input.activate !== undefined ? { activate: input.activate } : {}),
          },
          900_000,
        ),
      // Activating stops one preview server and starts another, and the
      // incoming project may still need its clone or install.
      projectActivate: (slug: string) =>
        call<ProjectList>({ type: "project.activate", slug }, 600_000).then(keepProjects),
      projectUpdate: (
        slug,
        changes: {
          name?: string;
          repoUrl?: string | null;
          baseBranch?: string;
          approveCommands?: boolean;
          instructions?: string | null;
          reviewers?: string[] | null;
          /** 초대 v4(PLAN 단계 5): 개발자의 값이라 덮는다 — null 이면 지운다. */
          defaults?: ProjectDefaults | null;
          lifecycle?: ProjectLifecycle | null;
        },
      ) =>
        call<ProjectList>(
          {
            type: "project.update",
            slug,
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...(changes.repoUrl !== undefined ? { repoUrl: changes.repoUrl } : {}),
            ...(changes.baseBranch !== undefined ? { baseBranch: changes.baseBranch } : {}),
            ...(changes.approveCommands !== undefined
              ? { approveCommands: changes.approveCommands }
              : {}),
            ...(changes.instructions !== undefined ? { instructions: changes.instructions } : {}),
            ...(changes.reviewers !== undefined ? { reviewers: changes.reviewers } : {}),
            ...(changes.defaults !== undefined ? { defaults: changes.defaults } : {}),
            ...(changes.lifecycle !== undefined ? { lifecycle: changes.lifecycle } : {}),
          },
          // A moved url re-clones.
          600_000,
        ).then(keepProjects),
      projectRemove: (slug: string, deleteFiles?: boolean) =>
        call<ProjectList>(
          {
            type: "project.remove",
            slug,
            ...(deleteFiles ? { deleteFiles } : {}),
          },
          120_000,
        ).then(keepProjects),
      projectOpenFolder: (slug: string) =>
        call<{ ok: boolean }>({ type: "project.openFolder", slug }),
      repoStatus: () => call<RepoStatus>({ type: "repo.status" }).then(keepRepo),
      // A first run clones and installs the connected repo: minutes, not the
      // minute a normal request is given before it is declared lost. `force`
      // rides only the stopped screen's 다시 시작.
      repoSync: (force = false) =>
        call<RepoStatus>({ type: "repo.sync", ...(force ? { force: true } : {}) }, 600_000).then(
          keepRepo,
        ),

      diff: () => call<DiffFile[]>({ type: "diff.get" }, 120_000),
      // A save runs the repo's own check and build before pushing: the
      // same minutes a first sync is given.
      save: (message?: string, sessionId?: string | null) =>
        call<DiffStatus>(
          {
            type: "repo.save",
            ...(message ? { message } : {}),
            ...(sessionId ? { sessionId } : {}),
          },
          600_000,
        ),
      // A handoff is a gate plus a network write: the repo's `build` runs
      // first, and only then does the pull request go out. Same window as a
      // save, because the gate is the slow half of both.
      handoff: (input: { title?: string; body?: string; sessionId?: string | null }) =>
        call<DiffStatus>(
          {
            type: "repo.handoff",
            ...(input.title ? { title: input.title } : {}),
            ...(input.body ? { body: input.body } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          },
          600_000,
        ),
      githubTokenSet: (token: string | null) =>
        call<OnboardingStep>({ type: "github.token.set", token }, 60_000).then((step) => {
          // The reply is one gate; fold it into the wizard's list in place.
          setOnboarding((prev) =>
            prev ? prev.map((entry) => (entry.id === step.id ? step : entry)) : [step],
          );
          return step;
        }),
      // 슬라이스 5: 개발자 에스컬레이션(Slack) 설정 — 웹훅 또는 봇 토큰+채널.
      // 값은 저장소에만 살고 돌아오지 않는다(토큰과 같은 길).
      escalationSet: (
        config:
          | { kind: "webhook"; url: string }
          | { kind: "bot"; token: string; channel: string }
          | null,
      ) => call<{ ok: true }>({ type: "escalation.set", config }, 60_000),
      escalationTest: () => call<{ ok: true }>({ type: "escalation.test" }, 30_000),
      escalationNotify: (text: string) =>
        call<{ ok: true }>({ type: "escalation.notify", text }, 30_000),
      machineSet: (provider: string | null) =>
        call<{ ok: true }>({ type: "machine.set", provider }, 15_000),
      machineAuthorSet: (name: string | null) =>
        call<{ ok: true }>({ type: "machine.author.set", name }, 15_000),
      githubRepoInspect: (owner: string, repo: string) =>
        call<GitHubRepoInspection>({ type: "github.repo.inspect", owner, repo }, 60_000),
      // One read of one pull request — no gate, no push. The window a remote
      // read gets, not the one a transfer does.
      handoffStatus: () =>
        call<HandoffStatusReport | null>({ type: "repo.handoffStatus" }, 120_000),
      // One committed capture out of the handoff branch — a `git show`
      // read, so the window a remote read gets.
      handoffShot: (route: string) =>
        call<{ mediaType: string; data: string } | null>(
          { type: "repo.handoffShot", route },
          120_000,
        ),
      // the daemon queues opens, it never builds two worktrees.
      handoffPreview: (sessionId?: string | null) =>
        call<HandoffPreviewInfo>(
          { type: "repo.handoffPreview", ...(sessionId ? { sessionId } : {}) },
          180_000,
        ),
      // The draft runs one short agent turn on the daemon.
      handoffDraft: () => call<HandoffDraft>({ type: "repo.handoffDraft" }, 120_000),
      saveHistory: () => call<SaveHistory>({ type: "repo.history" }, 60_000),
      // A restore commits and pushes, and the repo's checks may run on the
      // way: the same window a save is given.
      restore: (sha: string) => call<DiffStatus>({ type: "repo.restore", sha }, 600_000),
      // 검증 창이 화면을 열고 문서가 완전히 로드되기를 기다리는 시간 —
      // 게이트의 한 화면과 같은 길이다. null 은 판정이 아니라 확인 불능이다.
      screenCheck: (route: string) =>
        call<ScreenCheckReport | null>({ type: "preview.screenCheck", route }, 120_000),
      recordComments: (input: {
        items: Array<{
          id?: string;
          screen: string;
          text: string;
          elementText: string;
          intent?: "change" | "question";
          element?: {
            component: string;
            path: string;
            rect: { x: number; y: number; width: number; height: number };
          };
        }>;
      }) => call<{ recorded: number }>({ type: "comments.record", items: input.items }),
      replyToReview: (id: number, body: string) =>
        call<{ ok: true }>({ type: "comments.reply", reviewId: id, body }, 60_000),
      // 대화 분기: 답을 하나도 보내지 않는다 — 포크의 악수(절단 재개)만
      // 기다린다.
      branch: (sessionId, turn) =>
        call<{ sessionId: string; memoryKept: boolean }>(
          { type: "session.branch", sessionId, turn },
          120_000,
        ),
      onboardingCheck: (provider?: string) =>
        call<OnboardingStep[]>(
          { type: "onboarding.check", ...(provider ? { provider } : {}) },
          120_000,
        ).then((steps) => {
          const forProvider = provider ?? "claude";
          try {
            localStorage.setItem(
              ONBOARDING_CACHE_KEY,
              JSON.stringify({ provider: forProvider, steps } satisfies OnboardingCache),
            );
          } catch {
            // Storage can be unavailable (private mode); the session works
            // without the cache — it only costs the reload a wizard beat.
          }
          setOnboarding(steps);
          setOnboardingProvider(forProvider);
          return steps;
        }),
      onboardingFix: (kind: OnboardingFixKind, provider?: string) =>
        call(
          { type: "onboarding.fix", kind, ...(provider ? { provider } : {}) },
          // install-pnpm runs corepack to completion; the others only
          // launch an installer or start a login the daemon drives.
          600_000,
        ),
      agentLoginCode: (code: string) =>
        call<{ ok: true }>({ type: "agent.login.code", code }, 30_000),
    }),
    [call, keepProjects, keepRepo],
  );

  // 로그인의 끝(P1-1): 성공이면 게이트가 다시 채색해야 한다 — 마법사의 다시
  // 확인을 기다리지 않고 스스로 다시 묻는다. 실패는 loginDone.detail 로 마법사
  // 카드가 말한다.
  useEffect(() => {
    if (loginDone?.ok) void api.onboardingCheck(onboardingProvider ?? undefined);
  }, [loginDone, api, onboardingProvider]);

  // 설치의 끝(1단계): 성공이면 게이트가 다시 채색해야 한다 — 로그인 끝과
  // 같은 길이다. status 도 다시 읽는다(3단계): 프로바이더 목록의 available
  // 이 바뀌어야 마법사의 Codex 선택 행과 설정의 미설치 목록이 스스로 물러
  // 간다. 실패는 installDone.detail 로 마법사 카드가 말한다.
  useEffect(() => {
    if (installDone?.ok) {
      void api.onboardingCheck(onboardingProvider ?? undefined);
      void api.refreshStatus();
    }
  }, [installDone, api, onboardingProvider]);

  // A background thread that finished its turn — or stopped to
  // ask — calls. Derived from the session map, so a reconnect that replays
  // the same states fires nothing: the transition is the event.
  useEffect(() => {
    const next: Record<string, SessionState> = {};
    for (const [sessionId, view] of Object.entries(sessions)) {
      next[sessionId] = view.state;
      // 시계: running 진입에 놓고, 세션이 running 을 벗어나면 회수한다.
      // 새로고침 뒤에는 데몬이 기억한 시작 시각으로 심는다 — Date.now 로
      // 심으면 10분짜리 턴이 1분 미만으로 읽혀 알림이 씹힌다.
      if (view.state === "running" && prevStates.current[sessionId] !== "running") {
        runningSince.current[sessionId] = view.turnStartedAt ?? Date.now();
      }
      if (prevStates.current[sessionId] === "running" && view.state !== "running") {
        const startedAt = runningSince.current[sessionId];
        delete runningSince.current[sessionId];
        if (sessionId !== watched.current && blockingAsk(view.state, sessionId, pending)) {
          void notifyBackgroundThread(
            (id) =>
              call<SessionSummary[]>({ type: "session.list" }).then(
                (list) => list.find((session) => session.sessionId === id)?.title ?? null,
              ),
            sessionId,
            view.state,
            startedAt === undefined ? undefined : Date.now() - startedAt,
          );
        }
      }
    }
    prevStates.current = next;
  }, [sessions, pending, call]);

  const resolvePending = useCallback((requestId: string) => {
    setPending((prev) => prev.filter((p) => p.requestId !== requestId));
  }, []);

  const ensureSession = useCallback((sessionId: string) => {
    setSessions((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: EMPTY_SESSION }));
  }, []);

  /**
   * Replace a session's transcript with a stored one, without resuming it.
   * The replay's tail is authoritative: the daemon always appends the live
   * room (empty included), so a window opened mid-wait sees the list too.
   */
  const hydrate = useCallback((sessionId: string, events: ChatEvent[]) => {
    setSessions((prev) => {
      const view = prev[sessionId] ?? EMPTY_SESSION;
      // The replay's tail is AUTHORITATIVE: the daemon
      // always appends the live room, empty included, so rows a stale window
      // kept die here instead of becoming ghosts.
      let queue: QueuedSend[] = [];
      let dropped: LostSend[] = [];
      for (const event of events) {
        if (event.kind === "queued") queue = event.items;
        else if (event.kind === "queue.lost") dropped = event.items;
      }
      return {
        ...prev,
        [sessionId]: {
          ...view,
          blocks: events.reduce<Block[]>(foldEvent, []),
          queue,
          dropped,
        },
      };
    });
  }, []);
  const markLive = useCallback((sessionId: string) => {
    watched.current = sessionId;
    setSessions((prev) => ({
      ...prev,
      [sessionId]: { ...(prev[sessionId] ?? EMPTY_SESSION), live: true },
    }));
  }, []);

  /**
   * Let go of one lost send. The DAEMON owns the lost room now — the store
   * deletes it and the re-announcement updates every open window, this one
   * included.
   */
  const dismissDropped = useCallback(
    (sessionId: string, itemId: string) => {
      void api.queueDismissDropped(sessionId, itemId).catch(() => undefined);
    },
    [api],
  );

  return {
    connection,
    connectionError,
    reconnect,
    status,
    projects,
    activeSlug,
    hiddenThreads,
    hideThread,
    unhideThread,
    hideAllThreads,
    unhideAllThreads,
    sessions,
    pending,
    login,
    loginDone,
    install,
    installDone,
    api,
    resolvePending,
    ensureSession,
    hydrate,
    markLive,
    dismissDropped,
    repo,
    diffStatus,
    browserDriving: driving,
    onboarding,
    onboardingProvider,
  };
}

export type { SessionView };
export { EMPTY_SESSION };
