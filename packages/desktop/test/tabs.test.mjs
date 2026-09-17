/**
 * 인앱 브라우저 1단계 — 탭 모델 유닛(docs/in-app-browser-plan.md §3·§4-1).
 * desktop.test.mjs 의 runDriverUnit 패턴: 진짜 Electron 을 띄워
 * tabs-unit-entry.mjs 가 dist/preview-view.js 의 PlannerPreviewView 를 몰고
 * 시나리오를 돌리게 하고, 한 줄 JSON 답을 케이스별로 단언한다. 오프라인 —
 * 서버 둘은 로컬 fixture 다(A 는 repo 진영, B 는 웹 진영).
 *
 * Run: node --test packages/desktop/test/tabs.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const electronBinary = join(here, "..", "node_modules", ".bin", "electron");

/** 탭이 드나드는 페이지 — 스트립의 제목이 여기서 온다. */
const tabPage = (title) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;

/**
 * 서버 A — repo 진영. /hits 는 이 조회 앞까지 받은 요청 수를 돌려준다:
 * epoch 이동의 재로드는 페이지를 다시 달라고 하므로 요청 수가 불어난다.
 */
function startServerA() {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/hits") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(hits - 1));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(tabPage(path === "/repo" ? "리포 A" : "리포 A 문서"));
  });
  return server;
}

/** 서버 B — 웹 진영. 무슨 경로든 같은 페이지, 마운트되지 않는 origin 이다. */
function startServerB() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(tabPage("웹 B"));
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

async function runTabsUnit(urlA, urlB) {
  const child = spawn(electronBinary, [join(here, "tabs-unit-entry.mjs")], {
    env: {
      ...process.env,
      COLO_DESIGN_DESKTOP_UNIT: "1",
      COLO_TABS_UNIT_VIEW: pathToFileURL(join(here, "..", "dist", "preview-view.js")).href,
      COLO_TABS_UNIT_A: urlA,
      COLO_TABS_UNIT_B: urlB,
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
      reject(new Error(`tab model unit timed out — output: ${output.slice(-2000)}`));
    }, 90_000);
    child.on("exit", () => {
      clearTimeout(timer);
      const found = output.split("\n").find((candidate) => candidate.startsWith("COLO_TABS_UNIT "));
      if (found) resolve(JSON.parse(found.slice("COLO_TABS_UNIT ".length)));
      else reject(new Error(`tab model unit produced no answer — output: ${output.slice(-2000)}`));
    });
  });
  return line;
}

test("미리보기 탭 모델: 생성·전환·닫기, evict 후 재로드, window.open, kind 전환, repo 중복 금지", async () => {
  const serverA = startServerA();
  const serverB = startServerB();
  try {
    const [urlA, urlB] = await Promise.all([listen(serverA), listen(serverB)]);
    const result = await runTabsUnit(urlA, urlB);
    const suffix = result.error
      ? ` — entry: ${result.error}`
      : ` — debug: ${JSON.stringify({ url: result.debugUrl, tabs: result.debugTabs })}`;
    const cases = [
      [result.mountCreatesTab, "마운트는 preview 탭 하나를 스트립에 세운다"],
      [result.newTabForeground, "새 web 탭은 스트립 끝에 포그라운드로 선다"],
      [result.webTabKind, "newTab 이 만든 탭은 web 이다"],
      [result.cycleBack && result.cycleForward, "cycleActiveTab 이 앞뒤로 옮긴다"],
      [result.closeActivePicksNeighbour, "활성 탭을 닫으면 옆 탭이 뒤를 잇는다"],
      [result.closeInactiveKeepsActive, "뒤편 탭을 닫는 건 활성을 건드리지 않는다"],
      [result.closeBackToFirst, "마지막으로 남은 탭이 활성으로 돌아온다"],
      [result.titleFromPage, "페이지의 제목이 스트립 메타까지 온다"],
      [result.dedupMountReusesTab, "repo origin 중복 금지 — 같은 탭을 activate+refresh 로 데운다"],
      [result.previewToWeb && result.webToPreview, "kind 전환은 양방향이다"],
      [result.evictedOldestOnly, "8개를 넘으면 제일 오래된 parked 탭 하나만 버려진다"],
      [result.resurrectReloadsLastUrl, "버려진 탭은 lastUrl 로 되살아난다"],
      [result.epochMoveReloads, "epoch 이동은 그 탭을 뿌리로 다시 시작시킨다"],
      [result.windowOpenBecomesTab, "window.open 은 새 탭이 된다"],
      [result.denyNonHttpKeepsTabs, "비-http(s) 팝업은 탭을 만들지 않는다"],
      [result.osFallbackTaken, "비-http(s) 팝업은 OS 폴백으로 넘어간다"],
      [result.lastCloseUnmounts, "마지막 탭을 닫으면 pane 이 접힌다"],
    ];
    for (const [ok, label] of cases) assert.ok(ok, `${label}${suffix}`);
    assert.equal(result.error, undefined, `entry 오류 없음${suffix}`);
  } finally {
    serverA.close();
    serverB.close();
  }
});
