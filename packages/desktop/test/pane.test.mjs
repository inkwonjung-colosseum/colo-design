/**
 * 인앱 브라우저 — 페이지 모델 유닛.
 * desktop.test.mjs 의 runDriverUnit 패턴: 진짜 Electron 을 띄워
 * pane-unit-entry.mjs 가 dist/preview-view.js 의 PlannerPreviewView 를 몰고
 * 시나리오를 돌리게 하고, 한 줄 JSON 답을 케이스별로 단언한다. 오프라인 —
 * 서버 둘은 로컬 fixture 다(A 는 repo 진영, B 는 웹 진영).
 *
 * Run: node --test packages/desktop/test/pane.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const electronBinary = join(here, "..", "node_modules", ".bin", "electron");

/** 페이지가 서는 곳 — 제목은 본문에도 그대로 적는다. */
const docPage = (title) =>
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
    response.end(docPage(path === "/repo" ? "리포 A" : "리포 A 문서"));
  });
  return server;
}

/** 서버 B — 웹 진영. 무슨 경로든 같은 페이지, 처음엔 마운트되지 않는 origin 이다. */
function startServerB() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(docPage("웹 B"));
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

async function runPaneUnit(urlA, urlB) {
  const child = spawn(electronBinary, [join(here, "pane-unit-entry.mjs")], {
    env: {
      ...process.env,
      COLO_DESIGN_DESKTOP_UNIT: "1",
      COLO_PANE_UNIT_VIEW: pathToFileURL(join(here, "..", "dist", "preview-view.js")).href,
      COLO_PANE_UNIT_A: urlA,
      COLO_PANE_UNIT_B: urlB,
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
      reject(new Error(`pane model unit timed out — output: ${output.slice(-2000)}`));
    }, 90_000);
    child.on("exit", () => {
      clearTimeout(timer);
      const found = output.split("\n").find((candidate) => candidate.startsWith("COLO_PANE_UNIT "));
      if (found) resolve(JSON.parse(found.slice("COLO_PANE_UNIT ".length)));
      else reject(new Error(`pane model unit produced no answer — output: ${output.slice(-2000)}`));
    });
  });
  return line;
}

test("미리보기 페이지 모델: mount·로밍·history, park·복귀, loose 생애, window.open, epoch, evict", async () => {
  const serverA = startServerA();
  const serverB = startServerB();
  try {
    const [urlA, urlB] = await Promise.all([listen(serverA), listen(serverB)]);
    const result = await runPaneUnit(urlA, urlB);
    const suffix = result.error ? ` — entry: ${result.error}` : "";
    const cases = [
      [result.mountCreatesPage, "마운트는 preview 페이지 하나를 화면에 세운다"],
      [result.openTabRoamsSamePage, "외부 링크는 같은 페이지를 제자리에서 옮긴다"],
      [
        result.roamedKindWeb && result.roamedOrigin,
        "로밍한 페이지는 kind=web·origin 은 링크의 것이다",
      ],
      [result.backReturnsHome, "뒤로 가기는 프로젝트로 돌아오는 길이다(kind 도 preview 로)"],
      [result.mountKeepsRoamedSpot, "로밍 뒤 mount 는 페이지를 뿌리로 끌지 않는다"],
      [result.repoLinkMounts, "repo origin 으로의 링크는 mount 경로로 간다"],
      [result.unmountParks, "unmount 는 프로젝트 페이지를 살려 둔 채 내린다"],
      [result.remountSamePage, "재마운트는 데워 둔 같은 페이지를 세운다"],
      [result.loosePageOpens, "프로젝트 없이 열린 링크는 loose 페이지를 세운다"],
      [result.looseDiscarded, "loose 페이지는 unmount 에 파기된다"],
      [result.switchCreatesSecondPage, "프로젝트 전환은 그 프로젝트의 페이지를 세운다"],
      [result.returnKeepsPage, "돌아오면 있던 곳 그대로의 같은 페이지다"],
      [result.parkedAlive, "park 된 페이지의 WebContents 는 살아 있다"],
      [result.windowOpenToOs, "window.open 은 OS 브라우저로 간다"],
      [result.paneStaysPut, "팝업이 떠도 pane 은 제자리다"],
      [result.osFallbackTaken, "비-http(s) 팝업도 OS 폴백으로 넘어간다"],
      [result.epochMoveReloads, "epoch 이동은 페이지를 뿌리로 다시 시작시킨다"],
      [result.evictedOldest, "8을 넘으면 제일 오래된 parked 페이지가 파기된다"],
      [result.strayIsLoose, "프로젝트 없이 뜬 페이지는 loose 다"],
      [result.looseAdopted, "repo origin 에 착지한 loose 페이지는 입양된다"],
      [result.survivorReused, "살아 있는 페이지는 재마운트가 같은 몸통을 쓴다"],
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
