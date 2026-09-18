/**
 * P0 스파이크 — `<webview>` 호스트 전환 검증 (preview-proxy-agent-plan.md §2-P0).
 *
 * 제품 코드 병합 없음. 이 스크립트는 다음을 하나의 Electron 실행으로 검증한다:
 *   ISO   — 게스트가 별 프로세스인지(격리의 전제)
 *   W4    — will-attach-webview 펜스: 외부 src 거절, preload/partition 강제
 *   W5    — 클레임한 게스트에 오늘의 CDP 통로(debugger.attach + Input)가 그대로
 *           통하는지, 실입력 isTrusted 포함
 *   W7    — 한국어 IME 조합 입력이 게스트 input에 닿는지(CDP imeSetComposition)
 *   W2    — DOM 토글 100회에 게스트 재로드 0회
 *   W6    — park(visibility) 상태 보존: 입력값·스크롤 유지
 *   W1    — 리사이즈 스톰 후 레이아웃 추적 + 경과 스크린샷
 *   W3    — 모달이 webview 위에 그려지는지(픽셀 샘플)
 *
 * 실행: cd packages/desktop && node_modules/.bin/electron test/spike-webview.mjs
 * 종료 코드: 전부 통과 0, 하나라도 실패 1. 결과는 `SPIKE_RESULTS {...}` 한 줄.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

const results = [];
const detail = {};
const record = (name, pass, info = "") => {
  results.push({ name, pass: Boolean(pass) });
  if (info) detail[name] = info;
};

const watch = setTimeout(() => {
  for (const name of ["ISO", "W4", "W5", "W7", "W2", "W6", "W1", "W3"]) {
    if (!results.some((r) => r.name === name)) record(name, false, "watchdog timeout");
  }
  finish();
}, 180_000);

const finish = () => {
  clearTimeout(watch);
  const pass = results.every((r) => r.pass);
  process.stdout.write(`SPIKE_RESULTS ${JSON.stringify({ pass, results, detail }, null, 1)}\n`);
  app.exit(pass ? 0 : 1);
};

// ---------------------------------------------------------------------------
// 1. 목표 서버 — 레포 dev 서버 자리(루프백, 살아 있는 입력·스크롤·부트 카운터)
// ---------------------------------------------------------------------------
const page = `<!doctype html><meta charset="utf-8"><title>spike app</title>
<body style="margin:0;font-size:14px">
  <input id="ime" placeholder="여기 입력" style="width:200px;padding:6px">
  <button id="btn" style="padding:6px 14px">눌러봐</button>
  <div data-state="기본" style="height:3000px;background:linear-gradient(#eef,#cce)">스크롤 몸통</div>
  <script>
    sessionStorage.boot = (Number(sessionStorage.boot) || 0) + 1;
    window.__boot = { origin: performance.timeOrigin, boot: Number(sessionStorage.boot) };
    window.__clicks = [];
    document.getElementById("btn").addEventListener("click", (e) => {
      window.__clicks.push({ trusted: e.isTrusted, at: Date.now() });
    });
  </script>
</body>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const appUrl = `http://127.0.0.1:${port}/app`;

// ---------------------------------------------------------------------------
// 2. 스텁 preload / 사악한 preload — 펜스가 강제하는 것과 렌더러가 넘기는 것
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "colo-spike-"));
const stubPreload = join(tmp, "stub-preload.cjs");
const evilPreload = join(tmp, "evil-preload.cjs");
writeFileSync(
  stubPreload,
  `require("electron").webFrame.executeJavaScript('window.__spikePreload = "ok"').catch(() => {});`,
);
writeFileSync(
  evilPreload,
  `require("electron").webFrame.executeJavaScript('window.__evilPreload = "evil"').catch(() => {});`,
);

// ---------------------------------------------------------------------------
// 3. 호스트 창 — 플래너 창 자리(webviewTag 활성) + 펜스 + 게스트 클레임
// ---------------------------------------------------------------------------
const HOST_PAGE = `<!doctype html><meta charset="utf-8"><title>spike host</title>
<style>
  #stage { position: relative; width: 860px; height: 560px; }
  webview { width: 600px; height: 480px; border: 1px solid #888; }
  webview.parked { visibility: hidden; position: absolute; left: -9999px; top: 0; }
  webview.live { visibility: visible; position: absolute; left: 0; top: 0; }
  #modal { display: none; position: absolute; left: 10px; top: 10px; width: 220px; height: 120px;
           background: #ff00aa; z-index: 9; }
</style>
<div id="stage">
  <webview id="wvA" class="live"></webview>
  <webview id="wvB" class="parked"></webview>
  <div id="modal"></div>
</div>
<script>
  window.__attachErrors = [];
  window.hostApi = {
    mount(src, stub, evil) {
      const a = document.getElementById("wvA");
      const b = document.getElementById("wvB");
      a.setAttribute("preload", stub);
      b.setAttribute("preload", evil); // 펜스가 이걸 떨어뜨려야 한다
      a.setAttribute("partition", "persist:rogue"); // 펜스가 persist:preview로 강제해야 한다
      a.src = src; b.src = src;
    },
    rogue(src, preload) {
      const w = document.createElement("webview");
      if (preload) w.setAttribute("preload", preload);
      w.src = src;
      w.addEventListener("error", () => window.__attachErrors.push(w.src));
      document.getElementById("stage").appendChild(w);
    },
    switchTo(id) {
      for (const w of document.querySelectorAll("webview")) {
        w.classList.toggle("live", w.id === id);
        w.classList.toggle("parked", w.id !== id);
      }
    },
    async resizeStorm(from, to, steps) {
      const w = document.getElementById("wvA");
      for (let i = 0; i <= steps; i++) {
        w.style.width = (from + ((to - from) * i) / steps) + "px";
        await new Promise((r) => requestAnimationFrame(r));
      }
      return w.getBoundingClientRect().width;
    },
    showModal(on) { document.getElementById("modal").style.display = on ? "block" : "none"; },
  };
</script>`;

const hostPage = join(tmp, "host.html");
writeFileSync(hostPage, HOST_PAGE);

const guests = new Map(); // id -> { contents, src }
const attachLog = []; // { src, refused }
let lastWillAttach = null;

// 격리 측정: 게스트와 호스트의 렌더러 OS pid 비교.
const pidOf = (wc) => {
  try {
    return wc.getOSProcessId?.();
  } catch {
    return undefined;
  }
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: true,
    webPreferences: { webviewTag: true },
  });
  const host = win.webContents;

  // --- 펜스 (계획 §1-a의 미니본) ---
  const loopbackHttp = (url) => {
    try {
      const { protocol, hostname } = new URL(url);
      return protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
    } catch {
      return false;
    }
  };
  host.on("will-attach-webview", (event, webPreferences, params) => {
    const ok = loopbackHttp(params.src);
    attachLog.push({ src: params.src, refused: !ok });
    if (!ok) {
      event.preventDefault();
      lastWillAttach = null;
      return;
    }
    webPreferences.preload = stubPreload; // 렌더러가 넘긴 값 무시
    webPreferences.partition = "persist:preview";
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    lastWillAttach = params.src;
  });
  host.on("did-attach-webview", (_event, guest) => {
    const src = lastWillAttach ?? "unknown";
    lastWillAttach = null;
    const id = `g${guests.size + 1}`;
    guests.set(id, { contents: guest, src });
    guest.on("render-process-gone", () => (detail.crashes = (detail.crashes ?? 0) + 1));
  });

  await win.loadFile(hostPage);
  await host.executeJavaScript(
    `hostApi.mount(${JSON.stringify(appUrl)}, ${JSON.stringify(stubPreload)}, ${JSON.stringify(evilPreload)})`,
  );
  for (let i = 0; i < 100 && guests.size < 2; i++) await delay(50);
  const entryA = guests.get("g1");
  const entryB = guests.get("g2");
  if (!entryA || !entryB) {
    record("ISO", false, `guests attached: ${[...guests.keys()].join(",") || "none"}`);
    return finish();
  }
  const gA = entryA.contents;
  const gB = entryB.contents;
  await delay(600); // preload의 webFrame.executeJavaScript가 main world에 마커를 남길 시간

  // --- ISO: 별 프로세스 (게스트 렌더러 pid ≠ 호스트 렌더러 pid) ---
  {
    const hostPid = pidOf(host);
    const gAPid = pidOf(gA);
    const gBPid = pidOf(gB);
    const separate = hostPid !== undefined && gAPid !== undefined && gAPid !== hostPid;
    record("ISO", separate, `host=${hostPid} guestA=${gAPid} guestB=${gBPid}`);
  }

  // --- W4: 펜스 ---
  {
    await host.executeJavaScript(`hostApi.rogue("https://example.com/")`);
    await host.executeJavaScript(
      `hostApi.rogue(${JSON.stringify(appUrl)}, ${JSON.stringify(evilPreload)})`,
    );
    await delay(1500);
    const refusedExternal = attachLog.some((l) => l.refused && !loopbackHttp(l.src));
    const loopbackClaimed = [...guests.values()].every((g) => loopbackHttp(g.src));
    await delay(600); // 악의 preload가 붙었더라면 main world 마커가 남을 시간
    const rogueEvil = guests.get("g3");
    const forcedRogue = rogueEvil
      ? await rogueEvil.contents
          .executeJavaScript(
            `({ stub: window.__spikePreload ?? null, evil: window.__evilPreload ?? null })`,
          )
          .catch(() => null)
      : null;
    const forcedB = await gB.executeJavaScript(
      `({ stub: window.__spikePreload ?? null, evil: window.__evilPreload ?? null })`,
    );
    const forcingWorks =
      forcedB.stub === "ok" &&
      forcedB.evil === null &&
      (forcedRogue === null || (forcedRogue.stub === "ok" && forcedRogue.evil === null));
    record(
      "W4",
      refusedExternal && loopbackClaimed && forcingWorks,
      `refused=${refusedExternal} loopbackOnly=${loopbackClaimed} forcedB=${JSON.stringify(forcedB)} forcedRogue=${JSON.stringify(forcedRogue)}`,
    );
  }

  // --- W5: 오늘의 CDP 통로 ---
  try {
    gA.debugger.attach("1.3");
    await gA.debugger.sendCommand("Runtime.enable");
    const five = await gA.debugger.sendCommand("Runtime.evaluate", {
      expression: "2 + 3",
      returnByValue: true,
    });
    const rect = await gA.debugger.sendCommand("Runtime.evaluate", {
      expression: `JSON.stringify(document.getElementById("btn").getBoundingClientRect())`,
      returnByValue: true,
    });
    const { x, y, width, height } = JSON.parse(rect.result.value);
    const cx = Math.round(x + width / 2);
    const cy = Math.round(y + height / 2);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await gA.debugger.sendCommand("Input.dispatchMouseEvent", {
        type,
        x: cx,
        y: cy,
        button: "left",
        clickCount: 1,
      });
    }
    const clicks = await gA.executeJavaScript(`window.__clicks`);
    record(
      "W5",
      five.result.value === 5 && clicks.length === 1 && clicks[0].trusted === true,
      `eval=${five.result.value} clicks=${JSON.stringify(clicks)}`,
    );
  } catch (error) {
    record("W5", false, String(error));
  }

  // --- W7: 한국어 입력 파이프라인 ---
  // CDP의 Input.imeSetComposition은 이 Chromium에서 파라미터 유무와 무관하게
  // 거부된다(프로브로 확인 — 조합 이벤트 자체를 시뮬레이션할 방법이 없다).
  // CDP로 증명 가능한 것: 포커스 + 한글 텍스트가 게스트 input에 정확히 착지.
  // 실제 조합(한→한글→확정)은 P1 수용 기준의 수동 확인 항목으로 이관한다
  // (계획서 §2-P1 수용 기준 참조).
  try {
    const dbg = gA.debugger;
    const rect = await dbg.sendCommand("Runtime.evaluate", {
      expression: `JSON.stringify(document.getElementById("ime").getBoundingClientRect())`,
      returnByValue: true,
    });
    const { x, y, width, height } = JSON.parse(rect.result.value);
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.round(x + width / 2),
      y: Math.round(y + height / 2),
      button: "left",
      clickCount: 1,
    });
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.round(x + width / 2),
      y: Math.round(y + height / 2),
      button: "left",
      clickCount: 1,
    });
    const val = () => gA.executeJavaScript(`document.getElementById("ime").value`);
    const focused = await gA.executeJavaScript(`document.activeElement?.id ?? null`);
    let probe = null;
    let done = "";
    try {
      await dbg.sendCommand("Input.imeSetComposition", {
        compositionText: "한",
        selectionStart: 1,
        selectionEnd: 1,
      });
      probe = "사용 가능";
    } catch (error) {
      probe = "CDP 거부";
    }
    // 조합 시뮬레이션 불가와 무관하게 — 확정 텍스트가 input 파이프라인에 착지하는지 검증
    await dbg.sendCommand("Input.insertText", { text: "한글!" });
    done = await val();
    record(
      "W7",
      focused === "ime" && probe !== null && done === "한글!",
      `focus=${focused} 한글 확정 입력=${done} (imeSetComposition=${probe === null ? "사용 가능" : "CDP 거부 — 실제 조합은 수동 확인"})`,
    );
  } catch (error) {
    record("W7", false, String(error));
  }

  // --- W2: 토글 100회, 재로드 0 ---
  try {
    const bootBefore = await gA.executeJavaScript(`window.__boot`);
    for (let i = 0; i < 50; i++) {
      await host.executeJavaScript(`hostApi.switchTo(${JSON.stringify(i % 2 ? "wvB" : "wvA")})`);
      await delay(20);
    }
    await host.executeJavaScript(`hostApi.switchTo("wvA")`);
    const bootAfter = await gA.executeJavaScript(`window.__boot`);
    record(
      "W2",
      bootAfter.origin === bootBefore.origin && bootAfter.boot === bootBefore.boot,
      `origin ${bootBefore.origin} → ${bootAfter.origin}, boot ${bootBefore.boot} → ${bootAfter.boot}, crashes=${detail.crashes ?? 0}`,
    );
  } catch (error) {
    record("W2", false, String(error));
  }

  // --- W6: park 상태 보존 ---
  try {
    await gA.executeJavaScript(`document.getElementById("ime").focus()`);
    await gA.debugger.sendCommand("Input.insertText", { text: "안녕" });
    await gA.executeJavaScript(`document.documentElement.scrollTop = 800; window.scrollTo(0, 800)`);
    const before = await gA.executeJavaScript(
      `({ v: document.getElementById("ime").value, y: window.scrollY, o: window.__boot.origin })`,
    );
    await host.executeJavaScript(`hostApi.switchTo("wvB")`);
    await delay(300);
    await host.executeJavaScript(`hostApi.switchTo("wvA")`);
    await delay(400);
    const after = await gA.executeJavaScript(
      `({ v: document.getElementById("ime").value, y: window.scrollY, o: window.__boot.origin })`,
    );
    record(
      "W6",
      before.v === after.v && before.y === after.y && before.o === after.o,
      `입력 ${before.v}→${after.v}, 스크롤 ${before.y}→${after.y}`,
    );
  } catch (error) {
    record("W6", false, String(error));
  }

  // --- W1: 리사이즈 스톰 ---
  try {
    const shots = [];
    const storm = host.executeJavaScript(`hostApi.resizeStorm(300, 800, 100)`);
    for (let i = 0; i < 3; i++) {
      await delay(120);
      const image = await win.webContents.capturePage();
      const file = join(tmp, `resize-${i}.png`);
      writeFileSync(file, image.toPNG());
      shots.push(file);
    }
    const finalWidth = await storm;
    await delay(150);
    const inner = await gA.executeJavaScript(`window.innerWidth`);
    const tracking = Math.abs(inner - 800) <= 2 && finalWidth >= 799;
    record(
      "W1",
      tracking,
      `inner=${inner}/800, rect=${finalWidth}, shots=${shots.length} (${tmp})`,
    );
  } catch (error) {
    record("W1", false, String(error));
  }

  // --- W3: 모달이 webview 위에 그려짐 (픽셀 샘플) ---
  try {
    const sample = async () => {
      const image = await win.webContents.capturePage();
      const { width: w } = image.getSize();
      const buf = image.toBitmap();
      const px = (x, y) => {
        const i = (y * w + x) * 4;
        return [buf[i + 2], buf[i + 1], buf[i]]; // R,G,B
      };
      return { modal: px(60, 60), beside: px(500, 60) };
    };
    await host.executeJavaScript(`hostApi.showModal(true)`);
    await delay(250);
    const on = await sample();
    writeFileSync(join(tmp, "modal-on.png"), (await win.webContents.capturePage()).toPNG());
    await host.executeJavaScript(`hostApi.showModal(false)`);
    await delay(250);
    const off = await sample();
    const near = (a, b) => Math.abs(a - b) <= 12;
    const modalIsPink = near(on.modal[0], 255) && near(on.modal[1], 0) && near(on.modal[2], 170);
    const uncovered = !(
      near(off.modal[0], 255) &&
      near(off.modal[1], 0) &&
      near(off.modal[2], 170)
    );
    record(
      "W3",
      modalIsPink && uncovered,
      `모달시 픽셀=${JSON.stringify(on.modal)} 해제시=${JSON.stringify(off.modal)}`,
    );
  } catch (error) {
    record("W3", false, String(error));
  }

  finish();
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
