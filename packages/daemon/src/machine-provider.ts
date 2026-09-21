/**
 * 기계 잔일의 담당 (저장 메모 · 넘기기 초안) — machine-provider.
 *
 * 저장 사이클의 두 짧은 턴(빈 메모의 커밋 문장, PR 의 제목·첫 문단)은 어떤
 * 대화에도 속하지 않는다: 입력은 순수 git 상태(diff · 커밋 제목)이고 세션
 * 대화록은 읽지 않는다. 그래서 담당도 세션이 아니라 데몬이 정한다 — 여러
 * 세션이 한 워크트리를 고치는 게 이 도구의 평상임이라 "저장을 누른 창의
 * provider"는 소유자가 아니라 포커스일 뿐이다.
 *
 * 규칙의 두 층 (위가 이긴다):
 *   1. 설정(machine.set) — 계획자가 고른 provider. 못 쓰면 조용히 아래로.
 *   2. 자동 — 등록 순서가 곧 후보 순서(registry.ts)로 oneShot 계약을 구현한
 *      첫 드라이버. 계약을 지키지 못하는 드라이버는 oneShot 을 생략하는
 *      것만으로 후보에서 빠진다 — provider 가 늘어나도 이 쪽은 한 줄도
 *      바뀌지 않는다.
 *   후보가 없으면 null — 폴백이 유일한 길이고 저장은 막히지 않는다.
 *
 * 자격은 설치 여부만 본다(ok + executable). 로그인 상태는 턴 자신의 실패
 * (→null→폴백)가 담당한다 — 원샷이 살아남는 길을 가용성 검사가 닫아버리는
 * 일이 없어야 한다.
 *
 * 담당은 데몬 단위로 한 번 정해 캐시한다: 같은 기계의 메모는 항상 같은
 * 계정, 같은 저가 모델, 같은 목줄 통과율로 나온다. 설정이 바뀌는 순간
 * (machine.set)과 담당이 죽었음을 알린 순간에만 다시 판정한다.
 */

import type { AgentDriver } from "./agent/driver.js";
import type { DriverRegistry } from "./agent/registry.js";

/**
 * 한 번의 기계 턴 — repo 레이어가 아는 전부. 어느 provider 인지는 이
 * 경계 너머의 일이고, null 은 언제나 "폴백을 쓰라"는 뜻이다.
 */
export type MachineTurn = (
  prompt: string,
  opts: { cwd: string; timeoutMs: number },
) => Promise<string | null>;

/**
 * 담당이 없을 때의 턴 — 폴백만 남는 길. "구성이 machineTurn 을 안 싣는"
 * 직접 구성(테스트 · doctor)이 평상임이라 값이 아니라 이름이 필요하다.
 */
export const NO_MACHINE_TURN: MachineTurn = () => Promise.resolve(null);

/** 판정의 결과 — 설정이 골랐는지 자동이 골랐는지까지가 상태의 말이다. */
export interface MachinePick {
  id: string;
  origin: "setting" | "auto";
}

/** 드라이버가 설치돼 있는가 — 로그인은 보지 않는다(모듈 머리 참조). */
async function installed(driver: AgentDriver): Promise<boolean> {
  const diagnostic = await driver.isAvailable().catch(() => null);
  return diagnostic?.ok === true && typeof diagnostic.executable === "string";
}

/** 담당 정하기의 판정만 — 순수하고, 상태도 타이머도 모른다. */
export async function resolveMachineProvider(
  registry: DriverRegistry,
  configured: string | null,
): Promise<MachinePick | null> {
  if (configured) {
    const driver = registry.get(configured);
    if (driver?.oneShot && (await installed(driver))) {
      return { id: configured, origin: "setting" };
    }
    // 못 쓰는 설정값 — 조용히 자동으로. 설정 행이 그 사실을 말한다.
  }
  for (const driver of registry.all()) {
    if (!driver.oneShot) continue;
    if (await installed(driver)) return { id: driver.id, origin: "auto" };
  }
  return null;
}

/** The daemon-wide machine turns: 담당을 최초 필요 시 한 번 정해 캐시한다. */
export class MachineTurns {
  /**
   * undefined = 아직 정하지 않았다. null 은 "후보가 없다"의 판정 완료 —
   * 매 저장마다 드라이버를 다시 검사하지 않는다.
   */
  private resolved: MachinePick | null | undefined;

  constructor(
    private readonly registry: DriverRegistry,
    private readonly configured: () => string | null = () => null,
  ) {}

  /** 한 번의 기계 턴: 담당이 없으면 null (폴백), 있는데 못 내도 null. */
  async turn(prompt: string, opts: { cwd: string; timeoutMs: number }): Promise<string | null> {
    const pick = await this.resolve();
    const driver = pick ? this.registry.get(pick.id) : undefined;
    return driver?.oneShot ? driver.oneShot(prompt, opts) : null;
  }

  /** 지금의 담당 — status 가 설정 행 아래 한 줄로 말하는 값. */
  async resolve(): Promise<MachinePick | null> {
    if (this.resolved === undefined) {
      this.resolved = await resolveMachineProvider(this.registry, this.configured());
    }
    return this.resolved;
  }

  /** 담당을 다시 정한다 — machine.set 직후와 담당의 죽음을 알린 순간. */
  invalidate(): void {
    this.resolved = undefined;
  }
}
