/**
 * 탭 모델 유닛 엔트리(인앱 브라우저 1단계) — desktop.test.mjs 의 runDriverUnit
 * 패턴을 따른다: 진짜 Electron 위에서 dist/preview-view.js 의
 * PlannerPreviewView 를 몇 시나리오 몰고, 한 줄 JSON 으로 답한다. 케이스는
 * 계획 §4-1: 생성/전환/닫기, 8개 초과 evict 후 재로드, window.open → 새 탭,
 * kind 전환 양방향, repo origin 중복 금지.
 *
 * COLO_TABS_UNIT_VIEW — dist/preview-view.js 의 file URL.
 * COLO_TABS_UNIT_A / COLO_TABS_UNIT_B — 탭을 나눠 관찰할 로컬 서버 둘의 base
 * url. A 는 repo 진영(마운트되는 쪽), B 는 링크가 나는 웹 진영이다. 둘 다
 * 127.0.0.1 이지만 포트가 origin 이므로 레지스트리는 A 만 repo 로 안다.
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
    process.stdout.write(`COLO_TABS_UNIT ${JSON.stringify(payload)}\n`);
    app.exit(0);
  };
  // shell.openExternal 을 엿본다 — 비-http(s) 팝업이 진짜 OS 앱을 띄우지 않고도
  // 폴백으로 넘어갔음을 확인하려고. (desktop-comments.mjs 의 선례 그대로.)
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
    const { PlannerPreviewView } = await import(process.env.COLO_TABS_UNIT_VIEW);
    const view = new PlannerPreviewView(() => win);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    const baseA = process.env.COLO_TABS_UNIT_A;
    const baseB = process.env.COLO_TABS_UNIT_B;

    // ── 생성/전환/닫기 ────────────────────────────────────────────────
    view.mount(`${baseA}/repo`, null, []);
    out.mountCreatesTab = view.listTabs().length === 1 && view.listTabs()[0].kind === "preview";
    const t1 = view.listTabs()[0];
    view.newTab(`${baseB}/one`);
    view.newTab(`${baseB}/two`);
    out.newTabForeground =
      view.listTabs().length === 3 && view.getActiveTabId() === view.listTabs()[2].id;
    out.webTabKind = view.listTabs()[2].kind === "web";
    view.cycleActiveTab(-1);
    out.cycleBack = view.getActiveTabId() === view.listTabs()[1].id;
    view.cycleActiveTab(1);
    out.cycleForward = view.getActiveTabId() === view.listTabs()[2].id;
    // 활성(t3)을 닫으면 옆 탭 — 오른쪽이 없으니 왼쪽 t2 가 뒤를 잇는다.
    view.closeTab();
    out.closeActivePicksNeighbour =
      view.listTabs().length === 2 && view.getActiveTabId() === view.listTabs()[1].id;
    // 임시 탭을 하나 더 세워 뒤편 탭 닫기를 본다 — 활성은 그대로다.
    view.newTab(`${baseB}/x`);
    const t4 = view.listTabs()[2];
    view.closeTab(view.listTabs()[1].id);
    out.closeInactiveKeepsActive = view.listTabs().length === 2 && view.getActiveTabId() === t4.id;
    // 활성 t4 를 닫으면 남은 t1 이 활성된다 — 이후 케이스의 출발점.
    view.closeTab();
    out.closeBackToFirst = view.listTabs().length === 1 && view.getActiveTabId() === t1.id;
    // 페이지가 말한 제목이 스트립 메타까지 온다.
    out.titleFromPage = await waitFor(() => view.listTabs()[0]?.title === "리포 A");

    // ── repo origin 중복 금지(규칙 4) ─────────────────────────────────
    view.mount(`${baseA}/other`, 7, []);
    out.dedupMountReusesTab =
      view.listTabs().length === 1 &&
      view.getActiveTabId() === t1.id &&
      (view.webContents()?.getURL() ?? "").startsWith(`${baseA}/repo`);

    // ── kind 전환 양방향(규칙 5) ──────────────────────────────────────
    await view
      .webContents()
      ?.executeJavaScript(`location.href = ${JSON.stringify(`${baseB}/roamed`)}`);
    out.previewToWeb = await waitFor(() => view.listTabs()[0]?.kind === "web");
    if (!out.previewToWeb) {
      out.debugUrl = view.webContents()?.getURL() ?? null;
      out.debugTabs = view.listTabs();
    }
    await view
      .webContents()
      ?.executeJavaScript(`location.href = ${JSON.stringify(`${baseA}/repo`)}`);
    out.webToPreview = await waitFor(() => view.listTabs()[0]?.kind === "preview");

    // ── 8개 초과 evict 후 재로드 ──────────────────────────────────────
    for (let i = 1; i <= 8; i++) view.newTab(`${baseB}/e${i}`);
    out.evictedOldestOnly = await waitFor(() => {
      const tabs = view.listTabs();
      return (
        tabs.length === 9 &&
        tabs.filter((tab) => tab.discarded).length === 1 &&
        tabs[0].discarded === true &&
        tabs[0].id === t1.id
      );
    });
    view.activateTab(t1.id);
    out.resurrectReloadsLastUrl = await waitFor(async () => {
      const url = view.webContents()?.getURL() ?? "";
      return url.startsWith(`${baseA}/repo`) && view.listTabs()[0].discarded === false;
    });
    // epoch 이동은 그 탭만 뿌리로 다시 시작시킨다(규칙 3·5) — 같은 탭, 재로드.
    const hitsBefore = await getHits(baseA);
    view.mount(`${baseA}/repo`, 8, []);
    out.epochMoveReloads = await waitFor(async () => (await getHits(baseA)) > hitsBefore);

    // ── window.open → 새 탭(포그라운드) ───────────────────────────────
    await view
      .webContents()
      ?.executeJavaScript(`window.open(${JSON.stringify(`${baseB}/popped`)}, "_blank")`);
    out.windowOpenBecomesTab = await waitFor(() => {
      const tabs = view.listTabs();
      const active = tabs.find((tab) => tab.id === view.getActiveTabId());
      return (
        tabs.length === 10 &&
        active?.kind === "web" &&
        (view.webContents()?.getURL() ?? "").startsWith(`${baseB}/popped`)
      );
    });

    // ── 비-http(s) 팝업: deny + OS 폴백 ───────────────────────────────
    await view.webContents()?.executeJavaScript(`window.open("mailto:unit@example.com")`);
    await sleep(300);
    out.denyNonHttpKeepsTabs = view.listTabs().length === 10;
    out.osFallbackTaken = openedExternally.includes("mailto:unit@example.com");

    // ── 마지막 탭 닫기 → pane unmount ─────────────────────────────────
    while (view.listTabs().length > 1) view.closeTab();
    view.closeTab();
    out.lastCloseUnmounts =
      view.listTabs().length === 0 && view.getActiveTabId() === null && view.webContents() === null;

    answer(out);
  } catch (error) {
    answer({
      ...out,
      error: error && error.message ? error.message : String(error),
    });
  }
});
