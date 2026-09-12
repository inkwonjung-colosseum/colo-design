/**
 * Platform behaviour checks.
 *
 * The point of these is that the Windows branch is verified from macOS and the
 * POSIX branch from Windows, because the daemon has to ship for both and no
 * one runs the suite on both machines before every commit.
 *
 * Path separators are the one thing these cannot check: `path.join` uses the
 * host's separator, so the win32 candidates come out with forward slashes when
 * this runs on macOS. The entries, their order, and the `.exe` suffix are what
 * matter, and those are asserted.
 *
 * Run: node --test packages/daemon/test/platform.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeCandidates, filterFiles, listFiles, lookupCommand } from "../dist/environment.js";

test("Windows candidates point at .exe files", () => {
  const found = claudeCandidates("win32", "C:/Users/dev", {
    LOCALAPPDATA: "C:/Users/dev/AppData/Local",
  });
  assert.ok(found.length >= 3, "expected several Windows locations");
  assert.ok(
    found.every((p) => p.endsWith("claude.exe")),
    `every Windows candidate must be an .exe: ${found.join(", ")}`,
  );
  assert.ok(
    found[0].includes(".local") && found[0].includes("bin"),
    "the native installer location comes first",
  );
  assert.ok(
    found.some((p) => p.includes("WinGet")),
    "WinGet installs must be found",
  );
  assert.ok(!found.some((p) => p.includes("homebrew")), "no macOS paths on the Windows branch");
});

test("Windows candidates fall back when LOCALAPPDATA is unset", () => {
  const found = claudeCandidates("win32", "C:/Users/dev", {});
  assert.ok(
    found.some((p) => p.includes("AppData") && p.includes("Local")),
    "must derive AppData\\Local from the home directory",
  );
});

test("POSIX candidates cover the native installer and Homebrew", () => {
  const found = claudeCandidates("darwin", "/Users/dev");
  assert.ok(
    found.every((p) => !p.endsWith(".exe")),
    "no .exe suffixes off Windows",
  );
  assert.ok(
    found.some((p) => p.includes("/opt/homebrew/")),
    "Homebrew must be searched",
  );
  assert.ok(
    found.some((p) => p.includes("/usr/local/")),
    "the classic prefix must be searched",
  );
  assert.ok(!found.some((p) => p.includes("WinGet")), "no Windows paths on the POSIX branch");
});

test("command lookup uses the tool that exists on each platform", () => {
  assert.deepEqual(lookupCommand("win32"), {
    command: "where",
    args: ["claude.exe"],
  });
  assert.deepEqual(lookupCommand("darwin"), {
    command: "which",
    args: ["claude"],
  });
  assert.deepEqual(lookupCommand("linux"), {
    command: "which",
    args: ["claude"],
  });
});

test("the file walk needs no shell utility and skips build output", async () => {
  const root = mkdtempSync(join(tmpdir(), "hub-walk-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "readme.md"), "x");
    writeFileSync(join(root, "src", "index.ts"), "x");
    writeFileSync(join(root, "node_modules", "pkg", "junk.js"), "x");
    writeFileSync(join(root, ".git", "HEAD"), "x");

    // No .git repository metadata that `git ls-files` would accept, so this
    // exercises the walk rather than the git path.
    const files = await listFiles(root);

    assert.ok(files.includes("readme.md"), `expected readme.md in ${files.join(", ")}`);
    assert.ok(files.includes("src/index.ts"), "nested files use forward slashes");
    assert.ok(!files.some((f) => f.includes("node_modules")), "node_modules must be skipped");
    assert.ok(!files.some((f) => f.includes(".git")), "the git directory must be skipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file ranking puts filename matches above deep path matches", () => {
  const files = ["deep/nested/zebra/other.ts", "zebra.ts", "src/zebra-config.ts"];
  const ranked = filterFiles(files, "zebra", 10);
  assert.equal(ranked[0], "zebra.ts");
  assert.ok(ranked.includes("src/zebra-config.ts"));
  assert.equal(ranked.length, 3);
});

test("an empty query returns the head of the list", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  assert.deepEqual(filterFiles(files, "", 2), ["a.ts", "b.ts"]);
});

test("the daemon still reports a usable status when git is missing", async () => {
  // A stock Windows machine has no git until the user installs it. Stripping
  // PATH is the closest we can get to that from here, and it proves the file
  // listing and the status check both degrade instead of failing.
  const daemonEntry = new URL("../dist/index.js", import.meta.url).pathname;
  // A stock Windows machine has no git until the user installs it. Stripping
  // PATH is the closest we can get to that from here — but the resolver's
  // absolute fallbacks (/usr/bin/git ships with the macOS CLT) would still
  // find one, so the pin points at a file that cannot work, which is the
  // knob the resolver itself offers for "no git anywhere".
  const env = {
    ...process.env,
    PATH: "",
    Path: "",
    COLO_DESIGN_GIT_BIN: "/nonexistent/colo-design-no-git",
  };
  delete env.ANTHROPIC_API_KEY;

  const { stdout } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [daemonEntry, "doctor"], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve({ stdout: out }));
  });

  const status = JSON.parse(stdout);
  assert.equal(status.gitAvailable, false, "git must be reported missing");
  assert.ok(
    status.warnings.some((w) => /git was not found/i.test(w)),
    `expected a git warning, got: ${status.warnings.join(" | ")}`,
  );
  assert.equal(typeof status.platform, "string");
  // The version the protocol dist pins — this test reads it live rather than
  // copying a number, so a bump (D33's rule: once, at the stage's end) lands
  // here without a manual edit.
  const { PROTOCOL_VERSION } = await import("../../protocol/dist/index.js");
  assert.equal(status.protocolVersion, PROTOCOL_VERSION);
});
