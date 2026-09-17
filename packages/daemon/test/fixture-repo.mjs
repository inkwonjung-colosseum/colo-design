/**
 * A local fixture "connected repo": a bare git remote plus a seed commit
 * carrying a minimal but valid colo-design app — package.json whose scripts
 * carry the dev server and the check gate, a pnpm lockfile so the derived
 * install runs, a tiny node static server as the preview. When `port` is
 * given the server bakes it in; otherwise it follows PORT (the handoff
 * build's hint) or picks a free one. Everything runs offline: git remotes
 * are local paths, commands are node/npm, and no registry is contacted.
 *
 * Shared by the daemon repo e2e and the browser planner e2e so both boot the
 * exact same repo contract.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A fake `claude` CLI for tests that must not touch the real login: answers
 * --version and `auth status` (logged in, team plan) and exits for anything
 * else. Point COLO_DESIGN_CLAUDE_BIN at it.
 */
export function writeStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "1.0.0-stub"; exit 0;;',
      "  auth)",
      '    echo "{\\"loggedIn\\":true,\\"authMethod\\":\\"claude.ai\\",\\"subscriptionType\\":\\"team\\",\\"email\\":\\"planner@example.com\\"}"',
      "    exit 0;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

/** A port nothing is listening on, for the fixture preview to declare. */
export function freePort() {
  const { promise, resolve } = Promise.withResolvers();
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
  return promise;
}

const serverMjs = (port) => `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
// PORT first — the handoff build's hint — then the seed-baked port, then free.
const port = Number(process.env.PORT) || ${port ?? 0};

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(join(root, "index.html"), "utf8"));
});
server.listen(port, "127.0.0.1", () => {
  console.log(\`fixture preview on http://127.0.0.1:\${server.address().port}\`);
});
`;

const INDEX_HTML = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>연결 레포 미리보기</title></head>
<body>
  <!-- 레포 브리지 계약의 참조 구현 (PLAN D72): 화면 선언 + 이동. 도구의 핀
       오버레이는 preload 가 주입하므로 여기 없다. -->
  <main id="app"><div data-screen="member/MemberList" data-state="default">
    <h1>회원 관리</h1>
    <p>연결 레포가 렌더하는 미리보기입니다.</p>
    <table><tbody>
      <tr><td data-component="MemberNameCell">홍길동</td><td><button data-component="DetailButton">상세</button></td></tr>
      <tr><td data-component="MemberNameCell">김철수</td><td><button data-component="DetailButton">상세</button></td></tr>
    </tbody></table>
  </div></main>
  <script>
    (function () {
      var applyState = function (state) {
        var wrapper = document.querySelector("[data-screen]");
        wrapper.setAttribute("data-state", state);
        var rows = wrapper.querySelectorAll("tbody tr");
        for (var i = 0; i < rows.length; i++) rows[i].style.display = state === "empty" ? "none" : "";
      };
      // 도구는 평범한 URL 이동으로도 화면 상태를 정한다(?state=) — 문서화된
      // 계약이라 레퍼런스 구현이 그 자리에서 읽는다. 메시지 경로와 같은 규칙.
      var initial = new URLSearchParams(location.search).get("state");
      if (initial) applyState(initial);
      if (!window.coloDesign && window.parent === window) return; // 받을 도구가 없다
      var post = function (envelope) {
        if (window.coloDesign && window.coloDesign.post) window.coloDesign.post(envelope);
        else window.parent.postMessage(envelope, "*");
      };
      window.addEventListener("message", function (event) {
        if (event.source !== window.parent && event.source !== window) return;
        var data = event.data || {};
        if (data.type !== "colo-design.navigate" || typeof data.route !== "string") return;
        if (data.route !== "/member/MemberList") return;
        var state = typeof data.state === "string" && data.state ? data.state : "default";
        // 실제 브리지는 클라이언트 라우팅을 한다 — 도구의 뷰는
        // did-navigate-in-page 로 그 자리를 따라간다.
        history.pushState(null, "", data.route + (state !== "default" ? "?state=" + state : ""));
        applyState(state);
      });
    })();
  </script>
