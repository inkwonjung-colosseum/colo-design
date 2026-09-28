import type { Attention, RepoStatus } from "@colo-design/protocol";
import type { L } from "../labels";

/**
 * 화면의 문제 문장(README「화면의 문제 문장은 셋이다」 · PLAN-UI U13) — 대화 칸의
 * 맨 위 한 줄. 옛 `AttentionLine` 의 판정을 순수 함수로 옮기고, 제출이 막힌
 * 경우(`repo.submit.phase === "blocked"`)를 `개발자에게 알렸어요` 로 더했다.
 *
 * 우선순위는 데몬의 `composeAttention` 과 같다 — 사람의 손이 필요한 `다시
 * 연결` 이 먼저, 개발자에게 알린 사실이 다음, AI 고침이 마지막. 프로젝트의
 * 주의와 기계 전체의 주의 중 높은 쪽 하나만 선다.
 *
 * 문장은 인자(`W`)로 받는다 — 시험이 src 에서 곧장 읽는 순수 모듈은 형제를
 * 부르지 않는다(journey.ts 와 같은 규칙).
 */
export type ProblemWords = Pick<typeof L, "problem" | "chat">;

export interface Problem {
  /** 줄의 색 — 목업의 `.problem.fixing` · `.notified` · `.reconnect`. */
  kind: "fixing" | "notified" | "reconnect";
  title: string;
  body: string;
  /** 사람의 손 — 초대 파일 열기 · 브라우저에서 다시 로그인. 없으면 버튼이 없다. */
  action: "invite" | "login" | null;
  /**
   * 닫기의 신원 (PLAN-UI U13) — `개발자에게 알렸어요` 줄만 가진다. 문제가
   * 처음 선 시각(`since`)이 들어 있어 같은 문제는 한 번 닫으면 다시 뜨지
   * 않고, 풀렸다 새로 막히면 다른 신원으로 다시 선다.
   */
  dismissId: string | null;
}

type RepoLike = Pick<RepoStatus, "phase" | "previewUrl"> &
  Partial<Pick<RepoStatus, "attention" | "submit">>;

function rank(attention: Attention): number {
  return attention.kind === "reconnect" ? 0 : attention.kind === "developer-notified" ? 1 : 2;
}

/** 두 주의 중 먼저 말할 것 — 같은 순위면 프로젝트의 것(`a`). */
export function pickAttention(
  a: Attention | null | undefined,
  b: Attention | null | undefined,
): Attention | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return rank(a) <= rank(b) ? a : b;
}

export function problemFor(
  status: { attention?: Attention | null } | null,
  repo: RepoLike | null,
  W: ProblemWords,
): Problem | null {
  const attention = pickAttention(repo?.attention, status?.attention);
  if (attention?.kind === "reconnect") {
    return attention.what === "github"
      ? {
          kind: "reconnect",
          title: W.problem.reconnect,
          body: W.problem.reconnectInvite,
          action: "invite",
          dismissId: null,
        }
      : {
          kind: "reconnect",
          title: W.problem.reconnect,
          body: W.problem.reconnectLogin,
          action: "login",
          dismissId: null,
        };
  }
  // 제출이 막힌 것은 개발자 몫의 문제다(U13) — 데몬이 알림을 세우기 전에도
  // 막힘 자체가 그 문장을 말한다.
  if (repo?.submit?.phase === "blocked") {
    return {
      kind: "notified",
      title: W.problem.notified,
      body: W.problem.notifiedSubmit,
      action: null,
      dismissId: `submit:${repo.submit.since ?? "?"}`,
    };
  }
  if (attention?.kind === "developer-notified") {
    return {
      kind: "notified",
      title: W.problem.notified,
      body: W.problem.notifiedOther,
      action: null,
      dismissId: `notice:${attention.since}`,
    };
  }
  if (attention?.kind === "ai-fixing") {
    // 미리보기가 떠 있지 않으면 고치는 대상은 미리보기다 — 목업의 문장이 그렇게 말한다.
    const previewDown = repo !== null && (repo.phase !== "ready" || repo.previewUrl === null);
    return {
      kind: "fixing",
      title: W.problem.fixing,
      body: previewDown ? W.problem.fixingPreview : W.chat.fixingOther,
      action: null,
      dismissId: null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// `개발자에게 알렸어요` 의 닫기 — 이 탭이 사는 동안만 기억한다
// ---------------------------------------------------------------------------

/**
 * 닫은 문제의 신원 목록 — sessionStorage 라 앱을 다시 켜면 다시 선다: 문제는
 * 아직 서 있고, 하루 걸린 알림을 다시 보여 주는 쪽이 잊히는 것보다 낫다
 * (레포 경고의 지문은 localStorage 이지만 그것은 영구 소식 — 이 줄은 살아
 * 있는 문제다). 신원은 `problem.dismissId`(문제가 처음 선 시각)라 같은 문제만
 * 닫히고, 풀렸다 다시 막힌 제출이나 새 알림은 다른 신원으로 다시 선다.
 */
const PROBLEM_DISMISSED_KEY = "colo-design.problem-dismissed";
const PROBLEM_DISMISSED_MAX = 20;

export function dismissedProblems(): string[] {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(PROBLEM_DISMISSED_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function dismissProblem(dismissId: string): void {
  try {
    const next = [...new Set([...dismissedProblems(), dismissId])].slice(-PROBLEM_DISMISSED_MAX);
    sessionStorage.setItem(PROBLEM_DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // 사적 모드 등에서 저장이 막혀도 닫기는 이 탭의 몫으로 끝난다.
  }
}
