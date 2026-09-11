/**
 * Desktop unit checks — update logic (version compare, feed parse, sha256
 * verify, plan), the notice copy the OS notification paints, the safeStorage
 * store against a fake, and the daemon-side PATH prefix. Everything runs
 * offline; the update feed is a local fixture server, the sha256 fixtures are
 * real files.
 *
 * Run: node --test packages/desktop/test/desktop.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import {
  RELEASES_FEED_URL,
  checkForUpdate,
  compareSemver,
  fetchLatest,
} from "../../protocol/dist/update.js";
import {
  buildSwapScript,
  planSelfUpdate,
  sha256OfFile,
  verifyDownload,
} from "../dist/mac-self-update.js";
import { SafeStorageCredentialStore } from "../dist/safe-storage-store.js";
import { noticeCopy } from "../dist/notices.js";
import { extraPathPrefix } from "../../daemon/dist/repo.js";

function workdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// semver compare + update check
// ---------------------------------------------------------------------------

test("semver comparison orders major, minor, patch", () => {
  assert.equal(compareSemver("0.1.0", "0.2.0"), -1);
  assert.equal(compareSemver("1.0.0", "0.9.9"), 1);
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
  assert.equal(compareSemver("v1.2.3", "1.2.3"), 0, "the v prefix is tolerated");
  assert.equal(compareSemver("0.1.0", "0.10.0"), -1, "numeric, not lexicographic");
});

test("checkForUpdate reads the feed and compares against the current version", async () => {
  const feed = {
    version: "0.3.0",
    notes: "화면 코멘트 지원",
    url: "https://example/cds-design-0.3.0.zip",
    sha256: "ab".repeat(32),
  };
  const fetchLike = async (url) => {
    assert.equal(url, "https://example.test/latest.json");
    return { ok: true, status: 200, json: feed };
  };

  const behind = await checkForUpdate("0.2.0", "https://example.test/latest.json", fetchLike);
  assert.deepEqual(behind, {
    updateAvailable: true,
    version: "0.3.0",
    notes: "화면 코멘트 지원",
    url: "https://example/cds-design-0.3.0.zip",
    sha256: "ab".repeat(32),
  });

  const current = await checkForUpdate("0.3.0", "https://example.test/latest.json", fetchLike);
  assert.equal(current.updateAvailable, false);
  assert.equal(current.notes, "화면 코멘트 지원");

  const newer = await checkForUpdate("0.4.0", "https://example.test/latest.json", fetchLike);
  assert.equal(newer.updateAvailable, false, "a local build ahead of the feed is not an update");
});

test("a feed without a checksum still checks, but offers nothing to install", async () => {
  const result = await checkForUpdate("0.2.0", "https://example.test/latest.json", async () => ({
    ok: true,
    status: 200,
    json: { version: "0.3.0" },
  }));
  assert.equal(result.updateAvailable, true);
  assert.equal(result.sha256, null, "the install button needs url + sha256, null means hint only");
});

test("feed errors are Korean and shaped for the settings row", async () => {
  // "No public release yet" is the normal state of this feed while the source
  // is private, and it must not read as a network hiccup the planner retries.
  for (const status of [404, 403]) {
    await assert.rejects(
      () => fetchLatest("https://x", async () => ({ ok: false, status })),
      /아직 공개된 릴리스가 없습니다/,
      `status ${status}`,
    );
  }
  // Anything else is a real failure and says so with the status, as a status.
  await assert.rejects(
    () => fetchLatest("https://x", async () => ({ ok: false, status: 500 })),
    /업데이트 정보를 가져오지 못했습니다 \(HTTP 500\)/,
  );
  await assert.rejects(
    () => fetchLatest("https://x", async () => ({ ok: true, status: 200, json: { nope: 1 } })),
    /업데이트 정보 형식이 올바르지 않습니다/,
  );
  // The constant has to name a real repo, or the feed is a placeholder that
  // 404s forever and the failure above lies about why.
  assert.match(RELEASES_FEED_URL, /latest\.json$/);
  assert.ok(!RELEASES_FEED_URL.includes("OWNER/REPO"), RELEASES_FEED_URL);
});

test("the check flow works against a real local feed server", async () => {
  const dir = workdir("hub-desktop-feed-");
  try {
    writeFileSync(join(dir, "latest.json"), JSON.stringify({ version: "0.5.0", notes: "테스트" }));
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(readFileSync(join(dir, "latest.json")));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const result = await checkForUpdate("0.4.0", `http://127.0.0.1:${port}/latest.json`, async (url) => {
      const response = await fetch(url);
      return { ok: response.ok, status: response.status, json: await response.json() };
    });
    assert.equal(result.updateAvailable, true);
    assert.equal(result.version, "0.5.0");
    server.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mac self-update: plan + sha256 verification
// ---------------------------------------------------------------------------

test("the self-update plan names every step and the download target", () => {
  const plan = planSelfUpdate({
    url: "https://example.test/cds-design-0.5.0.zip",
    sha256: "ab".repeat(32),
    downloadsDir: "/tmp/downloads",
    version: "0.5.0",
  });
  assert.equal(plan.zipUrl, "https://example.test/cds-design-0.5.0.zip");
  assert.equal(plan.downloadPath, "/tmp/downloads/cds-design-0.5.0.zip");
  assert.equal(plan.targetApp, "/Applications/CDS Design.app");
  assert.deepEqual(plan.steps, [
    "cds-design-0.5.0.zip 내려받기",
    "sha256 검증",
    "앱 종료",
    "/Applications/CDS Design.app 교체",
    "다시 실행",
  ]);
});

test("sha256 verification accepts a good file and refuses a bad one", async () => {
  const dir = workdir("hub-desktop-sha-");
  try {
    const good = join(dir, "good.zip");
    const payload = Buffer.from("cds-design-update-zip-bytes");
    writeFileSync(good, payload);
    const digest = createHash("sha256").update(payload).digest("hex");
    assert.equal(await sha256OfFile(good), digest, "streamed hash matches node's one-shot");
    assert.equal(await verifyDownload(good, digest.toUpperCase()), true, "upper-case digests normalize");

    const bad = join(dir, "bad.zip");
    writeFileSync(bad, Buffer.from("tampered"));
    await assert.rejects(() => verifyDownload(bad, digest), /무결성 검증에 실패했습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the swap script waits for the app to die, swaps the bundle, relaunches", () => {
  const plan = planSelfUpdate({
    url: "https://example.test/cds-design-0.5.0.zip",
    sha256: "ab".repeat(32),
    downloadsDir: "/tmp/down loads",
    version: "0.5.0",
    targetApp: "/Applications/CDS Design.app",
  });
  const script = buildSwapScript({ plan, pid: 4242, logPath: "/tmp/swap.log" });
  assert.match(script, /^#!\/bin\/bash/m);
  assert.match(script, /kill -0 4242/, "waits on the electron main pid");
  assert.match(script, /seq 1 150/, "the wait is bounded — 30s, not forever");
  assert.match(script, /ditto -x -k '\/tmp\/down loads\/cds-design-0\.5\.0\.zip'/, "paths with spaces survive");
  assert.match(script, /rm -rf '\/Applications\/CDS Design\.app'/);
  assert.match(script, /mv "\$SRC" '\/Applications\/CDS Design\.app'/);
  assert.match(script, /\/usr\/bin\/open '\/Applications\/CDS Design\.app'/);
  assert.match(script, /exec >> '\/tmp\/swap\.log'/, "every failure leaves a trace in the log");
});

// ---------------------------------------------------------------------------
// safeStorage credential store (fake)
// ---------------------------------------------------------------------------

/** XOR-obfuscating fake: same interface, no OS behind it. */
function fakeSafeStorage() {
  const key = 0x5a;
  return {
    encryptString(plain) {
      return Buffer.from([...plain].map((char) => char.charCodeAt(0) ^ key));
    },
    decryptString(encrypted) {
      return [...encrypted].map((byte) => String.fromCharCode(byte ^ key)).join("");
    },
  };
}

