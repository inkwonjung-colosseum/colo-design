// PLAN-MCP §3.D 시험 — screen_check 의 인자 정규화 · 화면 하나 판정 · 그림 내리기.
// `../dist` 임포트인 이유: node --test 는 src 의 `.js` 지정자를 못 읽는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDef, Wire } from "../dist/browser-tools.js";
import { BROWSER_TOOLS, callBrowserTool } from "../dist/browser-tools.js";
import type {
  PreviewConsoleLine,
  PreviewDriver,
  PreviewOpenOptions,
  PreviewOpenResult,
} from "../dist/preview-driver.js";
import {
  judgeScreen,
  MAX_GATE_SCREENS,
  MAX_LINES_PER_SCREEN,
  normalizeScreenCheckArgs,
} from "../dist/screen-gate.js";

const PREVIEW = "http://127.0.0.1:5274";

test("normalizeScreenCheckArgs — route 와 routes 의 합집합을 순서대로 접는다", () => {
  const got = normalizeScreenCheckArgs({ route: "/a", routes: ["/b", "/c"] }, PREVIEW);
  assert.ok(got.ok);
  if (!got.ok) return;
  assert.deepEqual(got.routes, ["/a", "/b", "/c"]);
});

test("normalizeScreenCheckArgs — 같은 화면의 다른 표기는 경로 기준으로 접힌다", () => {
  const got = normalizeScreenCheckArgs({ route: "/a", routes: [`${PREVIEW}/a`, "/b"] }, PREVIEW);
  assert.ok(got.ok);
  if (!got.ok) return;
  assert.deepEqual(got.routes, ["/a", "/b"], "전체 주소와 경로는 같은 화면이다");
});

test("normalizeScreenCheckArgs — 상한을 넘으면 잘라 잘린 수를 돌려준다", () => {
  const routes = Array.from({ length: MAX_GATE_SCREENS + 1 }, (_, i) => `/s${i}`);
  const got = normalizeScreenCheckArgs({ routes }, PREVIEW);
  assert.ok(got.ok);
  if (!got.ok) return;
  assert.equal(got.routes.length, MAX_GATE_SCREENS, "본 것은 상한까지만");
  assert.equal(got.truncated, 1, "잘린 수가 답의 마지막 줄을 말하게 한다");
});

test("normalizeScreenCheckArgs — 미리보기 origin 밖의 주소는 거절한다", () => {
  const got = normalizeScreenCheckArgs({ route: "http://evil.example/x" }, PREVIEW);
  assert.ok(!got.ok);
  if (got.ok) return;
  assert.match(got.error, /미리보기 안의 화면/);
});

test("normalizeScreenCheckArgs — 주소가 하나도 없으면 오류 문장이다", () => {
  for (const params of [{}, { route: "" }, { routes: [] }, { route: "  ", routes: [""] }]) {
    const got = normalizeScreenCheckArgs(params, PREVIEW);
    assert.ok(!got.ok, `빈 인자(${JSON.stringify(params)})는 오류이다`);
    if (got.ok) continue;
    assert.match(got.error, /필요합니다/);
  }
});

test("normalizeScreenCheckArgs — 잘못된 viewport 는 오류이다", () => {
  const got = normalizeScreenCheckArgs({ route: "/a", viewport: "wide" }, PREVIEW);
  assert.ok(!got.ok);
  if (got.ok) return;
  assert.match(got.error, /viewport/);
});

test("normalizeScreenCheckArgs — viewport 기본은 desktop 이고 capture 기본은 끔이다", () => {
  const got = normalizeScreenCheckArgs({ route: "/a" }, PREVIEW);
  assert.ok(got.ok);
  if (!got.ok) return;
  assert.equal(got.viewport, "desktop");
  assert.equal(got.capture, false);
  assert.equal(got.truncated, 0, "안 잘렸으면 잘린 수를 실지 않는다");
});

/** 가짜 드라이버 — open 의 대본과 콘솔 줄을 정해 둔다. 부른 open 을 기록한다. */
function fakeDriver(opts: {
  openScript?: Array<
    (route: string, options?: PreviewOpenOptions) => PreviewOpenResult | Promise<PreviewOpenResult>
  >;
  lines?: PreviewConsoleLine[];
}): PreviewDriver & { opens: Array<{ route: string; options?: PreviewOpenOptions }> } {
  const opens: Array<{ route: string; options?: PreviewOpenOptions }> = [];
  let call = 0;
  return {
    opens,
    async open(route, options) {
      opens.push({ route, options });
      const step = opts.openScript?.[call];
      call += 1;
      if (step === undefined) return { ok: true, settled: true };
      return await step(route, options);
    },
    async screenshot() {
      return { data: "c2hvdA==", mediaType: "image/webp" };
    },
    async consoleLines() {
      return opts.lines ?? [];
    },
    async destroy() {},
  };
}

test("judgeScreen — 정상 화면은 문제 없음의 판정이다", async () => {
  const driver = fakeDriver({});
  const verdict = await judgeScreen(driver, "/a");
  assert.deepEqual(verdict, {
    route: "/a",
    opened: true,
    unsettled: false,
    blank: false,
    lines: [],
    consoleCount: 0,
    netCount: 0,
    rescued: false,
  });
});

test("judgeScreen — 다 로드됐는데 빈 화면이면 blank 다 (D2)", async () => {
  const driver = fakeDriver({});
  driver.open = async () => ({ ok: true, settled: true, blank: true });
  const verdict = await judgeScreen(driver, "/a");
  assert.ok(verdict.opened);
  if (!verdict.opened) return;
  assert.equal(verdict.blank, true);
});

