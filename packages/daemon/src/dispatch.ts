import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type ClientMessage,
  DEFAULT_HANDOFF_BODY,
  markTurn,
  type ServerMessage,
} from "@colo-design/protocol";
import { REFRESH_BRIEF, REFRESH_TITLE } from "./bootstrap-brief.js";
import { recordComments } from "./comments.js";
import { browseFiles, listFiles } from "./environment.js";
import type { GitHubBridge } from "./github-bridge.js";
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
import { undoLog } from "./undo-log.js";
import { repoWritePolicy } from "./workspaces.js";

/**
 * 서버가 라우터에 넘기는 것 — 프로토콜의 모든 요청이 거치는 좁은 문. 협력자는
 * 참조로, 실행 중 바뀌는 값은 콜백으로, 바깥에도 쓰이는 상태맵은 공유로.
 */
export interface RouterDeps {
  manager: SessionManager;
  fleet: ProjectFleet;
  drivers: PreviewDrivers;
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

  private announceProjectsThrottled(): void {
    this.deps.fleet.announceProjectsThrottled();
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
        const events0 = await this.deps.manager.history(
          message.sessionId,
          await this.resolveSessionCwd(message.sessionId),
        );
        // 대기 줄과 lost room 은 기록이 아니라 지금의 상태 (PLAN D86 의
        // 확장): a window opened — or reloaded — must see both above the
        // field, so they ride at the tail of the replay. The tail is
        // AUTHORITATIVE, empty rooms included — a window that kept rows the
        // daemon no longer holds must lose them here, not keep the ghosts.
        const events = [
          ...events0,
          { kind: "queued", items: this.deps.manager.get(message.sessionId)?.heldItems() ?? [] },
        ];
        const lost = this.deps.queueStore.lostItems(message.sessionId);
        return lost.length > 0 ? [...events, { kind: "queue.lost", items: lost }] : events;
      }

