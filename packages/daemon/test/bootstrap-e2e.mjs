/**
 * 연결 준비 end-to-end (PLAN D94), fully offline: `cds-design.json` 이 없는
 * 레포를 `project.create {bootstrap: true}` 로 추가하면 — 준비 턴(brief 마커)
 * 이 열리고, 스텁 Claude 가 계약을 쓰고(여기서는 유효한 JSON), 데몬의 기계
 * 검증이 통과시켜 미리보기까지 간다. 준비 커밋은 저장을 기다리는 미해결
 * 변경으로 남는다 — 첫 넘기기 PR 이 개발자의 수용 게이트다.
 *
 * Usage: node packages/daemon/test/bootstrap-e2e.mjs
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonServer } from "../dist/server.js";
import { createFixtureRepo, freePort } from "./fixture-repo.mjs";

const DIR = join(tmpdir(), "cds-design-bootstrap-e2e");

process.env.CDS_DESIGN_CREDENTIAL_STORE = "memory";
process.env.CDS_DESIGN_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.CDS_DESIGN_PROJECTS_DIR = join(DIR, "projects");
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude-config");

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") throw new Error(`check("${name}") needs a verdict`);
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await predicate();
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** 준비 턴의 스텁: brief 를 받으면 계약을 쓰고 끝난다. 포트는 env 로 받는다. */
function bootstrapStub(dir, port) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("fs");',
      'if (process.argv[2] === "--version") { console.log("1.0.0-stub"); process.exit(0); }',
      'if (process.argv[2] === "auth") {',
      '  console.log(\'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"team","email":"p@x.com"}\');',
      "  process.exit(0);",
      "}",
      'let buf = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => {',
      "  buf += chunk;",
      "  let idx;",
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);",
      '    if (line.includes(\'"type":"user"\') && line.includes("연결 준비")) {',
      '      const port = process.env.CDS_BOOTSTRAP_PORT;',
      '      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));',
      '      pkg.scripts = pkg.scripts || {};',
      '      pkg.scripts.dev = "node server.mjs";',
      '      fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));',
      '      fs.writeFileSync("cds-design.json", JSON.stringify({',
      '        install: "pnpm install", check: "pnpm run check", build: "pnpm run check",',
      '        preview: { command: "pnpm run dev", port: Number(port) },',
      "      }, null, 2));",
      "      process.stdout.write(JSON.stringify({",
      '        type: "result", subtype: "success", is_error: false,',
      '        session_id: "stub", result: "연결 준비를 마쳤습니다", num_turns: 1, duration_ms: 5,',
      "      }) + \"\\n\");",
      "      setTimeout(() => process.exit(0), 150);",
      "      return;",
      "    }",
      "  }",
      "});",
      'process.stdin.on("end", () => process.exit(0));',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const previewPort = await freePort();
  process.env.CDS_BOOTSTRAP_PORT = String(previewPort);
  const fixture = await createFixtureRepo({
    dir: join(DIR, "fixture"),
    port: previewPort,
    omitConfig: true,
  });
  check("the fixture seeds without cds-design.json", !existsSync(join(fixture.remote, "cds-design.json")));

  const port = await freePort();
  const server = new DaemonServer({
    host: "127.0.0.1",
    port,
    token: "bootstrap-e2e",
    claudeExecutable: bootstrapStub(join(DIR, "bin"), previewPort),
  });
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=bootstrap-e2e`);
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  await new Promise((ok, fail) => {
    ws.once("open", ok);
    ws.once("error", fail);
  });
  let nextId = 0;
  const request = async (message, timeoutMs = 180_000) => {
    const id = `m${(nextId += 1)}`;
    ws.send(JSON.stringify({ ...message, id }));
    const reply = await waitFor(() => inbox.find((m) => m.id === id), timeoutMs, message.type);
    if (reply.type === "ok") return reply.data;
    throw new Error(reply.message);
  };

  try {
    const briefs = [];
    await request({ type: "project.create", name: "연결 준비", repoUrl: fixture.remote, bootstrap: true });
    const status = await waitFor(
      async () => {
        const current = await request({ type: "repo.status" });
        return current.phase === "ready" || current.phase === "error" ? current : null;
      },
      180_000,
      "prepare → ready",
    );
    check(
      "the connection prepares all the way to ready",
      status.phase === "ready",
      `${status.phase} · ${status.detail ?? ""}`,
    );
    check(
      "the contract file exists in the clone",
      existsSync(join(status.root, "cds-design.json")),
    );
    check(
      "the preparation waits as unsaved changes — the first PR is the gate",
      status.pendingChanges > 0,
      String(status.pendingChanges),
    );
    check(
      "the preview serves on the prepared port",
      (status.previewUrl ?? "").includes(String(previewPort)),
      status.previewUrl ?? "(none)",
    );
    for (const m of inbox) {
      if (m.type === "session.event" && m.event.kind === "user.echo" && m.event.text.includes("연결 준비")) {
        briefs.push(m.event.text);
      }
    }
    check("the brief turn opened as 연결 준비", briefs.length === 1, `${briefs.length} brief(s)`);
  } finally {
    ws.close();
    await server.stop();
    rmSync(DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
