/**
 * Preview tools (PLAN D61) — the `screen_*` tools of the in-process
 * `colo-preview` MCP server, driven through a fake driver: the wire-level
 * tool list, the declared-screen list provider (read per call, never
 * snapshotted), a refused open reported as an error, the ref outline
 * `screen_read` serves, the input tools' whitelists, the per-turn capture
 * budget and its reset, the console filter, and the null-driver absence.
 *
 * Run: node --test packages/daemon/test/preview-tools.test.mjs
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { PreviewDrivers } from "../dist/preview-drivers.js";
import { createPreviewTools, serializeAxTree } from "../dist/preview-tools.js";

// The in-memory MCP pair arrives through the Agent SDK's dependency graph —
// the same place the daemon itself takes zod from (see preview-tools.ts).
const requireFromSdk = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
const { Client } = requireFromSdk("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = requireFromSdk("@modelcontextprotocol/sdk/inMemory.js");

const SCREENS = [
  {
    route: "/pay/PayFailed",
    title: "결제 실패",
    states: ["기본", "비어 있음", "오류"],
  },
  { route: "/member/MemberList", title: "회원 목록", states: ["기본"] },
];

/** The outline a fake driver answers with — a button, a field, a heading. */
const node = (over = {}) => ({ ref: "", role: "", name: "", states: [], children: [], ...over });
const TREE = [
  node({
    role: "generic",
    ref: "e1",
    children: [
      node({ role: "heading", name: "결제 실패", ref: "e2" }),
      node({ role: "button", name: "다시 시도", ref: "e3" }),
      node({
        role: "textbox",
        name: "카드번호",
        value: "4242",
        states: ["required"],
        ref: "e4",
      }),
    ],
  }),
];

/** A driver that records what the tools did and answers fixed outputs. */
function fakeDriver(overrides = {}) {
  return {
    open: async (route, state, options) =>
      overrides.open ? overrides.open(route, state, options) : { ok: true, settled: true },
    screenshot: async (options) => overrides.screenshot(options),
    axTree: async () => (overrides.axTree ? overrides.axTree() : TREE),
    click: async (target) => (overrides.click ? overrides.click(target) : undefined),
    type: async (input) => (overrides.type ? overrides.type(input) : undefined),
    press: async (key) => (overrides.press ? overrides.press(key) : undefined),
    scroll: async (target) => (overrides.scroll ? overrides.scroll(target) : undefined),
    hover: async (target) => (overrides.hover ? overrides.hover(target) : undefined),
    consoleLines: async () =>
      overrides.consoleLines
        ? overrides.consoleLines()
        : [
            { level: "log", text: "rendered" },
            { level: "error", text: "boom" },
            { level: "warn", text: "meh" },
          ],
    destroy: async () => {},
  };
}
/** Connects a real MCP client to the tools' in-process server; `close` ends
 * both sides so a test file cannot hold the event loop open. */
async function openTools(tools) {
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  // Both halves connect together: the client's connect waits on the
  // initialize round-trip, which only the connected server can answer.
  await Promise.all([client.connect(clientSide), tools.config.instance.connect(serverSide)]);
  return {
    client,
    close: async () => {
      await client.close();
      await tools.config.instance.close();
    },
  };
}

const textOf = (result) => result.content.map((block) => block.text).join("\n");

test("a session without a driver gets no preview tools at all", () => {
  assert.equal(
    createPreviewTools(null, () => SCREENS),
    null,
  );
});

test("the colo-preview server serves exactly the screen tools", async () => {
  const tools = createPreviewTools(fakeDriver(), () => SCREENS);
  assert.equal(tools.name, "colo-preview");
  const { client, close } = await openTools(tools);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "screen_click",
    "screen_console",
    "screen_do",
    "screen_hover",
    "screen_list",
    "screen_open",
    "screen_press",
    "screen_read",
    "screen_screenshot",
    "screen_scroll",
    "screen_type",
  ]);
  await close();
});

