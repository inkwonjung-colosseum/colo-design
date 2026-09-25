/**
 * 되살리기 예산 (PLAN L12 · 단계 0) — 같은 대화가 일정 창 안에 스스로 일으킬 수
 * 있는 횟수의 상한. 옛 셈은 되살리기 자신이 세션을 교체하며 닫는 close 에 매번
 * 지워져 상한이 사실상 없었다(망가진 CLI 가 끝없이 되살아난다). 셈을 순수
 * 클래스로 뽑아 그 길을 가른다: 지우는 것은 성공한 턴의 끝(settled)과 대화의
 * 진짜 닫힘(forget)뿐이다.
 *
 * 상한 · 창의 값은 예산 표(budgets.ts, PLAN L7)가 정한다 — 단계 8 부터
 * 이 클래스는 그 표만 읽는다(10분 안에 3회).
 */

import { BUDGETS } from "./budgets.js";

export class ReviveBudget {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly max: number = BUDGETS.revive.max,
    private readonly windowMs: number = BUDGETS.revive.windowMs,
  ) {}

  /** 허용이면 셈을 올린다 — 거절하면 아무 것도 바뀌지 않는다. */
  allow(sessionId: string, now: number): boolean {
    const fresh = (this.attempts.get(sessionId) ?? []).filter((at) => now - at < this.windowMs);
    this.attempts.set(sessionId, fresh);
    if (fresh.length >= this.max) return false;
    fresh.push(now);
    return true;
  }

  /** 성공한 턴의 끝 — 다음 고장은 새로운 사건이다. */
  settled(sessionId: string): void {
    this.attempts.delete(sessionId);
  }

  /** 대화가 정말 닫힘 — 셈도 함께 간다. */
  forget(sessionId: string): void {
    this.attempts.delete(sessionId);
  }
}
