/**
 * 다음 턴에 보내기 (PLAN D86) 의 약속을 와이어 위에서 고정하는 스위트: 턴이
 * 도는 중에 보낸 말은 그 턴에 끼어들지 않는다.
 *
 * 이 스위트가 막는 회귀는 SDK 의 성질 그 자체다. SDK 의 입력 스트림은 대기
 * 줄이 아니다 — 거기에 쓴 사용자 메시지는 CLI 가 도는 턴 안으로(툴 라운드
 * 사이에) 접어 넣는다(sdk.d.ts 의 `user_message_uuids`: "any queued user
 * message folded into the running turn"). 그래서 데몬이 send 를 그대로
 * 밀어 넣으면 설정은 `다음 턴에 보내기` 인데 동작은 끼어들기가 된다. 대기
 * 줄은 데몬이 쥐어야 하고, 이 스위트는 스텁 CLI 의 stdin 로그로 그것을 본다:
 * 그 말은 앞 턴이 끝나기 전에는 CLI 에 도착조차 하지 않는다.
 *
 * Free: no real Claude turn. Offline end to end — daemon, SDK, stub CLI.
 *
 * Usage: node packages/daemon/test/midturn-queue-e2e.mjs
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "colo-design-midturn-queue-e2e");
const STDIN_LOG = join(DIR, "cli-stdin.log");

process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");
process.env.COLO_DESIGN_REPO_SETTINGS = join(DIR, "settings.json");
process.env.COLO_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.COLO_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.COLO_DESIGN_RUN_DIR = join(DIR, "run");
process.env.COLO_DESIGN_CREDENTIAL_STORE = "memory";
process.env.COLO_DESIGN_REPO_DIR = join(DIR, "work");

const LONG = "오래 걸리는 작업 시작해 줘";
const WAITING = "그동안 이것도 확인해 줘";

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await predicate();
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** What the CLI's stdin actually received, in arrival order. */
function stdinLog() {
  if (!existsSync(STDIN_LOG)) return [];
  return readFileSync(STDIN_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * A stub CLI that writes down every user line it is handed, with the instant
 * it arrived. The marker turn never answers on its own — it RUNS until the
 * interrupt cuts it, which is how a mid-turn send gets a running turn to land
 * in. The process stays alive after the cut, because what happens NEXT (does
 * the waiting line arrive now?) is the whole point of the suite.
 */
function loggingStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const log = ${JSON.stringify(STDIN_LOG)};`,
      'if (process.argv[2] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (process.argv[2] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\');',
      "  process.exit(0);",
      "}",
      'let buf = "";',
      'let sessionId = "stub";',
      "let busy = false;",
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "const note = (kind, text) => fs.appendFileSync(log, JSON.stringify({ kind, text, at: Date.now() }) + '\\n');",
      "const seen = () => {",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      "    let o = null; try { o = JSON.parse(line); } catch { continue; }",
      '    if (o.type === "control_request") {',
      "      const sub = String(o.request && o.request.subtype);",
      '      if (sub === "initialize" || sub === "set_permission_mode" || sub === "interrupt") {',
      '        send({ type: "control_response", response: { subtype: "success", request_id: o.request_id,',
      '          response: sub === "initialize" ? { models: [], commands: [], agents: [] } : {} } });',
      "      }",
      '      if (sub === "interrupt") {',
      "        // 실제 CLI 가 멈춘 턴을 끝내는 모양 그대로: 에러 결과 하나.",
      '        note("interrupt", "");',
      "        busy = false;",
      // 실제 CLI 의 결과 한 줄에는 SDK 가 훑는 배열들이 들어 있다. 그것이
      // 빠지면 SDK 가 질의 안에서 터지고(TypeError: reading 'map'), 이 스위트가
      // 보려는 "끝난 턴 다음의 전달" 자체가 일어나지 않는다.
      '        send({ type: "result", subtype: "error_during_execution", is_error: true,',
      '          session_id: sessionId, result: "interrupted", num_turns: 1, duration_ms: 5,',
      "          duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {},",
      "          permission_denials: [], errors: [] });",
      "      }",
      "      continue;",
      "    }",
      '    if (o.type !== "user") continue;',
      "    sessionId = o.session_id || sessionId;",
      "    const content = o.message && o.message.content;",
      '    const text = typeof content === "string" ? content : JSON.stringify(content);',
      '    note("user", text);',
      "    // 표식이 실린 턴은 스스로 끝나지 않는다 — 무언가 끊을 때까지 돈다.",
      '    if (text.includes("오래 걸리는 작업")) { busy = true; continue; }',
      "    if (busy) continue;",
      "    setTimeout(() => send({",
      '      type: "result", subtype: "success", is_error: false,',
      '      session_id: sessionId, result: "알겠습니다.", num_turns: 1, duration_ms: 10,',
      "      duration_api_ms: 0, total_cost_usd: 0, usage: {}, modelUsage: {},",
      "      permission_denials: [], errors: [],",
      "    }), 20);",
      "  }",
      "};",
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { buf += chunk; seen(); });',
      'process.stdin.on("end", () => process.exit(0));',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  process.env.COLO_DESIGN_CLAUDE_BIN = loggingStubClaude(join(DIR, "bin"));

  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });
  process.env.COLO_DESIGN_REPO_URL = fixture.remote;

  const daemonPort = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port: daemonPort,
    token: "midturn-queue",
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}?token=midturn-queue`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  let seq = 0;
  /** 재시작 검사가 데몬을 먼저 내렸는지 — 두 번 내리면 돌아오지 않는다. */
  let stopped = false;
  const request = async (type, extra = {}, timeoutMs = 60_000) => {
    const id = `m${++seq}`;
    ws.send(JSON.stringify({ id, type, ...extra }));
    const reply = await waitFor(() => inbox.find((m) => m.id === id), timeoutMs, type);
    if (reply.type !== "ok") throw new Error(`${type} failed: ${reply.message}`);
    return reply.data;
  };
  const sessionEvents = (sessionId, kind) =>
    inbox.filter(
      (m) => m.type === "session.event" && m.sessionId === sessionId && m.event.kind === kind,
    );
  /** The wait room as the daemon last announced it — oldest first. */
  const room = (sessionId) => sessionEvents(sessionId, "queued").at(-1)?.event.items ?? [];
  const roomTexts = (sessionId) => room(sessionId).map((item) => item.text);
  const arrivals = (text) =>
    stdinLog().filter((row) => row.kind === "user" && row.text.includes(text));

  try {
    const ready = await request("repo.sync");
    check("the fixture repo clones", ready.phase === "ready", ready.detail ?? "");

    const { sessionId } = await request("session.create", {});

    // --- 1. 도는 턴 하나 --------------------------------------------------
    await request("session.send", { sessionId, text: LONG });
    await waitFor(
      () => stdinLog().some((row) => row.kind === "user" && row.text.includes(LONG)),
      20_000,
      "the first turn reaching the CLI",
    );
    await waitFor(
      () =>
        inbox.some(
          (m) => m.type === "session.state" && m.sessionId === sessionId && m.state === "running",
        ),
      20_000,
      "the running state",
    );

    // --- 2. 그 턴 한가운데로 보낸 말 --------------------------------------
    await request("session.send", { sessionId, text: WAITING });

    check(
      "the waiting words stay OUT of the transcript until they go out",
      !sessionEvents(sessionId, "user.echo").some((m) => m.event.text === WAITING),
    );
    // 도는 턴은 스스로 끝나지 않으니, 이 기다림은 경합이 아니다: 이 창이
    // 지나도 CLI 의 stdin 에 그 말이 없어야 한다. 있다면 그것이 끼어들기다.
    await sleep(1500);
    const midTurn = stdinLog();
    check(
      "the running turn never receives the waiting words",
      !midTurn.some((row) => row.kind === "user" && row.text.includes(WAITING)),
      JSON.stringify(midTurn.map((row) => `${row.kind}:${row.text.slice(0, 20)}`)),
    );
    check(
      "the daemon says which send is waiting",
      roomTexts(sessionId).join("|") === WAITING,
      JSON.stringify(roomTexts(sessionId)),
    );

    check(
      "and the turn it would have interrupted is still running",
      inbox.filter((m) => m.type === "session.state" && m.sessionId === sessionId).at(-1)?.state ===
        "running",
    );

    // --- 3. 턴이 끝나면 — 그리고 그때서야 — 나간다 ------------------------
    await request("session.interrupt", { sessionId });
    const delivered = await waitFor(
      () => stdinLog().find((row) => row.kind === "user" && row.text.includes(WAITING)),
      20_000,
      "the waiting words reaching the CLI",
    );
    const cut = stdinLog().find((row) => row.kind === "interrupt");
    check(
      "the waiting words reach the CLI only after the turn ended",
      Boolean(cut) && delivered.at >= cut.at,
      `interrupt@${cut?.at} → send@${delivered.at}`,
    );
    check(
      "the transcript closed the stopped turn before the next one opened",
      sessionEvents(sessionId, "turn.end").some((m) => m.event.subtype === "interrupted"),
      JSON.stringify(sessionEvents(sessionId, "turn.end").map((m) => m.event.subtype)),
    );
    check(
      "the waiting words echo into the transcript as they go out",
      sessionEvents(sessionId, "user.echo").some((m) => m.event.text === WAITING),
    );
    await waitFor(() => room(sessionId).length === 0, 10_000, "the wait-line clearing");
    check("the wait-line empties when the words go out", true);

    const answered = await waitFor(
      () => sessionEvents(sessionId, "turn.end").find((m) => m.event.subtype === "success"),
      20_000,
      "the released turn's own answer",
    );
    check(
      "the released words run as their own turn",
      answered.event.resultText === "알겠습니다.",
      String(answered.event.resultText),
    );

    // --- 4. 대기 줄 다루기: 고쳐서 보내기, 지금 보내기 --------------------
    await waitFor(
      () =>
        inbox.filter((m) => m.type === "session.state" && m.sessionId === sessionId).at(-1)
          ?.state === "idle",
      10_000,
      "the released turn settling",
    );
    const LONG_AGAIN = "오래 걸리는 작업 다시 시작해 줘";
    const FIRST = "첫째로 기다리는 말";
    const SECOND = "둘째로 기다리는 말";
    await request("session.send", { sessionId, text: LONG_AGAIN });
    await waitFor(() => arrivals(LONG_AGAIN).length === 1, 20_000, "the second marker turn");
    await request("session.send", { sessionId, text: FIRST });
    await request("session.send", { sessionId, text: SECOND });
    check(
      "the room lists every waiting send, oldest first",
      roomTexts(sessionId).join("|") === `${FIRST}|${SECOND}`,
      JSON.stringify(roomTexts(sessionId)),
    );

    // 고쳐서 보내기: the send comes back whole, and the room forgets it.
    const secondId = room(sessionId)[1].id;
    const taken = await request("session.queue.remove", { sessionId, itemId: secondId });
    check(
      "taking a send back returns what was sent",
      taken?.text === SECOND && Array.isArray(taken.attachments),
      JSON.stringify(taken),
    );
    check(
      "and the room keeps only the other",
      roomTexts(sessionId).join("|") === FIRST,
      JSON.stringify(roomTexts(sessionId)),
    );
    const again = await request("session.queue.remove", { sessionId, itemId: secondId });
    check("a send no longer waiting has nothing to hand back", again === null, String(again));
    check(
      "nothing taken back ever reached the CLI",
      arrivals(SECOND).length === 0 && arrivals(FIRST).length === 0,
    );

    // 지금 보내기: the turn is cut, THAT send goes out alone, the rest wait.
    await request("session.send", { sessionId, text: SECOND });
    const hurriedId = room(sessionId)[1].id;
    await request("session.queue.sendNow", { sessionId, itemId: hurriedId });
    const hurried = await waitFor(() => arrivals(SECOND)[0], 20_000, "the hurried words");
    const secondCut = stdinLog().filter((row) => row.kind === "interrupt")[1];
    check(
      "지금 보내기 cuts the running turn and delivers that send after the cut",
      Boolean(secondCut) && hurried.at >= secondCut.at,
      `interrupt@${secondCut?.at} → send@${hurried.at}`,
    );
    // The room's announcements, in order: the hurried send moves to the
    // front, then leaves alone. The socket frame and the stub's log line
    // race across two processes, so the sequence is awaited, not sampled.
    const rooms = () =>
      sessionEvents(sessionId, "queued").map((m) =>
        m.event.items.map((item) => item.text).join("|"),
      );
    await waitFor(
      () =>
        rooms().includes(`${SECOND}|${FIRST}`) &&
        rooms().lastIndexOf(FIRST) > rooms().lastIndexOf(`${SECOND}|${FIRST}`),
      5_000,
      `the room going ${SECOND}|${FIRST} → ${FIRST}`,
    );
    check("the hurried send moved to the front, then left alone", true);
    // The hurried turn answers on its own (알겠습니다.), and ITS end releases
    // what kept waiting — after, never alongside. The send's arrival at the
    // stub races the turn.end frame across two processes, so the end itself
    // is awaited, not sampled.
    const secondEnd = await waitFor(
      () =>
        sessionEvents(sessionId, "turn.end").filter((m) => m.event.subtype === "success").length >=
        2,
      20_000,
      "the hurried turn's own end",
    );
    const followed = await waitFor(() => arrivals(FIRST)[0], 20_000, "the remaining send");
    check(
      "the other send follows at the next turn's end",
      followed.at >= hurried.at && secondEnd,
      `hurried@${hurried.at} → remaining@${followed.at}`,
    );
    await waitFor(() => room(sessionId).length === 0, 10_000, "the room emptying");
    check(
      "both echo into the transcript in delivery order",
      sessionEvents(sessionId, "user.echo")
        .map((m) => m.event.text)
        .filter((text) => text === FIRST || text === SECOND)
        .join("|") === `${SECOND}|${FIRST}`,
    );

    // --- 5. 지금 보내기를 두 번 눌러도 한 번만 끊는다 ---------------------
    // 두 번째 클릭이 인터럽트의 유예(5초) 안에 도착하면, 막 시작된 턴을
    // 자를 수 있다. 데몬의 멱등 가드가 그 두 번째 컷을 삼킨다.
    const DOUBLE = "두 번 눌린 말";
    await request("session.send", { sessionId, text: LONG_AGAIN });
    await waitFor(() => arrivals(LONG_AGAIN).length === 2, 20_000, "the third marker turn");
    await request("session.send", { sessionId, text: DOUBLE });
    const doubleId = room(sessionId)[0].id;
    const cutsBefore = stdinLog().filter((row) => row.kind === "interrupt").length;
    // Fired back to back, both inside the interrupt's grace.
    const first = request("session.queue.sendNow", { sessionId, itemId: doubleId });
    const second = request("session.queue.sendNow", { sessionId, itemId: doubleId });
    await Promise.all([first, second]);
    await waitFor(() => arrivals(DOUBLE).length === 1, 20_000, "the hurried words");
    await sleep(600);
    check(
      "two 지금 보내기 clicks cut the running turn exactly once",
      stdinLog().filter((row) => row.kind === "interrupt").length === cutsBefore + 1,
      `cuts ${cutsBefore} → ${stdinLog().filter((row) => row.kind === "interrupt").length}`,
    );
    check(
      "and the hurried words were delivered once",
      arrivals(DOUBLE).length === 1,
      String(arrivals(DOUBLE).length),
    );

    // --- 6. 잃은 방: 크래시가 삼킨 말이 원문으로 돌아온다 ------------------
    const LOST = "크래시가 삼킨 말";
    await waitFor(
      () =>
        inbox.filter((m) => m.type === "session.state" && m.sessionId === sessionId).at(-1)
          ?.state === "idle",
      20_000,
      "the hurried turn settling",
    );
    await request("session.send", { sessionId, text: LONG_AGAIN });
    await waitFor(() => arrivals(LONG_AGAIN).length === 3, 20_000, "the fourth marker turn");
    await request("session.send", { sessionId, text: LOST });
    check("the send waits before the crash", roomTexts(sessionId).join("|") === LOST);

    // 스텁 CLI 를 죽인다 — 데몬은 살아 있고, 질의만 죽는다.
    execFileSync("pkill", ["-9", "-f", join(DIR, "bin", "claude")], { stdio: "ignore" });
    const lostRoom = await waitFor(
      () => sessionEvents(sessionId, "queue.lost").at(-1)?.event.items,
      20_000,
      "the lost room announcement",
    );
    check(
      "a dead query turns the wait room into the lost room",
      lostRoom.length === 1 && lostRoom[0].text === LOST,
      JSON.stringify(lostRoom.map((item) => item.text)),
    );
    check("the lost row carries the moment it was lost", typeof lostRoom[0].lostAt === "number");
    check(
      "the lost words never reached the CLI",
      arrivals(LOST).length === 0,
      String(arrivals(LOST).length),
    );

    // 되살리기: the daemon hands the send back whole, from its own store.
    const restored = await request("session.queue.takeDropped", {
      sessionId,
      itemId: lostRoom[0].id,
    });
    check(
      "되살리기 hands the lost send back whole",
      restored?.text === LOST && Array.isArray(restored.attachments),
      JSON.stringify(restored),
    );
    const emptied = await request("session.history", { sessionId });
    check(
      "and the lost room empties with it",
      !emptied.some((event) => event.kind === "queue.lost" && event.items.length > 0),
    );

    // --- 7. 재시작: 데몬이 죽어도 방은 디스크에 남는다 ---------------------
    // 도는 턴 아래에 말을 하나 세워 둔 채 데몬을 내린다. 다음 데몬이 그 방을
    // 기동 청소에서 lost room 으로 되살린다 — 자동 재전송은 없다.
    const SURVIVOR = "재시작을 건너온 말";
    const revived = await request("session.create", { resume: sessionId });
    const liveId = revived.sessionId;
    await request("session.send", { sessionId: liveId, text: LONG });
    await waitFor(() => arrivals(LONG).length === 2, 20_000, "the marker turn after resume");
    await request("session.send", { sessionId: liveId, text: SURVIVOR });
    check("the survivor waits when the daemon goes down", roomTexts(liveId).join("|") === SURVIVOR);

    ws.close();
    await server.stop();
    stopped = true;

    const secondPort = await freePort();
    const second_server = new DaemonServer({
      host: "127.0.0.1",
      port: secondPort,
      token: "midturn-queue-2",
    });
    await second_server.start();
    try {
      const revivedRoom = await new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${secondPort}?token=midturn-queue-2`);
        socket.on("error", reject);
        socket.on("open", () =>
          socket.send(JSON.stringify({ id: "h1", type: "session.history", sessionId: liveId })),
        );
        socket.on("message", (raw) => {
          const reply = JSON.parse(String(raw));
          if (reply.id !== "h1") return;
          socket.close();
          reply.type === "ok" ? resolve(reply.data) : reject(new Error(reply.message));
        });
      });
      const lostAfterRestart = revivedRoom.filter((event) => event.kind === "queue.lost").at(-1);
      check(
        "a restart turns the orphaned wait room into the lost room",
        lostAfterRestart?.items.some((item) => item.text === SURVIVOR) === true,
        JSON.stringify(lostAfterRestart?.items.map((item) => item.text) ?? []),
      );
      check(
        "and the restarted daemon never delivers it behind the planner's back",
        arrivals(SURVIVOR).length === 0,
        String(arrivals(SURVIVOR).length),
      );
    } finally {
      await second_server.stop();
    }
  } catch (e) {
    check(`unexpected failure: ${e.message}`, false);
  } finally {
    // 재시작 검사가 이미 데몬을 내렸다면 두 번 내리지 않는다 — 두 번째
    // `stop()` 은 이미 닫힌 서버에서 돌아오지 않는다.
    if (!stopped) {
      ws.close();
      await server.stop();
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
