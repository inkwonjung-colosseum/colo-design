#!/usr/bin/env node
// orphan-check — PLAN-CRASH-PROCESS.md §3.B 의 재현 도구.
// `before` 로 프로세스 스냅샷을 ~/.nova-design/logs/orphan-before.json 에 적고,
// 시나리오(Stop · 창 닫기 · 강제 종료) 뒤 `after` 로 새로 생긴 claude · codex · omp ·
// node · 셸 계열 프로세스를 표로 낸다. before 와 after 사이에 이 도구는 아무것도
// 하지 않는다 — 재현 결과가 도구 자신으로 오염되지 않는다.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// 독립 실행 스크립트라 데몬 모듈을 가져오지 않는다 — 경로 표기는 홀로 남는다
// (environment.ts 의 NOVA_DESIGN_DATA_DIR 과 같은 값을 가리킨다).
const SNAPSHOT_PATH = join(homedir(), ".nova-design", "logs", "orphan-before.json");
const WATCH_NAMES = new Set([
  "claude",
  "codex",
  "omp",
  "node",
  "bash",
  "sh",
  "pwsh",
  "powershell",
  "conhost",
  "cmd",
  "vite",
]);
const COMMAND_LIMIT = 100;

const USAGE = [
  "사용법: node scripts/orphan-check.mjs before|after",
  "  before — 지금 프로세스 스냅샷을 orphan-before.json 에 적는다",
  "  after  — 새 스냅샷을 찍어 before 이후 새로 남은 프로세스를 표로 낸다 (0줄이면 통과)",
].join("\n");

function normName(value) {
  return basename(String(value ?? "").replace(/\.exe$/i, ""))
    .replace(/^-/, "")
    .toLowerCase();
}

function truncCommand(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > COMMAND_LIMIT ? `${text.slice(0, COMMAND_LIMIT - 1)}…` : text;
}

// 스냅샷 명령을 한 번 돌리고, 그 자식 pid 를 own 에 남긴다(판정에서 뺀다).
function runCapture(argv, own) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.pid) own.add(result.pid);
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? "";
}

// mac · linux — ps 한 번으로 pid · ppid · 전체 인자. comm 은 쓰지 않는다 — TTY 가 없으면
// macOS 가 경로를 16 자로 자라(/Users/developji) 이미지 이름이 못 된다. 이름은 args 의
// 첫 토큰(실행 이름)의 basename 으로 뽑는다.
function snapshotPosix() {
  const own = new Set();
  const raw = runCapture(["ps", "-axo", "pid=,ppid=,args="], own);
  const rows = [];
  if (raw === null) {
    console.error("[orphan-check] 경고 — ps 스냅샷이 실패해 빈 스냅샷으로 판정한다");
    return { rows, own };
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const args = match[3].trim();
    const space = args.search(/\s/);
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: normName(space === -1 ? args : args.slice(0, space)),
      command: truncCommand(args),
    });
  }
  return { rows, own };
}

// Windows — powershell 한 번(ProcessId · ParentProcessId · Name · CommandLine)이 우선이고,
// 그것이 망가지면 tasklist 의 이름·pid 바닥으로라도 판정한다.
function snapshotWindows() {
  const own = new Set();
  const byPid = new Map();
  const taskRaw = runCapture(["tasklist", "/FO", "CSV", "/NH"], own);
  if (taskRaw !== null) {
    for (const line of taskRaw.split("\n")) {
      const match = line.match(/^"([^"]*)",\s*(\d+)\s*,/);
      if (!match) continue;
      const pid = Number(match[2]);
      byPid.set(pid, { pid, ppid: 0, name: normName(match[1]), command: "" });
    }
  }
  const psRaw = runCapture(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ],
    own,
  );
  if (psRaw !== null) {
    try {
      const parsed = JSON.parse(psRaw);
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        byPid.set(Number(entry.ProcessId), {
          pid: Number(entry.ProcessId),
          ppid: Number(entry.ParentProcessId ?? 0),
          name: normName(entry.Name),
          command: truncCommand(entry.CommandLine ?? ""),
        });
      }
    } catch {
      console.error("[orphan-check] 경고 — powershell 스냅샷을 읽지 못해 tasklist 로 판정한다");
    }
  } else if (taskRaw !== null) {
    console.error(
      "[orphan-check] 경고 — powershell 이 실패해 tasklist(ppid·명령줄 없음)로 판정한다",
    );
  }
  return { rows: [...byPid.values()], own };
}

function takeSnapshot() {
  return process.platform === "win32" ? snapshotWindows() : snapshotPosix();
}

// 판정에서 빼는 pid — 이 도구 자신, 도구가 띄운 스냅샷 명령, 도구를 띄운 조상 사슬
// (검사를 부른 셸 포장지는 시나리오의 생존자가 아니다).
function excludedPids(rows, own) {
  const excluded = new Set(own);
  excluded.add(process.pid);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const seen = new Set();
  let pid = process.pid;
  while (pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    const row = byPid.get(pid);
    if (!row) break;
    excluded.add(row.ppid);
    pid = row.ppid;
  }
  return excluded;
}

function runBefore() {
  const { rows } = takeSnapshot();
  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(rows, null, 1)}\n`);
  console.log(`스냅샷 ${rows.length}개를 적었다 — ${SNAPSHOT_PATH}`);
}

function runAfter() {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.error(`이전 스냅샷이 없습니다 — ${SNAPSHOT_PATH}`);
    console.error("먼저 'node scripts/orphan-check.mjs before' 를 실행하세요.");
    return 2;
  }
  let beforeRows;
  try {
    beforeRows = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    if (!Array.isArray(beforeRows)) throw new Error("스냅샷이 목록이 아니다");
  } catch {
    console.error(
      `이전 스냅샷(${SNAPSHOT_PATH})을 읽지 못했다 — 파일을 지우고 before 를 다시 돌리세요.`,
    );
    return 2;
  }
  const { rows, own } = takeSnapshot();
  const excluded = excludedPids(rows, own);
  const beforePids = new Set(beforeRows.map((row) => Number(row?.pid)).filter(Number.isFinite));
  const orphans = rows.filter(
    (row) => !excluded.has(row.pid) && !beforePids.has(row.pid) && WATCH_NAMES.has(row.name),
  );
  if (orphans.length === 0) {
    console.log("통과 — 남은 프로세스 없음");
    return 0;
  }
  console.log("pid      ppid     name         command");
  for (const row of orphans) {
    console.log(
      String(row.pid).padEnd(8) + String(row.ppid).padEnd(8) + row.name.padEnd(12) + row.command,
    );
  }
  console.log(`실패 — 남은 프로세스 ${orphans.length}개`);
  return 1;
}

const command = process.argv[2];
if (process.argv.length !== 3 || (command !== "before" && command !== "after")) {
  console.error(USAGE);
  process.exitCode = 2;
} else if (command === "before") {
  runBefore();
} else {
  process.exitCode = runAfter();
}
