/**
 * End-to-end check against a running daemon.
 *
 * Exercises the whole session surface: status, session creation, streaming
 * text, a real permission round-trip, a follow-up turn that proves context
 * carried over, session listing, and teardown.
 *
 * The daemon's one workspace is a throwaway directory (`COLO_DESIGN_REPO_DIR`)
 * rather than something registered over the wire, and the project registry the
 * daemon migrates it into is thrown away with it. Without that the spawned
 * daemon would write ~/colo-design/config/projects.json on the developer's own
 * machine. Nothing is cloned there: sessions only need the directory to exist.
 *
 * Usage: node test/e2e.mjs            (starts its own daemon)
 *        node test/e2e.mjs <ws-url>   (uses an already running daemon)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@colo-design/protocol";
import { WebSocket } from "ws";
import { freePort } from "./fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const daemonEntry = join(here, "..", "dist", "index.js");
const WORK = join(tmpdir(), "colo-design-e2e");
const TARGET = join(WORK, "greeting.txt");

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function waitFor(predicate, timeoutMs, label, inbox) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = inbox.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs)
        return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  let daemon = null;
  let url = process.argv[2];

  if (!url) {
    const env = {
      ...process.env,
      COLO_DESIGN_REPO_DIR: WORK,
      COLO_DESIGN_PROJECTS_SETTINGS: join(WORK, "projects.json"),
      COLO_DESIGN_PROJECTS_DIR: join(WORK, "projects"),
      // The user's own daemon may be running right now; never fight it for 7823.
      COLO_DESIGN_PORT: String(await freePort()),
    };
    delete env.ANTHROPIC_API_KEY;
    daemon = spawn(process.execPath, [daemonEntry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
    process.on("exit", () => daemon.kill("SIGKILL"));
    url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon did not print a client url")), 20000);
      let buffered = "";
      daemon.stdout.on("data", (chunk) => {
        buffered += String(chunk);
        const match = buffered.match(/client url: (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    check("daemon starts and prints a client url", true, url.replace(/token=.*/, "token=***"));
  }

  const ws = new WebSocket(url);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  let nextId = 0;
  const call = async (payload) => {
    const id = `r${++nextId}`;
    ws.send(JSON.stringify({ id, ...payload }));
    const reply = await waitFor(
      (m) => (m.type === "ok" || m.type === "error") && m.id === id,
      60000,
      payload.type,
      inbox,
    );
    if (reply.type === "error") throw new Error(`${payload.type}: ${reply.message}`);
    return reply.data;
  };

  // 1. hello + status
  const hello = await waitFor((m) => m.type === "hello", 10000, "hello", inbox);
  check("hello carries daemon status", hello.status.protocolVersion === PROTOCOL_VERSION);
  check(
    "signed in with a subscription, not an API key",
    hello.status.loggedIn === true &&
      hello.status.apiKeyInEnv === false &&
      hello.status.authMethod === "claude.ai",
    `authMethod=${hello.status.authMethod} plan=${hello.status.subscriptionType} apiKeyInEnv=${hello.status.apiKeyInEnv}`,
  );
  // The throwaway root has no colo-design.json, so no registry is declared and
  // the CDS registry probe stays out of the picture. That is repo-e2e's
  // subject, not this one's.
  const blocking = hello.status.warnings.filter((w) => !w.includes("@colosseumcoinckr/cds"));
  check("no warnings that would stop a session", blocking.length === 0, blocking.join("; "));

  // 2. session creation — the daemon owns the cwd: the active project's clone
  const created = await call({ type: "session.create" });
  const sessionId = created.sessionId;
  check("session.create returns an id up front", /^[0-9a-f-]{36}$/.test(sessionId), sessionId);

  // 3. first turn -> expect a Bash permission request.
  //
  // The daemon answers Write/Edit itself inside the workspace (acceptEdits
  // semantics, moved in-process), so a Write would be approved silently. Bash
  // still asks, which is what makes it the honest test of the round-trip.
  await call({
    type: "session.send",
    sessionId,
    text: `Use the Bash tool to run: printf 'hello from the hub' > greeting.txt. Then stop.`,
  });

  const permission = await waitFor(
    (m) => m.type === "permission.request" && m.sessionId === sessionId,
    120000,
    "permission.request",
    inbox,
  );
  check(
    "permission request surfaces the tool and its input",
    typeof permission.toolName === "string" && permission.input !== undefined,
    `tool=${permission.toolName}`,
  );
  check(
    "state moved to waiting_permission",
    inbox.some((m) => m.type === "session.state" && m.state === "waiting_permission"),
  );
  check(
    "suggestions are offered for remember-this",
    Array.isArray(permission.suggestions),
    `${permission.suggestions.length} suggestion(s)`,
  );

  // 4. approve without echoing the input back
  await call({
    type: "permission.respond",
    requestId: permission.requestId,
    decision: "allow",
  });

  // Claude may need more than one approval to finish the task. Keep answering
  // so the turn can complete; the request shape was asserted above.
  const answered = new Set([permission.requestId]);
  const approver = setInterval(() => {
    for (const m of inbox) {
      if (m.type !== "permission.request" || answered.has(m.requestId)) continue;
      answered.add(m.requestId);
      call({
        type: "permission.respond",
        requestId: m.requestId,
        decision: "allow",
      }).catch(() => undefined);
    }
  }, 400);

  let firstTurn;
  try {
    firstTurn = await waitFor(
      (m) => m.type === "session.event" && m.event.kind === "turn.end",
      240000,
      "turn.end",
      inbox,
    );
  } finally {
    clearInterval(approver);
  }
  if (answered.size > 1) {
    console.log(`      (answered ${answered.size} approvals)`);
  }
  check("first turn completed", firstTurn.event.subtype === "success", firstTurn.event.subtype);
  check(
    "file was actually written",
    existsSync(TARGET) && readFileSync(TARGET, "utf8").includes("hello from the hub"),
    existsSync(TARGET) ? JSON.stringify(readFileSync(TARGET, "utf8")) : "missing",
  );

  const events = inbox.filter((m) => m.type === "session.event").map((m) => m.event);
  check(
    "init event reported the model and no api key source",
    events.some((e) => e.kind === "init" && e.model && e.apiKeySource === "none"),
    events.find((e) => e.kind === "init")?.model ?? "no init",
  );
  check(
    "text streamed as deltas",
    events.filter((e) => e.kind === "text.delta").length > 0,
    `${events.filter((e) => e.kind === "text.delta").length} deltas`,
  );
  check(
    "tool call start and end were both reported",
    events.some((e) => e.kind === "tool.start") && events.some((e) => e.kind === "tool.end"),
  );

  // 5. follow-up turn proves the session kept context
  const before = inbox.length;
  await call({
    type: "session.send",
    sessionId,
    text: "What was the exact name of the file you just created? Reply with only the filename.",
  });
  const approver2 = setInterval(() => {
    for (const m of inbox) {
      if (m.type !== "permission.request" || answered.has(m.requestId)) continue;
      answered.add(m.requestId);
      call({
        type: "permission.respond",
        requestId: m.requestId,
        decision: "allow",
      }).catch(() => undefined);
    }
  }, 400);
  let secondTurn;
  try {
    secondTurn = await waitFor(
      (m, i) => i >= before && m.type === "session.event" && m.event.kind === "turn.end",
      240000,
      "second turn.end",
      inbox,
    );
  } finally {
    clearInterval(approver2);
  }
  check(
    "follow-up turn kept conversation context",
    /greeting\.txt/.test(secondTurn.event.resultText ?? ""),
    JSON.stringify((secondTurn.event.resultText ?? "").slice(0, 60)),
  );

  // 6. listing merges live and on-disk sessions for the active project
  const listed = await call({ type: "session.list" });
  const mine = listed.find((s) => s.sessionId === sessionId);
  check("session.list includes the live session", Boolean(mine?.live), `state=${mine?.state}`);
  check(
    "session title derived from the first prompt",
    Boolean(mine?.title && mine.title !== "새 화면"),
  );

  // 7. teardown
  await call({ type: "session.close", sessionId });
  const status = await call({ type: "daemon.status" });
  check("session closed and daemon reports zero live sessions", status.liveSessions === 0);

  ws.close();
  if (daemon) daemon.kill("SIGTERM");

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nE2E ERROR: ${error.message}`);
  process.exit(2);
});
