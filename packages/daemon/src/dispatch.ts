import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type ClientMessage,
  DEFAULT_HANDOFF_BODY,
  markTurn,
  type ServerMessage,
} from "@colo-design/protocol";
import type { DriverRegistry } from "./agent/registry.js";
import { captureTargets, readComments, recordComments } from "./comments.js";
import { browseFiles, listFiles } from "./environment.js";
import type { GitHubBridge } from "./github-bridge.js";
import type { HandoffPreviews } from "./handoff-preview.js";
import type { DaemonLogger } from "./log.js";
import type { DaemonNotice } from "./notices.js";
import {
  gitInstallGuidance,
  runOnboardingChecks,
  runPnpmInstall,
  startClaudeInstall,
  startClaudeLogin,
} from "./onboarding.js";
import { realpathBestEffort } from "./paths.js";
import type { PlanTracker } from "./plan-tracker.js";
import type { PreviewDrivers } from "./preview-drivers.js";
import type { ProjectFleet, ProjectWorkspaces } from "./project-fleet.js";
import type { ProjectRegistry } from "./projects.js";
import type { QueueDisk, QueueStore } from "./queue-store.js";
import { assertClonableRepoUrl, type RepoWorkspace } from "./repo.js";
import type { Session } from "./session.js";
import type { SessionManager } from "./session-manager.js";
import { dropTape, readTape, spliceTape } from "./session-tape.js";
import { undoLog } from "./undo-log.js";
import { repoWritePolicy } from "./workspaces.js";

/**
 * 서버가 라우터에 넘기는 것 — 프로토콜의 모든 요청이 거치는 좁은 문. 협력자는
 * 참조로, 실행 중 바뀌는 값은 콜백으로, 바깥에도 쓰이는 상태맵은 공유로.
 */
export interface RouterDeps {
  manager: SessionManager;
  fleet: ProjectFleet;
  previewDrivers: PreviewDrivers;
  /**
   * 시점 빌드 재현 — the handed-off moment's worktree
   * build. The server owns its lifetime; the router only relays.
   */
  handoffPreviews: HandoffPreviews;
  /** The agent provider registry — session.create resolves its driver here. */
  agentDrivers: DriverRegistry;
  plans: PlanTracker;
  github: GitHubBridge;
  queueStore: QueueStore;
  registry: ProjectRegistry;
  logger: DaemonLogger;
  broadcast(message: ServerMessage): void;
  notice(notice: DaemonNotice): void;
  /** 해석된 CLI 경로 — start() 가 채운다. */
  claudeExecutable(): string | null;
  /** 설정의 CLI 경로 오버라이드 — 온보딩 체크가 읽는다. */
  claudeExecutableOverride(): string | undefined;
  queueDiskFor(sessionId: string): QueueDisk;
  /** 세션별 화면 턴 번호 (PLAN D52) — echo 콜백(서버)과 session.send(여기)가 나눠 쓴다. */
  checkpointTurns: Map<string, number>;
  status(): Promise<unknown>;
}

/**
 * 클라이언트 메시지의 라우팅 테이블 — 한 케이스가 곧 선로 위 계약 하나. 서버는
 * transport 와 수명주기를, 이 라우터는 "무엇을 어디로 보내는가"를 담당한다.
 */
export class RequestRouter {
  /** The last thread a failing gate briefed, when it had to open one itself. */
  private gateThreadId: string | null = null;
  /**
   * 재시작 뒤 첫 턴의 밑값 읽기 — 진행 중인 promptCount 프로미스를 세션별로
   * 나눠 쥔다. 읽기는 대화록 파일을 디스크에서 다시 읽으므로 await 가 끼고,
   * 그 사이에 도착한 같은 세션의 두 번째 send 가 또 읽으면 둘이 같은 밑값을
   * 적어 같은 턴 번호의 체크포인트가 두 번 찍힌다(뒤것이 앞것을 덮는다).
   * 늦게 온 send 는 새로 읽지 않고 이미 도는 읽기에 합류한다.
   */
  private readonly checkpointSeeding = new Map<string, Promise<void>>();

  constructor(private readonly deps: RouterDeps) {}

  /** The active project's repo — every repo.* case's "the repo". */
  private get repo(): RepoWorkspace {
    return this.deps.fleet.requireActive().repo;
  }

  private workspacesFor(slug: string): ProjectWorkspaces {
    return this.deps.fleet.workspacesFor(slug);
  }

  private requireActive(): ProjectWorkspaces {
    return this.deps.fleet.requireActive();
  }

  private projectSummaries() {
    return this.deps.fleet.projectSummaries();
  }

  private announceProjects(): void {
    this.deps.fleet.announceProjects();
  }

  private refreshThreads(): void {
    this.deps.fleet.refreshThreads();
  }

  private touchThreadsCwd(cwd: string | null | undefined): void {
    this.deps.fleet.touchThreadsCwd(cwd);
  }

  private async cliCommands() {
    return this.deps.fleet.cliCommands();
  }

  private activateProject(slug: string): Promise<ProjectWorkspaces> {
    return this.deps.fleet.activateProject(slug);
  }

