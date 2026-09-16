import type { HandoffShot } from "@colo-design/protocol";
import { type DaemonNotice, noticeForState } from "./notices.js";
import {
  createPreviewTools,
  type PreviewDriver,
  type PreviewDriverFactory,
  type PreviewScreenDeclaration,
  type PreviewTools,
} from "./preview-tools.js";
import type { RepoWorkspace } from "./repo.js";
import { type GateScreen, gateBrief, inspectScreens, type ScreenTrouble } from "./screen-gate.js";
import { NEW_SESSION_TITLE, type Session } from "./session.js";

/**
 * 넘기기의 캡처는 사람이 풀 리퀘스트에서 읽는다 (PLAN D56) — 모델의 토큰
 * 예산과 무관하므로 화면을 알아볼 만한 긴 변을 준다.
 */
const HANDOFF_SHOT_LONG_EDGE = 1200;
/** 캡처가 스스로 말한 형식 → 커밋될 파일의 확장자. */
const SHOT_EXTENSIONS: Record<string, string> = {
  "image/webp": ".webp",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

/**
 * 서버가 주는 것 — 드라이버 클러스터는 이 경계 너머를 모른다. 세션의 창이
 * 서버의 수명주기(닫기·프로젝트 전환·데몬 종료)에 맞춰 죽어야 하므로 조회는
 * 콜백으로 받고, 상태는 이 클래스가 소유한다.
 */
export interface PreviewDriverDeps {
  /** 데스크톱만 드라이버 공장을 주입한다 — 브라우저 개발 경로에는 창 자체가 없다. */
  factory(): PreviewDriverFactory | undefined;
  /** 활성 프로젝트의 레포 — 프리뷰 주소·클론 여부·repo 설정의 출처. */
  activeRepo(): RepoWorkspace | null;
  session(sessionId: string): Session | undefined;
  sessions(): Iterable<Session>;
  notice(notice: DaemonNotice): void;
}

/**
 * 세션별 프리뷰 드라이버의 수명과 화면 게이트 (PLAN D61, D56, D7).
 *
 * 서버에 남는 것은 연결부뿐이다: `session.create`가 도구를 물고, 상태 전환이
 * 게이트를 부르며, 닫힘이 창을 거둔다. 창의 소유권(어느 세션이 어느 드라이버를
 * 받았는가)과 게이트의 판정 상태(이 턴이 연 화면, 이미 건 세션)는 전부 여기다.
 */
export class PreviewDrivers {
  /** 세션이 받은 드라이버 — 세션·프로젝트·데몬의 죽음과 함께 간다. */
  private readonly bySession = new Map<string, PreviewDriver>();
  /**
   * The connected repo's declared screens (the `colo-design.screens`
   * envelope's cache, PLAN D7) — the list `screen_list` serves, filled by
   * `setScreens` and emptied by a project switch. Read on every call,
   * never snapshotted into the tools.
   */
  private declaredScreens: PreviewScreenDeclaration[] = [];
  /**
   * 이 턴이 연 화면들 (PLAN D61 게이트): `screen_open` 이 실제로 열어 낸
   * 주소만 모은다. 턴이 시작할 때 비워지므로 언제나 "방금 만진 화면"이다.
   * 키는 `route\nstate` — 같은 화면의 같은 상태를 두 번 열어도 한 번 본다.
   */
  readonly openedThisTurn = new Map<string, Map<string, GateScreen>>();
  /**
   * 이미 게이트가 한 번 말을 건 세션. 사용자가 다시 보내기 전까지는 다시
   * 걸지 않는다 — 게이트가 부른 턴이 또 게이트를 부르면 기계 둘이 서로
   * 답하며 구독을 태운다. 두 번째 문제는 사람의 다음 턴이 본다.
   */
  readonly gatedSessions = new Set<string>();

  constructor(private readonly deps: PreviewDriverDeps) {}

  /** 활성 레포가 선언한 화면 목록 — 핸드오프의 `screenTitles`가 읽는다. */
  get screens(): readonly PreviewScreenDeclaration[] {
    return this.declaredScreens;
  }

  /**
   * The connected repo said which screens it has (`colo-design.screens`,
   * PLAN D7). The host hands the envelope's contents here: the daemon has no
   * page of its own to hear it from, and without this `screen_list` answers
   * "아직 선언된 화면이 없습니다" for a repo that declared everything. Read
   * live by the tools, so a list that arrives mid-session counts.
   */
  setScreens(screens: PreviewScreenDeclaration[]): void {
    this.declaredScreens = screens;
  }

  /**
   * The screens are the OUTGOING repo's declarations (PLAN D7): keeping
   * them would have `screen_list` name routes the incoming app does not
   * serve. The new bridge announces itself and fills this again.
   */
  clearScreens(): void {
    this.declaredScreens = [];
  }

  /** The session's driver dies with the session (PLAN D61). */
  register(sessionId: string, driver: PreviewDriver): void {
    this.bySession.set(sessionId, driver);
  }

  /** `screen_open` 하나 — 이 턴의 목록에 담는다. */
  noteOpened(sessionId: string, route: string, state: string | null): void {
    const opened = this.openedThisTurn.get(sessionId) ?? new Map<string, GateScreen>();
    opened.set(`${route}\n${state ?? ""}`, { route, state });
    this.openedThisTurn.set(sessionId, opened);
  }

  /**
   * The session options' preview half: a `colo-preview` tool set bound to the
   * active project's preview url, when a driver is injected, the preview
   * server is up, and the planner has not turned the tools off. Everything
   * else — no desktop, no preview yet, `previewTools: false` — is a session
   * without them.
   */
  async toolsFor(
    enabled: boolean,
    onOpened?: (route: string, state: string | null) => void,
  ): Promise<{ tools: PreviewTools; driver: PreviewDriver } | null> {
    const factory = this.deps.factory();
    if (!factory || !enabled) return null;
    const repo = this.deps.activeRepo();
    if (!repo?.isCloned()) return null;
    const status = await repo.status().catch(() => null);
    if (!status?.previewUrl) return null;
    const driver = factory.for(status.previewUrl);
    const tools = createPreviewTools(driver, () => this.declaredScreens, onOpened);
    if (!tools) {
      // A driver that never got tools must not leave a window behind.
      await driver.destroy().catch(() => undefined);
      return null;
    }
    return { tools, driver };
  }

  /**
   * 게이트를 걸 수 있는 턴인가. 열어 본 화면이 없으면 볼 것이 없고, 드라이버가
   * 없는 브라우저 개발 경로에는 창 자체가 없으며, 이미 한 번 건 세션은
   * 사용자의 다음 보내기를 기다린다. 여기서 false 면 완료 알림은 평소대로
   * 그 자리에서 나간다.
   */
  gatePossible(sessionId: string): boolean {
    if (!this.deps.factory()) return false;
    if (this.gatedSessions.has(sessionId)) return false;
    return (this.openedThisTurn.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * 턴이 끝난 뒤 그 화면들을 기계가 다시 열어 본다 (screen-gate.ts). 문제가
   * 있으면 Claude 에게 게이트 턴으로 돌려보내고, 없으면 미뤄 둔 완료 알림을
   * 그제야 내보낸다 — 순서가 뒤집히면 사용자는 `작업이 끝났습니다` 를 읽은
   * 직후 다시 도는 대화를 보게 된다.
   *
   * 세션이 쓰던 창을 빌리지 않고 제 드라이버를 만든다: `open` 이 콘솔 기록을
   * 비우므로 여기서 읽는 줄이 정확히 그 화면의 것이 되고, Claude 가 다음 턴에
   * 들고 갈 ref 세대도 건드리지 않는다.
   */
  async runGate(sessionId: string, turnDurationMs?: number): Promise<void> {
    const screens = [...(this.openedThisTurn.get(sessionId)?.values() ?? [])];
    this.openedThisTurn.delete(sessionId);
    const session = this.deps.session(sessionId);
    const done = (): void => {
      const notice = noticeForState(
        sessionId,
        "idle",
        session?.title ?? NEW_SESSION_TITLE,
        turnDurationMs,
      );
      if (notice) this.deps.notice(notice);
    };
    const factory = this.deps.factory();
    if (!factory || !session || screens.length === 0) return done();
    const status = await this.deps
      .activeRepo()
      ?.status()
      .catch(() => null);
    if (!status?.previewUrl) return done();
    const driver = factory.for(status.previewUrl);
    let troubles: ScreenTrouble[] = [];
    try {
      troubles = await inspectScreens(driver, screens);
    } catch {
      // 게이트가 깨지는 것은 턴의 실패가 아니다 — 확인을 못 했을 뿐이다.
      troubles = [];
    } finally {
      await driver.destroy().catch(() => undefined);
    }
    // 사용자가 그 사이 다시 보냈으면 이 판정은 낡았다 — 도는 턴에 끼어들지 않는다.
    if (troubles.length === 0 || this.deps.session(sessionId)?.state !== "idle") return done();
    this.gatedSessions.add(sessionId);
    this.deps.notice({
      kind: "gate",
      sessionId,
      title: session.title,
      stage: "screen",
    });
    try {
      session.send(gateBrief(troubles));
    } catch {
      // 질의가 방금 죽었다 — 완료로 닫는 편이 아무 말도 없는 것보다 낫다.
      done();
    }
  }

  /** The session's driver dies with the session (PLAN D61). */
  destroy(sessionId: string): void {
    const driver = this.bySession.get(sessionId);
    if (!driver) return;
    this.bySession.delete(sessionId);
    void driver.destroy().catch(() => undefined);
  }

  /**
   * Every driver rooted at a clone dies when that clone's preview does — the
   * switch fence or the warm cap stopped the server, and the sessions left
   * behind would otherwise point their windows at a dead port.
   */
  destroyWhere(cwd: string): void {
    for (const session of this.deps.sessions()) {
      if (session.cwd === cwd) this.destroy(session.id);
    }
  }

  /**
   * How many captures a 넘기기 would attach — the preview's `### 화면 미리보기`
   * line. Same gates as captureHandoffShots, count only: a screen with no
   * declared states still ships its default look.
   */
  async handoffShotCount(): Promise<number> {
    const factory = this.deps.factory();
    const repo = this.deps.activeRepo();
    if (!factory || !repo?.isCloned()) return 0;
    if (repo.repoConfig()?.shots === false) return 0;
    const status = await repo.status().catch(() => null);
    if (!status?.previewUrl || this.declaredScreens.length === 0) return 0;
    return this.declaredScreens.reduce(
      (total, screen) => total + Math.max(screen.states.length, 1),
      0,
    );
  }

  /**
   * 넘기기의 화면 캡처 (PLAN D56): each declared screen·state, opened in the
   * preview driver and captured. Desktop only — the browser dev path has no
   * driver — and every failure is quiet: a capture that will not come back
   * simply is not in the set, and an empty set means the pull request body
   * carries no `### 화면 미리보기` section at all.
   */
  async captureHandoffShots(): Promise<HandoffShot[]> {
    const factory = this.deps.factory();
    const repo = this.deps.activeRepo();
    if (!factory || !repo?.isCloned()) return [];
    // The repo's refusal is also read at commit time (repo.ts); checking here
    // spares the window the drive through every screen.
    if (repo.repoConfig()?.shots === false) return [];
    const status = await repo.status().catch(() => null);
    if (!status?.previewUrl || this.declaredScreens.length === 0) return [];
    const driver = factory.for(status.previewUrl);
    const shots: HandoffShot[] = [];
    try {
      for (const screen of this.declaredScreens) {
        // A screen that declares no states still has its default look.
        const states = screen.states.length > 0 ? screen.states : ["default"];
        for (const state of states) {
          try {
            const opened = await driver.open(screen.route, state);
            // A screen that would not come up has no picture to take.
            if (!opened.ok) continue;
            // A handoff picture is read by a person in a pull request, not by
            // a model — it gets the detailed long edge, and its real
            // extension so the committed file is named after what it holds.
            const capture = await driver.screenshot({ longEdge: HANDOFF_SHOT_LONG_EDGE });
            shots.push({
              route: screen.route,
              state,
              image: Buffer.from(capture.data, "base64"),
              extension: SHOT_EXTENSIONS[capture.mediaType] ?? ".bin",
            });
          } catch {
            // One screen failing must not sink the rest of the set.
          }
        }
      }
    } finally {
      await driver.destroy().catch(() => undefined);
    }
    return shots;
  }
}
