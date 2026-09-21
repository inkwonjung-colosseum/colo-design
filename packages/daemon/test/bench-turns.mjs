/**
 * 턴 실측 벤치 (측정이 먼저, 2026-09-20): 고정 과업을 fixture 레포에 돌려
 * `turn-stats-<날짜>.jsonl` 에 진짜 턴 행을 채우고, 종류별로 묶어 보고한다.
 *
 * 무엇이 턴을 느리게 하는지는 이 스크립트가 대는 재료다 — firstEditMs(방향
 * 잡기) · waitMs(카드 대기) · scanMs(핀 강화) · sincePrevTurnMs(교정 턴) ·
 * gateset(게이트). 벤치의 통계는 이 실행의 로그 디렉터리에만 쓰인다 — 사용자의
 * 실사용 통계(~/.colo-design/logs)는 건드리지 않는다.
 *
 * 두 모드:
 *   node test/bench-turns.mjs --stub          스텁 CLI — 구독 없이 배선만 확인
 *   node test/bench-turns.mjs                 REAL — 로그인된 Claude 구독을 쓴다
 * 옵션: --repeat N(기본 3) · --tasks <file>(기본 test/bench-tasks.json)
 *
 * 과업은 bench-tasks.json 이 정한다 — 실사용 요청 샘플로 교체할 자리다.
 * 매 반복은 fresh 세션(차가운 방향 잡기)이고, 핀 과업은 fixture 에 뿌린
 * 표식(testid)을 겨눈다. gateset 행은 미리보기 창이 있는 데스크톱 경로에서만
 * 나오므로 이 벤치에는 없다 — 데스크톱 실사용 통계가 그 칸을 채운다.
 *
 * Prerequisites: pnpm --filter @colo-design/daemon build · protocol build
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { markTurn } from "../../protocol/dist/turn-marker.js";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort, pushFixtureChange } from "./fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const DIR = join(tmpdir(), "colo-design-bench-turns");
const REPORT_ROOT = join(repoRoot, ".test-logs", "bench-turns");

// ---------------------------------------------------------------------------
// CLI 인자
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const STUB = flag("stub");
const REPEAT = Math.max(1, Number(option("repeat", "3")) || 3);
const PIN_EFFORT = option("pin-effort", null);
const TASKS_FILE = option("tasks", join(here, "bench-tasks.json"));

// ---------------------------------------------------------------------------
// 과업 — 파일이 정한다
// ---------------------------------------------------------------------------
const { tasks } = JSON.parse(readFileSync(TASKS_FILE, "utf8"));

/** 핀 과업의 턴 문자열 — 마커 종류(comments)를 붙여 데몬이 후보를 얹게 한다. */
function turnText(task) {
  if (task.kind !== "comments") return task.text;
  return markTurn(
    {
      kind: "comments",
      screen: "회원 목록",
      items: [{ id: task.pin.id, label: task.pin.label, comment: task.text }],
    },
    [
      "미리보기에서 가리킨 요소 1개입니다. 아래 위치를 기준으로 고친 뒤 화면을 다시 보여 주세요.",
      "",
      `1. ${task.pin.label} — "${task.pin.label}"`,
      `   요청: ${task.text}`,
      "",
    ].join("\n"),
  );
}

/** 핀 과업의 pinHints — 후보 사냥의 재료. */
function pinHints(task) {
  if (task.kind !== "comments") return undefined;
  return [{ id: task.pin.id, testId: task.pin.testId }];
}

