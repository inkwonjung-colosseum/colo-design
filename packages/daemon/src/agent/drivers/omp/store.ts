import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ChatEvent } from "@colo-design/protocol";
import type { ImportableSession, RewindCutoff } from "../../driver.js";

type Wire = Record<string, any>;

/**
 * The omp transcript store: `~/.omp/agent/sessions/<encoded-cwd>/`. Each
 * session is one JSONL file named `<timestamp>_<sessionId>.jsonl`; a
 * `session` header line carries the cwd, the rest are entries in an
 * append-only tree (`id`/`parentId`).
 *
 * The encoding mirrors the CLI's own session dir naming: strip the
 * leading slash, turn every `/ \ :` into `-`, wrap in `--…--`.
 */
function sessionDirFor(agentDir: string, cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // The clone may not exist yet — encode the spelling we were given.
  }
  const safe = `--${resolve(real)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
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

function loadFile(path: string): StoredFile | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
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
    mtime = statSync(path).mtimeMs;
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
function branchEntries(file: StoredFile): Wire[] {
  const byId = new Map<string, Wire>();
  for (const entry of file.entries) {
    if (typeof entry?.id === "string") byId.set(entry.id, entry);
  }
  // The leaf is the last entry in append order — the file is append-only.
  let leaf: Wire | null = file.entries[file.entries.length - 1] ?? null;
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

function titleOf(file: StoredFile): string {
  const name = file.entries.find((e) => e?.type === "session_name" || e?.type === "name");
  if (typeof (name as Wire | undefined)?.name === "string" && (name as Wire).name.trim()) {
    return String((name as Wire).name);
  }
  const first = branchEntries(file).find(isPrompt);
  const text = first ? promptText(first).trim() : "";
  return text ? text.slice(0, 80) : "제목 없는 대화";
}

export function listStoredSessions(
  agentDir: string,
  provider: string,
  cwd: string,
  limit = 50,
): ImportableSession[] {
  const dir = sessionDirFor(agentDir, cwd);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const rows: ImportableSession[] = [];
  for (const name of names) {
    const file = loadFile(join(dir, name));
    if (!file?.id) continue;
    rows.push({
      id: file.id,
      title: titleOf(file),
      lastModified: file.mtime,
      provider,
    });
  }
  return rows.sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
}

function findFile(agentDir: string, cwd: string, id: string): StoredFile | null {
  const dir = sessionDirFor(agentDir, cwd);
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  for (const name of names) {
    const file = loadFile(join(dir, name));
    if (file?.id === id) return file;
    // The id is also the filename suffix — a cheap second chance when the
    // header's id field moved.
    if (name.endsWith(`_${id}.jsonl`)) return file;
  }
  return null;
}

export function storedSessionTitle(agentDir: string, cwd: string, id: string): string | null {
  const file = findFile(agentDir, cwd, id);
  return file ? titleOf(file) : null;
}

export function deleteStoredSession(agentDir: string, cwd: string, id: string): void {
  const file = findFile(agentDir, cwd, id);
  if (file) rmSync(file.path, { force: true });
}

export function storedPromptCount(agentDir: string, cwd: string, id: string): number {
  const file = findFile(agentDir, cwd, id);
  if (!file) return 0;
  return branchEntries(file).filter(isPrompt).length;
}

/**
 * 되감기의 절단점: the k-th prompt's own entry id is the fork point —
 * omp's `branch` keeps everything BEFORE that entry and hands its text
 * back for resending, which is exactly "drop this answer, keep the memory
 * before it".
 */
export function resolveOmpRewindCutoff(
  agentDir: string,
  cwd: string,
  id: string,
  turn: number,
): RewindCutoff | null {
  const file = findFile(agentDir, cwd, id);
  if (!file) return null;
  const branch = branchEntries(file);
  const prompts = branch.filter(isPrompt);
  if (turn < 1 || turn > prompts.length) return null;
  const target = prompts[turn - 1] ?? {};
  return {
    cut: typeof target.id === "string" ? target.id : null,
    drops: typeof target.id === "string" ? target.id : null,
    answerCount: prompts.length,
  };
}

/**
 * Replay a stored session as ChatEvents. Entries hold whole messages —
 * text, thinking, tool calls already complete — so like the other
 * importers this emits finished blocks, not deltas.
 */
export function replayOmpSession(agentDir: string, cwd: string, id: string): ChatEvent[] {
  const file = findFile(agentDir, cwd, id);
  if (!file) return [];
  const out: ChatEvent[] = [];
  const toolNames = new Map<string, string>();

  for (const entry of branchEntries(file)) {
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
