import type { ProjectSummary, ThreadSummary } from "@colo-design/protocol";
import { BOOTSTRAP_THREAD_TITLE } from "@colo-design/protocol";

/**
 * 대화 지우기의 낙관 상태 (OPTIMISTIC DELETE).
 *
 * 지우기가 데몬에서 끝나도 트리의 행은 저장 스캔과 `project.changed`
 * 브로드캐스트를 한 바퀴 돌고 나서야 사라진다 — 스캔이 무거운 클론에서는
 * 그 한 바퀴가 수 초로 읽힌다. 그래서 확인 대화상자가 승인한 순간 행을
 * 화면에서 먼저 거둔다(숨김), 데몬의 목록이 따라오면 숨김을 거둔다(조정).
 * 지우기가 실패하면 숨김을 풀어 행을 되돌리고 오류를 보인다.
 *
 * slug → 숨긴 스레드 id들, 또는 "all"(그 프로젝트의 행 전체 — 대화 모두 지우기).
 * 이 모듈은 순수 함수만 담는다 — 상태 소유는 useDaemon, 소비는 Sidebar.
 */
export type HiddenThreads = Record<string, "all" | string[]>;

/**
 * 도구가 스스로 여는 대화의 고정 제목들 — 데몬이 사람의 손 없이 만든다:
 * 연결 준비(BOOTSTRAP_THREAD_TITLE), 리뷰 반영·최신화 문제 해결
 * (project-fleet.autoFixThreadFor), 저장·넘기기·최신화 문제 해결
 * (dispatch.gateThreadFor). 사이드바는 이 대화들을 기획자의 대화와 섞지
 * 않고 프로젝트 목록 맨 아래 「도구가 한 일」 접힌 그룹으로 묶는다.
 * 판정은 데몬의 제목으로 한다 — 이름 바꾸기는 sessionTitles 의 표시만
 * 바꾸므로, 도구가 만든 기록은 이름을 바꿔도 이 그룹에 남는다.
 */
export const SYSTEM_THREAD_TITLES: Record<string, true> = {
  [BOOTSTRAP_THREAD_TITLE]: true,
  "리뷰 반영": true,
  "최신화 문제 해결": true,
  "보관 문제 해결": true,
  "제출 문제 해결": true,
};

export function hideThread(hidden: HiddenThreads, slug: string, sessionId: string): HiddenThreads {
  const current = hidden[slug];
  if (current === "all") return hidden; // 이미 전부 숨겨져 있다 — 더 숨길 것도 없다
  const next = current ? current.filter((id) => id !== sessionId) : [];
  next.push(sessionId);
  return { ...hidden, [slug]: next };
}

export function unhideThread(
  hidden: HiddenThreads,
  slug: string,
  sessionId: string,
): HiddenThreads {
  const current = hidden[slug];
  if (!current) return hidden;
  if (current === "all") return hidden; // 전체 숨김은 개별 해제의 대상이 아니다
  const next = current.filter((id) => id !== sessionId);
  if (next.length === 0) {
    const { [slug]: _dropped, ...rest } = hidden;
    return rest;
  }
  return { ...hidden, [slug]: next };
}

export function hideAllThreads(hidden: HiddenThreads, slug: string): HiddenThreads {
  return { ...hidden, [slug]: "all" };
}

export function unhideAllThreads(hidden: HiddenThreads, slug: string): HiddenThreads {
  const current = hidden[slug];
  if (!current) return hidden;
  const { [slug]: _dropped, ...rest } = hidden;
  return rest;
}

/**
 * 화면이 그릴 행 — 데몬이 알려준 목록에서 숨긴 것을 거둔다. 목록이 아직
 * 없는 프로젝트(null)는 행이 없다는 뜻 그대로 둔다.
 */
export function visibleThreads(
  threads: ThreadSummary[] | null | undefined,
  hidden: HiddenThreads,
  slug: string,
): ThreadSummary[] {
  const entry = hidden[slug];
  const base = threads ?? [];
  if (!entry) return base;
  if (entry === "all") return [];
  return base.filter((thread) => !entry.includes(thread.id));
}

/**
 * 데몬의 목록이 따라왔을 때의 조정: 더는 존재하지 않는 숨김을 거둔다.
 * - 프로젝트가 사라졌다면 숨김도 무의미하다.
 * - "all"은 데몬 목록이 실제로 비는 순간에만 거둔다 — 목록이 undefined(아직
 *   스캔 전)이거나 행이 남아 있으면(스캔 지연) 숨김을 유지한다.
 * - 개별 id는 데몬 목록에서 사라진 것만 거둔다. 목록에 아직 남아 있는 id는
 *   스캔이 늦은 것 — 숨김을 유지해 행이 반짝 돌아오지 않게 한다.
 */
export function pruneHidden(hidden: HiddenThreads, projects: ProjectSummary[]): HiddenThreads {
  let changed = false;
  const next: HiddenThreads = {};
  for (const [slug, entry] of Object.entries(hidden)) {
    const project = projects.find((p) => p.slug === slug);
    if (!project) {
      changed = true;
      continue;
    }
    const threads = project.threads;
    if (entry === "all") {
      if (threads != null && threads.length === 0) {
        changed = true;
        continue;
      }
      next[slug] = "all";
      continue;
    }
    const kept = threads ? entry.filter((id) => threads.some((t) => t.id === id)) : entry;
    if (kept.length !== entry.length) changed = true;
    if (kept.length > 0) next[slug] = kept;
  }
  return changed ? next : hidden;
}
