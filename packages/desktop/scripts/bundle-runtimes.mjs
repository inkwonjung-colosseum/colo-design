/**
 * 포터블 런타임 번들(DESIGN §7 런타임 번들): 연결 레포의 install·preview·
 * build 가 요구하는 node + corepack(pnpm 활성화)을 resources/bin 으로
 * 모은다. Windows 빌드에서는 MinGit 도 같은 폴더에 둔다(config — 이 머신
 * 에서는 실행하지 않는다).
 *
 * 앱은 resources/bin 을 COLO_DESIGN_EXTRA_PATH 로 데몬에 넘기고, 데몬은
 * repo.ts 에서 PATH 앞에 붙인다 — 사용자 머신의 Node/pnpm 과 무관하다.
 *
 * 실행: node packages/desktop/scripts/bundle-runtimes.mjs [--with-mingit]
 * 소스는 이 머신의 node 실행파일(corepack 은 node 옆에 있다). CI 에서는
 * actions/setup-node 가 설치한 것을 같은 방식으로 복사한다.
 */

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "resources", "bin");
const withMinGit = process.argv.includes("--with-mingit");

mkdirSync(bin, { recursive: true });

// node — 실행 파일 그대로.
const node = process.execPath;
copyFileSync(node, join(bin, process.platform === "win32" ? "node.exe" : "node"));
console.log(`node: ${node}`);

// corepack — node 배포에 포함(실행 스크립트를 같은 폴더에 둔다).
const corepack = join(dirname(node), process.platform === "win32" ? "corepack.cmd" : "corepack");
if (existsSync(corepack)) {
  copyFileSync(corepack, join(bin, process.platform === "win32" ? "corepack.cmd" : "corepack"));
  // pnpm shim: corepack 이 첫 실행 때 만들지 않고, 앱이 쓰는 대로 고정한다.
  writeFileSync(
    join(bin, process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
    process.platform === "win32"
      ? "@echo off\r\ncorepack pnpm %*\r\n"
      : '#!/bin/sh\nexec "$(dirname "$0")/corepack" pnpm "$@"\n',
    { mode: 0o755 },
  );
  console.log(`corepack: ${corepack} (+ pnpm shim)`);
} else {
  console.error("corepack 을 찾지 못했습니다 — node 배포 옆에 있어야 합니다.");
  process.exit(1);
}

// MinGit(Windows 만, DESIGN §7): 번들 파일을 수동으로 resources/bin 에
// 두었을 때 목록만 남긴다. CI 는 winget/직접 내려받기로 채운다.
if (withMinGit) {
  if (process.platform !== "win32") {
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
const { stdout } = await run(
  process.platform === "win32" ? join(bin, "node.exe") : join(bin, "node"),
  ["--version"],
);
writeFileSync(join(bin, "RUNTIMES.txt"), `node ${stdout.trim()}\ncorepack via pnpm shim\n`);
console.log(`bundled: ${stdout.trim()} → ${bin}`);
