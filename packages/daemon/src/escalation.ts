/**
 * 개발자 에스컬레이션 (슬라이스 5, 2026-09-19 "무조건 처리"): AI 가 고칠 수
 * 없는 환경 실패(토큰 만료 · 푸시 권한 · 브랜치 보호 · 첫 넘기기 실패)를 도구
 * 밖의 채널로 흘린다 — Slack. GitHub 경로가 죽는 순간에도 살아 있는 길이어야
 * 하므로, GitHub 안(PR 코멘트)이 아니라 밖이다.
 *
 * 두 가지 붙는 법(둘 다 지원):
 * - 웹훅 — Slack 이 파는 incoming webhook URL 하나. 설정이 가장 싸다.
 * - 봇 — bot token(xoxb-) + 채널. 채널을 골라 보내고 여러 채널을 쓰는 팀에
 *   맞다. chat.postMessage 는 실패도 200 {ok:false} 로 답하는 Slack 만의
 *   규칙이 있어 ok 판정이 별도다.
 *
 * 계약:
 * - 비밀(URL · 토큰)은 OS 자격 증명 저장소에 산다(GitHub 토큰과 같은 길).
 *   화면으로는 절대 나가지 않는다 — 상태는 "설정됨" 한 단어로만 알린다.
 * - 이 채널이 본 시스템을 깨지 않는다: 보내기는 언제나 불이행(4초 상한,
 *   실패 조용). 알림 채널이 죽어서 저장이 막히는 일은 없다.
 * - 같은 문장은 10분에 한 번: 고장이 지속되는 동안 슬랙이 도배하지 않는다.
 */

import type { CredentialStore } from "./credentials.js";
import type { DaemonLogger } from "./log.js";

/** 자격 증명 저장소의 키 — 서비스 이름은 저장소가 정한다. */
export const ESCALATION_ITEM = "escalation";

/** 같은 문장의 재울림 방지 창 (ms). */
const RERING_WINDOW_MS = 10 * 60_000;

/** 보내기 상한 — 느린 슬랙이 저장을 붙잡지 않게. */
const SEND_TIMEOUT_MS = 4_000;

const SLACK_POST_MESSAGE = "https://slack.com/api/chat.postMessage";

export type EscalationConfig =
  | { kind: "webhook"; url: string }
  | { kind: "bot"; token: string; channel: string };

/** 저장소의 한 줄 — 부팅보다 오래 사는 설정의 모양. 깨진 줄은 없는 것이다. */
function parseConfig(raw: string | null): EscalationConfig | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 깨진 저장은 없는 것과 같다 — 시작이 실패할 이유가 아니다.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.kind === "webhook" && typeof record.url === "string") {
    return { kind: "webhook", url: record.url };
  }
  if (
    record.kind === "bot" &&
    typeof record.token === "string" &&
    typeof record.channel === "string"
  ) {
    return { kind: "bot", token: record.token, channel: record.channel };
  }
  return null;
}

export class Escalation {
  private config: EscalationConfig | null = null;
  private readonly lastRung = new Map<string, number>();

  constructor(
    private readonly store: CredentialStore,
    private readonly logger: DaemonLogger,
  ) {}

  /** 시작 시 저장소에서 읽는다 — 설정은 부팅보다 먼저 살 수 없다. */
  async load(): Promise<void> {
    this.config = parseConfig(await this.store.load(ESCALATION_ITEM).catch(() => null));
  }

  /** 저장(또는 `null` 이면 잊기). 화면에는 돌려줄 비밀이 없다. */
  async set(config: EscalationConfig | null): Promise<void> {
    this.config = config;
    if (config === null) {
      await this.store.delete(ESCALATION_ITEM).catch(() => undefined);
      return;
    }
    await this.store.save(ESCALATION_ITEM, JSON.stringify(config)).catch(() => undefined);
  }

  get configured(): boolean {
    return this.config !== null;
  }

  /**
   * 한 번 울린다. 성공 여부를 돌려주되(시험 버튼의 답), 실패는 예외가 아니라
   * false 다 — 에스컬레이션의 실패를 호출자가 처리하는 것은 이 계약의 위반이다.
   */
  async notify(text: string, now = Date.now()): Promise<boolean> {
    const config = this.config;
    if (config === null) return false;
    const last = this.lastRung.get(text) ?? 0;
    if (now - last < RERING_WINDOW_MS) return true;
    this.lastRung.set(text, now);
    try {
      if (config.kind === "webhook") {
        const response = await fetch(config.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (!response.ok) {
          this.logger.warn("에스컬레이션 전송 실패", { mode: "webhook", status: response.status });
          return false;
        }
        return true;
      }
      const response = await fetch(SLACK_POST_MESSAGE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ channel: config.channel, text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      // Slack 의 API 는 실패도 200 으로 답한다 — ok:false 가 진짜 판정이다.
      const answer: unknown = await response.json().catch(() => null);
      const delivered =
        typeof answer === "object" && answer !== null && "ok" in answer && answer.ok === true;
      if (!response.ok || !delivered) {
        this.logger.warn("에스컬레이션 전송 실패", { mode: "bot", status: response.status });
        return false;
      }
      return true;
    } catch {
      // 조용히 — 채널이 죽은 것은 본 시스템의 고장이 아니다.
      return false;
    }
  }
}
