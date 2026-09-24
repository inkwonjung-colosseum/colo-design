import type { HandoffShot, ScreenCheckReport } from "@colo-design/protocol";
import { type DaemonNotice, noticeForState } from "./notices.js";
import type { PreviewDriverFactory } from "./preview-driver.js";
import type { RepoWorkspace } from "./repo.js";
import {
  type GateScreen,
  gateBrief,
  inspectScreens,
  MAX_LINES_PER_SCREEN,
  type ScreenTrouble,
  TROUBLE_LEVELS,
} from "./screen-gate.js";
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
  /** 활성 프로젝트의 레포 — 캡처 등 화면의 현재 주인을 묻는 경로의 출처. */
  activeRepo(): RepoWorkspace | null;
  /**
   * 세션이 사는 프로젝트의 레포 — 게이트의 재검증은 이 기준이다. 활성
   * 레포와 다른 프로젝트의 세션이 턴을 마쳤을 때 activeRepo 의 주소로
   * 판정하면 상대 route 핀이 전혀 다른 앱의 화면으로 재해석된다(실사
   * 결함). 없으면(구현체가 알려주지 않으면) 활성 레포로 물러난다.
   */
  repoForSession?(sessionId: string): RepoWorkspace | null;
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
   * 키는 route — 같은 화면을 두 번 가리켜도 한 번 본다. (2026-09-21 상태
   * 축 철거로 주소가 전부다.)
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
  notePinned(sessionId: string, route: string): void {
    const pinned = this.pinnedThisTurn.get(sessionId) ?? new Map<string, GateScreen>();
    pinned.set(route, { route });
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
    const done = (detail?: string): void => {
      // 대기 줄이 곧(또는 이미) 새 턴을 열었다면 이 완료 알림은 허위다 — 도는
      // 턴이 있는데 `작업이 끝났습니다` 가 나간다(턴 끝의 idle 방출과 release
      // 순서가 만드는 창). 새 턴의 끝이 제 알림을 내므로 여기서는 잠든다.
      if (this.deps.session(sessionId)?.state !== "idle") return;
      const notice = noticeForState(
        sessionId,
        "idle",
        session?.title ?? NEW_SESSION_TITLE,
        turnDurationMs,
      );
      if (notice)
        this.deps.notice(detail && notice.kind === "done" ? { ...notice, detail } : notice);
    };
    const factory = this.deps.factory();
    if (!factory || !session || screens.length === 0) return done();
    // 게이트는 이 세션이 사는 프로젝트를 기준으로 판정한다 — 활성 프로젝트가
    // 아니라. 턴 도중 프로젝트를 전환한 뒤 끝난 턴의 핀을 활성 레포의 주소로
    // 다시 열면 전혀 다른 앱의 콘솔이 이 세션의 판정이 된다.
    const repo = this.deps.repoForSession?.(sessionId) ?? this.deps.activeRepo();
    const status = await repo?.status().catch(() => null);
    if (!status?.previewUrl) return done();
    // preview origin 밖의 주소는 게이트가 재검증할 대상이 아니다 — 허용된
    // 추가 origin 은 레포의 다른 서버이지, 게이트가 다시 열 화면이 아니다.
    const origin = new URL(status.previewUrl).origin;
    const kept: GateScreen[] = [];
    const seen = new Set<string>();
    for (const screen of screens) {
      try {
        const u = new URL(screen.route, origin);
        if (u.origin !== origin) continue;
        // 사람의 pin 은 경로로, 에이전트의 navigate·openTab 은 전체 주소로
        // 온다 — 같은 화면을 두 번 열지 않게 경로로 정규화해 중복을 접는다.
        const route = u.pathname + u.search + u.hash;
        if (seen.has(route)) continue;
        seen.add(route);
        kept.push({ route });
      } catch {
        // 못 읽는 주소는 게이트 입력이 아니다.
      }
    }
    if (kept.length === 0) return done();
    const driver = factory.forIsolated(status.previewUrl);
    let troubles: ScreenTrouble[] = [];
    /** 게이트 스스로 깨진 것 — 판정이 아니라 확인 불능이다. */
    let broken = false;
    try {
      troubles = await inspectScreens(driver, kept);
    } catch {
      // 게이트가 깨지는 것은 턴의 실패가 아니다 — 확인을 못 했을 뿐이다. 그러나
      // 못했다는 사실까지 삼키면 확인 못 한 턴과 통과한 턴이 같은 침묵이 된다.
      broken = true;
    } finally {
      await driver.destroy().catch(() => undefined);
    }
    if (broken) {
      return done("화면 확인을 실행하지 못했습니다 — 다음 말에 핀을 다시 찍어 확인해 주세요.");
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
   * 패인이 쥔 오류 하나의 판정 (`preview.screenCheck`): 게이트와 같은 드라이버·
   * 같은 기준으로 그 화면 하나만 검증 창에서 다시 열어 본다 — 패인이 보고한
   * 오류가 지금도 살아 있는지, AI 의 수정이 이미 지나갔는지를 가리는 길이다.
   * 패인은 활성 프로젝트의 미리보기를 띄우므로 게이트의 세션 기준
   * (repoForSession) 없이 활성 레포가 곧 출처다. 확인 자체를 못 했으면
   * (드라이버가 없거나 화면을 열지 못했거나) null — 판정이 아니라 확인
   * 불능이며, 부르는 쪽이 안전한 쪽으로 떨어진다.
   */
  async checkScreen(route: string): Promise<ScreenCheckReport | null> {
    const factory = this.deps.factory();
    const repo = this.deps.activeRepo();
    if (!factory || !repo?.isCloned()) return null;
    const status = await repo.status().catch(() => null);
    const previewUrl = status?.previewUrl;
    if (!previewUrl) return null;
    let target: URL;
    try {
      target = new URL(route, previewUrl);
    } catch {
      return null;
    }
    if (target.origin !== new URL(previewUrl).origin) return null;
    const driver = factory.forIsolated(previewUrl);
    try {
      // 주소의 쿼리는 그냥 주소의 일부다 — 특별히 떼어 내는 것은 없다
      // (2026-09-21 상태 축 철거).
      const opened = await driver
        .open(target.pathname + target.search + target.hash)
        .catch(() => null);
      // 열지 못한 것은 판정이 아니다 — 미리보기 서버가 방금 죽었거나 주소가
      // 사라진 것이고, 그 사실은 다른 자리(중단 카드·레포 상태)가 말한다.
      if (opened === null || opened.ok !== true) return null;
      const errors = (await driver.consoleLines().catch(() => []))
        .filter((line) => TROUBLE_LEVELS[line.level.toLowerCase()] === true)
        .slice(0, MAX_LINES_PER_SCREEN)
        .map((line) => `${line.level}: ${line.text}`);
      return { settled: opened.settled, errors };
    } finally {
      await driver.destroy().catch(() => undefined);
    }
  }

  /**
   * How many captures a 넘기기 would attach — the preview's `### 화면 미리보기`
   * line. Same gates as captureHandoffShots, count only.
   */
  async handoffShotCount(targets: Array<{ route: string }>): Promise<number> {
    const factory = this.deps.factory();
    const repo = this.deps.activeRepo();
    if (!factory || !repo?.isCloned()) return 0;
    const status = await repo.status().catch(() => null);
    if (!status?.previewUrl || targets.length === 0) return 0;
    return targets.length;
  }

  /**
   * 넘기기의 화면 캡처 (PLAN D56 · 브리지 폐지): the screens the
   * planner's own pins named this cycle (`captureTargets`), each opened in
   * the preview driver and captured. Desktop only — the browser dev path has
   * no driver — and every failure is quiet: a capture that will not come
   * back simply is not in the set, and an empty set means the pull request
   * body carries no `### 화면 미리보기` section at all. (2026-09-21 상태 축
   * 철거 — 대상은 주소뿐이다.)
   */
  async captureHandoffShots(targets: Array<{ route: string }>): Promise<HandoffShot[]> {
    const factory = this.deps.factory();
    const repo = this.deps.activeRepo();
    if (!factory || !repo?.isCloned()) return [];
    const status = await repo.status().catch(() => null);
    if (!status?.previewUrl || targets.length === 0) return [];
    const driver = factory.forIsolated(status.previewUrl);
    const shots: HandoffShot[] = [];
    try {
      for (const target of targets) {
        try {
          const opened = await driver.open(target.route);
          // A screen that would not come up has no picture to take.
          if (!opened.ok) continue;
          // A handoff picture is read by a person in a pull request, not by
          // a model — it gets the detailed long edge, and its real
          // extension so the committed file is named after what it holds.
          const capture = await driver.screenshot({ longEdge: HANDOFF_SHOT_LONG_EDGE });
          shots.push({
            route: target.route,
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
