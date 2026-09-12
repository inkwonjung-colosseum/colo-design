import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCredentialStore, loadRepoPat, migratePlaintextSecrets } from "./credentials.js";
import { buildStatus, CONFIG_DIR, childPath, resolveClaudeExecutable } from "./environment.js";
import { createGitHubTransport, GitHubClient } from "./github.js";
import { runOnboardingChecks } from "./onboarding.js";
import { ProjectRegistry } from "./projects.js";
import { RepoWorkspace } from "./repo.js";
import { DaemonServer } from "./server.js";

const CONFIG_FILE = join(CONFIG_DIR, "daemon.json");

interface StoredConfig {
  host: string;
  port: number;
  token: string;
}

function loadConfig(): StoredConfig {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // A second daemon on the same machine — an end-to-end suite while the user's
  // own daemon is running — needs a port of its own or it dies on bind.
  const override = Number(process.env.COLO_DESIGN_PORT);
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
    registryProbeDir: null,
  });

  // The onboarding checks are doctor's product surface (DESIGN §8, PLAN M1).
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

  const config = loadConfig();
  const server = new DaemonServer(config);
  await server.start();

  const url = `ws://${config.host}:${config.port}?token=${config.token}`;
  console.log(`colo-design daemon listening on http://${config.host}:${config.port}`);
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
