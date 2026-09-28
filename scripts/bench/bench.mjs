#!/usr/bin/env node
/**
 * 재생 벤치(PLAN-HARNESS §3.A) — 데몬에 WebSocket 으로 붙는 Node 스크립트.
 * 새 의존성 없음(Node 22 의 전역 WebSocket · node:child_process 만).
 *
 *   node scripts/bench/bench.mjs run \
 *     --endpoint /tmp/colo-bench.json   # 또는 --url ws://127.0.0.1:7823/?token=…
 *     --project colo-beta-fixture \
 *     --scenarios scripts/bench/scenarios/fixture.json \
 *     [--provider omp --model devin/swe-2 --effort high] \
 *     [--label before] [--only search,form] [--repeat 3] [--yes]
 *
 *   node scripts/bench/bench.mjs compare bench-results/…-before.json bench-results/…-after.json
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { connect } from "./client.mjs";
import {
  collectRows,
  compareResults,
  judge,
  loadScenarios,
  pinHints,
  pinsOf,
  pinTurnText,
  renderCompareTable,
  renderSummaryTable,
  statsFiles,
  turnProgress,
} from "./lib.mjs";

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROJECTS_DIR =
  process.env.COLO_DESIGN_PROJECTS_DIR ?? join(homedir(), ".colo-design", "projects");
const LOG_DIR = process.env.COLO_DESIGN_LOG_DIR ?? join(homedir(), ".colo-design", "logs");
const RESULTS_DIR = join(process.cwd(), "bench-results");
const FIXTURE_PROJECT = "colo-beta-fixture";
const POLL_MS = 2_000;
const TURN_TIMEOUT_MS = 15 * 60_000;
const AUTOSAVE_MS = 20_000;

const USAGE = `재생 벤치 — 데몬에 붙어 시나리오를 돌리고 결과를 파일로 남긴다.

쓰는 법:
  node scripts/bench/bench.mjs run --endpoint <파일> --project <slug> --scenarios <파일> [선택]
  node scripts/bench/bench.mjs compare <결과 A> <결과 B>

run 의 인자:
  --endpoint <파일>    dev:desktop 이 적어 둔 접속 파일 (COLO_DESIGN_BENCH_ENDPOINT)
  --url <ws 주소>      endpoint 대신 직접 겨누기 (pnpm dev:daemon 의 client url)
  --project <slug>     프로젝트 — 필수
  --scenarios <파일>   시나리오 JSON — 필수
  --provider <이름>    session.create 의 provider (없으면 데몬 기본값)
  --model <이름>       session.create 의 model
  --effort <수준>      session.create 의 effort
  --label <이름>       결과 파일 이름의 꼬리표 (기본 "run")
  --only <id,id>       이 id 의 시나리오만 돌린다
  --repeat <N>         시나리오마다 N번 돌린다 (기본 1)
  --yes                안전 확인을 건너뛴다
`;

function parseArgs(argv) {
  const args = {};
  let command = argv[0];
  if (command === "--help" || command === "-h") {
    args.help = true;
    command = undefined;
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes") {
      args.yes = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg?.startsWith("--")) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`인자 ${arg} 에 값이 없습니다`);
      args[arg.slice(2)] = value;
      continue;
    }
    if (args.positional === undefined) args.positional = [];
    args.positional.push(arg);
  }
  return { command, args };
}

/** git 의 읽기 명령 — 클론에서만 돌린다. */
async function git(repo, args) {
  const { stdout } = await execFileP("git", args, { cwd: repo });
  return stdout.trimEnd();
}

/** HEAD 와 바뀐 파일 목록 — diff 와 미추적 상태를 합친다. */
async function changedFiles(repo, startSha) {
  const [diff, status] = await Promise.all([
    git(repo, ["diff", "--name-only", `${startSha}..HEAD`]),
    git(repo, ["status", "--porcelain"]),
  ]);
  const names = new Set();
  for (const line of diff.split("\n")) {
    if (line.trim()) names.add(line.trim());
  }
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    // "XY path" 또는 "XY a -> b" — 둘째 인자가 바뀐 쪽이다.
    const path = line.slice(3).split(" -> ").pop().trim();
    names.add(path);
  }
  return [...names];
}

/** 결과 파일 이름 — `bench-results/<YYYYMMDD-HHmm>-<label>.json`. */
function resultPath(label, now = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
  return join(RESULTS_DIR, `${stamp}-${label}.json`);
}

