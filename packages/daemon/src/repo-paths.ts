/**
 * 클론 안의 경로의 규칙 — 어디까지가 이 워크스페이스 안인가
 * (`safeRepoPath`). 순수 함수라 워크스페이스 없이 검사된다.
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
