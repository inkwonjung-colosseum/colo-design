import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
  AskQuestion,
  ChatEvent,
  ContextUsage,
  EffortLevel,
  LostSend,
  PermissionMode,
  PermissionSuggestion,
  PlanUsage,
  QueuedSend,
  QueuedSendPayload,
  SessionCommand,
  SessionSelectors,
  SessionState,
} from "@colo-design/protocol";
import { readTurn } from "@colo-design/protocol";
import type { AgentSession, DriverHooks, PermissionVerdict, ToolClass } from "./agent/driver.js";
import { containsPath, realpathBestEffort } from "./paths.js";
import { permissionLog } from "./permission-log.js";
import type { QueueDisk } from "./queue-store.js";

/**
 * A send refusal the planner can read. The daemon's own guards answer in
 * Korean and pass through untouched; anything else is foreign — the SDK, Node
 * — and reaches the chat as raw English unless it is wrapped here (the same
 * family as the C1·C3 fixes: "Query closed before response received" once
 * rode the wire verbatim). The raw line stays in the daemon log; the
 * planner's sentence carries the recovery instead.
 */
export function asPlannerFacingError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (/[\p{Script=Hangul}]/u.test(detail))
    return error instanceof Error ? error : new Error(detail);
  console.error(`[session] 전송이 거절됐습니다: ${detail}`);
  return new Error(
    "에이전트와의 대화가 방금 끊겼습니다 — 입력창의 말을 잠시 뒤 다시 보내면 이어집니다.",
  );
}

interface PendingRequest {
  requestId: string;
  kind: "permission" | "question" | "plan";
  toolName: string;
  resolve: (result: PermissionVerdict) => void;
  suggestions: unknown[];
  /** Kept so an approval can echo the tool input back without the client resending it. */
  input: Record<string, unknown>;
  /** 요청이 만들어진 시각 (epoch ms) — 홈 카드의 "N분 전"이 읽는다. */
  requestedAt: number;
  /**
   * 이 요청에 답이 없으면 일이 못 가는가 — settle 이 resolve 를 풀기 전엔
   * 턴이 못 가므로, 이 자리에서의 판정은 "도구 호출이 응답을 기다린다"와
   * 같은 말이다. 알림 위계의 세 번째 단계(네이티브 알림)는 이 판정을
   * 데이터로 읽는다(P3-3): 조용한 요청이 생기면 이 한 곳만 바꾸면 된다.
   */
  blocking: boolean;
}

/** 핀 하나 — 세션은 봉투만 알고 화면 게이트는 서버가 옮긴다. */
export interface SessionPin {
  screen: string;
  state: string | null;
}

/**
 * A send waiting for the next turn (PLAN D86), exactly as `send` received it —
 * pins 포함. 핀은 받은 시점이 아니라 `deliver` 되는 시점에 게이트 입력이
 * 된다: 대기 핀을 턴 시작 때 미리 지우면, 그 핀을 실어 보낼 턴의 게이트
 * 입력이 사라진다(실사 결함 — 대기 줄의 핀이 영구 미검증).
 */
interface HeldSend {
  id: string;
  text: string;
  images: Array<{ mediaType: string; data: string }>;
  pins: SessionPin[];
}

/** The wire shape of a waiting send: words and counts, never the bytes. */
function summarize({ id, text, images }: HeldSend): QueuedSend {
  return { id, text, images: images.length };
}

/** The same wire shape, stamped — the no-store fallback for the lost room. */
function toLost(send: HeldSend): LostSend {
  return { ...summarize(send), lostAt: Date.now() };
}

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
  /**
   * 말이 실제로 CLI 로 나가는 시점(deliver)의 핀 목록 — 서버가 화면 게이트의
   * 입력으로 옮겨 적는다. 받은 시점이 아닌 나가는 시점인 이유는 HeldSend 의
   * 주석: 대기 중인 말의 핀은 그 말을 실은 턴의 것이어야 한다.
   */
  onPinned?: (sessionId: string, pins: SessionPin[]) => void;
  onPermissionRequest: (payload: {
    requestId: string;
    sessionId: string;
    toolName: string;
    input: unknown;
    suggestions: PermissionSuggestion[];
    blocking: boolean;
    requestedAt: number;
  }) => void;
  onQuestionRequest: (payload: {
    requestId: string;
    sessionId: string;
    questions: AskQuestion[];
    blocking: boolean;
    requestedAt: number;
  }) => void;
}

/**
 * What a session may do to a file its edit tools name, decided by whoever
 * created it:
 *
 * - `allow` — write it without asking (the repo's own working set).
 * - `ask`   — surface a permission card, as any non-edit tool would.
 * - `deny`  — refuse outright, with a Korean reason the agent can read. Used for
 *   files the tool owns and a session must never rewrite.
 */
type WriteDecision = "allow" | "ask" | "deny";
export type WritePolicy = (absolutePath: string) => WriteDecision;

/**
 * The launch half of SessionOptions — everything the provider's driver needs
 * to start its transport. The core reads none of it except through the
 * driver; provider-specific fields (Claude: resume/forkSession/…) ride the
 * same bag.
 */
interface SessionLaunch {
  /** The provider's resolved binary — the driver's availability probe found it. */
  executable?: string;
  /** Resume an existing transcript (the provider's stored session id). */
  resume?: string;
  /** D95: with `resume` — this session is a fork carrying a new id. */
  forkSession?: boolean;
  /** D95: with `resume` — the chain uuid the truncated resume keeps up to. */
  resumeSessionAt?: string;
  /** D95: with `resumeSessionAt` — the discarded turn's prompt uuid. */
  resumeDropsTurn?: string;
  /** Model the query starts on; omitted = the provider's default. */
  model?: string;
  /** Reasoning effort the query starts on; omitted = the provider's default. */
  effort?: EffortLevel;
  /**
   * 프로젝트별 지침(설정 문서 P1#8) — 기본 시스템 프롬프트 끝에 붙는 몇 줄.
   * 사용자가 이 프로젝트에서 지켜 줄 것을 적는 상자다.
   */
  appendSystemPrompt?: string;
}