/** 시나리오 하나 — 클론 경로는 읽고 쓰지 않는다. */
async function runScenario({ client, scenario, repo, logDir, meta }) {
  const entry = {
    id: scenario.id,
    pass: false,
    reasons: [],
    startSha: null,
    turns: [],
    gate: null,
    changed: [],
  };
  try {
    entry.startSha = await git(repo, ["rev-parse", "HEAD"]);
  } catch (error) {
    entry.reasons.push(`클론의 HEAD 를 읽지 못했습니다 — ${error.message}`);
    return entry;
  }

  const created = await client.request({
    type: "session.create",
    ...(meta.provider ? { provider: meta.provider } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.effort ? { effort: meta.effort } : {}),
    title: `벤치 · ${scenario.id}`,
  });
  const sessionId = created.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") {
    entry.reasons.push("세션 id 를 받지 못했습니다");
    return entry;
  }

  try {
    const text = scenario.kind === "pin" ? pinTurnText(scenario) : scenario.text.trim();
    await client.request({
      type: "session.send",
      sessionId,
      text,
      ...(scenario.kind === "pin" ? { pins: pinsOf(scenario), pinHints: pinHints(scenario) } : {}),
    });

    // 끝 판정 — 통계 파일을 읽어 이 세션의 행이 모이는지 본다.
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let files = statsFiles(logDir);
    while (true) {
      const rows = collectRows(files, sessionId);
      const progress = turnProgress(rows);
      entry.turns = rows.filter((row) => row.kind !== "gateset");
      const lastGate = rows.filter((row) => row.kind === "gateset").at(-1) ?? null;
      entry.gate = lastGate;
      if (progress.done) break;
      if (Date.now() > deadline) {
        entry.timeout = true;
        entry.reasons.push(`15분 안에 끝나지 않았습니다(기다리는 중: ${progress.waiting})`);
        return entry;
      }
      await sleep(POLL_MS);
      files = statsFiles(logDir);
    }

    // 자동 보관이 지나가기를 기다린다 — HEAD 가 움직이거나 20초.
    const autosaveDeadline = Date.now() + AUTOSAVE_MS;
    while (Date.now() < autosaveDeadline) {
      const head = await git(repo, ["rev-parse", "HEAD"]).catch(() => entry.startSha);
      if (head !== entry.startSha) break;
      await sleep(1_000);
    }

    entry.changed = await changedFiles(repo, entry.startSha).catch(() => []);
    const contents = new Map();
    for (const path of entry.changed) {
      try {
        contents.set(path, readFileSync(join(repo, path), "utf8"));
      } catch {
        // 파일이 지워졌으면 없는 내용이다.
      }
    }
    const lastTurn = entry.turns.at(-1) ?? null;
    const verdict = judge(scenario, entry.changed, contents, lastTurn);
    entry.pass = verdict.pass;
    entry.reasons = verdict.reasons;
  } catch (error) {
    entry.reasons.push(error instanceof Error ? error.message : String(error));
  } finally {
    // 세션은 지우지 않고 닫는다 — 대화록은 남는다.
    await client.request({ type: "session.close", sessionId }).catch(() => undefined);
  }
  return entry;
}

async function commandRun(args) {
  const url = args.url ?? readEndpoint(args.endpoint);
  if (!url) throw new Error("--endpoint <파일> 또는 --url <주소> 가 필요합니다");
  if (!args.project) throw new Error("--project <slug> 가 필요합니다");
  if (!args.scenarios) throw new Error("--scenarios <파일> 이 필요합니다");

  const scenarios = loadScenarios(args.scenarios);
  const only = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;
  const chosen = scenarios.filter((s) => !only || only.has(s.id));
  if (chosen.length === 0) {
    throw new Error("--only 가 시나리오를 하나도 남기지 않았습니다");
  }
  const repeat = Math.max(1, Number.parseInt(args.repeat ?? "1", 10) || 1);

  if (args.project !== FIXTURE_PROJECT && !args.yes) {
    console.error(
      `이 프로젝트의 원격에 작업 가지가 올라갑니다 — --yes 로 진행하세요 (project: ${args.project})`,
    );
    process.exitCode = 1;
    return;
  }

  const repo = join(PROJECTS_DIR, args.project, "repo");
  const client = await connect(url);
  const off = client.onEvent(() => {}); // hello 이후의 방송은 읽기만 하고 버린다.
  try {
    await client.request({ type: "project.activate", slug: args.project });
    const startedAt = new Date();
    const entries = [];
    for (const scenario of chosen) {
      for (let i = 0; i < repeat; i++) {
        console.log(`벤치 · ${scenario.id}${repeat > 1 ? ` (${i + 1}/${repeat})` : ""}`);
        const entry = await runScenario({
          client,
          scenario,
          repo,
          logDir: LOG_DIR,
          meta: { provider: args.provider, model: args.model, effort: args.effort },
        });
        entries.push(entry);
        console.log(`  ${entry.pass ? "통과" : `실패 — ${entry.reasons.join(" · ")}`}`);
      }
    }
    mkdirSync(RESULTS_DIR, { recursive: true });
    const file = resultPath(args.label ?? "run", startedAt);
    writeFileSync(
      file,
      JSON.stringify(
        {
          label: args.label ?? "run",
          startedAt: startedAt.toISOString(),
          project: args.project,
          provider: args.provider ?? null,
          model: args.model ?? null,
          effort: args.effort ?? null,
          scenarios: entries,
        },
        null,
        2,
      ),
    );
    console.log(`\n${renderSummaryTable(entries)}\n\n결과: ${file}`);
  } finally {
    off();
    client.close();
  }
}

function readEndpoint(file) {
  if (!file) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`접속 파일이 없습니다 — ${file}`);
    throw error;
  }
  if (typeof data.url !== "string" || !data.url) {
    throw new Error(`${file} 안에 url 이 없습니다`);
  }
  return data.url;
}

async function commandCompare(args) {
  const [fileA, fileB] = args.positional ?? [];
  if (!fileA || !fileB) throw new Error("compare 에는 결과 파일 두 개가 필요합니다");
  const a = JSON.parse(readFileSync(fileA, "utf8"));
  const b = JSON.parse(readFileSync(fileB, "utf8"));
  console.log(renderCompareTable(compareResults(a, b), a.label ?? "a", b.label ?? "b"));
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (args.help || !command) {
    console.log(USAGE);
    return;
  }
  if (command === "run") await commandRun(args);
  else if (command === "compare") await commandCompare(args);
  else throw new Error(`알 수 없는 명령입니다: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
