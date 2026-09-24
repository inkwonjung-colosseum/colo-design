import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeDriver } from "../dist/agent/drivers/claude/driver.js";
import {
  AgentInstall,
  classifyInstallFailure,
  codexAssetFor,
  meaningfulInstallLine,
  verifyDigest,
} from "../dist/agent-install.js";

/** 실제 설치 스크립트처럼 한 청크가 한 줄로 흐르는 시험용 설치 명령. */
function emitSteps(): string {
  const lines = [
    "\\033[1mSetting up Claude Code...\\033[0m",
    "Installing Claude Code native build latest...",
    "~/.local/bin is not in your PATH",
    'export PATH="$HOME/.local/bin:$PATH"',
    "Installing Claude Code native build latest...",
    "✔ Claude Code successfully installed!",
  ];
  return lines.map((line) => `printf '${line}\\n'`).join("; sleep 0.05; ");
}

/** 설치 한 바퀴를 기다린다 — 진행 줄은 순서 그대로 모은다. */
function runInstall(
  deps: ConstructorParameters<typeof AgentInstall>[0],
  kind: "install-claude" | "install-codex" = "install-claude",
): Promise<{
  started: boolean;
  guidance: string;
  ok: boolean;
  detail: string;
  lines: string[];
  executable: string | null | undefined;
}> {
  const { promise, resolve } = Promise.withResolvers<{
    ok: boolean;
    detail: string;
    lines: string[];
    executable: string | null | undefined;
  }>();
  const lines: string[] = [];
  const installer = new AgentInstall(deps);
  const started = installer.start(kind, {
    onProgress: (line) => lines.push(line),
    onDone: (ok, detail, executable) => resolve({ ok, detail, lines, executable }),
  });
  if (!started.started) resolve({ ok: false, detail: started.guidance, lines, executable: null });
  return promise.then((result) => ({ ...started, ...result }));
}

// ---------------------------------------------------------------------------
// 실패 분류 — 네 가지 이유의 표본 (mac · Windows 문장 섞어서)
// ---------------------------------------------------------------------------

test("실패 분류: 네트워크 — mac curl 문장과 Windows PowerShell 문장", () => {
  const mac = classifyInstallFailure("curl: (6) Could not resolve host: claude.ai\n", 6, "darwin");
  assert.equal(mac.reason, "network");
  assert.equal(mac.detail, "인터넷 연결을 확인한 뒤 다시 시도해 주세요.");
  const win = classifyInstallFailure(
    "irm : The remote name could not be resolved 'claude.ai'",
    1,
    "win32",
  );
  assert.equal(win.reason, "network");
  // 문장 없이 curl 의 종료 코드만으로도 분류된다(7 = 연결 실패).
  const bare = classifyInstallFailure("", 7, "darwin");
  assert.equal(bare.reason, "network");
});

test("실패 분류: 회사 PC 정책 — 안내 문장과 복사용 한 줄이 함께", () => {
  const ps = classifyInstallFailure(
    "install.ps1 cannot be loaded because running scripts is disabled on this system.",
    1,
    "win32",
  );
  assert.equal(ps.reason, "policy");
  assert.ok(ps.detail.includes("IT 담당자에게 보내 주세요"));
  assert.ok(ps.detail.includes("Colo Design 이 Claude Code 를 사용자 폴더에"));
  const denied = classifyInstallFailure(
    "cp: /Users/x/.local/bin/claude: Access is denied",
    1,
    "darwin",
  );
  assert.equal(denied.reason, "policy");
  const forbidden = classifyInstallFailure("HTTP 403 Forbidden", 1, "win32");
  assert.equal(forbidden.reason, "policy");
});

test("실패 분류: 디스크 공간", () => {
  const mac = classifyInstallFailure("cp: write error: No space left on device", 1, "darwin");
  assert.equal(mac.reason, "disk");
  const win = classifyInstallFailure(
    "Expand-Archive : There is not enough space on the disk.",
    1,
    "win32",
  );
  assert.equal(win.reason, "disk");
});

test("실패 분류: 그 밖의 실패 — 마지막 의미 있는 줄이 딸린다", () => {
  const withLine = classifyInstallFailure(
    "stdbuf failed\nclaude-installer: unknown flag --x",
    2,
    "darwin",
  );
  assert.equal(withLine.reason, "other");
  assert.ok(withLine.detail.includes("claude-installer: unknown flag --x"));
  const bare = classifyInstallFailure("", 1, "win32");
  assert.equal(bare.reason, "other");
  assert.equal(bare.detail, "설치가 실패했어요 — 다시 시도해 주세요.");
});

