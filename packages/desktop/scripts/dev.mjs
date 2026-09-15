/**
 * 데스크톱 개발 실행: 필요한 것들을 모아 electron 을 띄운다.
 *
 * 기본(릴리스와 같은 코드 경로):
 *   - 데몬/프로토콜/웹 빌드 + 데스크톱 tsc
 *   - web-dist 스테이징(릴리스 빌드와 같은 stage-web-dist.mjs)
 *   - 포터블 런타임 resources/bin 은 없어도 된다(있으면 PATH 에 붙는다)
 *
 * `--hmr`(빠른 개발 고리):
 *   - 웹은 빌드하지 않는다 — vite 개발 서버가 그 자리를 대신한다
 *   - electron 창이 그 서버를 열고(COLO_DESIGN_DEV_SERVER), 데몬은 그대로
 *     in-process 다. 웹 소스를 고치면 창이 즉시 바뀐다.
 *
 * 두 경로 모두: 데스크톱 src/ 를 지켜보다가 메인/프리로드가 바뀌면 다시
 * 빌드해 electron 을 갈아끼운다(빌드가 깨지면 지금 도는 앱을 그대로 둔다).
 * 데몬 · 프로토콜을 고치면 여전히 다시 실행해야 한다.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repo = join(desktop, "..", "..");
const shell = process.platform === "win32";

/** vite 개발 서버 주소 — 포트는 packages/web/vite.config.ts 의 strictPort 와 같다. */
const DEFAULT_DEV_SERVER = "http://127.0.0.1:5273";
const DEV_SERVER = process.env.COLO_DESIGN_DEV_SERVER ?? DEFAULT_DEV_SERVER;
const hmr = process.argv.includes("--hmr");

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd,
    shell,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["--filter", "@colo-design/protocol", "build"], repo);
run("pnpm", ["--filter", "@colo-design/daemon", "build"], repo);
// HMR 경로에서는 vite 가 웹을 직접 준다 — 정적 산출물을 만들 이유가 없다.
if (!hmr) run("pnpm", ["--filter", "@colo-design/web", "build"], repo);
run("pnpm", ["--filter", "@colo-design/desktop", "build"], repo);

// 메인이 찾는 경로(app.getAppPath()/web-dist)에 웹 산출물을 둔다 —
// 릴리스 빌드와 같은 스테이징 스크립트를 쓴다.
if (!hmr) run(process.execPath, [join(here, "stage-web-dist.mjs")], repo);

let vite = null;
const stopVite = () => {
  if (vite && vite.exitCode === null) vite.kill("SIGTERM");
  vite = null;
};

let electronProc = null;
let restarting = false;
let rerunBuildAfterRestart = false;
let finished = false;

function startElectron() {
  if (finished) return;
  electronProc = spawn(electron, [desktop], {
    stdio: "inherit",
    cwd: desktop,
    shell,
    env: hmr ? { ...process.env, COLO_DESIGN_DEV_SERVER: DEV_SERVER } : process.env,
    // 터미널 프로세스 그룹과 갈라 놓는다 — 종료·재시작은 이 스크립트가 그룹째로
    // 주도한다. Ctrl+C 는 detached 그룹에 닿지 않으니 아래 핸들러가 대신 전한다.
    detached: process.platform !== "win32",
  });
  electronProc.on("exit", (code) => {
    if (!restarting) finish(code ?? 0);
  });
}

/** electron 과 그 자식들이 완전히 사라질 때까지 기다린다. */
function stopElectron() {
  return new Promise((resolve) => {
    const proc = electronProc;
    if (!proc || proc.exitCode !== null) return resolve();
    proc.once("exit", resolve);
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
    }
    // 닫기 가드에 걸려 안 닫히면 3초 뒤에 강제로 끊는다.
    setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          // 이미 사라졌다 — SIGTERM 이 제대로 닿았다는 뜻이다.
        }
      }
    }, 3_000).unref();
  });
}

