/**
 * 대화 설정 메뉴의 고르기 체인 — 프로바이더 → 모델 → 생각 시간 → 확인 방식
 * 순서로 값이 이어지는지 잡는 브라우저 수준 스위트.
 *
 * 모델 목록은 살아 있는 세션만 줄 수 있어 데몬 세계에서는 다루기 어렵다 —
 * 이 스위트는 chatpreview.html 하니스(진짜 Composer + 고정 fixture)를
 * vite 개발 서버로 띄워 실제 컴포넌트의 걸음을 본다. 체인의 규칙:
 * 행에서 값을 고르면 메뉴는 닫히는 대신 다음 걸음으로 이어지고, 마지막
 * 확인 방식을 고르면 닫힌다. 노력을 못 정하는 모델은 생각 단계를 건너뛴다.
 *
 * Prerequisite: 없음 — vite dev 서버를 직접 띄운다.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { freePort } from "../../daemon/test/fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "..");

const results = [];
function check(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** vite 개발 서버 — 하니스 페이지(chatpreview.html)를 띄운다. */
async function startDevServer() {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      resolve(webDir, "node_modules", "vite", "bin", "vite.js"),
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: webDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));
  for (let deadline = Date.now() + 30000; Date.now() < deadline; ) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/chatpreview.html`);
      if (res.ok) return { child, port };
    } catch {
      // 아직 준비 전
    }
    await sleep(300);
  }
  child.kill("SIGKILL");
  throw new Error("vite dev server never became ready");
}

async function main() {
  const vite = await startDevServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  const menu = page.locator(".composer .selector__menu");
  const chip = page.locator(".composer .selector__chiplabel");
  const openMenu = async () => {
    await page.locator(".composer .selector__chip").click();
    await menu.waitFor({ timeout: 5000 });
  };

  try {
    await page.goto(`http://127.0.0.1:${vite.port}/chatpreview.html`);
    await page.waitForSelector(".composer .selector__chip", { timeout: 30000 });

    // --- 1. 뿌리는 고르는 순서 그대로: 프로바이더 → 모델 → 생각 → 확인 ----
    await openMenu();
    const names = await page
      .locator(".composer .selector__menu .selector__drillname")
      .allInnerTexts();
    check(
      "root reads the picking order",
      JSON.stringify(names) === JSON.stringify(["프로바이더", "모델", "생각 시간", "확인 방식"]),
      names.join(" → "),
    );

    // --- 2. 프로바이더 고르기 → 모델 단계로 이어진다 ------------------------
    await page.locator(".selector__drill", { hasText: "프로바이더" }).click();
    await page.locator(".selector__row", { hasText: "Claude" }).first().waitFor();
    // 이 기기에 없는 에이전트는 행에 이유가 적힌 채 못 고르는 몸이 된다.
    const openRow = page.locator(".selector__row", { hasText: "Codex" });
    check(
      "unavailable provider stands disabled with its reason",
      (await openRow.getAttribute("disabled")) !== null &&
        (await openRow.locator(".selector__desc").innerText()).length > 0,
    );
    await page.locator(".selector__row", { hasText: "omp" }).click();
    await page.locator(".selector__provbtn").first().waitFor({ timeout: 5000 });
    const provName = await page.locator(".selector__provbtn .selector__provname").innerText();
    check("provider pick flows into its models", provName.trim() === "omp", provName);

    // --- 3. 모델 고르기 → 생각 시간 단계로 이어진다 (메뉴는 닫히지 않음) ----
    await page.locator(".selector__row", { hasText: "Opus 5" }).first().click();
    await page.locator(".selector__meter").first().waitFor({ timeout: 5000 });
    check("model pick flows into the effort step, menu stays open", true);

    // --- 4. 생각 시간 고르기 → 확인 방식 단계으로 이어진다 -------------------
    await page.locator(".selector__row", { hasText: "High" }).first().click();
    await page
      .locator(".selector__row", { hasText: "화면 수정은 바로" })
      .first()
      .waitFor({ timeout: 5000 });
    check("effort pick flows into the mode step", true);

    // --- 5. 확인 방식 고르기 → 체인의 끝, 메뉴가 닫히고 칩이 요약한다 -------
    await page.locator(".selector__row", { hasText: "실행 전에 물어보기" }).first().click();
    await menu.waitFor({ state: "detached", timeout: 5000 });
    const chipChain = (await chip.innerText()).trim();
    check(
      "mode pick ends the chain and the chip reads every pick",
      chipChain.includes("Opus 5") &&
        chipChain.includes("High") &&
        chipChain.includes("실행 전에 물어보기"),
      chipChain,
    );
    await page.screenshot({ path: `${here}/ui-selector-chain-e2e.png` });

    // --- 6. 노력을 못 정하는 모델은 생각 단계를 건너뛴다 --------------------
    await openMenu();
    await page.locator(".selector__drill", { hasText: "모델" }).click();
    await page.locator(".selector__row", { hasText: "Haiku 5" }).first().click();
    await page
      .locator(".selector__row", { hasText: "화면 수정은 바로" })
      .first()
      .waitFor({ timeout: 5000 });
    const meters = await page.locator(".selector__meter").count();
    check("non-effort model skips the effort step into mode", meters === 0);
    await page.locator(".selector__row", { hasText: "계획 먼저 보기" }).first().click();
    await menu.waitFor({ state: "detached", timeout: 5000 });

    check("no page errors while walking the chain", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    vite.child.kill("SIGKILL");
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name}`);
    process.exit(1);
  }
}

await main();
