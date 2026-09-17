import { BOOTSTRAP_THREAD_TITLE, type ThreadSummary } from "@colo-design/protocol";

/**
 * 여정 보드의 진실 — `thread.cycle`(테이프의 마지막 사이클 행, P3-1)와
 * `thread.state`를 여정 보드의 한 행으로 기계 번역한다. 순수 함수라
 * 그룹핑·트레일·칩 규칙을 React 없이 검증한다.
 *
 * 정류장은 프로젝트 지도(`lib/journey`)와 같은 4개: 만들기 → 저장 → 넘기기 → 반영.
 */

/** 한 정류장의 옷 — done 지나옴, now 지금 서 있음, warn 경고, empty 아직 안 옴. */
type TrailStop = "done" | "now" | "warn" | "empty";
export type Trail = [TrailStop, TrailStop, TrailStop, TrailStop];

export interface JourneyChip {
  tone: "danger" | "accent" | "warn" | "ok" | "muted";
  label: string;
}

/** 보드의 한 행 — 트레일·칩·시각은 전부 사실의 번역일 뿐, 판단이 아니다. */
export interface JourneyRow {
  thread: ThreadSummary;
  title: string;
  trail: Trail | null;
  chip: JourneyChip | null;
  /** 마지막 쓰기 시각(ISO). 도는 턴은 빈 문자열 — 경과가 아니라 칩이 말한다. */
  time: string;
}

export interface JourneyBoardData {
  /** 나를 기다리는 일 — 확인 대기·검토 중·코멘트 도착. */
  waiting: JourneyRow[];
  /** 지금 진행 중 — 도는 턴과 만들기·저장 단계의 대화. */
  working: JourneyRow[];
  /** 방금 있던 일 — 반영된 사이클. */
  done: JourneyRow[];
}

/**
 * 대화의 4점 트레일. 도는 턴이 얹히면 프로젝트 지도의 리셋과 같은 뜻 —
 * 새 작업이 시작됐으니 만들기로 돌아온다(`deriveThreadJourney`의 규칙과
 * 같은 모양). 기여가 없는 대화는 null — 빈 트레일은 "아직 못 갔다"로
 * 오독된다.
 */
export function trailFor(thread: ThreadSummary): Trail | null {
  if (thread.state === "running") return ["now", "empty", "empty", "empty"];
  switch (thread.cycle) {
    case "merged":
      return ["done", "done", "done", "done"];
    case "handed":
      return ["done", "done", "now", "empty"];
    case "review":
      return ["done", "done", "warn", "empty"];
    case "saved":
      return ["done", "now", "empty", "empty"];
    default:
      return thread.state === "awaiting" ? ["now", "empty", "empty", "empty"] : null;
  }
}

/** 행의 상태 칩 — 상태와 사이클의 단어. running·awaiting 이 사이클보다 크다. */
export function chipFor(thread: ThreadSummary): JourneyChip | null {
  if (thread.state === "running") return { tone: "warn", label: "작업 중" };
  if (thread.state === "awaiting") return { tone: "warn", label: "확인 대기" };
  switch (thread.cycle) {
    case "review":
      return { tone: "danger", label: "변경 요청" };
    case "handed":
      return { tone: "accent", label: "개발자 검토 중" };
    case "merged":
      return { tone: "ok", label: "반영됨" };
    case "saved":
      return { tone: "muted", label: "저장됨" };
    default:
      return null;
  }
}

/** 트레일의 말 — 점만 그린 행이 툴팁으로 대신 읽는 문장. */
export function trailWords(thread: ThreadSummary): string {
  if (thread.state === "running") return "만들기(진행 중)";
  switch (thread.cycle) {
    case "merged":
      return "반영됨";
    case "handed":
      return "만들기 · 저장 · 넘기기(검토 중) · 반영";
    case "review":
      return "만들기 · 저장 · 넘기기(코멘트 도착) · 반영";
    case "saved":
      return "만들기 · 저장 — 넘기기 전";
    default:
      return thread.state === "awaiting" ? "만들기(확인 대기)" : "만들기(진행 중)";
  }
}

/**
 * 활성 프로젝트의 대화를 보드의 세 그룹으로 접는다. 각 그룹은 스레드 목록의
 * 순서(최신 먼저)를 그대로 가진다 — 보드가 다시 정렬하지 않는다.
 *
 * - 나를 기다리는 일: 확인 대기(도는 턴이 멈춰 내 답을 기다리는 것)와
 *   넘기기 정류장에 서 있는 대화(검토 중·코멘트 도착). 공은 밖에 있어도
 *   계획자의 시선이 머물 자리다.
 * - 지금 진행 중: 도는 턴과 만들기·저장 단계 — 계획자의 손에 있는 일.
 * - 방금 있던 일: 반영된 사이클.
 */
export function buildJourneyBoard(
  threads: ThreadSummary[],
  sessionTitles: Record<string, string>,
): JourneyBoardData {
  const waiting: JourneyRow[] = [];
  const working: JourneyRow[] = [];
  const done: JourneyRow[] = [];
  for (const thread of threads) {
    // 준비 기록은 대화가 아니라 scaffold — 어느 그룹에도 서지 않는다.
    if (thread.title === BOOTSTRAP_THREAD_TITLE) continue;
    const row: JourneyRow = {
      thread,
      title: sessionTitles[thread.id] ?? thread.title,
      trail: trailFor(thread),
      chip: chipFor(thread),
      // 도는 턴의 updatedAt 은 마지막 쓰기일 뿐 경과가 아니라 — 시간은 비우고 칩이 말한다.
      time: thread.state === "running" ? "" : thread.updatedAt,
    };
    if (thread.state === "running") working.push(row);
    else if (thread.state === "awaiting" || thread.cycle === "handed" || thread.cycle === "review")
      waiting.push(row);
    else if (thread.cycle === "merged") done.push(row);
    else working.push(row);
  }
  return { waiting, working, done };
}
