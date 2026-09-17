import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

type Wire = Record<string, any>;

/**
 * One omp RPC connection (`omp --mode rpc`) over stdio. The protocol is
 * command/response/event JSONL: the client writes `{type, id?, ...}`
 * commands, the agent answers `{type:"response", id, command, success,
 * data|error}` and streams events (`message_update`, `tool_execution_*`,
 * `agent_end`, …) unprompted.
 *
 * `extension_ui_request` frames are agent→client requests from extensions;
 * they carry an id and expect `extension_ui_response` back.
 *
 * The transport owns no protocol knowledge — command names and event types
 * are opaque. What it guarantees: one in-flight map keyed by `id`, strict
 * LF framing (the spec forbids generic line readers), and a single `onEnd`
 * when the pipe dies.
 */
export class OmpTransport {
  private readonly proc: ChildProcess;
  private readonly lines: Interface;
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (value: Wire) => void; reject: (error: Error) => void }
  >();
  private ended = false;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    private readonly handlers: {
      /** An event frame (anything that is not a response or ui request). */
      onEvent: (frame: Wire) => void;
      /**
       * An extension asked for UI. The return value becomes the
       * `extension_ui_response` payload — return `{cancelled: true}` to
       * refuse politely.
       */
      onUiRequest: (frame: Wire) => Promise<Wire>;
      /** The pipe closed or the process exited — once, either way. */
      onEnd: (exitCode: number | null) => void;
    },
  ) {
    this.proc = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
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
        waiter.reject(new Error("pi transport closed"));
      }
      this.pending.clear();
      this.handlers.onEnd(exitCode);
    };
    this.proc.on("exit", (code) => end(code));
    this.proc.on("error", () => end(null));
  }

  private onLine(line: string): void {
    let frame: Wire;
    try {
      frame = JSON.parse(line);
    } catch {
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
    if (frame?.type === "extension_ui_request" && typeof frame.id === "string") {
      void this.answerUiRequest(frame);
      return;
    }
    this.handlers.onEvent(frame);
  }

  private async answerUiRequest(frame: Wire): Promise<void> {
    try {
      const payload = await this.handlers.onUiRequest(frame);
      this.write({ type: "extension_ui_response", id: frame.id, ...payload });
    } catch {
      this.write({ type: "extension_ui_response", id: frame.id, cancelled: true });
    }
  }

  private write(message: Wire): void {
    if (this.ended || !this.proc.stdin?.writable) return;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * A client → agent command; resolves with the response's `data` (or `{}`)
   * and rejects on `success: false` or transport death. `timeoutMs` bounds
   * control-plane calls — a wedged agent that never answers must not hang
   * an interrupt forever. Omit it for turn-length commands (`prompt`).
   */
  command<T = Wire>(type: string, params?: Wire, timeoutMs?: number): Promise<T> {
    if (this.ended) return Promise.reject(new Error("pi transport closed"));
    const id = `req-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`omp ${type} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
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