  private async createProject(message: Parameters<ProjectFleet["createProject"]>[0]) {
    return this.deps.fleet.createProject(message);
  }

  private workspaceCwd(): string {
    return this.deps.fleet.workspaceCwd();
  }

  private projectInstructions(cwd: string): string {
    return this.deps.fleet.projectInstructions(cwd);
  }

  private async resolveSessionCwd(sessionId: string): Promise<string> {
    return this.deps.fleet.resolveSessionCwd(sessionId);
  }

  private workspaceOfSession(sessionId: string): ProjectWorkspaces | null {
    return this.deps.fleet.workspaceOfSession(sessionId);
  }

  async dispatch(message: ClientMessage): Promise<unknown> {
    switch (message.type) {
      case "daemon.status":
        return await this.deps.status();

      case "session.list":
        return await this.deps.manager.list(this.workspaceCwd(), message.limit ?? 50);

      // 리뷰 B7: the notification click names a session, the UI needs its
      // project first — resuming in the wrong project would fork the thread.
      case "session.locate": {
        const workspaces = this.workspaceOfSession(message.sessionId);
        const slug = workspaces
          ? ([...this.deps.fleet.workspaces.entries()].find(
              ([, value]) => value === workspaces,
            )?.[0] ?? null)
          : null;
        return { slug };
      }

      case "session.history": {
        const sessionCwd = await this.resolveSessionCwd(message.sessionId);
        const events0 = await this.deps.manager.history(message.sessionId, sessionCwd);
        // hero-synthesis D1: the daemon's own cycle events (저장 · 넘김 ·
        // 반영 · 코멘트 도착) live on the session tape, not the vendor
        // transcript — splice them in at the turn they followed.
        const tape = this.deps.fleet.workspacesForCwd(sessionCwd);
        const replayed = tape
          ? spliceTape(events0, readTape(tape.paths.root, message.sessionId))
          : events0;
        // 대기 줄과 lost room 은 기록이 아니라 지금의 상태 (PLAN D86 의
        // 확장): a window opened — or reloaded — must see both above the
        // field, so they ride at the tail of the replay. The tail is
        // AUTHORITATIVE, empty rooms included — a window that kept rows the
        // daemon no longer holds must lose them here, not keep the ghosts.
        const events = [
          ...replayed,
          { kind: "queued", items: this.deps.manager.get(message.sessionId)?.heldItems() ?? [] },
        ];
        const lost = this.deps.queueStore.lostItems(message.sessionId);
        return lost.length > 0 ? [...events, { kind: "queue.lost", items: lost }] : events;
      }

      case "session.create": {
        // A resume names the thread, not the provider — the store that owns
        // the id decides which driver continues it.
        const storedProvider = message.resume
          ? await this.deps.manager.findStoredProvider(message.resume, this.workspaceCwd())
          : undefined;
        if (message.resume && !message.provider && storedProvider === undefined) {
          // Guessing a driver for a foreign id corrupts the resume — say so.
          throw new Error(
            "이 대화를 저장한 에이전트를 찾지 못했습니다 — 목록에서 다시 열어 주세요.",
          );
        }
        const provider = message.provider ?? storedProvider ?? "claude";
        const driver = this.deps.agentDrivers.get(provider);
        if (!driver) {
          throw new Error(`알 수 없는 에이전트입니다: ${provider}`);
        }
        const availability = await driver.isAvailable();
        if (!availability.ok || !availability.executable) {
          throw new Error(
            provider === "claude"
              ? "Claude Code CLI 를 찾지 못했습니다 — 설치를 마친 뒤 다시 시도해 주세요."
              : `${driver.describe().label} CLI 를 찾지 못했습니다 — 설치를 마친 뒤 다시 시도해 주세요.`,
          );
        }
        if (!existsSync(this.repo.root)) {
          throw new Error("연결 레포가 아직 준비되지 않았습니다 — 잠시 후 다시 시도해 주세요.");
        }
        // A resume onto a thread whose live query already died (the crash
        // card's own state, or a force-aborted stop): tear the dead object
        // down FIRST, under its own id — after the replacement lands, its
        // late `closed` broadcast would take the fresh session's preview
        // driver with it. A healthy live thread is left exactly as it was.
        const dead = message.resume ? this.deps.manager.get(message.resume) : undefined;
        if (dead && (dead.state === "error" || dead.state === "closed")) {
          await this.deps.manager.close(dead.id);
        }
        const sessionCwd = this.workspaceCwd();
        const instructions = this.projectInstructions(sessionCwd);
        const session = this.deps.manager.create({
          cwd: sessionCwd,
          provider,
          queueDiskFor: this.deps.queueDiskFor,
          writePolicy: repoWritePolicy(sessionCwd),
          ...(message.title ? { title: message.title } : {}),
          launch: {
            executable: availability.executable,
            ...(instructions ? { appendSystemPrompt: instructions } : {}),
            ...(message.resume ? { resume: message.resume } : {}),
            ...(message.model ? { model: message.model } : {}),
            ...(message.effort ? { effort: message.effort } : {}),
          },
        });
        // A session start is the moment the 화면 half goes back to the remote.
        // Mid-cycle that is a merge of the developer's base branch, and a
        // conflict lands as this session's first task — which is why it runs
        // after the session exists, and without blocking on it.
        void this.repo.pull((brief) => {
          try {
            this.deps.manager.get(session.id)?.send(brief);
          } catch {
            // The fresh thread's query died mid-pull; the conflict state
            // itself still surfaces through repo.status.
          }
        });
        // The tree gains a child row (PLAN D59).
        this.deps.manager.invalidateThreads(session.cwd);
        this.refreshThreads();
        return { sessionId: session.id, state: session.state };
      }

      case "session.send": {
        // A live session of another project writes into another clone.
        // list() filters them out, but a client that kept an old id (a stale
        // tab) could still reach it — refuse instead of writing across.
        const target = this.deps.manager.require(message.sessionId);
        if (target.cwd !== this.workspaceCwd()) {
          throw new Error("다른 프로젝트의 대화입니다 — 프로젝트를 전환한 뒤 보내 주세요.");
        }
        // 사람이 다시 말을 걸었다 — 화면 확인 게이트의 한 번 제한이 풀린다.
        // 게이트는 사람의 턴마다 한 번이지, 대화마다 한 번이 아니다.
        this.deps.previewDrivers.gatedSessions.delete(message.sessionId);
        // 사람이 가리킨 화면은 이 말과 함께 간다: 핀을 받는 시점에 기록하지
        // 않는 이유는 대기 줄 때문이다. 도는 턴에 온 말은 held 로 기다리는데,
        // 그 핀을 미리 적으면 턴이 바뀔 때 지워져 그 말을 실은 턴의 게이트
        // 입력이 영영 사라진다. 핀은 deliver 시점(session 쪽)에 적힌다.
        // 죽은 질의에 말을 흘리지 않는다: 크래시 카드가 약속한대로, 같은 id 의
        // 재개(resume)가 새 CLI 에서 대화를 이어받아 지금의 말을 전달한다.
        // Refusals answer through the dispatch-wide Korean boundary above.
        const carrier = target.sendable ? target : await this.resurrectSession(target);
        // 화면 턴의 시작점 (PLAN D52) is the delivery (the echo, see the
        // manager's onEvent); this only seeds the count, before anything can
        // be handed over — so the transcript is read while it still holds
        // exactly the prompts that came before this one. The seed sits AFTER
        // the resurrect: the dead session's `closed` prunes the counter, and
        // a count planted before it would die with the old object.
        if (this.deps.checkpointTurns.get(message.sessionId) === undefined) {
          // 재시작 뒤 첫 턴: 카운터는 프로세스와 함께 사라지지만 대화록은
          // 남는다. 되감기의 k 번째 프롬프트는 대화록 기준이므로 이미 있는
          // 프롬프트 수부터 이어 셀 수밖에 없다 — 1부터 다시 세면 첫 되감기가
          // 전체 기억을 버리고, 두 번째는 남의 턴을 자른 채 memoryKept 를
          // 보고하던 것. 읽기가 도는 동안 온 같은 세션의 send 는 새로 읽지
          // 않고 그 읽기에 합류한다 — 둘이 같은 밑값을 적으면 같은 턴 번호의
          // 체크포인트가 두 번 찍혀 뒤것이 앞것을 덮는다.
          let seeding = this.checkpointSeeding.get(message.sessionId);
          if (!seeding) {
            seeding = this.deps.manager
              .promptCount(message.sessionId, target.cwd)
              .then((count) => {
                this.deps.checkpointTurns.set(message.sessionId, count);
              })
              .finally(() => {
                if (this.checkpointSeeding.get(message.sessionId) === seeding) {
                  this.checkpointSeeding.delete(message.sessionId);
                }
              });
            this.checkpointSeeding.set(message.sessionId, seeding);
          }
          await seeding;
        }
        carrier.send(message.text, message.images, message.pins);
        return { ok: true };
      }

      case "session.interrupt":
        await this.deps.manager.require(message.sessionId).interrupt();
        return { ok: true };

      // 대기 줄 다루기 (PLAN D86): both act on a live room, and `sendNow`
      // writes into the clone — the same cross-project fence as session.send.
      case "session.queue.remove": {
        const target = this.deps.manager.require(message.sessionId);
        if (target.cwd !== this.workspaceCwd()) {
          throw new Error("다른 프로젝트의 대화입니다 — 프로젝트를 전환한 뒤 시도해 주세요.");
        }
        return target.removeHeld(message.itemId);
      }

      case "session.queue.sendNow": {
        const target = this.deps.manager.require(message.sessionId);
        if (target.cwd !== this.workspaceCwd()) {
          throw new Error("다른 프로젝트의 대화입니다 — 프로젝트를 전환한 뒤 시도해 주세요.");
        }
        await target.sendHeldNow(message.itemId);
        return { ok: true };
      }

      // lost room 다루기 (PLAN D86 의 확장): these touch only the daemon's
      // own store — no clone is written — so they need no project fence, and
      // they work for a thread nobody has reopened since the restart.
      case "session.queue.takeDropped":
        return this.deps.queueStore.takeLost(message.sessionId, message.itemId);

      case "session.queue.dismissDropped": {
        this.deps.queueStore.dismissLost(message.sessionId, message.itemId);
        // The store changed under every window: re-announce the state.
        this.deps.broadcast({
          type: "session.event",
          sessionId: message.sessionId,
          event: { kind: "queue.lost", items: this.deps.queueStore.lostItems(message.sessionId) },
        });
        return { ok: true };
      }

      case "session.close": {
        const cwd = this.deps.manager.get(message.sessionId)?.cwd;
        await this.deps.manager.close(message.sessionId);
        this.touchThreadsCwd(cwd);
        return { ok: true };
      }

      case "session.delete": {
        const cwd = await this.resolveSessionCwd(message.sessionId);
        await this.deps.manager.remove(message.sessionId, cwd);
        // The thread is gone; its wait room, lost room and tape rows go with
        // it — 사람 메시지도 세션 소속이다 (hero-synthesis D1).
        this.deps.queueStore.clear(message.sessionId);
        const tape = this.deps.fleet.workspacesForCwd(cwd);
        if (tape) dropTape(tape.paths.root, message.sessionId);
        this.touchThreadsCwd(cwd);
        return { ok: true };
      }
      case "session.deleteAll": {
        // The tree's 대화 모두 지우기: unlike session.delete this names its
        // project, so a non-active clone's transcripts die too (D77's store
        // is keyed by the clone's realpath).
        const paths = this.deps.registry.paths(message.slug);
        const repoRoot = realpathBestEffort(paths.repoRoot);
        // The wait rooms, lost rooms and tape rows go with the threads —
        // collect the ids first; removeWhere closes live sessions and
        // sweeps every driver's store in one pass. The id set must cover
        // what the sweep deletes: manager.list 의 상한(그리고 그 캐시)을
        // 믿으면 상한 너머의 대화는 지워지면서 방과 테이프만 남는다 — 저장소마다
        // 사실상 전부(사이드바 상한의 2000배)를 읽어 모으고, 아직 대화록을
        // 쓰지 않은 라이브 세션은 따로 더한다.
        const ids = new Set<string>();
        for (const session of this.deps.manager.all()) {
          if (session.cwd === repoRoot) ids.add(session.id);
        }
        for (const driver of this.deps.agentDrivers.all()) {
          const stored = await driver.store?.list(repoRoot, 100_000).catch(() => []);
          for (const info of stored ?? []) ids.add(info.id);
        }
        await this.deps.manager.removeWhere(repoRoot);
        for (const sessionId of ids) {
          this.deps.queueStore.clear(sessionId);
          dropTape(paths.root, sessionId);
        }
        this.touchThreadsCwd(repoRoot);
        this.announceProjects();
        return { ok: true };
      }
      case "session.contextUsage": {
        const usage = await this.deps.manager.require(message.sessionId).contextUsage();
        this.deps.plans.rememberPlanUsage(usage?.plan ?? null);
        return usage;
      }

      case "repo.files": {
        // @-mention autocomplete draws from the repo clone only.
        const root = this.repo.root;
        const files = existsSync(root) ? await listFiles(root) : [];
        return browseFiles(files, message.query ?? "", message.limit ?? 40);
      }

      case "session.setMode":
        await this.deps.manager.require(message.sessionId).setPermissionMode(message.mode);
        return { ok: true };

      case "session.setModel":
        await this.deps.manager.require(message.sessionId).setModel(message.model);
        return { ok: true };

      case "session.setEffort":
        await this.deps.manager.require(message.sessionId).setEffort(message.effort);
        return { ok: true };

      case "session.setPermissionMode":
        await this.deps.manager.require(message.sessionId).setPermissionMode(message.mode);
        return { ok: true };

      case "session.setFastMode":
        await this.deps.manager.require(message.sessionId).setFastMode(message.fast);
        return { ok: true };

      case "session.selectors": {
        const session = this.deps.manager.require(message.sessionId);
        const selectors = await session.selectors();
        this.deps.plans.rememberModels(session.provider, selectors.models);
        return selectors;
      }
      case "session.commands":
        return await this.deps.manager.require(message.sessionId).commands();

      case "session.stopTask":
        await this.deps.manager.require(message.sessionId).stopTask(message.taskId);
        return { ok: true };

      case "session.backgroundTask": {
        const moved = await this.deps.manager
          .require(message.sessionId)
          .backgroundTask(message.toolUseId);
        return { moved };
      }

      case "cli.commands":
        return await this.cliCommands();

      case "permission.respond": {
        const session = this.deps.manager.findByRequest(message.requestId);
        if (!session)
          throw new Error("이미 끝난 권한 요청입니다 — 방금 뜬 카드에서 다시 답해 주세요.");
        // 계획 승인은 모드 복귀를 승인보다 먼저 맺는다 — ok 답신이 그 순서를
        // 지나가길 기다린다.
        await session.respondPermission(
          message.requestId,
          message.decision,
          message.message,
          message.updatedInput,
        );
        return { ok: true };
      }

      case "question.respond": {
        const session = this.deps.manager.findByRequest(message.requestId);
        if (!session) throw new Error("이미 끝난 질문입니다 — 방금 뜬 카드에서 다시 답해 주세요.");
        session.respondQuestion(
          message.requestId,
          message.answers,
          message.response,
          message.annotations,
        );
        return { ok: true };
      }

      case "project.list":
        return {
          projects: this.projectSummaries(),
          activeSlug: this.deps.registry.activeSlug(),
        };

      case "project.create":
        return await this.createProject(message);

      case "project.activate": {
        await this.activateProject(message.slug);
        return {
          projects: this.projectSummaries(),
          activeSlug: this.deps.registry.activeSlug(),
        };
      }

      case "project.update": {
        // Same guard as create — a moved url re-clones, so the wire's word
        // passes through the clone-url guard before the registry hears it.
        if (message.repoUrl != null) assertClonableRepoUrl(message.repoUrl);
        // The error card's 실행 허용: the registry remembers, the workspace is
        // told, and the bring-up it was waiting on runs to ready.
        if (message.approveCommands !== undefined) {
          this.deps.registry.update(message.slug, {
            commandsApproved: message.approveCommands,
          });
          const gate = this.workspacesFor(message.slug);
          gate.repo.setCommandsApproved(message.approveCommands);
          if (message.approveCommands) void gate.repo.sync().catch(() => undefined);
        }
        this.deps.registry.update(message.slug, {
          ...(message.name !== undefined ? { name: message.name } : {}),
          ...(message.repoUrl !== undefined ? { repoUrl: message.repoUrl } : {}),
          ...(message.baseBranch !== undefined ? { baseBranch: message.baseBranch } : {}),
          // 지침(P1#8): 다음 대화부터 적용된다 — 돌고 있는 세션의 시스템
          // 프롬프트를 중간에 바꾸지 않는다(SDK 의 스냅샷 계약).
          ...(message.instructions !== undefined ? { instructions: message.instructions } : {}),
        });
        // A url change is a repo change: the workspace re-points (and
        // re-clones when the url moved) through its own update path.
        const workspaces = this.workspacesFor(message.slug);
        if (message.repoUrl !== undefined) {
          await workspaces.repo.update({ url: message.repoUrl });
        }
        this.announceProjects();
        return {
          projects: this.projectSummaries(),
          activeSlug: this.deps.registry.activeSlug(),
        };
      }
      case "project.remove": {
        const paths = this.deps.registry.paths(message.slug);
        // Transcripts are keyed by the clone's realpath (see workspaceCwd) —
        // every lookup below must use that same spelling.
        const repoRoot = realpathBestEffort(paths.repoRoot);
        const workspaces = this.deps.fleet.workspaces.get(message.slug);
        if (workspaces) {
          // The clone's live threads die with it (D21): a session left
          // running would keep writing into a folder the planner just
          // disowned — or one `deleteFiles` is about to remove.
          await this.deps.manager.closeWhere(repoRoot);
          await workspaces.repo.stop();
          this.deps.fleet.workspaces.delete(message.slug);
        }
        this.deps.registry.remove(message.slug);
        // Files survive a forget: the clone holds screen work that was saved
        // but never merged, and nothing else on the machine has it.
        if (message.deleteFiles) {
          // The conversations go with the folder (PLAN D77): the transcript
          // store lives outside the project folder, keyed by this clone's
          // path — leaving it behind would orphan every thread and let a
          // same-named re-add resurrect them against an empty worktree.
          await this.deps.manager.removeWhere(repoRoot);
          rmSync(paths.root, { recursive: true, force: true });
        }
        const next = this.deps.registry.activeSlug();
        if (next) await this.activateProject(next);
        this.announceProjects();
        return { projects: this.projectSummaries(), activeSlug: next };
      }

      case "repo.status":
        return await this.repo.status();

      case "repo.sync":
        return await this.repo.sync(message.force === true);

      case "repo.refresh": {
        // 레포 최신화: the planner's pull of the developer's side, pressed
        // from the screen bar. Progress is `repo.status` as always; a
        // conflict briefs the named thread like a failing gate does. The
        // button's failures report — the planner pressed it, so the reason
        // lands as words on the screen instead of a silent no-op.
        const { onSessionTurn } = this.briefTo(message.sessionId, "refresh");
        // 사이클 브랜치에서 대화 없이 눌린 최신화는 병합을 하지 않는다(충돌의
        // 첫 과제는 AI 의 몫) — 대신 fetch 로 원격을 확인해 무엇이 기다리는
        // 지 버튼을 누른 사람에게 말한다.
        const behind = await this.repo.refreshNeedsThread();
        if (behind !== null && !message.sessionId)
          throw new Error(
            `개발자의 최신 변경 ${behind}건이 원격에 있습니다 — 대화를 하나 연 뒤 최신화를 누르면 지금 화면 위로 받아 옵니다.`,
          );
        // 받아올 게 없으면 pull 도 부르지 않는다 — 새 커밋 0건의 병합은
        // 아무도 모른 채 끝나는 일이고, 그것이 정직한 결과다.
        if (behind === 0) return await this.repo.status();
        const outcome = await this.repo.pull(onSessionTurn, { report: true });
        // 실사 결함: 최신화가 사이클 브랜치에 merge 커밋을 묵시적으로 쌓는
        // 사실을 아무도 말하지 않았다. 병합이 실제로 일어났으면 그 기록이
        // 대화에 남는다 — 충돌 브리프와 같은 자리, 같은 어휘로.
        if (behind !== null && behind > 0 && outcome === "clean" && message.sessionId) {
          // The record is news, not cargo: a thread that died mid-refresh
          // must not turn the report into an error reply.
          try {
            this.deps.manager.get(message.sessionId)?.send(
              markTurn(
                {
                  kind: "brief",
                  title: `원격의 최신 변경 ${behind}건을 받아 왔습니다`,
                  purpose: "refresh",
                },
                "개발자의 최신 변경을 이번 작업 브랜치에 병합했습니다 — 미리보기를 새로 고침하면 반영됩니다. 저장하면 이 병합이 함께 담깁니다.",
              ),
            );
          } catch {
            // The thread's query died; the merge itself is already done.
          }
        }
        return await this.repo.status();
      }

      case "onboarding.check":
        return await runOnboardingChecks({
          claudeExecutableOverride: this.deps.claudeExecutableOverride(),
          gitHubClient: () => this.deps.github.client(),
          provider: message.provider,
          driverFor: (id) => this.deps.agentDrivers.get(id),
        });

      case "onboarding.fix":
        switch (message.kind) {
          case "install-claude":
            return startClaudeInstall();
          case "login-claude":
            return startClaudeLogin();
          case "install-git":
            return gitInstallGuidance();
          case "install-pnpm":
            return await runPnpmInstall();
        }
        return { started: false, guidance: "알 수 없는 수정 요청입니다." };

      case "github.token.set":
        return await this.deps.github.setToken(message.token);

      case "github.repos.list":
        return await this.deps.github.listRepos(message.refresh === true);

      case "github.repo.inspect":
        return await this.deps.github.inspectRepo(message.owner, message.repo);

      case "diff.get":
        return await this.repo.diff();

      case "repo.save":
        return await this.repo.save({
          ...(message.message ? { message: message.message } : {}),
          // hero-synthesis D1: the calling conversation owns the saved card.
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          ...this.briefTo(message.sessionId, "save"),
        });

      case "repo.handoff": {
        const active = this.requireActive();
        // The captures come first, while the preview server is still the one
        // serving — the build gate inside the handoff may not leave it up.
        // 핀 주도 (브리지 폐지): 이 사이클에 사람이 핀으로 가리킨 화면·상태만이
        // "보낸 화면"이다 — 선언된 목록은 더 이상 없다.
        const commentsFile = join(active.paths.root, "comments.json");
        const targets = captureTargets(readComments(commentsFile), await active.repo.cycleAnchor());
        const shots = await this.deps.previewDrivers.captureHandoffShots(targets);
        return await active.repo.handoff({
          title: message.title ?? this.deps.registry.get(active.slug)?.name ?? undefined,
          body: message.body ?? DEFAULT_HANDOFF_BODY,
          ...(shots.length > 0 ? { shots } : {}),
          // D93: the comment store — the PR body's `### 수정 요청` section is
          // the daemon's to build.
          commentsFile,
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          ...this.briefTo(message.sessionId, "handoff"),
        });
      }

      case "repo.handoffStatus": {
        // refreshHandoff can land a finished cycle — fetch, checkout, reset —
        // so while a writer owns the worktree the answer is the poller's
        // passive read instead (pollOpenHandoffs' fence, 판정 1·2). A publish
        // in flight shows in diffStage; a pull in busyRefreshing.
        const workspaces = this.requireActive();
        if (
          workspaces.diffStage === "computing" ||
          workspaces.diffStage === "pushing" ||
          workspaces.diffStage === "handing-off" ||
          workspaces.repo.busyRefreshing
        ) {
          return await workspaces.repo.peekHandoff();
        }
        return await workspaces.repo.refreshHandoff();
      }

      // 보낸 화면 동결: the frozen stage asks for one
      // committed capture at a time — null is the "no shot" answer, not an
      // error, so the panel falls back to the live preview with the stamp.
      case "repo.handoffShot":
        return await this.repo.handoffShot(message.route, message.state);

      // 시점 빌드 재현: the frozen stage's 실제로
      // 열기 — the handoff branch's tip in a throwaway worktree, served on
      // a second port. Absence answers as a ready:false info, not an error,
      // so the stage falls back to the committed capture. The sessionId is
      // what ties the build's life to the conversation that asked for it.
      case "repo.handoffPreview":
        return await this.deps.handoffPreviews.open(message.sessionId ?? null);

      // 화면 캡처 (게이트 재배선): the planner's "이 화면" button — the
      // daemon borrows a preview driver, shoots, and the web attaches the
      // picture to the next turn. Desktop only; the browser dev path has
      // no window to shoot.
      case "preview.capture":
        return await this.deps.previewDrivers.capture(message.route, message.state);

      // 답하기 (PLAN D88): the planner's words to one developer comment —
      // the daemon picks the endpoint by the id's kind.
      // 되감기 (PLAN D95): files (the turn's checkpoint) go back first, then
      // the daemon forks the conversation's memory before that answer and
      // sends the words again. A refused fork falls back inside the manager.
      case "session.rewind": {
        const target = this.deps.manager.require(message.sessionId);
        if (target.cwd !== this.workspaceCwd()) {
          throw new Error("다른 프로젝트의 대화입니다 — 프로젝트를 전환한 뒤 시도해 주세요.");
        }
        const checkpoints = await this.repo.checkpoints();
        const entry = checkpoints.entries.find(
          (candidate) =>
            candidate.sessionId === message.sessionId && candidate.turn === message.turn,
        );
        // 체크포인트가 없는 턴은 되감을 수 없다: 파일이 먼저 돌아가고 기억이
        // 뒤따르는 약속인데, 파일 없이 기억만 자르면 워크트리는 그 턴 이후의
        // 것을 든 채 대화만 과거로 간다. 재시작 뒤 다시 센 번호나 정리된 ref
        // 로 엇갈린 요청은 거절이 정직한 답이다.
        if (!entry) {
          throw new Error("그 턴의 체크포인트를 찾지 못했습니다 — 아무것도 되돌리지 않았습니다.");
        }
        await this.repo.checkpointRestore(entry.id);
        const targetDriver = this.deps.agentDrivers.get(target.provider);
        // The fork's binary is the TARGET provider's — a codex thread must
        // not be handed the claude path just because the field used to be
        // named after it.
        const targetExecutable = targetDriver
          ? ((await targetDriver.isAvailable().catch(() => null))?.executable ?? null)
          : null;
        const result = await this.deps.manager.rewind({
          sessionId: message.sessionId,
          cwd: this.workspaceCwd(),
          turn: message.turn,
          text: message.text,
          images: message.images,
          base: {
            cwd: this.workspaceCwd(),
            provider: target.provider,
            queueDiskFor: this.deps.queueDiskFor,
            writePolicy: repoWritePolicy(this.workspaceCwd()),
            launch: {
              ...(targetExecutable ? { executable: targetExecutable } : {}),
            },
          },
        });
        this.deps.manager.invalidateThreads(target.cwd);
        undoLog().record({
          kind: "retry",
          slug: this.requireActive().slug,
          sessionId: message.sessionId,
          turn: message.turn,
        });
        this.refreshThreads();
        return result;
      }

      case "comments.reply": {
        const activeWs = this.requireActive();
        await activeWs.repo.replyToReview(message.reviewId, message.body);
        return { ok: true as const };
      }

      // --- 되돌리기와 넘기기 (PLAN D52 · D53) ------------------------------
      case "repo.handoffDraft": {
        const active = this.requireActive();
        const commentsFile = join(active.paths.root, "comments.json");
        // The dialog's shot count reads the same pin-driven targets the
        // handoff itself will capture — the preview never promises a number
        // the handoff then fails to deliver.
        const targets = captureTargets(readComments(commentsFile), await active.repo.cycleAnchor());
        return await active.repo.handoffDraft({
          commentsFile,
          shotCount: await this.deps.previewDrivers.handoffShotCount(targets),
        });
      }

      case "repo.history":
        return await this.repo.history();

      case "repo.restore": {
        const restored = await this.repo.restore(message.sha);
        undoLog().record({ kind: "save", slug: this.requireActive().slug });
        return restored;
      }

      case "repo.discard":
        return await this.repo.discard();

      // 잠깐 치워두기 · 꺼내기 (보관함 토론 2026-09-15): one slot per repo.
      // Refusals are one Korean sentence in the reply; a 꺼내기 conflict
      // rides the session wire like every gate failure does.
      case "repo.shelve":
        return await this.repo.shelve();

      case "repo.unshelve":
        return await this.repo.unshelve(this.briefTo(message.sessionId, "save").onSessionTurn);

      case "repo.checkpoints":
        return await this.repo.checkpoints();

      case "repo.checkpoint.restore": {
        const restored = await this.repo.checkpointRestore(message.checkpoint);
        // 체크포인트 id 는 `<sessionId>/<turn>` 그대로다 — 되돌린 턴의 번호를
        // 알아내려고 git 을 한 번 더 부를 이유가 없다.
        const [sessionId, turn] = message.checkpoint.split("/");
        undoLog().record({
          kind: "turn",
          slug: this.requireActive().slug,
          ...(sessionId ? { sessionId } : {}),
          ...(Number.isFinite(Number(turn)) ? { turn: Number(turn) } : {}),
        });
        return restored;
      }

      // --- 코멘트 저장소 (PLAN D57) ----------------------------------------
      // The pins belong to the ACTIVE project: the messages carry no slug,
      // exactly because the planner is looking at one project's preview.
      // Write-only from here: the store's reader is the pull request body.
      case "comments.record": {
        recordComments(join(this.requireActive().paths.root, "comments.json"), message.items);
        return { recorded: message.items.length };
      }
    }
  }

