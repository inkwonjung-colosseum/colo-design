// PLAN 단계 6 시험 — 세션에 실리는 도구 목록의 판정 (L6 · O6).
// `../dist` 임포트인 이유: node --test 는 src 의 `.js` 지정자를 못 읽는다.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { browserMcpEntry } from "../dist/browser-launch.js";
import {
  BROWSER_TOOLS,
  browserTools,
  callBrowserTool,
  classifyBrowserFailure,
  isBrowserToolName,
  submitNoteOf,
  waitForAnswer,
  waitForBudgetMs,
} from "../dist/browser-tools.js";

test("browserTools — submit_for_review 는 판정이 켜진 세션에만 실린다", () => {
  const full = browserTools(true);
  const cut = browserTools(false);
  assert.ok(
    full.some((tool) => tool.name === "submit_for_review"),
    "켜면 실린다",
  );
  assert.ok(!cut.some((tool) => tool.name === "submit_for_review"), "끄면 빠진다");
  assert.equal(cut.length, full.length - 1, "빠지는 것은 그 하나뿐이다");
  for (const tool of cut) assert.ok(full.includes(tool), "나머지 도구는 그대로다");
});

test("submit_for_review — note 를 선언하지만 required 는 아니다", () => {
  const tool = browserTools(true).find((t) => t.name === "submit_for_review");
  assert.ok(tool, "켜면 실린다");
  assert.equal(tool.properties.note?.type, "string", "note 는 문자열 인자다");
  assert.ok(!tool.required?.includes("note"), "한마디는 선택이다 — required 에서 빠진다");
});

test("submitNoteOf — 공백을 걷고 200자에서 자르며 빈 문자열은 없음이다", () => {
  assert.equal(submitNoteOf({}), undefined, "인자가 없으면 한마디도 없다");
  assert.equal(submitNoteOf({ note: 42 }), undefined, "문자열이 아니면 한마디가 아니다");
  assert.equal(submitNoteOf({ note: "   " }), undefined, "공백만 있으면 한마디가 아니다");
  assert.equal(
    submitNoteOf({ note: "  주말에 봐 주세요  " }),
    "주말에 봐 주세요",
    "앞뒤 공백을 걷는다",
  );
  assert.equal(submitNoteOf({ note: "가".repeat(201) }).length, 200, "200자에서 자른다");
  assert.equal(submitNoteOf({ note: "가".repeat(200) }).length, 200, "정확히 200자는 그대로다");
});

/** 계약 안의 도구를 이름으로 찾는다 — 시험의 재료는 제품과 같은 표다. */
function toolOf(name: string) {
  const tool = BROWSER_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `${name} 이 계약에 있다`);
  return tool;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 전역 fetch 를 가짜로 갈아끼운다 — 끝나면 제자리 돌려 시험끼리 오염하지 않는다. */
