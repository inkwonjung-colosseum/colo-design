/**
 * Daemon-side credential storage (DESIGN §7): secrets live in the OS store,
 * never in settings files. The Electron desktop story moves this behind
 * safeStorage; until then macOS uses the `security` CLI (Keychain generic
 * passwords) and Windows reports a typed Korean "not yet available" — the
 * desktop build provides DPAPI. Linux falls back to a process-memory store
 * (documented limitation: secrets do not survive a daemon restart there).
 *
 * On startup the daemon migrates any plaintext secrets still sitting in the
 * settings files into the store and rewrites the files without them.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR } from "./environment.js";

const run = promisify(execFile);

export const CREDENTIAL_SERVICE = "Colo Design";
/** The credential-store item holding the machine-wide GitHub token. */
export const REPO_PAT_ITEM = "pat";

/** The per-project item an installation before the machine-wide token filed its PAT under. */
export function repoPatItem(slug: string): string {
  return `pat:${slug}`;
}

/** Thrown when the platform has no store yet (Windows before the desktop story). */
export class CredentialStoreUnavailable extends Error {
  constructor(message = "이 운영체제의 자격 증명 저장소는 desktop 버전에서 제공됩니다") {
    super(message);
    this.name = "CredentialStoreUnavailable";
  }
}

export interface CredentialStore {
  /** Stores (or replaces) a secret under the Colo Design service. */
  save(item: string, secret: string): Promise<void>;
  load(item: string): Promise<string | null>;
  delete(item: string): Promise<void>;
  readonly kind: "memory" | "keychain" | "dpapi";
}

export class MemoryCredentialStore implements CredentialStore {
  readonly kind = "memory" as const;
  private readonly secrets = new Map<string, string>();

  async save(item: string, secret: string): Promise<void> {
    this.secrets.set(item, secret);
  }

  async load(item: string): Promise<string | null> {
    return this.secrets.get(item) ?? null;
  }

  async delete(item: string): Promise<void> {
    this.secrets.delete(item);
  }
}

/** macOS Keychain generic passwords via /usr/bin/security. */
export class KeychainCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;
  private readonly security = "/usr/bin/security";

  constructor(private readonly service: string = CREDENTIAL_SERVICE) {}

  async save(item: string, secret: string): Promise<void> {
    await run(this.security, [
      "add-generic-password",
      "-s",
      this.service,
      "-a",
      item,
      "-w",
      secret,
      "-U",
    ]);
  }

  async load(item: string): Promise<string | null> {
    try {
      const { stdout } = await run(this.security, [
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        item,
        "-w",
      ]);
      // `security` quotes values with spaces and prints non-ASCII bytes as
      // hex; tokens are ASCII by construction, so quoting is the case to
      // normalize here.
      const value = stdout.trimEnd().replace(/^"(.*)"$/s, "$1");
      return value === "" ? null : value;
    } catch {
      return null; // "could not be found" and every other miss read the same
    }
  }

  async delete(item: string): Promise<void> {
    await run(this.security, ["delete-generic-password", "-s", this.service, "-a", item]);
  }
}

/** Windows: DPAPI arrives with the Electron build. */
export class DpapiCredentialStore implements CredentialStore {
  readonly kind = "dpapi" as const;

  async save(): Promise<void> {
    throw new CredentialStoreUnavailable();
  }

  async load(): Promise<string | null> {
    throw new CredentialStoreUnavailable();
  }

  async delete(): Promise<void> {
    throw new CredentialStoreUnavailable();
  }
}

/**
 * COLO_DESIGN_CREDENTIAL_STORE forces a backend (tests use memory); otherwise
 * macOS → Keychain, Windows → the DPAPI stub, everything else → memory.
 */
export function createCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const forced = env.COLO_DESIGN_CREDENTIAL_STORE;
  if (forced === "memory") return new MemoryCredentialStore();
  if (forced === "keychain") return new KeychainCredentialStore();
  if (process.platform === "darwin") return new KeychainCredentialStore();
  if (process.platform === "win32") return new DpapiCredentialStore();
  return new MemoryCredentialStore();
}

// ---------------------------------------------------------------------------
// Secret accessors: env override first (tests, headless deploys), then store
// ---------------------------------------------------------------------------