/** 정상 종료의 모든 길이 모이는 곳 — vite 와 electron 을 남기지 않는다. */
async function finish(code) {
  if (finished) return;
  finished = true;
  stopVite();
  await stopElectron();
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    void finish(1);
  });
}
process.on("exit", () => {
  stopVite();
  // finish() 가 정리했다면 잠자는 코드다 — 그 외 어떤 경로로 이 스크립트가
  // 죽더라도 detached electron 이 고아로 남지 않게 하는 안전망이다.
  if (electronProc && electronProc.exitCode === null && electronProc.pid) {
    try {
      process.kill(process.platform === "win32" ? electronProc.pid : -electronProc.pid, "SIGKILL");
    } catch {
      // 이미 사라졌다.
    }
  }
});
if (hmr) {
  // 사용자의 터미널 1에 `pnpm dev:web` 이 이미 돌고 있는 일이 흔하다 —
  // vite 는 strictPort 라 그 위에 또 뜨지 못한다. 그 서버가 이 레포의
  // 웹이면 그대로 쓰고, 남의 것이면 창을 엉뚱한 앱으로 열기 전에 멈춘다.
  if (await webDevServerRunning(DEV_SERVER)) {
    console.log(`[dev] 이미 도는 개발 서버를 쓴다 — ${DEV_SERVER}`);
  } else if (DEV_SERVER !== DEFAULT_DEV_SERVER) {
    // 주소를 손으로 지정했다면 그 자리에 서버를 띄우는 것도 그 사람 몫이다 —
    // 여기서 띄우는 vite 는 vite.config.ts 의 고정 포트로만 듣는다.
    console.error(`COLO_DESIGN_DEV_SERVER(${DEV_SERVER}) 에 개발 서버가 없습니다.`);
    process.exit(1);
  } else {
    vite = spawn("pnpm", ["--filter", "@colo-design/web", "dev"], {
      stdio: "inherit",
      cwd: repo,
      shell,
    });
    // 이 스크립트가 어떻게 끝나든 vite 를 남기지 않는 일은 아래 finish() 가 맡는다.
    await waitForDevServer(DEV_SERVER);
  }
}

const electron = join(desktop, "node_modules", ".bin", "electron");
if (!existsSync(electron)) {
  console.error("electron 바이너리가 없습니다 — pnpm install 을 먼저 실행해 주세요.");
  process.exit(1);
}
if (hmr) console.log(`[dev] electron → ${DEV_SERVER} (HMR)`);

startElectron();

// 데스크톱 메인/프리로드가 바뀌면 다시 빌드해 electron 을 갈아끼운다.
let rebuildTimer = null;
const sourceWatcher = watch(join(desktop, "src"), { recursive: true }, () => {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuildAndRestart, 250);
});
sourceWatcher.on("error", (error) => {
  console.error(`[dev] 소스 감시 실패 — ${error.message}`);
  void finish(1);
});

async function rebuildAndRestart() {
  if (restarting) {
    // 재시작 한창 중에 또 바뀌면 — 끝나고 마지막 상태로 다시 빌드한다.
    rerunBuildAfterRestart = true;
    return;
  }
  if (finished) return;
  restarting = true;
  console.log("[dev] 데스크톱 소스 변경 — 재빌드");
  const result = spawnSync("pnpm", ["--filter", "@colo-design/desktop", "build"], {
    stdio: "inherit",
    cwd: repo,
    shell,
  });
  if (electronProc.exitCode !== null) {
    // 빌드 사이에 앱이 닫혔다 — exit 이벤트는 restarting 에 가로막혔으니 여기서 마무리한다.
    await finish(electronProc.exitCode);
    return;
  }
  if (result.status !== 0) {
    restarting = false;
    console.error("[dev] 데스크톱 빌드 실패 — electron 은 지금 상태로 계속 간다.");
    return;
  }
  console.log("[dev] electron 재시작");
  await stopElectron();
  restarting = false;
  startElectron();
  if (rerunBuildAfterRestart) {
    rerunBuildAfterRestart = false;
    rebuildAndRestart();
  }
}

/**
 * 그 주소에 이 레포의 웹 개발 서버가 이미 있는가. 아무거나 200 을 주는 서버를
 * 믿으면 창이 남의 앱을 열게 된다 — vite 가 변환해 내보내는 App.tsx 안의
 * 저장 키까지 확인해야 우리 것이라고 말할 수 있다.
 */
async function webDevServerRunning(url) {
  let body;
  try {
    const response = await fetch(new URL("/src/App.tsx", url), {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(String(response.status));
    body = await response.text();
  } catch {
    return false; // 아무도 없다 — 우리가 띄운다
  }
  if (body.includes("colo-design.daemon-url")) return true;
  console.error(
    `${url} 을 다른 서버가 쓰고 있습니다 — 그 서버를 끄거나 COLO_DESIGN_DEV_SERVER 로 다른 주소를 지정해 주세요.`,
  );
  process.exit(1);
}

/** vite 가 응답할 때까지 기다린다 — 창이 빈 페이지를 여는 경주를 막는다. */
async function waitForDevServer(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (vite === null || vite.exitCode !== null) {
      console.error(`vite 개발 서버(${url})가 시작하지 못했습니다.`);
      process.exit(1);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // 아직 듣지 않는다 — 다음 박자에 다시 두드린다.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.error(`vite 개발 서버(${url})가 60초 안에 뜨지 않았습니다.`);
  process.exit(1);
}
