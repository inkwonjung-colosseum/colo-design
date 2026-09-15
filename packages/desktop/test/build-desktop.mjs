/**
 * The Electron suites' one build step (comments · smoke · switch · cover):
 * the four packages, then the web bundle copied into `packages/desktop/
 * web-dist` where the app's main looks for it.
 *
 * `COLO_TEST_SKIP_BUILD=1` skips the compile and keeps the copy — for a
 * caller that JUST built the tree. CI's offline lanes run `pnpm build` as
 * their own step, so without this every Electron suite rebuilt all four
 * packages again: four `vite build`s and sixteen `tsc`s, ~2 minutes of the
 * L1 lane spent compiling what the step before had already compiled.
 * A developer running one suite by hand leaves it unset and gets the build.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repo = join(desktop, "..", "..");

/** 의존 순서대로 — protocol 이 나머지 셋의 타입을 낳는다. */
const PACKAGES = [
  "@colo-design/protocol",
  "@colo-design/daemon",
  "@colo-design/web",
  "@colo-design/desktop",
];

/** Builds (unless skipped) and refreshes `packages/desktop/web-dist`. */
export function buildDesktopBundle() {
  if (!process.env.COLO_TEST_SKIP_BUILD) {
    for (const name of PACKAGES) {
      const result = spawnSync("pnpm", ["--filter", name, "build"], {
        stdio: "inherit",
        cwd: repo,
      });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
  // The copy stays either way: it is a second's work, and it is what makes
  // the app's bundle the one the tree just produced. test-parallel.mjs stages
  // web-dist once for the whole lane instead, so its suites do not rmSync a
  // sibling's copy mid-run — it hands them COLO_TEST_SKIP_WEBDIST=1.
  if (process.env.COLO_TEST_SKIP_WEBDIST) return;
  const webDist = join(desktop, "web-dist");
  rmSync(webDist, { recursive: true, force: true });
  mkdirSync(webDist, { recursive: true });
  cpSync(join(repo, "packages", "web", "dist"), webDist, { recursive: true });
}
