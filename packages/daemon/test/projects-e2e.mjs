/**
 * Projects end-to-end check, fully offline (PLAN D2).
 *
 * This is the product claim of D2, driven over the same WebSocket the browser
 * uses, against local fixture remotes:
 *
 *   - a project is one connected repo, cloned into its own folder;
 *   - switching the active project switches what every other message means —
 *     the clone, the preview, the session cwd;
 *   - the registry survives a restart.
 *
 * Cloning mechanics and publishing are what repo-e2e and publish-e2e already
 * prove; what is new here is the scoping.
 *
 * Usage: node packages/daemon/test/projects-e2e.mjs
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort, writeStubClaude } from "./fixture-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(tmpdir(), "cds-design-projects-e2e");

process.env.CDS_DESIGN_CREDENTIAL_STORE = "memory";
// Every registry path in the temp dir. This suite deliberately does NOT set
// CDS_DESIGN_REPO_DIR or CDS_DESIGN_REPO_URL: those override the ACTIVE
// project's clone, which would erase exactly the per-project separation
// under test.
process.env.CDS_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.CDS_DESIGN_PROJECTS_DIR = join(DIR, "projects");

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await predicate();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}
/**
 * Like writeStubClaude, but a real invocation answers by dropping a file
 * into the session cwd and stalling a moment — a turn whose product and
 * timing the sidebar checks can observe.
 */
function writeTurnStubClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "1.0.0-stub"; exit 0;;',
      "  auth)",
      '    echo \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"planner@example.com"}\'',
      "    exit 0;;",
      "esac",
      'touch "$PWD/스텁-산출물.txt"',
      "sleep 2",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}
