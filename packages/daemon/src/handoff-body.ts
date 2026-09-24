/**
 * 넘기기 본문의 코멘트 절 (PLAN D93) — 개발자는 무엇이 바뀌었는지와 **왜**
 * 바뀌었는지를 풀 리퀘스트를 떠나지 않고 읽는다. 이 저장소의 유일한 독자가
 * 그 개발자다: 사용자의 핀은 대화에서 이미 소비됐으므로 도구는 그것을 다시
 * 목록으로 그리지 않는다.
 */

/**
 * Builds the `### 수정 요청` section from this cycle's recorded comments:
 * 브랜치가 생긴 시각(sinceIso) 이후의 항목, 최대 20건(넘으면 `외 N건`), 화면은
 * 핀이 기록한 화면 id로, 요소 이름과 경로는 쓰지 않는다(D38). 자동 정리 뒤 모든
 * 행은 AI에게 전달된 것 — 해결 표식은 없다, 목록 자체가 요청의 기록이다.
 * 의도가 제목을 정한다 (재설계 C10 · 커미티 2차 판정 4): 전부 질문이면 섹션
 * 자체가 질문이고, 섞였으면 행마다 (질문)을 새긴다 — 사용자의 질문이 개발자
 * 에게 변경 지시로 읽혀선 안 된다. 빈 메모는 빈 메모다 (커미티 2차 판정 3):
 * 턴의 문장을 빌려 오면 한 문장이 N행으로 복제된다.
 */
export function buildCommentsSection(
  rows: Array<{
    screen: string;
    text: string;
    at: string;
    intent?: "change" | "question";
  }>,
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
    const screen = row.screen;
    const ask = row.intent === "question" ? " (질문)" : "";
    // 핀 본문은 한 행에 눌러 담는다 — 새 줄이 그대로 들어가면 목록의 행이
    // 깨져 절의 끝이 어긋난다. (2026-09-21 상태 축 철거 — 행은 화면만 담는다.)
    const text = row.text.replace(/[\r\n\t]+/g, " ").trim();
    const words = text ? `"${text}"` : "(메모 없음)";
    return `- ${screen}${ask} — ${words}`;
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

/**
 * `### 바뀐 파일` 절 (저장·넘기기 목업 02): 이 사이클 브랜치의 numstat 을
 * 개발자가 읽는 목록으로 — 행마다 ±수, 머리줄에 합계. 개발자는 PR 의
 * Files 탭을 열기 전에 규모를 읽는다. 바이너리·이름 바꿈처럼 git 이 수를
 * 주지 않는 행은 ± 없이 경로만 말한다 — 추측한 크기는 거짓말이다.
 * 미리보기와 실제 본문이 같은 빌더를 지나므로 카드가 보여 준 것이 곧
 * 개발자에게 간다.
 */
export function buildFilesSection(numstat: string, max = 60): string | null {
  const rows = numstat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      const path = fields.slice(2).join("\t").trim();
      if (!path) return null;
      const added = Number.parseInt(fields[0] ?? "", 10);
      const removed = Number.parseInt(fields[1] ?? "", 10);
      return {
        path,
        added: Number.isNaN(added) ? null : added,
        removed: Number.isNaN(removed) ? null : removed,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  if (rows.length === 0) return null;
  const shown = rows.slice(0, max);
  const overflow = rows.length - shown.length;
  const counted = rows.filter((row) => row.added !== null && row.removed !== null);
  const totalAdded = counted.reduce((sum, row) => sum + (row.added ?? 0), 0);
  const totalRemoved = counted.reduce((sum, row) => sum + (row.removed ?? 0), 0);
  const lead =
    counted.length > 0
      ? `바뀐 파일 ${rows.length}개 · +${totalAdded} −${totalRemoved}`
      : `바뀐 파일 ${rows.length}개`;
  const lines = shown.map((row) =>
    row.added === null || row.removed === null
      ? `- ${row.path}`
      : `- ${row.path} (+${row.added} −${row.removed})`,
  );
  const tail = overflow > 0 ? `\n- 외 ${overflow}건` : "";
  return `### 바뀐 파일\n\n${lead}\n\n${lines.join("\n")}${tail}\n`;
}

/** PR 본문에서 도구의 구간을 표시하는 말뭉치 (PLAN L6) — 이 안이 도구의
 *  것이고 바깥은 개발자의 것이다. */
export const TOOL_BLOCK_START = "<!-- colo-design:start -->";
export const TOOL_BLOCK_END = "<!-- colo-design:end -->";

/**
 * PR 본문의 도구 구간만 갱신한다 (PLAN L6) — 순수 함수.
 *
 * 구간이 없으면 본문 끝에 붙이고, 있으면 첫 구간의 내용만 바꾸고, 둘 이상이면
 * 첫 구간만 남기고 나머지는 지운다(옛 버전의 흔적). 구간 밖의 글은 개발자의
 * 것이므로 어떤 경우에도 그대로 둔다 — 다시 제출이 개발자가 쓴 본문을 덮어
 * 쓰는 일가지가 이 함수로 막힌다.
 */
export function mergeToolBlock(existing: string | null, block: string): string {
  const base = existing ?? "";
  const wrapped = `${TOOL_BLOCK_START}\n${block.replace(/\n+$/, "")}\n${TOOL_BLOCK_END}`;
  const pattern = new RegExp(
    `${escapeRegExp(TOOL_BLOCK_START)}[\\s\\S]*?${escapeRegExp(TOOL_BLOCK_END)}\\s*`,
    "g",
  );
  const found = base.match(pattern);
  if (found === null) {
    // 구간이 없다 — 개발자의 글 뒤에 붙인다. 빈 본문이면 안내 문단 없이
    // 구간만 선다.
    return base.trim() === "" ? wrapped : `${base.replace(/\n+$/, "")}\n\n${wrapped}`;
  }
  // 첫 구간만 새 것으로 바꾸고 나머지는 지운다. 끝의 여백은 다듬는다 —
  // 갱신을 거듭할 때마다 빈 줄이 쌓이면 멱등이 아니다 (I5).
  let first = true;
  return base
    .replace(pattern, () => {
      if (first) {
        first = false;
        return `${wrapped}\n\n`;
      }
      return "";
    })
    .replace(/\s+$/, "");
}
/** 정규식 특수문자를 피한다 — 표식은 고정 문장이지만 이스케이프가 재사용을
 *  안전하게 만든다. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * PR 제목은 생성할 때만 정한다 (PLAN L6) — 순수 함수. 초안(handoffDraft 의
 * 8초 안에 나온 제목)이 없으면 `<프로젝트 이름> · <첫 커밋 제목>`, 그마저
 * 없으면 도구의 기본 제목이다. 입양한 PR 이나 다시 제출에서는 이 함수를
 * 부르지 않는다 — 제목은 개발자의 것이다.
 */
export function pickHandoffTitle(input: {
  draftTitle: string | null;
  projectName: string;
  firstCommitSubject: string | null;
  fallback: string;
}): string {
  const draft = input.draftTitle?.trim();
  if (draft) return draft;
  const subject = input.firstCommitSubject?.trim();
  if (subject) return `${input.projectName} · ${subject}`;
  return input.fallback;
}