export interface SessionOptions {
  cwd: string;
  /** The provider id the registry resolves; omitted = "claude". */
  provider?: string;
  /** The provider's display name for user-facing strings; omitted = generic wording. */
  providerLabel?: string;
  /** The provider's plan-mode id (descriptor's capabilities.planMode); null = none. */
  planModeId?: string | null;
  /** The mode a fresh session starts on — the plan-approval restore target. */
  defaultModeId?: string;
  /**
   * A custom session id — with `launch.resume` + `launch.forkSession` it
   * names the FORK (PLAN D95); without a resume it is what a new session is
   * born as.
   */
  sessionId?: string;
  /**
   * Verdict for every edit-class tool call. Defaults to the historical rule:
   * silent inside cwd, a card everywhere else.
   */
  writePolicy?: WritePolicy;
  /**
   * A name for a thread the tool opened on the planner's behalf. The first
   * turn only names an UNNAMED thread, so a handoff — whose first turn is a
   * sentence this tool wrote, not the planner's — would be named by that
   * whole sentence instead of by the file path inside it.
   */
  title?: string;
  /** Everything the driver's transport needs; see SessionLaunch. */
  launch?: SessionLaunch;
  /**
   * 대기 줄의 디스크 절반 (PLAN D86 의 확장). Every held mutation writes
   * through, so even a SIGKILL leaves the room recoverable; a crash converts
   * the room into the lost room on the handle this returns. The session asks
   * with its own id once it knows it. Omitted by tests that drive the room
   * purely in memory.
   */
  queueDiskFor?: (sessionId: string) => QueueDisk;
}

/**
 * git 의 명사는 도구가 합니다 (README · PLAN D5): 커밋과 푸시는 저장·넘기기
 * 버튼의 몫이라, 세션이 직접 만들면 개발자에게 가는 풀 리퀘스트가 도구가
 * 검토하지 못한 역사를 실어 나른다(실측: 핸드오프 브랜치에 무의미한 커밋).
 * 같은 이유로 워크트리·인덱스·레퍼런스를 바꾸는 동사들도 막는다 — reset·
 * checkout·stash 는 커밋 없이도 저장 검토가 읽는 상태를 흔든다. 상태 읽기
 * (status·log·diff·fetch)와 충돌 정리의 add 는 그대로다.
 */
const GIT_WRITE_REFUSAL =
  "커밋과 푸시는 이 도구가 합니다 — 완성된 화면은 저장 버튼으로, 개발자에게는 넘기기 버튼으로 전달해 주세요.";

function writesGitHistory(command: string): boolean {
  if (!/\bgit\b/.test(command)) return false;
  // 상태를 바꾸는 동사는 전부 막는다 — 커밋·푸시만이 아니라 reset·checkout·
  // merge 도 저장 검토가 읽는 상태를 흔든다.
  if (
    /\b(commit|push|reset|rebase|update-ref|clean|checkout|restore|switch|am|cherry-pick|revert|merge|pull|apply|rm|mv|init)\b/.test(
      command,
    )
  ) {
    return true;
  }
  // config 도 읽기 형태가 있다 — --get·--list 같은 조회는 열어 두고(hooks
  // 경로를 읽는 일은 무해하다), 그 밖은 전부 쓰기로 본다: 값을 심는 기본형
  // 부터 --unset·--edit 까지. 깃발 앞에 \b 를 못 붙인다 — `-` 는 비단어라
  // 경계가 서지 않는다.
  if (/\bconfig\b/.test(command)) {
    return !/\bconfig\b[\s\S]*?(?:--get(?:-all|-regexp|-urlmatch|-color|-colorbool)?|--list|-l)\b/.test(
      command,
    );
  }
  // stash·tag·branch 는 읽기 형태가 있다 — list·show·나열은 열어 두고,
  // 쓰기 형태(pop·drop·생성·삭제)만 막는다.
  return (
    /\bstash\b(?!\s+(?:list|show)\b)/.test(command) ||
    /\btag\b(?!\s*(?:$|\s+-[ln]\b|--list\b))/.test(command) ||
    /\bbranch\b(?!\s*(?:$|\s+-[alrv]+\b|--list\b|--show-current\b))/.test(command)
  );
}

/**
 * The name a session carries until its first turn supplies one. Also the
 * sentinel for "nobody has named this yet" — a resumed thread inherits its
 * stored title only while the placeholder is still in place.
 */
export const NEW_SESSION_TITLE = "새 화면";

/**
 * The core session: provider-agnostic. It owns the state machine, the held
 * queue (D86), permission memory and policy, the pending card requests, and
 * the title/cost bookkeeping. The transport — the live query to the agent —
 * is an `AgentSession` attached by the manager after the driver creates it;
 * events flow back through `driverHooks`.
 */
