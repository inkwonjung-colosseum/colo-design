/**
 * D4 준비 실패 브리프의 장부 (2026-09-23): 준비가 멈췄을 때 AI 에게 넘길지,
 * 이미 넘긴 실패의 재방송인지, AI 가 고쳐 보고도 못 넘어 개발자에게 알릴
 * 자리인지를 가른다. 연결 레포의 오류는 사람에게 올리지 않으므로(웹의 진행
 * 판은 "AI 가 고치는 중" 만 말한다) 이 장부가 곧 그 약속의 울타리다.
 *
 * 한 바퀴(에피소드)는 준비가 `ready` 에 닿을 때까지다. `armed` 는 지난 브리프
 * 뒤에 준비가 다시 돌았다는 뜻이다(고침 턴 끝의 재동기화 · 사람의 다시 시도):
 * 그 뒤의 실패만이 "고쳤는데 또 멈췄다" 이고, 같은 실패의 재방송(상태가 다시
 * 나갈 뿐인 것)은 다시 브리프하지 않는다. 실패 문장은 세지 않는다 — 출력의
 * 시각·경로가 바뀔 때마다 새 실패로 읽으면 고침 턴이 끝없이 이어진다.
 *
 * 상태 하나를 받아 다음 장부와 결정을 돌려주는 순수 함수다 — fleet 은
 * 부작용(대화 열기 · 개발자 알림)만 진다.
 */
import type { RepoStatus } from "@colo-design/protocol";

/**
 * 같은 단계의 준비 실패를 AI 에게 넘기는 횟수 — 첫 브리프와, 고친 뒤에도 또
 * 멈췄을 때의 한 번. 미리보기 오류의 고침 예산(웹의 MAX_AUTO_FIXES)과 같은 둘이다.
 */
export const BRING_UP_BRIEFS_PER_KIND = 2;
/** 준비가 설 때까지 한 바퀴의 브리프 상한 — 단계가 번갈아 넘어지는 고리를 끊는다. */
export const BRING_UP_BRIEFS_PER_EPISODE = 4;

export interface BringUpEpisode {
  /** 마지막으로 센 실패의 종류(`RepoStatus.errorKind`). */
  kind: string;
  /** 이 종류가 연달아 넘어진 수. */
  same: number;
  /** 이 바퀴에서 센 실패 전부. */
  total: number;
  /** 지난 실패 뒤에 준비가 다시 돌았다 — 다음 실패는 재방송이 아니다. */
  armed: boolean;
  /** 개발자 채널에 이미 알렸다 — 한 바퀴에 한 번. */
  escalated: boolean;
}

export type BringUpDecision =
  | { action: "none" }
  /** AI 에게 넘긴다. `repeat` — 고친 뒤에도 같은 단계에서 또 멈췄다. */
  | { action: "brief"; repeat: boolean }
  /** AI 는 멈추고 개발자 채널에 알린다. */
  | { action: "escalate" };

const NONE: BringUpDecision = { action: "none" };

export function nextBringUpBrief(
  episode: BringUpEpisode | undefined,
  status: Pick<RepoStatus, "phase" | "errorKind" | "detail">,
): { episode: BringUpEpisode | undefined; decision: BringUpDecision } {
  // 준비가 섰다 — 이 바퀴는 끝났다. 다음 실패는 새 실패다.
  if (status.phase === "ready") return { episode: undefined, decision: NONE };
  // 준비가 다시 돈다 — 그 끝의 실패는 재방송이 아니라 다시 멈춘 것이다.
  if (status.phase !== "error") {
    return { episode: episode ? { ...episode, armed: true } : undefined, decision: NONE };
  }
  const kind = status.errorKind;
  // 사람의 결정이 필요한 실패(commands — 첫 실행의 동의)는 AI 의 몫이 아니고,
  // C5 의 재시도 중 문장은 아직 실패가 아니다.
  if (!kind || kind === "commands") return { episode, decision: NONE };
  if (status.detail?.startsWith("화면을 다시 켜는 중") === true) return { episode, decision: NONE };
  if (episode && !episode.armed) return { episode, decision: NONE };
  const next: BringUpEpisode = {
    kind,
    same: episode?.kind === kind ? episode.same + 1 : 1,
    total: (episode?.total ?? 0) + 1,
    armed: false,
    escalated: episode?.escalated ?? false,
  };
  if (next.same > BRING_UP_BRIEFS_PER_KIND || next.total > BRING_UP_BRIEFS_PER_EPISODE) {
    // AI 가 고쳐 보고도 못 넘은 자리다 — 기계끼리 더 돌리지 않는다.
    if (next.escalated) return { episode: next, decision: NONE };
    return { episode: { ...next, escalated: true }, decision: { action: "escalate" } };
  }
  return { episode: next, decision: { action: "brief", repeat: next.same > 1 } };
}
