/** Timestamps read as "얼마 전"; an exact date only helps once it is old. */
export function timeAgo(ts: number): string {
  if (!Number.isFinite(ts)) return "";
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return "방금";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}일 전`;
  return new Date(ts).toLocaleDateString();
}

/** A turn's own length, read as time a person waited: "2분 30초". */
export function waitedFor(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}분` : `${minutes}분 ${rest}초`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
}

/**
 * 되돌릴 수 없는 동작의 행선: 연결 레포
 * 주소에서 `owner/repo` 만을 딴다 — 회사가 저장소를 부르는 이름이고, git
 * 어휘가 아니다. GitHub 주소가 아니면 아무 말도 하지 않는다(null).
 */
export function ownerRepoOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The daemon streams the raw output of whatever it is running. A planner
 * should never meet terminal colour codes or the command line itself, so
 * only the last human-readable line survives.
 */
export function daemonLine(detail: string | null | undefined): string {
  return (
    (detail ?? "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 이스케이프 시퀀스(\u001b[…m)를 벗기는 게 목적이다.
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("$"))
      .at(-1) ?? ""
  );
}