/**
 * The machine-wide GitHub token: COLO_DESIGN_REPO_PAT wins over the store. One
 * token answers for every project on this machine — the `github` onboarding
 * gate stores it, repo clones authenticate with it, and the project picker's
 * repo list is what it can see.
 */
export async function loadRepoPat(
  store: CredentialStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return env.COLO_DESIGN_REPO_PAT ?? (await safeLoad(store, REPO_PAT_ITEM));
}

/**
 * One machine-wide token replaces the per-project `pat:<slug>` items. While
 * the machine item is empty, the active project's token (else the first
 * project's) is promoted — nobody re-enters a working token because the
 * storage layout moved — and every per-project item is then deleted whether
 * or not anything was promoted, so a stale token can never quietly answer
 * for a repo it was not meant for. Returns whether anything moved.
 */
export async function migrateProjectPats(
  store: CredentialStore,
  slugs: string[],
  preferred: string | null,
): Promise<boolean> {
  const existing = await safeLoad(store, REPO_PAT_ITEM);
  let promoted: string | null = null;
  if (!existing) {
    for (const slug of [preferred, ...slugs]) {
      if (!slug) continue;
      const token = await safeLoad(store, repoPatItem(slug));
      if (!token) continue;
      promoted = token;
      break;
    }
    if (promoted) {
      try {
        await store.save(REPO_PAT_ITEM, promoted);
      } catch {
        return false; // store unavailable: leave every item as it was
      }
    }
  }
  for (const slug of [preferred, ...slugs]) {
    if (!slug) continue;
    await store.delete(repoPatItem(slug)).catch(() => undefined);
  }
  return Boolean(promoted);
}

async function safeLoad(store: CredentialStore, item: string): Promise<string | null> {
  try {
    return await store.load(item);
  } catch {
    // A platform without its store yet must not take the daemon down.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Migration: plaintext settings → store
// ---------------------------------------------------------------------------

interface PlainTextSettings {
  file: string;
  secretKey: "pat";
  item: string;
}

function plaintextTargets(env: NodeJS.ProcessEnv): PlainTextSettings[] {
  return [
    {
      // The pre-projects shape: one repo.json holding one PAT, which lands
      // under the machine-wide item. Projects file theirs under `pat:<slug>`,
      // and projects.ts reads this same file once to migrate the url.
      file: env.COLO_DESIGN_REPO_SETTINGS ?? join(CONFIG_DIR, "repo.json"),
      secretKey: "pat",
      item: REPO_PAT_ITEM,
    },
  ];
}

/**
 * Moves any plaintext secrets in the settings files into the store and
 * rewrites the files without them. A platform whose store is not available
 * yet keeps its plaintext (nothing is lost); the returned report says so.
 */
export async function migratePlaintextSecrets(
  store: CredentialStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ migrated: string[]; kept: string[] }> {
  const migrated: string[] = [];
  const kept: string[] = [];

  for (const target of plaintextTargets(env)) {
    if (!existsSync(target.file)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(target.file, "utf8")) as Record<string, unknown>;
    } catch {
      continue; // the daemon never wrote a broken settings file
    }
    const secret = parsed[target.secretKey];
    if (typeof secret !== "string" || secret === "") continue;

    try {
      await store.save(target.item, secret);
      delete parsed[target.secretKey];
      writeAtomic(target.file, `${JSON.stringify(parsed, null, 2)}\n`);
      migrated.push(target.item);
    } catch {
      kept.push(target.item); // store unavailable: leave the file as-is
    }
  }
  return { migrated, kept };
}

function writeAtomic(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.colo-design-${process.pid}`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, file);
}

/** Where the user-level npmrc lives — COLO_DESIGN_NPMRC overrides HOME (tests). */
export function npmrcPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.COLO_DESIGN_NPMRC) return env.COLO_DESIGN_NPMRC;
  const home = env.HOME ?? homedir();
  return join(home, ".npmrc");
}

/**
 * Merges registry lines into an npmrc without clobbering anything else:
 * same-key lines are replaced in place, new ones appended.
 */
export function mergeNpmrc(file: string, lines: Array<{ key: string; value: string }>): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const kept = existing
    .split("\n")
    .filter(
      (line) => line.trim() !== "" && !lines.some((entry) => line.startsWith(`${entry.key}=`)),
    );
  const merged = [...kept, ...lines.map((entry) => `${entry.key}=${entry.value}`)];
  writeAtomic(file, `${merged.join("\n")}\n`);
}
