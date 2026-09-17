import type { DeveloperReview, PermissionSuggestion, ProjectSummary } from "@colo-design/protocol";
import type { PendingPermission, PendingQuestion, SessionView } from "./daemon-client";
import { toolLabel } from "./labels";

type Pending = PendingPermission | PendingQuestion;

/** 질문형 결정 카드 — 즉답 칩은 단일 질문·단일 선택일 때만 있다. */
interface AskingQuestion {
  kind: "question";
  requestId: string;
  sessionId: string;
  title: string;
  /** 인용할 질문 원문 — 즉답 칩이 없는 다중 질문/다중 선택일 때는 null. */
  quote: string | null;
  /** 즉답 칩의 라벨들 — quote 가 null 이면 항상 빈 배열. */
  options: string[];
  questionCount: number;
  /** 요청이 만들어진 시각 (epoch ms) — 데몬이 찍는 시계, 없으면 카드가 숨긴다. */
  requestedAt?: number;
}

/** 권한형 결정 카드 — 인용할 문장이 없다; 헤드라인은 카드가 포맷한다. */
interface AskingPermission {
  kind: "permission";
  requestId: string;
  sessionId: string;
  title: string;
  toolName: string;
  input: unknown;
  suggestions: PermissionSuggestion[];
  /** AskingQuestion.requestedAt 와 같은 시계. */
  requestedAt?: number;
}

/** 코멘트 도착 카드 — 그 대화의 마지막 블록이 아직 답 없는 개발자 코멘트다. */
interface AskingReview {
  kind: "review";
  sessionId: string;
  title: string;
  reviews: DeveloperReview[];
}

export type AskingItem = AskingQuestion | AskingPermission | AskingReview;

/** "지금 진행 중" 카드 한 장. */
export interface RunningItem {
  sessionId: string;
  title: string;
  line: string;
  turnStartedAt: number | null;
}

/** "방금 있던 일" 카드 한 장 — `at`은 `ThreadSummary.updatedAt`에서 온 실제 시각. */
export interface DoneItem {
  sessionId: string;
  title: string;
  line: string;
  at: number;
}

/**
 * 크로스 프로젝트 인박스(PLAN P3-2)의 요약 행 한 장 — 비활성 프로젝트는 살아
 * 있는 세션이 없어 결정 카드의 인용·즉답을 못 그리므로, 대신 프로젝트 자체가
 * 폴러(`pollOpenHandoffs`)로부터 받은 세 숫자만 보인다: 이름 · 답을 기다리는
 * 스레드 수 · 마지막으로 감지된 개발자 쪽 사건. `lastEventKind`가 없으면 아직
 * 폴러가 아무 사건도 못 본 프로젝트 — 그 줄은 pendingCount 만으로 그린다.
 */
export interface OtherProjectItem {
  slug: string;
  name: string;
  pendingCount: number;
  lastEventKind?: "merged" | "closed" | "changes_requested" | "comments";
  lastEventAt?: string;
}

export interface HomeFeed {
  asking: AskingItem[];
  running: RunningItem[];
  done: DoneItem[];
  /** 활성 프로젝트를 뺀 나머지 — pending 도 마지막 사건도 없는 프로젝트는
      0건 숨김 규칙을 따라 걸러진다. */
  otherProjects: OtherProjectItem[];
}

/**
 * 지금 진행 중 카드의 한 줄 — 서브에이전트(Task 도구) 경유 작업이면 그 설명을
 * 그대로 쓰고, 아니면 마지막으로 돈 도구의 한국어 이름으로 낮춘다.
 * 아무 신호도 없으면(막 시작해 블록이 쌓이기 전) 빈 문장을 보이지 않는다.
 */
function lastActionLine(view: SessionView): string {
  const task = view.tasks.find((item) => item.description.trim().length > 0);
  if (task) return task.description.trim();
  for (let i = view.blocks.length - 1; i >= 0; i--) {
    const block = view.blocks[i];
    if (block?.type === "tool") return `${toolLabel(block.name)} 하는 중이에요`;
  }
  return "작업하는 중이에요";
}

/**
 * `pending`·`sessions`·`projects`를 홈의 네 그룹으로 접는다. 순수 함수라
 * React 없이도 그룹핑 규칙(0건 숨김, 다중 질문/선택 판별, 활성 프로젝트
 * 스코프)을 검증할 수 있다.
 *
 * 결정 카드의 인용·즉답(`asking`)과 진행/완료 줄(`running`/`done`)은 활성
 * 프로젝트로 계속 좁힌다 — 비활성 프로젝트엔 살아 있는 세션이 없으므로
 * 폴러(`pollOpenHandoffs`)로부터 온 세 숫자(pendingCount·lastEventKind·
 * lastEventAt, PLAN P3-2)만으로 나머지 프로젝트를 한 줄씩 요약한다 — 그
 * 대화를 열려면 먼저 그 프로젝트로 전환해야 한다.
 */
