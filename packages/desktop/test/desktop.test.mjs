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
  loadDesktopSettings,
  loadNotificationPrefs,
  loadStoredPort,
  saveDesktopSettings,
} from "../dist/desktop-settings.js";
import { buildSwapScript as buildMacSwapScript } from "../dist/mac-self-update.js";
import { noticeCopy } from "../dist/notices.js";
import { normalizeNotificationPrefs, shouldNotify } from "../dist/notify-policy.js";
import { SafeStorageCredentialStore } from "../dist/safe-storage-store.js";
import {
  parseSwapResult,
  planSelfUpdate,
  requireDiskSpace,
  sha256OfFile,
  verifyDownload,
} from "../dist/self-update.js";
import { buildSwapScript as buildWinSwapScript } from "../dist/win-self-update.js";

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
    winUrl: "https://example/colo-design-Setup-0.3.0.exe",
    winSha256: "cd".repeat(32),
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
    winUrl: "https://example/colo-design-Setup-0.3.0.exe",
    winSha256: "cd".repeat(32),
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

test("a one-platform feed leaves the other platform's asset absent", async () => {
  // 한쪽 플랫폼만 실은 피드는 흔하다(빌드 하나가 실패한 릴리스). 그때 다른
  // 플랫폼의 설치 단추가 아무것도 없는 url 로 달려가서는 안 된다.
  const macOnly = await fetchLatest("https://x", async () => ({
    ok: true,
    status: 200,
    json: { version: "0.6.0", url: "https://example/mac.zip", sha256: "ab".repeat(32) },
  }));
  assert.equal(macOnly.winUrl, undefined);
  assert.equal(macOnly.winSha256, undefined);

  const winOnly = await checkForUpdate("0.5.0", "https://x", async () => ({
    ok: true,
    status: 200,
    json: {
      version: "0.6.0",
      winUrl: "https://example/setup.exe",
      winSha256: "cd".repeat(32),
    },
  }));
  assert.equal(winOnly.url, null);
  assert.equal(winOnly.sha256, null);
  assert.equal(winOnly.winUrl, "https://example/setup.exe");
  assert.equal(winOnly.winSha256, "cd".repeat(32));
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
// self-update: plan (mac · win) + sha256 verification + swap scripts
// ---------------------------------------------------------------------------

test("the mac self-update plan names every step and the download target", () => {
  const plan = planSelfUpdate({
    url: "https://example.test/colo-design-0.5.0.zip",
    sha256: "ab".repeat(32),
    downloadsDir: "/tmp/downloads",
    version: "0.5.0",
    platform: "darwin",
  });
  assert.equal(plan.assetUrl, "https://example.test/colo-design-0.5.0.zip");
  assert.equal(plan.downloadPath, "/tmp/downloads/colo-design-0.5.0.zip");
  assert.equal(plan.target, "/Applications/Colo Design.app");
  assert.deepEqual(plan.steps, [
    "colo-design-0.5.0.zip 내려받기",
    "sha256 검증",
    "앱 종료",
    "/Applications/Colo Design.app 교체",
    "다시 실행",
  ]);
});

test("the Windows plan installs an exe into the running exe's place", () => {
  const target = "C:\\Users\\Kim\\AppData\\Local\\Programs\\colo-design\\Colo Design.exe";
  const plan = planSelfUpdate({
    url: "https://example.test/colo-design-Setup-0.5.0-win-x64.exe",
    sha256: "cd".repeat(32),
    downloadsDir: "C:\\Users\\Kim\\Down loads",
    version: "0.5.0",
    platform: "win32",
    target,
  });
  assert.equal(plan.assetUrl, "https://example.test/colo-design-Setup-0.5.0-win-x64.exe");
  assert.ok(
    plan.downloadPath.endsWith("colo-design-Setup-0.5.0.exe"),
    `the installer, not a zip: ${plan.downloadPath}`,
  );
  assert.equal(plan.target, target, "the caller's exe path is the target, verbatim");
  assert.deepEqual(plan.steps, [
    "colo-design-Setup-0.5.0.exe 내려받기",
    "sha256 검증",
    "앱 종료",
    "설치 프로그램 실행(무인)",
    "다시 실행",
  ]);
  // 설치 위치를 추측하면 엉뚱한 자리를 다시 띄운다 — 그래서 대상은 필수다.
  assert.throws(
    () =>
      planSelfUpdate({
        url: "https://example.test/setup.exe",
        sha256: "cd".repeat(32),
        downloadsDir: "C:\\Down loads",
        version: "0.5.0",
        platform: "win32",
      }),
    /교체 대상 실행 파일의 경로가 필요합니다/,
  );
  assert.throws(
    () =>
      planSelfUpdate({
        url: "https://example.test/whatever",
        sha256: "cd".repeat(32),
        downloadsDir: "/tmp",
        version: "0.5.0",
        platform: "linux",
      }),
    /자가 교체를 지원하지 않습니다/,
  );
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

test("the mac swap script waits for the app to die, swaps the bundle, relaunches", () => {
  const plan = planSelfUpdate({
    url: "https://example.test/colo-design-0.5.0.zip",
    sha256: "ab".repeat(32),
    downloadsDir: "/tmp/down loads",
    version: "0.5.0",
    platform: "darwin",
    target: "/Applications/Colo Design.app",
  });
  const script = buildMacSwapScript({
    plan,
    pid: 4242,
    logPath: "/tmp/swap.log",
    resultPath: "/Users/사용자/Library/Application Support/Colo Design/update-result.json",
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
    /'\/Users\/사용자\/Library\/Application Support\/Colo Design\/update-result\.json'/,
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

test("the Windows swap script waits out the locked exe, installs silently, relaunches", () => {
  // 경로에 한 번 든 작은따옴표가 PowerShell 리터럴을 닫아 버리면 스크립트는
  // 문법 오류로 죽고, 앱은 닫힌 채 남는다 — 그래서 O'Brien 이 대상 경로에 있다.
  const target = "C:\\Users\\O'Brien\\AppData\\Local\\Programs\\colo-design\\Colo Design.exe";
  const plan = planSelfUpdate({
    url: "https://example.test/colo-design-Setup-0.5.0-win-x64.exe",
    sha256: "cd".repeat(32),
    downloadsDir: "C:\\Users\\사용자\\Down loads",
    version: "0.5.0",
    platform: "win32",
    target,
  });
  const script = buildWinSwapScript({
    plan,
    pid: 4242,
    logPath: "C:\\Temp\\swap.log",
    resultPath: "C:\\Users\\사용자\\AppData\\Roaming\\Colo Design\\update-result.json",
    version: "0.5.0",
  });
  // 도는 exe 는 잠겨 있다 — 이 기다림 없이는 설치가 파일을 덮어쓰지 못한다.
  assert.match(
    script,
    /Get-Process -Id 4242 -ErrorAction SilentlyContinue/,
    "polls the electron main pid",
  );
  assert.match(script, /AddSeconds\(30\)/, "the wait is bounded — 30s, not forever");
  assert.match(
    script,
    /Start-Process -FilePath \$installer -ArgumentList '\/S' -Wait -PassThru/,
    "silent install, and the script waits for its verdict",
  );
  assert.ok(!script.includes("/D="), "the install location comes from the registry, not /D=");
  assert.match(script, /\$process\.ExitCode -ne 0/, "a non-zero exit is a failure, not a success");
  assert.match(script, /Start-Process -FilePath \$target/, "the new build gets relaunched");
  // 결과 파일에 BOM 이 붙으면 다음 실행의 JSON.parse 가 그대로 던지고, 교체는
  // 성공했는데 아무 보고도 남지 않는다.
  assert.match(
    script,
    /New-Object System\.Text\.UTF8Encoding \$false/,
    "the result line has no BOM",
  );
  // 경로는 모두 단일 인용 — 공백·한글이 흔하고, 따옴표는 두 번 찍어 막는다.
  assert.match(
    script,
    /\$installer = '[^\n']*Down loads[^\n']*colo-design-Setup-0\.5\.0\.exe'/,
    "the download path with its space survives, single-quoted",
  );
  assert.match(
    script,
    /\$target = 'C:\\Users\\O''Brien\\[^\n]*Colo Design\.exe'/,
    "a quote inside the path is doubled, not left to close the literal",
  );
  assert.match(
    script,
    /\$resultPath = 'C:\\Users\\사용자\\AppData\\Roaming\\Colo Design\\update-result\.json'/,
    "the result path survives its spaces",
  );
  const embedded = [...script.matchAll(/'(\{"outcome":[^\n]*?\})'/g)].map((m) => m[1]);
  const parsed = embedded.map((raw) => parseSwapResult(raw));
  assert.ok(parsed.length >= 4, `every exit leaves a result line (found ${parsed.length})`);
  assert.ok(
    parsed.every((r) => r !== null),
    "each embedded line parses as a swap result — the same shape the mac script writes",
  );
  assert.ok(
    parsed.some(
      (r) => r?.outcome === "done" && r.version === "0.5.0" && r.logPath === "C:\\Temp\\swap.log",
    ),
    "the happy path records done + version + log",
  );
  assert.ok(
    parsed.some(
      (r) => r?.outcome === "failed" && r.reason === "앱이 끝나지 않아 교체를 포기했습니다",
    ),
    "a still-running app is reported, not silently skipped",
  );
  assert.ok(
    parsed.some((r) => r?.outcome === "failed" && /종료 코드 __EXIT__/.test(r.reason ?? "")),
    "the installer's exit code reaches the user's notice",
  );
  assert.match(script, /-replace '__EXIT__', \$code/, "that placeholder is filled at runtime");
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
  // 문구 자체는 카피의 영역이다 — 테스트가 지키는 것은 구조와 어휘 계약:
  // 스레드 이름이 제목이 되고(notices.ts:5), 여섯 종은 서로 다른 말을
  // 하며, git 명사와 도구 이름은 어떤 알림에도 나오지 않는다.
  const cases = [
    { kind: "done", sessionId: "s1", title: "로그인 화면" },
    { kind: "ask", sessionId: "s1", title: "로그인 화면", what: "permission" },
    { kind: "ask", sessionId: "s1", title: "로그인 화면", what: "question" },
    { kind: "gate", sessionId: "s1", title: "회원 목록", stage: "save" },
    { kind: "gate", sessionId: "s1", title: "회원 목록", stage: "handoff" },
    { kind: "crashed", sessionId: "s1", title: "로그인 화면" },
  ];
  const copies = cases.map((notice) => ({ notice, out: noticeCopy(notice) }));
  for (const { notice, out } of copies) {
    assert.ok(out.title.length > 0 && out.body.length > 0, "빈 알림은 없다");
    assert.ok(out.title.startsWith(notice.title), "스레드 이름이 제목이 된다");
    assert.doesNotMatch(
      `${out.title} ${out.body}`,
      /git|branch|commit|push|pull|PR|Bash|Write|Edit/,
    );
  }
  assert.equal(
    new Set(copies.map((c) => c.out.body)).size,
    copies.length,
    "알림 여섯 종은 서로 다른 말을 한다",
  );
});

test("개발자 쪽 알림은 프로젝트 이름으로 부르고 네 사건이 서로 다른 말을 한다", () => {
  // 커미티 B1+2026-09-15: 단위는 프로젝트(대화가 아니다), 그리고 반영됨 ·
  // 반려 · 변경 요청 · 코멘트는 사용자가 할 일이 서로 다르므로 문장도 다르다.
  const cases = [
    { kind: "handoff", slug: "shop", projectName: "쇼핑몰", event: "merged" },
    { kind: "handoff", slug: "shop", projectName: "쇼핑몰", event: "closed" },
    { kind: "handoff", slug: "shop", projectName: "쇼핑몰", event: "changes_requested" },
    { kind: "handoff", slug: "shop", projectName: "쇼핑몰", event: "comments", count: 3 },
  ];
  const copies = cases.map((notice) => noticeCopy(notice));
  for (const out of copies) {
    assert.ok(out.title.startsWith("쇼핑몰"), "프로젝트 이름이 제목이 된다");
    assert.doesNotMatch(
      `${out.title} ${out.body}`,
      /git|branch|commit|push|pull|PR|Bash|Write|Edit/,
    );
  }
  assert.equal(new Set(copies.map((out) => out.body)).size, copies.length);
  assert.match(copies[3].body, /3건/, "코멘트 알림은 몇 건인지 말한다");
});

// ---------------------------------------------------------------------------
// preview driver (PLAN D61 · D63) — the hidden offscreen window, over real Electron
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const electronBinary = join(here, "..", "node_modules", ".bin", "electron");

/**
 * The page the driver visits: a width readout logged to the console (so 폭
 * emulation is observable through the console bridge alone), a `data-state`
 * marker for the settle wait, and a console error plus a failing request on
 * load.
 */
const DRIVER_PAGE = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head><body>
<div data-screen="unit/Driver" data-state="기본">
  <p id="w">?</p>
</div>
<script>
  console.error("열자마자의 콘솔 오류");
  fetch("/missing").catch(function () {});
  function report() {
    document.getElementById("w").textContent = String(window.innerWidth);
    console.log("innerWidth=" + window.innerWidth);
  }
  report();
  window.addEventListener("resize", report);
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
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const { createPreviewDriverFactory } = await import(process.env.COLO_DRIVER_UNIT_MAIN);
    const driver = createPreviewDriverFactory().for(process.env.COLO_DRIVER_UNIT_URL, [
      "http://localhost:6006",
    ]);
    // 선언한 상태의 표식을 기다리므로, 여기서 돌아오면 화면은 자리를 잡았다.
    const opened = await driver.open("/", "기본");
    // 미리보기 서버도 레포가 허용한 서버도 아닌 주소는 열지 않는다 — 조용히
    // 넘어가지 않고 말한다.
    const refused = await driver.open("https://example.invalid/x", null);
    const windows = BrowserWindow.getAllWindows();
    const hidden = windows.length === 1 && windows.every((w) => !w.isVisible());
    // 첫 프레임이 칠해질 때까지 캡처를 재시도한다 — 오프스크린 paint 는 첫 로드 뒤에 온다.
    // WebP 의 base64 는 RIFF 헤더라 "UklGR" 로 시작한다.
    let shot = null;
    for (let i = 0; i < 15; i++) {
      shot = await driver.screenshot({ longEdge: 900 });
      if (shot && typeof shot.data === "string" && shot.data.startsWith("UklGR")) break;
      await sleep(200);
    }
    // 폭은 진짜로 좁아진다 — 페이지가 스스로 콘솔에 말한 innerWidth 가 증거다.
    let mobileWidth = null;
    await driver.open("/", "기본", { viewport: "mobile", colorScheme: "dark" });
    for (let i = 0; i < 15; i++) {
      const probe = await driver.consoleLines();
      const found = probe
        .map((line) => line.text.match(/innerWidth=(\\d+)/))
        .find(Boolean);
      if (found) {
        mobileWidth = Number(found[1]);
        if (mobileWidth === 390) break;
      }
      await sleep(200);
    }
    // 404 의 net 기록은 응답이 떨어진 뒤에 온다 — 폭 프로브가 빨리 끝나도
    // 기록이 다 모인 뒤에 읽는다.
    await sleep(500);
    const lines = await driver.consoleLines();
    await driver.destroy();
    const afterWindows = BrowserWindow.getAllWindows().length;
    // pane 드라이버: 사용자가 보는 pane 의 페이지를 그대로 찍는다 — 창을
    // 새로 세우지 않고, 드라이버가 끝나도 페이지는 사용자의 것이라 살아 있다.
    const { PlannerPreviewView } = await import(process.env.COLO_DRIVER_UNIT_VIEW);
    const paneWindow = new BrowserWindow({ show: true, width: 1280, height: 800 });
    const pane = new PlannerPreviewView(() => paneWindow);
    pane.mount(process.env.COLO_DRIVER_UNIT_URL + "/", null, ["http://localhost:6006"]);
    pane.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    const paneDriver = createPreviewDriverFactory(() => pane).for(
      process.env.COLO_DRIVER_UNIT_URL,
      ["http://localhost:6006"],
    );
    const paneOpened = await paneDriver.open("/", "기본");
    const paneShot = await paneDriver.screenshot({ longEdge: 600 });
    await paneDriver.destroy();
    const paneContents = pane.webContents();
    const panePageAlive = paneContents !== null && !paneContents.isDestroyed();
    paneWindow.destroy();
    answer({
      openedOk: opened && opened.ok === true,
      openedSettled: opened && opened.settled === true,
      refusedOk: refused && refused.ok === false,
      refusedReason: refused ? refused.reason ?? null : null,
      hidden,
      webpOk: !!shot && shot.mediaType === "image/webp" && shot.data.startsWith("UklGR"),
      mobileWidth,
      consoleHasError: lines.some((line) => line.text.includes("콘솔 오류")),
      consoleHasNet: lines.some((line) => line.level === "net"),
      windowDestroyed: afterWindows === 0,
      paneOpenedOk: paneOpened && paneOpened.ok === true,
      paneShotOk:
        !!paneShot && paneShot.mediaType === "image/webp" && paneShot.data.startsWith("UklGR"),
      panePageAlive,
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
      COLO_DRIVER_UNIT_VIEW: pathToFileURL(join(here, "..", "dist", "preview-view.js")).href,
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

test("미리보기 드라이버: 숨은 창, 거절하는 open, 캡처와 콘솔 다리", async (t) => {
  const server = createServer((request, response) => {
    // 실패하는 요청 하나 — screen_console 의 `net` 줄이 여기서 온다.
    if (request.url?.startsWith("/missing")) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("nope");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(DRIVER_PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runDriverUnit(url);
    assert.equal(result.error, undefined);
    // 보이는 창은 사용자의 것뿐 — Claude 의 창은 화면에 없다 (PLAN D61).
    assert.equal(result.hidden, true);
    // 캡처는 컴포지터가 한 번에 구운 진짜 WebP 다 — 재인코딩 세대가 없다.
    assert.equal(result.webpOk, true);
    // 선언한 상태의 표식을 기다렸으므로 열림은 자리를 잡은 열림이다.
    assert.equal(result.openedOk, true);
    assert.equal(result.openedSettled, true);
    // 허용 목록 밖의 주소는 "열었습니다" 가 아니라 거절이다 — 조용히
    // 넘어가면 도구가 모델에게 거짓말을 한다.
    assert.equal(result.refusedOk, true);
    assert.match(result.refusedReason, /허용되지 않은 서버/);
    // 폭 에뮬레이션은 페이지가 스스로 콘솔에 말한 innerWidth 로 증명된다.
    assert.equal(result.mobileWidth, 390);
    // pane 드라이버: 캡처는 사용자가 보는 같은 WebContents 를 찍고, 드라이버가
    // 끝나도 페이지는 사용자의 것이라 살아 있다.
    assert.equal(result.paneOpenedOk, true);
    assert.equal(result.paneShotOk, true);
    assert.equal(result.panePageAlive, true);
    // 콘솔 error 와 실패한 요청이 기록된다.
    assert.equal(result.consoleHasError, true);
    assert.equal(result.consoleHasNet, true);
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
  const deltas = [];
  const template = buildMenuTemplate({
    preview: {
      reload: noop,
      history: noop,
      cycleTab: (delta) => deltas.push(delta),
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
  // 탭 전환(인앱 브라우저 계획 §3 규칙 8): 메뉴에 오는 것은 ⌘⇧[/⌘⇧] 쌍뿐이다
  // — ⌘T(새 탭)·⌘W(탭 닫기)는 뷰 포커스 스코프라 before-input-event 채널로
  // 가고, 메뉴의 ⌘T는 앱 전역 '새 대화' 그대로다.
  assert.equal(byAccelerator("CmdOrCtrl+Shift+[").label, "이전 탭");
  assert.equal(byAccelerator("CmdOrCtrl+Shift+]").label, "다음 탭");
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
  // 탭 전환 클릭은 방향을 그대로 뷰로 옮긴다 — 이전/다음이 뒤집히면 여기서 걸린다.
  byAccelerator("CmdOrCtrl+Shift+[").click();
  byAccelerator("CmdOrCtrl+Shift+]").click();
  assert.deepEqual(deltas, [-1, 1]);
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
      cycleTab: noop,
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
  // 새 엔트리(⌘⇧[/⌘⇧], 탭 전환)도 같은 규칙 안에 산다 — ⊆ 루프는 빠진 것을
  // 증명하지 못하니, 메뉴에 실제로 도착했는지를 먼저 확인한다.
  for (const accelerator of ["CmdOrCtrl+Shift+[", "CmdOrCtrl+Shift+]"]) {
    assert.ok(menuAccelerators.includes(accelerator), `${accelerator} is a menu item`);
  }
  // ⌘T(새 탭)·⌘W(탭 닫기)는 일부러 메뉴 항목이 아니다(인앱 브라우저 계획
  // §3 규칙 8): preview 뷰 포커스에서만 뜻이 있는 키라 before-input-event
  // 채널로 가고, 상수·메뉴의 ⌘T는 앱 전역 '새 대화' 그대로다.
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

// ---------------------------------------------------------------------------
// desktop-settings.json — 알림 정책과 데몬 포트가 한 파일을 나눠 쓴다
// ---------------------------------------------------------------------------

test("설정 저장은 다른 키를 지우지 않는다 — 알림 뒤에 포트를 써도 둘 다 산다", () => {
  const dir = workdir("hub-desktop-settings-");
  const file = join(dir, "desktop-settings.json");

  saveDesktopSettings(file, { notifications: { done: "all", sound: false } });
  saveDesktopSettings(file, { port: 52341 });

  const stored = loadDesktopSettings(file);
  assert.deepEqual(stored.notifications, { done: "all", sound: false });
  assert.equal(stored.port, 52341);
});

test("포트 순서를 바꿔도 같다 — 포트 뒤의 알림 갱신이 포트를 지우지 않는다", () => {
  const dir = workdir("hub-desktop-settings-");
  const file = join(dir, "desktop-settings.json");

  saveDesktopSettings(file, { port: 52341 });
  saveDesktopSettings(file, { notifications: { done: "off", sound: true } });

  assert.equal(loadStoredPort(file), 52341, "알림 갱신 뒤에도 포트가 남는다");
});

test("저장 포트는 범위를 검증한다 — 손으로 고친 값은 없던 것으로 읽는다", () => {
  const dir = workdir("hub-desktop-settings-");
  const file = join(dir, "desktop-settings.json");

  assert.equal(loadStoredPort(file), null, "파일 자체가 없어도 null");

  for (const bad of [80, 1023, 65536, 3.5, "7823", true, null]) {
    writeFileSync(file, JSON.stringify({ port: bad }));
    assert.equal(loadStoredPort(file), null, `${JSON.stringify(bad)} 는 못 쓰는 값`);
  }

  writeFileSync(file, JSON.stringify({ port: 7823 }));
  assert.equal(loadStoredPort(file), 7823);
});

test("깨진 파일은 기본값으로 읽힌다 — 부팅을 망가뜨리지 않는다", () => {
  const dir = workdir("hub-desktop-settings-");
  const file = join(dir, "desktop-settings.json");

  writeFileSync(file, "{ not json");
  assert.deepEqual(loadNotificationPrefs(file), { done: "long", sound: true });
  assert.equal(loadStoredPort(file), null);

  writeFileSync(file, JSON.stringify([1, 2, 3]));
  assert.deepEqual(loadDesktopSettings(file), {}, "배열도 객체가 아니면 빈 설정");
});

test("알림 정책은 normalize 를 거쳐 읽힌다 — 저장된 못 쓰는 값은 기본으로", () => {
  const dir = workdir("hub-desktop-settings-");
  const file = join(dir, "desktop-settings.json");

  writeFileSync(file, JSON.stringify({ notifications: { done: "가끔", sound: "네" } }));
  assert.deepEqual(loadNotificationPrefs(file), { done: "long", sound: true });

  writeFileSync(file, JSON.stringify({ notifications: { done: "all", sound: false } }));
  assert.deepEqual(loadNotificationPrefs(file), { done: "all", sound: false });
});
