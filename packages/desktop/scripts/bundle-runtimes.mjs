/**
 * 포터블 런타임 번들(DESIGN §7 런타임 번들): 연결 레포의 install·preview·
 * build 가 요구하는 node + corepack(pnpm 활성화)을 resources/bin 으로
 * 모은다. Windows 빌드에서는 MinGit 도 같은 폴더에 둔다(config — 이 머신
 * 에서는 실행하지 않는다).
 *
 * 앱은 resources/bin 을 COLO_DESIGN_EXTRA_PATH 로 데몬에 넘기고, 데몬은
 * repo.ts 에서 PATH 앞에 붙인다 — 사용자 머신의 Node/pnpm 과 무관하다.
 *
 * 실행: node packages/desktop/scripts/bundle-runtimes.mjs [--out <dir>] [--with-mingit]
 * 소스는 이 머신의 node 실행파일과 node 배포가 함께 두는 corepack dist.
 * CI 에서는 actions/setup-node 가 설치한 것을 같은 방식으로 복사한다.
 */

import { execFile } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const outAt = process.argv.indexOf("--out");
const bin = outAt === -1 ? join(here, "..", "resources", "bin") : resolve(process.argv[outAt + 1]);
const win = process.platform === "win32";
const withMinGit = process.argv.includes("--with-mingit");

mkdirSync(bin, { recursive: true });

// node — 실행 파일 그대로.
const node = process.execPath;
copyFileSync(node, join(bin, win ? "node.exe" : "node"));
console.log(`node: ${node}`);

// corepack — node 배포가 node 실행파일 옆에 두는 corepack 패키지를 통째로
// 옮긴다. 실행 스크립트는 우리가 쓴다: 배포마다 bin/corepack 이 심볼릭 링크
// (nvm · setup-node)이기도 하고 셸 스크립트(zip)이기도 해서 런처만 복사하면
// 제각각의 상대경로가 남아, 어느 쪽이든 require 하는 구현체가 번들에서 빠진다
// (2026-09 에 나간 0.3.x 앱이 정확히 이렇게 죽었다). 구현체는 dist/lib/
// corepack.cjs 지만 corepack 은 패키지 루트의 package.json 도 읽으므로(버전
// 확인) 패키지 전체가 들어가야 한다.
//
// 디렉터리 이름을 node_modules 로 두지 않는 게 핵심이다. electron-builder 는
// extraResources filter 에 node_modules 를 무조건 제외해서(저런 이름의 산물
// 을 앱 의존성 노드와 섞지 않으려는 기본 동작) 아무리 **/* 를 걸어도 빠진다
// — 이 빌드가 0.3.x 다음 버전을 만들며 실제로 밟았다. corepack-nm 디렉터리에
// 두고 shim 이 NODE_PATH 로 알려주면 corepack 의 require.resolve(
// 'corepack/package.json') 가 그 폴백에서 패키지를 찾는다(실행 검증됨).
// 패키지 package.json 이 "type": "module" 이 아니므로 dist 의 .js 는 주변과
// 무관하게 항상 CommonJS 로 읽힌다.
const nodeDir = dirname(node);
const pkg =
  [
    join(nodeDir, "node_modules", "corepack"), // Windows zip · setup-node
    join(nodeDir, "..", "lib", "node_modules", "corepack"), // POSIX nvm · pkg · homebrew
  ].find(
    (dir) =>
      existsSync(join(dir, "package.json")) &&
      existsSync(join(dir, "dist", "corepack.js")) &&
      existsSync(join(dir, "dist", "lib", "corepack.cjs")),
  ) ?? null;
if (!pkg) {
  console.error("corepack 패키지를 찾지 못했습니다 — node 배포 옆에 corepack 가 있어야 합니다.");
  process.exit(1);
}
cpSync(pkg, join(bin, "corepack-nm", "corepack"), { recursive: true });

// corepack 실행 스크립트 — 번들 node 로 구현체를 직접 돌린다. 다운로드
// 프롬프트 기본값 0 도 원 배포 런처를 잇는다: 데몬 자식은 사용자에게 프롬프트를
// 띄울 수 없다.
writeFileSync(
  join(bin, win ? "corepack.cmd" : "corepack"),
  win
    ? '@echo off\r\nIF NOT DEFINED COREPACK_ENABLE_DOWNLOAD_PROMPT SET COREPACK_ENABLE_DOWNLOAD_PROMPT=0\r\nSET NODE_PATH=%~dp0corepack-nm\r\n"%~dp0node.exe" "%~dp0corepack-nm\\corepack\\dist\\corepack.js" %*\r\n'
    : '#!/bin/sh\nCOREPACK_ENABLE_DOWNLOAD_PROMPT=${COREPACK_ENABLE_DOWNLOAD_PROMPT:-0}\nexport COREPACK_ENABLE_DOWNLOAD_PROMPT\nNODE_PATH="$(dirname "$0")/corepack-nm"\nexport NODE_PATH\nexec "$(dirname "$0")/node" "$(dirname "$0")/corepack-nm/corepack/dist/corepack.js" "$@"\n',
  { mode: 0o755 },
);
// pnpm shim: corepack 이 첫 실행 때 만들지 않고, 앱이 쓰는 대로 고정한다.
writeFileSync(
  join(bin, win ? "pnpm.cmd" : "pnpm"),
  win
    ? "@echo off\r\ncorepack.cmd pnpm %*\r\n"
    : '#!/bin/sh\nexec "$(dirname "$0")/corepack" pnpm "$@"\n',
  { mode: 0o755 },
);
console.log(`corepack: ${pkg} (package + own shims)`);

// MinGit(Windows 만, DESIGN §7): 번들 파일을 수동으로 resources/bin 에
// 두었을 때 목록만 남긴다. CI 는 winget/직접 내려받기로 채운다.
if (withMinGit) {
  if (!win) {
    console.error("--with-mingit 은 Windows 빌드에서만 씁니다.");
    process.exit(1);
  }
  const git = join(bin, "cmd", "git.exe");
  if (existsSync(git)) {
    console.log(`MinGit: ${git}`);
  } else {
    console.error("MinGit 이 resources/bin/cmd/git.exe 에 없습니다 — 번들에서 채워 주세요.");
    process.exit(1);
  }
}

// 무결성 기록: 앱이 시작할 때 존재만 확인한다(버전 고정은 하지 않는다).
// corepack --version 을 여기서 돌려 찍는다 — 구현체가 번들에서 빠지면 이
// 스크립트 자체가 실패해야 한다(런처만 복사하는 옛 버그는 이 검사를 통과할 수
// 없다).
const { stdout: nodeOut } = await run(join(bin, win ? "node.exe" : "node"), ["--version"]);
const { stdout: corepackOut } = await run(join(bin, win ? "corepack.cmd" : "corepack"), [
  "--version",
]);
writeFileSync(
  join(bin, "RUNTIMES.txt"),
  `node ${nodeOut.trim()}\ncorepack ${corepackOut.trim()} via bundled dist\n`,
);
console.log(`bundled: ${nodeOut.trim()} / corepack ${corepackOut.trim()} → ${bin}`);