export function buildHomeFeed(
  pending: Pending[],
  sessions: Record<string, SessionView>,
  projects: ProjectSummary[],
  activeSlug: string | null,
): HomeFeed {
  const activeProject = projects.find((project) => project.slug === activeSlug) ?? null;
  const threads = activeProject?.threads ?? [];
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const titleFor = (sessionId: string) => threadById.get(sessionId)?.title ?? "대화";

  // 질문형·권한형: 데몬이 준 순서는 도착 순이지 발생 순이 아니다 —
  // 타임스탬프가 없는 한 "최신이 맨 위"는 근사값일 뿐이니, 도착이 늦은
  // 쪽(배열의 뒤)을 먼저 보인다.
  const askingFromPending: AskingItem[] = [];
  for (const item of pending) {
    if (!threadById.has(item.sessionId)) continue;
    if (item.kind === "question") {
      const [first] = item.questions;
      const multi = item.questions.length > 1 || Boolean(first?.multiSelect);
      askingFromPending.push({
        kind: "question",
        requestId: item.requestId,
        sessionId: item.sessionId,
        title: titleFor(item.sessionId),
        quote: multi ? null : (first?.question ?? null),
        options: multi ? [] : (first?.options.map((option) => option.label) ?? []),
        questionCount: item.questions.length,
        requestedAt: item.requestedAt,
      });
    } else {
      askingFromPending.push({
        kind: "permission",
        requestId: item.requestId,
        sessionId: item.sessionId,
        title: titleFor(item.sessionId),
        toolName: item.toolName,
        input: item.input,
        suggestions: item.suggestions,
        requestedAt: item.requestedAt,
      });
    }
  }
  askingFromPending.reverse();

  // 코멘트 도착: 사이드바가 "답이 왔습니다"를 판정하는 것과 같은 규칙 —
  // 그 대화의 가장 마지막 블록이 아직 아무 턴도 뒤따르지 않은 사람 메시지일
  // 때만 "나를 기다리는 일"이다.
  const askingFromReviews: AskingItem[] = [];
  for (const [sessionId, view] of Object.entries(sessions)) {
    if (!threadById.has(sessionId)) continue;
    const last = view.blocks.at(-1);
    if (last?.type === "human") {
      askingFromReviews.push({
        kind: "review",
        sessionId,
        title: titleFor(sessionId),
        reviews: last.reviews,
      });
    }
  }

  const running: RunningItem[] = [];
  const done: DoneItem[] = [];
  for (const thread of threads) {
    const view = sessions[thread.id];
    if (view?.state === "running") {
      running.push({
        sessionId: thread.id,
        title: thread.title,
        line: lastActionLine(view),
        turnStartedAt: view.turnStartedAt,
      });
    } else if (thread.state === "finished") {
      // ThreadSummary.updatedAt 은 실제 타임스탬프다(pending 과 달리) — 근사가
      // 아니라 정확한 "얼마 전"을 보일 수 있다.
      done.push({
        sessionId: thread.id,
        title: thread.title,
        line: "답이 왔어요 — 확인해 보세요",
        at: Date.parse(thread.updatedAt) || 0,
      });
    }
  }
  running.sort((a, b) => (b.turnStartedAt ?? 0) - (a.turnStartedAt ?? 0));
  done.sort((a, b) => b.at - a.at);

  // 크로스 프로젝트 인박스(PLAN P3-2): 활성 프로젝트를 뺀 나머지
  // 중 pending 도 마지막 사건도 없는 프로젝트는 그룹별 0건 숨김 규칙을
  // 따라 걸러진다. pending 이 있는 쪽을 먼저, 그 다음 최근 사건순.
  const otherProjects: OtherProjectItem[] = projects
    .filter((project) => project.slug !== activeSlug)
    .filter((project) => project.pendingCount > 0 || project.lastEventKind !== undefined)
    .map((project) => ({
      slug: project.slug,
      name: project.name,
      pendingCount: project.pendingCount,
      ...(project.lastEventKind
        ? { lastEventKind: project.lastEventKind, lastEventAt: project.lastEventAt }
        : {}),
    }))
    .sort((a, b) => {
      if (a.pendingCount !== b.pendingCount) return b.pendingCount - a.pendingCount;
      return (Date.parse(b.lastEventAt ?? "") || 0) - (Date.parse(a.lastEventAt ?? "") || 0);
    });

  return {
    asking: [...askingFromPending, ...askingFromReviews],
    running,
    done,
    otherProjects,
  };
}