</body>
</html>
`;

// The repo's own publish gate. The seed ships the passing version; a test
// overwrites the clone's copy to make a publish fail on purpose.
const CHECK_MJS = `console.log("check: 통과");
`;

// The repo's own convention for where screens live. The daemon does not know
// this; the browser planner e2e relies on it, the daemon e2e does not.
const CLAUDE_MD = `# fixture colo-design 레포

**대화 상대는 사용자다.** 모든 문장은 한국어로 쓴다.

## 작업 절차

- 화면 요청이 오면 \`src/screens/<기능>/<화면이름>.screen.tsx\` 형태로 파일을 만든다.
- 사용자가 말하지 않은 화면 내용은 지어내지 않고 AskUserQuestion으로 한 번에 묻는다.
- 터미널 명령은 실행하지 않는다. 미리보기 서버는 이미 돌고 있다.
- 만들거나 바꾼 화면을 이름과 경로로 답변에 남긴다.
`;

/**
 * Creates the remote and pushes the seed commit.
 *
 * `port` bakes a fixed preview port into the seed's server; null (default)
 * lets it follow PORT (the handoff build's hint) or pick a free one so the
 * daemon auto-detects the preview from the dev server's output/listen port.
 * `previewCommand` swaps the dev script (unit tests use a command that exits
 * immediately to observe the failure phases).
 */
export async function createFixtureRepo({
  dir,
  port = null,
  previewCommand = "node server.mjs",
  // Replaces scripts/check.mjs entirely — security regressions use a check
  // that passes while writing files the planner never reviewed.
  checkMjs = CHECK_MJS,
  // { host, scope } — seeds the committed .npmrc registry line the derivation
  // reads (npmrc leak checks).
  registry = null,
  // Swaps index.html — a suite that needs a different bridge seeds its own page.
  indexHtml = INDEX_HTML,
}) {
  const seed = join(dir, "seed");
  const remote = join(dir, "remote.git");

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(seed, "src", "screens"), { recursive: true });

  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify(
      {
        name: "fixture-colo-design-app",
        private: true,
        version: "0.0.0",
        scripts: {
          check: "node scripts/check.mjs",
          dev: previewCommand,
        },
      },
      null,
      2,
    ),
  );
  // The lockfile is what makes the derivation run an install at all — and it
  // is the exact shape `pnpm install` itself settles on, so the install is a
  // no-op that leaves the worktree clean.
  writeFileSync(
    join(seed, "pnpm-lock.yaml"),
    [
      "lockfileVersion: '9.0'",
      "",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "",
      "importers:",
      "",
      "  .: {}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(seed, ".gitignore"), "node_modules\n");
  if (registry)
    writeFileSync(join(seed, ".npmrc"), `${registry.scope}:registry=https://${registry.host}/\n`);
  mkdirSync(join(seed, "scripts"), { recursive: true });
  writeFileSync(join(seed, "scripts", "check.mjs"), checkMjs);
  writeFileSync(join(seed, "server.mjs"), serverMjs(port));
  writeFileSync(join(seed, "index.html"), indexHtml);
  writeFileSync(join(seed, "CLAUDE.md"), CLAUDE_MD);

  await run("git", ["init", "--initial-branch=main", seed]);
  await commitAll(seed, "seed");
  await run("git", ["init", "--bare", "--initial-branch=main", remote]);
  await run("git", ["push", remote, "HEAD:main"], { cwd: seed });

  return { dir, seed, remote, port };
}

/** Writes `files` (path -> contents, relative to the seed root), commits, pushes. */
export async function pushFixtureChange(seed, remote, files, message = "update") {
  for (const [path, contents] of Object.entries(files)) {
    const file = join(seed, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  await commitAll(seed, message);
  await run("git", ["push", remote, "HEAD:main"], { cwd: seed });
}

async function commitAll(seed, message) {
  await run("git", ["add", "."], { cwd: seed });
  await run(
    "git",
    [
      "-c",
      "user.name=colo-design",
      "-c",
      "user.email=fixture@colo-design.test",
      "commit",
      "-m",
      message,
    ],
    { cwd: seed },
  );
}
