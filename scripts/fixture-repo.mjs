#!/usr/bin/env node
/**
 * 수동 스모크용 fixture 레포 (검증 체제 v2 §0) — 테스트 러너가 아니라
 * 사람이 데몬을 띄워 확인할 때의 준비물. CI 에서 돌리지 않는다.
 *
 *   node scripts/fixture-repo.mjs /tmp/fix1                 # bare 원격 + 최소 앱
 *   node scripts/fixture-repo.mjs /tmp/fix1 --dies 5        # 5초 뒤 스스로 죽는 미리보기
 *   node scripts/fixture-repo.mjs /tmp/fix1 --add-commit    # 원격에 커밋 하나 더
 *
 * 만드는 것:
 *   <dir>/remote   — bare 원격 (main 브랜치)
 *   <dir>/seed     — 원격을 채운 시드 클론 (재사용: --add-commit 는 여기서 커밋한다)
 *
 * 앱은 pnpm-락파일 없음 → 설치는 돌지 않고(계약 그대로) dev 스크립트만 선다.
 * 미리보기 서버는 포트 0(빈 포트 자체 선택)을 쓰는 node http 서버 — 주소를
 * 출력하므로 데몬의 주소 감지가 그대로 돈다.
 *
 * 데몬 연결(예):
 *   COLO_DESIGN_PROJECTS_DIR=/tmp/fix1-projects \
 *   COLO_DESIGN_REPO_URL=/tmp/fix1/remote \
 *   COLO_DESIGN_CREDENTIAL_STORE=memory \
 *   pnpm dev:daemon
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const diesAfter = flag("dies");
const addCommit = args.includes("--add-commit");

if (!dir) {
  console.error("사용법: node scripts/fixture-repo.mjs <dir> [--dies <초>] [--add-commit]");
  process.exit(1);
}

const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const remote = join(dir, "remote");
const seed = join(dir, "seed");
const appJs = (dies) => `const http = require("node:http");
const pages = {
  "/": "<h1>홈</h1><p>fixture 앱</p>",
  "/list": "<h1>회원 목록</h1><ul><li>김기획</li><li>이디자인</li></ul>",
  "/boom": "<h1>깨진 화면</h1><script>throw new Error("fixture 오류")</script>",
  "/blank": "<h1>빈 화면</h1><script>document.body.innerHTML=""</script>",
};
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/missing")) { res.statusCode = 404; res.end("nope"); return; }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(pages[req.url.split("?")[0]] ?? "<h1>fixture</h1>");
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  console.log(\`Local: http://127.0.0.1:\${port}/\`);
});${
  dies
    ? `
// --dies: 준비되고 ${dies}초 뒤 스스로 죽는다 (재기동 검증용)
setTimeout(() => process.exit(1), ${Number(dies) * 1000});`
    : ""
}
`;

function create() {
  mkdirSync(dir, { recursive: true });
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.email", "fixture@localhost");
  git(seed, "config", "user.name", "fixture");
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify(
      {
        name: "fixture-app",
        private: true,
        scripts: { dev: diesAfter ? `node server.js --dies ${diesAfter}` : "node server.js" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(seed, "server.js"), appJs(diesAfter));
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "fixture 앱");
  git(seed, "clone", "--bare", ".", remote);
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  console.log(`fixture 준비: 원격 ${remote} (시드 ${seed})`);
}

if (addCommit) {
  if (!existsSync(join(seed, "package.json"))) throw new Error("먼저 fixture 를 만들어 주세요");
  appendFileSync(join(seed, "server.js"), "\n// 원격 커밋 추가\n");
  const prev = readFileSync(join(seed, "server.js"), "utf8");
  writeFileSync(join(seed, "server.js"), prev);
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "원격 쪽 최신 변경");
  git(seed, "push", "-q", "origin", "main");
  console.log(`원격에 커밋 추가: ${git(seed, "rev-parse", "--short", "HEAD")}`);
} else if (!existsSync(remote)) {
  create();
} else {
  console.log(`이미 있음: ${remote} — --add-commit 으로 원격에 커밋을 더한다`);
}
