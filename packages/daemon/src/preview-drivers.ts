import type { HandoffShot, ScreenCheckReport } from "@nova-design/protocol";
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

/** 게이트가 타입 검사를 돌렸다면 갈래를 가리지 않고 붙는 칸(PLAN-HARNESS §3.D D-3) —
 *  돌리지 않았으면 칸이 아예 안 선다. */
export interface GateTypeCheck {
  /** 이번에 바뀐 TypeScript 파일에서 나온 오류 수 — 0 도 싣는다. */
  typeErrors?: number;
  /** 타입 검사에 걸린 밀리초. */
  typeMs?: number;
}

/** 게이트 한 바퀴의 결과(2026-09-22) — 서버가 통계 행으로 내려앉히는 것. */
export type GateOutcome = (
  | { status: "trouble"; kept: number; troubles: ScreenTrouble[] }
  | { status: "ok"; kept: number }
  | { status: "broken" }
  | {
      status: "skipped";
      reason: "no-driver" | "no-session" | "no-screens" | "no-preview" | "busy";
    }
) &
  GateTypeCheck;

/** 게이트 한 바퀴를 통계 행의 칸으로 — kept 는 dedupe·origin 필터를 통과한
 *  화면 수다. 못 돈 이유와 판정 상세가 같은 모양으로 흘러 noteGateCheck 에
 *  들어간다. */
export function gateOutcomeStats(outcome: GateOutcome): {
  screens: number;
  skipped?: string;
  unsettled?: number;
  blank?: number;
  consoleLines?: number;
  netLines?: number;
  rescued?: number;
  typeErrors?: number;
  typeMs?: number;
} {
  const typeCheck =
    outcome.typeErrors === undefined
      ? {}
      : { typeErrors: outcome.typeErrors, typeMs: outcome.typeMs };
  if (outcome.status === "trouble") {
    return {
      screens: outcome.kept,
      unsettled: outcome.troubles.filter((trouble) => trouble.unsettled).length,
      blank: outcome.troubles.filter((trouble) => trouble.blank).length,
      consoleLines: outcome.troubles.reduce((sum, trouble) => sum + trouble.consoleCount, 0),
      netLines: outcome.troubles.reduce((sum, trouble) => sum + trouble.netCount, 0),
      rescued: outcome.troubles.filter((trouble) => trouble.rescued).length,
      ...typeCheck,
    };
  }
  if (outcome.status === "ok") return { screens: outcome.kept, ...typeCheck };
  return {
    screens: 0,
    skipped: outcome.status === "broken" ? "broken" : outcome.reason,
    ...typeCheck,
  };
}

