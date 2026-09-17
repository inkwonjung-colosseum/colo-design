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

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { containsPath, realpathBestEffort } from "../dist/paths.js";
import { PermissionMemory, permissionSignature } from "../dist/session.js";
import { serveWeb } from "../dist/web-static.js";

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
    assert.equal(realpathBestEffort(join(dir, "a", "b", "not-yet.md")), join(real, "not-yet.md"));
    assert.equal(
      realpathBestEffort(join(dir, "a", "b", "deep", "deeper", "file.md")),
      join(real, "deep", "deeper", "file.md"),
    );
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
  assert.equal(
    memory.allows("Bash", { command: "pnpm check" }),
    true,
    "extra fields do not change the command identity",
  );
  assert.equal(
    memory.allows("Bash", { command: "pnpm build" }),
    false,
    "a different command still prompts",
  );
  assert.equal(
    memory.allows("WebFetch", { url: "https://x" }),
    false,
    "a different tool still prompts",
  );

  memory.record("WebFetch", { url: "https://x" });
  assert.equal(memory.allows("WebFetch", { url: "https://x" }), true);
  assert.equal(memory.allows("WebFetch", { url: "https://y" }), false);
});

test("path-shaped tools key on tool+path; Bash keys on the command string", () => {
  assert.equal(permissionSignature("Bash", { command: "ls" }), "Bash:command:ls");
  assert.equal(permissionSignature("Edit", { file_path: "/w/a.md" }), "Edit:path:/w/a.md");
  assert.equal(
    permissionSignature("Edit", { file_path: "/w/b.md" }) ===
      permissionSignature("Edit", { file_path: "/w/a.md" }),
    false,
  );
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
  // Every path this daemon reads is this directory's. Unscoped, it adopted
  // the DEVELOPER'S ~/.colo-design registry: it activated their project,
  // started a bring-up of their real clone, and `stop()` then waited that
  // bring-up out — twenty-odd seconds of the L1 lane spent syncing a repo
  // this check has no opinion about (and touching a tree nobody asked it to).
  process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(dir, "projects.json");
  process.env.COLO_DESIGN_PROJECTS_DIR = join(dir, "projects");
  process.env.COLO_DESIGN_RUN_DIR = join(dir, "run");
  process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
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
    // The other checks in this file run in the same process and read no
    // registry, but a leaked pointer at a deleted directory is a trap for
    // whatever is added next.
    delete process.env.COLO_DESIGN_PROJECTS_SETTINGS;
    delete process.env.COLO_DESIGN_PROJECTS_DIR;
    delete process.env.COLO_DESIGN_RUN_DIR;
    delete process.env.COLO_DESIGN_CREDENTIAL_STORE;
  }
});

// ---------------------------------------------------------------------------
// git 의 명사 — a session never writes history the tool did not review
// ---------------------------------------------------------------------------

test("Bash git commit·push are refused before 항상 허용; reads and stash stay open", async () => {
  const { Session } = await import("../dist/session.js");
  // decidePermission runs on the prototype with a stub `this`: the git guard
  // sits before alwaysAllowed, so a memory that would allow anything still
  // cannot buy it.
  const ask = {
    alwaysAllowed: { allows: () => true },
    handlePermission: () => Promise.resolve({ behavior: "allow", updatedInput: {} }),
    cwd: workdir("hub-git-gate-"),
  };
  const signal = new AbortController().signal;
  const exec = { kind: "exec", name: "Bash" };
  for (const command of [
    "git commit -m 'ㅅㄴㅅ'",
    "git -C /repo push origin main",
    "git push --set-upstream origin colo-design/20260911-1",
  ]) {
    const verdict = await Session.prototype.decidePermission.call(
      ask,
      { ...exec, command },
      { command },
      { signal },
    );
    assert.equal(verdict.behavior, "deny", command);
    assert.match(verdict.message, /저장 버튼/, `${command} names the tool's own verb`);
  }
  // Status reads and conflict cleanup (add·stash) are the session's to use.
  // config 의 조회형(--get·--list)도 읽기다 — hooks 경로를 읽는 일은 무해.
  for (const command of [
    "git status --porcelain",
    "git add -A",
    "git stash list",
    "git config --get user.name",
    "git config --list --show-origin",
    "git config --global -l",
  ]) {
    const verdict = await Session.prototype.decidePermission.call(
      ask,
      { ...exec, command },
      { command },
      { signal },
    );
    assert.equal(verdict.behavior, "allow", command);
  }
  // config 의 값 심기·해제는 여전히 도구의 동사다.
  for (const command of [
    "git config user.name 개발자",
    "git config --global user.name 개발자",
    "git config --unset user.name",
  ]) {
    const verdict = await Session.prototype.decidePermission.call(
      ask,
      { ...exec, command },
      { command },
      { signal },
    );
    assert.equal(verdict.behavior, "deny", command);
    assert.match(verdict.message, /저장 버튼/, `${command} names the tool's own verb`);
  }
});

