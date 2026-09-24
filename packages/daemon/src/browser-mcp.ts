/**
 * 인앱 브라우저 도구의 stdio MCP 서버 (인앱 브라우저 전환 3단계).
 *
 * claude·acp·codex 세션이 이 프로세스를 MCP 서버로 띄운다 — 기동 명세는
 * browser-launch.ts가 프로바이더별 와이어 형태(claude 레코드 / acp 배열 /
 * codex config 객체)로 빌드한다. 서버는 도구 호출을 데몬의 `/internal/browser`
 * 엔드포인트로 중계할 뿐이다. 상태 없음: 탭과 스냅샷의 진실은 데몬과 pane이
 * 소유하고, 여기는 와이어 번역만 한다.
 *
 * - env: COLO_DAEMON_URL (예: http://127.0.0.1:7823), COLO_BROWSER_SECRET
 *   (세션별 시크릿 — 데몬이 세션을 열 때 발급한다). 시크릿이 세션 스코프라
 *   이 프로세스는 자기 세션의 브라우저만 본다.
 * - 프로토콜: stdio 위 줄 단위 JSON-RPC 2.0 — initialize,
 *   notifications/initialized, tools/list, tools/call, ping. MCP SDK를 끌지
 *   않는다(의존성 없음): 이 파일은 데몬 번들과 분리된 별도 엔트리다.
 * - 실패도 도구 결과다: 데몬의 ok:false·401·404와 도달 실패는 모두 isError
 *   텍스트로 내려가 턴을 죽이는 대신 모델이 읽고 고치게 한다. 스냅샷 첨부
 *   (모든 액션 도구의 결과에 새 스냅샷)은 데몬 쪽 드라이버 계약이 담당한다.
 */

// 이 진입점의 stdout 은 JSON-RPC 전용 채널이다 — 어떤 콘솔 출력보다 먼저 경계를
// 세운다(ESM import 순서상 이 모듈의 몸통이 아래 의존성들보다 먼저 돈다).
import "./stderr-console.js";

import { createInterface } from "node:readline";
import {
  BROWSER_TOOLS,
  type BrowserRelay,
  callBrowserTool,
  text,
  type Wire,
} from "./browser-tools.js";

const daemonUrl = process.env.COLO_DAEMON_URL;
const secret = process.env.COLO_BROWSER_SECRET;
if (!daemonUrl || !secret) {
  console.error(
    "COLO_DAEMON_URL·COLO_BROWSER_SECRET 환경 변수가 필요하다 — 이 프로세스는 데몬이 띄우는 MCP 자식이다.",
  );
  process.exit(1);
}
/** 좁혀진 좌표 — 게이트 뒤라 둘 다 있다. `handle` 은 이 값만 본다. */
const relay: BrowserRelay = { daemonUrl, secret };

function send(message: Wire): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function answer(id: string | number | null, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function refuse(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message: Wire): Promise<void> {
  const params = (message.params ?? {}) as Wire;
  // 알림(id 없음 — notifications/initialized 포함)은 응답하지 않는다.
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      // 클라이언트가 제안한 프로토콜 버전을 그대로 따른다 — 협상의 한쪽
      // 절반을 서버가 굳히면 낡은 클라이언트와 악수가 깨진다.
      answer(message.id as string | number | null, {
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "colo-browser", title: "콜로디자인 인앱 브라우저", version: "0" },
        instructions:
          "인앱 브라우저 도구 — 사용자가 보고 있는 페이지를 드라이브한다. browser_snapshot의 ref로 " +
          "요소를 가리키며, 모든 액션의 결과에 새 스냅샷이 실려 온다.",
      });
      return;
    case "notifications/initialized":
      return;
    case "ping":
      answer(message.id as string | number | null, {});
      return;
    case "tools/list":
      answer(message.id as string | number | null, {
        tools: BROWSER_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: "object",
            properties: tool.properties,
            ...(tool.required?.length ? { required: tool.required } : {}),
          },
        })),
      });
      return;
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = BROWSER_TOOLS.find((candidate) => candidate.name === name);
      if (!tool) {
        // 모르는 도구도 프로토콜 오류가 아니라 도구 결과로 — 모델이 목록을
        // 다시 읽고 고칠 수 있어야 한다.
        answer(
          message.id as string | number | null,
          text(`알 수 없는 도구: ${name || "(이름 없음)"}`, true),
        );
        return;
      }
      answer(
        message.id as string | number | null,
        await callBrowserTool(tool, (params.arguments ?? {}) as Wire, relay),
      );
      return;
    }
    default:
      refuse(
        message.id as string | number | null,
        -32601,
        `Method not found: ${String(message.method)}`,
      );
  }
}

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Wire;
  try {
    message = JSON.parse(trimmed) as Wire;
  } catch {
    refuse(null, -32700, "Parse error");
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    refuse(null, -32600, "Invalid Request");
    return;
  }
  void handle(message).catch((error: unknown) => {
    if (message.id !== undefined) {
      refuse(
        message.id as string | number | null,
        -32603,
        `Internal error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
});
lines.on("close", () => process.exit(0));