/** 캡처 파일 이름 — 주소를 무난한 조각으로 눌러 쓴다. */
function captureNameOf(route: string): string {
  const id = route.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "screen";
  return id.slice(0, 60);
}

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
  /**
   * (PLAN-HARNESS §3.D D-3) 게이트 브리프의 타입 절 — 이 턴이 바꾼
   * TypeScript 파일이 있을 때만 서버가 증분 검사를 돌려 만든다. 없으면
   * null(게이트마다 tsc 를 돌리지 않는다). 오류가 없어도 검사를 돌렸으면
   * lines 가 빈 채로 돌아온다 — 통계가 그 사실을 남긴다.
   */
  typeTroubles?(sessionId: string): Promise<{ lines: string[]; errors: number; ms: number } | null>;
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
   * (PLAN-HARNESS §3.B B-4) 게이트를 걸 수 있는 세션인가 — gatePossible 에서
   * "모인 화면이 있다" 조건만 뺀 것. 드라이버가 없는 브라우저 개발 경로와
   * 이미 한 번 건 세션은 화면이 있어도 없어도 걸 수 없으므로, 바꾼 파일에서
   * 화면을 되짚는 길(fallback)도 이 조건을 지난 뒤에야 간다.
   */
  gateEligible(sessionId: string): boolean {
    if (!this.deps.factory()) return false;
    return !this.gatedSessions.has(sessionId);
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
   *
   * (PLAN-HARNESS §3.D D-3) 타입 갈래가 끼는 자리는 정해져 있다 —
   * no-driver·no-session 뒤, 화면 없음 판정 앞에서 타입 검사를 돌려 그
   * 줄을 모든 결과에 싣고, 화면 문제가 없어도 타입 줄이면 게이트 턴이 선다.
   */
  async runGate(sessionId: string, turnDurationMs?: number): Promise<GateOutcome> {
    const screens = [...(this.pinnedThisTurn.get(sessionId)?.values() ?? [])];
    this.pinnedThisTurn.delete(sessionId);
    const session = this.deps.session(sessionId);
    const done = (detail?: string): void => {
      // 대기 줄이 곧(또는 이미) 새 턴을 열었다면 이 완료 알림은 허위다 — 도는
      // 턴이 있는데 `작업이 끝습니다` 가 나간다(턴 끝의 idle 방출과 release
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
    if (!factory) return done(), { status: "skipped", reason: "no-driver" };
    if (!session) return done(), { status: "skipped", reason: "no-session" };
    // (D-3 ②) 타입 검사 — 서버가 이 턴에 바꾼 TypeScript 파일이 있을 때만
    // 돌렸다. 실패는 null 이고, 돌렸다는 사실은 모든 갈래의 typeErrors ·
    // typeMs 로 흘러간다.
    const typeTroubles = (await this.deps.typeTroubles?.(sessionId).catch(() => null)) ?? null;
    const typeLines = typeTroubles?.lines ?? [];
    const typeFields: GateTypeCheck =
      typeTroubles === null ? {} : { typeErrors: typeTroubles.errors, typeMs: typeTroubles.ms };
    // (D-3 ③) 모인 화면이 없고 타입 줄도 없으면 지금처럼 no-screens.
    if (screens.length === 0 && typeLines.length === 0) {
      return done(), { status: "skipped", reason: "no-screens", ...typeFields };
    }
    // 게이트는 이 세션이 사는 프로젝트를 기준으로 판정한다 — 활성 프로젝트가
    // 아니라. 턴 도중 프로젝트를 전환한 뒤 끝난 턴의 핀을 활성 레포의 주소로
    // 다시 열면 전혀 다른 앱의 콘솔이 이 세션의 판정이 된다.
    const repo = this.deps.repoForSession?.(sessionId) ?? this.deps.activeRepo();
    const status = await repo?.status().catch(() => null);
    const previewUrl = status?.previewUrl;
    // (F1) 모인 화면이 있는데 미리보기 주소가 없으면 확인 불능이다 — 타입 줄도
    // 없으면 통과가 아닌 no-preview 로 끝낸다(타입 줄이 있을 때만 화면 없이
    // 계속 간다, D-3 ④).
    if (!previewUrl && typeLines.length === 0) {
      return done(), { status: "skipped", reason: "no-preview", ...typeFields };
    }
    const kept: GateScreen[] = [];
    let troubles: ScreenTrouble[] = [];
    if (previewUrl) {
      // preview origin 밖의 주소는 게이트가 재검증할 대상이 아니다 — 허용된
      // 추가 origin 은 레포의 다른 서버이지, 게이트가 다시 열 화면이 아니다.
      const origin = new URL(previewUrl).origin;
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
      if (kept.length > 0) {
        const driver = factory.forIsolated(previewUrl);
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
        // (D-3 ⑤) 게이트 자신이 깨지면 타입 줄도 버리고 broken 으로 끝난다 —
        // 드물고, 다음 사람의 턴이 다시 본다.
        if (broken) {
          done("화면 확인을 실행하지 못했습니다 — 다음 말에 핀을 다시 찍어 확인해 주세요.");
          return { status: "broken", ...typeFields };
        }
      }
    }
    // (D-3 ⑥) 화면 문제도 타입 줄도 없으면 ok — origin 을 지난 화면이 0 이면
    // kept 도 0 이다.
    if (troubles.length === 0 && typeLines.length === 0) {
      return done(), { status: "ok", kept: kept.length, ...typeFields };
    }
    // 사용자가 그 사이 다시 보냈으면 이 판정은 낡았다 — 도는 턴에 끼어들지 않는다.
    if (this.deps.session(sessionId)?.state !== "idle") {
      return done(), { status: "skipped", reason: "busy", ...typeFields };
    }
    this.gatedSessions.add(sessionId);
    this.deps.notice({
      kind: "gate",
      sessionId,
      title: session.title,
      stage: "screen",
    });
    // 문제 화면의 그림이 브리프와 함께 간다(2026-09-22) — 글자만 읽고 추측하던
    // 고침을 눈으로 보게 한다. 첨부는 세션의 send 계약 그대로(이름·형식·bytes).
    const captures = troubles.flatMap((trouble) =>
      trouble.capture !== undefined
        ? [
            {
              name: `${captureNameOf(trouble.route)}${SHOT_EXTENSIONS[trouble.capture.mediaType] ?? ".bin"}`,
              mediaType: trouble.capture.mediaType,
              data: trouble.capture.data,
            },
          ]
        : [],
    );
    try {
      session.send(gateBrief(troubles, typeLines), captures);
    } catch {
      // 질의가 방금 죽었다 — 완료로 닫는 편이 아무 말도 없는 것보다 낫다.
      done();
    }
    return { status: "trouble", kept: kept.length, troubles, ...typeFields };
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