  /**
   * The thread a send must land in when its own query died (crash · a
   * force-aborted stop · a CLI that ended on its own): same id, fresh CLI,
   * the stored transcript resumed — the planner's words ride the
   * conversation they belong to, which is the promise the crash card made
   * ("다시내면 이어집니다"). The dead object is torn down FIRST, under
   * its own id, so its late `closed` broadcast cannot shadow the
   * replacement.
   */
  private async resurrectSession(dead: Session): Promise<Session> {
    await this.deps.manager.close(dead.id);
    const provider = dead.provider;
    const driver = this.deps.agentDrivers.get(provider);
    const availability = driver ? await driver.isAvailable().catch(() => null) : null;
    const executable = availability?.executable;
    if (!executable) {
      // 죽은 세션을 돌려주면 호출자의 send 가 "크래시" 에러로 오진된다 —
      // 진짜 이유는 CLI 가 없는 것. isAvailable 의 한국어 사유를 그대로 넘긴다.
      throw new Error(
        availability?.reason ?? `${provider} 를 찾지 못했습니다 — 설치한 뒤 다시 보내 주세요.`,
      );
    }
    const chosen = dead.chosen;
    const instructions = this.projectInstructions(dead.cwd);
    const session = this.deps.manager.create({
      cwd: dead.cwd,
      provider,
      queueDiskFor: this.deps.queueDiskFor,
      writePolicy: repoWritePolicy(dead.cwd),
      title: dead.title,
      launch: {
        ...(instructions ? { appendSystemPrompt: instructions } : {}),
        executable,
        resume: dead.id,
        ...(chosen.model ? { model: chosen.model } : {}),
        ...(chosen.effort ? { effort: chosen.effort } : {}),
      },
    });
    // The tree's child row points at the same id; a rescan picks the new life up.
    this.deps.manager.invalidateThreads(session.cwd);
    this.refreshThreads();
    return session;
  }

