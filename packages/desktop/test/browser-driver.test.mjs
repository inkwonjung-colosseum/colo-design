/**
 * 인앱 브라우저 2단계 — PaneBrowserDriver 유닛(docs/in-app-browser-plan.md §4-2).
 * tabs.test.mjs 의 runTabsUnit 패턴: 진짜 Electron 을 띄워
 * browser-driver-unit-entry.mjs 가 dist/preview-view.js 의 PlannerPreviewView 와
 * dist/preview-driver.js 의 createBrowserDriverFactory 를 몰고 시나리오를
 * 돌리게 하고, 한 줄 JSON 답을 케이스별로 단언한다. 오프라인 — 서버 둘은
 * 로컬 fixture 다(A 는 상호작용 페이지들, B 는 두 번째 탭용).
 *
 * Run: node --test packages/desktop/test/browser-driver.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const electronBinary = join(here, "..", "node_modules", ".bin", "electron");

const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

/**
 * 서버 A — 상호작용 페이지들. /one 은 ref 액션의 전부(버튼·입력·select·키),
 * /covered 는 actionability 의 대기, /delayed 는 waitFor, /dialog 는 자동
 * 처리, /third 는 이동 뒤 옛 ref 거절의 목적지다.
 */
function startServerA() {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const bodies = {
      "/one": `<button id="go" onclick="document.getElementById('later').hidden=false">Go</button>
        <div id="later" hidden><button>After</button></div>
        <input id="name" aria-label="이름">
        <select id="pick" aria-label="고르기"><option value="a">에이</option><option value="b">비</option></select>
        <script>document.addEventListener("keydown", (e) => { if (e.key === "Enter") document.body.dataset.pressed = "1"; });</script>`,
      "/third": `<p>세 번째 페이지</p>`,
      "/covered": `<button id="late">Late</button>
        <div id="veil" style="position:fixed;inset:0;background:#000;z-index:10"></div>
        <script>setTimeout(() => document.getElementById("veil").remove(), 900);</script>`,
      "/delayed": `<p id="slot"></p>
        <script>setTimeout(() => { document.getElementById("slot").textContent = "늦게 왔다"; }, 400);</script>`,
      "/dialog": `<button id="alert" onclick="alert('안녕')">Alert</button>
        <button id="confirm" onclick="document.body.dataset.confirm = String(confirm('계속?'))">Confirm</button>`,
    };
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page(path, bodies[path] ?? "<p>빈 페이지</p>"));
  });
  return server;
}

/** 서버 B — 두 번째 탭용. 무슨 경로든 같은 페이지. */
function startServerB() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page("웹 B", "<p>웹 B</p>"));
  });
  return server;
}

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });

async function runBrowserUnit(urlA, urlB) {
  const child = spawn(electronBinary, [join(here, "browser-driver-unit-entry.mjs")], {
    env: {
      ...process.env,
      COLO_DESIGN_DESKTOP_UNIT: "1",
      COLO_BROWSER_UNIT_VIEW: pathToFileURL(join(here, "..", "dist", "preview-view.js")).href,
      COLO_BROWSER_UNIT_DRIVER: pathToFileURL(join(here, "..", "dist", "preview-driver.js")).href,
      COLO_BROWSER_UNIT_A: urlA,
      COLO_BROWSER_UNIT_B: urlB,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`browser driver unit timed out — output: ${output.slice(-2000)}`));
    }, 90_000);
    child.on("exit", () => {
      clearTimeout(timer);
      const found = output
        .split("\n")
        .find((candidate) => candidate.startsWith("COLO_BROWSER_UNIT "));
      if (found) resolve(JSON.parse(found.slice("COLO_BROWSER_UNIT ".length)));
      else
        reject(
          new Error(`browser driver unit produced no answer — output: ${output.slice(-2000)}`),
        );
    });
  });
  return line;
}

test("브라우저 드라이버: ref 세대, actionability, 다이얼로그, evaluate, waitFor, 탭 지명, pane 없으면 null", async () => {
  const serverA = startServerA();
  const serverB = startServerB();
  try {
    const [urlA, urlB] = await Promise.all([listen(serverA), listen(serverB)]);
    const result = await runBrowserUnit(urlA, urlB);
    const suffix = result.error ? ` — entry: ${result.error}` : "";
    const cases = [
      [result.paneNull, "pane getter 가 null 이면 forPane 은 null 이다"],
      [result.factoryNullBeforeTabs, "탭이 하나도 없으면 forPane 은 null 이다"],
      [result.factoryReturnsDriver, "탭이 있으면 forPane 이 드라이버를 돌려준다"],
      [result.sameInstance, "같은 pane 에는 같은 드라이버 인스턴스다"],
      [result.activeIsT1, "첫 탭이 활성 탭이다"],
      [result.snapshotHasRefs, "스냅샷이 eN 형태의 ref 를 발급한다"],
      [result.clickReturnsFreshSnapshot, "click 의 답은 새 스냅샷이다(새 노드가 보인다)"],
      [result.freshRefUsable, "새 세대의 ref 는 다시 읽지 않고 곧장 쓸 수 있다"],
      [result.staleRefRejected, "이동 뒤 옛 ref 는 '다시 읽으십시오'로 거절된다"],
      [result.typeWorks, "type(clear) 이 입력칸의 값을 바꾼다"],
      [result.pressWorks, "press(Enter) 가 페이지의 keydown 에 닿는다"],
      [result.selectWorks, "select 가 option 을 고른다"],
      [
        result.coveredClickOk === true,
        `가려진 버튼은 덮개가 걷힐 때까지 기다렸다가 눌린다 (${result.coveredElapsed}ms)`,
      ],
      [result.evaluateValue, "evaluate 가 페이지의 값을 돌려준다"],
      [result.evaluateCapThrows, "evaluate 반환은 JSON 8KB 를 넘으면 오류다"],
      [result.waitForTextTrue, "waitFor(text) 가 늦게 오는 글자를 기다린다"],
      [result.waitForTextFalse, "waitFor 는 없는 글자를 예산 안에 false 로 답한다"],
      [result.secondTabActive, "openTab 은 새 탭을 포그라운드로 연다"],
      [result.tabTargeted, "tabId 지명은 그 탭을 화면에 세운다"],
      [result.tabTargetedUrl, "지명된 탭에서 navigate 가 돈다"],
      [result.consoleOfOtherTab, "뒤편 탭의 consoleLines 도 읽힌다"],
      [result.screenshotWorks, "screenshot 이 webp 를 돌려준다"],
      [result.dialogAlertHandled, "alert 은 자동 수락된다"],
      [result.dialogConfirmHandled, "confirm 도 자동 처리된다"],
      [result.dialogConfirmDismissed, "confirm 의 답은 거절(false)이다"],
      [result.dialogReported, "다이얼로그 처리는 콘솔에 보고된다"],
      [result.closeTabWorks, "closeTab 이 지명된 탭을 닫는다"],
      [result.destroyOk, "destroy 가 끝까지 돈다"],
    ];
    for (const [ok, label] of cases) {
      if (!ok) console.error("FAIL", label, JSON.stringify(result, null, 1).slice(0, 3000));
      assert.ok(ok, `${label}${suffix}`);
    }
    assert.equal(result.error, undefined, `entry 오류 없음${suffix}`);
  } finally {
    serverA.close();
    serverB.close();
  }
});
