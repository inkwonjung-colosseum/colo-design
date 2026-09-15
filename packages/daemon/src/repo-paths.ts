/**
 * 클론 안의 경로를 다루는 규칙 둘 — 어디까지가 이 워크스페이스 안인가
 * (`safeRepoPath`), 그리고 되돌리기가 무엇을 되돌리고 무엇을 지워야 하는가
 * (`restorePlan`). 순수 함수라 워크스페이스 없이 검사된다.
 */

/**
 * The one path rule every write here obeys — the same rule a save's
 * reviewed diff already follows: a repo-relative, forward-slash path that
 * stays inside the clone. Absolute paths and `..` are not paths inside a
 * worktree; they are an escape attempt, and an escape is refused with null.
 * Returns the normalized path otherwise.
 */
export function safeRepoPath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  if (normalized === "" || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

/**
 * A checkpoint restore's plan (PLAN D52): `git diff --name-status <tree>`
 * splits into the paths to check out (present in the snapshot, changed
 * since) and the paths to delete (created after the snapshot). Only paths
 * the allow rule passes survive — a snapshot tree is git's own output, but
 * the plan is what gets executed, and the plan never reaches outside.
 */
export function restorePlan(
  nameStatus: string,
  allowed: (path: string) => boolean = (path) => safeRepoPath(path) !== null,
): { checkout: string[]; remove: string[] } {
  const checkout = new Set<string>();
  const remove = new Set<string>();
  for (const line of nameStatus.split(/\r?\n/)) {
    const trimmed = line.trim();
    const tab = trimmed.indexOf("\t");
    if (trimmed === "" || tab < 0) continue;
    const status = trimmed.slice(0, tab).trim();
    const path = trimmed.slice(tab + 1).trim();
    if (!allowed(path)) continue;
    // `--no-renames` keeps this to A/M/D/T; anything else (U, X) is a state
    // a mid-merge worktree is in, and a restore must not touch it.
    if (status === "A") remove.add(path);
    else if (status === "M" || status === "D" || status === "T") checkout.add(path);
  }
  return {
    checkout: [...checkout].sort(),
    remove: [...remove].sort(),
  };
}
