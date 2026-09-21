export { daemonOwnedPorts } from "./preview-claim.js";

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import {
  PROTOCOL_VERSION,
  type ProjectSummary,
  parseClientMessage,
  type ServerMessage,
} from "@colo-design/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { Diagnostic } from "./agent/driver.js";
import { ClaudeDriver } from "./agent/drivers/claude/driver.js";
import { CodexDriver } from "./agent/drivers/codex/driver.js";
import { OmpDriver } from "./agent/drivers/omp/driver.js";
import { DriverRegistry } from "./agent/registry.js";
import { browserMcpEntry } from "./browser-launch.js";
import {
  type CredentialStore,
  createCredentialStore,
  migratePlaintextSecrets,
  migrateProjectPats,
} from "./credentials.js";
import { RequestRouter } from "./dispatch.js";
import { buildStatus, resolveClaudeExecutable } from "./environment.js";
import { Escalation } from "./escalation.js";
import { GitHubBridge } from "./github-bridge.js";
import { HandoffPreviews } from "./handoff-preview.js";
import { createFileLogger, type DaemonLogger } from "./log.js";
import { MachineTurns } from "./machine-provider.js";
import { MachineSetting } from "./machine-setting.js";
import { type DaemonNotice, noticeForState } from "./notices.js";
import { AgentLogin } from "./onboarding.js";
import { realpathBestEffort } from "./paths.js";
import { PlanTracker } from "./plan-tracker.js";
import { daemonOwnedPorts } from "./preview-claim.js";
import type {
  BrowserDriver,
  BrowserDriverFactory,
  PreviewDriverFactory,
} from "./preview-driver.js";
import { PreviewDrivers } from "./preview-drivers.js";
import { ProjectFleet, type ProjectWorkspaces } from "./project-fleet.js";
import { ProjectRegistry } from "./projects.js";
import { QueueStore } from "./queue-store.js";
import { repoSettingsWarning, sanitizeRepoAgentSettings, trustWorkspace } from "./repo.js";
import { MAX_LINES_PER_SCREEN, TROUBLE_LEVELS } from "./screen-gate.js";
import { asPlannerFacingError, NEW_SESSION_TITLE } from "./session.js";
import { SessionManager } from "./session-manager.js";
import { TurnStats } from "./turn-stats.js";
import { serveWeb } from "./web-static.js";

// The host's notice type (notices.ts) — re-exported so
// `@colo-design/daemon/server` stays the one import a host needs.
export type { DaemonNotice } from "./notices.js";
// The desktop builds its drivers against these (게이트 재배선 + 인앱 브라우저
// 2단계) — exported here so `@colo-design/daemon/server` stays the one import
// a host needs.
export type {
  BrowserDriver,
  BrowserDriverFactory,
  PreviewAxNode,
  PreviewCapture,
  PreviewConsoleLine,
  PreviewDriver,
  PreviewDriverFactory,
  PreviewOpenOptions,
  PreviewOpenResult,
  PreviewViewport,
} from "./preview-driver.js";

/**
 * 커미티 B1 (2026-09-15): 열린 넘김 폴링 주기. 슬라이스 4 (2026-09-19) 가
 * 10분 → 2분으로 줄였다: 인증 요청 5000/시 예산에서 프로젝트당 분당 1회
 * 미만이라 "한 사람·한 대·한 구독" 규모에 여유가 있고, 반영 알림이 실제
 * 병합에서 늦게 도착하는 일은 이제 사용자 경험의 문제였다.
 */
const HANDOFF_POLL_MS = 2 * 60_000;
/**
 * /internal/browser가 받는 op의 화이트리스트(3단계 계약의 16개). 와이어에
 * 노출하지 않는 것: destroy(세션 수명에 귀속 — 와이어에서 찌르면 사용자
 * 페이지가 망가진다). `screenCheck` 는 pane 이 아니라 검증 창(forIsolated)
 * 에서 돈다 — 게이트의 판정을 턴 안에서 앞당겨 보는 길이다.
 */
const BROWSER_OPS: Record<string, true> = {
  navigate: true,
  back: true,
  forward: true,
  snapshot: true,
  screenshot: true,
  click: true,
  type: true,
  press: true,
  scroll: true,
  hover: true,
  select: true,
  drag: true,
  consoleLines: true,
  evaluate: true,
  waitFor: true,
  screenCheck: true,
};

/** 요청 본문 한도 — evaluate 식·콘솔 요청 등을 다 담는 충분한 크기. */
const BROWSER_BODY_LIMIT = 1_000_000;

/**
 * op 하나가 데몬을 붙들 수 있는 상한 — evaluate 의 awaitPromise 가 영원히
 * 이행하지 않는 Promise 를 만나도 세션의 브라우저가 죽지 않게 한다. MCP
 * 자식의 60s 유예보다 길게 둔다(자식이 먼저 포기하는 게 정상 경로).
 */
const BROWSER_OP_TIMEOUT_MS = 90_000;

/**
 * 읽기 전용 op — 이것들은 "브라우저 조작 중" 표시를 켜지 않는다(조작이
 * 아니라 관찰이다).
 */
const BROWSER_QUIET_OPS: Record<string, true> = {
  snapshot: true,
  screenshot: true,
  consoleLines: true,
  waitFor: true,
  screenCheck: true,
};

/**
 * 권한 카드 유예 — MCP 자식이 포기하는 60s 유예 직전까지. 답이 없으면
 * 거절로 정산된다(무응답 = 안 함).
 */
const BROWSER_ASK_TIMEOUT_MS = 55_000;

/**
 * 이동(navigate·back·forward)이 레포 바깥에 내려앉았을 때 스냅샷 대신
 * 내리는 안내 — 이동 자체는 카드 없이 허용하지만, 착지한 화면의 내용은
 * 권한 카드를 지나야 읽힌다.
 */
const BROWSER_EXTERNAL_NOTE =
  "레포 바깥 화면에 내려앉았다 — 내용은 권한 없이 읽지 않는다. 필요하면 browser_snapshot 을 다시 부르면 권한 카드가 온다.";

/** 와이어의 JSON 값을 시그니처 형태로 좁힌다 — 엔드포인트는 임의 JSON이 닿는 경계라 믿지 않는다. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * 와이어의 flat 인자(params)를 BrowserDriver의 위치 인자로 풀어 부른다 —
 * MCP 자식은 하나의 params 객체만 알고, 호출 규약은 드라이버 소유다.
 */
async function callBrowserOp(
  driver: BrowserDriver,
  op: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (op) {
    case "navigate":
      return driver.navigate(String(params.url ?? ""));
    case "back":
      return driver.back();
    case "forward":
      return driver.forward();
    case "snapshot":
      return driver.snapshot();
    case "screenshot":
      return driver.screenshot({
        ref: asString(params.ref),
        longEdge: asNumber(params.longEdge),
      });
    case "click":
      return driver.click({ ref: String(params.ref ?? "") });
    case "type":
      return driver.type({
        ref: asString(params.ref),
        text: String(params.text ?? ""),
        clear: params.clear !== false,
      });
    case "press":
      return driver.press(String(params.key ?? ""));
    case "scroll":
      return driver.scroll({ ref: asString(params.ref), dy: asNumber(params.dy) ?? 0 });
    case "hover":
      return driver.hover({ ref: String(params.ref ?? "") });
    case "select":
      return driver.select({ ref: String(params.ref ?? ""), value: String(params.value ?? "") });
    case "drag":
      return driver.drag({
        fromRef: String(params.fromRef ?? ""),
        toRef: String(params.toRef ?? ""),
      });
    case "consoleLines":
      return driver.consoleLines();
    case "evaluate":
      return driver.evaluate(String(params.fn ?? ""));
    case "waitFor":
      return driver.waitFor({
        text: asString(params.text),
        url: asString(params.url),
        ms: asNumber(params.ms),
      });
    default:
      throw new Error(`알 수 없는 브라우저 op: ${op}`);
  }
}

