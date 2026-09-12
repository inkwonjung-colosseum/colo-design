/**
 * 데스크톱 개발 실행: 필요한 것들을 모아 electron 을 띄운다.
 *   - 데몬/프로토콜/웹 빌드 + 데스크톱 tsc
 *   - web-dist 스테이징(릴리스 빌드와 같은 stage-web-dist.mjs)
 *   - 포터블 런타임 resources/bin 은 없어도 된다(있으면 PATH 에 붙는다)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repo = join(desktop, "..", "..");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["--filter", "@colo-design/protocol", "build"], repo);
run("pnpm", ["--filter", "@colo-design/daemon", "build"], repo);
run("pnpm", ["--filter", "@colo-design/web", "build"], repo);
run("pnpm", ["--filter", "@colo-design/desktop", "build"], repo);

// 메인이 찾는 경로(app.getAppPath()/web-dist)에 웹 산출물을 둔다 —
// 릴리스 빌드와 같은 스테이징 스크립트를 쓴다.
run(process.execPath, [join(here, "stage-web-dist.mjs")], repo);

const electron = join(desktop, "node_modules", ".bin", "electron");
if (!existsSync(electron)) {
  console.error("electron 바이너리가 없습니다 — pnpm install 을 먼저 실행해 주세요.");
  process.exit(1);
}
run(electron, [desktop], desktop);
