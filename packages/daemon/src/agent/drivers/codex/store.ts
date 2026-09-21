import type { Dirent } from "node:fs";
import { type FileHandle, open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "@colo-design/protocol";

type Wire = Record<string, any>;

/** `$CODEX_HOME` when set, else `~/.codex` — the CLI's own root. */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export interface RolloutMeta {
  id: string;
  cwd: string;
  timestamp: string;
}

/**
 * Rollout files live at `sessions/YYYY/MM/DD/rollout-*.jsonl`, newest dates
 * first. `session_meta` is always line one, but it carries the full base
 * instructions — tens of KB — so a truncated first-line read falls back to
 * the streaming reader rather than failing.
 */
export async function listRolloutFiles(root: string, cap = 2000): Promise<string[]> {
  const sessions = join(root, "sessions");
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= cap || depth > 3) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Directory names sort chronologically (YYYY < MM < DD); files too.
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (out.length >= cap) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  await walk(sessions, 0);
  return out;
}

/**
 * session_meta reads are the sweep's whole cost — one 256KB head read per
 * file, per scan, over a store that grows for years (2,988 rollouts ≈ 15s
 * on one machine). The daemon rescans on every session event, and the same
 * files answer every time: memoize by (mtime, size) so a rescan costs one
 * stat per file and only brand-new rollouts pay the read.
 */
const metaMemo = new Map<string, { key: string; meta: RolloutMeta | null }>();
const META_MEMO_CAP = 6000;

export async function readSessionMeta(path: string): Promise<RolloutMeta | null> {
  let key: string;
  try {
    const s = await stat(path);
    key = `${s.mtimeMs}:${s.size}`;
  } catch {
    // Gone from disk — a memoized answer for a missing file is a lie.
    metaMemo.delete(path);
    return null;
  }
  const hit = metaMemo.get(path);
  if (hit && hit.key === key) return hit.meta;
  const meta = await readSessionMetaFromDisk(path);
  if (metaMemo.size >= META_MEMO_CAP) metaMemo.clear();
  metaMemo.set(path, { key, meta });
  return meta;
}

/** Line one, parsed — null when the file is not a rollout or unreadable. */
async function readSessionMetaFromDisk(path: string): Promise<RolloutMeta | null> {
  let first: string | null = null;
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline > 0) first = buffer.subarray(0, newline).toString("utf8");
  } catch {
    first = null;
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // Nothing to close.
      }
    }
  }
  if (first === null) {
    try {
      first = (await readFile(path, "utf8")).split("\n", 1)[0] ?? null;
    } catch {
      return null;
    }
  }
  if (!first) return null;
  try {
    const line = JSON.parse(first) as Wire;
    if (line.type !== "session_meta") return null;
    const payload = (line.payload ?? {}) as Wire;
    const id = String(payload.id ?? payload.session_id ?? "");
    const cwd = String(payload.cwd ?? "");
    if (!id || !cwd) return null;
    return { id, cwd, timestamp: String(payload.timestamp ?? line.timestamp ?? "") };
  } catch {
    return null;
  }
}

/** The rollout file for a stored thread id — the id is the filename's tail. */
export async function findRollout(root: string, id: string): Promise<string | null> {
  for (const path of await listRolloutFiles(root)) {
    if (path.includes(id)) return path;
  }
  return null;
}

export async function readRolloutLines(path: string): Promise<Wire[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const lines: Wire[] = [];
  for (const text of raw.split("\n")) {
    if (!text.trim()) continue;
    try {
      lines.push(JSON.parse(text) as Wire);
    } catch {
      // A torn tail line is not a reason to drop the whole tape.
    }
  }
  return lines;
}

/**
 * Injected context rides as user-role `input_text` blocks — AGENTS.md dumps,
 * `<permissions instructions>`, `<collaboration_mode>`, `<app-context>`. A
 * block is real user text only when it does not open with a wrapper.
 */
function isInjectedText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<") || trimmed.startsWith("# AGENTS.md");
}

