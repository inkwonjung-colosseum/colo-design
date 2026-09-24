/**
 * 브라우저 MCP 서버의 기동 명세 빌더 (인앱 브라우저 전환 3단계).
 *
 * 데몬이 세션을 열 때 claude·acp·codex에 stdio MCP 서버 하나를 주입한다.
 * 세 프로바이더의 와이어 형태가 달라서(claude 레코드 / acp 배열 / codex
 * config 객체) 주입 명세 하나를 세 형태로 바꿔 주는 게 이 파일의 전부다.
 * 주입 여부는 host가 browserDriverFactory를 주입했는지(데스크톱 앱 여부)가
 * 정하고, 세션 스코프 시크릿은 세션 생성 시점에 데몬이 발급해 env에 실린다.
 *
 * 명세는 `node <browser-mcp.js>` 형태다 — MCP stdio는 실행 파일을 요구하므로
 * 스크립트 경로는 args에 실고 command는 node 바이너리를 가린다. 데스크톱 앱
 * 안에서 process.execPath는 Electron이라 node가 아니다: 레포의 다른 자식과
 * 같은 순서(COLO_DESIGN_EXTRA_PATH의 번들 node 먼저 — environment.ts의
 * resolveNodeVersion 관례)로 가리고, 둘 다 없으면 PATH의 node에 맡긴다.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 프로바이더에 등록할 MCP 서버 이름 — claude 도구 이름의 `mcp__colo-browser__*` 접두가 된다. */
export const BROWSER_MCP_SERVER_NAME = "colo-browser";

/** 주입 명세 — LaunchConfig.browserMcp로 세션까지 실려 간다. */
export interface BrowserMcpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** 이 파일(→ dist/browser-launch.js) 옆의 stdio 서버 스크립트 — tsc가 같은 디렉터리 구조로 놓는다. */
const browserMcpScript = (() => {
  const inside = fileURLToPath(new URL("./browser-mcp.js", import.meta.url));
  // 패키징된 앱에서는 asar 안의 경로가 나온다 — plain node 자식은 asar 를
  // 못 읽으므로 electron-builder 의 asarUnpack 이 놓은 .unpacked 로 돌린다.
  return inside.includes("app.asar") ? inside.replace("app.asar", "app.asar.unpacked") : inside;
})();

/** MCP 자식의 node 바이너리 가리기 — 배포 번들 → 실행 중인 node → PATH 순. */
function resolveNodeBinary(): string {
  const binary = process.platform === "win32" ? "node.exe" : "node";
  const extraDirs = (process.env.COLO_DESIGN_EXTRA_PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .map((dir) => join(dir, binary));
  const candidates = [...extraDirs, join(dirname(process.execPath), binary)];
  // 마지막 폴백은 실행 중인 바이너리 자신 — Electron 메인에서는 execPath 가
  // 앱 실행 파일이라 ELECTRON_RUN_AS_NODE=1 로 node 처럼 쓴다(아래 env).
  return candidates.find((candidate) => existsSync(candidate)) ?? process.execPath;
}

/**
 * 주입 명세를 만든다. `browserAvailable`은 host가 browserDriverFactory를
 * 주입했는지 — 아니면 null로, 세션은 브라우저 도구 없이 열린다. 시크릿은
 * 세션마다 새로 발급된 것이어야 하므로 호출자가 그때그때 넣는다.
 */
export function browserMcpEntry(
  browserAvailable: boolean,
  daemonUrl: string,
  secret: string,
  /** 이 세션에 submit_for_review 를 실을지 (PLAN L6 · O6 — 프로젝트의
   *  lifecycle.submitFromChat). MCP 자식과 omp 가 같은 env 를 읽는다. */
  submitFromChat: boolean,
): BrowserMcpEntry | null {
  if (!browserAvailable) return null;
  return {
    command: resolveNodeBinary(),
    args: [browserMcpScript],
    env: {
      COLO_DAEMON_URL: daemonUrl,
      COLO_BROWSER_SECRET: secret,
      // execPath 폴백이 Electron 바이너리일 때 node 로 돌게 하는 스위치 —
      // 진짜 node 에게는 무해하다.
      ELECTRON_RUN_AS_NODE: "1",
      ...(submitFromChat ? { COLO_BROWSER_SUBMIT: "1" } : {}),
    },
  };
}

/** claude — query options.mcpServers의 레코드 값(SDK McpStdioServerConfig). */
export function claudeBrowserMcpServer(entry: BrowserMcpEntry): {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return { type: "stdio", command: entry.command, args: entry.args, env: { ...entry.env } };
}

/** codex — thread/start config.mcp_servers의 표 객체(config.toml의 mcp_servers 표와 같은 형태). */
export function codexBrowserMcpServer(entry: BrowserMcpEntry): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return { command: entry.command, args: entry.args, env: { ...entry.env } };
}
