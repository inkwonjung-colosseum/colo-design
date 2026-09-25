/**
 * 작업 기록 서랍(PLAN-UI U9)의 순수 판정 — 되돌리기 확인 문구의 수, 제출
 * 구분선의 자리, 차례마다의 화면. 형제 모듈을 부르지 않는다(시험이 src 에서
 * 곧장 읽는다) — 문장 조각(`코멘트 반영 — `)도 인자로 받는다.
 *
 * `entries` 는 `repo.history` 그대로 — 최신이 앞(0번이 지금 서 있는 곳)이다.
 */

/** 차례의 제목 — 보관의 첫 줄(=그 차례를 연 사용자의 말). */
export function entryTitle(message: string): string {
  return (message.split("\n")[0] ?? "").trim();
}

/**
 * `index` 의 차례 직후로 되돌리면 화면에서 사라지는 것 — 그보다 새로운 차례의
 * 수와, 그중 개발자 코멘트 반영(제목이 `commentPrefix` 로 시작)이 있는가.
 */
export function revertSummary(
  entries: ReadonlyArray<{ message: string }>,
  index: number,
  commentPrefix: string,
): { count: number; withComments: boolean } {
  const later = entries.slice(0, Math.max(0, Math.min(index, entries.length)));
  return {
    count: later.length,
    withComments: later.some((entry) => entryTitle(entry.message).startsWith(commentPrefix)),
  };
}

/** 서랍의 한 줄 — 차례 하나, 또는 그 사이의 제출 구분선. */
export type HistoryRow = { kind: "entry"; index: number } | { kind: "submit"; at: string };

/**
 * 차례들 사이에 제출의 순간을 끼운다. 제출은 그 시각보다 오래된 첫 차례 바로
 * 위에 선다(최신이 앞인 목록). 모든 차례보다 오래된 제출은 이번 사이클 밖이라
 * 긋지 않고, 같은 틈의 제출 여럿은 가장 늦은 것 하나로 접는다.
 */
export function historyRows(
  entries: ReadonlyArray<{ at: string }>,
  submits: readonly string[],
): HistoryRow[] {
  const times = submits
    .map((at) => ({ at, ms: Date.parse(at) }))
    .filter((submit) => Number.isFinite(submit.ms))
    .sort((a, b) => b.ms - a.ms);
  const rows: HistoryRow[] = [];
  let next = 0;
  entries.forEach((entry, index) => {
    const entryMs = Date.parse(entry.at);
    let divider: string | null = null;
    while (next < times.length && (times[next]?.ms ?? 0) >= entryMs) {
      divider ??= times[next]?.at ?? null;
      next += 1;
    }
    if (divider !== null) rows.push({ kind: "submit", at: divider });
    rows.push({ kind: "entry", index });
  });
  return rows;
}

/**
 * 한 차례가 만진 화면의 제목 — `RepoStatus.cycleScreens` 에서 그 차례의 제목
 * (`note`)이나 sha 로 짝짓는다. 제목 없는 화면(화면을 만지지 않은 차례)은 뺀다.
 */
export function entryScreens(
  entry: { message: string; sha?: string },
  screens: ReadonlyArray<{ title: string; note: string; sha?: string }> | undefined,
): string[] {
  if (!screens) return [];
  const title = entryTitle(entry.message);
  const names: string[] = [];
  for (const screen of screens) {
    const match =
      (entry.sha !== undefined && screen.sha === entry.sha) || entryTitle(screen.note) === title;
    const name = screen.title.trim();
    if (match && name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}
