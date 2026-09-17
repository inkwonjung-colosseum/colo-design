/**
 * 인앱 브라우저 — PaneBrowserDriver 유닛.
 * pane-unit-entry.mjs 의 패턴: 진짜 Electron 위에서 dist/preview-view.js 의
 * PlannerPreviewView 와 dist/preview-driver.js 의 createBrowserDriverFactory 를
 * 몰고, 한 줄 JSON 으로 답한다. 케이스는 snapshot ref 세대
 * (스냅샷→click→새 스냅샷·이동 뒤 옛 ref 거절), actionability(가려진 버튼
 * 대기 후 클릭), 다이얼로그 자동 처리, evaluate 반환+8KB 캡, waitFor(text),
 * navigate 가 화면의 페이지를 옮기는 것, pane 없으면 null.
 *
 * COLO_BROWSER_UNIT_VIEW — dist/preview-view.js 의 file URL.
 * COLO_BROWSER_UNIT_DRIVER — dist/preview-driver.js 의 file URL.
 * COLO_BROWSER_UNIT_A / COLO_BROWSER_UNIT_B — fixture 서버 둘의 base url.
 *   A 는 상호작용 페이지들, B 는 로밍 목적지용 평범한 페이지다.
 */
import { app, BrowserWindow } from "electron";

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

