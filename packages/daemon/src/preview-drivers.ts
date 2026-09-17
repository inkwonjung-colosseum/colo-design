import type { HandoffShot } from "@colo-design/protocol";
import { type DaemonNotice, noticeForState } from "./notices.js";
import type {
  PreviewCapture,
  PreviewDriverFactory,
} from "./preview-driver.js";
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
 * 세션별 화면 게이트의 상태와 캡처 (게이트 재배선 2026-09-17, PLAN D56 · D7).
 *
 * 에이전트는 더 이상 화면 도구를 갖지 않는다 — 사람이 pin 과 화면 캡처로
 * 가리킨 화면이 게이트의 입력이다 (`notePinned`). 서버에 남는 것은 그 판정
 * 상태와, 넘기기·캡처를 위한 드라이버 대여다. 창의 소유권은 쓰는 곳에
 * 있다: 게이트와 캡처는 제 창을 세웠다가 닫는다.
 */
export class PreviewDrivers {
  /**
   * 이 턴이 가리킨 화면들 (게이트 재배선): 사람이 pin·화면 캡처로 보낸
   * 주소만 모은다. 턴이 시작할 때 비워지므로 언제나 "방금 가리킨 화면"이다.
   * 키는 `route\nstate` - 같은 화면의 같은 상태를 두 번 가리켜도 한 번 본다.
   */
  readonly pinnedThisTurn = new Map<string, Map<string, GateScreen>>();
  /**
   * 이미 게이트가 한 번 말을 건 세션. 사용자가 다시 보내기 전까지는 다시
   * 걸지 않는다 - 게이트가 부른 턴이 또 게이트를 부르면 기계 둘이 서로
   * 답하며 구독을 태운다. 두 번째 문제는 사람의 다음 턴이 본다.
   */
  readonly gatedSessions = new Set<string>();

  constructor(private readonly deps: PreviewDriverDeps) {}

  /** pin·캡처 하나 — 이 턴의 목록에 담는다. preview origin 밖의 주소는
   *  게이트가 재검증할 대상이 아니므로 runGate 에서 걸러진다. */
  notePinned(sessionId: string, route: string, state: string | null): void {
    const pinned = this.pinnedThisTurn.get(sessionId) ?? new Map<string, GateScreen>();
    pinned.set(`${route}\n${state ?? ""}`, { route, state });
    this.pinnedThisTurn.set(sessionId, pinned);
  }

