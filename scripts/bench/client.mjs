/**
 * 데몬과 이야기하는 WebSocket 클라이언트 — Node 22 의 전역 WebSocket 만 쓴다.
 * 접속하면 `hello` 를 기다리고, `request(msg)` 는 같은 id 의 `ok` / `error` 를
 * 기다린다. `session.state` · `session.event` 는 구독자에게 그대로 넘긴다.
 */

export class BenchClient {
  #ws;
  #seq = 0;
  #pending = new Map();
  #listeners = new Set();
  hello = null;

  /** connect() 가 new 하고 hello 를 기다린다 — 직접 만들지 않는다. */
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return; // 데몬이 보내지 않는 바이너리 등은 벤치의 몫이 아니다.
      }
      if (message === null || typeof message !== "object") return;
      if (message.type === "ok" || message.type === "error") {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.type === "ok") pending.resolve(message.data);
        else pending.reject(new Error(message.message ?? "daemon error"));
        return;
      }
      if (message.type === "hello") this.hello = message;
      for (const listener of this.#listeners) listener(message);
    });
    ws.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("데몬과의 연결이 끊겼습니다"));
      }
      this.#pending.clear();
    });
    ws.addEventListener("error", () => {
      // close 이벤트가 뒤따르며 걸린 요청을 정리한다 — 여기서는 더 할 게 없다.
    });
  }

  /**
   * 데몬 명령 하나 — id 를 붙여 보내고 같은 id 의 ok/error 를 기다린다.
   * `timeoutMs` 를 주면 그 시간 안에 답이 없으면 거절한다(기본 무기한 —
   * session.create 처럼 긴 명령이 벤치 상한이 치른다).
   */
  request(message, { timeoutMs } = {}) {
    const id = message.id ?? `bench-${++this.#seq}`;
    const payload = { ...message, id };
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error(`명령 ${message.type} 이 ${timeoutMs}ms 안에 답하지 않았습니다`));
            }, timeoutMs);
      this.#pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  /** session.state · session.event 같은 방송의 구독자를 단다. 해제를 돌려준다. */
  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // 이미 닫힌 소켓은 닫을 것도 없다.
    }
  }
}

/**
 * url 로 붙어 hello 를 기다린다. `hello` 는 접속 직후 데몬이 보내는 첫
 * 방송이다 — 그걸 보기 전에는 어떤 명령도 보내지 않는다.
 */
export async function connect(url, { timeoutMs = 15_000 } = {}) {
  const ws = new WebSocket(url);
  const client = new BenchClient(ws);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${timeoutMs}ms 안에 데몬의 hello 가 오지 않았습니다 — ${url}`));
    }, timeoutMs);
    const offError = () => {
      clearTimeout(timer);
      reject(new Error(`데몬에 붙지 못했습니다 — ${url}`));
    };
    ws.addEventListener("error", offError, { once: true });
    ws.addEventListener("close", () => {}, { once: true });
    const off = client.onEvent((message) => {
      if (message.type !== "hello") return;
      clearTimeout(timer);
      ws.removeEventListener("error", offError);
      off();
      resolve();
    });
  });
  return client;
}
