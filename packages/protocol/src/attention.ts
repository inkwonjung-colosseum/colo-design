/**
 * 화면의 문제 문장 (PLAN L8 · 단계 4) — 프로젝트와 기계의 주의는 이 세 문장
 * 중 하나다. 데몬이 재료(감독자의 판정 · 넘기기 게이트 · 준비 복구 · 서 있는
 * 개발자 알림)를 모아 `composeAttention` 이 하나를 고르고, 웹은 그 값을
 * 그대로 읽는다 — 웹이 우선순위를 다시 배우는 일은 없다.
 *
 * `developer-notified` 는 실제로 개발자에게 닿은 알림(원장의 notices)에서만
 * 선다 — 알리지 못한 것을 알렸다고 말하지 않는다 (PLAN O9).
 */

export type Attention =
  | { kind: "ai-fixing"; since: string }
  | { kind: "developer-notified"; since: string; via: "pr" | "issue" | "slack" }
  | { kind: "reconnect"; since: string; what: "github" | "agent-login" };

/** 서 있는 개발자 알림의 최소 모양 — 원장(cycle.json notices)의 값과 같다. */
export interface AttentionNotice {
  via: "pr" | "issue" | "slack";
  raisedAt: string;
}

/**
 * 주의의 재료 — 각 출처가 아는 것만 넣는다. `reconnect` 는 사용자의 손이
 * 필요한 문제(연결 코드 · AI 로그인), `aiFixingSince` 는 AI 가 고치는 중이
 * 된 시각, `notices` 는 실제로 개발자에게 나간 알림의 기록이다.
 */
export interface AttentionParts {
  reconnect?: { what: "github" | "agent-login"; since: string } | null;
  aiFixingSince?: string | null;
  notices?: Record<string, AttentionNotice>;
}

/**
 * 재료에서 화면의 한 문장을 고른다 — 우선순위는 reconnect > developer-notified
 * > ai-fixing (PLAN L8). 사용자의 손이 필요한 문제가 가장 먼저이고, 개발자에게
 * 알렸다는 사실이 그 다음, AI 고침이 마지막이다.
 */
export function composeAttention(parts: AttentionParts): Attention | null {
  if (parts.reconnect) {
    return { kind: "reconnect", since: parts.reconnect.since, what: parts.reconnect.what };
  }
  const notices = Object.values(parts.notices ?? {});
  if (notices.length > 0) {
    // 가장 오래 서 있는 알림의 경로와 시각 — 문제가 둘 이상이어도 문장은 하나다.
    const first = notices.reduce((a, b) => (a.raisedAt <= b.raisedAt ? a : b));
    return { kind: "developer-notified", since: first.raisedAt, via: first.via };
  }
  if (parts.aiFixingSince) {
    return { kind: "ai-fixing", since: parts.aiFixingSince };
  }
  return null;
}
