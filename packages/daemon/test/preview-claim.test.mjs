/**
 * Preview-claim probes — the pieces port autodetection and the orphan sweep
 * are built from: what a URL answers, which LISTEN ports a pid owns, the
 * process tree under a pid, and reaping claims whose owner died.
 *
 * Self-contained on purpose: it imports dist/preview-claim.js directly so a
 * broken sibling module cannot keep these pure procedures from being checked.
 *
 * Run: node --test packages/daemon/test/preview-claim.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  descendantPids,
  pidAlive,
  pidListeningPorts,
  probePreviewUrl,
  readPreviewClaim,
  sweepOrphanedPreviewClaims,
  writePreviewClaim,
} from "../dist/preview-claim.js";

function workdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** First stdout line of a child, as a promise — the "I am listening" shout. */
function firstLine(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const line = buf.split("\n")[0];
      if (line) resolve(line);
    });
    child.once("error", reject);
  });
}

/** A child process running a real http server on an ephemeral port. */
async function spawnHttpServer() {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'const s = require("node:http").createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end("<p>preview</p>"); }); s.listen(0, "127.0.0.1", () => console.log(s.address().port));',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const port = Number(await firstLine(child));
  assert.ok(Number.isInteger(port) && port > 0, "server child printed its port");
  return { child, port };
}

test("pidListeningPorts: 자식 서버가 쥔 LISTEN 포트를 찾는다", async () => {
  const { child, port } = await spawnHttpServer();
  try {
    const ports = await pidListeningPorts([child.pid]);
    assert.ok(ports.includes(port), `expected ${port} in ${JSON.stringify(ports)}`);
    assert.deepEqual(await pidListeningPorts([]), []);
  } finally {
    child.kill("SIGKILL");
  }
});

test("descendantPids: 자식과 손자를 찾고 자기 자신은 제외한다", async () => {
  // The child spawns a grandchild and shouts its pid — a two-deep tree.
  const child = spawn(
    process.execPath,
    [
      "-e",
      'const g = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" }); console.log(g.pid); setInterval(() => {}, 1 << 30);',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const grandchildPid = Number(await firstLine(child));
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
  try {
    const under = await descendantPids(child.pid);
    assert.ok(under.includes(grandchildPid), `grandchild ${grandchildPid} under ${child.pid}`);
    assert.ok(!under.includes(child.pid), "the root pid itself is not a descendant");
    const all = await descendantPids(process.pid);
    assert.ok(all.includes(child.pid));
    assert.ok(all.includes(grandchildPid));
  } finally {
    child.kill("SIGKILL");
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

test("probePreviewUrl: html 페이지는 html, 그 외의 응답은 ok, 거절은 null", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/api") {
      res.setHeader("content-type", "application/json");
      res.end("{}");
    } else {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<p>preview</p>");
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  try {
    assert.equal(await probePreviewUrl(`http://127.0.0.1:${port}/`), "html");
    assert.equal(await probePreviewUrl(`http://127.0.0.1:${port}/api`), "ok");
  } finally {
    server.close();
  }
  // 아무것도 듣지 않는 포트 — 연결 거절은 null 이다.
  const dead = createServer();
  await new Promise((ok) => dead.listen(0, "127.0.0.1", ok));
  const deadPort = dead.address().port;
  await new Promise((ok) => dead.close(ok));
  assert.equal(await probePreviewUrl(`http://127.0.0.1:${deadPort}/`), null);
});

test("sweep: 주인이 죽은 기록은 리스너를 죽이고 지우고, 산 주인의 기록은 남긴다", async () => {
  const env = { COLO_DESIGN_RUN_DIR: workdir("colo-sweep-") };
  const { child, port } = await spawnHttpServer();
  // 죽은 인스턴스 흉내 — 띄우자마자 죽여 exit 까지 거둔 pid.
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
    stdio: "ignore",
  });
  owner.kill("SIGKILL");
  await new Promise((ok) => owner.once("exit", ok));
  assert.equal(pidAlive(owner.pid), false);
  writePreviewClaim({ instancePid: owner.pid, listenerPid: child.pid, port, at: "now" }, env);
  // 산 주인(이 검사 프로세스)의 기록 — 스위프가 건드리면 안 된다.
  const keptPort = port + 1;
  const kept = { instancePid: process.pid, listenerPid: null, port: keptPort, at: "now" };
  writePreviewClaim(kept, env);

  const exited = new Promise((ok) => child.once("exit", ok));
  await sweepOrphanedPreviewClaims(env);
  await exited;

  assert.equal(pidAlive(child.pid), false);
  assert.equal(readPreviewClaim(port, env), null);
  assert.deepEqual(readPreviewClaim(keptPort, env), kept);
});

test("sweep: 기록 폴더가 없으면 아무 일도 없다", async () => {
  const env = { COLO_DESIGN_RUN_DIR: join(workdir("colo-sweep-"), "missing") };
  await sweepOrphanedPreviewClaims(env);
});
