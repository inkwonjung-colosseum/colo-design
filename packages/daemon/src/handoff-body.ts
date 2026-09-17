/**
 * 넘기기 본문의 코멘트 절 (PLAN D93) — 개발자는 무엇이 바뀌었는지와 **왜**
 * 바뀌었는지를 풀 리퀘스트를 떠나지 않고 읽는다. 이 저장소의 유일한 독자가
 * 그 개발자다: 사용자의 핀은 대화에서 이미 소비됐으므로 도구는 그것을 다시
 * 목록으로 그리지 않는다.
 */

/** The planner's words for a screen state, matching the web's stateLabel. */
const COMMENT_STATE_LABEL: Record<string, string> = {
  default: "기본",
  empty: "비어 있음",
  loading: "불러오는 중",
  error: "오류",
};

/**
 * Builds the `### 수정 요청` section from this cycle's recorded comments:
 * 브랜치가 생긴 시각(sinceIso) 이후의 항목, 최대 20건(넘으면 `외 N건`), 화면은
 * 선언된 제목으로, 요소 이름과 경로는 쓰지 않는다(D38). 자동 정리 뒤 모든 행은
 * AI에게 전달된 것 — 해결 표식은 없다, 목록 자체가 요청의 기록이다.
 * 의도가 제목을 정한다 (재설계 C10 · 커미티 2차 판정 4): 전부 질문이면 섹션
 * 자체가 질문이고, 섞였으면 행마다 (질문)을 새긴다 — 사용자의 질문이 개발자
 * 에게 변경 지시로 읽혀선 안 된다. 빈 메모는 빈 메모다 (커미티 2차 판정 3):
 * 턴의 문장을 빌려 오면 한 문장이 N행으로 복제된다.
 */
export function buildCommentsSection(
  rows: Array<{
    screen: string;
    state: string;
    text: string;
    at: string;
    intent?: "change" | "question";
  }>,
  screenTitle: (screenId: string) => string | null,
  sinceIso: string,
  max = 20,
): string | null {
  // Compare as instants, not strings: the commit date is local-offset ISO,
  // the comment rows are UTC — a string compare would sort them wrong.
  const sinceMs = Date.parse(sinceIso);
  if (Number.isNaN(sinceMs)) return null;
  const cycle = rows
    .filter((row) => {
      const at = Date.parse(row.at);
      return !Number.isNaN(at) && at >= sinceMs;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (cycle.length === 0) return null;
  const shown = cycle.slice(-max);
  const overflow = cycle.length - shown.length;
  const questions = shown.filter((row) => row.intent === "question").length;
  const changes = shown.length - questions;
  const lines = shown.map((row) => {
    const screen = screenTitle(row.screen) ?? row.screen;
    const state = COMMENT_STATE_LABEL[row.state] ?? row.state;
    const ask = row.intent === "question" ? " (질문)" : "";
    const words = row.text ? `"${row.text}"` : "(메모 없음)";
    return `- ${screen} · ${state}${ask} — ${words}`;
  });
  const tail = overflow > 0 ? `\n- 외 ${overflow}건` : "";
  const title =
    questions > 0 && changes === 0
      ? "### 질문"
      : questions > 0
        ? "### 수정 요청 · 질문"
        : "### 수정 요청";
  const lead =
    questions > 0 && changes === 0
      ? "사용자가 미리보기에서 찍어 AI에게 보낸 질문입니다."
      : questions > 0
        ? "사용자가 미리보기에서 찍어 AI에게 보낸 수정 요청과 질문입니다."
        : "사용자가 미리보기에서 찍어 AI에게 보낸 수정 요청입니다.";
  return `${title}\n\n${lead}\n\n${lines.join("\n")}${tail}\n`;
}
