import { createRequire } from "node:module";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * The preview tools Claude sees in a screen session (PLAN D61): an
 * in-process MCP server named `colo-preview` whose six `screen_*` tools drive
 * a hidden preview window through the `PreviewDriver` interface. The daemon
 * never learns what Electron is — the desktop injects a factory; the browser
 * dev path injects nothing and the tools simply do not exist.
 */

/** One screen the connected repo declares, as its overlay reports it. */
export interface PreviewScreenDeclaration {
  route: string;
  title: string;
  states: string[];
}

/**
 * The one window Claude looks through. Implemented by the desktop with an
 * offscreen `BrowserWindow`; unit tests implement it with a fake.
 */
export interface PreviewDriver {
  /** Show `<baseUrl><route>` (and `?state=` when a state is named). */
  open(route: string, state: string | null): Promise<void>;
  /** JPEG (base64), long edge 900px — the image Claude actually receives. */
  screenshot(): Promise<string>;
  /** The accessibility tree as a text outline, capped at 200 lines. */
  axTree(): Promise<string>;
  click(target: { text?: string; selector?: string }): Promise<void>;
  /** Console lines since the last `open` — the tool filters error·warn. */
  consoleLines(): Promise<Array<{ level: string; text: string }>>;
  destroy(): Promise<void>;
}

export interface PreviewDriverFactory {
  for(baseUrl: string): PreviewDriver;
}

/** What a session receives when preview tools are on. */
export interface PreviewTools {
  name: typeof PREVIEW_SERVER_NAME;
  /** Value for the query's `mcpServers`, under the server's own name. */
  config: McpSdkServerConfigWithInstance;
  /** A turn boundary: the per-turn screenshot quota starts over. */
  resetTurnQuota(): void;
}

const PREVIEW_SERVER_NAME = "colo-preview";
/** Screenshots are tokens (PLAN D61) — twelve per turn, then words. */
const CAPTURE_LIMIT_PER_TURN = 12;
const CAPTURE_LIMIT_TEXT = "이 턴의 캡처 한도에 닿았습니다";

// ---------------------------------------------------------------------------
// MCP plumbing, typed locally
// ---------------------------------------------------------------------------

type PreviewToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface PreviewToolResult {
  content: PreviewToolContent[];
  isError?: boolean;
}

interface PreviewToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<PreviewToolResult>;
}

/**
 * The zod surface the input schemas use. Typed here — not imported — because
 * the daemon does not name zod as a dependency: the Agent SDK declares it as
 * its peer, so the one instance the SDK's own schema handling will see is
 * resolved through the SDK's side of the dependency graph.
 */
interface PreviewZodType {
  optional(): PreviewZodType;
}

interface PreviewZod {
  string(): PreviewZodType;
  object(shape: Record<string, PreviewZodType>): unknown;
}

function loadZod(): PreviewZod | null {
  try {
    const requireFromDaemon = createRequire(import.meta.url);
    // Resolves through the daemon's dependency and materializes the pnpm
    // store path, where the SDK's declared peers live as siblings.
    const requireFromSdk = createRequire(
      requireFromDaemon.resolve("@anthropic-ai/claude-agent-sdk"),
    );
    const mod = requireFromSdk("zod") as Partial<PreviewZod> & {
      z?: PreviewZod;
    };
    return mod.z ?? (mod as PreviewZod);
  } catch {
    return null;
  }
}

/** The SDK's `tool()` returns a plain definition object; typed loosely since
 * the schemas are real zod values the typechecker cannot name (loadZod). */
const defineTool = tool as unknown as (
  name: string,
  description: string,
  inputSchema: Record<string, PreviewZodType>,
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<PreviewToolResult>,
) => PreviewToolDefinition;

const createServer = createSdkMcpServer as unknown as (options: {
  name: string;
  version?: string;
  instructions?: string;
  tools: PreviewToolDefinition[];
}) => McpSdkServerConfigWithInstance;

const SERVER_INSTRUCTIONS =
  "미리보기 화면을 다룰 때는 screen_list 로 화면과 상태를 확인하고, " +
  "화면을 읽을 때는 screen_read 를 먼저 쓰십시오 — 스크린샷(screen_screenshot)은 " +
  "토큰이 비싸니 꼭 사진이 필요할 때만 씁니다(턴당 12장).";

// ---------------------------------------------------------------------------
// The six tools
// ---------------------------------------------------------------------------

/**
 * Builds the `colo-preview` in-process MCP server. `listScreens` is read on
 * every `screen_list` call — the declared-screen cache can fill (or move)
 * while the session lives, so the tools must not snapshot it at creation.
 * `onOpened` (PLAN D91) is what makes the web's 따라가기 true: every
 * `screen_open` reports the screen Claude actually put up. Returns null when
 * there is no driver, or zod cannot be reached — preview tools are an
 * enhancement, and their absence must stay quiet.
 */