test("screen_list answers the declared screens, reading the provider per call", async () => {
  let reads = 0;
  const tools = createPreviewTools(fakeDriver(), () => {
    reads += 1;
    return reads === 1 ? SCREENS : [SCREENS[1]];
  });
  const { client, close } = await openTools(tools);

  const first = textOf(await client.callTool({ name: "screen_list", arguments: {} }));
  assert.match(first, /\/pay\/PayFailed · 결제 실패 · states: 기본, 비어 있음, 오류/);
  assert.match(first, /\/member\/MemberList/);
  // The window's own facts ride the list — the model never guesses the width.
  assert.match(first, /지금 창: desktop · light/);

  const second = textOf(await client.callTool({ name: "screen_list", arguments: {} }));
  assert.doesNotMatch(second, /\/pay\/PayFailed/);
  await close();
});

test("screen_open hands route, state and window options to the driver", async () => {
  const seen = [];
  const { client, close } = await openTools(
    createPreviewTools(
      fakeDriver({
        open: (route, state, options) => {
          seen.push({ route, state, options });
          return { ok: true, settled: true };
        },
      }),
      () => SCREENS,
    ),
  );
  const named = await client.callTool({
    name: "screen_open",
    arguments: { route: "/pay/PayFailed", state: "오류", viewport: "mobile", colorScheme: "dark" },
  });
  assert.deepEqual(seen[0], {
    route: "/pay/PayFailed",
    state: "오류",
    options: { viewport: "mobile", colorScheme: "dark" },
  });
  assert.match(textOf(named), /mobile · dark/);

  // The window keeps what it was set to — the next open inherits it.
  await client.callTool({ name: "screen_open", arguments: { route: "/member/MemberList" } });
  assert.deepEqual(seen[1], {
    route: "/member/MemberList",
    state: null,
    options: { viewport: "mobile", colorScheme: "dark" },
  });
  assert.match(
    textOf(await client.callTool({ name: "screen_list", arguments: {} })),
    /지금 창: mobile · dark/,
  );
  await close();
});

test("screen_open answers with the screen's tree — the read is already paid", async () => {
  const { client, close } = await openTools(createPreviewTools(fakeDriver(), () => SCREENS));
  const result = textOf(
    await client.callTool({ name: "screen_open", arguments: { route: "/pay/PayFailed" } }),
  );
  assert.match(result, /\/pay\/PayFailed 을\(를\) 열었습니다/);
  assert.match(result, /button "다시 시도" \[e3\]/);
  await close();
});

test("screen_open refuses an unknown viewport before touching the driver", async () => {
  let opens = 0;
  const { client, close } = await openTools(
    createPreviewTools(
      fakeDriver({
        open: () => {
          opens += 1;
          return { ok: true, settled: true };
        },
      }),
      () => SCREENS,
    ),
  );
  const result = await client.callTool({
    name: "screen_open",
    arguments: { route: "/pay/PayFailed", viewport: "watch" },
  });
  assert.equal(result.isError, true);
  assert.equal(opens, 0);
  await close();
});

test("a refused open is an error, and the web is not told a screen came up", async () => {
  const opened = [];
  const { client, close } = await openTools(
    createPreviewTools(
      fakeDriver({
        open: () => ({ ok: false, reason: "미리보기 서버 밖의 주소는 열지 않습니다" }),
      }),
      () => SCREENS,
      (route, state) => opened.push([route, state]),
    ),
  );
  const result = await client.callTool({
    name: "screen_open",
    arguments: { route: "https://evil.example/x" },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /미리보기 서버 밖의 주소/);
  // D91's 따라가기 must not follow a screen that never showed.
  assert.deepEqual(opened, []);
  await close();
});

test("an open that never settled says so — the read after it may be half a screen", async () => {
  const { client, close } = await openTools(
    createPreviewTools(fakeDriver({ open: () => ({ ok: true, settled: false }) }), () => SCREENS),
  );
  const result = await client.callTool({
    name: "screen_open",
    arguments: { route: "/pay/PayFailed", state: "오류" },
  });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /상태 표식을 확인하지 못했습니다/);
  await close();
});

test("screen_read serves the outline with refs, folding structure away", async () => {
  const { client, close } = await openTools(createPreviewTools(fakeDriver(), () => SCREENS));
  const compact = textOf(await client.callTool({ name: "screen_read", arguments: {} }));
  assert.equal(
    compact,
    [
      'heading "결제 실패" [e2]',
      'button "다시 시도" [e3]',
      'textbox "카드번호" = "4242" (required) [e4]',
    ].join("\n"),
  );
  // The unnamed generic wrapper is only there when the model asks for it.
  const full = textOf(
    await client.callTool({ name: "screen_read", arguments: { compact: false } }),
  );
  assert.match(full, /^generic \[e1\]\n {2}heading "결제 실패" \[e2\]/);
  await close();
});