async function withFetch<T>(stub: typeof fetch, body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

test("callBrowserTool — 상태·ok:false·도달 실패·계약 밖 응답은 모두 isError 텍스트다", async () => {
  const relay = { daemonUrl: "http://127.0.0.1:9", secret: "s" };
  const cases: Array<{ label: string; respond: () => Response; marker: string }> = [
    { label: "401", respond: () => new Response("", { status: 401 }), marker: "401로 거절했다" },
    { label: "404", respond: () => new Response("", { status: 404 }), marker: "404로 거절했다" },
    {
      label: "ok:false",
      respond: () => jsonResponse({ ok: false, error: "e5 는 지금 화면의 것이 아닙니다" }),
      marker: "지금 화면의 것이 아닙니다",
    },
    {
      label: "도달 실패(throw)",
      respond: () => {
        throw new Error("connect ECONNREFUSED");
      },
      marker: "도달하지 못했다",
    },
    {
      label: "계약 밖 응답(ok 없음)",
      respond: () => jsonResponse({ result: 1 }),
      marker: "계약에 없는 형태다",
    },
  ];
  for (const { label, respond, marker } of cases) {
    await withFetch(respond, async () => {
      const outcome = await callBrowserTool(toolOf("browser_console"), {}, relay);
      assert.equal(outcome.isError, true, label);
      const block = outcome.content[0];
      assert.ok(
        block?.type === "text" && block.text.includes(marker),
        `${label}: ${JSON.stringify(outcome.content)}`,
      );
    });
  }
});

test("callBrowserTool — 스크린샷은 텍스트가 아니라 image 블록으로 내려간다", async () => {
  await withFetch(
    () => jsonResponse({ ok: true, result: { data: "QUJD", mediaType: "image/webp" } }),
    async () => {
      const outcome = await callBrowserTool(
        toolOf("browser_screenshot"),
        {},
        {
          daemonUrl: "http://127.0.0.1:9",
          secret: "s",
        },
      );
      assert.equal(outcome.isError, undefined);
      const block = outcome.content[0];
      assert.ok(block?.type === "image", "image 블록이다");
      assert.equal(block.type === "image" ? block.data : "", "QUJD");
      assert.equal(block.type === "image" ? block.mimeType : "", "image/webp");
    },
  );
});

/** initialize 응답의 serverInfo — 와이어 JSON 을 in·typeof 로 좁혀 읽는다(인라인 캐스트 회피). */
function serverInfoOf(message: Record<string, unknown>): Record<string, unknown> {
  const result: unknown = message.result;
  if (typeof result === "object" && result !== null && "serverInfo" in result) {
    const info: unknown = result.serverInfo;
    // 이미 object 로 좁혀진 뒤다 — 필드 읽기를 위한 느슨한 사전으로 한 번만 편다.
    if (typeof info === "object" && info !== null) return info as Record<string, unknown>;
  }
  return {};
}

/** stdio JSON-RPC 자식 — 요청 id 별로 한 줄 응답을 기다린다(줄 단위 버퍼 포함). */
class McpChild {
  private seq = 0;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  private readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === "number") this.pending.get(message.id)?.(message);
      }
    });
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    // 파수 타임아웃 — 응답을 기다리는 실제 신호이지 잠이 아니다. 정상 경로는
    // 딜레이를 더하지 않는다.
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(() => reject(new Error(`응답이 없다: ${method}`)), 10_000);
    timer.unref();
    this.pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }
}

test("browser-mcp 악수 — initialize → tools/list → 모르는 도구와 중계 실패는 도구 결과로 온다", async () => {
  const env = { ...process.env };
  delete env.NOVA_BROWSER_SUBMIT;
  // 닫힌 포트 — 중계 실패까지 결과로 내려오는 길을 함께 본다.
  env.NOVA_DAEMON_URL = "http://127.0.0.1:1";
  env.NOVA_BROWSER_SECRET = "test-secret";
  env.NOVA_APP_VERSION = "9.9.9";
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, "..", "dist", "browser-mcp.js")],
    {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const mcp = new McpChild(child);
  try {
    const init = await mcp.call("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.error, undefined);
    const info = serverInfoOf(init);
    assert.equal(info.name, "nova-browser");
    assert.equal(info.title, "콜로디자인 도구");
    assert.equal(
      info.version,
      "9.9.9",
      "env 의 앱 버전이 serverInfo.version 으로 흘러간다(PLAN-MCP §3.F)",
    );

    const list = await mcp.call("tools/list", {});
    const tools = (list.result as { tools?: Array<{ name?: string }> }).tools ?? [];
    assert.ok(
      tools.some((tool) => tool.name === "browser_snapshot"),
      "스냅샷 도구가 실린다",
    );
    assert.ok(
      !tools.some((tool) => tool.name === "submit_for_review"),
      "NOVA_BROWSER_SUBMIT 이 없으면 제출 도구는 빠진다",
    );

    const unknown = await mcp.call("tools/call", { name: "browser_teleport", arguments: {} });
    assert.equal(unknown.error, undefined, "모르는 도구는 JSON-RPC 오류가 아니다");
    const unknownResult = unknown.result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    assert.equal(unknownResult.isError, true);
    assert.ok(unknownResult.content?.[0]?.text?.includes("알 수 없는 도구"));

    const relayed = await mcp.call("tools/call", { name: "browser_console", arguments: {} });
    assert.equal(relayed.error, undefined, "중계 실패도 JSON-RPC 오류가 아니다");
    const relayedResult = relayed.result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    assert.equal(relayedResult.isError, true);
    assert.ok(relayedResult.content?.[0]?.text?.includes("도달하지 못했다"));
  } finally {
    child.kill();
  }
});

test("isBrowserToolName — 세 프로바이더의 이름 형태를 모두 본다", () => {
  assert.equal(isBrowserToolName("screen_check"), true, "omp — 맨 이름");
  assert.equal(isBrowserToolName("mcp__nova-browser__screen_check"), true, "claude — mcp__ 접두");
  assert.equal(isBrowserToolName("nova-browser/browser_snapshot"), true, "codex — 슬래시 접두");
  assert.equal(isBrowserToolName("browser_teleport"), false, "browser_ 접두만 같은 이름은 아니다");
  assert.equal(
    isBrowserToolName("mcp__other-server__browser_click"),
    false,
    "다른 MCP 서버는 아니다",
  );
  assert.equal(isBrowserToolName("Edit"), false, "일반 도구는 아니다");
});