  /**
   * 게이트를 걸 수 있는 턴인가. 가리킨 화면이 없으면 볼 것이 없고, 드라이버가
   * 없는 브라우저 개발 경로에는 창 자체가 없으며, 이미 한 번 건 세션은
   * 사용자의 다음 보내기를 기다린다. 여기서 false 면 완료 알림은 평소대로
   * 그 자리에서 나간다.
   */
  gatePossible(sessionId: string): boolean {
    if (!this.deps.factory()) return false;
    if (this.gatedSessions.has(sessionId)) return false;
    return (this.pinnedThisTurn.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * 턴이 끝난 뒤 그 화면들을 기계가 다시 열어 본다 (screen-gate.ts). 문제가
   * 있으면 AI 에게 게이트 턴으로 돌려보내고, 없으면 미뤄 둔 완료 알림을
   * 그제야보낸다 — 순서가 뒤집히면 사용자는 `작업이 끝났습니다` 를 읽은
   * 직후 다시 도는 대화를 보게 된다.
   *
   * 게이트는 제 드라이버를 만든다: `open` 이 콘솔 기록을 비우므로 여기서
   * 읽는 줄이 정확히 그 화면의 것이 되고, 사용자가 보고 있는 창도
   * 건드리지 않는다.
   */
  async runGate(sessionId: string, turnDurationMs?: number): Promise<void> {
    const screens = [...(this.pinnedThisTurn.get(sessionId)?.values() ?? [])];
    this.pinnedThisTurn.delete(sessionId);
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
    // preview origin 밖의 주소는 게이트가 재검증할 대상이 아니다 — 허용된
    // 추가 origin 은 레포의 다른 서버이지, 게이트가 다시 열 화면이 아니다.
    const origin = new URL(status.previewUrl).origin;
    const kept = screens.filter((screen) => {
      try {
        return new URL(screen.route, origin).origin === origin;
      } catch {
        return false;
      }
    });
    if (kept.length === 0) return done();
    const origins = this.deps.activeRepo()?.repoConfig()?.preview.origins ?? [];
    const driver = factory.forIsolated(status.previewUrl, origins);
    let troubles: ScreenTrouble[] = [];
    try {
      troubles = await inspectScreens(driver, kept);
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

  /**
   * 화면 캡처 (preview.capture): the planner's "이 화면" 버튼. `route` 가
   * 오면 그 화면을 먼저 연다 — pane 이 떠 있으면 그 창이, 아니면 숨은 창이
   * 그린다. 창은 쓰고 나면 닫는다(pane 은 디버거만 뗀다 — 페이지는 사용자의
   * 것). 브라우저 개발 경로에는 창 자체가 없으므로 거절한다.
   */
  async capture(
    route?: string,
    state?: string | null,
  ): Promise<PreviewCapture & { route: string | null; state: string | null }> {
    const factory = this.deps.factory();
    const repo = this.deps.activeRepo();
    if (!factory || !repo?.isCloned()) {
      throw new Error("화면 캡처는 데스크톱 앱에서만 동작합니다.");
    }
    const status = await repo.status().catch(() => null);
    if (!status?.previewUrl) {
      throw new Error("미리보기 서버가 아직 뜨지 않았습니다 — 잠시 후 다시 시도해 주세요.");
    }
    const origins = repo.repoConfig()?.preview.origins ?? [];
    const driver = factory.for(status.previewUrl, origins);
    try {
      if (route) {
        const opened = await driver.open(route, state ?? null);
        if (!opened.ok) throw new Error(`화면을 열지 못했습니다: ${opened.reason}`);
      }
      const shot = await driver.screenshot({ longEdge: 900 });
      return { ...shot, route: route ?? null, state: state ?? null };
    } finally {
      await driver.destroy().catch(() => undefined);
    }
  }

  /**
   * How many captures a 넘기기 would attach — the preview's `### 화면 미리보기`
   * line. Same gates as captureHandoffShots, count only.
   */
  async handoffShotCount(targets: Array<{ route: string; state: string }>): Promise<number> {
    const factory = this.deps.factory();
    const repo = this.deps.activeRepo();
    if (!factory || !repo?.isCloned()) return 0;
    if (repo.repoConfig()?.shots === false) return 0;
    const status = await repo.status().catch(() => null);
    if (!status?.previewUrl || targets.length === 0) return 0;
    return targets.length;
  }

  /**
   * 넘기기의 화면 캡처 (PLAN D56 · 브리지 폐지): the screen·state pairs the
   * planner's own pins named this cycle (`captureTargets`), each opened in
   * the preview driver and captured. Desktop only — the browser dev path has
   * no driver — and every failure is quiet: a capture that will not come
   * back simply is not in the set, and an empty set means the pull request
   * body carries no `### 화면 미리보기` section at all.
   */
  async captureHandoffShots(
    targets: Array<{ route: string; state: string }>,
  ): Promise<HandoffShot[]> {
    const factory = this.deps.factory();
    const repo = this.deps.activeRepo();
    if (!factory || !repo?.isCloned()) return [];
    // The repo's refusal is also read at commit time (repo.ts); checking here
    // spares the window the drive through every screen.
    if (repo.repoConfig()?.shots === false) return [];
    const status = await repo.status().catch(() => null);
    if (!status?.previewUrl || targets.length === 0) return [];
    const driver = factory.forIsolated(status.previewUrl, repo.repoConfig()?.preview.origins ?? []);
    const shots: HandoffShot[] = [];
    try {
      for (const target of targets) {
        try {
          const opened = await driver.open(target.route, target.state);
          // A screen that would not come up has no picture to take.
          if (!opened.ok) continue;
          // A handoff picture is read by a person in a pull request, not by
          // a model — it gets the detailed long edge, and its real
          // extension so the committed file is named after what it holds.
          const capture = await driver.screenshot({ longEdge: HANDOFF_SHOT_LONG_EDGE });
          shots.push({
            route: target.route,
            state: target.state,
            image: Buffer.from(capture.data, "base64"),
            extension: SHOT_EXTENSIONS[capture.mediaType] ?? ".bin",
          });
        } catch {
          // One screen failing must not sink the rest of the set.
        }
      }
    } finally {
      await driver.destroy().catch(() => undefined);
    }
    return shots;
  }
}
