import type { Block } from "./daemon-client";
import { type DeliveryInput, deriveDelivery } from "./delivery";

/**
 * 여정 띠의 진실 — `deriveDelivery` 의 state 를 4정류장 지도로 기계 번역한다
 * (docs/plan/preview.md §1-A). 지도는 대화가 아니라 프로젝트 사이클의 것:
 * `repo.handoff`·`pendingChanges` 는 프로젝트 단위라 같은 프로젝트의 모든
 * 대화가 같은 지도를 본다. 시계·타이머는 없다 — `delivery.state` 와
 * `pendingChanges`·`running` 만으로 결정되는 순수 함수.
 *
 * 정류장: 0 만들기 → 1 저장 → 2 넘기기 → 3 반영.
 * ('연결' 정류장은 제외 — 대화 단위에선 노이즈, 계약 확정.)
 */
export interface Journey {
  /** 지금 서 있는 정류장 (0..3). */
  stop: 0 | 1 | 2 | 3;
  /**
   * 각 정류장의 reached 여부 — 지나온 정류장은 채워진다. `arrived` 일 때만
   * 넷 다 true (반영에 도착했다는 뜻이지, 아직 가는 중이 아니다).
   */
  reached: [boolean, boolean, boolean, boolean];
  /** 반영 정류장에 도착 — merged + 새 작업 없음. */
  arrived: boolean;
  /** 넘기기 정류장의 경고 톤 — 변경 요청·반려·코멘트 도착. */
  warn: boolean;
  /**
   * 어느 단위의 지도인가 (P3-1): `project` 는 프로젝트 사이클의 진실,
   * `thread` 는 이 대화가 기여한 사이클 위치 — 지도가 대화 제목 칩과 함께
   * 그려지는 것이 이 구분이다.
   */
  scope: "project" | "thread";
}

const at = (stop: number): [boolean, boolean, boolean, boolean] => [
  stop > 0,
  stop > 1,
  stop > 2,
  stop > 3,
];

/**
 * `delivery === null`(phase ≠ ready/error)이면 null — 준비 중엔 지도가
 * 거짓말을 하므로 띠 자체를 숨긴다.
 *
 * 2주차 리셋 규칙(확정): merged 도착은 "새 작업이 시작되기 전까지"만 유지.
 * 리셋 트리거 = `pendingChanges > 0` 또는 `running`(새 고침 턴) — 리셋되면
 * 4정류장이 모두 비고 만들기가 now가 된다.
 */
export function deriveJourney(input: DeliveryInput): Journey | null {
  const delivery = deriveDelivery(input);
  if (!delivery) return null;
  const reset = input.pendingChanges > 0 || input.running;

  switch (delivery.state) {
    case "merged":
      if (reset) {
        return {
          stop: 0,
          reached: at(0),
          arrived: false,
          warn: false,
          scope: "project",
        };
      }
      return {
        stop: 3,
        reached: [true, true, true, true],
        arrived: true,
        warn: false,
        scope: "project",
      };
    case "closed":
      // 반려는 넘기기 정류장에 경고 톤으로 머문다 — 반영으로 위장 금지.
      return {
        stop: 2,
        reached: at(2),
        arrived: false,
        warn: true,
        scope: "project",
      };
    case "changes_requested":
      return {
        stop: 2,
        reached: at(2),
        arrived: false,
        warn: true,
        scope: "project",
      };
    case "handed":
      return {
        stop: 2,
        reached: at(2),
        arrived: false,
        warn: false,
        scope: "project",
      };
    case "saved":
      return {
        stop: 1,
        reached: at(1),
        arrived: false,
        warn: false,
        scope: "project",
      };
    case "unsaved":
      return {
        stop: 0,
        reached: at(0),
        arrived: false,
        warn: false,
        scope: "project",
      };
    case "clean":
      return {
        stop: 0,
        reached: at(0),
        arrived: false,
        warn: false,
        scope: "project",
      };
  }
}

/**
 * 대화 단위 여정 (P3-1): 이 대화의 테이프가 접은 사이클 블록 — `save`
 * (cycle.saved) · `milestone` (cycle.handed·cycle.merged) · `human`
 * (review.arrived) — 만 읽어 "이 대화가 기여한 사이클 위치"를 도출한다.
 * 프로젝트 지도(`deriveJourney`)와 같은 4정류장을 쓰되, 입력이 대화의
 * 기록이라 답은 이 대화의 것이다.
 *
 * 규칙 — 프로젝트 지도의 전이 표와 같은 모양:
 * - 사이클 블록이 하나도 없으면 null — 기여가 없는 대화는 프로젝트 지도로
 *   떨어진다(빈 지도는 "아직 못 갔다"로 오독된다).
 * - 마지막 사이클 블록이 위치를 정한다: save → 저장, handed → 넘기기,
 *   merged → 반영(arrived), human → 넘기기의 경고(코멘트 도착).
 * - `merged` 는 여정의 끝이자 다음 여정의 시작: 그 뒤의 블록만 새 위치를
 *   만든다(재사이클 — 넘긴 뒤 다시 저장하면 이 대화의 지도도 저장으로 돌아온다).
 * - `running`(이 대화의 턴이 도는 중)은 프로젝트 지도의 리셋과 같은 뜻:
 *   새 작업이 시작됐으니 만들기로 돌아온다.
 */
export function deriveThreadJourney(blocks: Block[], running: boolean): Journey | null {
  // The last merged ends one journey; only blocks after it place the next.
  let from = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.type === "milestone" && block.subtype === "merged") {
      from = i;
      break;
    }
  }
  let stop = 0;
  let warn = false;
  for (let i = from; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block?.type === "save") {
      stop = 1;
      warn = false;
    } else if (block?.type === "milestone") {
      stop = block.subtype === "merged" ? 3 : 2;
      warn = false;
    } else if (block?.type === "human") {
      stop = 2;
      warn = true;
    }
  }
  if (stop === 0) return null;
  if (running) {
    return {
      stop: 0,
      reached: at(0),
      arrived: false,
      warn: false,
      scope: "thread",
    };
  }
  if (stop === 3) {
    return {
      stop: 3,
      reached: [true, true, true, true],
      arrived: true,
      warn: false,
      scope: "thread",
    };
  }
  return {
    stop: stop as 1 | 2,
    reached: at(stop),
    arrived: false,
    warn,
    scope: "thread",
  };
}
