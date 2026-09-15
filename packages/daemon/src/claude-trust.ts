import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RepoSettingsWarning } from "@colo-design/protocol";
import { currentPlatform } from "./environment.js";

/**
 * 클론과 Claude Code 사이의 세 가지 — 레포가 스스로 넓힌 권한을 사용자에게
 * 보이게 하는 경고(`repoSettingsWarning`), 데스크톱이 실어 온 런타임을 레포
 * 명령의 PATH 앞에 붙이는 일(`extraPathPrefix`), 그리고 대화형 신뢰 대화상자가
 * 없는 데몬이 클론을 신뢰로 등록하는 일(`trustWorkspace`).
 *
 * `RepoWorkspace` 에서 떼어 둔 이유: 셋 다 워크스페이스의 상태를 읽지 않고,
 * 셋 다 온보딩 쪽에서도 쓰인다. `extraPathPrefix` 가 여기 있으면
 * `server → onboarding → repo` 순환도 끊긴다.
 */

/**
 * A connected repo can ship Claude Code project settings — and with them
 * `permissions.allow` rules that pre-approve tools no card will ever ask
 * about. Loading the project tier is deliberate (it is also how the repo's
 * CLAUDE.md reaches the session), so this does not block: it makes the
 * repo's ask visible, as one header warning line. The fingerprint (repo
 * root + raw bytes) is how a client files the news as read without
 * mistaking an edited file — or another repo — for news it already saw.
 */
export function repoSettingsWarning(root: string): RepoSettingsWarning | null {
  const file = join(root, ".claude", "settings.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // Absent (the normal repo) or unreadable — nothing to report either way.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A broken file is the CLI's news, not ours.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const widening = (["permissions", "env", "hooks"] as const).filter((key) => key in parsed);
  if (widening.length === 0) return null;
  // 실사 결함: 보안 의도는 좋았지만 영어 한 줄이었다 — 이 도구를 읽는 사용자는
  // 한국어다. 무엇이 사전 승인되는지 그 자리에서 알려 준다.
  return {
    text: `이 레포가 보낸 .claude/settings.json(${widening.join(", ")})이 일부 도구를 미리 승인합니다 — 권한 카드 없이 실행될 수 있어요.`,
    fingerprint: createHash("sha256").update(root).update("\0").update(raw).digest("hex"),
  };
}

/** PATH with COLO_DESIGN_EXTRA_PATH prepended when the desktop app sets it. */
export function extraPathPrefix(
  extra: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: "win32" | "darwin" | "linux" = currentPlatform(),
): string {
  const separator = platform === "win32" ? ";" : ":";
  if (!extra || extra.trim() === "") return env.PATH ?? "";
  const parts = (env.PATH ?? "").split(separator).filter(Boolean);
  const additions = extra.split(separator).filter(Boolean);
  const merged = [...additions];
  for (const part of parts) if (!merged.includes(part)) merged.push(part);
  return merged.join(separator);
}

// ---------------------------------------------------------------------------

/**
 * Claude Code drops every `permissions.allow` entry from a project's
 * `.claude/settings.json` until that directory has been trusted, and says so
 * only on stderr. The repo's rules are what keep approval cards away from a
 * planner, so an untrusted clone silently turns the product into a stream of
 * permission prompts. The trust dialog is interactive and the daemon has no
 * terminal, so record the acceptance the same way the CLI does.
 *
 * Connecting a repo is an explicit act by the planner, so accepting on their
 * behalf grants nothing they did not ask for.
 */
export function trustWorkspace(root: string, home = homedir()): void {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? home;
  const configFile = join(configDir, ".claude.json");
  mkdirSync(configDir, { recursive: true });

  let config: { projects?: Record<string, Record<string, unknown>> } = {};
  if (existsSync(configFile)) {
    try {
      config = JSON.parse(readFileSync(configFile, "utf8"));
    } catch {
      // A corrupt config is the CLI's problem to report; overwriting it with a
      // fresh object would throw away the user's own projects.
      return;
    }
  }

  // The CLI keys projects by the resolved cwd, which on macOS turns /tmp into
  // /private/tmp. Record both spellings when they differ.
  const keys = new Set([root]);
  try {
    keys.add(realpathSync(root));
  } catch {
    // Not created yet; the literal path is the best we can do.
  }

  // biome-ignore lint/suspicious/noAssignInExpressions: 없으면 만들고 그 값을 곧 쓰는 ??= 관용구다.
  const projects = (config.projects ??= {});
  let changed = false;
  for (const key of keys) {
    // biome-ignore lint/suspicious/noAssignInExpressions: 없으면 만들고 그 값을 곧 쓰는 ??= 관용구다.
    const project = (projects[key] ??= {});
    if (project.hasTrustDialogAccepted !== true) {
      project.hasTrustDialogAccepted = true;
      changed = true;
    }
  }
  if (!changed) return;

  // The CLI rewrites this file whenever a session ends, so replace it in one
  // step rather than leaving a window where it is half written.
  const temporary = `${configFile}.colo-design-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, configFile);
}
