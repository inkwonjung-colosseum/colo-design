/** Timestamps read as "얼마 전"; an exact date only helps once it is old. */
export function timeAgo(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return "방금";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}일 전`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Screen states, in the planner's language (PLAN D13).
 *
 * The four names below are the ones `CLAUDE.md` asks a connected repo to use,
 * so they cover what the preview will normally offer. A repo that declares
 * something else keeps its own word — inventing a Korean gloss for a state we
 * have never seen would put a label on the chip that the 기획서 does not use.
 */
const STATE_LABEL: Record<string, string> = {
  default: "기본",
  empty: "비어 있음",
  loading: "불러오는 중",
  error: "오류",
};

export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}

/**
 * The daemon streams the raw output of whatever it is running. A planner
 * should never meet terminal colour codes or the command line itself, so
 * only the last human-readable line survives.
 */
export function daemonLine(detail: string | null | undefined): string {
  return (
    (detail ?? "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("$"))
      .at(-1) ?? ""
  );
}
