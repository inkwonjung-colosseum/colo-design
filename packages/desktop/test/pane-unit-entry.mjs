/**
 * 페이지 모델 유닛 엔트리 — desktop.test.mjs 의 runDriverUnit 패턴을 따른다:
 * 진짜 Electron 위에서 dist/preview-view.js 의 PlannerPreviewView 를 몇
 * 시나리오 몰고, 한 줄 JSON 으로 답한다. 케이스는 mount 가 페이지를 세우는
 * 것, 링크의 제자리 로밍과 history 의 귀환, 프로젝트 전환의 park·복귀,
 * loose 페이지의 생애와 repo origin 입양, window.open 의 OS 폴백,
 * epoch 이동의 재로드, parked cap 의 evict.
 *
 * COLO_PANE_UNIT_VIEW — dist/preview-view.js 의 file URL.
 * COLO_PANE_UNIT_A / COLO_PANE_UNIT_B — 로컬 서버 둘의 base url. A 는 repo
 * 진영(마운트되는 쪽), B 는 링크가 나는 웹 진영이다. 둘 다 127.0.0.1 이지만
 * 포트가 origin 이므로 레지스트리는 mount 된 것만 repo 로 안다.
 */
import http from "node:http";
import { app, BrowserWindow, shell } from "electron";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 조건이 참이 되거나 때가 되거나 — 유닛의 기다림은 늘 이 하나다. */
async function waitFor(predicate, timeout = 20_000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - started > timeout) return false;
    await sleep(100);
  }
}

/** /hits 조회 — 서버 A 가 지금까지 받은 요청 수(epoch 재로드의 증거). */
const getHits = (base) =>
  new Promise((resolve, reject) => {
    http
      .get(`${base}/hits`, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += String(chunk)));
        response.on("end", () => resolve(Number(body)));
      })
      .on("error", reject);
  });