async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });

  // Two repos, two ports: two projects that have nothing to do with each
  // other, which is the whole point of a project being one repo.
  const paymentsFixture = await createFixtureRepo({
    dir: join(DIR, "fixture-payments"),
    port: await freePort(),
  });
  const refundsFixture = await createFixtureRepo({
    dir: join(DIR, "fixture-refunds"),
    port: await freePort(),
  });

  const port = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port,
    token: "projects-e2e",
    // A session thread is per project; the stub keeps this offline while the
    // scoping checks below create one. This stub WRITES A FILE into the cwd
    // when a turn runs and takes a moment doing it — that is how the D14
    // check produces a count in one project while another one is on screen.
    claudeExecutable: writeTurnStubClaude(join(DIR, "bin")),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=projects-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  let nextId = 0;
  const request = async (message, timeoutMs = 60_000) => {
    const id = `m${(nextId += 1)}`;
    ws.send(JSON.stringify({ ...message, id }));
    const reply = await waitFor(() => inbox.find((m) => m.id === id), timeoutMs, message.type);
    if (reply.type === "ok") return reply.data;
    throw new Error(reply.message);
  };
  /** Same, but the refusal is the result under test. */
  const refusal = async (message) => {
    try {
      await request(message);
      return null;
    } catch (error) {
      return error.message;
    }
  };
  /** The clone the wizard just registered is brought up in the background. */
  const waitReady = async (label) => {
    const status = await waitFor(
      async () => {
        const current = await request({ type: "repo.status" });
        return current.phase === "ready" || current.phase === "error" ? current : null;
      },
      60_000,
      label,
    );
    if (status.phase !== "ready") throw new Error(`${label}: ${status.detail ?? status.phase}`);
    return status;
  };

  try {
    // --- 1. a fresh machine has no project ---------------------------------
    const empty = await request({ type: "project.list" });
    check(
      "a machine with nothing configured reports no project",
      empty.projects.length === 0 && empty.activeSlug === null,
    );
    const noProject = await refusal({ type: "repo.status" });
    check(
      "a repo message without a project refuses in Korean",
      noProject !== null && noProject.includes("프로젝트"),
      noProject ?? "(accepted)",
    );

    // --- 2. two projects, two repos -----------------------------------------
    const payments = await request({
      type: "project.create",
      name: "결제",
      repoUrl: paymentsFixture.remote,
    });
    const refunds = await request({
      type: "project.create",
      name: "환불",
      repoUrl: refundsFixture.remote,
    });
    check(
      "each project carries its own repo url",
      payments.repoUrl === paymentsFixture.remote && refunds.repoUrl === refundsFixture.remote,
      `${payments.repoUrl} | ${refunds.repoUrl}`,
    );

    // Creating the second project made it active; its clone comes up.
    const refundsStatus = await waitReady("the 환불 clone");
    check(
      "the newest project is the active one and its clone is its own folder",
      refundsStatus.root === join(DIR, "projects", refunds.slug, "repo") &&
        refundsStatus.url === refundsFixture.remote &&
        existsSync(join(DIR, "projects", refunds.slug, "repo", "cds-design.json")),
      `${refundsStatus.root}`,
    );
    check(
      "each project's clone lives only in its own folder",
      existsSync(join(DIR, "projects", payments.slug, "repo", "cds-design.json")) &&
        join(DIR, "projects", payments.slug, "repo") !==
          join(DIR, "projects", refunds.slug, "repo"),
      `${payments.slug} | ${refunds.slug}`,
    );

    // --- 3. the active project is what every other message means ------------
    const previewPort = refundsStatus.previewUrl ? new URL(refundsStatus.previewUrl).port : null;
    await request({ type: "project.activate", slug: payments.slug });
    const paymentsStatus = await waitReady("the 결제 clone after the switch");
    check(
      "switching the project switches the clone under the same message",
      paymentsStatus.root === join(DIR, "projects", payments.slug, "repo") &&
        paymentsStatus.url === paymentsFixture.remote,
      `${paymentsStatus.root}`,
    );
    check(
      "the two projects never share one preview port",
      previewPort === null ||
        paymentsStatus.previewUrl === null ||
        new URL(paymentsStatus.previewUrl).port !== previewPort,
      `${previewPort} vs ${paymentsStatus.previewUrl}`,
    );
    const announced = inbox.filter((m) => m.type === "project.changed").at(-1);
    check(
      "every open client is told the active project moved",
      announced?.activeSlug === payments.slug,
      announced?.activeSlug ?? "(no broadcast)",
    );

    // A thread opened in 결제 belongs to 결제: listing 환불's threads must
    // not carry it over, and sending into it from the wrong project is
    // refused instead of writing into the other clone.
    const { sessionId } = await request({ type: "session.create" });
    await request({ type: "project.activate", slug: refunds.slug });
    await waitReady("the 환불 clone after the session check");
    const otherList = await request({ type: "session.list" });
    check(
      "another project's live thread is not in this project's list",
      !otherList.some((entry) => entry.sessionId === sessionId),
      `결제 session ${sessionId} leaked into 환불`,
    );
    const crossTurn = await refusal({ type: "session.send", sessionId, text: "엉뚱한 프로젝트에서 보낸 턴" });
    check(
      "a turn aimed across projects refuses in Korean",
      crossTurn !== null && crossTurn.includes("다른 프로젝트"),
      crossTurn ?? "(accepted)",
    );
    await request({ type: "project.activate", slug: payments.slug });
    const ownList = await request({ type: "session.list" });
    check(
      "back in its own project the thread is listed again",
      ownList.some((entry) => entry.sessionId === sessionId),
      `결제 list: ${ownList.map((entry) => entry.sessionId).join(",")}`,
    );

    // --- 3.5 a turn finishing OFF-SCREEN counts its OWN project (D14) -------
    // The 결제 thread runs; the planner moves to 환불 mid-turn. The stub
    // drops a file into 결제's clone, and when the turn ends the recount
    // must land on 결제's row of `project.changed` — not on the active one.
    await request({ type: "project.activate", slug: payments.slug });
    await waitReady("the 결제 clone for the off-screen turn");
    const turnPromise = request({
      type: "session.send",
      sessionId,
      text: "스텁이 파일 하나를 남기는 턴",
    }).catch(() => undefined);
    await request({ type: "project.activate", slug: refunds.slug });
    const offscreenChanged = await waitFor(
      () => {
        const changed = inbox.filter((m) => m.type === "project.changed").at(-1);
        const paymentsRow = changed?.projects?.find((p) => p.slug === payments.slug);
        return changed?.activeSlug === refunds.slug &&
          paymentsRow?.pendingChanges > 0 &&
          paymentsRow?.working === false
          ? paymentsRow
          : null;
      },
      30_000,
      "the off-screen project's count",
    );
    check(
      "a turn finishing off-screen counts its own project, not the active one",
      offscreenChanged?.pendingChanges > 0,
      `결제 pendingChanges=${offscreenChanged?.pendingChanges}`,
    );
    await turnPromise;

    // --- 3.6 a removal closes the clone's live threads (D21) ----------------
    const refundSession = await request({ type: "session.create" });
    const closedEvents = [];
    const onStateMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "session.state" && message.sessionId === refundSession.sessionId) {
        closedEvents.push(message.state);
      }
    };
    ws.on("message", onStateMessage);
    const removeReply = await request({
      type: "project.remove",
      slug: refunds.slug,
      deleteFiles: true,
    });
    ws.off("message", onStateMessage);
    check(
      "removing a project closes its live thread",
      closedEvents.includes("closed"),
      `states: ${closedEvents.join(",") || "(none)"}`,
    );
    check(
      "removing with deleteFiles takes the folder",
      !existsSync(join(DIR, "projects", refunds.slug)) &&
        removeReply.projects.every((p) => p.slug !== refunds.slug),
    );
    // The survivor is what everything means again.
    check(
      "the surviving project is the active one after a removal",
      removeReply.activeSlug === payments.slug,
      `${removeReply.activeSlug}`,
    );

    // --- 3.7 overlapping switches serialize; the last request wins (D34) ----
    // 환불 is gone, so the duel is 결제 against the emptied registry: create
    // a fresh second project and fire two activations without awaiting.
    const third = await request({
      type: "project.create",
      name: "정산",
      repoUrl: refundsFixture.remote,
    });
    await new Promise((resolve) => {
      ws.send(JSON.stringify({ type: "project.activate", slug: payments.slug, id: "d34a" }));
      ws.send(JSON.stringify({ type: "project.activate", slug: third.slug, id: "d34b" }));
      const settle = () => {
        if (inbox.find((m) => m.id === "d34a") && inbox.find((m) => m.id === "d34b")) resolve();
        else setTimeout(settle, 100);
      };
      setTimeout(settle, 100);
    });
    const afterRace = await request({ type: "project.list" });
    check(
      "overlapping activations settle on the last request",
      afterRace.activeSlug === third.slug,
      `${afterRace.activeSlug}`,
    );

    // --- 4. the registry survives a restart ---------------------------------
    await server.stop();
    ws.close();
    const restartPort = await freePort();
    const restarted = new DaemonServer({ host: "127.0.0.1", port: restartPort, token: "projects-e2e" });
    await restarted.start();
    const ws2 = new WebSocket(`ws://127.0.0.1:${restartPort}?token=projects-e2e`);
    const inbox2 = [];
    ws2.on("message", (raw) => inbox2.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => {
      ws2.once("open", resolve);
      ws2.once("error", reject);
    });
    const hello = await waitFor(() => inbox2.find((m) => m.type === "hello"), 20_000, "hello");
    check(
      "a restart reports the surviving projects and remembers which one was active",
      hello.status.projects.length === 2 &&
        hello.status.activeProject === third.slug &&
        !hello.status.projects.some((p) => p.slug === refunds.slug),
      `${hello.status.projects.map((p) => p.name).join("·")} → ${hello.status.activeProject}`,
    );
    // D18: the sidebar's numbers exist before anyone clicks — the off-screen
    // turn's file in 결제 is counted by the start sweep, not by the first UI.
    const paymentsAfterRestart = hello.status.projects.find((p) => p.slug === payments.slug);
    check(
      "a restart restores every project's unsaved-change count",
      paymentsAfterRestart?.pendingChanges > 0,
      `결제 pendingChanges=${paymentsAfterRestart?.pendingChanges}`,
    );
    ws2.close();
    await restarted.stop();
  } finally {
    try {
      await server.stop();
    } catch {
      // Already stopped by the restart step; the second stop is the cleanup.
    }
    rmSync(DIR, { recursive: true, force: true });
  }

  const failed = results.filter((entry) => !entry.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`Failed: ${failed.map((entry) => entry.name).join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
