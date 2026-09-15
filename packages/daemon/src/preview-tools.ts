import { createRequire } from "node:module";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * The preview tools Claude sees in a screen session (PLAN D61): an
 * in-process MCP server named `colo-preview` whose `screen_*` tools drive
 * a hidden preview window through the `PreviewDriver` interface. The daemon
 * never learns what Electron is — the desktop injects a factory; the browser
 * dev path injects nothing and the tools simply do not exist.
 *
 * The window is addressed by REF (`e12`), handed out by `screen_read` and
 * minted by the driver against the accessibility tree it just walked. Every
 * `screen_open` and every `screen_read` starts a new generation, so a stale
 * ref is an error the model is told to fix by reading again — never a click
 * that lands somewhere else.
 */

/** One screen the connected repo declares, as its overlay reports it. */
export interface PreviewScreenDeclaration {
  route: string;
  title: string;
  states: string[];
}

/** The widths a screen can be looked at in — the 폭 toggle's, shared. */
export type PreviewViewport = "mobile" | "tablet" | "desktop";

/** How the window is set up before a screen loads. */
export interface PreviewOpenOptions {
  viewport?: PreviewViewport;
  colorScheme?: "light" | "dark";
}

/**
 * What `open` answers. `settled` false means the page loaded but the screen's
 * own `data-state` marker never appeared — the read that follows may be of a
 * half-built screen, and the tool says so instead of pretending.
 */
export type PreviewOpenResult = { ok: true; settled: boolean } | { ok: false; reason: string };

/** One node of the accessibility tree, as the driver minted its ref. */
export interface PreviewAxNode {
  /** Address for `screen_click` and friends; valid until the next read. */
  ref: string;
  role: string;
  name: string;
  /** A field's text, a slider's number — only where the node has one. */
  value?: string;
  /** `disabled`, `checked`, `expanded`, … — what the role does not say. */
  states: string[];
  children: PreviewAxNode[];
}

/** One line of what the page said — console levels, plus `net` (PLAN D61). */
export interface PreviewConsoleLine {
  level: string;
  text: string;
}

/**
 * One capture. The driver owns the encoder, so it says what the bytes are —
 * a caller that assumed a format would mislabel the picture (and the handoff
 * would commit it under the wrong extension).
 */
export interface PreviewCapture {
  /** base64, no data-url prefix. */
  data: string;
  mediaType: string;
}

/**
 * The one window Claude looks through. Implemented by the desktop with an
 * offscreen `BrowserWindow`; unit tests implement it with a fake.
 */
export interface PreviewDriver {
  /** Show `<baseUrl><route>` (and `?state=` when a state is named). */
  open(
    route: string,
    state: string | null,
    options?: PreviewOpenOptions,
  ): Promise<PreviewOpenResult>;
  /**
   * One picture of the window, downscaled so its long edge is `longEdge`.
   * `ref` crops to that one element. Scaling happens AT capture time — a
   * re-encode after the fact bakes one generation's artifacts into the next.
   */
  screenshot(options?: { ref?: string; longEdge?: number }): Promise<PreviewCapture>;
  /** The accessibility tree, refs minted — this call is the ref generation. */
  axTree(): Promise<PreviewAxNode[]>;
  click(target: { ref?: string; text?: string; selector?: string }): Promise<void>;
  /** Types into the focused element, or into `ref` after focusing it. */
  type(input: { ref?: string; text: string; clear?: boolean }): Promise<void>;
  /** One key, from the tool's whitelist — never arbitrary text. */
  press(key: string): Promise<void>;
  scroll(target: { ref?: string; dy: number }): Promise<void>;
  hover(target: { ref: string }): Promise<void>;
  /** Console and network trouble since the last `open`. */
  consoleLines(): Promise<PreviewConsoleLine[]>;
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
/**
 * Captures are tokens (PLAN D61), and a picture's token cost is its PIXEL
 * COUNT, not its byte count: Claude charges ⌈w/28⌉ × ⌈h/28⌉ visual tokens, so
 * the encoder and the quality knob change the wire and nothing else. Only the
 * long edge and the crop are levers, which is why `size` defaults to the
 * small one — 600px is ~300 tokens against ~680 for 900px, and a look that
 * genuinely needs detail asks for `size: "full"`.
 *
 * The budget is in points, not pictures: a whole frame costs two, a small or
 * cropped one costs one.
 */
const CAPTURE_BUDGET_PER_TURN = 24;
const CAPTURE_COST_FULL = 2;
const CAPTURE_COST_SMALL = 1;
const CAPTURE_LIMIT_TEXT = "이 턴의 캡처 한도에 닿았습니다 — screen_read 로 화면을 읽으십시오.";
/** Long edges: the detailed look, and the default one. */
const CAPTURE_LONG_EDGE_FULL = 900;
const CAPTURE_LONG_EDGE_SMALL = 600;

/** Past this the outline is noise; the tail says how much was left. */
const MAX_TREE_LINES = 400;

/** The keys `screen_press` will send. Anything else is a typo, or text. */
const PRESS_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
] as const;