app.whenReady().then(async () => {
  const answer = (payload) => {
    process.stdout.write(`COLO_PANE_UNIT ${JSON.stringify(payload)}\n`);
    app.exit(0);
  };
  // shell.openExternal 을 엿본다 — 팝업이 진짜 OS 앱을 띄우지 않고도 폴백으로
  // 넘어갔음을 확인하려고. (desktop-comments.mjs 의 선례 그대로.)
  const openedExternally = [];
  try {
    shell.openExternal = (url) => {
      openedExternally.push(String(url));
      return Promise.resolve();
    };
  } catch {
    // patch 실패는 osFallbackTaken false 로 답한다 — 흐름은 계속된다.
  }
  const out = {};
  try {
    const win = new BrowserWindow({ show: false, width: 1280, height: 800 });
    const { PlannerPreviewView } = await import(process.env.COLO_PANE_UNIT_VIEW);
    const view = new PlannerPreviewView(() => win);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    const baseA = process.env.COLO_PANE_UNIT_A;
    const baseB = process.env.COLO_PANE_UNIT_B;
    const originA = new URL(baseA).origin;
    const originB = new URL(baseB).origin;
    const urlOf = () => view.webContents()?.getURL() ?? "";

    // ── mount 가 페이지를 세운다 ─────────────────────────────────────
    view.mount(`${baseA}/repo`, null, []);
    out.mountCreatesPage = view.page !== null && view.page.kind === "preview";
    const pageA = view.page;
    await waitFor(() => urlOf().startsWith(`${baseA}/repo`));

    // ── 링크는 같은 페이지를 제자리에서 옮긴다(로밍) ──────────────────
    view.openTab(`${baseB}/one`);
    out.openTabRoamsSamePage =
      view.page === pageA && (await waitFor(() => urlOf().startsWith(`${baseB}/one`)));
    out.roamedKindWeb = await waitFor(() => view.page?.kind === "web");
    out.roamedOrigin = view.getOrigin() === originB;

    // ── history 가 돌아오는 길이다 ───────────────────────────────────
    view.history(-1);
    out.backReturnsHome =
      (await waitFor(() => urlOf().startsWith(`${baseA}/repo`))) &&
      (await waitFor(() => view.page?.kind === "preview"));

    // ── 로밍 뒤 mount 는 그 자리를 지킨다 ────────────────────────────
    view.openTab(`${baseB}/two`);
    await waitFor(() => urlOf().startsWith(`${baseB}/two`));
    view.mount(`${baseA}/repo`, null, []);
    out.mountKeepsRoamedSpot = view.page === pageA && urlOf().startsWith(`${baseB}/two`);
    view.history(-1);
    await waitFor(() => urlOf().startsWith(`${baseA}/repo`));

    // ── repo origin 으로의 링크는 mount 경로로 간다 ──────────────────
    view.openTab(`${baseA}/other`);
    out.repoLinkMounts =
      view.page === pageA && (await waitFor(() => urlOf().startsWith(`${baseA}/other`)));

    // ── unmount 는 프로젝트 페이지를 park 한다 ───────────────────────
    view.unmount();
    out.unmountParks = view.page === null && !pageA.view.webContents.isDestroyed();
    view.mount(`${baseA}/repo`, null, []);
    out.remountSamePage = view.page === pageA;

    // ── loose 페이지: 프로젝트 없이 열리고 unmount 에 버려진다 ───────
    // (B 는 아직 mounts 에 없다 — 이 시점의 B 링크만 loose 길을 탄다.)
    view.unmount();
    view.openTab(`${baseB}/loose`);
    const loose = view.page;
    out.loosePageOpens =
      loose !== null &&
      loose !== pageA &&
      loose.home === null &&
      (await waitFor(() => urlOf().startsWith(`${baseB}/loose`)));
    view.unmount();
    // 파기된 페이지의 webContents 는 destroyed 가 아니라 아예 없어질 수 있다 —
    // 둘 다 "버려졌다"로 센다.
    out.looseDiscarded =
      (await waitFor(() => (loose.view.webContents?.isDestroyed() ?? true) === true)) &&
      view.page === null;

    // ── 프로젝트 전환: park 와 복귀 ──────────────────────────────────
    // B 도 repo 진영으로 올린다 — origins 인자가 허용 목록을 갈아 끼운다.
    view.mount(`${baseB}/proj`, null, [originA, originB]);
    const pageB = view.page;
    out.switchCreatesSecondPage = pageB !== null && pageB !== pageA;
    await waitFor(() => urlOf().startsWith(`${baseB}/proj`));
    view.mount(`${baseA}/repo`, null, [originA, originB]);
    out.returnKeepsPage =
      view.page === pageA && (await waitFor(() => urlOf().startsWith(`${baseA}/other`)));
    out.parkedAlive = !pageB.view.webContents.isDestroyed();

    // ── window.open → OS 브라우저 (pane 은 제자리) ───────────────────
    await view
      .webContents()
      ?.executeJavaScript(`window.open(${JSON.stringify(`${baseB}/popped`)}, "_blank")`);
    await sleep(300);
    out.windowOpenToOs = openedExternally.includes(`${baseB}/popped`);
    out.paneStaysPut = urlOf().startsWith(`${baseA}/other`);
    await view.webContents()?.executeJavaScript(`window.open("mailto:unit@example.com")`);
    await sleep(300);
    out.osFallbackTaken = openedExternally.includes("mailto:unit@example.com");

    // ── epoch 이동은 뿌리로 다시 시작한다 ────────────────────────────
    const hitsBefore = await getHits(baseA);
    view.mount(`${baseA}/repo`, 7, [originA, originB]);
    view.mount(`${baseA}/repo`, 8, [originA, originB]);
    out.epochMoveReloads = await waitFor(async () => (await getHits(baseA)) > hitsBefore);

    // ── parked cap: 8을 넘으면 제일 오래된 parked 페이지가 파기된다 ──
    // 닫힌 고포트들로 페이지를 채운다 — 로드는 거절돼도 페이지는 선다
    // (cap 은 살아 있는 몸통을 센다). 포트마다 origin 이 다르다.
    // A·B 페이지가 제일 오래됐다.
    for (let i = 1; i <= 8; i += 1) {
      view.mount(`http://127.0.0.1:${59990 + i}/f${i}`, null, [originA, originB]);
      await sleep(50);
    }
    const f8 = view.page;
    // 살아 있는 프로젝트 페이지: A·B·f1..f8 = 10 > 8 — 가장 오래된 parked
    // 둘(A, B)이 파기됐어야 한다. 파기는 비동기 — 없어질 때까지 본다.
    out.evictedOldest = await waitFor(
      () =>
        (pageA.view.webContents?.isDestroyed() ?? true) &&
        (pageB.view.webContents?.isDestroyed() ?? true),
    );

    // ── loose 페이지의 repo origin 입양 ──────────────────────────────
    // A 는 mounts 에 남았지만 페이지는 파기됐다 — loose 페이지가 A 에
    // 착지하면 다음 mount 가 그 페이지를 프로젝트 페이지로 입양한다.
    // loose 의 첫 주소는 엔트리가 직접 띄운 서버 — mounts 에 없는 진짜
    // origin 이라 문서가 서고 executeJavaScript 가 돈다.
    const strayServer = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><p>stray</p>");
    });
    await new Promise((resolve) => strayServer.listen(0, "127.0.0.1", resolve));
    const strayBase = `http://127.0.0.1:${strayServer.address().port}`;
    view.unmount();
    view.openTab(`${strayBase}/loose`);
    const stray = view.page;
    out.strayIsLoose = stray !== null && stray.home === null;
    await waitFor(() => urlOf().includes("/loose"));
    await view
      .webContents()
      ?.executeJavaScript(`location.href = ${JSON.stringify(`${baseA}/adopted`)}`);
    await waitFor(() => urlOf().startsWith(`${baseA}/adopted`));
    view.mount(`${baseA}/repo`, null, [originA, originB]);
    out.looseAdopted = view.page === stray && stray.home === originA;
    strayServer.close();

    // ── 살아 있는 페이지는 재마운트가 같은 몸통을 데워 쓴다 ──────────
    view.mount("http://127.0.0.1:59998/f8", null, [originA, originB]);
    out.survivorReused = view.page === f8;

    answer(out);
  } catch (error) {
    answer({
      ...out,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
