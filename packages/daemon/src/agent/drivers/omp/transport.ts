import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

type Wire = Record<string, any>;

/** The v1 physical frame ceiling the server advertises; a floor for our own guard. */
const DEFAULT_MAX_REASSEMBLED = 64 * 1024 * 1024;

/**
 * One omp RPC connection (`omp --mode rpc-ui`) over stdio. The protocol is
 * command/response/event JSONL: the client writes `{id?, type, …}` commands,
 * the agent answers `{type:"response", id, command, success, data|error}` and
 * streams frames (`message_update`, `tool_execution_*`, `agent_end`,
 * `extension_ui_request`, `host_tool_call`, …) unprompted.
 *
 * The transport owns no protocol knowledge — command names and frame types
 * are opaque. What it guarantees:
 *
 * - `ready` is awaited before the first command leaves, and protocol v2 is
 *   negotiated on it, so oversized frames arrive losslessly as `rpc_chunk`
 *   sequences instead of being truncated by the 1 MiB v1 fallback.
 * - `rpc_chunk` sequences are validated (chunkId · index · count ·
 *   byteLength, no interleaving, reassembly ceiling) and re-parsed into the
 *   single logical frame they carried.
 * - One in-flight map keyed by `id`, and a single `onEnd` when the pipe dies.
 */
