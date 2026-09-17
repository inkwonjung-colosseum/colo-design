import type { DiffFile } from "@colo-design/protocol";

/**
 * 기계가 쓰는 한 턴짜리 프롬프트들 (PLAN D51 · D53): 저장 검토의 요약, 저장
 * 메모, 넘기기 본문 초안. 셋 다 문자열을 받아 문자열을 내는 순수 함수라
 * 여기 모여 산다 — 프롬프트의 말이 바뀌는 것과 워크스페이스의 절차가 바뀌는
 * 것은 서로 다른 이유로 일어나는 변경이다.
 */

/** 요약이 낼 수 있는 줄 수 — 세 줄을 넘으면 그것은 목록이지 요약이 아니다. */
export const SUMMARY_MAX_LINES = 3;
/** 한 파일이 프롬프트에서 차지할 수 있는 글자 — 전면 재작성 하나가 나머지를
 *  밀어내지 않게. 사용자의 `자세히 보기` 는 여전히 전부를 본다. */
const SUMMARY_HUNK_CHAR_LIMIT = 4_096;
/** 저장 메모의 길이 상한. */
export const MEMO_MAX_CHARS = 500;
/** 넘기기 초안이 읽는 파일 수의 상한. */
export const HANDOFF_FILE_LIMIT = 60;
/** 넘기기 제목·본문의 길이 상한. */
export const HANDOFF_TITLE_MAX_CHARS = 200;
export const HANDOFF_BODY_MAX_CHARS = 2_000;

/**
 * The diff as the summarizer reads it: `git diff`-shaped lines, each file
 * capped at SUMMARY_HUNK_CHAR_LIMIT so one wholesale rewrite cannot crowd
 * the rest out of the prompt. The cap is on what the agent is handed — the
 * planner's `자세히 보기` still gets every hunk.
 */
export function renderSummaryFile(file: DiffFile): string {
  if (file.binary) return `파일: ${file.path} (바이너리 — 내용 생략)`;
  const lines: string[] = [`파일: ${file.path}`];
  let size = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const piece =
        line.length > SUMMARY_HUNK_CHAR_LIMIT ? `${line.slice(0, SUMMARY_HUNK_CHAR_LIMIT)}…` : line;
      if (size + piece.length > SUMMARY_HUNK_CHAR_LIMIT) {
        lines.push("(이 파일의 나머지는 생략했습니다)");
        return lines.join("\n");
      }
      size += piece.length;
      lines.push(piece);
    }
  }
  return lines.join("\n");
}

/**
 * The summarizer's whole instruction (PLAN D51): the changed files and the
 * ask — planner's words, three lines, no file names, then one `메모:` line
 * the review's 저장 메모 field opens with. The diff is the only thing this
 * turn may read, so it rides in the prompt. There is no declared screen
 * list any more: a screen the diff touches is described, never named.
 */
export function summaryPrompt(files: DiffFile[]): string {
  return [
    "아래는 저장 전에 검토할 변경 내용입니다. 바뀐 화면과 바뀐 점을 사용자 말로 3줄 이내, 파일 이름 없이 적어 주세요. 한 줄에 한 가지 바뀐 점을 적습니다.",
    "마지막 줄에는 `메모:` 로 시작하는 저장 메모 한 문장을 적어 주세요 — 저장 기록에 남을 짧은 제목입니다. 예: 메모: 회원 관리 화면 추가",
    "",
    `바뀐 화면·파일: ${files.map((file) => file.path).join(", ")}`,
    "",
    files.map(renderSummaryFile).join("\n"),
  ].join("\n");
}

/**
 * The save-time memo's whole instruction (비개발자 저장): one Korean
 * sentence that can stand alone as a commit subject — no file-name lists,
 * no quoting, nothing but the sentence. The diff is the only thing this
 * turn may read, so it rides in the prompt, exactly like the summary's.
 */
export function memoPrompt(files: DiffFile[]): string {
  return [
    "아래 변경 내용이 저장(커밋)됩니다. 저장 메모로 쓸 한국어 한 문장을 적어 주세요.",
    "규칙: 한 줄만 답하고, 따옴표·목록 기호·접두어를 붙이지 않으며, 파일 이름을 나열하지 않습니다. 예: 회원 관리 화면 추가",
    "",
    `바뀐 화면·파일: ${files.map((file) => file.path).join(", ")}`,
    "",
    files.map(renderSummaryFile).join("\n"),
  ].join("\n");
}

/**
 * The 넘기기 draft's whole instruction (비개발자 넘기기): the cycle's own
 * 저장 메모 and the files those saves moved. The memos are already the
 * planner's words — this turn joins them into the two things a developer
 * reads first, and is told not to invent what the memos do not say.
 */
export function handoffPrompt(memos: string[], files: string[]): string {
  return [
    "아래는 사용자가 이번에 저장한 작업입니다. 개발자에게 넘길 제목과 내용을 한국어로 적어 주세요.",
    "첫 줄: 제목 한 줄 (40자 안쪽, 따옴표·접두어 없이).",
    "둘째 줄부터: 무엇을 만들었고 개발자가 무엇을 봐 주면 되는지 3줄 이내. 파일 이름은 나열하지 않고, 저장 메모에 없는 내용은 지어내지 않습니다.",
    "",
    "저장 메모:",
    ...memos.map((memo) => `- ${memo}`),
    "",
    "바뀐 파일:",
    ...files,
  ].join("\n");
}
