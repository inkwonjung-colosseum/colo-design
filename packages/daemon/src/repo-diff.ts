import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DiffFile, DiffHunk } from "@colo-design/protocol";

/**
 * 저장 검토가 읽는 diff — `git diff HEAD` 의 글자를 파일과 hunk 로 바꾸고,
 * 아직 추적되지 않는 파일을 "전부 추가된 파일"로 읽어 같은 모양에 세운다.
 * 그리고 Claude 의 요약 한 턴이 실패했을 때 대신 쓰는 폴더 묶음까지.
 *
 * `this` 가 하나도 없다 — 워크스페이스의 상태 기계를 빌리지 않으므로 파일
 * 하나와 문자열 하나로 검사된다.
 */

/** 폴더로 묶을 수 없는 파일들이 모이는 이름. */
const FALLBACK_ROOT_GROUP = "기타";

const DIFF_HEADER = /^diff --git a\/(.*) b\/(.*)$/;

/**
 * Parses `git diff HEAD` output into per-file hunks. Header noise (index,
 * mode, ---/+++) is dropped; `\ No newline at end of file` stays in the hunk
 * it belongs to, because it is part of what the planner is approving.
 */
export function parseUnifiedDiff(output: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  const lines = output.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing newline artifact

  for (const line of lines) {
    const header = DIFF_HEADER.exec(line);
    if (header) {
      current = { path: header[2]!, status: "modified", hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) current.status = "renamed";
    else if (line.startsWith("rename to ")) current.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      current.binary = true;
      hunk = null;
    } else if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      current.hunks.push(hunk);
    } else if (
      hunk &&
      (line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ") ||
        line.startsWith("\\"))
    ) {
      hunk.lines.push(line);
    }
    // Everything else — index, mode, ---/+++ — is plumbing the panel does not show.
  }
  return files;
}

/** An untracked file is a change too: shown as one added-everything hunk. */
export function untrackedAsAdded(root: string, rel: string): DiffFile {
  const file: DiffFile = { path: rel, status: "added", hunks: [] };
  let content: Buffer;
  try {
    content = readFileSync(join(root, rel));
  } catch {
    return file; // vanished mid-listing; the next diff.get will tell the truth
  }
  // A NUL byte in the head of the file is how git decides "binary" without a
  // parser; adopt the same cheap test.
  if (content.subarray(0, 8000).includes(0)) return { ...file, binary: true };
  const lines = content.toString("utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) lines.push("");
  file.hunks = [
    {
      header: `@@ -0,0 +1,${lines.length} @@`,
      lines: lines.map((line) => `+${line}`),
    },
  ];
  return file;
}

// ---------------------------------------------------------------------------
// 요약 폴백 · 되돌리기 경로 규칙 (PLAN D51 · D52 · D53 — pure, unit tested)
// ---------------------------------------------------------------------------

/**
 * The folder a changed path is read as, for the summary's fallback (PLAN
 * D51): `src/screens/member/PayFailed.screen.tsx` → `member`. The folder
 * directly above the file is the one the repo's own convention names a
 * screen group with; a file with no folder above it lands in `기타`. This is
 * string cutting, not repo-convention reading — the daemon never decides
 * what a "screens" folder means.
 */
export function fallbackGroup(path: string): string {
  const segments = path.split("/");
  return segments.length >= 2
    ? (segments[segments.length - 2] ?? FALLBACK_ROOT_GROUP)
    : FALLBACK_ROOT_GROUP;
}

/**
 * The summary when Claude's turn cannot land (PLAN D51): the changed paths
 * grouped by their folder, `폴더: 수정 N · 추가 M` per group. Deterministic —
 * same diff, same lines — because this is what the planner reads when the
 * fancy version failed.
 */
export function fallbackSummary(files: Array<Pick<DiffFile, "path" | "status">>): string[] {
  const groups = new Map<string, { modified: number; added: number }>();
  for (const file of files) {
    const group = fallbackGroup(file.path);
    const counts = groups.get(group) ?? { modified: 0, added: 0 };
    if (file.status === "added") counts.added += 1;
    else counts.modified += 1;
    groups.set(group, counts);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([group, counts]) => {
      const parts: string[] = [];
      if (counts.modified > 0) parts.push(`수정 ${counts.modified}`);
      if (counts.added > 0) parts.push(`추가 ${counts.added}`);
      return `${group}: ${parts.join(" · ")}`;
    });
}
