#!/usr/bin/env node
/**
 * 개발 서버가 쓸 포트를 최우선으로 확보한다.
 *
 * vite(29173)는 strictPort 라 포트가 막히면 다른 포트로 넘어가지 않고 죽고,
 * 데몬은 bind 실패 즉시 죽는다. 대부분은 예전 실행이 남긴 좀비 프로세스
 * 때문이다 — dev:* 스크립트는 시작 맨 앞에서 이 스크립트로 리스너를 정리하고
 * 지나간다. 내 프로젝트의 포트가 항상 최우선이라는 규칙의 실행기.
 *
 * 사용법: node scripts/free-port.mjs <포트|daemon> [<포트|daemon>…]
 * `daemon` 은 데몬이 실제로 쓸 포트로 풀린다 — COLO_DESIGN_PORT 환경 변수,
 * 없으면 ~/.colo-design/config/daemon.json 의 기록된 포트, 그도 없으면 7823
 * (daemon/src/index.ts 의 loadConfig 와 같은 순서).
 * 리스너가 없으면 조용히 성공한다. 있으면 SIGTERM → 2초 → SIGKILL.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const SELF = process.pid;

/** 데몬이 실제로 bind 할 포트 — loadConfig() 의 포트 선택만 재현한다. */
function daemonPort() {
  const override = Number(process.env.COLO_DESIGN_PORT);
  if (override > 0) return override;
  try {
    const stored = JSON.parse(
      readFileSync(join(homedir(), ".colo-design", "config", "daemon.json"), "utf8"),
    );
    if (Number.isInteger(stored?.port) && stored.port > 0) return stored.port;
  } catch {
    // 없거나 깨진 기록 — 기본 포트로 간다.
  }
  return 7823;
}

/** 그 포트를 듣고 있는 pid 목록. lsof 가 없거나(비 POSIX) 리스너가 없으면 빈 배열. */
function listeners(port) {
  if (process.platform === "win32") return [];
  let out;
  try {
    out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  return [
    ...new Set(
      out
        .split("\n")
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== SELF),
    ),
  ];
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 하나의 포트를 비운다. 못 비우면(권한 등) 실패로 종료해 시작이 막힌 것을 드러낸다. */
async function freePort(port) {
  const pids = listeners(port);
  if (pids.length === 0) return;

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 이미 죽었다 — 아래 확인 단계에서 지나간다.
    }
  }
  let deadline = Date.now() + 2_000;
  while (Date.now() < deadline && pids.some(alive)) await sleep(100);

  for (const pid of pids.filter(alive)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  // SIGKILL 후에도 소켓 반납은 한 박자 늦다 — bind 경쟁을 막으려면 확인하고 넘어간다.
  deadline = Date.now() + 2_000;
  while (Date.now() < deadline && listeners(port).length > 0) await sleep(100);

  const left = listeners(port);
  if (left.length > 0) {
    console.error(
      `[free-port] ${port} 을(를) 잡은 프로세스(pid ${left.join(", ")})를 못 끄겠습니다.`,
    );
    process.exit(1);
  }
  console.log(`[free-port] ${port} 확보 — 종료: pid ${pids.join(", ")}`);
}

const ports = process.argv.slice(2).map((arg) => (arg === "daemon" ? daemonPort() : Number(arg)));
if (ports.length === 0 || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
  console.error("사용법: node scripts/free-port.mjs <포트|daemon> [<포트|daemon>…]");
  process.exit(1);
}
for (const port of ports) await freePort(port);
