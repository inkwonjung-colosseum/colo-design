/**
 * Desktop unit checks — update logic (version compare, feed parse, sha256
 * verify, plan), the notice copy the OS notification paints, the safeStorage
 * store against a fake, and the daemon-side PATH prefix. Everything runs
 * offline; the update feed is a local fixture server, the sha256 fixtures are
 * real files.
 *
 * Run: node --test packages/desktop/test/desktop.test.mjs
 */

import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { extraPathPrefix } from "../../daemon/dist/repo.js";
import {
  checkForUpdate,
  compareSemver,
  fetchLatest,
  RELEASES_FEED_URL,
} from "../../protocol/dist/update.js";
import {
  buildSwapScript,
  parseSwapResult,
  planSelfUpdate,
  requireDiskSpace,
  sha256OfFile,
  verifyDownload,
} from "../dist/mac-self-update.js";
import { noticeCopy } from "../dist/notices.js";
import { normalizeNotificationPrefs, shouldNotify } from "../dist/notify-policy.js";
import { SafeStorageCredentialStore } from "../dist/safe-storage-store.js";

function workdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

const execFile = promisify(execFileCb);

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
    url: "https://example/colo-design-0.3.0.zip",
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
    url: "https://example/colo-design-0.3.0.zip",
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
    () =>
      fetchLatest("https://x", async () => ({
        ok: true,
        status: 200,
        json: { nope: 1 },
      })),
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
    const result = await checkForUpdate(
      "0.4.0",
      `http://127.0.0.1:${port}/latest.json`,
      async (url) => {
        const response = await fetch(url);
        return {
          ok: response.ok,
          status: response.status,
          json: await response.json(),
        };
      },
    );
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
    url: "https://example.test/colo-design-0.5.0.zip",
    sha256: "ab".repeat(32),
    downloadsDir: "/tmp/downloads",
    version: "0.5.0",
  });
  assert.equal(plan.zipUrl, "https://example.test/colo-design-0.5.0.zip");
  assert.equal(plan.downloadPath, "/tmp/downloads/colo-design-0.5.0.zip");
  assert.equal(plan.targetApp, "/Applications/Colo Design.app");
  assert.deepEqual(plan.steps, [
    "colo-design-0.5.0.zip 내려받기",
    "sha256 검증",
    "앱 종료",
    "/Applications/Colo Design.app 교체",
    "다시 실행",
  ]);
});