// ---------------------------------------------------------------------------
// 스텁 CLI — 배선 확인용. Read→Edit 도구 사건을 흉내 내 firstEditMs 가
// 살아나는지까지 본다. REAL 모드에서는 쓰지 않는다.
// ---------------------------------------------------------------------------
function writeBenchStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (args[0] === "auth") {',
      '  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "team", email: "bench@example.com" }));',
      "  process.exit(0);",
      "}",
      'let buf = "";',
      'let sessionId = "stub";',
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      'const tool = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });',
      "const seen = () => {",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      "    let o = null; try { o = JSON.parse(line); } catch { continue; }",
      '    if (o.type === "control_request") {',
      "      const sub = String(o.request && o.request.subtype);",
      "      const id = String(o.request_id);",
      '      send({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });',
      "      continue;",
      "    }",
      '    if (o.type === "user") {',
      '      sessionId = (line.match(/"session_id":"([^"]*)"/) || [])[1] || sessionId;',
      '      setTimeout(() => send(tool("t1", "Read", { file_path: "src/screens/member/MemberList.screen.tsx" })), 200);',
      '      setTimeout(() => send(tool("t2", "Edit", { file_path: "src/screens/member/MemberList.screen.tsx" })), 600);',
      "      setTimeout(() => send({",
      '        type: "result", subtype: "success", is_error: false,',
      '        session_id: sessionId, result: "완료했습니다.", num_turns: 3, duration_ms: 1200,',
      "      }), 900);",
      "    }",
      "  }",
      "};",
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { buf += chunk; seen(); });',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

// ---------------------------------------------------------------------------
// fixture — 핀 과업이 겨눌 표식을 뿌린다
// ---------------------------------------------------------------------------
const SEEDED_SCREEN = `export function MemberList({ members }) {
  return (
    <section>
      <header>회원 목록</header>
      {members.map((member) => (
        <div key={member.id} data-testid="member-row">
          <span>{member.name}</span>
          <span data-kind="status">{member.status === "active" ? "활성" : "정지"}</span>
        </div>
      ))}
    </section>
  );
}
`;

// ---------------------------------------------------------------------------
// 통계 집계
// ---------------------------------------------------------------------------
const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function readStatRows(logDir) {
  const rows = [];
  for (const name of readdirSync(logDir)) {
    if (!name.startsWith("turn-stats-") || !name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(logDir, name), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // 반쯤 적힌 줄은 없는 것으로 한다.
      }
    }
  }
  return rows;
}

function summarize(label, rows, gateRows, cards = 0) {
  const turns = rows.filter((row) => row.kind !== "gateset");
  const numbers = (pick) =>
    turns.map(pick).filter((value) => typeof value === "number" && value >= 0);
  return {
    label,
    turns: turns.length,
    errors: turns.filter((row) => row.isError).length,
    durationMs: median(numbers((row) => row.durationMs)),
    firstEditMs: median(numbers((row) => row.firstEditMs)),
    firstEditKnown: numbers((row) => row.firstEditMs).length,
    waitMs: median(numbers((row) => row.waitMs)),
    scanMs: median(numbers((row) => row.scanMs)),
    scanKnown: numbers((row) => row.scanMs).length,
    numTurns: median(numbers((row) => row.numTurns)),
    contextTokens: median(numbers((row) => row.contextTokens)),
    tools: turns.reduce(
      (sum, row) => ({
        read: sum.read + (row.tools?.read ?? 0),
        edit: sum.edit + (row.tools?.edit ?? 0),
        exec: sum.exec + (row.tools?.exec ?? 0),
        browser: sum.browser + (row.tools?.browser ?? 0),
        other: sum.other + (row.tools?.other ?? 0),
      }),
      { read: 0, edit: 0, exec: 0, browser: 0, other: 0 },
    ),
    gates: gateRows.length,
    gateMs: median(gateRows.map((row) => row.gateMs).filter((v) => typeof v === "number")),
    cards,
  };
}