// ---------------------------------------------------------------------------
// 진행 줄 다듬기
// ---------------------------------------------------------------------------

test("진행 줄: ANSI 색 코드를 지우고 마지막 의미 있는 줄을 내놓는다", () => {
  const colored = "\u001b[1mSetting up Claude Code...\u001b[0m";
  assert.equal(meaningfulInstallLine(colored), "Setting up Claude Code...");
});

test("진행 줄: PATH 안내 문단을 버린다 — 머리 줄 `⚠ Setup notes:` 부터", () => {
  const output = [
    "Installing Claude Code native build latest...",
    "⚠ Setup notes:",
    "~/.local/bin is not in your PATH",
    "You should update your shell config to include it",
    'export PATH="$HOME/.local/bin:$PATH"',
    "✔ Claude Code successfully installed!",
    "",
  ].join("\n");
  assert.equal(meaningfulInstallLine(output), "✔ Claude Code successfully installed!");
});

test("진행 줄: 미완의 마지막 줄은 완결된 것만 본다", () => {
  assert.equal(meaningfulInstallLine("first line\npartial wi", false), "first line");
  assert.equal(meaningfulInstallLine("first line\npartial wi", true), "partial wi");
});

test("진행 방송: ANSI 제거 · PATH 문단 버림 · 같은 줄 반복 억제가 한 자리에서", async () => {
  // 줄마다 끊어 출력 — 실제 설치 스크립트처럼 한 청크가 한 줄이다. 간격 0 을
  // 주어 스로틀을 끄고 거름·억제만 본다(스로틀은 아래 테스트의 몫).
  const result = await runInstall({
    env: { ...process.env, COLO_DESIGN_CLAUDE_INSTALL_CMD: emitSteps() },
    resolveClaude: async () => "/usr/local/bin/claude",
    progressIntervalMs: 0,
  });
  assert.deepEqual(result.lines, [
    "Setting up Claude Code...",
    "Installing Claude Code native build latest...",
    "✔ Claude Code successfully installed!",
  ]);
  assert.equal(result.ok, true);
});

