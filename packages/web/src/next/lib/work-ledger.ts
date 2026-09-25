import type { DeveloperReview, RepoHistoryEntry, RepoStatus } from "@colo-design/protocol";

/**
 * `이번 작업` 과 제출 확인의 순수 판정(PLAN-UI U2 · U3) — 데몬이 싣는 사실
 * (`cycleScreens` · `repo.history` · 제출한 요청의 코멘트)을 목록으로 접는다.
 * 시험이 src 에서 곧장 읽으므로 형제를 부르지 않는다(journey.ts 와 같은 규칙).
 *
 * 시각은 늘 수로 견준다 — 화면 목록과 작업 기록은 git 의 시각(`+09:00`), 제출
 * 기록과 코멘트는 UTC(`Z`)라 글자로 견주면 어긋난다.
 */
export type CycleScreen = NonNullable<RepoStatus["cycleScreens"]>[number];

const time = (iso: string): number => Date.parse(iso);

/** `since` 뒤인가 — 기준이 없으면 모두 뒤다. */
function after(iso: string, since: string | null): boolean {
  return since === null || time(iso) > time(since);
}

/**
 * 보낼 화면 — 화면마다 한 줄, 그 화면을 만든 가장 최근의 말과 시각. 목록은
 * 최근 것부터 온다(데몬의 순서). 제목이 빈 화면(화면을 만지지 않은 차례)은
 * 빠지고, 열린 요청이 있으면 `since`(마지막 제출) 뒤의 것만 남는다.
 */
export function outgoingScreens(
  screens: CycleScreen[] | undefined,
  since: string | null,
): CycleScreen[] {
  const seen = new Set<string>();
  const out: CycleScreen[] = [];
  const newestFirst = [...(screens ?? [])].sort((a, b) => time(b.at) - time(a.at));
  for (const screen of newestFirst) {
    if (screen.title.trim() === "" || seen.has(screen.route)) continue;
    seen.add(screen.route);
    if (after(screen.at, since)) out.push(screen);
  }
  return out;
}

/**
 * 화면 밖 변경 — 작업 기록의 차례 중 화면 목록에 서지 않은 것의 수. 화면
 * 목록의 한 줄은 (차례 × 화면) 이고 그 시각이 차례의 시각이므로, 시각이 같은
 * 줄이 없는 차례가 화면 밖이다.
 */
export function outsideChanges(
  history: RepoHistoryEntry[] | null,
  screens: CycleScreen[] | undefined,
  since: string | null,
): number {
  if (!history) return 0;
  const onScreen = new Set(
    (screens ?? []).filter((screen) => screen.title.trim() !== "").map((screen) => time(screen.at)),
  );
  return history.filter((entry) => after(entry.at, since) && !onScreen.has(time(entry.at))).length;
}

export interface CommentRow {
  id: number;
  author: string;
  text: string;
  at: string;
  /** `done` 반영됨 · `fixing` AI 가 고치는 중. */
  state: "done" | "fixing";
}

/**
 * 개발자 코멘트의 장부 — 최근 것부터. 반영의 판정은 기계적이다: 코멘트 뒤에
 * 도구가 붙인 이름(`코멘트 반영 — …`, `reflectionPrefix`)의 차례가 작업 기록에
 * 있으면 반영됨이다(데몬의 반영 차례 하나가 그때까지 온 코멘트를 함께 받는다).
 * 반영된 사이클은 기록이 사라지므로 모두 반영됨이다. 글이 빈 코멘트(말 없는
 * 승인)는 서지 않는다.
 */
export function commentRows(
  reviews: DeveloperReview[],
  history: RepoHistoryEntry[] | null,
  options: { merged: boolean; reflectionPrefix: string },
): CommentRow[] {
  const reflections = (history ?? [])
    .filter((entry) => entry.message.startsWith(options.reflectionPrefix))
    .map((entry) => time(entry.at));
  return reviews
    .filter((review) => review.body.trim() !== "")
    .sort((a, b) => time(b.at) - time(a.at))
    .map((review) => ({
      id: review.id,
      author: review.author,
      text: review.body.replace(/\s+/g, " ").trim(),
      at: review.at,
      state:
        options.merged || reflections.some((at) => at > time(review.at))
          ? ("done" as const)
          : ("fixing" as const),
    }));
}

/** 여정 둘째 점의 코멘트 수 — 장부에 서는 줄(글이 있는 코멘트)의 수. */
export function commentCount(reviews: DeveloperReview[]): number {
  return reviews.filter((review) => review.body.trim() !== "").length;
}

/** 이번 작업이 시작된 때 — 기록과 화면 목록의 가장 이른 시각. 모르면 null. */
export function cycleStart(
  screens: CycleScreen[] | undefined,
  history: RepoHistoryEntry[] | null,
): string | null {
  let first: string | null = null;
  for (const at of [...(screens ?? []).map((s) => s.at), ...(history ?? []).map((e) => e.at)]) {
    if (Number.isNaN(time(at))) continue;
    if (first === null || time(at) < time(first)) first = at;
  }
  return first;
}

/** 시각 한 칸의 재료 — 문장은 부르는 쪽(`L.work.time`)이 짓는다. 읽을 수 없으면 null. */
export function clockParts(
  iso: string,
  now: Date,
): { today: boolean; hhmm: string; month: number; day: number } | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const today =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return { today, hhmm, month: at.getMonth() + 1, day: at.getDate() };
}