test("serializeAxTree caps the outline and says how much was left", () => {
  const many = Array.from({ length: 450 }, (_, index) =>
    node({ role: "button", name: `b${index}`, ref: `e${index}` }),
  );
  const lines = serializeAxTree(many, true).split("\n");
  assert.equal(lines.length, 401);
  assert.match(lines.at(-1), /…50줄 더/);
  assert.match(serializeAxTree([], true), /읽을 것이 없습니다/);
});

test("screen_screenshot is small by default, and the whole frame costs double", async () => {
  const asked = [];
  const frame = (n) => Buffer.from(`frame-${n}`).toString("base64");
  let shots = 0;
  const tools = createPreviewTools(
    fakeDriver({
      screenshot: (options) => {
        asked.push(options);
        return { data: frame(++shots), mediaType: "image/webp" };
      },
    }),
    () => SCREENS,
  );
  const { client, close } = await openTools(tools);

  // No `size` is the cheap look — 600px, one point — and the driver's own
  // format reaches the model instead of a hardcoded guess.
  const first = await client.callTool({ name: "screen_screenshot", arguments: {} });
  assert.deepEqual(first.content, [{ type: "image", data: frame(1), mimeType: "image/webp" }]);
  assert.deepEqual(asked[0], { longEdge: 600 });

  // 24 points of small looks; the 25th is words.
  for (let i = 0; i < 23; i++) {
    assert.equal(
      (await client.callTool({ name: "screen_screenshot", arguments: {} })).content[0].type,
      "image",
    );
  }
  assert.match(
    textOf(await client.callTool({ name: "screen_screenshot", arguments: {} })),
    /캡처 한도/,
  );

  // A new turn spent on whole frames instead: 900px, two points, half as many.
  tools.resetTurnQuota();
  for (let i = 0; i < 12; i++) {
    assert.equal(
      (await client.callTool({ name: "screen_screenshot", arguments: { size: "full" } })).content[0]
        .type,
      "image",
    );
  }
  assert.deepEqual(asked.at(-1), { longEdge: 900 });
  assert.match(
    textOf(await client.callTool({ name: "screen_screenshot", arguments: { size: "full" } })),
    /캡처 한도/,
  );

  // A crop is one element, so it is a small look whatever `size` says.
  tools.resetTurnQuota();
  await client.callTool({ name: "screen_screenshot", arguments: { ref: "e3", size: "full" } });
  assert.deepEqual(asked.at(-1), { ref: "e3", longEdge: 600 });
  await close();
});

test("screen_click needs a target and forwards exactly what it got", async () => {
  const seen = [];
  const { client, close } = await openTools(
    createPreviewTools(fakeDriver({ click: (target) => seen.push(target) }), () => SCREENS),
  );

  await client.callTool({ name: "screen_click", arguments: { ref: "e3" } });
  await client.callTool({ name: "screen_click", arguments: { text: "다시 시도" } });
  await client.callTool({ name: "screen_click", arguments: { selector: "#retry" } });
  assert.deepEqual(seen, [{ ref: "e3" }, { text: "다시 시도" }, { selector: "#retry" }]);

  const empty = await client.callTool({ name: "screen_click", arguments: {} });
  assert.equal(empty.isError, true);
  assert.equal(seen.length, 3);
  await close();
});

