import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ChatEvent } from "@colo-design/protocol";
import type { ImportableSession } from "../../driver.js";

type Wire = Record<string, any>;

/**
 * The omp transcript store: `~/.omp/agent/sessions/<encoded-cwd>/`. Each
 * session is one JSONL file named `<timestamp>_<sessionId>.jsonl`; a
 * `title` line precedes the `session` header line, which carries the cwd;
 * the rest are entries in an append-only tree (`id`/`parentId`).
 *
 * The encoding is the CLI's own (pi-coding-agent's session-dir rule), and it
 * must match byte for byte or every listing comes up empty: realpath the
 * cwd, then — under $HOME → `-<home-relative path>`, under the OS temp dir →
 * `-tmp-<tmp-relative path>`, anywhere else → the old whole-path wrap
 * (`--<path with separators as dashes>--`).
 */
async function sessionDirFor(agentDir: string, cwd: string): Promise<string> {
  let real = cwd;
  try {
    real = await realpath(cwd);
  } catch {
    // omp resolves too; a missing dir encodes as spelled.
  }
  const resolved = resolve(real);
  const section = (value: string): string => value.replace(/[/\\:]/g, "-");
  const under = (base: string): boolean => {
    const rel = relative(base, resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  let temp = tmpdir();
  try {
    temp = await realpath(temp);
  } catch {
    // Without a resolvable temp dir the tmp branch can't be trusted — keep
    // the spelling; omp sees the same env and lands in the same place.
  }
  let name: string;
  if (under(homedir())) {
    const rel = section(relative(homedir(), resolved));
    name = rel ? `-${rel}` : "-";
  } else if (under(temp)) {
    const rel = section(relative(temp, resolved));
    name = rel ? `-tmp-${rel}` : "-tmp";
  } else {
    name = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  }
  return join(agentDir, "sessions", name);
}

export function ompAgentDir(): string {
  return process.env.OMP_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
}

interface StoredFile {
  id: string;
  path: string;
  header: Wire;
  entries: Wire[];
  mtime: number;
}

async function loadFile(path: string): Promise<StoredFile | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  // omp prepends a `title` line before the `session` header — scan the
  // first few lines for it rather than assuming line one.
  let header: Wire | null = null;
  let headerIndex = -1;
  for (let i = 0; i < Math.min(lines.length, 4); i += 1) {
    try {
      const parsed = JSON.parse(lines[i] ?? "{}") as Wire;
      if (parsed?.type === "session") {
        header = parsed;
        headerIndex = i;
        break;
      }
    } catch {
      return null;
    }
  }
  if (!header) return null;
  const entries: Wire[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn write at the tail is not a reason to drop the session.
    }
  }
  let mtime = 0;
  try {
    mtime = (await stat(path)).mtimeMs;
  } catch {
    // Keep 0 — the row sorts last.
  }
  return {
    id: String(header.id ?? ""),
    path,
    header,
    entries,
    mtime,
  };
}

/** The active branch: walk parentId links back from the leaf. */
async function branchEntries(file: StoredFile): Promise<Wire[]> {
  const byId = new Map<string, Wire>();
  for (const entry of file.entries) {
    if (typeof entry?.id === "string") byId.set(entry.id, entry);
  }
  // The leaf is the last entry in append order — the file is append-only. A
  // tail entry without a string id can't anchor the parentId walk, so skip
  // back to the last one that can.
  let leaf: Wire | null = null;
  for (let i = file.entries.length - 1; i >= 0; i--) {
    const entry = file.entries[i];
    if (typeof entry?.id === "string") {
      leaf = entry;
      break;
    }
  }
  const chain: Wire[] = [];
  const seen = new Set<string>();
  while (leaf && typeof leaf.id === "string" && !seen.has(leaf.id)) {
    seen.add(leaf.id);
    chain.unshift(leaf);
    leaf = typeof leaf.parentId === "string" ? (byId.get(leaf.parentId) ?? null) : null;
  }
  return chain;
}

/** A user message that STARTED a turn — not a tool-result carrier. */
function isPrompt(entry: Wire): boolean {
  if (entry?.type !== "message") return false;
  const message = entry.message as Wire | undefined;
  if (message?.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return content.trim() !== "";
  if (Array.isArray(content)) {
    return content.some(
      (block: Wire) => block?.type === "text" && String(block.text ?? "").trim() !== "",
    );
  }
  return false;
}

function promptText(entry: Wire): string {
  const content = (entry.message as Wire | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: Wire) => block?.type === "text")
      .map((block: Wire) => String(block.text ?? ""))
      .join("\n");
  }
  return "";
}

async function titleOf(file: StoredFile): Promise<string> {
  const name = file.entries.find((e) => e?.type === "session_name" || e?.type === "name");
  if (typeof (name as Wire | undefined)?.name === "string" && (name as Wire).name.trim()) {
    return String((name as Wire).name);
  }
  const first = (await branchEntries(file)).find(isPrompt);
  const text = first ? promptText(first).trim() : "";
  return text ? text.slice(0, 80) : "제목 없는 대화";
}

export async function listStoredSessions(
  agentDir: string,
  provider: string,
  cwd: string,
  limit = 50,
): Promise<ImportableSession[]> {
  const dir = await sessionDirFor(agentDir, cwd);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const files = await Promise.all(names.map((name) => loadFile(join(dir, name))));
  const rows: ImportableSession[] = [];
  for (const file of files) {
    if (!file?.id) continue;
    rows.push({
      id: file.id,
      title: await titleOf(file),
      lastModified: file.mtime,
      provider,
    });
  }
  return rows.sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
}