  /**
   * Routes a failing gate's output to a live session as a user turn — the same
   * path a typed message takes, so the agent sees the planner asking for a fix.
   * The failure itself is news the planner clicked for — the step never
   * reached the developer and the agent is now on the fix — so it also fires a
   * notice before the turn starts.
   *
   * 게이트 실패는 AI 의 과제다(README) — 열린 대화가 없어도 과제는 태어나야
   * 한다: 저장·넘기기는 도구가 대화를 열고 브리프를 내려놓는다(준비 턴
   * runConventionsPrepare 와 같은 길). 최신화 충돌만 예외다 — 대화가 없을 때의 그
   * 상태는 오류 카드가 자기 버튼(AI 에게 해결 요청)으로 대화를 고르는 자리다.
   */
  private briefTo(sessionId: string | undefined, stage: "save" | "handoff" | "refresh") {
    if (!sessionId && stage === "refresh") return { onSessionTurn: undefined };
    return {
      onSessionTurn: (brief: string) => {
        // A named thread whose query already died cannot take the brief — and
        // since the crash guard it would refuse the send. The gate thread is
        // the fallback either way: no open thread, or a dead one.
        const named = sessionId ? this.deps.manager.get(sessionId) : undefined;
        const session =
          named && named.state !== "error" && named.state !== "closed"
            ? named
            : this.gateThreadFor(stage);
        if (!session) return;
        this.deps.logger.warn("게이트 실패", { sessionId: session.id, stage });
        this.deps.notice({
          kind: "gate",
          sessionId: session.id,
          title: session.title,
          stage,
        });
        try {
          session.send(brief);
        } catch {
          // Lost the race with the query's death — the failed DiffStatus
          // still tells the planner why the step stopped.
        }
      },
    };
  }