function printSummary(summary) {
  const ms = (value) => (value === null ? "—" : `${Math.round(value / 100) / 10}s`);
  console.log(
    `  ${summary.label}: 턴 ${summary.turns} (오류 ${summary.errors}) · ` +
      `총 ${ms(summary.durationMs)} · 첫 편집까지 ${ms(summary.firstEditMs)} ` +
      `(알 수 있는 턴 ${summary.firstEditKnown}/${summary.turns}) · ` +
      `스캔 ${ms(summary.scanMs)} (${summary.scanKnown}/${summary.turns}) · ` +
      `카드 대기 ${ms(summary.waitMs)} · 모델 왕복 ${
        summary.numTurns === null ? "—" : summary.numTurns
      } · 읽기 ${summary.tools.read} / 편집 ${summary.tools.edit} / 실행 ${summary.tools.exec}` +
      (summary.cards > 0 ? ` · 벤치가 답한 카드 ${summary.cards}회` : "") +
      (summary.gates > 0 ? ` · 게이트 ${summary.gates}회 ${ms(summary.gateMs)}` : ""),
  );
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------
function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let hit = null;
      try {
        hit = predicate();
      } catch {
        hit = null;
      }
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs)
        return reject(new Error(`${label} 을(를) 기다리다 시간이 다 됐습니다`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function main() {
  if (!existsSync(join(here, "..", "dist", "index.js")))
    throw new Error("daemon dist 가 없습니다 — pnpm --filter @colo-design/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const logDir = join(DIR, "logs");
  mkdirSync(logDir, { recursive: true });

  // 이 실행만의 세계 — 사용자의 실사용 통계·프로젝트 목록에는 닿지 않는다.
  process.env.COLO_DESIGN_LOG_DIR = logDir;
  process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
  process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
  process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
  process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
  delete process.env.ANTHROPIC_API_KEY;
  // 2' 팔: 핀으로 여는 스레드의 첫 자세(pin-effort.ts). A/B 의 두 번째 팔.
  if (PIN_EFFORT !== null) process.env.COLO_DESIGN_PIN_EFFORT = PIN_EFFORT;

  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });
  process.env.COLO_DESIGN_REPO_URL = fixture.remote;
  // 핀 과업이 겨눌 표식 — 클론이 생기기 전에 원격에 뿌린다.
  await pushFixtureChange(fixture.seed, fixture.remote, {
    "src/screens/member/MemberList.screen.tsx": SEEDED_SCREEN,
  });

  const port = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port,
    token: "bench-turns",
    ...(STUB ? { claudeExecutable: writeBenchStubClaude(join(DIR, "bin")) } : {}),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=bench-turns`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  let seq = 0;
  const request = async (type, extra = {}, timeoutMs = 120_000) => {
    const id = `b${++seq}`;
    ws.send(JSON.stringify({ id, type, ...extra }));
    const reply = await waitFor(() => inbox.find((m) => m.id === id), timeoutMs, type);
    if (reply.type !== "ok") throw new Error(`${type} 실패: ${reply.message}`);
    return reply.data;
  };

  // 어떤 세션이 어떤 과업을 돌았는지 — 집계에서 행을 과업에 붙이는 짝.
  const ran = new Map();
  /** 세션이 받은 카드의 답 — 집계까지 살아 있어야 과업별 카드 수가 나온다. */
  const cardsOf = new Map();

  try {
    const ready = await request("repo.sync", {}, 180_000);
    if (ready.phase !== "ready") throw new Error(`fixture 가 ready 가 아니라 ${ready.phase}`);

    const turnTimeout = STUB ? 30_000 : 600_000;
    // 카드에 답하는 사람 — 제품에서는 기획자가 앉는 자리다. 질문 카드는 첫
    // 선택지로, 허가 카드는(bypass 인데 떴다면 이상 신호다) 허용으로 답하고
    // 기록한다. 답지 않으면 턴은 카드 앞에서 영원히 선다 — 첫 실측이 정확히
    // 그걸 보여 줬다(생성 턴 3개 모두 질문 카드 대기로 죽은 시간).
    const answerCards = async (sessionId, label) => {
      const answered = cardsOf.get(sessionId) ?? new Set();
      cardsOf.set(sessionId, answered);
      for (const message of inbox) {
        if (message.sessionId !== sessionId || answered.has(message.requestId)) continue;
        if (message.type === "question.request") {
          answered.add(message.requestId);
          const answers = {};
          for (const question of message.questions ?? [])
            answers[question.question] = question.options?.[0]?.label ?? "";
          console.log(`  ↩ 질문 카드에 첫 선택지로 답한다 (${label})`);
          await request("question.respond", { requestId: message.requestId, answers }, 30_000);
        } else if (message.type === "permission.request") {
          answered.add(message.requestId);
          console.log(`  ⚠ 허가 카드(${message.toolName}) — 허용으로 답는다 (${label})`);
          await request(
            "permission.respond",
            { requestId: message.requestId, decision: "allow" },
            30_000,
          );
        }
      }
    };
    const turnEndCount = (sessionId) =>
      inbox.filter(
        (m) =>
          m.type === "session.event" && m.sessionId === sessionId && m.event.kind === "turn.end",
      ).length;
    const cardsAnswered = (sessionId) => cardsOf.get(sessionId)?.size ?? 0;

    for (let repeat = 1; repeat <= REPEAT; repeat++) {
      for (const task of tasks) {
        const { sessionId } = await request("session.create", {});
        // 새 대화의 기본 자세로 맞춘다 — CLI 기동은 "default" 로 깔리고 웹의
        // post-create 가 bypassPermissions 로 채우는 자리를 벤치가 대신 채운다.
        // default 로 두면 카드가 사람을 기다려 턴마다 시간이 다 된다.
        await request("session.setPermissionMode", { sessionId, mode: "bypassPermissions" });
        ran.set(sessionId, { task: task.id, repeat });
        console.log(`▶ ${task.id} #${repeat}`);
        await request(
          "session.send",
          { sessionId, text: turnText(task), pinHints: pinHints(task) },
          60_000,
        );
        try {
          const ends = turnEndCount(sessionId);
          const deadline = Date.now() + turnTimeout;
          while (true) {
            await answerCards(sessionId, `${task.id} #${repeat}`);
            if (turnEndCount(sessionId) > ends) break;
            if (Date.now() > deadline)
              throw new Error(
                `${task.id} #${repeat} 의 turn.end 을(를) 기다리다 시간이 다 됐습니다`,
              );
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          await waitFor(
            () =>
              inbox.find(
                (m) =>
                  m.type === "session.state" && m.sessionId === sessionId && m.state === "idle",
              ),
            60_000,
            `${task.id} #${repeat} 의 idle`,
          );
        } catch (error) {
          console.log(`  ⚠ ${error.message}`);
        }
        console.log(`  ✓ 완료 — 카드 응답 ${cardsAnswered(sessionId)}회`);
      }
    }
  } finally {
    ws.close();
    await server.stop();
  }

  // ------------------------------------------------------------------ 집계
  const rows = readStatRows(logDir);
  const byTask = new Map();
  const gatesByTask = new Map();
  for (const row of rows) {
    const run = ran.get(row.sessionId);
    if (run === undefined) continue;
    if (row.kind === "gateset") {
      const list = gatesByTask.get(run.task) ?? [];
      list.push(row);
      gatesByTask.set(run.task, list);
      continue;
    }
    const list = byTask.get(run.task) ?? [];
    list.push(row);
    byTask.set(run.task, list);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = join(REPORT_ROOT, stamp);
  mkdirSync(reportDir, { recursive: true });
  const report = {
    mode: STUB ? "stub" : "real",
    repeat: REPEAT,
    pinEffort: PIN_EFFORT,
    tasksFile: TASKS_FILE,
    at: new Date().toISOString(),
    summaries: [],
  };

  console.log(
    `\n턴 실측 — ${STUB ? "스텁(배선 확인)" : "REAL"} · 반복 ${REPEAT}` +
      (PIN_EFFORT !== null ? ` · 핀 자세 ${PIN_EFFORT}` : " · 기본 자세"),
  );
  let wiringOk = true;
  for (const task of tasks) {
    const cards = [...ran]
      .filter(([, run]) => run.task === task.id)
      .reduce((n, [sessionId]) => n + (cardsOf.get(sessionId)?.size ?? 0), 0);
    const summary = summarize(
      task.id,
      byTask.get(task.id) ?? [],
      gatesByTask.get(task.id) ?? [],
      cards,
    );
    report.summaries.push(summary);
    printSummary(summary);
    if (STUB) {
      if (summary.turns === 0) wiringOk = false;
      if (summary.firstEditKnown === 0) wiringOk = false;
      if (task.kind === "comments" && (summary.scanKnown === 0 || summary.scanMs === null))
        wiringOk = false;
    }
  }
  const unknown =
    rows.length -
    [...byTask.values()].reduce((n, list) => n + list.length, 0) -
    [...gatesByTask.values()].reduce((n, list) => n + list.length, 0);
  if (unknown > 0) console.log(`  (짝 못 찾은 행 ${unknown} — 기계 턴 등)`);

  writeFileSync(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    join(reportDir, "turn-stats.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  console.log(`보고서: ${reportDir}`);
  if (STUB && !wiringOk) {
    console.log("배선 확인 실패 — 턴 행·첫 편집·스캔 시간이 하나라도 비었다.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
