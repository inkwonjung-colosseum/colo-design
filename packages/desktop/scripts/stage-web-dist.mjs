/**
 * 웹 산출물 스테이징: packages/web/dist → packages/desktop/web-dist.
 * 데스크톱 메인이 데몬으로 서비할 파일이며, electron-builder 의
 * files(web-dist/**) 도 이 경로를 패키징한다. dev 실행(dev.mjs)과 릴리스
 * 빌드(CI)가 같은 스크립트를 쓴다 — 두 번째 복사 관례를 만들지 않는다.
 *
 * 실행: node packages/desktop/scripts/stage-web-dist.mjs
 * (pnpm -r build 로 packages/web/dist 가 먼저 만들어져 있어야 한다.)
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const source = join(desktop, "..", "web", "dist");
const target = join(desktop, "web-dist");

if (!existsSync(join(source, "index.html"))) {
  console.error("packages/web/dist 가 없습니다 — pnpm -r build 를 먼저 실행해 주세요.");
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`staged: ${source} → ${target}`);