// Session permission policy lives in Session itself: it pins the CLI to
// `default` mode (so a user's own global defaultMode cannot widen hub
// sessions) and answers edit-class tools in-process. See session.ts.

export interface DaemonConfig {
  host: string;
  port: number;
  /** Shared secret a client must present. Generated on first run. */
  token: string;
  claudeExecutable?: string;
  /**
   * 개발용 에이전트(omp)를 프로바이더 목록에 올린다. 실사용자는 Claude Code ·
   * Codex 만 쓴다 — omp 는 이 도구의 개발자만 쓰므로 그 길은 개발 실행에만
   * 열어 둔다: 데스크톱은 `!app.isPackaged`, CLI 는
   * `COLO_DESIGN_DEV_AGENTS=1`. 패키징된 앱은 절대 켜지 않는다.
   */
  devAgents?: boolean;
  /**
   * Where the web UI's built files live. When set, the daemon serves them
   * itself — the desktop app is one process serving one origin, no pairing
   * screen. The browser dev path (separate vite server + pasted ws url)
   * keeps working when this is unset.
   */
  webDist?: string;
  /** Credential store; the desktop app injects its safeStorage-backed one. */
  credentialStore?: CredentialStore;
  /**
   * 사용자가 돌아와야 하는 순간의 갈고리 — 턴이 끝났을 때, AI 가 확인을
   * 기다릴 때, 게이트가 실패했을 때. 데몬은 의미만 건넨다; 그것을 OS 알림으로
   * 그릴지는 받는 쪽(데스크톱 앱)의 몫이므로, 브라우저 개발 경로는 이 갈고리
   * 없이도 온전하다.
   */
  onNotice?: (notice: DaemonNotice) => void;
  /**
   * 데몬의 파일 로그 싱크. 지정하지 않으면 `~/.colo-design/logs` 의 하루
   * 파일 로거를 스스로 만든다 — 데스크톱 앱이 in-process 로 데몬을 키우므로
   * console 은 아무에게도 닿지 않고, 흔적은 파일로만 남는다.
   */
  logger?: DaemonLogger;
  /**
   * The desktop's preview-window driver (게이트 재배선). When a host injects
   * it, the screen gate re-opens the screens a turn pointed at, and the
   * 화면 캡처 button works; without it — the browser dev path — neither
   * exists.
   */
  previewDriverFactory?: PreviewDriverFactory;
  /**
   * The desktop's shared browser (인앱 브라우저): the driver the agent's
   * browser tools will go through — the pane's page, the same one the user
   * watches. The capture path rides the SAME instance so the page keeps a
   * single debugger owner. The browser dev path injects nothing and the
   * tools answer 404.
   */
  browserDriverFactory?: BrowserDriverFactory;
}

/**
 * The provider registry's contents — registration order is the picker order
 * (registry.ts). Claude · Codex always; omp only behind `devAgents`
 * (DaemonConfig 의 주석). 함수로 떼어 둔 이유는 하나다: 어느 실행이 어떤
 * 프로바이더 목록을 받는지를 데몬을 띄우지 않고 잠그기 위해서다.
 */
export function registerAgentDrivers(
  registry: DriverRegistry,
  options: { claudeExecutable: () => string | null; devAgents: boolean },
): void {
  registry.register(new ClaudeDriver(options.claudeExecutable));
  registry.register(new CodexDriver());
  if (!options.devAgents) return;
  registry.register(new OmpDriver());
}

export class DaemonServer {
  private readonly clients = new Set<WebSocket>();
  private readonly manager: SessionManager;
  private readonly logger: DaemonLogger;
  private readonly credentials: CredentialStore;
  /**
   * The project registry and one live workspace per project the daemon has
   * touched this run. Only the ACTIVE project runs a preview server — two
   * repos may declare the same `preview.port` — but a project the planner
   * switched away from keeps its clone.
   */
  private registry!: ProjectRegistry;
  /**
   * What "the repo" currently means — one live workspace per project, the
   * switch, the announces, the handoff poll (project-fleet.ts). Built in
   * `start()` once the registry exists.
   */
  private fleet!: ProjectFleet;
  /** The wire's request table (dispatch.ts) — built in `start()` beside the fleet. */
  private router!: RequestRouter;
  /** 커미티 B1 (2026-09-15): 열린 넘김 폴링 타이머 — stop() 이 끊는다. */
  private handoffTimer: NodeJS.Timeout | null = null;
  /**
   * The machine-wide GitHub credential: token lifecycle, picker cache, one
   * transport (github-bridge.ts). The fixture env var is read inside.
   */
  private readonly github: GitHubBridge;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly agentDrivers = new DriverRegistry();
  private claudeExecutable: string | null = null;
  /** 기계 잔일 담당의 설정 — 설정창의 machine.set 이 쓰고 machine.json 에 산다. */
  private readonly machineSetting = new MachineSetting();
  /** 기계 잔일(저장 메모 · 넘기기 초안)의 담당 — 레지스트리와 설정에서 고른다. */
  private readonly machineTurns = new MachineTurns(this.agentDrivers, () =>
    this.machineSetting.get("provider"),
  );
  /** 터미널 없는 에이전트 로그인(P1-1) — 데몬이 파이프로 몰고 방송한다. */
  private readonly agentLogin = new AgentLogin();
  /**
   * P2-1 자동 저장의 대기표. 답을 낸 턴(turn.end)이 표를 올리고, 그 턴이
   * 내려앉은 idle 에서 — 화면 확인 게이트가 걸렸다면 그 판정이 끝난 뒤에 —
   * 한 번만 내려온다. 표를 따로 두는 이유는 하나다: 커밋을 turn.end 에 바로
   * 걸면 게이트가 여는 고침 턴과 경합해 한 턴이 커밋 둘로 갈린다.
   */
  private readonly autoSaveDue = new Set<string>();
  /**
   * 브라우저 MCP 자식의 세션별 시크릿(3단계): Map<secret, {sessionId,
   * issuedAt}>. 데몬의 config.token은 전역 공유라 자식에게 못 준다 — 세션마다
   * 새 시크릿을 발급해 메모리에 매핑하면 자식이 타 세션의 RPC를 칠 수 없고,
   * 세션이 닫히면(onState closed) 시크릿도 함께 간다.
   */
  private readonly browserSecrets = new Map<string, { sessionId: string; issuedAt: number }>();
  /**
   * 세션별 브라우저 op 직렬화 큐 — 같은 세션의 명령이 겹치면 pane 의 ref
   * 세대가 경합한다. 값은 "지금까지의 꼬리"다.
   */
  private readonly browserOps = new Map<string, Promise<unknown>>();
  /**
   * Aborted the moment `stop()` begins. Unattended CLI probes ride it: a CLI
   * that never answers must not hold the process open for the probe's full
   * grace after the daemon is down — the offline suites each paid that grace
   * at exit, and the desktop's quit waited on it too.
   */
  private readonly closing = new AbortController();
  /** The one shutdown, shared by every caller that asks for it. */
  private stopping: Promise<void> | null = null;
  /**
   * The account's plan limits and the CLI's model catalog (plan-tracker.ts) —
   * account-wide, cached on disk across restarts, rebroadcast on change.
   */
  private readonly plans: PlanTracker;
  /**
   * The preview driver each session received and the screen-gate's verdict
   * state (preview-drivers.ts, PLAN D61·D56).
   */
  private readonly drivers: PreviewDrivers;
  /**
   * 시점 빌드 재현: the handed-off moment's worktree
   * build — one at a time, for the active project's open handoff. Its
   * lifetime is this server's to enforce: the conversation that opened it
   * reaps it on close (onState below), the daemon reaps it on stop, and the
   * store's own idle timer catches the window that never said goodbye.
   */
  private readonly handoffPreviews = new HandoffPreviews(
    () => {
      const active = this.activeOrNull();
      if (!active) return null;
      return {
        slug: active.slug,
        repoRoot: active.paths.repoRoot,
        projectRoot: active.paths.root,
        previewCommand: active.repo.repoConfig()?.preview.command ?? null,
        handoff: active.repo.currentHandoff,
      };
    },
    (message) => this.logger.info(message),
  );
  /**
   * 세션별 최근 running 진입 시각 — 완료 알림에 태울 턴의 길이(알림 시점
   * 정책의 "오래 걸린 턴")를 재는 시계. 대기 후 재개는 시계를 다시 놓는다.
   *
   * 화면의 진행 시계(`Session.turnStartedAt`)와 헷갈리지 않게 이름이 다르다:
   * 그쪽은 요청 하나가 시작한 시각을 카드 앞의 기다림까지 포함해 끝까지 든다.
   */
  private readonly notifyClockAt = new Map<string, number>();
  /**
   * 카드 대기의 시계 (턴 통계): waiting_permission·waiting_question 진입에
   * 놓고 벗어날 때 구간을 통계에 더한다 — durationMs 에 섞인 사람 대기를
   * waitMs 로 갈라 내는 재료다.
   */
  private readonly waitClockAt = new Map<string, number>();
  /**
   * 대기 줄의 디스크 절반 (PLAN D86 의 확장): the wait rooms' mirror and the
   * lost room's keeper, keyed by session id under the run dir.
   */
  private readonly queueStore = new QueueStore();
  /** 세션에 하나씩 물려주는 디스크 손잡이 — Session 이 자기 id 로 부른다. */
  private readonly queueDiskFor = (sessionId: string) => this.queueStore.for(sessionId);
  /** 슬라이스 5: 개발자 에스컬레이션 — 환경 실패를 웹훅으로 흘리는 문. */
  private readonly escalation: Escalation;
  /** 턴 통계 (AI 작업 시간 측정) — 종류와 숫자만 남기는 하루 JSONL. */
  private readonly stats: TurnStats;

