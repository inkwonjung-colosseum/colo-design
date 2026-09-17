import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangedFileLite, DiffFile, DiffHunk } from "@colo-design/protocol";

/**
 * 저장이 승인하는 diff — `git diff HEAD` 의 글자를 파일과 hunk 로 바꾸고,
 * 아직 추적되지 않는 파일을 "전부 추가된 파일"로 읽어 같은 모양에 세운다.
 *
 * `this` 가 하나도 없다 — 워크스페이스의 상태 기계를 빌리지 않으므로 파일
 * 하나와 문자열 하나로 검사된다.
 */

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
// 변경 점 스트립의 재료 — `git status --porcelain` · `git diff --numstat HEAD`
// 의 글자를 가벼운 행으로. hunks 없다: 어디가 무엇으로 변했지만 말한다.
// `this` 가 하나도 없다 — 재검수의 순수한 절반 (repo-core 가 짝지어 쓴다).
// ---------------------------------------------------------------------------

const PORCELAIN_RENAME = /^(.*) -> (.*)$/;

/** git 이 C 따옴표로 쓰는 이스케이프 — \ooo 빼고는 한 글자짜리다. */
const PORCELAIN_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
};

/**
 * porcelain 이 붙인 C 따옴표를 벗긴다 — `core.quotepath=false` 여도 공백·
 * 따옴표 경로는 `"src/space file.ts"` 로 인용된다(실측). 인용되지 않은 입력은
 * 그대로 돌려준다. \ooo 8진수는 UTF-8 바이트 하나 — 이웃한 바이트를 모아 한
 * 번에 디코딩해야 한글이 살아 있다.
 */
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || path[0] !== '"' || path[path.length - 1] !== '"') return path;
  const raw = path.slice(1, -1);
  const bytes: number[] = [];
  let out = "";
  const flush = (): void => {
    if (bytes.length === 0) return;
    out += new TextDecoder().decode(new Uint8Array(bytes));
    bytes.length = 0;
  };
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch !== "\\") {
      flush();
      out += ch;
      continue;
    }
    const mark = raw[i + 1];
    if (mark === undefined) break; // 매달린 역슬래시 — git 은 쓰지 않는다
    if (mark >= "0" && mark <= "7") {
      let value = 0;
      let digits = 0;
      while (digits < 3) {
        const digit = raw[i + 1 + digits];
        if (digit === undefined || digit < "0" || digit > "7") break;
        value = value * 8 + Number(digit);
        digits += 1;
      }
      i += digits; // 루프의 += 1 이 마지막 자릿수 다음으로 옮겨 놓는다
      bytes.push(value & 0xff);
      continue;
    }
    flush();
    out += PORCELAIN_ESCAPES[mark] ?? mark;
    i += 1;
  }
  flush();
  return out;
}

function porcelainStatus(xy: string): ChangedFileLite["status"] {
  // Worktree and index letters share one word here: what a 저장 would carry
  // is the net change against HEAD, and a file both staged and re-edited is
  // still one row. D wins over A — an add-then-delete nets to a deletion.
  if (xy.includes("D")) return "deleted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("A") || xy.includes("?")) return "added";
  return "modified";
}

/** `git status --porcelain` → path+status rows. Rename rows name the new path — the one that exists now. */
export function parseStatusRows(output: string): Array<{
  path: string;
  status: ChangedFileLite["status"];
}> {
  const rows: Array<{ path: string; status: ChangedFileLite["status"] }> = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) continue; // `XY path` — changedPaths's same floor
    const body = line.slice(3).trim();
    if (body === "") continue;
    const rename = PORCELAIN_RENAME.exec(body);
    const path = unquoteGitPath((rename ? (rename[2] ?? "").trim() : body).trim());
    if (path === "") continue;
    rows.push({ path, status: porcelainStatus(line.slice(0, 2)) });
  }
  return rows;
}

/**
 * `git diff --numstat HEAD` → ± counts, keyed by exact path. Renames
 * (`old => new`, `dir/{old => new}.ts`) and binaries (`-`) sit no count —
 * the caller leaves those rows' ± null instead of guessing a size.
 */
export function numstatCounts(output: string): Record<string, { added: number; removed: number }> {
  const counts: Record<string, { added: number; removed: number }> = {};
  for (const line of output.split(/\r?\n/)) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const [adds = "", removes = ""] = fields;
    const path = fields.slice(2).join("\t");
    if (adds === "-" || removes === "-" || path.includes(" => ")) continue;
    const added = Number(adds);
    const removed = Number(removes);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;
    counts[path] = { added, removed };
  }
  return counts;
}

/** Row-for-row equality — the recount's only guard against a needless emit. */
export function sameChangedFiles(a: ChangedFileLite[], b: ChangedFileLite[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        row.path === other.path &&
        row.status === other.status &&
        row.added === other.added &&
        row.removed === other.removed
      );
    })
  );
}
