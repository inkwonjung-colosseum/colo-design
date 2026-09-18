/**
 * 페이지 모델 유닛 엔트리 — desktop.test.mjs 의 runDriverUnit 패턴을 따른다:
 * 진짜 Electron 위에서 dist/preview-view.js 의 PlannerPreviewView 를 몇
 * 시나리오 몰고, 한 줄 JSON 으로 답한다. 케이스는 mount 가 페이지를 세우는
 * 것, 링크의 제자리 로밍과 history 의 귀환, 프로젝트 전환의 park·복귀,
 * loose 페이지의 생애와 repo origin 입양, window.open 의 OS 폴백,
 * epoch 이동의 재로드.
 *
 * webview 전환(2026-09-18) 뒤의 역할 분담: 요소의 생성·보이기·수명은
 * 렌더러(PreviewFrame)의 몫이고 main은 클레임(did-attach-webview)으로
 * 페이지를 세운다. 이 엔트리는 렌더러의 그 몫을 흉내 낸다 — 호스트 페이지에
 * <webview>를 얹는 add/remove 두 손잡이와 view.attachWindow(펜스·클레임).
 * park 상한(LRU evict)도 렌더러 쪽으로 이관했으므로 여기서 잰 게 아니다.
 *
 * COLO_PANE_UNIT_VIEW — dist/preview-view.js 의 file URL.
 * COLO_PANE_UNIT_A / COLO_PANE_UNIT_B — 로컬 서버 둘의 base url. A 는 repo
 * 진영(마운트되는 쪽), B 는 링크가 나는 웹 진영이다. 둘 다 127.0.0.1 이지만
 * 포트가 origin 이므로 레지스트리는 mount 된 것만 repo 로 안다.
 */

import { writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 유닛 전용 userData — 다른 실행(또는 잔존 인스턴스)의 SingletonLock 과
// 엮이지 않게 한다. ready 전에 정해야 한다.
app.setPath("userData", join(app.getPath("temp"), `colo-pane-unit-userdata-${process.pid}`));

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

const HOST_PAGE = `<!doctype html><meta charset="utf-8"><body>
<script>
  window.__api = {
    add(src, key) {
      const w = document.createElement("webview");
      w.src = src;
      // PreviewFrame과 동일 — 팝업은 main 핸들러가 심판한다.
      w.setAttribute("allowpopups", "");
      w.style.cssText = "width:600px;height:400px";
      w.dataset.key = key;
      document.body.appendChild(w);
      return w.src;
    },
    remove(key) {
      let removed = 0;
      for (const w of [...document.querySelectorAll("webview")]) {
        // src 프로퍼티는 내비게이션을 따라 움직인다 — 생성 때 심은 key 로
        // 식별한다.
        if (w.dataset.key === key) {
          w.remove();
          removed += 1;
        }
      }
      return removed;
    },
  };
</script>`;

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
  const step = (name) => process.stdout.write(`[entry] ${name}\n`);
  try {
    step("window");
    // show:true — 숨은 창에서는 첫 페인트 전까지 게스트 attach가 늦어질 수
    // 있다(실측). 유닛은 짧게 창을 띄우고 끝낸다. webviewTag 는 반드시
    // webPreferences 안으로 — 밖에 두면 조용히 무시된다(실측).
    const win = new BrowserWindow({
      show: true,
      width: 1280,
      height: 800,
      webPreferences: { webviewTag: true },
    });
    const hostPage = join(app.getPath("temp"), `colo-pane-unit-${Date.now()}.html`);
    writeFileSync(hostPage, HOST_PAGE);
    step("loadFile");
    await win.loadFile(hostPage);
    step("import");
    const { PlannerPreviewView } = await import(process.env.COLO_PANE_UNIT_VIEW);
    step("construct");
    const view = new PlannerPreviewView(() => win);
    view.attachWindow(win);
    win.webContents.on("will-attach-webview", (_e, _p, params) =>
      process.stdout.write(`[entry] will-attach ${params.src}\n`),
    );
    win.webContents.on("did-attach-webview", () => process.stdout.write(`[entry] did-attach\n`));
    // PreviewFrame의 몫 — 무대가 살아 있음을 main에 알린다(옛 bounds 0 판정).
    view.setHostReady(true);
    // 렌더러(PreviewFrame)의 몫 — 요소를 얹고 거둔다.
    const addGuest = (src, key) =>
      win.webContents.executeJavaScript(
        `window.__api.add(${JSON.stringify(src)}, ${JSON.stringify(key)})`,
      );
    const removeGuest = (key) =>
      win.webContents.executeJavaScript(`window.__api.remove(${JSON.stringify(key)})`);
    const baseA = process.env.COLO_PANE_UNIT_A;
    const baseB = process.env.COLO_PANE_UNIT_B;
    const originA = new URL(baseA).origin;
    const originB = new URL(baseB).origin;
    const urlOf = () => view.webContents()?.getURL() ?? "";

    // ── mount 가 페이지를 세운다 ─────────────────────────────────────
    // 요소가 먼저(React가 src를 쓰고 mount가 따라 오는 순서) — 클레임이
    // mount보다 빠르면 loose로 태어나고 mount가 입양한다(양쪽 순서 모두
    // 본계약). 여기서는 늦은 mount 길을 검증한다.
    step("addGuest");
    await addGuest(`${baseA}/repo`, "A");
    step("mount");
    view.mount(`${baseA}/repo`, null, []);
    step("waitPage");
    out.mountCreatesPage = await waitFor(() => view.page !== null && view.page.kind === "preview");
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
    out.unmountParks = view.page === null && !pageA.contents.isDestroyed();
    view.mount(`${baseA}/repo`, null, []);
    out.remountSamePage = await waitFor(() => view.page === pageA);

    // ── loose 페이지: 프로젝트 없이 열리고 unmount 에 버려진다 ───────
    // (B 는 아직 mounts 에 없다 — 이 시점의 B 링크만 loose 길을 탄다.)
    view.unmount();
    view.openTab(`${baseB}/loose`);
    await addGuest(`${baseB}/loose`, "loose");
    const loose = view.page;
    out.loosePageOpens =
      loose !== null &&
      loose !== pageA &&
      loose.home === null &&
      (await waitFor(() => urlOf().startsWith(`${baseB}/loose`)));
    view.unmount();
    // main의 닫기 요청(colo-preview:close)을 받은 렌더러는 요소를 거둔다 —
    // 그 흉내. 요소가 철거되면 게스트가 죽고 main이 잊는다.
    await removeGuest("loose");
    out.looseDiscarded = (await waitFor(() => loose.contents.isDestroyed())) && view.page === null;

    // ── 프로젝트 전환: park 와 복귀 ──────────────────────────────────
    // B 도 repo 진영으로 올린다 — origins 인자가 허용 목록을 갈아 끼운다.
    await addGuest(`${baseB}/proj`, "B");
    view.mount(`${baseB}/proj`, null, [originA, originB]);
    // 클레임(did-attach)은 요소 삽입 뒤 비동기다 — 페이지가 설 때까지 본다.
    await waitFor(() => view.page !== null && view.page.kind === "preview");
    const pageB = view.page;
    out.switchCreatesSecondPage =
      pageB !== null && pageB !== pageA && (await waitFor(() => pageB.kind === "preview"));
    await waitFor(() => urlOf().startsWith(`${baseB}/proj`));
    view.mount(`${baseA}/repo`, null, [originA, originB]);
    out.returnKeepsPage =
      view.page === pageA && (await waitFor(() => urlOf().startsWith(`${baseA}/other`)));
    out.parkedAlive = !pageB.contents.isDestroyed();

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

    // ── 요소 철거(렌더러 evict의 몫) — 게스트가 죽고 레지스트리가 비운다 ──
    await removeGuest("A");
    await removeGuest("B");
    out.evictedGuests = await waitFor(
      () => pageA.contents.isDestroyed() && pageB.contents.isDestroyed(),
    );

    // ── loose 페이지의 repo origin 입양 ──────────────────────────────
    // A 는 mounts 에 남았지만 페이지(게스트)는 철거됐다 — loose 페이지가
    // A 에 착지하면 다음 mount 가 그 페이지를 프로젝트 페이지로 입양한다.
    // loose 의 첫 주소는 엔트리가 직접 띄운 서버 — mounts 에 없는 진짜
    // origin 이라 문서가 서고 executeJavaScript 가 돈다.
    const strayServer = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><p>stray</p>");
    });
    await new Promise((resolve) => strayServer.listen(0, "127.0.0.1", resolve));
    const strayBase = `http://127.0.0.1:${strayServer.address().port}`;
    view.unmount();
    step("stray-open");
    view.openTab(`${strayBase}/loose`);
    await addGuest(`${strayBase}/loose`, "stray");
    step("stray-added");
    await waitFor(() => view.page !== null);
    const stray = view.page;
    step("stray-claimed");
    out.strayDebug = {
      page: stray && { home: stray.home, origin: stray.origin, kind: stray.kind },
      pages: [...["1"].flatMap(() => [])],
      wanted: null,
    };
    out.strayIsLoose = stray !== null && stray.home === null;
    await waitFor(() => urlOf().includes("/loose"));
    step("stray-roam");
    await view
      .webContents()
      ?.executeJavaScript(`location.href = ${JSON.stringify(`${baseA}/adopted`)}`);
    await waitFor(() => urlOf().startsWith(`${baseA}/adopted`));
    step("stray-mount");
    view.mount(`${baseA}/repo`, null, [originA, originB]);
    out.looseAdopted = view.page === stray && stray !== null && stray.home === originA;
    strayServer.close();

    // ── 살아 있는 페이지는 재마운트가 같은 몸통을 데워 쓴다 ──────────
    view.mount(`${baseA}/repo`, null, [originA, originB]);
    out.survivorReused = await waitFor(() => view.page === stray);

    answer(out);
  } catch (error) {
    answer({
      ...out,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