export async function findFile(
  agentDir: string,
  cwd: string,
  id: string,
): Promise<StoredFile | null> {
  const dir = await sessionDirFor(agentDir, cwd);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  for (const name of names) {
    const file = await loadFile(join(dir, name));
    if (file?.id === id) return file;
    // The id is also the filename suffix — a cheap second chance when the
    // header's id field moved.
    if (name.endsWith(`_${id}.jsonl`)) return file;
  }
  return null;
}

export async function storedSessionTitle(
  agentDir: string,
  cwd: string,
  id: string,
): Promise<string | null> {
  const file = await findFile(agentDir, cwd, id);
  return file ? titleOf(file) : null;
}

export async function deleteStoredSession(
  agentDir: string,
  cwd: string,
  id: string,
): Promise<void> {
  const file = await findFile(agentDir, cwd, id);
  if (file) await rm(file.path, { force: true });
}

/** The clone's whole session directory — a removed project's sweep. */
export async function deleteAllStoredSessions(agentDir: string, cwd: string): Promise<void> {
  await rm(await sessionDirFor(agentDir, cwd), { recursive: true, force: true });
}

export async function storedPromptCount(
  agentDir: string,
  cwd: string,
  id: string,
): Promise<number> {
  const file = await findFile(agentDir, cwd, id);
  if (!file) return 0;
  return (await branchEntries(file)).filter(isPrompt).length;
}

/**
 * 분기가 어디를 자르는가 — k 번째 답을 남기려면 그 다음 프롬프트를 버려야
 * 한다. omp 의 `branch{entryId}` 는 지정한 사용자 엔트리와 그 뒤를 전부
 * 버리고 새 세션 id 를 발급하므로(검증됨), 버릴 프롬프트의 엔트리 id 가
 * 드라이버가 받을 값이다 — 계약의 `drops`.
 *
 * 마지막 답에서 분기하면 버릴 프롬프트가 없다: `cut: null` 이 곧 "전부
 * 남긴다"이고, 세션은 `--fork` 로 대화록을 통째 복사해 열린다.
 */
export async function resolveOmpBranchCut(
  agentDir: string,
  cwd: string,
  id: string,
  turn: number,
): Promise<{ cut: string | null; drops: string | null; answerCount: number } | null> {
  const file = await findFile(agentDir, cwd, id);
  if (!file) return null;
  const prompts = (await branchEntries(file)).filter(isPrompt);
  if (turn < 1 || turn > prompts.length) return null;
  const keep = prompts[turn - 1];
  const drop = prompts[turn];
  if (!drop) return { cut: null, drops: null, answerCount: prompts.length };
  return {
    cut: typeof keep?.id === "string" ? keep.id : null,
    drops: typeof drop.id === "string" ? drop.id : null,
    answerCount: prompts.length,
  };
}

/**
 * Replay a stored session as ChatEvents. Entries hold whole messages —
 * text, thinking, tool calls already complete — so like the other
 * importers this emits finished blocks, not deltas.
 */
export async function replayOmpSession(
  agentDir: string,
  cwd: string,
  id: string,
): Promise<ChatEvent[]> {
  const file = await findFile(agentDir, cwd, id);
  if (!file) return [];
  const out: ChatEvent[] = [];
  const toolNames = new Map<string, string>();

  for (const entry of await branchEntries(file)) {
    if (entry?.type !== "message") continue;
    const message = entry.message as Wire | undefined;
    if (!message) continue;

    if (message.role === "user") {
      const content = message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((b: Wire) => b?.type === "text")
                .map((b: Wire) => String(b.text ?? ""))
                .join("\n")
            : "";
      const images = Array.isArray(content)
        ? content.filter((b: Wire) => b?.type === "image").length
        : 0;
      if (text.trim() || images > 0) out.push({ kind: "user.echo", text, images });
      continue;
    }

    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? (message.content as Wire[]) : [];
      content.forEach((block, index) => {
        const blockId = `${String(entry.id)}:b${index}`;
        if (block?.type === "text" && String(block.text ?? "").trim()) {
          out.push({ kind: "text.done", blockId, text: String(block.text), agentId: null });
        } else if (block?.type === "thinking" && typeof block.thinking === "string") {
          out.push({ kind: "thinking.delta", blockId, text: block.thinking, agentId: null });
        } else if (block?.type === "toolCall") {
          const callId = String(block.id ?? blockId);
          toolNames.set(callId, String(block.name ?? "tool"));
          out.push({
            kind: "tool.start",
            toolUseId: callId,
            name: String(block.name ?? "tool"),
            input: (block.arguments ?? {}) as Record<string, unknown>,
            agentId: null,
          });
        }
      });
      continue;
    }

    if (message.role === "toolResult") {
      const callId = String(message.toolCallId ?? "");
      const content = Array.isArray(message.content) ? (message.content as Wire[]) : [];
      const text = content
        .filter((b: Wire) => b?.type === "text")
        .map((b: Wire) => String(b.text ?? ""))
        .join("\n");
      out.push({
        kind: "tool.end",
        toolUseId: callId,
        isError: message.isError === true,
        content: text || null,
        agentId: null,
      });
      toolNames.delete(callId);
    }
  }
  return out;
}