      case "session.create": {
        const executable = this.deps.claudeExecutable();
        if (!executable) {
          throw new Error(
            "Claude Code CLI 를 찾지 못했습니다 — 설치를 마친 뒤 다시 시도해 주세요.",
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
          this.deps.drivers.destroy(dead.id);
          await this.deps.manager.close(dead.id);
        }
        // The preview tools ride the session when a driver is injected and
        // the active preview is up (PLAN D61); `previewTools: false` opts
        // out. The driver is remembered under the session's own id so the
        // lifecycle hooks above can destroy it. D91: the session id only
        // exists after `create`, so the opened-report goes through a sink
        // the code below points at the fresh id.
        const openSink: {
          current: ((route: string, state: string | null) => void) | null;
        } = {
          current: null,
        };
        const preview = await this.deps.drivers.toolsFor(
          message.previewTools !== false,
          (route, state) => openSink.current?.(route, state),
        );
        const sessionCwd = this.workspaceCwd();
        const instructions = this.projectInstructions(sessionCwd);
        const session = this.deps.manager.create({
          cwd: sessionCwd,
          claudeExecutable: executable,
          queueDiskFor: this.deps.queueDiskFor,
          ...(instructions ? { appendSystemPrompt: instructions } : {}),
          writePolicy: repoWritePolicy(sessionCwd),
          ...(message.title ? { title: message.title } : {}),
          ...(message.resume ? { resume: message.resume } : {}),
          ...(message.model ? { model: message.model } : {}),
          ...(message.effort ? { effort: message.effort } : {}),
          ...(preview ? { previewTools: preview.tools } : {}),
        });
        if (preview) {
          this.deps.drivers.register(session.id, preview.driver);
          openSink.current = (route, state) => {
            this.deps.drivers.noteOpened(session.id, route, state);
            this.deps.broadcast({
              type: "session.event",
              sessionId: session.id,
              event: { kind: "preview.opened", route, state },
            });
          };
        }
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
        this.deps.drivers.gatedSessions.delete(message.sessionId);
        // 화면 턴의 시작점 (PLAN D52) is the delivery (the echo, see the
        // manager's onEvent); this only seeds the count, before anything can
        // be handed over — so the transcript is read while it still holds
        // exactly the prompts that came before this one.
        if (this.deps.checkpointTurns.get(message.sessionId) === undefined) {
          // 재시작 뒤 첫 턴: 카운터는 프로세스와 함께 사라지지만 대화록은
          // 남는다. 되감기의 k 번째 프롬프트는 대화록 기준이므로 이미 있는
          // 프롬프트 수부터 이어 셀 수밖에 없다 — 1부터 다시 세면 첫 되감기가
          // 전체 기억을 버리고, 두 번째는 남의 턴을 자른 채 memoryKept 를
          // 보고하던 것.
          this.deps.checkpointTurns.set(
            message.sessionId,
            await this.deps.manager.promptCount(message.sessionId, target.cwd),
          );
        }
        // 죽은 질의에 말을 흘리지 않는다: 크래시 카드가 약속한대로, 같은 id 의
        // 재개(resume)가 새 CLI 에서 대화를 이어받아 지금의 말을 전달한다.
        // Refusals answer through the dispatch-wide Korean boundary above.
        const carrier = target.sendable ? target : await this.resurrectSession(target);
        carrier.send(message.text, message.images);
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
        // The thread is gone; its wait room and lost room go with it.
        this.deps.queueStore.clear(message.sessionId);
        this.touchThreadsCwd(cwd);
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
        const selectors = await this.deps.manager.require(message.sessionId).selectors();
        this.deps.plans.rememberModels(selectors.models);
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
      case "project.refreshConventions": {
        // 관례 최신화(커미티 2026-09-14): 재주입이 아니라 제안이다 — 쓰는
        // 주체는 앱이 아니라 세션이고, 바뀐 파일은 저장 → 넘기기 파이프라인을
        // 타 개발자의 PR 리뷰로 확정된다. 이 대화는 그 첫 턴일 뿐이다.
        const executable = this.deps.claudeExecutable();
        if (!executable) {
          throw new Error(
            "Claude Code CLI 를 찾지 못했습니다 — 설치를 마친 뒤 다시 시도해 주세요.",
          );
        }
        const workspaces = this.deps.fleet.workspaces.get(message.slug);
        if (!workspaces?.repo.isCloned()) {
          throw new Error("아직 내려받지 않은 프로젝트입니다 — 연결이 끝난 뒤 다시 시도해 주세요.");
        }
        const cwd = realpathBestEffort(this.deps.registry.paths(message.slug).repoRoot);
        const instructions = this.projectInstructions(cwd);
        const session = this.deps.manager.create({
          cwd,
          claudeExecutable: executable,
          queueDiskFor: this.deps.queueDiskFor,
          ...(instructions ? { appendSystemPrompt: instructions } : {}),
          writePolicy: repoWritePolicy(cwd),
          title: REFRESH_TITLE,
        });
        session.send(
          markTurn({ kind: "brief", title: REFRESH_TITLE, purpose: "conventions" }, REFRESH_BRIEF),
        );
        // The tree gains a child row (PLAN D59), same as any daemon-opened thread.
        this.deps.manager.invalidateThreads(cwd);
        this.refreshThreads();
        this.announceProjectsThrottled();
        return { sessionId: session.id };
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
        // 첫 과제는 Claude 의 몫) — 대신 fetch 로 원격을 확인해 무엇이 기다리는
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

      case "repo.update":
        if (message.url) assertClonableRepoUrl(message.url);
        return await this.repo.update({
          ...(message.url !== undefined ? { url: message.url } : {}),
        });

      case "onboarding.check":
        return await runOnboardingChecks({
          claudeExecutableOverride: this.deps.claudeExecutableOverride(),
          gitHubClient: () => this.deps.github.client(),
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
          ...this.briefTo(message.sessionId, "save"),
        });

      case "repo.handoff": {
        const active = this.requireActive();
        // The captures come first, while the preview server is still the one
        // serving — the build gate inside the handoff may not leave it up.
        const shots = await this.deps.drivers.captureHandoffShots();
        return await active.repo.handoff({
          title: message.title ?? this.deps.registry.get(active.slug)?.name ?? undefined,
          body: message.body ?? DEFAULT_HANDOFF_BODY,
          ...(shots.length > 0 ? { shots } : {}),
          // D93: the comment store and the declared titles — the PR body's
          // ### 수정 요청 section is the daemon's to build.
          commentsFile: join(active.paths.root, "comments.json"),
          screenTitles: this.deps.drivers.screens.map((screen) => ({
            route: screen.route,
            title: screen.title,
          })),
          ...this.briefTo(message.sessionId, "handoff"),
        });
      }

      case "repo.handoffStatus":
        return await this.repo.refreshHandoff();

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
        if (entry) await this.repo.checkpointRestore(entry.id);
        const openSink: {
          current: ((route: string, state: string | null) => void) | null;
        } = {
          current: null,
        };
        const preview = await this.deps.drivers.toolsFor(true, (route, state) =>
          openSink.current?.(route, state),
        );
        const result = await this.deps.manager.rewind({
          sessionId: message.sessionId,
          cwd: this.workspaceCwd(),
          turn: message.turn,
          text: message.text,
          images: message.images,
          base: {
            cwd: this.workspaceCwd(),
            claudeExecutable: this.deps.claudeExecutable() ?? "",
            queueDiskFor: this.deps.queueDiskFor,
            writePolicy: repoWritePolicy(this.workspaceCwd()),
            ...(preview ? { previewTools: preview.tools } : {}),
          },
        });
        if (preview) {
          this.deps.drivers.register(result.sessionId, preview.driver);
          openSink.current = (route, state) => {
            this.deps.drivers.noteOpened(result.sessionId, route, state);
            this.deps.broadcast({
              type: "session.event",
              sessionId: result.sessionId,
              event: { kind: "preview.opened", route, state },
            });
          };
        }
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

      // --- 되돌리기와 요약 (PLAN D51 · D52 · D53) --------------------------
      case "repo.summarize":
        // The declared screens ride along so the summary can say 회원 목록
        // instead of a folder name — the same list 넘기기's body uses.
        return await this.repo.summarize(
          this.deps.drivers.screens.map((screen) => ({ route: screen.route, title: screen.title })),
        );

      case "repo.handoffDraft": {
        const active = this.requireActive();
        return await active.repo.handoffDraft({
          commentsFile: join(active.paths.root, "comments.json"),
          screenTitles: this.deps.drivers.screens.map((screen) => ({
            route: screen.route,
            title: screen.title,
          })),
          shotCount: await this.deps.drivers.handoffShotCount(),
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
   * ("다시 보내면 이어집니다"). The dead object is torn down FIRST, under
   * its own id, so its late `closed` broadcast cannot take the
   * replacement's preview driver with it.
   */
  private async resurrectSession(dead: Session): Promise<Session> {
    this.deps.drivers.destroy(dead.id);
    await this.deps.manager.close(dead.id);
    const executable = this.deps.claudeExecutable();
    if (!executable) return dead;
    const chosen = dead.chosen;
    const openSink: {
      current: ((route: string, state: string | null) => void) | null;
    } = {
      current: null,
    };
    const preview = await this.deps.drivers.toolsFor(true, (route, state) =>
      openSink.current?.(route, state),
    );
    const instructions = this.projectInstructions(dead.cwd);
    const session = this.deps.manager.create({
      cwd: dead.cwd,
      claudeExecutable: executable,
      queueDiskFor: this.deps.queueDiskFor,
      ...(instructions ? { appendSystemPrompt: instructions } : {}),
      writePolicy: repoWritePolicy(dead.cwd),
      resume: dead.id,
      title: dead.title,
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(chosen.effort ? { effort: chosen.effort } : {}),
      ...(preview ? { previewTools: preview.tools } : {}),
    });
    if (preview) {
      this.deps.drivers.register(session.id, preview.driver);
      openSink.current = (route, state) => {
        this.deps.drivers.noteOpened(session.id, route, state);
        this.deps.broadcast({
          type: "session.event",
          sessionId: session.id,
          event: { kind: "preview.opened", route, state },
        });
      };
    }
    // The tree's child row points at the same id; a rescan picks the new life up.
    this.deps.manager.invalidateThreads(session.cwd);
    this.refreshThreads();
    return session;
  }

  /**
   * Routes a failing gate's output to a live session as a user turn — the same
   * path a typed message takes, so Claude sees the planner asking for a fix.
   * The failure itself is news the planner clicked for — the step never
   * reached the developer and Claude is now on the fix — so it also fires a
   * notice before the turn starts.
   *
   * 게이트 실패는 Claude 의 과제다(README) — 열린 대화가 없어도 과제는 태어나야
   * 한다: 저장·넘기기는 도구가 대화를 열고 브리프를 내려놓는다(준비 턴
   * runBootstrapPrepare 와 같은 길). 최신화 충돌만 예외다 — 대화가 없을 때의 그
   * 상태는 오류 카드가 자기 버튼(Claude 에게 해결 요청)으로 대화를 고르는 자리다.
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
      claudeExecutable: executable,
      queueDiskFor: this.deps.queueDiskFor,
      ...(instructions ? { appendSystemPrompt: instructions } : {}),
      writePolicy: repoWritePolicy(cwd),
      title:
        stage === "save"
          ? "저장 문제 해결"
          : stage === "handoff"
            ? "넘기기 문제 해결"
            : "최신화 문제 해결",
    });
    this.gateThreadId = session.id;
    // The tree gains a child row (PLAN D59), same as any daemon-opened thread.
    this.deps.manager.invalidateThreads(cwd);
    this.refreshThreads();
    return session;
  }
}