/** The plain user text a message payload carries — "" when fully injected. */
function userMessageText(payload: Wire): string {
  const content = Array.isArray(payload.content) ? (payload.content as Wire[]) : [];
  return content
    .filter((block) => block?.type === "input_text" || block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .filter((text) => text.trim() && !isInjectedText(text))
    .join("\n")
    .trim();
}

/** item_completed items arrive PascalCase in rollouts, camelCase on the wire. */
function normalizeItemType(type: unknown): string {
  const raw = String(type ?? "");
  if (raw === "UserMessage") return "userMessage";
  if (raw === "AgentMessage") return "agentMessage";
  if (raw === "Reasoning") return "reasoning";
  if (raw === "McpToolCall") return "mcpToolCall";
  return raw;
}

export interface StoredPrompt {
  text: string;
  /** The turn this prompt opened — from item_completed or turn_context. */
  turnId: string | null;
}

/**
 * The user prompts of a rollout, in order. `response_item` user messages are
 * the canonical record; `event_msg/item_completed` UserMessage entries carry
 * the turn id directly, and `turn_context` lines name the turn right after
 * the prompt. Consecutive duplicates (the same prompt seen through two
 * envelopes) merge, preferring the entry that knows its turn.
 */
export async function collectPrompts(lines: Wire[]): Promise<StoredPrompt[]> {
  const prompts: StoredPrompt[] = [];
  let pendingTurnId: string | null = null;
  let awaitingContext = false;
  for (const line of lines) {
    const payload = (line.payload ?? {}) as Wire;
    if (line.type === "event_msg" && payload.type === "task_started") {
      pendingTurnId = typeof payload.turn_id === "string" ? payload.turn_id : pendingTurnId;
      continue;
    }
    if (line.type === "turn_context") {
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
      if (awaitingContext && prompts.length > 0 && turnId) {
        prompts[prompts.length - 1]!.turnId = turnId;
      }
      pendingTurnId = turnId ?? pendingTurnId;
      awaitingContext = false;
      continue;
    }
    if (line.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const text = userMessageText(payload);
      if (!text) continue;
      prompts.push({ text, turnId: pendingTurnId });
      pendingTurnId = null;
      awaitingContext = true;
      continue;
    }
    if (line.type === "event_msg" && payload.type === "item_completed") {
      const item = (payload.item ?? {}) as Wire;
      if (normalizeItemType(item.type) !== "userMessage") continue;
      const text = userMessageText(item);
      if (!text) continue;
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
      const last = prompts[prompts.length - 1];
      if (last && last.text === text) {
        // Same prompt through the second envelope — keep the turn id.
        if (!last.turnId && turnId) last.turnId = turnId;
      } else {
        prompts.push({ text, turnId });
        awaitingContext = true;
      }
      continue;
    }
    if (line.type === "event_msg" && payload.type === "user_message") {
      const text = String(payload.message ?? payload.text ?? "").trim();
      if (!text || isInjectedText(text)) continue;
      const last = prompts[prompts.length - 1];
      if (!last || last.text !== text) {
        prompts.push({ text, turnId: pendingTurnId });
        pendingTurnId = null;
        awaitingContext = true;
      }
    }
  }
  return prompts;
}

/**
 * Replay a rollout as ChatEvents. Messages ride BOTH envelopes — codex
 * writes `response_item` and `event_msg/item_completed` for the same turn,
 * adjacently and in either order — so each message is emitted once and the
 * twin suppressed by comparing against the tail of `out`. Reading both is
 * what keeps the replayed transcript in step with `collectPrompts`, which
 * also counts either envelope: a prompt the branch UI can number must be a
 * prompt the transcript shows. `item_completed` additionally carries the
 * item kinds `response_item` never persists (commandExecution, fileChange,
 * mcpToolCall) — PascalCase there, camelCase on the wire.
 */
export async function replayRollout(lines: Wire[]): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  let blockSeq = 0;
  /** The twin envelope repeats the message we just emitted — drop it. */
  const isTwin = (kind: "user.echo" | "text.done", text: string): boolean => {
    const previous = out[out.length - 1];
    return previous?.kind === kind && previous.text === text;
  };
  for (const line of lines) {
    const payload = (line.payload ?? {}) as Wire;
    // 재생되는 도구 행의 경과 시계가 대화록의 시각에서 이어지도록.
    const lineAt = Date.parse(String(line.timestamp ?? ""));
    const startedAt = Number.isFinite(lineAt) ? { startedAt: lineAt } : {};
    if (line.type === "response_item") {
      switch (payload.type) {
        case "message": {
          const role = String(payload.role ?? "");
          const content = Array.isArray(payload.content) ? (payload.content as Wire[]) : [];
          if (role === "user") {
            const text = userMessageText(payload);
            if (text && !isTwin("user.echo", text)) {
              out.push({ kind: "user.echo", text, images: 0 });
            }
            break;
          }
          if (role !== "assistant") break;
          const text = content
            .filter((block) => block?.type === "output_text" || block?.type === "text")
            .map((block) => String(block.text ?? ""))
            .join("");
          if (text.trim() && !isTwin("text.done", text)) {
            out.push({
              kind: "text.done",
              blockId: `codex:${payload.id ?? `b${blockSeq++}`}`,
              text,
              agentId: null,
            });
          }
          break;
        }
        case "reasoning": {
          const parts = [
            ...(Array.isArray(payload.summary) ? (payload.summary as Wire[]) : []),
            ...(Array.isArray(payload.content) ? (payload.content as Wire[]) : []),
          ]
            .map((part) => String(part?.text ?? ""))
            .filter(Boolean);
          if (parts.length > 0) {
            out.push({
              kind: "thinking.delta",
              blockId: `codex:${payload.id ?? `r${blockSeq++}`}`,
              text: parts.join("\n"),
              agentId: null,
            });
          }
          break;
        }
        case "function_call":
        case "custom_tool_call": {
          const callId = String(payload.call_id ?? payload.id ?? `c${blockSeq++}`);
          const name = String(payload.name ?? "tool");
          let input: unknown = payload.arguments ?? payload.input ?? {};
          if (typeof input === "string") {
            try {
              input = JSON.parse(input);
            } catch {
              // Keep the raw string — the card shows it fine.
            }
          }
          out.push({
            kind: "tool.start",
            toolUseId: callId,
            name,
            input,
            agentId: null,
            ...startedAt,
          });
          break;
        }
        case "function_call_output":
        case "custom_tool_call_output": {
          const callId = String(payload.call_id ?? "");
          if (!callId) break;
          out.push({
            kind: "tool.end",
            toolUseId: callId,
            isError: false,
            content: payload.output ?? null,
            agentId: null,
          });
          break;
        }
        case "web_search_call": {
          const callId = String(payload.id ?? `w${blockSeq++}`);
          const query = String(payload.action?.query ?? "");
          out.push({
            kind: "tool.start",
            toolUseId: callId,
            name: "webSearch",
            input: { query },
            agentId: null,
            ...startedAt,
          });
          out.push({
            kind: "tool.end",
            toolUseId: callId,
            isError: payload.status === "failed",
            content: payload.action ?? null,
            agentId: null,
          });
          break;
        }
        default:
          break;
      }
      continue;
    }
    if (line.type === "event_msg" && payload.type === "item_completed") {
      const item = (payload.item ?? {}) as Wire;
      const type = normalizeItemType(item.type);
      const id = String(item.id ?? `i${blockSeq++}`);
      // Messages ride both envelopes; whichever lands first wins and the
      // twin is suppressed. The rest are the kinds response_item never has.
      if (type === "userMessage") {
        const text = userMessageText(item);
        if (text && !isTwin("user.echo", text)) {
          out.push({ kind: "user.echo", text, images: 0 });
        }
      } else if (type === "agentMessage") {
        // The wire item carries flat `text`; rollouts write `content` blocks.
        const text =
          typeof item.text === "string"
            ? item.text
            : (Array.isArray(item.content) ? (item.content as Wire[]) : [])
                .map((block) => String(block?.text ?? ""))
                .join("");
        if (text.trim() && !isTwin("text.done", text)) {
          out.push({ kind: "text.done", blockId: `codex:${id}`, text, agentId: null });
        }
      } else if (type === "commandExecution") {
        out.push({
          kind: "tool.start",
          toolUseId: id,
          name: "commandExecution",
          input: { command: item.command ?? "", cwd: item.cwd ?? null },
          agentId: null,
          ...startedAt,
        });
        const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
        out.push({
          kind: "tool.end",
          toolUseId: id,
          isError: item.status === "failed" || item.status === "declined" || (exitCode ?? 0) !== 0,
          content: item.aggregatedOutput ?? null,
          agentId: null,
        });
      } else if (type === "fileChange") {
        out.push({
          kind: "tool.start",
          toolUseId: id,
          name: "fileChange",
          input: { changes: item.changes ?? [] },
          agentId: null,
          ...startedAt,
        });
        out.push({
          kind: "tool.end",
          toolUseId: id,
          isError: item.status === "failed" || item.status === "declined",
          content: item.changes ?? null,
          agentId: null,
        });
      } else if (type === "mcpToolCall") {
        out.push({
          kind: "tool.start",
          toolUseId: id,
          name: `${item.server ?? "mcp"}/${item.tool ?? "tool"}`,
          input: item.arguments ?? {},
          agentId: null,
          ...startedAt,
        });
        out.push({
          kind: "tool.end",
          toolUseId: id,
          isError: item.status === "failed" || item.error != null,
          content: item.error ?? item.result ?? null,
          agentId: null,
        });
      }
    }
  }
  return out;
}