  constructor(private readonly config: DaemonConfig) {
    this.credentials = config.credentialStore ?? createCredentialStore();
    this.logger = config.logger ?? createFileLogger();
    this.escalation = new Escalation(this.credentials, this.logger);
    this.github = new GitHubBridge({
      credentials: this.credentials,
      claudeExecutableOverride: () => this.config.claudeExecutable,
      // Every live workspace re-arms at once; a project the planner has not
      // touched this run gets the token when it is next activated.
      onToken: (pat) => {
        for (const workspaces of this.fleet.workspaces.values()) workspaces.repo.setPat(pat);
      },
      // 데몬이 본 GitHub 401(또는 그 뒤의 회복) — 판정이 바뀔 때만 status 를
      // 다시 방송한다. 웹의 만료 카드는 이 방송 하나로 열리고 닫힌다.
      onAuthChange: () => {
        // 슬라이스 5: 토큰 만료는 AI 가 못 고친다 — 개발자에게 곧장 알린다.
        if (this.github.authExpired) {
          void this.escalation.notify(
            "[Colo Design] GitHub 토큰이 만료된 것 같습니다 — 기획자 컴퓨터에서 토큰을 다시 넣어야 합니다.",
          );
        }
        void this.status().then((status) => this.broadcast({ type: "status", status }));
      },
    });
    registerAgentDrivers(this.agentDrivers, {
      claudeExecutable: () => this.claudeExecutable,
      devAgents: config.devAgents === true,
    });
    this.manager = new SessionManager(
      {
        onEvent: (sessionId, event) => {
          // 턴 통계 — 아래의 return 들보다 먼저: 모든 사건이 새겨져야 한다.
          this.stats.observe(sessionId, event);
          this.broadcast({ type: "session.event", sessionId, event });
          // 한도가 움직였다 (PLAN D100): 요금 칩이 2분 뒤에야 진실을 말하면,
          // 계획자는 이미 막힌 뒤에 그 사실을 안다. 다음 읽기를 앞당긴다 —
          // 이벤트를 보낸 계정의 provider로.
          if (event.kind === "ratelimit") {
            this.plans.noteRateLimit(this.manager.get(sessionId)?.provider ?? "claude");
            return;
          }
          // 감독(2026-09-19): 턴이 답을 냈다 — 자동 재개의 상한은 돌려놓는다.
          // 다음 고장은 새 사건이고, 다시 두 번의 스스로 재기를 얻는다.
          // 슬라이스 2: 답을 낸 턴이 자동 브리프가 연 턴이면 저장까지 정산한다.
          // 중지는 사람의 뜻 — 반쯤 고쳐진 화면을 저장하지 않는다.
          // P2-1: 답을 낸 턴은 자동 저장의 후보다 — 표만 올리고, 커밋은 아래
          // onState 의 idle 에서 치른다(게이트가 있었다면 그 뒤에).
          if (event.kind === "turn.end" && !event.isError && event.subtype !== "interrupted") {
            this.router?.forgetReviveBudget(sessionId);
            this.autoSaveDue.add(sessionId);
            void this.fleet.settleAutoSave(sessionId);
            return;
          }
        },
        onState: (sessionId, state, detail) => {
          // 파일 로그의 뼈대: 턴이 언제 시작해 언제 어떤 상태로 내려앉았는지.
          this.logger.info("세션 상태", { sessionId, state, ...(detail ? { detail } : {}) });
          // 완료 알림에 태울 턴의 길이: running 진입에 시계를 놓고 idle 에서 회수한다.
          // 대기 뒤 재개는 시계를 다시 놓는다 — 그때의 일이 그때의 완료를 말한다.
          // (화면의 진행 시계는 다른 질문에 답한다 — 아래 `startedAt` 을 보라.)
          let turnDurationMs: number | undefined;
          if (state === "running") {
            // 이 시계는 `running` 의 것이 맞다: 카드를 기다렸다 재개한 일은
            // 그때부터 다시 재는 것이 완료 알림의 "오래 걸린 턴" 정의다
            // (화면의 진행 시계는 Session.turnStartedAt 이 따로 든다).
            this.notifyClockAt.set(sessionId, Date.now());
          } else if (state === "idle") {
            const startedAt = this.notifyClockAt.get(sessionId);
            this.notifyClockAt.delete(sessionId);
            turnDurationMs = startedAt === undefined ? undefined : Date.now() - startedAt;
          } else if (state === "closed") {
            this.notifyClockAt.delete(sessionId);
          }
          // 카드 대기의 시계 (턴 통계): waiting_* 진입에 놓고 벗어날 때 구간을
          // 통계에 더한다. 세션이 닫혀도 else 가 지우므로 시계는 남지 않는다.
          if (state === "waiting_permission" || state === "waiting_question") {
            this.waitClockAt.set(sessionId, Date.now());
          } else {
            const waitSince = this.waitClockAt.get(sessionId);
            if (waitSince !== undefined) {
              this.waitClockAt.delete(sessionId);
              this.stats.noteWait(sessionId, Date.now() - waitSince);
            }
          }
          // 진행 시계 (화면의 `n분 n초`): 시작을 창이 아니라 세션이 들고 있으므로
          // 새로고침해도 두 번째 창에서도 같은 초를 센다. 도는 턴이 없는 세션의
          // 시계는 null 이라 그 상태에는 붙지 않는다.
          const startedAt = this.manager.get(sessionId)?.turnStartedAt ?? null;
          this.broadcast({
            type: "session.state",
            sessionId,
            state,
            ...(detail ? { detail } : {}),
            ...(startedAt === null ? {} : { startedAt }),
          });
          // A turn that just finished is the one moment the clone can have
          // gained files nobody has saved (PLAN D8). Counting here — rather
          // than on a timer — is what lets the top bar say 저장 the instant
          // the agent stops, and say nothing at all while it is still writing.
          // The count belongs to the session's OWN project, not the active
          // one: a turn finishing in B while the planner reads A must move
          // B's number (D14).
          if (state !== "running") {
            void this.workspaceOfSession(sessionId)?.repo.refreshPendingChanges();
          }
          // The tree's child row reads this session's state (PLAN D59): the
          // clone's threads are stale the moment it moves.
          const sessionWorkspaces = this.workspaceOfSession(sessionId);
          if (sessionWorkspaces) {
            this.manager.invalidateThreads(realpathBestEffort(sessionWorkspaces.paths.repoRoot));
            this.refreshThreads();
          }
          // 턴이 화면을 열어 봤다면 완료 알림은 게이트의 판정 뒤로 미룬다
          // (runScreenGate 가 둘 중 하나를 내보낸다). 여기서 먼저 부르면
          // 사용자는 `작업이 끝났습니다` 를 읽은 직후 다시 도는 대화를 본다.
          if (state === "idle" && this.drivers.gatePossible(sessionId)) {
            // 게이트의 한 바퀴를 재서 통계에 남긴다 — 다시 연 여부는
            // gatedSessions(사람의 다음 보내기 전까지 산다)로 판정이 났을 때
            // 읽는다. screens 는 runGate 가 지우기 전의 수다.
            const screens = this.drivers.pinnedThisTurn.get(sessionId)?.size ?? 0;
            const gateStart = Date.now();
            // P2-1: 자동 저장의 커밋은 게이트의 판정이 끝난 **뒤**에 건다.
            // 게이트가 고침 턴을 열면 워크트리가 다시 더러워지므로, 먼저
            // 커밋하면 한 턴이 커밋 둘로 갈린다. 게이트가 깨져도(reject) 커밋은
            // 치른다 — 확인 못 한 것이 저장하지 않을 이유는 아니다.
            void this.drivers.runGate(sessionId, turnDurationMs).then(
              () => {
                this.stats.noteGateCheck(sessionId, {
                  ms: Date.now() - gateStart,
                  screens,
                  reopened: this.drivers.gatedSessions.has(sessionId),
                });
                this.runAutoSave(sessionId);
              },
              () => this.runAutoSave(sessionId),
            );
          } else {
            const notice = noticeForState(
              sessionId,
              state,
              this.manager.get(sessionId)?.title ?? NEW_SESSION_TITLE,
              turnDurationMs,
            );
            if (notice) this.config.onNotice?.(notice);
            // 게이트가 없는 턴의 커밋은 여기서 곧바로 — idle 에만. 다른 상태의
            // idle 아닌 방송(running · waiting_*)은 아직 턴의 끝이 아니다.
            if (state === "idle") this.runAutoSave(sessionId);
          }
          // 게이트의 판정 상태는 세션과 함께 간다 — close, delete, remove,
          // daemon stop all land here as `closed`.
          if (state === "closed") {
            this.router?.forgetReviveBudget(sessionId);
            // P2-1: 주인을 잃은 자동 저장 표는 치르지 않는다 — 닫힌 대화의
            // 커밋 제목을 그 대화의 말에서 끌어올 수 없다.
            this.autoSaveDue.delete(sessionId);
            this.drivers.pinnedThisTurn.delete(sessionId);
            this.drivers.gatedSessions.delete(sessionId);
            // 브라우저 시크릿도 세션과 함께 간다(3단계) — 남은 자식의 비밀로
            // 닫힌 세션의 브라우저를 몰 수 없게.
            for (const [secret, candidate] of this.browserSecrets) {
              if (candidate.sessionId === sessionId) this.browserSecrets.delete(secret);
            }
            this.browserOps.delete(sessionId);
            // 수명 규칙: the worktree build's life is
            // tied to the conversation that opened it — its close reaps the
            // worktree and the port. The store ignores strangers itself.
            this.handoffPreviews.closeSession(sessionId);
          }
        },
        onPermissionRequest: (payload) =>
          this.broadcast({ type: "permission.request", ...payload }),
        onQuestionRequest: (payload) => this.broadcast({ type: "question.request", ...payload }),
        // 새 턴의 화면 목록은 이 턴의 것이다 — 지난 턴이 가리킨 화면을 다시
        // 판정하면 고치지도 않은 화면을 AI 에게 떠넘기게 된다. 이것이 `running`
        // 방송에 걸려 있을 때는, 턴 도중 확인 카드 하나를 답한 것만으로도
        // (settle 이 running 을 재방송한다) 현 턴의 핀이 지워져 화면 게이트가
        // 조용히 생략됐다. 턴의 시작을 아는 것은 deliver 뿐이므로 그것만이 비운다.
        onTurnStart: (sessionId) => {
          this.drivers.pinnedThisTurn.delete(sessionId);
        },
        onPinned: (sessionId, pins) => {
          for (const pin of pins) this.drivers.notePinned(sessionId, pin.screen);
        },
        // 감독(2026-09-19): 턴이 도는 중에 CLI 가 죽었다 — 라우터가 같은 id 의
        // 재개로 스스로 일으킨다. start() 전에는 라우터가 없다(그때 세션도
        // 없다): 없는 문은 조용히 닫혀 있는 것이 옳다.
        onRevive: (sessionId) => {
          void this.router?.revive(sessionId);
        },
      },
      this.agentDrivers,
      // 세션별 브라우저 MCP 명세(3단계): 팩토리가 없으면(브라우저 개발 경로)
      // 시크릿도 발급하지 않는다. URL은 루프백 고정 — 자식은 같은 호스트의
      // 프로세스라 바인딩 호스트가 무엇이든 127.0.0.1로 닿는다.
      (sessionId) => {
        if (this.config.browserDriverFactory === undefined || !this.http) return null;
        const secret = this.issueBrowserSecret(sessionId);
        return browserMcpEntry(true, `http://127.0.0.1:${this.address().port}`, secret);
      },
      // createSession 이 던지면 발급된 시크릿을 회수한다 — 못 열린 세션의
      // 자격이 맵에 남는 일을 막는다.
      (sessionId) => {
        for (const [secret, candidate] of this.browserSecrets) {
          if (candidate.sessionId === sessionId) this.browserSecrets.delete(secret);
        }
      },
    );
    this.plans = new PlanTracker({
      idleSession: (provider) =>
        [...this.manager.all()]
          .filter((candidate) => candidate.state === "idle")
          .filter((candidate) => candidate.provider === provider)
          .sort((a, b) => b.lastActivity - a.lastActivity)[0] ?? null,
      claudeExecutable: () => this.claudeExecutable,
      probeCwd: () => {
        const active = this.activeOrNull();
        return active?.repo.isCloned() ? realpathBestEffort(active.paths.repoRoot) : homedir();
      },
      signal: this.closing.signal,
      onChanged: () =>
        void this.status().then((status) => this.broadcast({ type: "status", status })),
      catalogSources: this.agentDrivers
        .all()
        .filter((driver) => typeof driver.listModels === "function")
        .map((driver) => ({
          provider: driver.id,
          read: () => driver.listModels!(),
        })),
    });
    this.drivers = new PreviewDrivers({
      factory: () => this.config.previewDriverFactory,
      activeRepo: () => this.activeOrNull()?.repo ?? null,
      // 게이트의 재검증은 세션이 사는 프로젝트 기준 — 전환 뒤 끝난 턴의 핀을
      // 활성 레포의 주소로 다시 열지 않는다(preview-drivers 의존 주석 참조).
      repoForSession: (id) => this.workspaceOfSession(id)?.repo ?? null,
      session: (id) => this.manager.get(id),
      sessions: () => this.manager.all(),
      notice: (n) => {
        // 게이트가 턴을 다시 열었다는 사실이 그 턴의 통계에 새겨진다.
        if (n.kind === "gate") this.stats.noteGate(n.sessionId);
        this.config.onNotice?.(n);
      },
    });
    // 턴 통계 — 서버가 아는 것만 좁은 창으로 내어준다. 사건은 onEvent 에서
    // 흘러들어오고, 세션·프로젝트 조회는 여기의 콜백이 나중에 답한다.
    this.stats = new TurnStats({
      projectOf: (sessionId) => {
        const workspaces = this.workspaceOfSession(sessionId);
        if (workspaces === null) return null;
        const root = realpathBestEffort(workspaces.paths.repoRoot);
        for (const project of this.registry.list()) {
          if (realpathBestEffort(this.registry.paths(project.slug).repoRoot) === root) {
            return project.slug;
          }
        }
        return null;
      },
      chipsOf: (sessionId) => {
        const session = this.manager.get(sessionId);
        if (session === undefined) return { provider: null, model: null, effort: null };
        return {
          provider: session.provider,
          model: session.model ?? session.chosen.model,
          effort: session.chosen.effort,
        };
      },
      contextTokens: async (sessionId) => {
        const usage = await this.manager.get(sessionId)?.contextUsage();
        return usage?.totalTokens ?? null;
      },
    });
  }