/** 스냅샷 트리를 납작하게 — 이름으로 노드를 찾는 일이 전부 여기서 한다. */
const flatten = (nodes) => {
  const out = [];
  const walk = (list) => {
    for (const node of list ?? []) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
};
const findByName = (nodes, name) => flatten(nodes).find((node) => node.name === name) ?? null;

app.whenReady().then(async () => {
  // AX 트리는 보조 기술이 붙어야 렌더러가 만든다 — 숨은 창이라도 켜 둔다.
  app.setAccessibilitySupportEnabled(true);
  const answer = (payload) => {
    process.stdout.write(`COLO_BROWSER_UNIT ${JSON.stringify(payload)}\n`);
    app.exit(0);
  };
  const out = {};
  try {
    // 한 번도 표시된 적 없는 창은 프레임을 만들지 않아 rAF 가 죽는다 —
    // actionability 의 프레임 쌍이 영원히 기다리게 되므로 창을 띄운다
    // (구 desktop.test.mjs 의 show:true 선례).
    const win = new BrowserWindow({ show: true, width: 1280, height: 800 });
    const { PlannerPreviewView } = await import(process.env.COLO_BROWSER_UNIT_VIEW);
    const { createBrowserDriverFactory } = await import(process.env.COLO_BROWSER_UNIT_DRIVER);
    const view = new PlannerPreviewView(() => win);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    const baseA = process.env.COLO_BROWSER_UNIT_A;
    const baseB = process.env.COLO_BROWSER_UNIT_B;

    // ── pane 없으면 null (숨은 창 폴백 금지) ─────────────────────────
    out.paneNull = createBrowserDriverFactory(() => null).forPane() === null;
    const factory = createBrowserDriverFactory(() => view);
    // pane 은 있어도 페이지가 하나도 없으면 드라이버는 돌아오지만 페이지가
    // 필요한 명령은 실패한다 — navigate 가 페이지를 세울 수 있어야 하므로.
    out.factoryDriverBeforePage = factory.forPane() !== null;
    try {
      await factory.forPane().snapshot();
      out.noPageSnapshotFails = false;
    } catch {
      out.noPageSnapshotFails = true;
    }

    // 사용자가 링크를 여는 것과 같다 — 드라이버는 페이지가 생긴 뒤에야 손에 잡힌다.
    view.openTab(`${baseA}/one`);
    // 숨은 창의 페이지는 쓰로틀을 풀어 준다 — rAF 가 멈추면 actionability 의
    // 프레임 쌍이 영원히 기다린다.
    const unthrottle = () => view.webContents()?.setBackgroundThrottling(false);
    unthrottle();
    const driver = factory.forPane();
    out.factoryReturnsDriver = driver !== null;
    out.sameInstance = factory.forPane() === driver;

    out.pageOnScreen = view.webContents() !== null;
    await waitFor(() => (view.webContents()?.getURL() ?? "").startsWith(`${baseA}/one`));

    // AX 트리는 렌더러가 늦게 채울 수 있다 — 비어 있으면 다시 본다.
    const snapshotRetry = async () => {
      for (let i = 0; i < 15; i += 1) {
        const tree = await driver.snapshot();
        if (flatten(tree).length > 0) return tree;
        await sleep(200);
      }
      return driver.snapshot();
    };

    // ── snapshot → click → 새 스냅샷 (ref 세대) ──────────────────────
    const s1 = await snapshotRetry();
    const go = findByName(s1, "Go");
    out.snapshotHasRefs = go !== null && /^e\d+$/.test(go.ref);
    const s2 = await driver.click({ ref: go.ref });
    const after = findByName(s2, "After");
    out.clickReturnsFreshSnapshot = after !== null;
    // 새 세대의 ref 는 다시 읽지 않고 곧장 쓸 수 있다 — 세대 갱신 겸용의 증거.
    try {
      await driver.hover({ ref: after.ref });
      out.freshRefUsable = true;
    } catch (error) {
      out.freshRefUsable = false;
      out.hoverError = String(error?.message ?? error);
      // 진단: rAF 가 도는가, 요소 rect 는 안정적인가.
      out.rafAlive = await driver.evaluate(
        "() => new Promise((r) => { const t = setTimeout(() => r('no'), 400); requestAnimationFrame(() => { clearTimeout(t); r('yes'); }); })",
      );
      out.afterRect = await driver.evaluate(
        "() => JSON.stringify(document.querySelector('#later button').getBoundingClientRect())",
      );
    }
    // 이동 뒤 옛 ref 는 거절된다 — 옛 문서의 노드 번호가 새 문서를 가리키지 않게.
    await driver.navigate(`${baseA}/third`);
    unthrottle();
    let staleError = "";
    try {
      await driver.click({ ref: go.ref });
    } catch (error) {
      staleError = String(error?.message ?? error);
    }
    out.staleRefRejected = staleError.includes("다시 읽으십시오");

    // ── type · press · select (이식 액션이 페이지에 실제로 닿는다) ────
    await driver.navigate(`${baseA}/one`);
    unthrottle();
    const s3 = await snapshotRetry();
    const name = findByName(s3, "이름");
    await driver.type({ ref: name.ref, text: "hello", clear: true });
    out.typeWorks =
      (await driver.evaluate("() => document.getElementById('name').value")) === "hello";
    await driver.press("Enter");
    out.pressWorks = (await driver.evaluate("() => document.body.dataset.pressed")) === "1";
    // type·press 가 새 ref 세대를 발급했으므로 s3 의 ref 는 이미 낡았다 —
    // select 는 방금 세대(press 의 반환 스냅샷)에서 다시 찾는다.
    const s3b = await snapshotRetry();
    const pick = findByName(s3b, "고르기");
    out.pickNodes = flatten(s3b)
      .filter((node) => node.name === "고르기")
      .map((node) => `${node.role}:${node.ref}`);
    await driver.select({ ref: pick.ref, value: "b" });
    out.selectWorks =
      (await driver.evaluate("() => document.getElementById('pick').value")) === "b";

    // ── actionability: 가려진 버튼은 덮개가 걷힐 때까지 기다린다 ──────
    await driver.navigate(`${baseA}/covered`);
    unthrottle();
    const s4 = await snapshotRetry();
    const late = findByName(s4, "Late");
    const coveredAt = Date.now();
    out.coveredClickOk = await driver.click({ ref: late.ref }).then(
      () => true,
      (error) => String(error?.message ?? error),
    );
    out.coveredElapsed = Date.now() - coveredAt;

    // ── evaluate 반환 + JSON 8KB 캡 ──────────────────────────────────
    const value = await driver.evaluate("() => ({ a: 1, b: '둘' })");
    out.evaluateValue = value?.a === 1 && value?.b === "둘";
    let capError = "";
    try {
      await driver.evaluate("() => 'x'.repeat(20000)");
    } catch (error) {
      capError = String(error?.message ?? error);
    }
    out.evaluateCapThrows = capError.includes("넘습니다");

    // ── waitFor(text) ────────────────────────────────────────────────
    await driver.navigate(`${baseA}/delayed`);
    unthrottle();
    out.waitForTextTrue = await driver.waitFor({ text: "늦게 왔다", ms: 5000 });
    out.waitForTextFalse = (await driver.waitFor({ text: "없는 글자", ms: 300 })) === false;

    // ── navigate 는 화면의 페이지를 옮긴다 — 다른 origin 도 제자리다 ──
    await driver.navigate(`${baseB}/two`);
    unthrottle();
    out.navigateRoams = (view.webContents()?.getURL() ?? "").startsWith(`${baseB}/two`);
    out.consoleStillWorks = Array.isArray(await driver.consoleLines());
    // 뒤로 가기는 온 길을 되짚는다 — 같은 페이지, 같은 history.
    await driver.back();
    out.backReturns = (view.webContents()?.getURL() ?? "").startsWith(`${baseA}/delayed`);

    // ── screenshot ───────────────────────────────────────────────────
    const shot = await driver.screenshot({ longEdge: 200 });
    out.screenshotWorks = shot.mediaType === "image/webp" && shot.data.length > 0;

    // ── 다이얼로그 자동 처리 (마지막에 둔다 — 처리가 안 되면 페이지가
    //    멈추므로, 이후 케이스가 같이 멈추지 않게) ──────────────────────
    await driver.navigate(`${baseA}/dialog`);
    unthrottle();
    const s5 = await snapshotRetry();
    const alertButton = findByName(s5, "Alert");
    // alert 은 수락 — 처리가 없으면 페이지가 멈춰 클릭이 돌아오지 않는다.
    const alertClick = await Promise.race([
      driver.click({ ref: alertButton.ref }).then(
        () => "ok",
        (error) => String(error?.message ?? error),
      ),
      sleep(10_000).then(() => "timeout"),
    ]);
    out.dialogAlertHandled = alertClick === "ok";
    if (out.dialogAlertHandled) {
      // alert 클릭이 새 세대를 발급했다 — confirm 은 방금 세대에서 다시 찾는다.
      const s5b = await snapshotRetry();
      const confirmNow = findByName(s5b, "Confirm");
      const confirmClick = await Promise.race([
        driver.click({ ref: confirmNow.ref }).then(
          () => "ok",
          (error) => String(error?.message ?? error),
        ),
        sleep(10_000).then(() => "timeout"),
      ]);
      out.dialogConfirmHandled = confirmClick === "ok";
      out.dialogConfirmDismissed =
        (await driver.evaluate("() => document.body.dataset.confirm")) === "false";
      const lines = await driver.consoleLines();
      out.dialogReported =
        lines.some((line) => line.level === "dialog" && line.text.includes("alert")) &&
        lines.some((line) => line.level === "dialog" && line.text.includes("confirm"));
    } else {
      out.dialogConfirmHandled = false;
      out.dialogConfirmDismissed = false;
      out.dialogReported = false;
    }

    // ── waitFor 예산 클램프 ───────────────────────────────────────────
    // 60초를 청해도 실제 예산은 30초로 깎인다 — 영원히 안 오는 글자의
    // false 도달이 30초 안착(클램프)인지 60초 만전(무클램프)인지로 판정한다.
    const clampAt = Date.now();
    out.waitClampResult = await driver.waitFor({ text: "영원히 없는 글자", ms: 60_000 });
    out.waitClampElapsed = Date.now() - clampAt;

    // ── destroy ──────────────────────────────────────────────────────
    await driver.destroy();
    out.destroyOk = true;
  } catch (error) {
    out.error = String(error?.stack ?? error);
  }
  answer(out);
});
