import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCredentialStore, loadRepoPat, migratePlaintextSecrets } from "./credentials.js";
import { buildStatus, CONFIG_DIR, childPath, resolveClaudeExecutable } from "./environment.js";
import { createGitHubTransport, GitHubClient } from "./github.js";
import { createFileLogger } from "./log.js";
import { runOnboardingChecks } from "./onboarding.js";
import { ProjectRegistry } from "./projects.js";
import { RepoWorkspace } from "./repo.js";
import { DaemonServer } from "./server.js";

const CONFIG_FILE = join(CONFIG_DIR, "daemon.json");

/**
 * 데몬 자신의 버전 — package.json 을 모듈 자리(dist/)의 부모에서 읽는다
 * (repo-config.ts 의 readFileSync + JSON.parse 선례). 단독 실행이 이 값으로
 * DaemonConfig.appVersion 을 채워 브라우저 MCP 자식의 serverInfo.version 이
 * 앱 버전을 말하게 한다. 데스크톱은 app.getVersion() 을 대신 넣는다. 파일이
 * 없거나 깨졌으면 버전 없음 — 자식은 "0" 으로 산다.
 */
function daemonVersion(): string | undefined {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

interface StoredConfig {
  host: string;
  port: number;
  token: string;
}

function loadConfig(): StoredConfig {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // A second daemon on the same machine — an end-to-end suite while the user's
  // own daemon is running — needs a port of its own or it dies on bind.
  const override = Number(process.env.NOVA_DESIGN_PORT);
  if (existsSync(CONFIG_FILE)) {
    try {
      const stored = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StoredConfig;
      return override > 0 ? { ...stored, port: override } : stored;
    } catch {
      // Fall through and rewrite a fresh config.
    }
  }
  const config: StoredConfig = {
    host: "127.0.0.1",
    port: override > 0 ? override : 7823,
    token: randomBytes(24).toString("hex"),
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}

async function doctor(): Promise<number> {
  const executable = await resolveClaudeExecutable();
  const status = await buildStatus({
    executable,
    liveSessions: 0,
    pendingPermissions: 0,
    registryProbe: null,
  });

  // The onboarding checks are doctor's product surface (PLAN M1).
  const credentials = createCredentialStore();
  await migratePlaintextSecrets(credentials);

  // Read-only: doctor reports, it never migrates a layout or clones anything.
  // A machine with no project yet reports exactly that, which is the point.
  const registry = ProjectRegistry.load();
  const active = registry.active();
  const paths = active ? registry.paths(active.slug) : null;
  // The machine-wide token arms both the clone and the github gate; doctor
  // reports, so a missing token is the gate's own line, not an error.
  const pat = await loadRepoPat(credentials);
  const onboarding = await runOnboardingChecks({
    gitHubClient: pat ? () => new GitHubClient(pat, createGitHubTransport().transport) : undefined,
  });
  // The project is not a gate any more (PLAN D12[게이트 아님]): its bring-up state is what
  // a planner would see in the workspace, so doctor prints that instead.
  const project =
    active && paths
      ? await new RepoWorkspace({
          root: paths.repoRoot,
          url: active.repo.url,
          pat,
          onStatus: () => undefined,
        }).status()
      : null;
  console.log(JSON.stringify({ ...status, onboarding, project }, null, 2));
  if (status.warnings.length > 0) {
    console.error("\nProblems found:");
    for (const warning of status.warnings) console.error(`  - ${warning}`);
    return 1;
  }
  console.error("\nAll checks passed.");
  return 0;
}

/**
 * 개명(0.4.0) 뒤 개발자 셸에 남은 옛 환경 변수(`COLO_DESIGN_*`)가 조용히
 * 무시되지 않게 한다 — 값은 읽지 않고, 새 이름을 알리는 경고 한 줄만 남긴다.
 * 앱 사용자의 기계에서는 앱이 스스로 세우는 값이므로 이 경고는 뜨지 않는다.
 */
function warnLegacyEnv(env: NodeJS.ProcessEnv, warn: (line: string) => void): void {
  // read-legacy — 옛 접두로 남은 변수를 알아본다.
  const stale = Object.keys(env).filter((key) => key.startsWith("COLO_DESIGN_"));
  if (stale.length === 0) return;
  warn(`무시된 옛 환경 변수가 있습니다 — 새 이름은 NOVA_DESIGN_* 입니다: ${stale.join(", ")}`);
}

/**
 * The probe `doctor` and launchd use. A live daemon answers here — a stored
 * `daemon.json` that names a healthy endpoint is another daemon's machine,
 * not a stale file.
 */
async function daemonHealthy(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // Started from a desktop app rather than a shell, this process inherits a
  // PATH with no node on it, and every tool we drive — the Claude CLI, pnpm,
  // vite — is a script whose shebang resolves node through PATH. Widen it once
  // here so children inherit it instead of each spawn site remembering.
  process.env.PATH = childPath();

  const command = process.argv[2];

  if (command === "doctor") {
    process.exit(await doctor());
  }

  const hadStoredConfig = existsSync(CONFIG_FILE);
  const config = loadConfig();
  // 실사 결함: 고아 데몬이 쌓였다 — 두 번째 데몬은 같은 클론을 두 손으로 다룬다.
  // 저장된 주소가 살아 있으면 그 데몬의 기계이므로 여기서 물러난다. 환경 변수로
  // 포트를 정하는 e2e 스위트의 자기 데몬은 이 검사의 밖에 둔다.
  if (
    !process.env.NOVA_DESIGN_PORT &&
    hadStoredConfig &&
    (await daemonHealthy(config.host, config.port))
  ) {
    console.log(
      `nova-design daemon 이 이미 http://${config.host}:${config.port} 에서 돌고 있습니다 — 새 인스턴스를 시작하지 않습니다.`,
    );
    process.exit(0);
  }

  const logger = createFileLogger();
  warnLegacyEnv(process.env, (line) => logger.warn(line));
  process.on("uncaughtException", (error) => logger.error("미처리 예외", { err: error }));
  process.on("unhandledRejection", (reason) =>
    logger.error("미처리 거부", { err: reason instanceof Error ? reason : String(reason) }),
  );

  const server = new DaemonServer({
    ...config,
    logger,
    // 단독 실행의 버전 출처 — 데몬 package.json. 브라우저 MCP 자식의
    // serverInfo.version 이 그 값을 말한다(DaemonConfig.appVersion).
    appVersion: daemonVersion(),
    // 개발 실행(DaemonStatus.dev)은 이 변수로만 열린다 — 브라우저 개발
    // 경로(`pnpm dev:daemon`)가 켠다. 데스크톱은 자기 `app.isPackaged` 로 정한다.
    devAgents: process.env.NOVA_DESIGN_DEV_AGENTS === "1",
  });
  try {
    await server.start();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(
        `포트 ${config.port}를 다른 프로그램이 이미 써서 데몬을 시작하지 못했습니다 — ` +
          `daemon.json 이 오래된 주소를 가리키거나 다른 프로그램이 그 포트를 쓰고 있을 수 있습니다. ` +
          `그 프로그램을 끊거나 NOVA_DESIGN_PORT 로 다른 포트를 정해 시작해 주세요.`,
      );
      process.exit(1);
    }
    throw error;
  }

  const url = `ws://${config.host}:${config.port}?token=${config.token}`;
  console.log(`nova-design daemon listening on http://${config.host}:${config.port}`);
  console.log(`client url: ${url}`);
  console.log(`config: ${CONFIG_FILE}`);

  if (process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "\nWARNING: ANTHROPIC_API_KEY is set. Sessions will bill that key instead of your subscription.",
    );
  }

  const shutdown = async () => {
    console.log("\nshutting down...");
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
