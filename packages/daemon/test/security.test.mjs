/**
 * Security / containment regressions — the boundary cohort's F6+F10, F7.
 *
 * F6/F10: containment is decided through the filesystem (realpath), so the
 * /private spelling of a tmp workspace auto-allows legitimate writes while a
 * symlink planted inside and pointing out is refused. F7: 항상 허용 remembers
 * the exact call; an identical call never prompts again, a different one
 * still does.
 *
 * Run: node --test packages/daemon/test/security.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containsPath, realpathBestEffort } from "../dist/paths.js";
import { PermissionMemory, permissionSignature } from "../dist/session.js";

function workdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}


// ---------------------------------------------------------------------------
// F6 + F10 — realpath containment
// ---------------------------------------------------------------------------

test("realpathBestEffort resolves what exists and appends what does not", () => {
  const dir = workdir("hub-paths-");
  try {
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    // On macOS the tmpdir has two spellings; the resolved form is canonical.
    const real = realpathBestEffort(join(dir, "a", "b"));
    assert.ok(!real.startsWith("/var/folders") || true); // sanity: no assertion on host layout
    assert.equal(realpathBestEffort(join(dir, "a", "b", "not-yet.md")), join(real, "not-yet.md"));
    assert.equal(realpathBestEffort(join(dir, "a", "b", "deep", "deeper", "file.md")), join(real, "deep", "deeper", "file.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the alternate OS spelling of a workspace counts as inside", () => {
  const dir = workdir("hub-paths-alias-");
  try {
    mkdirSync(dir, { recursive: true });
    const real = realpathBestEffort(dir);
    // macOS: os.tmpdir() is /var/folders/... whose realpath is /private/var/...
    // A containment check against the lexical spelling must still accept the
    // realpath spelling and vice versa.
    assert.equal(containsPath(dir, join(real, "page.md")), true);
    assert.equal(containsPath(real, join(dir, "page.md")), true);
    assert.equal(containsPath(real, join(real, "page.md")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlink inside the workspace pointing outside is refused", () => {
  const outer = workdir("hub-paths-out-");
  const inner = workdir("hub-paths-in-");
  try {
    mkdirSync(join(outer, "elsewhere"), { recursive: true });
    mkdirSync(inner, { recursive: true });
    symlinkSync(join(outer, "elsewhere"), join(inner, "escape"));
    writeFileSync(join(outer, "elsewhere", "target.txt"), "outside");

    assert.equal(containsPath(inner, join(inner, "page.md")), true, "a plain file is inside");
    assert.equal(
      containsPath(inner, join(inner, "escape")),
      false,
      "the symlink target resolves outside — not contained",
    );
    assert.equal(
      containsPath(inner, join(inner, "escape", "target.txt")),
      false,
      "paths through the symlink are not contained either",
    );
  } finally {
    rmSync(outer, { recursive: true, force: true });
    rmSync(inner, { recursive: true, force: true });
  }
});

test("an absolute target outside the root is refused regardless of spelling", () => {
  const a = workdir("hub-paths-a-");
  const b = workdir("hub-paths-b-");
  try {
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    assert.equal(containsPath(a, join(b, "x.md")), false);
    // A prefix-looking path is not containment.
    assert.equal(containsPath(a, `${a}-suffix/x.md`), false);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F7 — 항상 허용 memory
// ---------------------------------------------------------------------------

test("an identical approved call never prompts again; a different one does", () => {
  const memory = new PermissionMemory();
  memory.record("Bash", { command: "pnpm check", description: "gate" });

  assert.equal(memory.allows("Bash", { command: "pnpm check", description: "gate" }), true);
  assert.equal(memory.allows("Bash", { command: "pnpm check" }), true, "extra fields do not change the command identity");
  assert.equal(memory.allows("Bash", { command: "pnpm build" }), false, "a different command still prompts");
  assert.equal(memory.allows("WebFetch", { url: "https://x" }), false, "a different tool still prompts");

  memory.record("WebFetch", { url: "https://x" });
  assert.equal(memory.allows("WebFetch", { url: "https://x" }), true);
  assert.equal(memory.allows("WebFetch", { url: "https://y" }), false);
});

test("path-shaped tools key on tool+path; Bash keys on the command string", () => {
  assert.equal(permissionSignature("Bash", { command: "ls" }), "Bash:command:ls");
  assert.equal(permissionSignature("Edit", { file_path: "/w/a.md" }), "Edit:path:/w/a.md");
  assert.equal(permissionSignature("Edit", { file_path: "/w/b.md" }) === permissionSignature("Edit", { file_path: "/w/a.md" }), false);
  // No command, no path: a stable JSON fallback still distinguishes calls.
  assert.notEqual(
    permissionSignature("Tool", { a: 1, b: 2 }),
    permissionSignature("Tool", { a: 1, b: 3 }),
  );
});

// ---------------------------------------------------------------------------
// F2 — the daemon's own http responses are never cacheable
// ---------------------------------------------------------------------------

test("daemon http responses carry cache-control: no-store (token'd page must not hit a disk cache)", async () => {
  const { DaemonServer } = await import("../dist/server.js");
  const dir = workdir("hub-security-nostore-");
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>hub</body></html>\n");
  const server = new DaemonServer({
    host: "127.0.0.1",
    port: 0,
    token: "nostore-test",
    webDist: dir,
  });
  await server.start();
  try {
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    for (const path of ["/", "/health", "/some/spa/route"]) {
      const res = await fetch(`${base}${path}?token=nostore-test`, {
        headers: { authorization: `Bearer nostore-test` },
      });
      await res.arrayBuffer().catch(() => undefined);
      assert.equal(res.headers.get("cache-control"), "no-store", `${path} must be no-store`);
    }
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