export function createPreviewTools(
  driver: PreviewDriver | null,
  listScreens: () => PreviewScreenDeclaration[],
  onOpened?: (route: string, state: string | null) => void,
): PreviewTools | null {
  const zod = loadZod();
  if (!driver || !zod) return null;

  // This turn's captures; `resetTurnQuota` is the session's turn boundary.
  let captures = 0;

  const text = (value: string): PreviewToolResult => ({
    content: [{ type: "text", text: value }],
  });

  const tools: PreviewToolDefinition[] = [
    defineTool(
      "screen_list",
      "연결 레포가 선언한 화면과 상태(들)의 목록을 돌려준다. 어떤 화면이 있는지 먼저 확인할 때 쓴다.",
      {},
      async () => {
        const screens = listScreens();
        if (screens.length === 0) {
          return text(
            "아직 선언된 화면이 없습니다 — 미리보기 앱이 화면을 알려 주면 목록이 채워집니다.",
          );
        }
        return text(
          screens
            .map((screen) => {
              const states =
                screen.states.length > 0 ? ` · states: ${screen.states.join(", ")}` : "";
              return `${screen.route} · ${screen.title}${states}`;
            })
            .join("\n"),
        );
      },
    ),
    defineTool(
      "screen_open",
      "미리보기에서 화면을 연다. route 와 state 는 screen_list 의 값을 그대로 쓴다. state 를 생략하면 화면의 기본 상태다.",
      { route: zod.string(), state: zod.string().optional() },
      async (args) => {
        const route = String(args.route ?? "");
        const state = typeof args.state === "string" && args.state !== "" ? args.state : null;
        if (route === "") {
          return {
            content: [
              {
                type: "text",
                text: "route 가 필요합니다 — screen_list 의 값을 쓰십시오.",
              },
            ],
            isError: true,
          };
        }
        await driver.open(route, state);
        // D91: the web follows the screen Claude actually looked at.
        onOpened?.(route, state);
        return text(
          state ? `${route} · ${state} 상태를 열었습니다.` : `${route} 을(를) 열었습니다.`,
        );
      },
    ),
    defineTool(
      "screen_screenshot",
      "지금 화면의 사진(JPEG)을 돌려준다. 토큰을 많이 쓰므로 턴당 12장이 한도고, 화면을 읽을 때는 screen_read 를 먼저 쓰십시오.",
      {},
      async () => {
        if (captures >= CAPTURE_LIMIT_PER_TURN) {
          return text(CAPTURE_LIMIT_TEXT);
        }
        captures += 1;
        return {
          content: [
            {
              type: "image",
              data: await driver.screenshot(),
              mimeType: "image/jpeg",
            },
          ],
        };
      },
    ),
    defineTool(
      "screen_read",
      "화면의 접근성 트리를 텍스트 개요로 돌려준다 — 스크린샷보다 훨씬 싸다. 화면을 읽을 때는 screen_read 를 먼저 쓰십시오.",
      {},
      async () => text(await driver.axTree()),
    ),
    defineTool(
      "screen_click",
      "화면의 요소를 누른다. text(보이는 글자)나 selector(CSS) 중 하나를 준다.",
      { text: zod.string().optional(), selector: zod.string().optional() },
      async (args) => {
        const textTarget =
          typeof args.text === "string" && args.text !== "" ? args.text : undefined;
        const selector =
          typeof args.selector === "string" && args.selector !== "" ? args.selector : undefined;
        if (!textTarget && !selector) {
          return {
            content: [{ type: "text", text: "text 나 selector 중 하나는 필요합니다." }],
            isError: true,
          };
        }
        await driver.click({
          ...(textTarget ? { text: textTarget } : {}),
          ...(selector ? { selector } : {}),
        });
        return text(`눌렀습니다: ${textTarget ?? selector}`);
      },
    ),
    defineTool(
      "screen_console",
      "마지막으로 화면을 연 이후의 콘솔 error·warn 을 돌려준다.",
      {},
      async () => {
        const lines = (await driver.consoleLines()).filter((line) =>
          ["error", "warn", "warning"].includes(line.level.toLowerCase()),
        );
        if (lines.length === 0) return text("화면을 연 이후 콘솔에 error·warn 이 없습니다.");
        return text(lines.map((line) => `${line.level}: ${line.text}`).join("\n"));
      },
    ),
  ];

  const config = createServer({
    name: PREVIEW_SERVER_NAME,
    version: "1.0.0",
    instructions: SERVER_INSTRUCTIONS,
    tools,
  });

  return {
    name: PREVIEW_SERVER_NAME,
    config,
    resetTurnQuota: () => {
      captures = 0;
    },
  };
}