export class OmpRpcTransport {
  private readonly proc: ChildProcess;
  private readonly lines: Interface;
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (value: Wire) => void; reject: (error: Error) => void }
  >();
  private ended = false;
  /** Resolves on the `ready` frame (after v2 negotiation), rejects if the pipe dies first. */
  private readonly readyGate: Promise<void>;
  private openReadyGate: (() => void) | null = null;
  private failReadyGate: ((error: Error) => void) | null = null;
  private maxReassembled = DEFAULT_MAX_REASSEMBLED;
  /** The `rpc_chunk` sequence being reassembled — at most one at a time. */
  private chunks: { id: string; count: number; bytes: number; parts: Buffer[] } | null = null;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    private readonly handlers: {
      /** A frame that is neither a response nor chunk plumbing. */
      onFrame: (frame: Wire) => void;
      /** The pipe closed or the process exited — once, either way. */
      onEnd: (exitCode: number | null) => void;
      /** The agent's own stderr, for the daemon log. */
      onStderr?: (text: string) => void;
    },
  ) {
    this.readyGate = new Promise<void>((resolve, reject) => {
      this.openReadyGate = resolve;
      this.failReadyGate = reject;
    });
    this.proc = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.proc.stderr?.on("data", (data: Buffer) => this.handlers.onStderr?.(data.toString()));
    // An EPIPE racing the agent's exit must not become an uncaughtException.
    this.proc.stdin?.on("error", () => undefined);
    this.lines = createInterface({ input: this.proc.stdout ?? process.stdin });
    this.lines.on("line", (line) => this.onLine(line));
    const end = (exitCode: number | null) => {
      if (this.ended) return;
      this.ended = true;
      const dead = new Error("omp transport closed");
      for (const [, waiter] of this.pending) waiter.reject(dead);
      this.pending.clear();
      this.failReadyGate?.(dead);
      this.failReadyGate = null;
      this.openReadyGate = null;
      this.handlers.onEnd(exitCode);
    };
    this.proc.on("exit", (code) => end(code));
    this.proc.on("error", () => end(null));
    // An unobserved rejection here would be an unhandled rejection the moment
    // a transport dies before anyone awaits it.
    this.readyGate.catch(() => undefined);
  }

  /** The `ready` frame has landed and protocol v2 is negotiated. */
  ready(): Promise<void> {
    return this.readyGate;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: Wire;
    try {
      frame = JSON.parse(trimmed) as Wire;
    } catch {
      // A malformed line is the server's problem, not a reason to tear the
      // pipe down — the spec's own parse errors keep the loop alive too.
      return;
    }
    if (frame?.type === "rpc_chunk") {
      const whole = this.absorbChunk(frame);
      if (whole) this.dispatch(whole);
      return;
    }
    this.dispatch(frame);
  }

  /**
   * One `rpc_chunk` of a lossless v2 sequence. Returns the reassembled frame
   * on the last chunk, null while the sequence is still arriving. A violated
   * sequence (interleaved id, out-of-order index, length mismatch, ceiling)
   * is dropped whole — half a frame is worse than none.
   */
  private absorbChunk(frame: Wire): Wire | null {
    const id = String(frame.chunkId ?? "");
    const index = Number(frame.index);
    const count = Number(frame.count);
    const byteLength = Number(frame.byteLength);
    const data = typeof frame.data === "string" ? frame.data : "";
    const fresh = index === 0;
    if (!id || !Number.isInteger(index) || !Number.isInteger(count) || count <= 0) {
      this.chunks = null;
      return null;
    }
    if (fresh) {
      if (byteLength > this.maxReassembled) {
        this.chunks = null;
        return null;
      }
      this.chunks = { id, count, bytes: byteLength, parts: [] };
    }
    const open = this.chunks;
    if (!open || open.id !== id || open.count !== count || open.parts.length !== index) {
      this.chunks = null;
      return null;
    }
    open.parts.push(Buffer.from(data, "base64"));
    if (open.parts.length < count) return null;
    this.chunks = null;
    const whole = Buffer.concat(open.parts);
    if (whole.byteLength !== open.bytes) return null;
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(whole)) as Wire;
    } catch {
      return null;
    }
  }

  private dispatch(frame: Wire): void {
    if (frame?.type === "ready") {
      if (Number.isFinite(frame.maxReassembledFrameBytes)) {
        this.maxReassembled = Number(frame.maxReassembledFrameBytes);
      }
      const v2 = Array.isArray(frame.supportedProtocolVersions)
        ? frame.supportedProtocolVersions.includes(2)
        : false;
      const open = this.openReadyGate;
      this.openReadyGate = null;
      this.failReadyGate = null;
      if (!v2) {
        open?.();
        return;
      }
      // Negotiation is the last thing between `ready` and the first command:
      // a v1 stream truncates any frame over 1 MiB, and a `read` result or a
      // screenshot passes that line routinely.
      this.command("negotiate_protocol", { protocolVersion: 2 }, 10_000)
        .catch(() => undefined)
        .then(() => open?.());
      return;
    }
    if (frame?.type === "response") {
      const id = frame.id;
      if (typeof id !== "string") return;
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (frame.success === true) {
        waiter.resolve((frame.data ?? {}) as Wire);
      } else {
        waiter.reject(new Error(String(frame.error ?? `${String(frame.command)} failed`)));
      }
      return;
    }
    this.handlers.onFrame(frame);
  }

  write(message: Wire): void {
    if (this.ended || !this.proc.stdin?.writable) return;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * A client → agent command; resolves with the response's `data` (or `{}`)
   * and rejects on `success: false` or transport death. Every omp command
   * answers on acceptance — `prompt` included — so every call is bounded: a
   * wedged agent that never answers must not hang an interrupt forever.
   */
  command<T = Wire>(type: string, params?: Wire, timeoutMs = 30_000): Promise<T> {
    if (this.ended) return Promise.reject(new Error("omp transport closed"));
    const id = `req-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`omp ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value: Wire) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ id, type, ...(params ?? {}) });
    });
  }

  get alive(): boolean {
    return !this.ended;
  }

  /** Kill the process; `onEnd` still fires so the session settles once. */
  close(): void {
    if (this.ended) return;
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // Already gone — the exit handler reports it.
    }
    setTimeout(() => {
      try {
        if (!this.ended) this.proc.kill("SIGKILL");
      } catch {
        // Nothing left to kill.
      }
    }, 3000).unref();
  }
}