test("classifyBrowserFailure — 다섯 종류로 나뉜다", () => {
  assert.equal(
    classifyBrowserFailure("e5 는 지금 화면의 것이 아닙니다 — snapshot 으로 다시 읽으십시오."),
    "stale-ref",
  );
  assert.equal(classifyBrowserFailure("브라우저 명령이 시간을 넘겼습니다."), "timeout");
  assert.equal(classifyBrowserFailure("사용자가 이 화면에 대한 접근을 거절했습니다."), "refused");
  assert.equal(
    classifyBrowserFailure("브라우저 드라이버가 없습니다 — 데스크톱 앱에서만 동작합니다."),
    "no-pane",
  );
  assert.equal(
    classifyBrowserFailure(
      "브라우저 창이 아직 없습니다 — 탭을 열거나 미리보기를 띄운 뒤 다시 시도해 주세요.",
    ),
    "no-pane",
  );
  assert.equal(
    classifyBrowserFailure("미리보기 화면이 없습니다 — 화면이 보이는 상태에서 다시 시도하십시오."),
    "no-pane",
  );
  assert.equal(classifyBrowserFailure("뜻밖의 오류"), "other");
});

test("BROWSER_TOOLS — 배열 인자는 모두 items 를 선언한다", () => {
  for (const tool of BROWSER_TOOLS) {
    for (const [name, property] of Object.entries(tool.properties)) {
      if (property.type !== "array") continue;
      assert.equal(
        property.items?.type,
        "string",
        `${tool.name}.${name} — items 없는 배열은 OpenAI·Gemini 계열이 도구 전체를 거절한다`,
      );
    }
  }
});

test("waitForBudgetMs — 드라이버와 같은 규칙으로 기본 5초 · 상한 30초를 계산한다", () => {
  assert.equal(waitForBudgetMs(undefined), 5_000, "ms 가 없으면 기본 5초다");
  assert.equal(waitForBudgetMs(-5), 5_000, "음수는 기본 예산으로");
  assert.equal(waitForBudgetMs(1_500), 1_500, "있으면 그 값이다");
  assert.equal(waitForBudgetMs(90_000), 30_000, "상한을 넘으면 30초로 깎인다");
});

test("waitForAnswer — 참은 사실 한 줄, 거짓은 실제 예산을 말한다(isError 가 아닌 길)", () => {
  assert.equal(waitForAnswer(true, undefined), "조건을 만족했습니다");
  assert.equal(waitForAnswer(true, 20_000), "조건을 만족했습니다", "성공은 예산을 말하지 않는다");
  assert.equal(
    waitForAnswer(false, undefined),
    "조건을 5초 안에 만족하지 못했습니다 — 화면을 다시 읽거나 조건을 바꾸십시오",
  );
  assert.equal(
    waitForAnswer(false, 30_000),
    "조건을 30초 안에 만족하지 못했습니다 — 화면을 다시 읽거나 조건을 바꾸십시오",
  );
  assert.equal(
    waitForAnswer(false, 1_500),
    "조건을 1.5초 안에 만족하지 못했습니다 — 화면을 다시 읽거나 조건을 바꾸십시오",
    "초는 잘라 올리지 않는다 — 1.5초가 2초로 불어나지 않는다",
  );
  assert.equal(
    waitForAnswer(false, 90_000),
    "조건을 30초 안에 만족하지 못했습니다 — 화면을 다시 읽거나 조건을 바꾸십시오",
    "문장의 예산은 드라이버가 실제로 기다린 값이다",
  );
});

test("browserMcpEntry — 앱 버전을 NOVA_APP_VERSION 으로 싣는다(있을 때 · 없을 때)", () => {
  const withVersion = browserMcpEntry(true, "http://127.0.0.1:1", "s", false, "0.3.15");
  assert.equal(withVersion?.env.NOVA_APP_VERSION, "0.3.15", "버전을 알면 env 로 자식에 실린다");
  const withoutVersion = browserMcpEntry(true, "http://127.0.0.1:1", "s", false);
  assert.equal(
    withoutVersion?.env.NOVA_APP_VERSION,
    undefined,
    "버전을 모르면 env 도 없다 — 자식은 0 으로 산다",
  );
});