export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly provider: string;
  state: SessionState = "idle";
  /**
   * The provider's own mode id — Claude's four values for Claude sessions,
   * the driver's own ids (ACP `build`/`plan`/…) for everyone else.
   */
  permissionMode: string = "default";
  /** The provider's display name for crash/error strings — dispatch's
   *  resurrect path reads it off a dead session. */
  readonly providerLabel: string;
  /** The provider's plan-mode id; null = the provider has no plan mode. */
  private readonly planModeId: string | null;
  /** The mode a fresh session starts on — the plan-approval restore target. */
  private readonly defaultModeId: string;
  /**
   * 계획 모드로 들어가기 전의 작업 모드. 계획은 한 턴의 자세라 승인 순간
   * 여기로 되돌아간다(`respondPermission`) — 승인된 계획 뒤의 편집이 계획
   * 모드의 제약 아래 갇히지 않게. `setPermissionMode` 가 기록하고 지운다.
   */
  modeBeforePlan: string | null = null;
  /**
   * 빠르게(fast mode)가 이 세션에서 켜져 있는지. 우리가 보낸 부탁이 아니라
   * CLI 가 매 메시지에 실어 보내는 `fast_mode_state` 가 주인이다 — 요금제나
   * 모델이나 쿨다운 때문에 거절된 부탁까지 켜짐으로 읽으면 토글이 거짓말을
   * 한다. 부탁은 낙관적으로 적고, 첫 메시지가 정정한다.
   */
  fastMode = false;
  /** 왜 지금 빠르게를 쓸 수 없는지(CLI 의 사유 문자열). null 이면 막힘 없음. */
  fastModeBlocked: string | null = null;
  model: string | null = null;
  /** Composer chip selections; `null` = the provider's own default. */
  private selectedModel: string | null = null;
  private selectedEffort: EffortLevel | null = null;
  lastActivity = Date.now();
  /** Replaced by the first turn's own words; also the "untouched" sentinel. */
  title: string;

  private readonly writePolicy: WritePolicy;

  private readonly alwaysAllowed = new PermissionMemory();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: SessionEvents;
  private agent: AgentSession | null = null;
  private closed = false;
  /**
   * 결함① (PLAN 0단계): set by `interrupt()` so the abort the transport
   * throws in the consume loop reads as the planner's own 중지 — a turn end,
   * not a crash. Cleared on the next `send()`, so a later real error still
   * surfaces.
   */
  private interrupting = false;
  /**
   * 중지가 유예 안에 답을 받지 못해 질의를 강제로 끊었다 — 그 CLI 는 죽었고,
   * 이 세션은 더는 보낸 말을 삼키지 않는다. transport end 가 대화를 닫는
   * 표식으로 읽는다.
   */
  private aborted = false;
  /**
   * 질의가 저 혼자 죽었다 — 중지도 종료도 아닌 예외(CLI 크래시). aborted 와
   * 같은 규칙이 이 사유에도 걸린다: 죽은 질의의 큐를 소비할 이는 없으니
   * 직접 send 하면 조용히 삼켜지는 대신 거절로 돌아간다. 서버는 이 사유를
   * 알아차려 같은 id 의 재개로 대신 전달한다(resurrectSession) — 크래시 카드의
   * "다시 보내면 이어집니다" 약속을 데몬이 이행하는 길이다.
   */
  private crashed = false;
  /**
   * The room's mirror on disk (PLAN D86 의 확장). Null only in tests that
   * construct a session bare — everything else writes through.
   */
  private readonly disk: QueueDisk | null;
  private readonly held: HeldSend[] = [];
  /**
   * 지금 보내기: how many of `held` the next release may deliver. `null`
   * empties the room (the turn's end); `1` delivers the front send alone
   * and the rest keep waiting for the turn it starts.
   */
  private releaseLimit: number | null = null;
  /**
   * 이 턴이 시작한 시각 (epoch ms), 도는 턴이 없으면 null — 두 가지를 한
   * 필드로 말한다: 턴이 돌고 있는가(`!== null`), 그리고 언제부터인가.
   *
   * 돈다는 것은 CLI 가 일하는 중이거나 카드 앞에 멈춰 있다는 뜻이다. 상태가
   * 아니라 이 시계가 기준인 이유: waiting_permission 도 도는 턴이고, 그 사이에
   * 쓴 말도 똑같이 다음 턴으로 접혀 들어간다. 같은 이유로 시계는 카드를
   * 기다리는 동안에도 계속 센다 — 사람이 기다린 시간도 그 요청의 시간이다.
   * 대기 줄이 연 다음 턴은 새 시계를 받는다.
   *
   * 알림의 `걸렸습니다` 시계(server.ts)와는 다른 질문에 답한다 — 그쪽은 대기
   * 뒤 재개마다 다시 놓아 "그때의 일"만 재고, 이쪽은 요청 하나가 시작한 시각을
   * 끝까지 들고 있는다.
   */
  turnStartedAt: number | null = null;
  /**
   * 세션 비용: what this run has spent, as the provider reports it — its
   * `total_cost_usd` is already the running total for the query, so the
   * latest result replaces the previous one rather than adding to it.
   *
   * Kept as a maximum because a crashed or startup-error result may carry
   * zeroed values: a real total must not be erased by one of those. Null
   * until a turn settles — an unanswered thread has no price to report.
   */
  private costUsd: number | null = null;

  /**
   * The hooks the driver calls back into. Exposed so the manager can hand
   * them to `driver.createSession` before this session's agent is attached —
   * events arriving during the handshake are safe: they only touch events
   * and state, never `this.agent`.
   */
  readonly driverHooks: DriverHooks = {
    onEvent: (event) => this.handleDriverEvent(event),
    onTransportEnd: (shutdownReason) => this.handleTransportEnd(shutdownReason),
    onTransportError: (detail) => this.handleTransportError(detail),
    decidePermission: (tool, input, opts) => this.decidePermission(tool, input, opts),
    onFastMode: (on, blocked) => {
      this.fastMode = on;
      this.fastModeBlocked = blocked;
    },
  };

  constructor(options: SessionOptions, events: SessionEvents) {
    this.events = events;
    this.provider = options.provider ?? "claude";
    this.title = options.title?.trim().slice(0, 80) || NEW_SESSION_TITLE;
    // /tmp vs /private/tmp: the resolved spelling, so workspace containment
    // and the provider's own cwd agree with what the filesystem calls the
    // folder. The CLI reports tool paths already resolved, so an unresolved
    // cwd makes it read its own workspace as foreign and card every Read in it.
    this.cwd = realpathBestEffort(options.cwd);
    // Containment is the floor, not the whole rule: a policy may refuse files
    // inside the cwd itself.
    this.writePolicy =
      options.writePolicy ?? ((path) => (containsPath(this.cwd, path) ? "allow" : "ask"));
    this.selectedModel = options.launch?.model ?? null;
    this.selectedEffort = options.launch?.effort ?? null;

    this.providerLabel = options.providerLabel ?? "에이전트";
    this.planModeId = options.planModeId ?? null;
    this.defaultModeId = options.defaultModeId ?? "default";
    // `sessionId` lets us name the session up front. Without it the id only
    // arrives with the init event, which the CLI does not emit until the first
    // user turn is pushed.
    this.id = options.sessionId ?? options.launch?.resume ?? randomUUID();
    this.disk = options.queueDiskFor?.(this.id) ?? null;
  }

  /** The manager attaches the driver's transport once `createSession` returns. */
  attach(agent: AgentSession): void {
    this.agent = agent;
  }

  // -------------------------------------------------------------------------
  // Driver → core: events and transport lifecycle
  // -------------------------------------------------------------------------

  private handleDriverEvent(event: ChatEvent): void {
    this.lastActivity = Date.now();
    if (event.kind === "init") {
      this.model = event.model;
      this.permissionMode = event.permissionMode;
    }
    if (event.kind === "tool.start") {
      // 도는 도구의 경과 시계는 여기서 뜬다 — 재생된 기록은 이 길을 지나지
      // 않으니(드라이버 store 가 대화록 시각을 직접 싣는다) 덮어쓸 일이 없다.
      event = { ...event, startedAt: event.startedAt ?? Date.now() };
    }
    if (event.kind === "turn.end" && event.costUsd != null) {
      this.costUsd = Math.max(this.costUsd ?? 0, event.costUsd);
    }
    if (event.kind === "turn.end") {
      // 결함① 의 두 번째 길: interrupt() 를 부른 뒤 transport 가 abort 예외를
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
        this.endTurn();
        return;
      }
      if (event.isError) this.interrupting = false;
      // 턴 끝을 먼저 알리고, 그 다음에 대기 줄을 푼다 — 다음 턴은 앞
      // 턴이 닫힌 뒤에 열려야 기록도 램프도 순서대로 읽힌다.
      this.events.onEvent(this.id, event);
      this.endTurn();
      return;
    }
    this.events.onEvent(this.id, event);
  }

  /**
   * The transport's stream ended on its own. A query that ends while a turn
   * is in flight is a crash wearing exit code 0: the planner's words got no
   * result and no card would explain the running lamp dying into an empty
   * answer. Say the same thing the exception path says; only a turn that was
   * never running ends quietly.
   */
  private handleTransportEnd(shutdownReason: string | null): void {
    if (this.state === "running") {
      this.crashed = true;
      // 예고를 들었으면 "예상 밖"이 아니다 (worker_shutting_down): 같은 복구
      // 를 말하되 놀라게 하지 않는다.
      const announced = shutdownReason !== null;
      const label = this.providerLabel;
      const text = announced
        ? `${label} 프로그램이 종료됐습니다 — 대화를 다시 보내면 새 프로그램이 이어받습니다.`
        : `${label}가 예상 밖으로 멈췄습니다 — 대화를 다시 보내면 이어집니다.\n\n${label} 프로그램이 응답 없이 종료됐습니다.`;
      this.events.onEvent(this.id, { kind: "notice", level: "error", text });
      this.setState(
        "error",
        announced
          ? `${label} 프로그램이 종료됐습니다 (${shutdownReason})`
          : `${label} 프로그램이 응답 없이 종료됐습니다.`,
      );
    } else {
      this.setState("closed");
    }
    this.settleTransport();
  }

  private handleTransportError(detail: string): void {
    // The deliberate shutdown in close() aborts the in-flight query; that
    // abort must not read as a crash — no error card, no error state.
    // Same for the planner's own 중지 (결함①): the transport surfaces it as
    // an abort exception, and the card vocabulary already has the word.
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
    } else if (!this.closed && this.state !== "closed") {
      this.crashed = true;
      this.events.onEvent(this.id, {
        kind: "notice",
        level: "error",
        // The transport detail is an English message string, not an error id —
        // the retry dictionary can't match it (리뷰 C3). A Korean lead rides
        // in front, the raw line stays below for 자세히.
        text: `${this.providerLabel}가 예상 밖으로 멈췄습니다 — 대화를 다시 보내면 이어집니다.\n\n${detail}`,
      });
      this.setState("error", detail);
    }
    this.settleTransport();
  }

  /**
   * Whatever way the transport died, its pending prompts can never be
   * answered and its held sends never reached the transcript — the first go
   * back as denies, the second to the lost room.
   */
  private settleTransport(): void {
    for (const request of this.pending.values()) {
      request.resolve({
        behavior: "deny",
        message: "Session ended before approval",
      });
    }
    this.pending.clear();
    this.turnStartedAt = null;
    this.dropHeld();
  }

  private setState(state: SessionState, detail?: string): void {
    // A closing session is quiet: the planner closed it themselves, so
    // neither the aborted turn's end nor the shutdown's aftermath is news.
    // `closed` itself still goes out — it is what takes the thread down.
    if (this.closed && state !== "closed") return;
    if (this.state === state) return;
    this.state = state;
    // 내려앉은 상태에는 도는 턴이 없다 — 크래시로 끝난 턴이 화면에 멈추지 않는
    // 시계를 남기지 않게, 시계는 상태와 같은 자리에서 꺼진다.
    if (state === "idle" || state === "error" || state === "closed") this.turnStartedAt = null;
    this.events.onState(this.id, state, detail);
  }

  /**
   * 턴이 끝났다 — 상태를 내리고 대기 줄을 다음 턴으로 보낸다. 중지로 끝난
   * 턴도 턴 끝이다: "다음 턴에 보냅니다" 라고 약속받고 써 둔 말은 멈춤 뒤에도
   * 그 다음 턴으로 간다 (끊고 보내기가 기대하는 순서이기도 하다 — 끊은 다음,
   * 그 말로 새 턴).
   */
  private endTurn(): void {
    this.turnStartedAt = null;
    this.setState(this.pending.size > 0 ? this.state : "idle");
    this.release();
  }

  /**
   * 대기 줄을 CLI 로 — 턴 끝에서만 부른다. 여러 건이면 CLI 가 한 턴으로 묶을
   * 수 있지만(SDK 의 prompt batch), 어느 쪽이든 도는 턴에 끼어들지는 않는다.
   * 지금 보내기가 한도를 걸어 두었으면 앞의 그만큼만 나가고 나머지는 이 턴의
   * 끝을 다시 기다린다.
   */
  private release(): void {
    // 내려가는 대화에는 보내지 않는다: 닫는 중에 온 턴 끝(중지의 응답)이
    // 대기 줄을 죽어 가는 질의로 밀면, 그 말들은 CLI 에 닿지도 못한 채 방에서
    // 사라진다. 닫힘이 이긴 방은 디스크에 그대로 남아 재시작 뒤 회복된다.
    if (this.closed) return;
    // The hurry is spent at this turn's end whether or not anything is left
    // to hurry — a limit outliving an emptied room would starve a later one.
    const limit = this.releaseLimit ?? this.held.length;
    this.releaseLimit = null;
    if (this.held.length === 0) return;
    const batch = this.held.splice(0, limit);
    this.disk?.saveHeld(this.held);
    // 대기 줄이 여는 턴은 새 요청이다 — 새 시계를 받는다.
    this.turnStartedAt = Date.now();
    // send 와 같은 이유 — 핀이 onPinned 로 적힌 뒤 지워지지 않게 상태를 먼저 본다.
    this.setState("running");
    for (const item of batch) this.deliver(item);
    this.announceHeld();
  }

  /**
   * 죽은 질의는 대기 줄을 소비하지 못한다. 그 말들은 기록에 들어간 적이 없으니
   * lost room 으로 옮겨진다 — 화면의 회복 패널이 이 목록을 그리고, 되살리기는
   * 계획자의 손으로 입력창을 거친다(자동 재전송은 없다).
   */
  private dropHeld(): void {
    if (this.held.length === 0) return;
    const lost = this.held.splice(0);
    this.releaseLimit = null;
    if (this.closed) return;
    // 두 패널에 같은 말이 서지 않게: 방을 잃었다는 말은 대기 줄이 비었다는
    // 말이기도 하다. 비움을 먼저 알리고, 그 다음 어디로 갔는지 말한다.
    this.announceHeld();
    const items = this.disk?.moveToLost(lost) ?? lost.map(toLost);
    this.announceLost(items);
  }

  /** lost room 을 화면으로 — 회복 패널이 이 목록을 그린다(상태 교체). */
  private announceLost(items: LostSend[]): void {
    this.events.onEvent(this.id, { kind: "queue.lost", items });
  }

  /** 대기 줄을 화면으로 — 입력창 위 목록이 이것을 그린다. */
  private announceHeld(): void {
    this.events.onEvent(this.id, { kind: "queued", items: this.heldItems() });
  }
  /** The wait room as the composer shows it, oldest first. */
  heldItems(): QueuedSend[] {
    return this.held.map(summarize);
  }

  /**
   * 고쳐서 보내기: take one waiting send back out, whole. `null` when it is
   * no longer waiting — the turn ended and it went out, or it was already
   * taken; either way there is nothing to restore.
   */
  removeHeld(itemId: string): QueuedSendPayload {
    const item = this.held.find((held) => held.id === itemId);
    if (!item) return null;
    // Taking back the hurried send (the front) ends the hurry: the cut turn's
    // end drains the room as any turn's end does.
    if (this.held[0] === item) this.releaseLimit = null;
    this.held.splice(this.held.indexOf(item), 1);
    this.disk?.saveHeld(this.held);
    this.announceHeld();
    // pins 는 프로토콜 타입에 아직 자리가 없다(회귀 보고에 기록) — 되살린 말이
    // 다시 나갈 때 게이트 입력을 잃지 않게 바이트로만 동행한다.
    return {
      text: item.text,
      images: item.images,
      ...(item.pins.length > 0 ? { pins: item.pins } : {}),
    };
  }

  /**
   * 지금 보내기: cut the running turn and deliver this send first. The turn's
   * end (the interrupt's `turn.end`, or `endTurn` when the CLI refuses the
   * interrupt) releases exactly one send — this one, moved to the front —
   * and the rest keep waiting for the turn it starts. A send that already
   * left the room is a no-op: there is nothing to hurry.
   */
  async sendHeldNow(itemId: string): Promise<void> {
    // Already hurrying exactly this send — the click landed twice inside the
    // interrupt's grace. A second cut here would slice the turn the FIRST
    // click just started.
    if (this.releaseLimit === 1 && this.held[0]?.id === itemId) return;
    const item = this.held.find((held) => held.id === itemId);
    if (!item) return;
    this.held.splice(this.held.indexOf(item), 1);
    this.held.unshift(item);
    this.releaseLimit = 1;
    this.disk?.saveHeld(this.held);
    this.announceHeld();
    await this.interrupt();
  }

  /**
   * The hub's single permission choke point — the driver's `decidePermission`
   * hook. Edit-class tools are answered by the session's `writePolicy`:
   * silent for the repo's own working set, a card for anything ambiguous, a
   * refusal for the files the tool owns. Everything else goes to the planner
   * as a permission (or question) card.
   */
  private decidePermission(
    tool: ToolClass,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: unknown[] },
  ): Promise<PermissionVerdict> {
    // The git nouns belong to the tool (README): a session committing or
    // pushing its own history puts words on the handoff branch the tool never
    // reviewed. Refused before alwaysAllowed — 항상 허용 cannot buy it back.
    // One door opens: the commit that CONCLUDES a merge this tool itself
    // started(최신화 충돌). The conflict card asks the agent for exactly that
    // commit, and this gate must not refuse the tool's own recovery
    // instruction(브리프 ↔ 게이트 모순). A push stays the tool's verb even
    // mid-merge, and a commit outside an open merge is still refused.
    const command = tool.command ?? String(input.command ?? "");
    if (tool.kind === "exec" && writesGitHistory(command)) {
      const mergeOpen = existsSync(join(this.cwd, ".git", "MERGE_HEAD"));
      const pushes = /\bpush\b/.test(command);
      if (!mergeOpen || pushes) {
        return Promise.resolve({ behavior: "deny", message: GIT_WRITE_REFUSAL });
      }
    }
    if (tool.kind === "edit") {
      const paths = tool.paths ?? [];
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
    if (tool.kind === "plan") {
      return this.handlePermission(tool, input, opts);
    }
    if (this.alwaysAllowed.allows(tool.name, input)) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    return this.handlePermission(tool, input, opts);
  }

  /**
   * The browser gate (인앱 브라우저의 표면 판정): an agent browser op aimed
   * OUTSIDE the repo's own surface — a page the planner merely roamed to —
   * asks before it runs. Every op can carry that page's content out (a
   * scroll answers with the whole tree), so the ask is not per-op; the
   * repo's own dev server needs no ask (the DevTools console is the same
   * tier). The card IS the tool-permission flow, so 항상 허용 memory
   * applies. A turn need not be running: settle 가 running 으로 놓은 상태는
   * 턴이 없으면 여기서 거둔다.
   */
  async decideBrowserOp(
    op: string,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; message: string | null }> {
    const verdict = await this.handlePermission({ kind: "other", name: op }, { op }, { signal });
    if (this.turnStartedAt === null && this.state === "running") this.setState("idle");
    return verdict.behavior === "allow"
      ? { allowed: true, message: null }
      : { allowed: false, message: verdict.message };
  }

  private handlePermission(
    tool: ToolClass,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: unknown[] },
  ): Promise<PermissionVerdict> {
    const requestId = randomUUID();
    const suggestions = opts.suggestions ?? [];
    // 권한 카드만 잰다(커미티 2026-09-14): 질문·계획 카드는 "항상 허용"이
    // 없는 세계라 반복이라는 개념이 없다.
    if (tool.kind !== "question" && tool.kind !== "plan") {
      permissionLog().ask(tool.name, permissionSignature(tool.name, input), this.cwd);
    }
    // 요청의 시계는 이곳에서 시작한다 — 세션 상태와 무관하게 "N분 전"의 기준.
    const requestedAt = Date.now();

    return new Promise<PermissionVerdict>((resolve) => {
      const onAbort = () => settle({ behavior: "deny", message: "Request cancelled" });
      const settle = (outcome: PermissionVerdict) => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        // 정상 정산에도 청취를 거둔다 — 세션 수명의 signal 위에 리스너가 쌓이는 것을 막는다.
        opts.signal.removeEventListener("abort", onAbort);
        if (this.pending.size === 0 && this.state !== "closed" && this.state !== "error") {
          this.setState("running");
        }
        resolve(outcome);
      };

      this.pending.set(requestId, {
        requestId,
        kind: tool.kind === "question" ? "question" : tool.kind === "plan" ? "plan" : "permission",
        toolName: tool.name,
        resolve: settle,
        suggestions,
        input,
        requestedAt,
        // 도구 호출이 이 응답을 기다린다 — settle 이 resolve 를 풀기 전엔
        // 턴이 못 간다. 그래서 여기서 만드는 모든 pending 은 막힌 요청이고,
        // 판정은 상태가 아니라 이 데이터로 옮겨진다(P3-3).
        blocking: true,
      });

      // If the query is torn down while a human is deciding, stop waiting.
      opts.signal.addEventListener("abort", onAbort, { once: true });

      // 요청 먼저, 상태는 나중: "기다림" 상태를 읽는 소비자(웹의 네이티브
      // 알림 판정)는 그 상태의 원인인 요청 데이터를 이미 갖고 있어야 한다.
      // 반대 순서면 상태만 먼저 도착해 blocking 판정을 읽을 카드가 없다.
      if (tool.kind === "question") {
        this.events.onQuestionRequest({
          requestId,
          sessionId: this.id,
          questions: normalizeQuestions(input),
          blocking: true,
          requestedAt,
        });
        this.setState("waiting_question");
      } else {
        this.events.onPermissionRequest({
          requestId,
          sessionId: this.id,
          toolName: tool.name,
          input,
          suggestions: describeSuggestions(suggestions),
          blocking: true,
          requestedAt,
        });
        this.setState("waiting_permission");
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
    // `agent.alive` catches the dying-query window: the stream ended but the
    // end event hasn't landed yet — a send pushed now would be swallowed.
    return !(
      this.crashed ||
      this.aborted ||
      this.state === "error" ||
      this.state === "closed" ||
      this.agent?.alive === false
    );
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
        blocking: boolean;
        requestedAt: number;
      }
    | {
        type: "question.request";
        requestId: string;
        sessionId: string;
        questions: AskQuestion[];
        blocking: boolean;
        requestedAt: number;
      }
  > {
    return [...this.pending.values()].map((entry) =>
      entry.kind === "question"
        ? {
            type: "question.request" as const,
            requestId: entry.requestId,
            sessionId: this.id,
            questions: normalizeQuestions(entry.input),
            // 리플레이는 원 요청과 같은 판정·같은 시계를 싣는다 — 다시 뜬
            // 창의 카드도 "N분 전"을 세고, 알림 위계도 같은 데이터를 읽는다.
            blocking: entry.blocking,
            requestedAt: entry.requestedAt,
          }
        : {
            type: "permission.request" as const,
            requestId: entry.requestId,
            sessionId: this.id,
            toolName: entry.toolName,
            input: entry.input,
            suggestions: describeSuggestions(entry.suggestions),
            blocking: entry.blocking,
            requestedAt: entry.requestedAt,
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
      const restore = this.modeBeforePlan ?? this.defaultModeId;
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
      // 반복 측정(커미티 2026-09-14): 이 답이 다음 대화의 repeat 판정의
      // 씨앗이다 — alwaysAllowed 는 이 세션과 함께 사라지니, 파일이 기억한다.
      permissionLog().alwaysAllowedAnswer(
        request.toolName,
        permissionSignature(request.toolName, input),
        this.cwd,
      );
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
    annotations?: Record<string, { preview?: string; notes?: string }>,
  ): boolean {
    const request = this.pending.get(requestId);
    if (!request) return false;
    // The tool requires the original questions array back alongside the answers.
    const updatedInput: Record<string, unknown> = {
      questions: request.input.questions,
      answers,
    };
    if (response) updatedInput.response = response;
    // 선택 옆의 메모 (PLAN D96): 도구가 스스로 받는 자리가 `annotations` 다 —
    // 질문 글자를 키로, 고른 시안과 계획자가 덧붙인 말을 함께 돌려준다. 빈
    // 껍데기는 보내지 않는다: 모델이 읽을 것이 없는 필드는 소음이다.
    if (annotations && Object.keys(annotations).length > 0) {
      updatedInput.annotations = annotations;
    }
    request.resolve({ behavior: "allow", updatedInput });
    return true;
  }

  send(
    text: string,
    images?: Array<{ mediaType: string; data: string }>,
    pins?: SessionPin[],
  ): void {
    if (this.closed) throw new Error("닫힌 대화입니다 — 목록에서 다시 열면 이어갑니다.");
    if (this.aborted)
      throw new Error("중지 요청에 답하지 않은 CLI를 끊었습니다 — 대화를 다시 열면 이어갑니다");
    if (this.crashed)
      throw new Error(
        `${this.providerLabel}가 예상 밖으로 멈춰 이 대화의 연결이 끊겼습니다 — 대화를 다시 열면 이어갑니다`,
      );
    this.lastActivity = Date.now();
    const item: HeldSend = { id: randomUUID(), text, images: images ?? [], pins: pins ?? [] };
    // 다음 턴에 보내기: 턴이 도는 중에 온 말은 여기서 기다린다(`held`) — 아직
    // 아무 일도 일어나지 않은 채로. CLI 로 곧장 가는 건 도는 턴이 없을 때뿐이다.
    if (this.turnStartedAt !== null) {
      this.held.push(item);
      this.disk?.saveHeld(this.held);
      this.announceHeld();
      return;
    }
    this.turnStartedAt = Date.now();
    // 상태가 먼저: deliver 가 부르는 onPinned 이 서버의 pinnedThisTurn 에 적힌
    // 뒤 running 진입이 그 판을 지우면 화면 게이트는 판정을 못 받는다.
    this.setState("running");
    this.deliver(item);
  }

  /**
   * A send goes out: everything a send MEANS happens here, and only here —
   * the moment the words are handed to the transport. A waiting send has done
   * none of this yet, so taking it back out of the room leaves no trace, and
   * the running turn keeps its own quota and interrupt flag until its end.
   */
  private deliver({ text, images, pins }: HeldSend): void {
    // A fresh turn is a fresh failure domain: an old interrupt's flag must
    // not swallow this turn's real error (결함①).
    this.interrupting = false;
    // 이 턴이 가리킨 화면이 곧 게이트의 입력이다 — 받을 때가 아니라 나갈 때
    // 기록되므로, 대기 줄에 섞였던 핀은 자기 턴의 판정을 받는다.
    if (pins.length > 0) this.events.onPinned?.(this.id, pins);

    /**
     * A thread names itself after its first turn — unless the tool wrote that
     * turn. A marked turn (PLAN D9) is a bundle of pins, a brief, a gate
     * failure: text composed for the agent, in the provider.s vocabulary. The tab strip
     * is the one place a planner navigates by reading, so it keeps its
     * placeholder rather than taking a machine's words. A thread the tool
     * opens on purpose is named at `session.create` instead.
     */
    const machine = readTurn(text).marker !== null;
    const title = text.trim();
    const unnamed = this.title === NEW_SESSION_TITLE;
    if (unnamed && title && !machine) {
      this.title = title.slice(0, 80);
    }

    void this.agent?.send({ text, images }).catch((error: unknown) => {
      // 전송이 살아 있어도 보내기가 거절될 수 있다(codex 의 turn/start 거절,
      // 방금 닫힌 SDK 입력 큐). 삼키면 turnStartedAt 만 남고 turn.end 는
      // 영원히 오지 않는다 — 시계가 도는 죽은 턴. 여기서 스스로 턴을 닫는다:
      // 에러 턴 끝은 handleDriverEvent 의 endTurn 을 타고 대기 줄까지 정산한다.
      const detail = error instanceof Error ? error.message : String(error);
      this.events.onEvent(this.id, {
        kind: "notice",
        level: "error",
        text: `${this.providerLabel}에게 말을 전달하지 못했습니다 — 다시 보내 주세요.${
          detail ? `\n\n${detail.slice(0, 200)}` : ""
        }`,
      });
      this.handleDriverEvent({
        kind: "turn.end",
        subtype: "error",
        isError: true,
        costUsd: null,
        numTurns: null,
        durationMs: this.turnStartedAt !== null ? Date.now() - this.turnStartedAt : null,
        resultText: null,
      });
    });

    // The echo carries the person's own words. D87: the pin crops ride back
    // (capped) so the chat card can draw its thumbnails — live only; a
    // replayed transcript keeps the words.
    const thumbs = images
      .filter((image) => image.mediaType === "image/jpeg")
      .slice(0, 6)
      .map((image) => image.data);
    this.events.onEvent(this.id, {
      kind: "user.echo",
      text,
      images: images.length,
      ...(thumbs.length > 0 ? { thumbs } : {}),
    });
  }

  async interrupt(): Promise<void> {
    // Mark first: the abort the transport throws back reads as THIS planner
    // action, and the catch must turn it into `멈추었습니다` (결함①).
    this.interrupting = true;
    const outcome = (await this.agent?.interrupt()) ?? "dead";
    if (outcome === "dead") {
      // 제어 요청이 답이 아니라 거절(throw)로 돌아왔다 — 쓸 수 없는 질의.
      // 중지는 도는 턴 위에서만 눌리므로 부팅 창의 not ready 일 수 없다 —
      // 질의는 이미 없다(실사 결함: 답한 뒤 스스로 내려간 CLI 를 중지로 끊어도
      // 대기 줄이 그 시체로 흘러 램프가 영원히 켜져 있었다). 죽은 질의는
      // 끊을 스트림도 없으므로 timeout 과 달리 정리를 직접 한다: 멈춤 카드,
      // 대기 줄은 lost room 으로, 대화는 닫는다 — 다음 보내기가 새 CLI 로
      // 이어받는다(resurrectSession).
      this.aborted = true;
      if (!this.closed) {
        const hadTurn = this.turnStartedAt !== null;
        this.interrupting = false;
        this.turnStartedAt = null;
        this.dropHeld();
        if (hadTurn) {
          this.events.onEvent(this.id, {
            kind: "turn.end",
            subtype: "interrupted",
            isError: false,
            costUsd: null,
            numTurns: null,
            durationMs: null,
            resultText: null,
          });
        }
        this.setState("closed");
      }
      return;
    }
    if (outcome === "timeout") {
      // The CLI never answered the control request — 실사 결함: 네트워크 대기에
      // 걸린 턴에서 중지를 두 번 눌러도 아무 일도 일어나지 않았다. 유예가 지났으면
      // 질의를 끊는다(드라이버가 이미 abort 했다). transport end 가 같은 깃발을
      // 읽어 멈춤으로 기록하고, `aborted` 로 대화를 닫는다 — 죽은 CLI 가 이후의
      // 보낸 말을 조용히 삼키지 않게.
      this.aborted = true;
    }
    // 대기 줄이 이미 다음 턴을 열었다면 그 램프를 끄지 않는다 — 멈춘 것은 앞
    // 턴이고, 뒤에 선 말은 지금 돌고 있다.
    if (this.turnStartedAt === null) this.setState("idle");
  }

  async contextUsage(): Promise<ContextUsage | null> {
    const usage = (await this.agent?.contextUsage?.()) ?? null;
    if (!usage) return null;
    return { ...usage, sessionCostUsd: this.costUsd };
  }

  /**
   * The account's plan-limit reading alone — what the usage tracker wants.
   * Rides the driver's own `usage()` where the provider offers one and is
   * null where it does not. Separate from `contextUsage` so a tracker
   * refresh never asks for a token ring it is about to throw away, and so a
   * fresh thread answers for its account before its first ring exists.
   */
  async usage(): Promise<PlanUsage | null> {
    return (await this.agent?.usage?.()) ?? null;
  }

  // -------------------------------------------------------------------------
  // Composer selector chips — mid-session switches (driver control requests)
  // -------------------------------------------------------------------------

  /** Effective from the next response. `null` returns to the provider default. */
  async setModel(model: string | null): Promise<void> {
    if (!this.agent?.setModel) throw new Error("이 에이전트는 모델 선택을 지원하지 않습니다.");
    await this.agent.setModel(model);
    this.selectedModel = model;
  }

  /** Effective from the next response. `null` clears the override. */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    if (!this.agent?.setEffort) throw new Error("이 에이전트는 노력 수준을 지원하지 않습니다.");
    await this.agent.setEffort(effort);
    this.selectedEffort = effort;
  }

  /** Widening past `default` is the planner's own explicit choice here. */
  async setPermissionMode(mode: string): Promise<void> {
    if (!this.agent) throw new Error("대화가 아직 준비되지 않았습니다.");
    await this.agent.setMode(mode);
    // 계획은 자세가 아니라 한 번의 승인이다: 들어갈 때의 작업 모드를 기억해
    // 두었다가 승인 순간 되돌린다(위 respondPermission). 이미 계획인 채의
    // 재진입은 첫 기억을 지키고, 다른 모드로의 나들이는 기억을 지운다.
    if (this.planModeId !== null && mode === this.planModeId) {
      if (this.permissionMode !== this.planModeId) this.modeBeforePlan = this.permissionMode;
    } else {
      this.modeBeforePlan = null;
    }
    this.permissionMode = mode;
  }

  /**
   * 빠르게 (fast mode): 같은 모델을 더 빠른 응답으로 돌린다. 켜 달라는 부탁일
   * 뿐이다 — 받아들여졌는지는 다음 메시지의 `fast_mode_state` 가 말한다.
   */
  async setFastMode(fast: boolean): Promise<void> {
    if (!this.agent?.setFastMode) throw new Error("이 에이전트는 빠르게를 지원하지 않습니다.");
    await this.agent.setFastMode(fast);
    this.fastMode = fast;
    // 켜는 쪽의 사유는 이제 옛말이다. 거절이면 다음 메시지가 다시 적는다.
    if (fast) this.fastModeBlocked = null;
  }

  /**
   * 이 작업만 중지 (PLAN D101): 폭주하는 명령 하나, 서브에이전트 하나를 턴을
   * 끊지 않고 세운다. 중지 버튼(interrupt)은 턴 전체의 것이고, 이것은 그 안의
   * 한 작업의 것 — 두 개가 다른 버튼인 이유다.
   */
  async stopTask(taskId: string): Promise<void> {
    if (!this.agent?.stopTask) throw new Error("이 에이전트는 작업별 중지를 지원하지 않습니다.");
    await this.agent.stopTask(taskId);
  }

  /**
   * 뒤로 보내기 (PLAN D101): 지금 턴을 붙잡고 있는 작업을 백그라운드로 옮긴다.
   * 답이 돌아온 뒤에도 그 작업은 계속 돌고, 끝나면 task.end 로 알려 온다.
   * 옮길 것이 없으면 false — 버튼이 거짓말하지 않게 그대로 올린다.
   */
  async backgroundTask(toolUseId: string): Promise<boolean> {
    if (!this.agent?.backgroundTask) return false;
    return await this.agent.backgroundTask(toolUseId);
  }

  /** Everything the composer's chips display, plus the model picker rows. */
  async selectors(): Promise<SessionSelectors> {
    // 죽은 질의가 칩 새로고침을 채팅의 오류 밴드로 만들지 않는다 — "Query
    // closed" 가 send 에 이어 selectors 에서도 같은 버선을 넘던 집안(리뷰
    // C1·C3). 칩이 보여 주는 줄 대부분은 세션 필드라 질의 없이도 살아
    // 있고, 모형 목록은 빈 채 돌려 화면이 기억한 카탈로그를 유지하게 한다.
    let models: Awaited<ReturnType<NonNullable<AgentSession["models"]>>> = [];
    if (this.sendable && this.agent?.models) {
      try {
        models = (await this.agent.models()) ?? [];
      } catch {
        models = [];
      }
    }
    let modes: Awaited<ReturnType<NonNullable<AgentSession["modes"]>>> = null;
    if (this.sendable && this.agent?.modes) {
      try {
        modes = (await this.agent.modes()) ?? null;
      } catch {
        modes = null;
      }
    }
    return {
      model: this.selectedModel ?? this.model,
      effort: this.selectedEffort,
      permissionMode: this.permissionMode as PermissionMode,
      fastMode: this.fastMode,
      fastModeBlocked: this.fastModeBlocked,
      models,
      provider: this.provider,
      ...(modes ? { modes, mode: this.permissionMode } : {}),
    };
  }

  /** The composer's /command palette: names, descriptions, argument hints. */
  async commands(): Promise<SessionCommand[]> {
    // selectors 와 같은 손: 죽은 질의의 팔레트는 비워 두고, 칩은 밴드 대신
    // 제 자리를 지킨다.
    let commands: SessionCommand[] = [];
    if (this.sendable && this.agent?.commands) {
      try {
        commands = (await this.agent.commands()) ?? [];
      } catch {
        commands = [];
      }
    }
    return commands;
  }

  /**
   * 닫는 이유가 방의 운명을 정한다 (PLAN D86 의 확장). 유저가 스스로 닫은
   * 대화의 대기 줄은 조용히 사라진다 — 닫는 창에 뒷말은 소식이 아니다. 데몬
   * 전체의 종료(shutdown)는 다르다: 방은 디스크에 그대로 남아 재시작 뒤
   * sweepOrphans 가 lost room 으로 회복한다.
   */
  async close(reason: "user" | "shutdown" = "user"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      request.resolve({ behavior: "deny", message: "Session closed by user" });
    }
    this.pending.clear();
    if (reason === "user") {
      this.held.length = 0;
      this.disk?.clear();
    }
    await this.agent?.close().catch(() => undefined);
    this.setState("closed");
  }
}

function describeSuggestions(suggestions: unknown[]): PermissionSuggestion[] {
  return suggestions.map((raw) => {
    const s = raw as Record<string, any>;
    const destination = String(s?.destination ?? "session");
    const persisted = destination === "localSettings" || destination === "projectSettings";
    // 이 문장은 사용자가 읽는 권한 카드에 그대로 붙는다 — 기계 말이 아니라
    // 기획 말로 쓴다 (README: 사용자는 git 명사를 읽지 않는다).
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