  async start(): Promise<void> {
    this.claudeExecutable = await resolveClaudeExecutable(this.config.claudeExecutable);
    // 기동 청소 (PLAN D86 의 확장): rooms the dead process was holding come
    // back as the lost room — the turns they waited for are gone, so the
    // words surface for the planner's hand, never for an automatic send.
    const orphaned = this.queueStore.sweepOrphans();
    if (orphaned > 0) this.logger?.info(`queue: recovered ${orphaned} lost room(s) from disk`);

    // Secrets move into the OS store on the way in; settings files keep only
    // what is not secret. A platform without its store yet keeps its plaintext.
    await migratePlaintextSecrets(this.credentials);

    // A pre-projects installation becomes one project here, folder and all,
    // and its per-project PAT — if the old layout left one — becomes the
    // machine-wide token nobody has to re-enter.
    this.registry = ProjectRegistry.load(process.env);
    this.machineSetting.load();
    this.fleet = new ProjectFleet({
      registry: this.registry,
      manager: this.manager,
      previewDrivers: this.drivers,
      broadcast: (m) => this.broadcast(m),
      notice: (n) => this.config.onNotice?.(n),
      logger: this.logger,
      claudeExecutable: () => this.claudeExecutable,
      machineTurn: (prompt, opts) => this.machineTurns.turn(prompt, opts),
      // 넘긴 요청의 작성자 이름 — 온보딩이 machine.json 에 저장한 값(P1-3).
      authorName: () => this.machineSetting.get("authorName"),
      closingSignal: this.closing.signal,
      pat: () => this.github.token,
      escalate: (text) => void this.escalation.notify(text),
      gitHubClient: () => this.github.client(),
      queueDiskFor: this.queueDiskFor,
    });
    await migrateProjectPats(
      this.credentials,
      this.registry.list().map((project) => project.slug),
      this.registry.activeSlug(),
    );
    await this.github.load();
    // 슬라이스 5: 저장된 웹훅을 읽는다 — 상태 방송은 그 뒤에 일어난다.
    await this.escalation.load();
    this.router = new RequestRouter({
      manager: this.manager,
      fleet: this.fleet,
      previewDrivers: this.drivers,
      handoffPreviews: this.handoffPreviews,
      stats: this.stats,
      agentDrivers: this.agentDrivers,
      plans: this.plans,
      github: this.github,
      queueStore: this.queueStore,
      registry: this.registry,
      escalation: this.escalation,
      logger: this.logger,
      broadcast: (m) => this.broadcast(m),
      notice: (n) => this.config.onNotice?.(n),
      claudeExecutable: () => this.claudeExecutable,
      claudeExecutableOverride: () => this.config.claudeExecutable,
      machineSetting: this.machineSetting,
      machineTurns: this.machineTurns,
      agentLogin: this.agentLogin,
      queueDiskFor: this.queueDiskFor,
      status: () => this.status(),
    });

    // 커미티 B1 감동판 (2026-09-15): 열린 넘김이 있는 프로젝트를 주기적으로
    // 다시 읽는다 — 반영됨·변경 요청이 기획자를 찾아온다. unref: 테스트 러너와
    // 데스크톱 in-process 호스트를 타이머가 붙잡지 않게.
    this.handoffTimer = setInterval(() => void this.pollOpenHandoffs(), HANDOFF_POLL_MS);
    this.handoffTimer.unref?.();

    // Warm restart: bring the active project up the same way a switch does —
    // in particular, arm its token. A start that only built the workspace
    // left it unarmed until the planner happened to switch projects, so a
    // private repo could neither pull nor hand over after a restart.
    // `activateProject` sees nothing moving and stops after arming it.
    const activeSlug = this.registry.activeSlug();
    if (activeSlug) {
      const active = await this.activateProject(activeSlug);
      if (active.repo.remoteUrl) void active.repo.sync().catch(() => undefined);
    }

    // The sidebar's numbers and badges exist before anyone clicks (PLAN D18):
    // a workspace per project — cheap, synchronous, side-effect free — and
    // one `git status` per cloned project so a restart does not blank the
    // counts. Only the ACTIVE project gets a preview server; that is what
    // activation above already did. Clones re-arm their trust entry too: the
    // ~/.colo-design migration renamed every clone path, and trust is keyed
    // by path.
    const sweeps: Array<Promise<unknown>> = [];
    for (const project of this.registry.list()) {
      const workspaces = this.workspacesFor(project.slug);
      workspaces.repo.setPat(this.github.token);
      if (workspaces.repo.isCloned()) {
        trustWorkspace(workspaces.paths.repoRoot);
        sanitizeRepoAgentSettings(workspaces.paths.repoRoot);
        // Awaited, not fired-and-forgotten: the first announce and every
        // client's first status read must see the counted clone, or a
        // restart blanks the counts for exactly the moment the tree also
        // starts scanning (PLAN D18/D59).
        sweeps.push(
          workspaces.repo
            .recoverParkedWork()
            .catch(() => undefined)
            .then(() => workspaces.repo.refreshPendingChanges()),
        );
      }
    }
    await Promise.all(sweeps);
    if (this.registry.list().length > 0) this.announceProjects();

    this.http = createServer((req, res) => {
      // Everything this server emits is either per-run (a token'd page) or
      // live state: no store, ever — a disk cache must never hold a url that
      // carries the pairing token (QA generation-1 finding F2).
      res.setHeader("cache-control", "no-store");
      // A tiny health endpoint so `hub doctor` and launchd can probe the daemon.
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
        return;
      }
      // 브라우저 MCP 자식의 중계 엔드포인트(3단계) — 인증은 세션별 시크릿.
      // 정적 서빙이 이 요청을 삼키지 않게 /health 다음에 둔다.
      if (req.url === "/internal/browser") {
        void this.onInternalBrowser(req, res);
        return;
      }
      if (this.config.webDist) {
        serveWeb(this.config.webDist, req, res);
        return;
      }
      res.writeHead(404).end();
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.http.on("upgrade", (req, socket, head) => {
      // A browser page on another origin could drive this socket cross-site —
      // the token sits in the url, so an Origin-bearing client must be one of
      // ours: the daemon's own pages or the dev server. Non-browser clients
      // send no Origin and answer to the token alone.
      const origin = req.headers.origin;
      if (origin !== undefined && !this.allowedUpgradeOrigin(origin)) {
        this.logger.warn("허용되지 않은 출처의 연결 거부", {
          origin,
          remote: req.socket.remoteAddress ?? "unknown",
        });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      // A malformed Host (or url) throws inside `new URL` — left alone that is
      // an uncaughtException in the daemon's own process. Reject the handshake.
      let url: URL;
      try {
        url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      } catch {
        this.logger.warn("잘못된 업그레이드 요청 거부", {
          remote: req.socket.remoteAddress ?? "unknown",
        });
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      const given = Buffer.from(url.searchParams.get("token") ?? "");
      const expected = Buffer.from(this.config.token);
      // Constant-time: this token guards every message the daemon accepts.
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        this.logger.warn("토큰 불일치 연결 거부", {
          remote: req.socket.remoteAddress ?? "unknown",
        });
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss?.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });

    await new Promise<void>((resolve, reject) => {
      // A bind failure (the stored port is taken) must reach the caller as a
      // rejection, not crash the process on an unhandled 'error' event — the
      // daemon entry prints its Korean guidance from that rejection.
      this.http?.once("error", reject);
      this.http?.listen(this.config.port, this.config.host, () => resolve());
    });
    // 미리보기 포트 스캔은 이 포트를 못 본다 — 자식들이 fd 로 물려받은 이
    // 리스너를 자기 소켓으로 착각하는 함정을 닫는다(preview-claim 참조).
    daemonOwnedPorts.add(this.address().port);
    const bound = this.address();
    this.logger.info("데몬 시작", {
      host: bound.address,
      port: bound.port,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  /** Where the HTTP server actually bound (port 0 = ephemeral in desktop). */
  address(): { address: string; port: number } {
    const bound = this.http?.address() as { address: string; port: number };
    return bound;
  }

  /**
   * The origins a WebSocket upgrade may come from: the daemon's own pages
   * (loopback on the bound port — the desktop's one-process origin) and, on
   * the HMR dev path, the vite server the window was opened from
   * (`COLO_DESIGN_DEV_SERVER`, desktop/scripts/dev.mjs). Anything else that
   * sends an Origin is a foreign page and gets a 403.
   */
  private allowedUpgradeOrigin(origin: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const port = this.address().port;
    const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
    if (loopback && parsed.port === String(port)) return true;
    const devServer = process.env.COLO_DESIGN_DEV_SERVER;
    if (devServer) {
      try {
        if (parsed.origin === new URL(devServer).origin) return true;
      } catch {
        // A malformed dev-server env var allows nothing.
      }
    }
    return false;
  }

  /** 리뷰 B3: the desktop's close guard asks before quitting under a turn. */
  anySessionBusy(): boolean {
    return this.manager.anyBusy();
  }

  /**
   * Shutdown, asked for as many times as anyone likes. A second call joins
   * the first instead of running the sequence again: the old one re-entered
   * `http.close()` on a listener already closed (and already nulled), whose
   * callback never fires — the caller's promise hung forever, which is how
   * projects-e2e finished green while its `main()` never returned.
   */
  async stop(): Promise<void> {
    this.stopping ??= this.runStop();
    return this.stopping;
  }

  private async runStop(): Promise<void> {
    // First, before any await: the probes this run left unattended must stop
    // waiting on a CLI nobody is listening to any more.
    this.closing.abort();
    // 진행 중인 에이전트 로그인도 이 데몬의 자식이다 — 데몬이 내려가면 함께 끊는다.
    this.agentLogin.stop();
    clearInterval(this.handoffTimer ?? undefined);
    this.handoffTimer = null;
    this.logger.info("데몬 종료");
    await this.manager.closeAll();
    // Every project the daemon touched this run, not just the active one: an
    // inactive project may still hold a warm preview server, and every
    // preview process is ours to take down. The fleet itself may not exist —
    // a start() that failed before building it still owes stop() a clean
    // shutdown, not a TypeError that caches the rejection in `stopping`.
    for (const workspaces of this.fleet?.workspaces.values() ?? []) {
      // Writers settle BEFORE the preview dies: a 최신화 killed between its
      // stash and its pop parks the planner's unsaved work in `git stash`.
      await workspaces.repo.settle();
      await workspaces.repo.stop();
    }
    // 수명 규칙의 마지막 자리 — 데몬이 내려가면 워크트리·서버·기록이 남는다.
    await this.handoffPreviews.dispose();
    for (const client of this.clients) client.close();
    this.wss?.close();
    // The web/http listener refs the event loop for as long as it listens —
    // the desktop in-process host and the test runner both stay alive until
    // it is closed, so stop() must close it, not just the websocket.
    const http = this.http;
    this.http = null;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  private attach(ws: WebSocket): void {
    this.clients.add(ws);
    this.logger.info("클라이언트 연결", { clients: this.clients.size });
    ws.on("close", () => {
      this.clients.delete(ws);
      this.logger.info("클라이언트 연결 해제", { clients: this.clients.size });
    });
    ws.on("message", (raw) => void this.onMessage(ws, String(raw)));

    void this.status().then((status) => {
      this.send(ws, {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        status,
      });
      // 재접속 복원 (리뷰 B1): the requests the window missed while it was
      // gone — the cards it must answer or the turn waits forever. THIS
      // socket only; a broadcast would double every other window's cards.
      // The client dedupes by requestId, so a flapping socket replays safe.
      for (const message of this.manager.pendingReplays()) this.send(ws, message);
    });
    void this.activeOrNull()
      ?.repo.status()
      .then((status) => this.broadcast({ type: "repo.status", status }));
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients) this.send(client, message);
  }

  // -------------------------------------------------------------------------
  // Projects (PLAN D2[프로젝트]): what "the repo" currently means
  // -------------------------------------------------------------------------
  /**
   * A project's live workspace — the fleet (project-fleet.ts) owns the map,
   * the switch, the announces, and the handoff poll; the delegates below
   * keep the dispatch table and session wiring readable.
   */
  private workspacesFor(slug: string): ProjectWorkspaces {
    return this.fleet.workspacesFor(slug);
  }

  private activeOrNull(): ProjectWorkspaces | null {
    return this.fleet.activeOrNull();
  }

  private projectSummaries(): ProjectSummary[] {
    return this.fleet.projectSummaries();
  }

  private announceProjects(): void {
    this.fleet.announceProjects();
  }

  private async pollOpenHandoffs(): Promise<void> {
    return this.fleet.pollOpenHandoffs();
  }

  private refreshThreads(): void {
    this.fleet.refreshThreads();
  }

  private activateProject(slug: string): Promise<ProjectWorkspaces> {
    return this.fleet.activateProject(slug);
  }

  private workspaceOfSession(sessionId: string): ProjectWorkspaces | null {
    return this.fleet.workspaceOfSession(sessionId);
  }

  /**
   * P2-1: 대기표의 이 턴을 치른다 — 표를 뽑아 쓰므로 한 턴은 한 번만 커밋한다
   * (게이트 경로와 idle 경로가 같은 턴에 둘 다 닿아도).
   */
  private runAutoSave(sessionId: string): void {
    if (!this.autoSaveDue.delete(sessionId)) return;
    void this.fleet.autoSaveTurn(sessionId);
  }

  // -------------------------------------------------------------------------
  // Preview tools (PLAN D61) — the desktop's driver, one per session.
  // Ownership lives in preview-drivers.ts; what remains here is the host's
  // entry point and the call sites wiring a fresh driver into session
  // create / branch.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Browser tools (인앱 브라우저 3단계) — the MCP child's relay endpoint.
  // A session-scoped secret is the only credential: issued here at session
  // create, carried to the child in env, revoked when the session closes.
  // -------------------------------------------------------------------------

  /**
   * 세션 하나의 브라우저 시크릿을 발급한다. session-manager가 세션을 열 때
   * browserDriverFactory가 있으면 불러 browserMcp 기동 명세의 env에 태운다 —
   * MCP 자식은 이 시크릿으로만 /internal/browser에 닿는다.
   */
  issueBrowserSecret(sessionId: string): string {
    const secret = randomBytes(32).toString("base64url");
    this.browserSecrets.set(secret, { sessionId, issuedAt: Date.now() });
    return secret;
  }

  /**
   * POST /internal/browser — browser-mcp.js의 도구 호출이 닿는 자리. op는
   * 화이트리스트로 가리고 실행은 pane 드라이버로 위임한다. 계약: 200
   * {ok:true,result} | 200 {ok:false,error} | 401 시크릿 불일치 | 404
   * 팩토리·pane 없음. 드라이버가 던진 실패(stale ref·DevTools 충돌 등)는
   * 도구가 읽고 고칠 수 있게 200 ok:false로 내려간다.
   */
  private async onInternalBrowser(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: Record<string, unknown>): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // 시크릿 검사 — 발급된 시크릿과 상수 시간 비교. 길이 노출은 무의미하다
    // (시크릿은 43글자 base64url로 일정하다).
    const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "");
    let authorized = false;
    let sessionId: string | null = null;
    for (const [secret, candidate] of this.browserSecrets) {
      const expected = Buffer.from(secret);
      if (given.length === expected.length && timingSafeEqual(given, expected)) {
        authorized = true;
        sessionId = candidate.sessionId;
      }
    }
    if (!authorized || sessionId === null) {
      reply(401, { ok: false, error: "브라우저 시크릿이 일치하지 않습니다." });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > BROWSER_BODY_LIMIT) {
          reply(413, { ok: false, error: "요청 본문이 너무 큽니다." });
          return;
        }
        chunks.push(chunk as Buffer);
      }
    } catch {
      reply(400, { ok: false, error: "요청 본문을 읽지 못했습니다." });
      return;
    }
    let message: { op?: unknown; params?: unknown };
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof message;
    } catch {
      reply(400, { ok: false, error: "요청 본문을 JSON으로 읽지 못했습니다." });
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      reply(400, { ok: false, error: "요청 본문은 {op, params} 객체여야 합니다." });
      return;
    }
    const op = typeof message.op === "string" ? message.op : "";
    if (!BROWSER_OPS[op]) {
      reply(400, { ok: false, error: `알 수 없는 브라우저 op: ${op || "(없음)"}` });
      return;
    }
    const params = message.params ?? {};
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      reply(400, { ok: false, error: "params는 객체여야 합니다." });
      return;
    }
    // screen_check 는 pane 이 아니라 검증 창에서 돈다 — 사용자가 보는
    // 페이지를 건드리지 않고, pane 이 없어도(미리보기를 띄우지 않아도)
    // 판정할 수 있다. 게이트(runGate)와 같은 드라이버·같은 판정: open 이
    // 콘솔을 비우므로 읽는 줄은 정확히 그 화면의 것이다.
    if (op === "screenCheck") {
      const checked = await this.runScreenCheck(sessionId, params as Record<string, unknown>);
      reply(checked.status, checked.body);
      return;
    }
    const factory = this.config.browserDriverFactory;
    if (!factory) {
      reply(404, {
        ok: false,
        error: "브라우저 드라이버가 없습니다 — 데스크톱 앱에서만 동작합니다.",
      });
      return;
    }
    const driver = factory.forPane();
    if (!driver) {
      reply(404, {
        ok: false,
        error: "브라우저 창이 아직 없습니다 — 탭을 열거나 미리보기를 띄운 뒤 다시 시도해 주세요.",
      });
      return;
    }
    // 에이전트가 pane을 조작하는 동안 탭 스트립에 표시한다(4단계) — 시작과
    // 끝을 같은 자리에서 방송하므로 실패해도 표시가 남지 않는다. 읽기 op는
    // 조작이 아니라 관찰이라 표시를 켜지 않는다.
    const quiet = BROWSER_QUIET_OPS[op] === true;
    if (!quiet) this.broadcast({ type: "browser.driving", sessionId, on: true });
    // 타임아웃 판별용 센티넬 — catch 에서 이것과 같은 오류면 op 가 아직
    // 끝나지 않은 채 떠 있다는 뜻이라 큐 꼬리 회수와 드라이버 복구가 따라간다.
    const opTimeout = new Error("브라우저 명령이 시간을 넘겼습니다.");
    try {
      // 같은 세션의 op는 한 줄로 세운다 — 병렬이면 ref 세대가 경합해 가짜
      // "다시 읽으십시오"가 난다. 타임아웃은 호출자만 놓아 준다 — 큐 꼬리는
      // op 의 실제 끝을 기다리므로, 시간을 넘긴 op 가 뒤에서 계속 돌아도
      // 다음 op 와 겹치지 않는다.
      const run = this.browserOps.get(sessionId) ?? Promise.resolve();
      const opDone = run.then(async () => {
        // 권한은 op 종류가 아니라 실행 시점의 표면이 정한다 — 레포 바깥
        // 화면에서는 scroll{dy:0} 한 줄도 페이지 전체를 실어 나르므로,
        // 비-레포 표면의 모든 op 가 카드를 지난다. 판정을 큐 안(실행
        // 직전)에 두는 것이 TOCTOU 를 닫는 길이다: 요청과 실행 사이에
        // 사용자가 화면을 옮겼을 수 있다. 카드는 세션의 권한 흐름 그
        // 자체라 항상 허용 메모리가 통하고, 무응답은 유예 뒤 거절로
        // 정산된다.
        const repoSurface = driver.isRepoSurface();
        if (!repoSurface) {
          const session = this.manager.get(sessionId);
          if (!session) throw new Error("대화가 이미 닫혔습니다.");
          const ask = new AbortController();
          const askTimer = setTimeout(() => ask.abort(), BROWSER_ASK_TIMEOUT_MS);
          askTimer.unref();
          let verdict: { allowed: boolean; message: string | null };
          try {
            verdict = await session.decideBrowserOp(`browser_${op}`, ask.signal);
          } finally {
            clearTimeout(askTimer);
          }
          if (!verdict.allowed) {
            throw new Error(verdict.message ?? "사용자가 이 화면에 대한 접근을 거절했습니다.");
          }
        }
        const result = await callBrowserOp(driver, op, params as Record<string, unknown>);
        // 레포 표면에서 떠난 이동(navigate·back·forward)은 카드 없이
        // 허용했다 — 하지만 착지한 곳이 레포 바깥이면 그 화면의 내용까지
        // 약속한 것은 아니다. 스냅샷을 내리지 않는다: 다시 읽고 싶으면
        // 권한 카드를 지나는 읽기 op 를 부르게 한다.
        if (
          repoSurface &&
          !driver.isRepoSurface() &&
          (op === "navigate" || op === "back" || op === "forward")
        ) {
          // navigate 의 settled 만 살린다(도착 사실) — 결과가 계약 밖
          // 형태면 정착 실패로 답하는 쪽이 안전하다.
          if (
            op === "navigate" &&
            result !== null &&
            typeof result === "object" &&
            "settled" in result
          ) {
            return { settled: result.settled === true, note: BROWSER_EXTERNAL_NOTE };
          }
          return { note: BROWSER_EXTERNAL_NOTE };
        }
        return result;
      });
      this.browserOps.set(
        sessionId,
        opDone.catch(() => undefined),
      );
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        opDone,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(opTimeout), BROWSER_OP_TIMEOUT_MS);
          timer.unref();
        }),
      ]).finally(() => clearTimeout(timer));
      // navigate 가 가리킨 주소는 이 턴의 게이트 입력이다 — 사람의 pin과
      // 같은 자리(notePinned)에 담고, preview origin 판별은 runGate가 한다.
      // 전체 URL을 남긴다 — origin을 벗기면 외부 탐색이 preview 경로로
      // 둔갑해 게이트가 뜬 적 없는 화면을 재검증한다. 주소의 쿼리는
      // 그냥 주소의 일부로 실린다(2026-09-21 상태 축 철거).
      if (op === "navigate" && typeof (params as Record<string, unknown>).url === "string") {
        try {
          const u = new URL((params as Record<string, unknown>).url as string);
          this.drivers.notePinned(sessionId, u.toString());
        } catch {
          // 못 읽는 주소는 게이트 입력이 아니다.
        }
      }
      reply(200, { ok: true, result });
    } catch (error) {
      reply(200, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error === opTimeout) {
        // op 가 끝나지 않은 채 떠 있다 — 꼬리를 이미 해결된 Promise 로
        // 갈아치워 다음 op 가 멈춘 op 를 기다리지 않게 하고, 드라이버를
        // 복구해 디버거 점유(사용자의 DevTools 봉쇄)를 푼다. 멈춘 op 자체는
        // 계속 떠 있을 수 있지만 큐와 붙임은 회수됐다.
        this.browserOps.set(sessionId, Promise.resolve());
        try {
          driver.recover();
        } catch {
          // 복구 실패가 타임아웃 보고를 가리면 안 된다 — 다음 op 가 다시 시도한다.
        }
      }
    } finally {
      if (!quiet) this.broadcast({ type: "browser.driving", sessionId, on: false });
    }
  }
  /**
   * `screen_check` 도구의 판정 (빠른 수정, 2026-09-20): 세션이 사는
   * 프로젝트의 미리보기 주소에서 그 화면을 검증 창으로 열어 본다 —
   * 게이트(runGate)와 같은 드라이버, 같은 기준(자리 잡음 + error·실패한
   * 요청), 같은 상한. 돌려주는 것은 정확히 그 두 사실뿐이라 스냅샷 수천
   * 토큰을 태우지 않는다. 레포 바깥 주소는 원천 봉쇄 — 검증 창이 열 수
   * 있는 것은 이 세션의 미리보기뿐이다.
   */
  private async runScreenCheck(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const factory = this.config.previewDriverFactory;
    if (factory === undefined) {
      return {
        status: 404,
        body: { ok: false, error: "브라우저 드라이버가 없습니다 — 데스크톱 앱에서만 동작합니다." },
      };
    }
    const route0 = typeof params.route === "string" ? params.route : "";
    if (route0.trim() === "") {
      return { status: 400, body: { ok: false, error: "확인할 화면 주소(route)가 필요합니다." } };
    }
    // 게이트와 같은 겨냥 — 세션이 사는 프로젝트의 미리보기. 활성 프로젝트가
    // 아니라 이 세션의 것이다(전환 뒤 끝난 턴과 같은 이유).
    const repo = this.workspaceOfSession(sessionId)?.repo ?? null;
    const status = await repo?.status().catch(() => null);
    const previewUrl = status?.previewUrl;
    if (!repo || !previewUrl) {
      return {
        status: 200,
        body: {
          ok: false,
          error: "미리보기 서버가 아직 뜨지 않았습니다 — 잠시 후 다시 시도해 주세요.",
        },
      };
    }
    let target: URL;
    try {
      target = new URL(route0, previewUrl);
    } catch {
      return { status: 400, body: { ok: false, error: `화면 주소를 읽지 못했습니다: ${route0}` } };
    }
    const origin = new URL(previewUrl).origin;
    if (target.origin !== origin) {
      return {
        status: 200,
        body: { ok: false, error: "미리보기 안의 화면만 확인할 수 있습니다." },
      };
    }
    const driver = factory.forIsolated(previewUrl);
    try {
      const opened = await driver
        .open(target.pathname + target.search + target.hash)
        .catch(() => null);
      if (opened === null || opened.ok !== true) {
        return {
          status: 200,
          body: {
            ok: false,
            error:
              opened !== null && opened.ok === false ? opened.reason : "화면을 열지 못했습니다.",
          },
        };
      }
      const errors = (await driver.consoleLines().catch(() => []))
        .filter((line) => TROUBLE_LEVELS[line.level.toLowerCase()] === true)
        .slice(0, MAX_LINES_PER_SCREEN)
        .map((line) => `${line.level}: ${line.text}`);
      return {
        status: 200,
        body: {
          ok: true,
          // 2026-09-21: 화면의 전체 주소 — 답변의 하이퍼링크가 이 주소로
          // 맺어진다. 경로만 아는 패인에게 미리보기 서버의 주소를 가르쳐
          // 주는 유일한 자리다.
          result: { settled: opened.settled, errors, url: target.toString() },
        },
      };
    } finally {
      await driver.destroy().catch(() => undefined);
    }
  }

  private async status() {
    const active = this.activeOrNull();
    const base = await buildStatus({
      executable: this.claudeExecutable,
      liveSessions: this.manager.liveCount,
      pendingPermissions: this.manager.pendingCount,
      // The registry probe only makes sense inside a repo that declares one.
      registryProbeDir: active?.repo.registry() ? active.repo.root : null,
    });
    // A repo that ships its own pre-approved tool rules widens its sessions
    // past the card flow — the planner should hear that it did. It rides its
    // own field, not the env warnings: this is news, not a live problem, and
    // the fingerprint lets a client that has read it stay quiet until the
    const repoSettings = active ? repoSettingsWarning(active.repo.root) : null;
    const providers = await Promise.all(
      this.agentDrivers.all().map(async (driver) => {
        const descriptor = driver.describe();
        const diagnostic = await driver.isAvailable().catch((): Diagnostic => ({ ok: false }));
        return {
          id: descriptor.id,
          label: descriptor.label,
          available: diagnostic.ok,
          ...(diagnostic.version ? { version: diagnostic.version } : {}),
          ...(diagnostic.loggedIn !== undefined ? { loggedIn: diagnostic.loggedIn } : {}),
          ...(diagnostic.reason ? { reason: diagnostic.reason } : {}),
          oneShot: driver.oneShot !== undefined,
          modes: descriptor.modes,
          defaultModeId: descriptor.defaultModeId,
          capabilities: {
            ...descriptor.capabilities,
            // 브라우저 도구(3단계): 공급자 선언은 "주입 가능"일 뿐 — 실제
            // 제공은 host의 browserDriverFactory 주입이 정한다. 둘 다 참일
            // 때만 UI가 브라우저 의존 기능을 보여 준다.
            browserTools:
              descriptor.capabilities.browserTools === true &&
              this.config.browserDriverFactory !== undefined,
          } as Record<string, unknown>,
        };
      }),
    );
    // The picker's rows before any thread: drivers that can answer without
    // a session are read once per run, off this await — the next broadcast
    // carries whatever landed.
    this.plans.refreshModels();
    return {
      ...base,
      repoSettingsWarning: repoSettings,
      planUsageByProvider: this.plans.currentAll(this.agentDrivers.all().map((d) => d.id)),
      modelsByProvider: this.plans.models,
      projects: this.projectSummaries(),
      activeProject: this.registry?.activeSlug() ?? null,
      providers,
      machineProvider: this.machineSetting.get("provider"),
      machineProviderActive: await this.machineTurns.resolve(),
      // 개발 전용 면의 판정은 데몬이 내린다 — 웹 번들의 DEV 플래그는 패키징 빌드라 항상 거짓.
      dev: this.config.devAgents === true,
      authorName: this.machineSetting.get("authorName"),
      githubAuthExpired: this.github.authExpired,
    };
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send(ws, {
        type: "error",
        id: parsed.id,
        message: parsed.error,
        code: "bad_request",
      });
      return;
    }
    const message = parsed.value;
    try {
      const data = await this.router.dispatch(message);
      this.send(ws, { type: "ok", id: message.id, data });
    } catch (error) {
      // The one Korean boundary every RPC refusal passes (리뷰 C1·C3): the
      // daemon's own guards already answer in Korean and pass through
      // untouched, while a foreign error — the SDK's "Query closed before
      // response received" once rode the wire to the chat banner — is logged
      // here verbatim and replaced by the recovery sentence.
      this.logger.error("요청 실패", { type: message.type, err: error });
      this.send(ws, {
        type: "error",
        id: message.id,
        message: asPlannerFacingError(error).message,
      });
    }
  }
}