  /**
   * The thread a failing gate briefs when none is (or none living one is)
   * open. One per run: a planner who presses 저장 twice with no thread open
   * must not grow a garden of failure threads. Reused while it lives in this
   * clone and its query is healthy; a dead one is replaced on the next brief.
   */
  private gateThreadFor(stage: "save" | "handoff" | "refresh") {
    const cwd = this.workspaceCwd();
    const remembered = this.gateThreadId ? this.deps.manager.get(this.gateThreadId) : undefined;
    if (
      remembered &&
      remembered.cwd === cwd &&
      remembered.state !== "error" &&
      remembered.state !== "closed"
    ) {
      return remembered;
    }
    const executable = this.deps.claudeExecutable();
    if (!executable) return null;
    const instructions = this.projectInstructions(cwd);
    const session = this.deps.manager.create({
      cwd,
      queueDiskFor: this.deps.queueDiskFor,
      writePolicy: repoWritePolicy(cwd),
      title:
        stage === "save"
          ? "저장 문제 해결"
          : stage === "handoff"
            ? "넘기기 문제 해결"
            : "최신화 문제 해결",
      launch: {
        executable,
        ...(instructions ? { appendSystemPrompt: instructions } : {}),
      },
    });
    this.gateThreadId = session.id;
    // The tree gains a child row (PLAN D59), same as any daemon-opened thread.
    this.deps.manager.invalidateThreads(cwd);
    this.refreshThreads();
    return session;
  }
}
