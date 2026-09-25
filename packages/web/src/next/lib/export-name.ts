/**
 * 내보내는 파일의 이름 — 대화 제목을 파일 이름에 쓸 수 있는 글자로 눌러 닫고
 * 날짜를 붙인다. 확장자는 붙이지 않는다: `downloadTranscript` 가 `.md` 를 얹는다.
 * 순수 함수라 시험이 src 에서 곧장 읽는다(README 「순수 판정」).
 */
export function exportFileName(title: string, now: Date): string {
  const safe = title
    // 파일 이름에 쓸 수 없는 글자(윈도우의 금지 목록)과 제어 문자(`\p{Cc}`).
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${safe || "conversation"}-${now.getFullYear()}-${month}-${day}`;
}
