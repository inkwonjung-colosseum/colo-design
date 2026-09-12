/**
 * Preview tools (PLAN D61) — the six `screen_*` tools of the in-process
 * `colo-preview` MCP server, driven through a fake driver: the wire-level
 * tool list, the declared-screen list provider (read per call, never
 * snapshotted), the per-turn 12-screenshot quota and its reset, the
 * console error·warn filter, and the null-driver absence.
 *
 * Run: node --test packages/daemon/test/preview-tools.test.mjs
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createPreviewTools } from "../dist/preview-tools.js";

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

/** A driver that records what the tools did and answers fixed outputs. */
function fakeDriver(overrides = {}) {
  return {
    open: async (route, state) => (overrides.open ? overrides.open(route, state) : undefined),
    screenshot: async () => overrides.screenshot(),
    axTree: async () => overrides.axTree() ?? "button 결제하기\ntextbox 카드번호",
    click: async (target) => (overrides.click ? overrides.click(target) : undefined),
    consoleLines: async () =>
      overrides.consoleLines() ?? [
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

test("the colo-preview server serves exactly the six screen tools", async () => {
  const tools = createPreviewTools(fakeDriver(), () => SCREENS);
  assert.equal(tools.name, "colo-preview");
  const { client, close } = await openTools(tools);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "screen_click",
    "screen_console",
    "screen_list",
    "screen_open",
    "screen_read",
    "screen_screenshot",
  ]);
  // screen_read is the cheap path — its description is where the tools say
  // to reach for it before any screenshot (PLAN D61).
  const read = (await client.listTools()).tools.find((tool) => tool.name === "screen_read");
  assert.match(read.description, /screen_read/);
  assert.match(read.description, /스크린샷보다/);
  await close();
});

test("screen_list answers the declared screens, reading the provider per call", async () => {
  let reads = 0;
  const tools = createPreviewTools(fakeDriver(), () => {
    reads += 1;
    return reads === 1 ? SCREENS : [SCREENS[1]];
  });
  const { client, close } = await openTools(tools);
  const first = await client.callTool({ name: "screen_list", arguments: {} });
  assert.match(textOf(first), /\/pay\/PayFailed · 결제 실패 · states: 기본, 비어 있음, 오류/);
  assert.match(textOf(first), /\/member\/MemberList/);
  // The provider is read again, not snapshotted at creation: the declared
  // screen cache can fill while the session lives (PLAN D61).
  const second = await client.callTool({ name: "screen_list", arguments: {} });
  assert.doesNotMatch(textOf(second), /PayFailed/);
  assert.equal(reads, 2);
  await close();
});

test("screen_open hands route and state to the driver — state optional", async () => {
  const driver = fakeDriver();
  const { client, close } = await openTools(createPreviewTools(driver, () => SCREENS));
  const named = await client.callTool({
    name: "screen_open",
    arguments: { route: "/pay/PayFailed", state: "오류" },
  });
  assert.match(textOf(named), /오류/);
  const unnamed = await client.callTool({
    name: "screen_open",
    arguments: { route: "/pay/PayFailed" },
  });
  assert.ok(textOf(unnamed).length > 0);
  const missing = await client.callTool({ name: "screen_open", arguments: {} });
  assert.equal(missing.isError, true);
  await close();
});

test("screen_screenshot returns the driver's JPEG — twelve per turn, then words", async () => {
  let shots = 0;
  // Valid base64 whose decoded bytes start with the JPEG magic /9j/ — the
  // MCP client validates the image content's data as base64.
  const frame = (n) => Buffer.from(`/9j/frame-${n}`, "utf8").toString("base64");
  const driver = fakeDriver({ screenshot: () => frame(++shots) });
  const tools = createPreviewTools(driver, () => SCREENS);
  const { client, close } = await openTools(tools);

  for (let i = 0; i < 12; i++) {
    const result = await client.callTool({
      name: "screen_screenshot",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [
      { type: "image", data: frame(i + 1), mimeType: "image/jpeg" },
    ]);
  }
  // The thirteenth is a sentence, not an image — the turn keeps going
  // (PLAN D61: 스크린샷은 토큰이다).
  const over = await client.callTool({
    name: "screen_screenshot",
    arguments: {},
  });
  assert.deepEqual(over.content, [{ type: "text", text: "이 턴의 캡처 한도에 닿았습니다" }]);

  // The session resets the quota at turn boundaries.
  tools.resetTurnQuota();
  const fresh = await client.callTool({
    name: "screen_screenshot",
    arguments: {},
  });
  assert.deepEqual(fresh.content, [{ type: "image", data: frame(13), mimeType: "image/jpeg" }]);
  await close();
});

test("screen_read hands the accessibility outline through as text", async () => {
  const driver = fakeDriver({
    axTree: () => "heading 결제 실패\nbutton 다시 시도",
  });
  const { client, close } = await openTools(createPreviewTools(driver, () => SCREENS));
  const result = await client.callTool({ name: "screen_read", arguments: {} });
  assert.deepEqual(result.content, [{ type: "text", text: "heading 결제 실패\nbutton 다시 시도" }]);
  await close();
});

test("screen_click needs a target and forwards exactly what it got", async () => {
  const seen = [];
  const driver = fakeDriver({ click: (target) => seen.push(target) });
  const { client, close } = await openTools(createPreviewTools(driver, () => SCREENS));

  await client.callTool({
    name: "screen_click",
    arguments: { text: "결제하기" },
  });
  assert.deepEqual(seen.at(-1), { text: "결제하기" });
  await client.callTool({
    name: "screen_click",
    arguments: { selector: "#pay-button" },
  });
  assert.deepEqual(seen.at(-1), { selector: "#pay-button" });
  await client.callTool({
    name: "screen_click",
    arguments: { text: "결제", selector: ".pay" },
  });
  assert.deepEqual(seen.at(-1), { text: "결제", selector: ".pay" });

  const neither = await client.callTool({
    name: "screen_click",
    arguments: {},
  });
  assert.equal(neither.isError, true);
  assert.match(textOf(neither), /text 나 selector/);
  await close();
});

test("screen_console keeps error and warn, drops the rest", async () => {
  const driver = fakeDriver({
    consoleLines: () => [
      { level: "log", text: "rendered" },
      { level: "error", text: "boom" },
      { level: "warn", text: "meh" },
      { level: "WARNING", text: "loud" },
    ],
  });
  const { client, close } = await openTools(createPreviewTools(driver, () => SCREENS));
  const result = await client.callTool({
    name: "screen_console",
    arguments: {},
  });
  const text = textOf(result);
  assert.match(text, /error: boom/);
  assert.match(text, /warn: meh/);
  assert.match(text, /WARNING: loud/);
  assert.doesNotMatch(text, /rendered/);

  const quietTools = createPreviewTools(
    fakeDriver({ consoleLines: () => [{ level: "log", text: "fine" }] }),
    () => SCREENS,
  );
  const quiet = await openTools(quietTools);
  assert.match(
    textOf(await quiet.client.callTool({ name: "screen_console", arguments: {} })),
    /error·warn 이 없습니다/,
  );
  await quiet.close();
  await close();
});