test("a stale ref is the driver's refusal, read back as a tool error", async () => {
  const { client, close } = await openTools(
    createPreviewTools(
      fakeDriver({
        click: () => {
          throw new Error("e9 는 지금 화면의 것이 아닙니다 — screen_read 로 다시 읽으십시오.");
        },
      }),
      () => SCREENS,
    ),
  );
  const result = await client.callTool({ name: "screen_click", arguments: { ref: "e9" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /screen_read 로 다시 읽으십시오/);
  await close();
});

test("an action's answer carries the fresh tree — no second read needed", async () => {
  const { client, close } = await openTools(createPreviewTools(fakeDriver(), () => SCREENS));
  const clicked = textOf(await client.callTool({ name: "screen_click", arguments: { ref: "e3" } }));
  assert.match(clicked, /눌렀습니다: e3/);
  assert.match(clicked, /textbox "카드번호" = "4242" \(required\) \[e4\]/);
  const typed = textOf(
    await client.callTool({ name: "screen_type", arguments: { ref: "e4", text: "4242" } }),
  );
  assert.match(typed, /heading "결제 실패" \[e2\]/);
  await close();
});

test("an action still answers when the tree read fails", async () => {
  const { client, close } = await openTools(
    createPreviewTools(
      fakeDriver({
        axTree: () => {
          throw new Error("미리보기 창이 닫혔습니다.");
        },
      }),
      () => SCREENS,
    ),
  );
  const result = await client.callTool({ name: "screen_click", arguments: { ref: "e3" } });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /눌렀습니다: e3/);
  assert.match(textOf(result), /다시 읽지 못했습니다/);
  await close();
});

test("screen_do runs the steps in order and answers with the last tree", async () => {
  const calls = [];
  const { client, close } = await openTools(
    createPreviewTools(
      fakeDriver({
        click: (target) => calls.push(["click", target]),
        type: (input) => calls.push(["type", input]),
        press: (key) => calls.push(["press", key]),
      }),
      () => SCREENS,
    ),
  );
  const result = await client.callTool({
    name: "screen_do",
    arguments: {
      steps: [
        { click: "e3" },
        { type: { ref: "e4", text: "4242", clear: true } },
        { press: "Enter" },
      ],
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    ["click", { ref: "e3" }],
    ["type", { ref: "e4", text: "4242", clear: true }],
    ["press", "Enter"],
  ]);
  const body = textOf(result);
  assert.match(body, /3개 스텝을 모두 실행했습니다/);
  assert.match(body, /button "다시 시도" \[e3\]/);
  await close();
});

test("the gate tracks only preview-origin screens — allowed origins pass through", async () => {
  const factoryCalls = [];
  const drivers = new PreviewDrivers({
    factory: () => ({
      for: (baseUrl, origins) => {
        factoryCalls.push([baseUrl, origins]);
        return fakeDriver();
      },
      forIsolated: (baseUrl, origins) => {
        factoryCalls.push([baseUrl, origins]);
        return fakeDriver();
      },
    }),
    activeRepo: () => ({
      isCloned: () => true,
      status: async () => ({ previewUrl: "http://127.0.0.1:5274" }),
      repoConfig: () => ({ preview: { origins: ["http://localhost:6006"] } }),
    }),
    session: () => undefined,
    sessions: () => [],
    notice: () => undefined,
  });
  const made = await drivers.toolsFor(true, (route, state) =>
    drivers.noteOpened("s1", route, state),
  );
  assert.ok(made, "toolsFor must build the tool set");
  // The repo's extra origins reach the driver factory.
  assert.deepEqual(factoryCalls, [["http://127.0.0.1:5274", ["http://localhost:6006"]]]);

  const { client, close } = await openTools(made.tools);
  // A declared screen lands on the gate list…
  await client.callTool({ name: "screen_open", arguments: { route: "/pay/PayFailed" } });
  // …but a repo-allowed foreign origin does not — the gate re-verifies the
  // repo's own preview, not a server the repo merely pointed at.
  await client.callTool({
    name: "screen_open",
    arguments: { route: "http://localhost:6006/iframe.html" },
  });
  assert.deepEqual([...drivers.openedThisTurn.get("s1").keys()], ["/pay/PayFailed\n"]);
  await close();
});
test("screen_do stops at the first failure and says which step and why", async () => {
  const calls = [];
  const { client, close } = await openTools(
    createPreviewTools(
      fakeDriver({
        click: (target) => calls.push(["click", target]),
        type: () => {
          throw new Error("e4 는 지금 화면의 것이 아닙니다");
        },
        press: (key) => calls.push(["press", key]),
      }),
      () => SCREENS,
    ),
  );
  const result = await client.callTool({
    name: "screen_do",
    arguments: {
      steps: [{ click: "e3" }, { type: { ref: "e4", text: "x" } }, { press: "Enter" }],
    },
  });
  assert.equal(result.isError, true);
  // The third step never ran — a dead ref stops the batch, not skips it.
  assert.deepEqual(calls, [["click", { ref: "e3" }]]);
  const body = textOf(result);
  assert.match(body, /2번째 스텝에서 멈췄습니다/);
  assert.match(body, /지금 화면의 것이 아닙니다/);
  // The tree at the stop point rides along so the model can keep going.
  assert.match(body, /heading "결제 실패" \[e2\]/);
  await close();
});

test("screen_do refuses a step that names no action or a bad key", async () => {
  const calls = [];
  const { client, close } = await openTools(
    createPreviewTools(fakeDriver({ click: (target) => calls.push(target) }), () => SCREENS),
  );
  const empty = await client.callTool({ name: "screen_do", arguments: { steps: [] } });
  assert.equal(empty.isError, true);
  const badKey = await client.callTool({
    name: "screen_do",
    arguments: { steps: [{ press: "F13" }] },
  });
  assert.equal(badKey.isError, true);
  assert.match(textOf(badKey), /쓸 수 있는 키가 아닙니다/);
  assert.deepEqual(calls, []);
  await close();
});

test("screen_type carries ref, text and clear through", async () => {
  const seen = [];
  const { client, close } = await openTools(
    createPreviewTools(fakeDriver({ type: (input) => seen.push(input) }), () => SCREENS),
  );
  await client.callTool({
    name: "screen_type",
    arguments: { ref: "e4", text: "4242", clear: true },
  });
  await client.callTool({ name: "screen_type", arguments: { text: "x" } });
  assert.deepEqual(seen, [{ ref: "e4", text: "4242", clear: true }, { text: "x" }]);
  await close();
});

test("screen_press sends whitelisted keys only", async () => {
  const seen = [];
  const { client, close } = await openTools(
    createPreviewTools(fakeDriver({ press: (key) => seen.push(key) }), () => SCREENS),
  );
  await client.callTool({ name: "screen_press", arguments: { key: "Enter" } });
  const refused = await client.callTool({ name: "screen_press", arguments: { key: "F13" } });
  assert.equal(refused.isError, true);
  assert.deepEqual(seen, ["Enter"]);
  await close();
});

test("screen_scroll needs somewhere to go; screen_hover needs a ref", async () => {
  const scrolls = [];
  const hovers = [];
  const { client, close } = await openTools(
    createPreviewTools(
      fakeDriver({
        scroll: (target) => scrolls.push(target),
        hover: (target) => hovers.push(target),
      }),
      () => SCREENS,
    ),
  );
  await client.callTool({ name: "screen_scroll", arguments: { dy: 400 } });
  await client.callTool({ name: "screen_scroll", arguments: { ref: "e3" } });
  const nowhere = await client.callTool({ name: "screen_scroll", arguments: {} });
  assert.equal(nowhere.isError, true);
  assert.deepEqual(scrolls, [{ dy: 400 }, { ref: "e3", dy: 0 }]);

  await client.callTool({ name: "screen_hover", arguments: { ref: "e3" } });
  assert.deepEqual(hovers, [{ ref: "e3" }]);
  await close();
});

test("screen_console keeps error, warn and failed requests, drops the rest", async () => {
  const driver = fakeDriver({
    consoleLines: () => [
      { level: "log", text: "rendered" },
      { level: "error", text: "boom" },
      { level: "info", text: "hello" },
      { level: "warning", text: "deprecated" },
      { level: "net", text: "500 /api/pay" },
    ],
  });
  const { client, close } = await openTools(createPreviewTools(driver, () => SCREENS));
  const result = await client.callTool({ name: "screen_console", arguments: {} });
  assert.equal(textOf(result), "error: boom\nwarning: deprecated\nnet: 500 /api/pay");

  const quietTools = createPreviewTools(
    fakeDriver({ consoleLines: () => [{ level: "log", text: "fine" }] }),
    () => SCREENS,
  );
  const quiet = await openTools(quietTools);
  assert.match(
    textOf(await quiet.client.callTool({ name: "screen_console", arguments: {} })),
    /error·warn 도, 실패한 요청도 없습니다/,
  );
  await quiet.close();
  await close();
});