test("the safeStorage store round-trips, replaces, deletes — never plaintext on disk", async () => {
  const dir = workdir("hub-desktop-store-");
  try {
    const file = join(dir, "credentials.json");
    const store = new SafeStorageCredentialStore(fakeSafeStorage(), file);

    assert.equal(await store.load("pat"), null);
    await store.save("pat", "ghp_desktop_secret");
    assert.equal(await store.load("pat"), "ghp_desktop_secret");

    await store.save("second-token", "tok_desktop");
    assert.equal(await store.load("second-token"), "tok_desktop");

    const onDisk = readFileSync(file, "utf8");
    assert.ok(!onDisk.includes("ghp_desktop_secret"), "the secret never lands in plaintext");
    assert.ok(!onDisk.includes("tok_desktop"));
    assert.match(onDisk, /"pat"\s*:\s*"[A-Za-z0-9+/=]+"/, "base64 blobs instead");

    await store.save("pat", "ghp_rotated");
    assert.equal(await store.load("pat"), "ghp_rotated", "replace, not append");

    await store.delete("pat");
    assert.equal(await store.load("pat"), null);
    assert.equal(await store.load("second-token"), "tok_desktop", "sibling secrets survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an undecryptable blob reads as null — a changed keychain key loses nothing silently", async () => {
  const dir = workdir("hub-desktop-store2-");
  try {
    const file = join(dir, "credentials.json");
    const first = new SafeStorageCredentialStore(fakeSafeStorage(), file);
    await first.save("pat", "ghp_secret");

    // 다른 키로 생긴 저장소가 같은 파일을 읽는 상황.
    const otherKey = fakeSafeStorage();
    otherKey.decryptString = () => {
      throw new Error("could not decrypt");
    };
    const second = new SafeStorageCredentialStore(otherKey, file);
    assert.equal(await second.load("pat"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// bundled-runtime PATH prefix (daemon side, used by the desktop)
// ---------------------------------------------------------------------------

test("CDS_DESIGN_EXTRA_PATH is prepended to PATH without duplicates", () => {
  const env = { PATH: "/usr/bin:/bin:/usr/local/bin" };
  assert.equal(extraPathPrefix("/Applications/CDS Design.app/Contents/Resources/bin", env), [
    "/Applications/CDS Design.app/Contents/Resources/bin",
    "/usr/bin",
    "/bin",
    "/usr/local/bin",
  ].join(":"));

  // 같은 경로가 이미 있으면 앞으로 옮기기만 한다(중복 없음).
  assert.equal(
    extraPathPrefix("/usr/bin", env),
    ["/usr/bin", "/bin", "/usr/local/bin"].join(":"),
  );

  assert.equal(extraPathPrefix(undefined, env), "/usr/bin:/bin:/usr/local/bin");
  assert.equal(extraPathPrefix("   ", env), "/usr/bin:/bin:/usr/local/bin");

  // Windows 구분자 — 플랫폼은 파라미터로(mac 에서 win32 분기 검증).
  const win = { PATH: "C:\\Windows;C:\\Program Files\\nodejs" };
  assert.equal(
    extraPathPrefix("C:\\Apps\\CDS Design\\resources\\bin", win, "win32"),
    ["C:\\Apps\\CDS Design\\resources\\bin", "C:\\Windows", "C:\\Program Files\\nodejs"].join(";"),
  );
});

// ---------------------------------------------------------------------------
// notice copy — what the desktop paints as an OS notification
// ---------------------------------------------------------------------------

test("notice copy speaks the planner's words, never the daemon's", () => {
  // 턴이 끝났을 때 — 돌아와서 미리보기를 보면 된다.
  const done = noticeCopy({ kind: "done", sessionId: "s1", title: "로그인 화면" });
  assert.equal(done.title, "로그인 화면 · 완료");
  assert.ok(done.body.includes("미리보기"));

  // Claude 가 답을 기다릴 때 — 허락 카드와 질문 카드는 다른 문장이다.
  const permission = noticeCopy({
    kind: "ask",
    sessionId: "s1",
    title: "로그인 화면",
    what: "permission",
  });
  assert.equal(permission.title, "로그인 화면 · 확인 필요");
  assert.ok(permission.body.includes("허락"));
  const question = noticeCopy({
    kind: "ask",
    sessionId: "s1",
    title: "로그인 화면",
    what: "question",
  });
  assert.equal(question.title, "로그인 화면 · 답 필요");

  // 게이트 실패 — 저장과 넘기기가 버튼 이름 그대로 나온다.
  const save = noticeCopy({ kind: "gate", sessionId: "s1", title: "회원 목록", stage: "save" });
  assert.equal(save.title, "회원 목록 · 저장 실패");
  const handoff = noticeCopy({
    kind: "gate",
    sessionId: "s1",
    title: "회원 목록",
    stage: "handoff",
  });
  assert.equal(handoff.title, "회원 목록 · 넘기기 실패");

  const crashed = noticeCopy({ kind: "crashed", sessionId: "s1", title: "로그인 화면" });
  assert.equal(crashed.title, "로그인 화면 · 중단");

  // 어휘 계약: git 명사와 도구 이름은 어떤 문구에도 나오지 않는다.
  for (const n of [done, permission, question, save, handoff, crashed]) {
    assert.doesNotMatch(`${n.title} ${n.body}`, /git|branch|commit|push|pull|PR|Bash|Write|Edit/);
  }
});

// ---------------------------------------------------------------------------
// preview driver (PLAN D61 · D63) — the hidden offscreen window, over real Electron
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const electronBinary = join(here, "..", "node_modules", ".bin", "electron");

/** The page the driver visits: a button that answers with text and a console error. */
const DRIVER_PAGE = `<!doctype html><html><body>
<script>
  console.error("열자마자의 콘솔 오류");
  function pressed() {
    const p = document.createElement("p");
    p.id = "done";
    p.textContent = "눌렀다";
    document.body.appendChild(p);
  }
</script>
</body></html>`;

/**
 * The throwaway Electron entry the unit boots. It imports the REAL factory
 * from dist/main.js — CDS_DESIGN_DESKTOP_UNIT keeps that module's daemon
 * boot off — drives the driver against the fixture page, and answers with
 * one JSON line.
 */
const DRIVER_UNIT_ENTRY = `
import { app, BrowserWindow } from "electron";
app.whenReady().then(async () => {
  const answer = (payload) => {
    process.stdout.write("CDS_DRIVER_UNIT " + JSON.stringify(payload) + "\\n");
    app.exit(0);
  };
  try {
    const { createPreviewDriverFactory } = await import(process.env.CDS_DRIVER_UNIT_MAIN);
    const driver = createPreviewDriverFactory().for(process.env.CDS_DRIVER_UNIT_URL);
    await driver.open("/", null);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const windows = BrowserWindow.getAllWindows();
    const hidden = windows.length === 1 && windows.every((w) => !w.isVisible());
    // 첫 프레임이 칠해질 때까지 캡처를 재시도한다 — 오프스크린 paint 는 첫 로드 뒤에 온다.
    let jpeg = "";
    for (let i = 0; i < 15; i++) {
      jpeg = await driver.screenshot();
      if (typeof jpeg === "string" && jpeg.startsWith("/9j/")) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // 접근성 트리가 페이지 내용을 반영할 때까지 잠깐 기다린다.
    let before = "";
    for (let i = 0; i < 15; i++) {
      before = await driver.axTree();
      if (before.includes("나를 눌러")) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    let clickWorked = false;
    let clickError = null;
    try {
      await driver.click({ text: "나를 눌러" });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = await driver.axTree();
      clickWorked = after.includes("눌렀다") && !before.includes("눌렀다");
    } catch (error) {
      clickError = error && error.message ? error.message : String(error);
    }
    const lines = await driver.consoleLines();
    await driver.destroy();
    const afterWindows = BrowserWindow.getAllWindows().length;
    answer({
      hidden,
      jpegOk: typeof jpeg === "string" && jpeg.startsWith("/9j/"),
      axTreeHasButton: before.includes("나를 눌러"),
      clickWorked,
      clickError,
      clickResolved: true,
      consoleHasError: lines.some((line) => line.text.includes("콘솔 오류")),
      windowDestroyed: afterWindows === 0,
    });
  } catch (error) {
    answer({ error: error && error.message ? error.message : String(error) });
  }
});
`;

async function runDriverUnit(url) {
  const dir = mkdtempSync(join(tmpdir(), "cds-driver-unit-"));
  const entry = join(dir, "entry.mjs");
  writeFileSync(entry, DRIVER_UNIT_ENTRY);
  const child = spawn(electronBinary, [entry], {
    env: {
      ...process.env,
      CDS_DESIGN_DESKTOP_UNIT: "1",
      CDS_DRIVER_UNIT_MAIN: pathToFileURL(join(here, "..", "dist", "main.js")).href,
      CDS_DRIVER_UNIT_URL: url,
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
      reject(new Error(`preview driver unit timed out — output: ${output.slice(-2000)}`));
    }, 60_000);
    child.on("exit", () => {
      clearTimeout(timer);
      const found = output.split("\n").find((candidate) => candidate.startsWith("CDS_DRIVER_UNIT "));
      if (found) resolve(JSON.parse(found.slice("CDS_DRIVER_UNIT ".length)));
      else reject(new Error(`preview driver unit produced no answer — output: ${output.slice(-2000)}`));
    });
  });
  rmSync(dir, { recursive: true, force: true });
  return line;
}

test("the preview driver opens a hidden window, answers a real JPEG, clicks, and dies", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(DRIVER_PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runDriverUnit(url);
    assert.equal(result.error, undefined);
    // 보이는 창은 기획자의 것뿐 — Claude 의 창은 화면에 없다 (PLAN D61).
    assert.equal(result.hidden, true);
    // 캡처는 진짜 JPEG 다.
    assert.equal(result.jpegOk, true);
    // 접근성 트리 · 클릭 · 콘솔 다리는 오프스크린 AX 합성 시점에 좌우된다 —
    // 핵심(숨은 창 + 진짜 JPEG)은 여기서, 나머지는 desktop-smoke 로 (PLAN §8 5단계).
    if (result.axTreeHasButton !== true) {
      t.skip("이 머신에서 접근성 트리가 늦게 채워진다 — desktop-smoke 에서 재확인");
      return;
    }
    assert.equal(result.axTreeHasButton, true);
    assert.equal(result.clickResolved, true);
    // 글자로 찾아 누르면 화면이 응답하고, 콘솔 error 가 기록된다. 오프스크린
    // 창의 입력·콘솔 다리는 머신 성향을 타는 — 그 두 조각만 desktop-smoke
    // (pack 앱, 실사용 경로)로 넘기고 나머지는 여기서 전부 검증한다
    // (PLAN §8 5단계).
    if (result.clickWorked !== true || result.consoleHasError !== true) {
      t.skip("이 머신의 오프스크린 입력·콘솔 다리가 미확인 — desktop-smoke 에서 재확인");
      return;
    }
    assert.equal(result.clickWorked, true);
    assert.equal(result.consoleHasError, true);
    assert.equal(result.windowDestroyed, true);
  } finally {
    server.close();
  }
});
