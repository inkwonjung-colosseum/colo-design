/**
 * 핀 턴의 첫 자세 (2' 측정, 2026-09-20): 대화가 핀으로 시작하면 노력을
 * `COLO_DESIGN_PIN_EFFORT` 로 정한다 — 기본값은 꺼짐(환경변수가 없으면 아무
 * 일도 일어나지 않는다). 턴 종류별 자세의 첫 조각이고, 판정은 턴 통계
 * (firstEditMs · 총 시간 · 교정률)가 대는 길에서만 한다.
 *
 * 왜 "세션 시작 시 한 번"뿐인가 — thinking/effort 를 대화 중간에 바꾸면
 * 메시지 프리픽스 캐시가 깨져 전체 대화를 다시 읽는다(느려짐). 첫 턴 앞은
 * 아직 캐시할 대화가 없으므로 그때만, 그리고 사람이 고르지 않았을 때만
 * (selectedEffort === null) 손을 댄다. `low` 는 거절한다 — "스스로 알아내는
 * 대신 사용자에게 묻는" 쪽으로 기울어 비개발자에게 질문 카드를 늘린다.
 */
import { type EffortLevel, effortLevelSchema } from "@colo-design/protocol";

/** 환경변수 이름 — 벤치(--pin-effort)가 같은 이름을 쥔다. */
export const PIN_EFFORT_ENV = "COLO_DESIGN_PIN_EFFORT";

/** 판정의 재료 — 세션이 아는 것만, 읽기 쉽게. */
export interface PinEffortInput {
  /** 이 보내기가 세션의 첫 턴인가. */
  first: boolean;
  /** 첫 턴의 표식 종류 — "comments" 만이 핀으로 여는 대화다. */
  markerKind: string | null;
  /** 세션이 굴러가는 노력 — null 이면 아직 아무도 고르지 않았다. */
  effort: EffortLevel | null;
  /** 사용자(또는 생성 시 지정)가 명시적으로 고른 노력인가. */
  explicit: boolean;
}

/**
 * 핀으로 시작하는 첫 턴에 얹을 노력 — 조건 하나라도 아니면 null (손대지
 * 않는다). 순수 함수: 판정은 여기, 부작용(세션의 setEffort)은 session.ts 가.
 */
export function pinEffortFor(env: NodeJS.ProcessEnv, input: PinEffortInput): EffortLevel | null {
  const raw = env[PIN_EFFORT_ENV];
  if (raw === undefined || raw === "") return null;
  const parsed = effortLevelSchema.safeParse(raw);
  if (!parsed.success || parsed.data === "low") return null;
  if (!input.first) return null;
  if (input.markerKind !== "comments") return null;
  if (input.explicit || input.effort !== null) return null;
  return parsed.data;
}