test("진행 방송: 기본 간격(1초)에서는 1초에 한 번 이하 — 끝의 flush 가 마지막 줄을 내보낸다", async () => {
  const result = await runInstall({
    env: { ...process.env, COLO_DESIGN_CLAUDE_INSTALL_CMD: emitSteps() },
    resolveClaude: async () => "/usr/local/bin/claude",
  });
  // 6 줄이 0.05 초 간격으로 흐르면 즉시 나가는 것은 첫 줄뿐이고, 나머지는
  // 스로틀에 붙들렸다가 끝(finish 의 flush)에서 마지막 것만 나간다.
  assert.deepEqual(result.lines, [
    "Setting up Claude Code...",
    "✔ Claude Code successfully installed!",
  ]);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Codex 자산 선택 · digest 검증
// ---------------------------------------------------------------------------

const RELEASE_ASSETS = [
  {
    name: "codex-aarch64-apple-darwin.tar.gz",
    browser_download_url: "https://x/1",
    digest: "sha256:11",
    size: 95,
  },
  {
    name: "codex-x86_64-apple-darwin.tar.gz",
    browser_download_url: "https://x/2",
    digest: "sha256:22",
    size: 96,
  },
  {
    name: "codex-x86_64-pc-windows-msvc.exe.zip",
    browser_download_url: "https://x/3",
    digest: "sha256:33",
    size: 97,
  },
  {
    name: "codex-aarch64-pc-windows-msvc.exe.zip",
    browser_download_url: "https://x/4",
    digest: "sha256:44",
    size: 98,
  },
];

test("자산 선택: 플랫폼/칩 조합이 자산 이름을 고른다 — linux/x64 는 없다", () => {
  assert.equal(
    codexAssetFor("darwin", "arm64", RELEASE_ASSETS)?.name,
    "codex-aarch64-apple-darwin.tar.gz",
  );
  assert.equal(
    codexAssetFor("darwin", "x64", RELEASE_ASSETS)?.name,
    "codex-x86_64-apple-darwin.tar.gz",
  );
  assert.equal(
    codexAssetFor("win32", "x64", RELEASE_ASSETS)?.name,
    "codex-x86_64-pc-windows-msvc.exe.zip",
  );
  assert.equal(
    codexAssetFor("win32", "arm64", RELEASE_ASSETS)?.name,
    "codex-aarch64-pc-windows-msvc.exe.zip",
  );
  assert.equal(codexAssetFor("linux", "x64", RELEASE_ASSETS), null);
});

test("digest 검증: sha256 접두사를 떼고 비교, 없으면 거짓", () => {
  const hex = createHash("sha256").update("codex").digest("hex");
  assert.equal(verifyDigest(`sha256:${hex}`, hex), true);
  assert.equal(verifyDigest(`sha256:${"0".repeat(64)}`, hex), false);
  assert.equal(verifyDigest(undefined, hex), false);
});

// ---------------------------------------------------------------------------
// 성공 판정 — 종료 코드와 실행 파일의 실존이 함께 판정한다
// ---------------------------------------------------------------------------

test("성공 판정: exit 0 + 실행 파일 있음 → ok", async () => {
  const result = await runInstall({
    env: { ...process.env, COLO_DESIGN_CLAUDE_INSTALL_CMD: "exit 0" },
    resolveClaude: async () => "/opt/homebrew/bin/claude",
  });
  assert.equal(result.ok, true);
  assert.equal(result.detail, "Claude Code 설치가 완료되었습니다.");
});

test("성공 판정: exit 0 인데 실행 파일이 없으면 실패 문장", async () => {
  const result = await runInstall({
    env: { ...process.env, COLO_DESIGN_CLAUDE_INSTALL_CMD: "exit 0" },
    resolveClaude: async () => null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, "설치가 끝났지만 실행 파일을 찾지 못했습니다 — 다시 시도해 주세요.");
});

test("성공 판정: exit 7 은 네트워크 실패로 분류된다", async () => {
  const result = await runInstall({
    env: {
      ...process.env,
      COLO_DESIGN_CLAUDE_INSTALL_CMD: "echo 'curl: (7) Failed to connect' >&2; exit 7",
    },
    resolveClaude: async () => "/opt/homebrew/bin/claude",
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, "인터넷 연결을 확인한 뒤 다시 시도해 주세요.");
});

test("시간 상한: 넘으면 자식을 끊고 실패 문장으로 끝난다", async () => {
  const result = await runInstall({
    env: { ...process.env, COLO_DESIGN_CLAUDE_INSTALL_CMD: "sleep 5" },
    resolveClaude: async () => "/opt/homebrew/bin/claude",
    timeoutMs: 400,
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.detail,
    "설치가 너무 오래 걸려 멈췄습니다 — 네트워크를 확인하고 다시 시도해 주세요.",
  );
});

test("종류마다 하나씩: 도는 중의 두 번째 시작은 거절된다", () => {
  const installer = new AgentInstall({
    env: { ...process.env, COLO_DESIGN_CLAUDE_INSTALL_CMD: "sleep 5" },
    timeoutMs: 5_000,
  });
  const first = installer.start("install-claude", { onProgress: () => {}, onDone: () => {} });
  const second = installer.start("install-claude", { onProgress: () => {}, onDone: () => {} });
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(second.guidance, "설치가 이미 진행 중입니다 — 잠시만 기다려 주세요.");
  installer.stop();
});

test("실행 파일 자리는 주입된 해석 함수가 정한다 — 임시 폴더로", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-agent-install-test-"));
  try {
    const fake = join(dir, "claude");
    writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
    const result = await runInstall({
      env: { ...process.env, COLO_DESIGN_CLAUDE_INSTALL_CMD: "exit 0" },
      resolveClaude: async () => fake,
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("설치 성공 뒤 loginCommand 가 살아난다 — 처음엔 없음, 성공 판정의 경로가 데몬의 자리를 갈아끼운다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "colo-agent-install-test-"));
  try {
    const fake = join(dir, "claude");
    writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
    // 데몬이 시작 때 한 번 푼 자리 — 설치 전엔 비어 있다(2026-09-24 버그의 현장).
    let resolved: string | null = null;
    const driver = new ClaudeDriver(() => resolved);
    assert.equal(driver.loginCommand(), null);
    const result = await runInstall({
      env: { ...process.env, COLO_DESIGN_CLAUDE_INSTALL_CMD: "exit 0" },
      resolveClaude: async () => fake,
    });
    assert.equal(result.ok, true);
    assert.equal(result.executable, fake);
    // dispatch 의 몫: 성공 판정에 쓴 경로를 방송 전에 데몬의 자리에 심는다.
    resolved = result.executable ?? null;
    const command = driver.loginCommand();
    assert.ok(command);
    assert.equal(command.command, fake);
    assert.deepEqual(command.args, ["auth", "login"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
