/**
 * 대화 설정 칩의 단계 걸음 — 팝오버가 확인 방식·모델·생각 시간을 한 판에
 * 다 펼치지 않는지 잡는 브라우저 수준 스위트.
 *
 * 칩 하나가 요약(모델 · 생각 · 방식)을 입고, 팝오버는 뿌리에서 좁혀 든다.
 * 뿌리가 프로바이더를 포함한 네 설정의 지금값을 입은 네 줄만 내미는 일, 고른
 * 설정의 단계에서만 그 행들이 열리는 일, ← 가 뿌리로 돌려놓는 일, 그리고
 * 열림마다 뿌리부터 — 닫혀 있던 단계를 기억하면 칩의 요약과 메뉴가 다른
 * 층을 가리키므로. 열린 대화의 프로바이더 단계는 고름의 범위(다음 새 대화)를
 * 노트 한 줄로 말한다.
 *
 * Free: no real Claude turn. Offline end to end — daemon, SDK, stub CLI.
 *
 * Prerequisite: `pnpm --filter @colo-design/web build`
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createFixtureRepo, freePort } from "../../daemon/test/fixture-repo.mjs";
import { stopDaemon } from "./stop-daemon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "colo-design-chat-settings-ui-e2e");
const PORT = 5420;

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") throw new Error(`check("${name}") was called without a verdict`);
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
};

function serveDist() {
  const server = createServer((req, res) => {
    const path = req.url === "/" ? "/index.html" : (req.url ?? "/").split("?")[0];
    const file = existsSync(join(webDist, path))
      ? join(webDist, path)
      : join(webDist, "index.html");
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

/** 모든 턴에 곧바로 답하는 스텁 CLI — 대화를 여는 최소한의 한 턴만 산다. */
function instantStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'if (process.argv[2] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (process.argv[2] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
      "  process.exit(0);",
      "}",
      'let buf = "";',
      'let sessionId = "stub";',
      "const seen = () => {",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      '    if (line.includes(\'"subtype":"set_permission_mode"\')) {',
      '      const id = (line.match(/"request_id":"([^"]*)"/) || [])[1];',
      "      process.stdout.write(JSON.stringify({",
      '        type: "control_response",',
      '        response: { subtype: "success", request_id: id },',
      '      }) + "\\n");',
      "      continue;",
      "    }",
      '    if (line.includes(\'"type":"user"\')) {',
      '      sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || sessionId;',
      "      process.stdout.write(JSON.stringify({",
      '        type: "result", subtype: "success", is_error: false,',
      '        session_id: sessionId, result: "알겠습니다.", num_turns: 1, duration_ms: 10,',
      "        duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {},",
      "        permission_denials: [], errors: [],",
      '      }) + "\\n");',
      "      setTimeout(() => process.exit(0), 300);",
      "      return;",
      "    }",
      "  }",
      "};",
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { buf += chunk; seen(); });',
      'process.stdin.on("end", () => process.exit(0));',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function main() {
  if (!existsSync(webDist))
    throw new Error("web dist missing. Run: pnpm --filter @colo-design/web build");
  if (!existsSync(daemonEntry))
    throw new Error("daemon dist missing. Run: pnpm --filter @colo-design/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  const fixture = await createFixtureRepo({
    dir: join(DIR, "fixture"),
    port: await freePort(),
  });

  const env = {
    ...process.env,
    COLO_DESIGN_PORT: String(await freePort()),
    COLO_DESIGN_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    COLO_DESIGN_PROJECTS_DIR: join(DIR, "projects"),
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    COLO_DESIGN_CLAUDE_BIN: instantStubClaude(join(DIR, "bin")),
    COLO_DESIGN_CREDENTIAL_STORE: "memory",
    COLO_DESIGN_DEV_SERVER: `http://127.0.0.1:${PORT}`,
  };
  delete env.ANTHROPIC_API_KEY;
  const daemon = spawn(process.execPath, [daemonEntry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  process.on("exit", () => daemon.kill("SIGKILL"));
  const daemonUrl = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("daemon never printed a url")), 20000);
    let buffered = "";
    daemon.stdout.on("data", (chunk) => {
      buffered += String(chunk);
      const match = buffered.match(/client url: (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        ok(match[1]);
      }
    });
  });

  const server = await serveDist();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const failures = [];
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("console", (m) => m.type() === "error" && failures.push(m.text()));

  /** A second socket from the page: setup and session wiring. */
  const call = (message, timeoutMs = 60000) =>
    page.evaluate(
      async ({ url, message, timeoutMs }) => {
        const ws = new WebSocket(url);
        await new Promise((ok, fail) => {
          ws.addEventListener("open", ok, { once: true });
          ws.addEventListener("error", () => fail(new Error("socket refused")), { once: true });
        });
        try {
          return await new Promise((ok, fail) => {
            const timer = setTimeout(() => fail(new Error(`${message.type} timed out`)), timeoutMs);
            ws.addEventListener("message", (event) => {
              const reply = JSON.parse(String(event.data));
              if (reply.id !== message.id) return;
              clearTimeout(timer);
              reply.type === "ok" ? ok(reply.data) : fail(new Error(reply.message));
            });
            ws.send(JSON.stringify(message));
          });
        } finally {
          ws.close();
        }
      },
      {
        url: daemonUrl,
        message: { ...message, id: `t${Math.random().toString(36).slice(2)}` },
        timeoutMs,
      },
    );

  const composer = page.getByLabel("메시지");
  const menu = page.locator(".composer .selector__menu");
  const rootDrills = page.locator(".composer .selector__menu .selector__drill");

  try {
    // 첫 실행 투어의 예시 창은 빈 대화마다 선다 — 이 스위트는 투어가
    // 아니라 그 아래의 화면을 본다.
    await page.addInitScript(() => localStorage.setItem("colo-design.tour-step", "done"));
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".onboarding--start", { timeout: 60000 });

    await call({
      type: "project.create",
      name: "단계메뉴",
      repoUrl: fixture.remote,
      approveCommands: true,
    });
    for (let deadline = Date.now() + 90000; Date.now() < deadline; ) {
      const status = await call({ type: "repo.status" }, 15000);
      if (status.phase === "ready") break;
      if (status.phase === "error") throw new Error(`clone: ${status.detail ?? status.phase}`);
      await sleep(1000);
    }

    await page.locator(".leaf--start").first().click();
    await page.locator(".empty__lead").waitFor({ timeout: 15000 });
    await composer.fill("대화를 열 문장입니다");
    await composer.press("Enter");
    await page.locator(".turndone").first().waitFor({ timeout: 30000 });

    // --- 1. the chip opens at the root: four summary drills, no rows -----
    // 모델·생각은 session.selectors 응답이 와야 칩에 선다 — 턴 종료보다 늦을
    // 수 있으므로(느린 러너) 요약이 채워질 때까지 기다린 뒤 읽는다.
    // waitForFunction 의 둘째 인자는 pageFunction 의 arg 다 — options 를
    // 둘째에 넘기면 timeout 은 조용히 무시되고 기본 30초가 돌았다(CI 로그의
    // "Timeout 30000ms exceeded"). options 는 셋째 자리다.
    try {
      await page.waitForFunction(
        () => /·/.test(document.querySelector(".composer .selector__chiplabel")?.textContent ?? ""),
        undefined,
        { timeout: 45_000 },
      );
    } catch (error) {
      const stuck = await page
        .locator(".composer .selector__chiplabel")
        .innerText({ timeout: 2000 })
        .catch(() => "(칩을 읽지 못했다)");
      console.error(`[chat-settings] 칩 요약이 45초 안에 안 찼다 — 칩: ${stuck.trim()}`);
      throw error;
    }
    const chipLabel = (await page.locator(".composer .selector__chiplabel").innerText()).trim();
    check("chip still reads the three-value summary", /·/.test(chipLabel), chipLabel);
    await page.locator(".composer .selector__chip").click();
    await menu.waitFor({ timeout: 5000 });
    const drillNames = await page
      .locator(".composer .selector__menu .selector__drillname")
      .allInnerTexts();
    check(
      "root shows the four settings, provider first",
      JSON.stringify(drillNames) ===
        JSON.stringify(["프로바이더", "모델", "생각 시간", "확인 방식"]),
      drillNames.join(" / "),
    );
    const drillVals = await page
      .locator(".composer .selector__menu .selector__drillval")
      .allInnerTexts();
    check(
      "root drills carry the current values, the provider row reading the pick",
      drillVals.length === 4 && drillVals[0] === "Claude",
      drillVals.join(" / "),
    );
    const drillDescs = await page
      .locator(".composer .selector__menu .selector__drilldesc")
      .allInnerTexts();
    check(
      "root drills carry a plain-language reading of the value",
      drillDescs.length === 4 && drillDescs.every((text) => text.trim().length > 0),
      drillDescs.join(" / "),
    );
    check(
      "no option rows leak into the root",
      (await page.locator(".composer .selector__menu .selector__row").count()) === 0,
    );

    // --- 2. the 프로바이더 step: the lock note, the rows, the reasons ------
    await rootDrills.filter({ hasText: "프로바이더" }).click();
    await page
      .locator(".composer .selector__menu .selector__row")
      .first()
      .waitFor({ timeout: 5000 });
    const lockNote = await page.locator(".composer .selector__menu .selector__note").innerText();
    check(
      "provider step names the lock to the open thread",
      lockNote.includes("열린 대화") && lockNote.includes("다음 새 대화"),
      lockNote,
    );
    const provRows = await page
      .locator(".composer .selector__menu .selector__row .selector__label")
      .allInnerTexts();
    check(
      "provider step lists the daemon's providers",
      provRows.includes("Claude"),
      provRows.join(" / "),
    );
    const checkedRows = await page
      .locator(".composer .selector__menu .selector__row")
      .evaluateAll(
        (rows) => rows.filter((row) => row.querySelector(".selector__check svg")).length,
      );
    check(
      "the current pick is the one row wearing the check",
      provRows.length >= 1 && checkedRows === 1,
      `checked=${checkedRows}`,
    );
    await page.locator(".composer .selector__back").click();
    await rootDrills.first().waitFor({ timeout: 5000 });

    // --- 3. drilling into 확인 방식 narrows to its rows; back returns ------
    await rootDrills.filter({ hasText: "확인 방식" }).click();
    await page
      .locator(".composer .selector__menu .selector__row")
      .first()
      .waitFor({ timeout: 5000 });
    const modeRows = await page
      .locator(".composer .selector__menu .selector__row .selector__label")
      .allInnerTexts();
    check(
      "mode step lists the modes",
      modeRows.includes("실행 전에 물어보기") && modeRows.includes("계획 먼저 보기"),
      modeRows.join(" / "),
    );
    check("drills are gone inside the mode step", (await rootDrills.count()) === 0);
    await page.locator(".composer .selector__back").click();
    await rootDrills.first().waitFor({ timeout: 5000 });
    check("back returns to the root drills", true);

    // --- 4. 생각 시간 step shows the effort rows ---------------------------
    await rootDrills.filter({ hasText: "생각 시간" }).click();
    await page
      .locator(".composer .selector__menu .selector__row")
      .first()
      .waitFor({ timeout: 5000 });
    const effortRows = await page
      .locator(".composer .selector__menu .selector__row .selector__label")
      .allInnerTexts();
    check("effort step lists effort levels", effortRows.length > 0, effortRows.join(" / "));
    const fills = await page
      .locator(".composer .selector__menu .selector__meter")
      .evaluateAll((meters) =>
        meters.map((meter) => meter.querySelectorAll(".selector__meterdot--on").length),
      );
    check(
      "effort rows carry the depth meter, one step deeper per row",
      fills.length === effortRows.length && fills.every((count, i) => count === i + 1),
      fills.join("/"),
    );
    await page.locator(".composer .selector__back").click();
    await rootDrills.first().waitFor({ timeout: 5000 });

    // --- 5. a picked mode closes the menu and lands on the chip ------------
    await rootDrills.filter({ hasText: "확인 방식" }).click();
    await page
      .locator(".composer .selector__menu .selector__row")
      .first()
      .waitFor({ timeout: 5000 });
    await page
      .locator(".composer .selector__menu .selector__row", { hasText: "계획 먼저 보기" })
      .click();
    await menu.waitFor({ state: "detached", timeout: 5000 });
    const chipAfter = (await page.locator(".composer .selector__chiplabel").innerText()).trim();
    check(
      "picking a mode closes the menu and the chip follows",
      chipAfter.includes("계획 먼저 보기"),
      chipAfter,
    );

    // --- 6. reopening lands at the root again (not the last step) ----------
    await page.locator(".composer .selector__chip").click();
    await menu.waitFor({ timeout: 5000 });
    await rootDrills.first().waitFor({ timeout: 5000 });
    check("reopen starts at the root", (await rootDrills.count()) === 4);
    check("no page errors while walking the steps", failures.length === 0, failures.join(" | "));
  } finally {
    await browser.close();
    server.close();
    await stopDaemon(daemon);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name}`);
    process.exit(1);
  }
}

await main();