const VIEWPORTS: PreviewViewport[] = ["mobile", "tablet", "desktop"];
const COLOR_SCHEMES = ["light", "dark"] as const;

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
  number(): PreviewZodType;
  boolean(): PreviewZodType;
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
  "screen_open 으로 연 뒤 screen_read 로 읽으십시오. screen_read 가 주는 " +
  "[e12] 같은 ref 로 누르고(screen_click) 입력합니다(screen_type) — ref 는 " +
  "다음 screen_read·screen_open 까지만 삽니다. 사진(screen_screenshot)의 값은 " +
  "픽셀 수라서, 되도록 ref 를 주어 그 요소만 찍고 size 는 기본(작게)으로 " +
  "두십시오. 글자나 레이블을 확인하려는 것이라면 사진보다 screen_read 가 " +
  "정확하고 거의 공짜입니다.";

// ---------------------------------------------------------------------------
// The accessibility outline
// ---------------------------------------------------------------------------

/** Roles that are the screen's controls — never folded away. */
const INTERACTIVE_ROLES: Record<string, true> = {
  button: true,
  link: true,
  textbox: true,
  searchbox: true,
  checkbox: true,
  radio: true,
  combobox: true,
  listbox: true,
  option: true,
  menuitem: true,
  menuitemcheckbox: true,
  menuitemradio: true,
  tab: true,
  switch: true,
  slider: true,
  spinbutton: true,
  textarea: true,
};

/** Roles that exist for layout only; without a name they carry nothing. */
const STRUCTURAL_ROLES: Record<string, true> = {
  generic: true,
  none: true,
  presentation: true,
  GenericContainer: true,
  LineBreak: true,
  group: true,
  section: true,
  div: true,
};

/**
 * The outline the model reads. `compact` folds structural nodes away and
 * lifts their children — the tree keeps its shape where shape means something
 * and loses the div soup that means nothing.
 */
