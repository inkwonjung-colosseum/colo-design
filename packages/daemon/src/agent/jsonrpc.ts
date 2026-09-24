import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

/**
 * One JSON-RPC 2.0 connection over an ACP agent's stdio. ACP is symmetric:
 * the client sends requests (`session/new`, `session/prompt`, …) and the
 * agent sends both notifications (`session/update`) and requests of its own
 * (`session/request_permission`, `fs/read_text_file`), which this transport
 * routes to a caller-supplied handler.
 *
 * The transport owns no protocol knowledge — methods and params are opaque.
 * What it guarantees: one in-flight map, newline-delimited framing, and a
 * single `onEnd` when the pipe dies so the session can decide crash vs close.
 */
export class JsonRpcTransport {
  private readonly proc: ChildProcess;
  private readonly lines: Interface;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private ended = false;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    private readonly handlers: {
      /** Agent → client request; the return value becomes the result. */
      onRequest: (method: string, params: unknown) => Promise<unknown>;
      /** Agent → client notification (`session/update` and friends). */
      onNotify: (method: string, params: unknown) => void;
      /** The pipe closed or the process exited — once, either way. */
      onEnd: (exitCode: number | null) => void;
    },
    /** 자식의 환경 — 기본은 데몬의 것. git 가드(gitGuardEnv)가 여기로 든다. */
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.proc = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    // The agent's own log stream — useful in the daemon log, never parsed.
    this.proc.stderr?.on("data", () => undefined);
    // An EPIPE racing the agent's exit must not become an uncaughtException.
    this.proc.stdin?.on("error", () => undefined);
    this.lines = createInterface({ input: this.proc.stdout ?? process.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    const end = (exitCode: number | null) => {
      if (this.ended) return;
      this.ended = true;
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error("JSON-RPC transport closed"));
      }
      this.pending.clear();
      this.handlers.onEnd(exitCode);
    };
    this.proc.on("exit", (code) => end(code));
    this.proc.on("error", () => end(null));
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // A request carries id + method; a notification method only; a response
    // id + result|error.
    if (typeof message.method === "string" && message.id !== undefined) {
      void this.answerRequest(message);
      return;
    }
    if (typeof message.method === "string") {
      this.handlers.onNotify(message.method, message.params);
      return;
    }
    const id = message.id;
    if (typeof id !== "number") return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (message.error !== undefined) {
      const err = message.error as { code?: number; message?: string };
      waiter.reject(new Error(err?.message ?? `JSON-RPC error ${err?.code ?? "unknown"}`));
    } else {
      waiter.resolve(message.result);
    }
  }

  private async answerRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    try {
      const result = await this.handlers.onRequest(message.method as string, message.params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.ended || !this.proc.stdin?.writable) return;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * A client → agent request; resolves with the result or rejects on
   * error/close. `timeoutMs` bounds control-plane calls — a wedged agent
   * that never answers must not hang an interrupt forever. Omit it for
   * turn-length calls (`session/prompt`, `turn/*` work).
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.ended) return Promise.reject(new Error("JSON-RPC transport closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`JSON-RPC ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  /** A client → agent notification (`session/cancel`). */
  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
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
    // A wedged agent that ignores SIGTERM still has to die.
    setTimeout(() => {
      try {
        if (!this.ended) this.proc.kill("SIGKILL");
      } catch {
        // Nothing left to kill.
      }
    }, 3000).unref();
  }
}