test("an open merge lets the conflict card's git commit through; push never", async () => {
  const { Session } = await import("../dist/session.js");
  // 최신화 충돌의 회복 카드는 AI 에게 [conflict] 커밋을 시킨다 — 그 지시를
  // 게이트가 거부하면 도구가 제 손발을 묶는다(브리프 ↔ 게이트 모순). MERGE_HEAD
  // 가 열려 있을 때만 커밋이 열리고, push 는 병합 중에도 도구의 동사다.
  const dir = workdir("hub-git-gate-merge-");
  const ask = {
    alwaysAllowed: { allows: () => true },
    handlePermission: () => Promise.resolve({ behavior: "allow", updatedInput: {} }),
    cwd: dir,
  };
  const signal = new AbortController().signal;
  const exec = { kind: "exec", name: "Bash" };
  try {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "MERGE_HEAD"), "refs/heads/main\n");
    const verdict = await Session.prototype.decidePermission.call(
      ask,
      { ...exec, command: "git commit -m '[conflict] 최신 변경 반영'" },
      { command: "git commit -m '[conflict] 최신 변경 반영'" },
      { signal },
    );
    assert.notEqual(verdict.behavior, "deny", "the merge-concluding commit is the card's own ask");
    const push = await Session.prototype.decidePermission.call(
      ask,
      { ...exec, command: "git push origin main" },
      { command: "git push origin main" },
      { signal },
    );
    assert.equal(push.behavior, "deny", "push stays the tool's verb even mid-merge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// serveWeb containment — the static host answers unauthenticated requests, so
// its traversal check is the whole boundary. The old lexical `startsWith`
// read a prefix-named sibling (`web-evil` next to `web`) as inside, and a
// symlink planted inside pointing out as inside too.
// ---------------------------------------------------------------------------

function fakeRes() {
  const res = {
    status: 0,
    body: undefined,
    writeHead(code) {
      res.status = code;
      return res;
    },
    end(body) {
      res.body = body;
    },
  };
  return res;
}

function served(root, url) {
  const res = fakeRes();
  serveWeb(root, { url }, res);
  return res;
}

test("serveWeb serves files under root and falls back for unknown paths", async () => {
  const dir = workdir("hub-web-");
  try {
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "index.html"), "<html>app</html>");
    writeFileSync(join(dir, "web", "app.js"), "console.log(1)");
    const page = served(join(dir, "web"), "/app.js");
    assert.equal(page.status, 200);
    assert.equal(String(page.body), "console.log(1)");
    // SPA fallback: an unknown route is the app, not an error.
    const spa = served(join(dir, "web"), "/some/route");
    assert.equal(spa.status, 200);
    assert.equal(String(spa.body), "<html>app</html>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serveWeb: a prefix-named sibling is outside, not inside", async () => {
  const dir = workdir("hub-web-");
  try {
    mkdirSync(join(dir, "web"), { recursive: true });
    mkdirSync(join(dir, "web-evil"), { recursive: true });
    writeFileSync(join(dir, "web", "index.html"), "<html>app</html>");
    writeFileSync(join(dir, "web-evil", "secret.txt"), "leak me");
    // Lexical check passed: "/x/web-evil/…" starts with "/x/web". The
    // filesystem check refuses it.
    for (const url of ["/../web-evil/secret.txt", "/%2e%2e/web-evil/secret.txt"]) {
      const res = served(join(dir, "web"), url);
      assert.equal(res.status, 200, url);
      assert.equal(String(res.body), "<html>app</html>", `${url} must not leak the sibling`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serveWeb: a symlink inside pointing out is outside too", async () => {
  const dir = workdir("hub-web-");
  try {
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "index.html"), "<html>app</html>");
    writeFileSync(join(dir, "secret.txt"), "leak me");
    symlinkSync(join(dir, "secret.txt"), join(dir, "web", "leak.txt"));
    const res = served(join(dir, "web"), "/leak.txt");
    assert.equal(String(res.body), "<html>app</html>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