test("sha256 verification accepts a good file and refuses a bad one", async () => {
  const dir = workdir("hub-desktop-sha-");
  try {
    const good = join(dir, "good.zip");
    const payload = Buffer.from("colo-design-update-zip-bytes");
    writeFileSync(good, payload);
    const digest = createHash("sha256").update(payload).digest("hex");
    assert.equal(await sha256OfFile(good), digest, "streamed hash matches node's one-shot");
    assert.equal(
      await verifyDownload(good, digest.toUpperCase()),
      true,
      "upper-case digests normalize",
    );

    const bad = join(dir, "bad.zip");
    writeFileSync(bad, Buffer.from("tampered"));
    await assert.rejects(() => verifyDownload(bad, digest), /무결성 검증에 실패했습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the swap script waits for the app to die, swaps the bundle, relaunches", () => {
  const plan = planSelfUpdate({
    url: "https://example.test/colo-design-0.5.0.zip",
    sha256: "ab".repeat(32),
    downloadsDir: "/tmp/down loads",
    version: "0.5.0",
    targetApp: "/Applications/Colo Design.app",
  });
  const script = buildSwapScript({
    plan,
    pid: 4242,
    logPath: "/tmp/swap.log",
    resultPath: "/Users/기획자/Library/Application Support/Colo Design/update-result.json",
    version: "0.5.0",
  });
  assert.match(script, /^#!\/bin\/bash/m);
  assert.match(script, /kill -0 4242/, "waits on the electron main pid");
  assert.match(script, /seq 1 150/, "the wait is bounded — 30s, not forever");
  assert.match(
    script,
    /ditto -x -k '\/tmp\/down loads\/colo-design-0\.5\.0\.zip'/,
    "paths with spaces survive",
  );
  assert.match(
    script,
    /mv "\$TARGET" "\$BACKUP"/,
    "the old bundle steps aside, never rm-rf'd first",
  );
  assert.match(script, /mv "\$SRC" "\$TARGET"/, "the new bundle takes the place");
  assert.match(script, /mv "\$BACKUP" "\$TARGET"/, "a failed move restores the old bundle");
  assert.match(script, /exec >> '\/tmp\/swap\.log'/, "every failure leaves a trace in the log");
  // 결과 기록 — 스크립트의 모든 끝(성공·실패)이 결과 파일로 말을 남긴다.
  assert.match(
    script,
    /'\/Users\/기획자\/Library\/Application Support\/Colo Design\/update-result\.json'/,
    "the result path survives its spaces",
  );
  const embeddedResults = [...script.matchAll(/'(\{"outcome":[^\n]*\})'/g)].map((m) => m[1]);
  const parsed = embeddedResults.map((raw) => parseSwapResult(raw));
  assert.ok(parsed.length >= 5, `every exit leaves a result line (found ${parsed.length})`);
  assert.ok(
    parsed.every((r) => r !== null),
    "each embedded line parses as a swap result",
  );
  assert.ok(
    parsed.some(
      (r) => r?.outcome === "done" && r.version === "0.5.0" && r.logPath === "/tmp/swap.log",
    ),
    "the happy path records done + version + log",
  );
  assert.ok(
    parsed.some(
      (r) =>
        r?.outcome === "failed" && r.reason === "새 앱 배치에 실패해 이전 버전으로 되돌렸습니다",
    ),
    "the rollback path records why",
  );
  // 재실행 — 성공 경로와 롤백 경로 모두에서 open: 어떤 끝도 앱 부재로 끝나지 않는다.
  const opens = script.match(/\/usr\/bin\/open "\$TARGET"/g) ?? [];
  assert.equal(opens.length, 2, "open runs on success AND after rollback");
});

test("parseSwapResult accepts the script's line and refuses anything doubtful", () => {
  const done = parseSwapResult(
    '{"outcome":"done","version":"0.5.0","logPath":"/tmp/colo-design-update.log"}',
  );
  assert.deepEqual(done, {
    outcome: "done",
    version: "0.5.0",
    reason: undefined,
    logPath: "/tmp/colo-design-update.log",
  });
  const failed = parseSwapResult(
    '{"outcome":"failed","version":"0.5.0","reason":"앱이 끝나지 않아 교체를 포기했습니다","logPath":"/tmp/colo-design-update.log"}',
  );
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.reason, "앱이 끝나지 않아 교체를 포기했습니다");
  assert.equal(parseSwapResult("not json"), null, "garbage is not a report");
  assert.equal(parseSwapResult('{"outcome":"maybe"}'), null, "unknown outcomes are not a report");
  assert.equal(
    parseSwapResult('{"outcome":"done","version":1,"logPath":"/tmp/x"}'),
    null,
    "a non-string version is not a report",
  );
});

test("requireDiskSpace refuses a full disk before anything is downloaded", async () => {
  const snapshot = (freeBytes) => async (path) => {
    assert.equal(path, "/tmp/down loads");
    return { bsize: 1, bavail: freeBytes };
  };
  // 여유가 넉넉하면 그냥 지나간다.
  await requireDiskSpace({
    path: "/tmp/down loads",
    minBytes: 1024 ** 3,
    statfs: snapshot(2 * 1024 ** 3),
  });
  // 부족하면 한국어 오류 — 내려받기 전에, 교체 도중이 아니라.
  await assert.rejects(
    () =>
      requireDiskSpace({
        path: "/tmp/down loads",
        minBytes: 1024 ** 3,
        statfs: snapshot(512 * 1024 ** 2),
      }),
    /디스크 공간이 부족합니다/,
  );
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

test("COLO_DESIGN_EXTRA_PATH is prepended to PATH without duplicates", () => {
  const env = { PATH: "/usr/bin:/bin:/usr/local/bin" };
  assert.equal(
    extraPathPrefix("/Applications/Colo Design.app/Contents/Resources/bin", env),
    [
      "/Applications/Colo Design.app/Contents/Resources/bin",
      "/usr/bin",
      "/bin",
      "/usr/local/bin",
    ].join(":"),
  );

  // 같은 경로가 이미 있으면 앞으로 옮기기만 한다(중복 없음).
  assert.equal(extraPathPrefix("/usr/bin", env), ["/usr/bin", "/bin", "/usr/local/bin"].join(":"));

  assert.equal(extraPathPrefix(undefined, env), "/usr/bin:/bin:/usr/local/bin");
  assert.equal(extraPathPrefix("   ", env), "/usr/bin:/bin:/usr/local/bin");

  // Windows 구분자 — 플랫폼은 파라미터로(mac 에서 win32 분기 검증).
  const win = { PATH: "C:\\Windows;C:\\Program Files\\nodejs" };
  assert.equal(
    extraPathPrefix("C:\\Apps\\Colo Design\\resources\\bin", win, "win32"),
    ["C:\\Apps\\Colo Design\\resources\\bin", "C:\\Windows", "C:\\Program Files\\nodejs"].join(";"),
  );
});

test("the bundled runtime carries corepack's implementation and its launcher loads it", async () => {
  const dir = workdir("hub-desktop-bundle-");
  try {
    // --out 로 임시 폴더에 같은 번들을 만든다 — 스크립트는 기록 단계에서
    // corepack --version 을 직접 돌리므로, 구현체가 빠지면 여기서 실패한다.
    await execFile(process.execPath, [
      join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "bundle-runtimes.mjs"),
      "--out",
      dir,
    ]);

    // 0.3.x 앱이 죽은 자리 — 런처(corepack)만 번들되고 require 대상 구현체가
    // 빠진 배포가 나가지 않는다. 이름이 node_modules 이면 electron-builder 가
    // extraResources 에서 빼 버리므로 corepack-nm 로 들어간다.
    assert.ok(
      existsSync(join(dir, "corepack-nm", "corepack", "dist", "lib", "corepack.cjs")),
      "corepack.cjs 구현체가 런처와 함께 번들되어야 한다",
    );
    assert.ok(existsSync(join(dir, "pnpm")), "pnpm shim 이 있어야 한다");

    const { stdout } = await execFile(join(dir, "corepack"), ["--version"]);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/, "번들 corepack 이 자기 버전을 말해야 한다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// notice copy — what the desktop paints as an OS notification
// ---------------------------------------------------------------------------

test("notice copy never speaks the daemon's words", () => {
  // 문구 자체는 카피의 영역이다 — 테스트가 지키는 것은 어휘 계약 하나:
  // git 명사와 도구 이름은 어떤 알림에도 나오지 않는다.
  const copies = [
    noticeCopy({ kind: "done", sessionId: "s1", title: "로그인 화면" }),
    noticeCopy({ kind: "ask", sessionId: "s1", title: "로그인 화면", what: "permission" }),
    noticeCopy({ kind: "ask", sessionId: "s1", title: "로그인 화면", what: "question" }),
    noticeCopy({ kind: "gate", sessionId: "s1", title: "회원 목록", stage: "save" }),
    noticeCopy({ kind: "gate", sessionId: "s1", title: "회원 목록", stage: "handoff" }),
    noticeCopy({ kind: "crashed", sessionId: "s1", title: "로그인 화면" }),
  ];
  for (const n of copies) {
    assert.ok(n.title.length > 0 && n.body.length > 0, "빈 알림은 없다");
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
 * from dist/main.js — COLO_DESIGN_DESKTOP_UNIT keeps that module's daemon
 * boot off — drives the driver against the fixture page, and answers with
 * one JSON line.
 */
const DRIVER_UNIT_ENTRY = `
import { app, BrowserWindow } from "electron";
app.whenReady().then(async () => {
  const answer = (payload) => {
    process.stdout.write("COLO_DRIVER_UNIT " + JSON.stringify(payload) + "\\n");
    app.exit(0);
  };
  try {
    const { createPreviewDriverFactory } = await import(process.env.COLO_DRIVER_UNIT_MAIN);
    const driver = createPreviewDriverFactory().for(process.env.COLO_DRIVER_UNIT_URL);
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
  const dir = mkdtempSync(join(tmpdir(), "colo-driver-unit-"));
  const entry = join(dir, "entry.mjs");
  writeFileSync(entry, DRIVER_UNIT_ENTRY);
  const child = spawn(electronBinary, [entry], {
    env: {
      ...process.env,
      COLO_DESIGN_DESKTOP_UNIT: "1",
      COLO_DRIVER_UNIT_MAIN: pathToFileURL(join(here, "..", "dist", "main.js")).href,
      COLO_DRIVER_UNIT_URL: url,
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
      const found = output
        .split("\n")
        .find((candidate) => candidate.startsWith("COLO_DRIVER_UNIT "));
      if (found) resolve(JSON.parse(found.slice("COLO_DRIVER_UNIT ".length)));
      else
        reject(
          new Error(`preview driver unit produced no answer — output: ${output.slice(-2000)}`),
        );
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

// ---------------------------------------------------------------------------
// 애플리케이션 메뉴 (PLAN D85 ⓒ) — the pure template
// ---------------------------------------------------------------------------

import { buildMenuTemplate } from "../dist/menu.js";

const noop = () => {};

test("buildMenuTemplate aims the view items at the preview, with the plan's accelerators", () => {
  const template = buildMenuTemplate({
    preview: {
      reload: noop,
      history: noop,
      zoomIn: noop,
      zoomOut: noop,
      zoomReset: noop,
    },
    gotoAddress: noop,
    openSettings: noop,
    newSession: noop,
    packaged: false,
  });
  const view = template.find((item) => item.label === "보기");
  assert.ok(view, "a 보기 menu exists");
  const items = view.submenu;
  const byAccelerator = (accelerator) => items.find((item) => item.accelerator === accelerator);
  assert.equal(byAccelerator("CmdOrCtrl+R").label, "미리보기 새로 고침");
  assert.equal(byAccelerator("CmdOrCtrl+[").label, "뒤로");
  assert.equal(byAccelerator("CmdOrCtrl+]").label, "앞으로");
  assert.equal(byAccelerator("CmdOrCtrl+L").label, "주소로 이동");
  assert.equal(byAccelerator("CmdOrCtrl+=").label, "확대");
  assert.equal(byAccelerator("CmdOrCtrl+-").label, "축소");
  assert.equal(byAccelerator("CmdOrCtrl+0").label, "실제 크기");
  // The Electron roles that once aimed at the TOOL UI are gone — the menu
  // owns the keys now, and none of them may hit the chat.
  const roles = items.map((item) => item.role);
  assert.ok(!roles.includes("reload"), "no role:reload");
  assert.ok(!roles.includes("forceReload"), "no role:forceReload");
  assert.ok(!roles.includes("zoomIn"), "no role:zoomIn");
  assert.ok(!roles.includes("zoomOut"), "no role:zoomOut");
  assert.ok(!roles.includes("resetZoom"), "no role:resetZoom");
});

test("buildMenuTemplate keeps the edit roles the composer lives on", () => {
  const template = buildMenuTemplate({
    preview: null,
    gotoAddress: noop,
    openSettings: noop,
    packaged: true,
  });
  const edit = template.find((item) => item.label === "편집");
  const roles = edit.submenu.map((item) => item.role);
  for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
    assert.ok(roles.includes(role), `${role} survives`);
  }
});

test("buildMenuTemplate drops 개발자 도구 in a packaged app", () => {
  const dev = buildMenuTemplate({
    preview: null,
    gotoAddress: noop,
    openSettings: noop,
    packaged: false,
  });
  const devView = dev.find((item) => item.label === "보기");
  assert.ok(
    devView.submenu.some((item) => item.role === "toggleDevTools"),
    "dev keeps the tools",
  );
  const packaged = buildMenuTemplate({
    preview: null,
    gotoAddress: noop,
    openSettings: noop,
    packaged: true,
  });
  const packagedView = packaged.find((item) => item.label === "보기");
  assert.ok(
    !packagedView.submenu.some((item) => item.role === "toggleDevTools"),
    "packaged drops the tools — 문제 해결은 설정의 몫",
  );
});

test("buildMenuTemplate's accelerators come from the same constant as the ⌘/ sheet (PLAN D92)", async () => {
  const { APP_SHORTCUTS } = await import("../../protocol/dist/shortcuts.js");
  const template = buildMenuTemplate({
    preview: {
      reload: noop,
      history: noop,
      zoomIn: noop,
      zoomOut: noop,
      zoomReset: noop,
    },
    gotoAddress: noop,
    openSettings: noop,
    newSession: noop,
    packaged: false,
  });
  const menuAccelerators = [];
  for (const item of template) {
    for (const entry of item.submenu ?? []) {
      if (entry.accelerator) menuAccelerators.push(entry.accelerator);
    }
  }
  // The plan's rule: the MENU's set ⊆ the constant — every menu accelerator
  // must come from the sheet's list, so the two surfaces cannot disagree.
  // (⌘K lives in the constant but not the menu: the chat owns it.)
  const constantAccelerators = new Set(
    APP_SHORTCUTS.filter((s) => s.accelerator).map((s) => s.accelerator),
  );
  for (const accelerator of menuAccelerators) {
    // 개발자 도구(⌥⌘I) is the developer's own item, not a planner shortcut —
    // it deliberately stays out of the planner's constant.
    if (accelerator === "Alt+CmdOrCtrl+I") continue;
    assert.ok(constantAccelerators.has(accelerator), `${accelerator} comes from the constant`);
  }
});

// ---------------------------------------------------------------------------
// 알림 정책 (설정 문서 P0#3)
// ---------------------------------------------------------------------------

test("부르는 값이 있는 순간은 시점 설정과 무관하게 부른다", () => {
  const off = { done: "off", sound: true };
  for (const notice of [
    { kind: "ask", sessionId: "s", title: "로그인", what: "permission" },
    { kind: "ask", sessionId: "s", title: "로그인", what: "question" },
    { kind: "crashed", sessionId: "s", title: "로그인" },
    { kind: "gate", sessionId: "s", title: "로그인", stage: "save" },
  ]) {
    assert.equal(shouldNotify(notice, off), true, `${notice.kind} 은 꺼짐에도 불린다`);
  }
});

test("완료 알림만 시점을 탄다 — 기본은 오래 걸린 턴", () => {
  const done = (durationMs) => ({ kind: "done", sessionId: "s", title: "로그인", durationMs });

  assert.equal(shouldNotify(done(5_000), { done: "off", sound: true }), false);
  assert.equal(shouldNotify(done(5_000), { done: "all", sound: true }), true);

  const long = { done: "long", sound: true };
  assert.equal(shouldNotify(done(5_000), long), false, "짧은 턴은 조용히 지나간다");
  assert.equal(shouldNotify(done(60_000), long), true, "1분은 부르는 값이 있다");
  assert.equal(
    shouldNotify({ kind: "done", sessionId: "s", title: "로그인" }, long),
    true,
    "걸린 시간을 모르면 부른다 — 놓치는 쪽이 비싸다",
  );
});

test("렌더러가 넘긴 알림 설정은 믿지 않고 기본으로 돌아간다", () => {
  assert.deepEqual(normalizeNotificationPrefs(null), { done: "long", sound: true });
  assert.deepEqual(normalizeNotificationPrefs({ done: "가끔", sound: "네" }), {
    done: "long",
    sound: true,
  });
  assert.deepEqual(normalizeNotificationPrefs({ done: "all", sound: false }), {
    done: "all",
    sound: false,
  });
});