export function serializeAxTree(nodes: PreviewAxNode[], compact: boolean): string {
  const lines: string[] = [];
  const walk = (list: PreviewAxNode[], depth: number): void => {
    for (const node of list) {
      // Interesting: a control, a node carrying state or a value, or anything
      // named that is not pure layout. Everything else is div soup — folded
      // away, its children lifted to this depth.
      const interesting =
        INTERACTIVE_ROLES[node.role] === true ||
        node.states.length > 0 ||
        node.value !== undefined ||
        (node.name !== "" && STRUCTURAL_ROLES[node.role] !== true);
      if (compact && !interesting) {
        walk(node.children, depth);
        continue;
      }
      const parts = [`${"  ".repeat(depth)}${node.role}`];
      if (node.name !== "") parts.push(`"${node.name}"`);
      if (node.value !== undefined) parts.push(`= "${node.value}"`);
      if (node.states.length > 0) parts.push(`(${node.states.join(", ")})`);
      if (node.ref !== "") parts.push(`[${node.ref}]`);
      lines.push(parts.join(" "));
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  if (lines.length === 0) return "화면에서 읽을 것이 없습니다 — 아직 그려지는 중일 수 있습니다.";
  if (lines.length <= MAX_TREE_LINES) return lines.join("\n");
  const dropped = lines.length - MAX_TREE_LINES;
  return [
    ...lines.slice(0, MAX_TREE_LINES),
    `…${dropped}줄 더 — 화면의 한 부분을 열어 다시 읽으십시오.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/**
 * Builds the `colo-preview` in-process MCP server. `listScreens` is read on
 * every `screen_list` call — the declared-screen cache can fill (or move)
 * while the session lives, so the tools must not snapshot it at creation.
 * `onOpened` (PLAN D91) is what makes the web's 따라가기 true: every
 * `screen_open` that actually landed reports the screen Claude put up.
 * Returns null when there is no driver, or zod cannot be reached — preview
 * tools are an enhancement, and their absence must stay quiet.
 */
export function createPreviewTools(
  driver: PreviewDriver | null,
  listScreens: () => PreviewScreenDeclaration[],
  onOpened?: (route: string, state: string | null) => void,
): PreviewTools | null {
  const zod = loadZod();
  if (!driver || !zod) return null;

  // This turn's capture spend; `resetTurnQuota` is the session's turn boundary.
  let spent = 0;
  // What the last `screen_open` set up — `screen_list` reports it so the model
  // is never guessing which width it has been looking at.
  let viewport: PreviewViewport = "desktop";
  let colorScheme: "light" | "dark" = "light";

  const text = (value: string): PreviewToolResult => ({
    content: [{ type: "text", text: value }],
  });
  const fail = (value: string): PreviewToolResult => ({
    content: [{ type: "text", text: value }],
    isError: true,
  });

  /**
   * A driver's refusal — a stale ref, an element that is not there, a window
   * that died — is the model's to read and act on, not an MCP transport
   * error. Every handler goes through here.
   */
  const guard =
    (handler: (args: Record<string, unknown>) => Promise<PreviewToolResult>) =>
    async (args: Record<string, unknown>): Promise<PreviewToolResult> => {
      try {
        return await handler(args);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    };

  const str = (args: Record<string, unknown>, key: string): string | undefined => {
    const value = args[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  const tools: PreviewToolDefinition[] = [
    defineTool(
      "screen_list",
      "연결 레포가 선언한 화면과 상태(들)의 목록을 돌려준다. 어떤 화면이 있는지 먼저 확인할 때 쓴다.",
      {},
      guard(async () => {
        const head = `지금 창: ${viewport} · ${colorScheme}`;
        const screens = listScreens();
        if (screens.length === 0) {
          return text(
            `${head}\n아직 선언된 화면이 없습니다 — 미리보기 앱이 화면을 알려 주면 목록이 채워집니다.`,
          );
        }
        return text(
          [
            head,
            ...screens.map((screen) => {
              const states =
                screen.states.length > 0 ? ` · states: ${screen.states.join(", ")}` : "";
              return `${screen.route} · ${screen.title}${states}`;
            }),
          ].join("\n"),
        );
      }),
    ),
    defineTool(
      "screen_open",
      "미리보기에서 화면을 연다. route 와 state 는 screen_list 의 값을 그대로 쓴다. state 를 생략하면 화면의 기본 상태다. viewport(mobile·tablet·desktop)와 colorScheme(light·dark)은 다음 screen_open 까지 유지된다.",
      {
        route: zod.string(),
        state: zod.string().optional(),
        viewport: zod.string().optional(),
        colorScheme: zod.string().optional(),
      },
      guard(async (args) => {
        const route = str(args, "route");
        const state = str(args, "state") ?? null;
        if (!route) return fail("route 가 필요합니다 — screen_list 의 값을 쓰십시오.");
        const wantViewport = str(args, "viewport");
        if (wantViewport && !VIEWPORTS.includes(wantViewport as PreviewViewport)) {
          return fail(`viewport 는 ${VIEWPORTS.join(" · ")} 중 하나입니다.`);
        }
        const wantScheme = str(args, "colorScheme");
        if (wantScheme && !COLOR_SCHEMES.includes(wantScheme as "light" | "dark")) {
          return fail(`colorScheme 은 ${COLOR_SCHEMES.join(" · ")} 중 하나입니다.`);
        }
        const nextViewport = (wantViewport as PreviewViewport | undefined) ?? viewport;
        const nextScheme = (wantScheme as "light" | "dark" | undefined) ?? colorScheme;
        const result = await driver.open(route, state, {
          viewport: nextViewport,
          colorScheme: nextScheme,
        });
        if (!result.ok) return fail(result.reason);
        viewport = nextViewport;
        colorScheme = nextScheme;
        // D91: the web follows the screen Claude actually looked at — and only
        // a screen that actually came up.
        onOpened?.(route, state);
        const where = state ? `${route} · ${state} 상태` : route;
        const head = `${where} 을(를) 열었습니다 (${nextViewport} · ${nextScheme}).`;
        return text(
          result.settled
            ? head
            : `${head}\n화면의 상태 표식을 확인하지 못했습니다 — 아직 그려지는 중일 수 있습니다.`,
        );
      }),
    ),
    defineTool(
      "screen_read",
      "화면의 접근성 트리를 텍스트 개요로 돌려준다 — 스크린샷보다 훨씬 싸고, 누를 것의 ref([e12])가 여기서 나온다. compact 를 false 로 주면 접힌 구조까지 모두 본다.",
      { compact: zod.boolean().optional() },
      guard(async (args) => {
        const compact = args.compact === undefined ? true : args.compact === true;
        return text(serializeAxTree(await driver.axTree(), compact));
      }),
    ),
    defineTool(
      "screen_screenshot",
      "지금 화면의 사진을 돌려준다. 기본은 작은 사진이고, 글자가 안 읽힐 때만 size 를 full 로 준다 — 사진 값은 픽셀 수라서 크게 찍으면 두 배를 쓴다. ref 를 주면 그 요소만 잘라 찍는다(제일 싸다). 한 턴의 예산이 정해져 있으니, 화면을 읽을 때는 screen_read 를 먼저 쓰십시오.",
      { ref: zod.string().optional(), size: zod.string().optional() },
      guard(async (args) => {
        const ref = str(args, "ref");
        const size = str(args, "size");
        if (size && size !== "small" && size !== "full") {
          return fail("size 는 small 이나 full 입니다.");
        }
        // Small is the default, and a crop is small whatever `size` says — it
        // is one element. Only an explicit `full` buys the whole frame.
        const small = ref !== undefined || size !== "full";
        const cost = small ? CAPTURE_COST_SMALL : CAPTURE_COST_FULL;
        if (spent + cost > CAPTURE_BUDGET_PER_TURN) return text(CAPTURE_LIMIT_TEXT);
        const capture = await driver.screenshot({
          ...(ref ? { ref } : {}),
          longEdge: small ? CAPTURE_LONG_EDGE_SMALL : CAPTURE_LONG_EDGE_FULL,
        });
        // Only a capture that came back is charged for.
        spent += cost;
        return {
          content: [{ type: "image", data: capture.data, mimeType: capture.mediaType }],
        };
      }),
    ),
    defineTool(
      "screen_click",
      "화면의 요소를 누른다. screen_read 가 준 ref 가 가장 정확하다. ref 대신 text(보이는 글자)나 selector(CSS)도 쓸 수 있다.",
      {
        ref: zod.string().optional(),
        text: zod.string().optional(),
        selector: zod.string().optional(),
      },
      guard(async (args) => {
        const ref = str(args, "ref");
        const textTarget = str(args, "text");
        const selector = str(args, "selector");
        if (!ref && !textTarget && !selector) {
          return fail("ref, text, selector 중 하나는 필요합니다 — screen_read 의 ref 를 권합니다.");
        }
        await driver.click({
          ...(ref ? { ref } : {}),
          ...(textTarget ? { text: textTarget } : {}),
          ...(selector ? { selector } : {}),
        });
        return text(`눌렀습니다: ${ref ?? textTarget ?? selector}`);
      }),
    ),
    defineTool(
      "screen_type",
      "입력란에 글자를 넣는다. ref 를 주면 그 요소를 먼저 누르고 입력하고, 생략하면 지금 포커스된 곳에 넣는다. clear 를 true 로 주면 있던 값을 지우고 쓴다.",
      { ref: zod.string().optional(), text: zod.string(), clear: zod.boolean().optional() },
      guard(async (args) => {
        const value = typeof args.text === "string" ? args.text : null;
        if (value === null) return fail("text 가 필요합니다.");
        const ref = str(args, "ref");
        await driver.type({
          ...(ref ? { ref } : {}),
          text: value,
          ...(args.clear === true ? { clear: true } : {}),
        });
        return text(`입력했습니다${ref ? ` (${ref})` : ""}: ${value}`);
      }),
    ),
    defineTool(
      "screen_press",
      `키 하나를 누른다. 쓸 수 있는 키: ${PRESS_KEYS.join(", ")}. 글자를 넣을 때는 screen_type 을 쓴다.`,
      { key: zod.string() },
      guard(async (args) => {
        const key = str(args, "key");
        if (!key || !PRESS_KEYS.includes(key as (typeof PRESS_KEYS)[number])) {
          return fail(`쓸 수 있는 키가 아닙니다 — ${PRESS_KEYS.join(", ")} 중 하나입니다.`);
        }
        await driver.press(key);
        return text(`눌렀습니다: ${key}`);
      }),
    ),
    defineTool(
      "screen_scroll",
      "화면을 굴린다. ref 를 주면 그 요소가 보이도록 옮기고, dy 를 주면 그만큼(양수는 아래로) 굴린다.",
      { ref: zod.string().optional(), dy: zod.number().optional() },
      guard(async (args) => {
        const ref = str(args, "ref");
        const dy = typeof args.dy === "number" && Number.isFinite(args.dy) ? args.dy : 0;
        if (!ref && dy === 0) return fail("ref 나 0 이 아닌 dy 중 하나는 필요합니다.");
        await driver.scroll({ ...(ref ? { ref } : {}), dy });
        return text(ref ? `${ref} 가 보이도록 옮겼습니다.` : `${dy}px 굴렸습니다.`);
      }),
    ),
    defineTool(
      "screen_hover",
      "요소 위에 마우스를 올린다 — 툴팁이나 hover 상태를 볼 때 쓴다. ref 는 screen_read 의 값이다.",
      { ref: zod.string() },
      guard(async (args) => {
        const ref = str(args, "ref");
        if (!ref) return fail("ref 가 필요합니다 — screen_read 의 값을 쓰십시오.");
        await driver.hover({ ref });
        return text(`올렸습니다: ${ref}`);
      }),
    ),
    defineTool(
      "screen_console",
      "마지막으로 화면을 연 이후의 콘솔 error·warn 과 실패한 네트워크 요청을 돌려준다.",
      {},
      guard(async () => {
        const lines = (await driver.consoleLines()).filter((line) =>
          ["error", "warn", "warning", "net"].includes(line.level.toLowerCase()),
        );
        if (lines.length === 0) {
          return text("화면을 연 이후 콘솔 error·warn 도, 실패한 요청도 없습니다.");
        }
        return text(lines.map((line) => `${line.level}: ${line.text}`).join("\n"));
      }),
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
      spent = 0;
    },
  };
}