test("judgeScreen — error·실패한 요청만 세고 경고는 빠뜨린다", async () => {
  const driver = fakeDriver({
    lines: [
      { level: "warn", text: "개발 빌드의 소음" },
      { level: "error", text: "렌더가 죽었다" },
      { level: "net", text: "GET /api/members 500" },
    ],
  });
  const verdict = await judgeScreen(driver, "/a");
  assert.ok(verdict.opened);
  if (!verdict.opened) return;
  assert.deepEqual(
    verdict.lines.map((line) => line.level),
    ["error", "net"],
  );
  assert.equal(verdict.consoleCount, 1);
  assert.equal(verdict.netCount, 1);
});

test("judgeScreen — 문제 줄은 화면당 상한에서 잘린다", async () => {
  const lines = Array.from({ length: MAX_LINES_PER_SCREEN + 3 }, (_, i) => ({
    level: "error",
    text: `오류 ${i}`,
  }));
  const driver = fakeDriver({ lines });
  const verdict = await judgeScreen(driver, "/a");
  assert.ok(verdict.opened);
  if (!verdict.opened) return;
  assert.equal(verdict.lines.length, MAX_LINES_PER_SCREEN);
});

test("judgeScreen — 첫 열기가 넘어지면 한 번 다시 본다 (D3)", async () => {
  const driver = fakeDriver({
    openScript: [
      () => {
        throw new Error("창 세우기 실패");
      },
      () => ({ ok: true, settled: true }),
    ],
  });
  const verdict = await judgeScreen(driver, "/a");
  assert.ok(verdict.opened, "재시도가 이으면 판정이 나온다");
  if (!verdict.opened) return;
  assert.equal(verdict.rescued, true, "한 번 넘어져서 일어난 판정임이 남는다");
  assert.equal(driver.opens.length, 2);
});

test("judgeScreen — viewport 는 open 에(재시도에도) 그대로 간다", async () => {
  const driver = fakeDriver({
    openScript: [
      () => {
        throw new Error("창 세우기 실패");
      },
      () => ({ ok: true, settled: true }),
    ],
  });
  await judgeScreen(driver, "/a", { viewport: "mobile" });
  assert.deepEqual(driver.opens[0]?.options, { viewport: "mobile" });
  assert.deepEqual(driver.opens[1]?.options, { viewport: "mobile" });
});

test("screen_check 도구 — route 는 필수가 아니고 네 인자를 선언한다", () => {
  const tool = BROWSER_TOOLS.find((entry) => entry.name === "screen_check") as ToolDef;
  assert.ok(!tool.required?.includes("route"), "route 와 routes 중 무엇이든 쓸 수 있다");
  for (const name of ["route", "routes", "viewport", "capture"]) {
    assert.ok(tool.properties[name], `${name} 을 선언한다`);
  }
  assert.deepEqual(
    tool.properties.viewport?.enum,
    ["mobile", "tablet", "desktop"],
    "틀린 폭을 덜 보내게 고른 칸을 선언한다",
  );
});

/** 전역 fetch 를 가짜로 — 데몬의 답을 정해 둔다. */
function stubFetch(body: unknown): { restore: () => void; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), bodies };
}

const SCREEN_CHECK_TOOL = BROWSER_TOOLS.find((entry) => entry.name === "screen_check") as ToolDef;
const RELAY = { daemonUrl: "http://127.0.0.1:1", secret: "s" };

test("callBrowserTool — screen_check 의 그림을 image 블록으로 내린다", async () => {
  const stub = stubFetch({
    ok: true,
    result: {
      screens: [
        {
          url: `${PREVIEW}/a`,
          settled: false,
          blank: true,
          errors: [],
          capture: { data: "QUJD", mediaType: "image/webp" },
        },
        { url: `${PREVIEW}/b`, settled: true, blank: false, errors: [] },
      ],
      truncated: 2,
    },
  });
  try {
    const outcome = await callBrowserTool(SCREEN_CHECK_TOOL, {} as Wire, RELAY);
    assert.notEqual(outcome.isError, true);
    const first = outcome.content[0];
    assert.equal(first.type, "text", "첫 블록은 screens 의 JSON 텍스트다");
    if (first.type !== "text") return;
    const parsed = JSON.parse(first.text) as {
      screens: Array<Record<string, unknown>>;
      truncated?: number;
    };
    assert.equal(parsed.truncated, 2, "잘린 수는 텍스트에 실린다");
    assert.equal(parsed.screens.length, 2);
    assert.ok(!("capture" in parsed.screens[0]), "그림 칸은 JSON에서 뗀다");
    assert.ok(!first.text.includes("QUJD"), "base64 를 텍스트에 싣지 않는다");
    assert.equal(outcome.content[1]?.type, "image");
    if (outcome.content[1]?.type !== "image") return;
    assert.equal(outcome.content[1].data, "QUJD");
    assert.equal(outcome.content[1].mimeType, "image/webp");
    assert.equal(outcome.content.length, 2, "문제 없는 화면은 그림이 없다");
  } finally {
    stub.restore();
  }
});

test("callBrowserTool — 그림 없는 screen_check 답은 텍스트 블록 하나다", async () => {
  const stub = stubFetch({
    ok: true,
    result: { screens: [{ url: `${PREVIEW}/a`, settled: true, blank: false, errors: [] }] },
  });
  try {
    const outcome = await callBrowserTool(SCREEN_CHECK_TOOL, {} as Wire, RELAY);
    assert.equal(outcome.content.length, 1);
    assert.equal(outcome.content[0]?.type, "text");
  } finally {
    stub.restore();
  }
});
