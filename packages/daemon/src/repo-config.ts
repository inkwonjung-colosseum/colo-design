/**
 * 연결 레포의 계약 — 레포가 이미 말한 것에서 읽어 내고, `colo-design.json` 은
 * 그 추론이 틀린 자리만 덮는다. 락파일이 패키지 매니저와 설치 명령을,
 * `package.json` 의 scripts 가 검사 · 빌드 · 미리보기 명령을, 커밋된 `.npmrc`
 * 가 private 레지스트리를 말한다 — 넷 다 어느 레포나 이미 가지고 있으므로 파일에
 * 다시 적을 이유가 없고, 적힌 복사본은 언젠가 원본과 어긋난다.
 *
 * 파일에 남는 필수 항목은 하나다: 미리보기가 뜨는 포트. 그것만은 레포의 어느
 * 파일도 기계가 읽을 수 있게 말하지 않는다 — 개발 서버의 포트는 스크립트 인자나
 * 프레임워크 설정 안에 있고, 도구는 그 포트에 연결이 될 때까지 기다려야 한다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 레포 루트의 오버라이드 파일 — 포트와, 추론이 틀린 자리만 적는다. */
export const CONFIG_FILE = "colo-design.json";

export interface RepoRegistry {
  host: string;
  scope: string;
}

/** 데몬이 실제로 돌리는 계약 — 추론과 오버라이드를 합친 결과. */
export interface RepoConfig {
  install?: string;
  check?: string;
  build?: string;
  preview: { command: string; port: number };
  registry?: RepoRegistry;
  /** D56: `false` refuses the handoff's screen captures — no files, no PR section. */
  shots?: boolean;
}

/** `colo-design.json` 이 적을 수 있는 것 — 전부 선택이고 preview.port 만 필수다. */
export interface RepoOverrides {
  install?: string;
  check?: string;
  build?: string;
  preview?: { command?: string; port?: number };
  registry?: RepoRegistry;
  shots?: boolean;
}

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/**
 * 락파일이 패키지 매니저를 말한다. 여러 개가 있으면 앞의 것이 이긴다 — 남겨진
 * 락파일 하나로 매니저가 바뀌는 것보다 한 가지를 고집하는 편이 예측 가능하다.
 * 하나도 없으면 pnpm 으로 본다: 데스크톱 앱이 동반해 오는 것이 그것이다.
 */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

/** 매니저가 정하는 설치 명령 — `npm ci` 는 package-lock.json 이 있을 때만 맞다. */
const INSTALL: Record<PackageManager, string> = {
  pnpm: "pnpm install",
  npm: "npm ci",
  yarn: "yarn install",
  bun: "bun install",
};

/**
 * 미리보기 명령이 숨어 있는 스크립트 이름 — 앞의 것이 개발 서버에 가깝다.
 * `preview` 가 마지막인 이유는 Vite 에서 그 이름이 빌드 결과를 띄우는 명령이고,
 * 빌드 없이는 뜨지 않기 때문이다.
 */
const PREVIEW_SCRIPTS = ["dev", "start", "serve", "preview"] as const;

const PREVIEW_PORT_UNKNOWN =
  `미리보기 포트를 알 수 없습니다 — 연결 레포 루트의 ${CONFIG_FILE} 에 ` +
  '{ "preview": { "port": 5274 } } 처럼 개발 서버가 뜨는 포트를 적어야 합니다.';

const PREVIEW_COMMAND_UNKNOWN =
  "미리보기 명령을 찾지 못했습니다 — package.json 의 scripts 에 dev · start · serve · preview 중 " +
  `하나가 있어야 하거나, ${CONFIG_FILE} 의 preview.command 로 직접 적어야 합니다.`;

/**
 * JSON 이 준 값이 키를 읽어도 되는 객체인지 판정한다 — 파일에서 온 값은 무엇이든
 * 될 수 있으므로, 읽기 전에 한 번 통과시킨다. 통과한 뒤의 값은 여전히 unknown
 * 이고, 각 필드는 제 자리에서 검사한다.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 커밋된 락파일이 매니저를 말한다 — 없으면 null 이다. 락파일이 없는 레포에서는
 * 설치를 돌리지 않는다: `pnpm install` 은 락파일을 만들어 레포를 바꾸고, 기획자는
 * 자기가 만들지 않은 변경을 저장 검토에서 보게 된다.
 */
function lockedManager(root: string): PackageManager | null {
  for (const [file, manager] of LOCKFILES) {
    if (existsSync(join(root, file))) return manager;
  }
  return null;
}

/**
 * `<pm> run <script>` — 네 매니저 모두가 받는 유일한 꼴이다. `npm dev` 는 없는
 * 명령이고 `pnpm dev` 는 되지만, 한 가지 꼴로 조립하면 매니저별 예외가 없다.
 */
function runScript(manager: PackageManager, script: string): string {
  return `${manager} run ${script}`;
}

/** 레포의 package.json scripts — 없거나 깨졌으면 빈 집합. */
function readPackageScripts(root: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return {};
  }
  const manifest = asRecord(raw);
  return (manifest && asRecord(manifest.scripts)) ?? {};
}

/** 토큰이 실려 가는 곳이므로 GitHub 의 패키지 엔드포인트만 허용한다. */
function isPackageHost(host: string): boolean {
  return host === "npm.pkg.github.com" || host.endsWith(".pkg.github.com");
}

/** `https://npm.pkg.github.com/` · `//npm.pkg.github.com/` 둘 다 host 로 읽는다. */
function hostOf(value: string): string | null {
  const text = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
    ? value
    : `https://${value.replace(/^\/\//, "")}`;
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const SCOPED_REGISTRY = /^\s*(@[^\s:=]+):registry\s*=\s*(\S+)\s*$/;

/**
 * 레포가 커밋해 둔 `.npmrc` 의 `@scope:registry=` 줄이 private 레지스트리를
 * 말한다 — 토큰 없는 그 줄이 원본이고, 토큰은 기계의 사용자 npmrc 로만 간다.
 * GitHub 패키지 호스트가 아닌 줄은 건너뛴다: 이 값이 기계의 PAT 를 겨누므로
 * 레포가 임의의 서버를 가리킬 수는 없다.
 */
export function deriveRegistry(root: string): RepoRegistry | null {
  let source: string;
  try {
    source = readFileSync(join(root, ".npmrc"), "utf8");
  } catch {
    return null;
  }
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const [, scope, target] = SCOPED_REGISTRY.exec(line) ?? [];
    if (!scope || !target) continue;
    const host = hostOf(target);
    if (host === null || !isPackageHost(host)) continue;
    return { host, scope };
  }
  return null;
}

/**
 * 오버라이드 파일을 읽어 형태만 검증한다. 모든 거절은 필드 이름과 무엇이어야
 * 하는지를 한국어로 말한다: 이것을 고치는 사람은 기획자이고, "invalid config"
 * 로는 아무것도 할 수 없다. 무엇이 없는지는 여기서 판정하지 않는다 — 빈 파일도
 * 합법이고, 빠진 포트는 resolveRepoConfig 가 말한다.
 */
export function parseRepoOverrides(source: string): RepoOverrides {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${CONFIG_FILE}을 해석할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const config = asRecord(raw);
  if (!config) throw new Error(`${CONFIG_FILE}은 객체여야 합니다`);
  const overrides: RepoOverrides = {};

  for (const key of ["install", "check", "build"] as const) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${CONFIG_FILE}의 ${key}는 실행할 명령을 문자열로 적어야 합니다`);
    }
    overrides[key] = value;
  }

  if (config.preview !== undefined) {
    const preview = asRecord(config.preview);
    if (!preview) throw new Error(`${CONFIG_FILE}의 preview는 { "port" } 형태여야 합니다`);
    overrides.preview = {};
    if (preview.command !== undefined) {
      if (typeof preview.command !== "string" || preview.command.trim() === "") {
        throw new Error(`${CONFIG_FILE}의 preview.command는 실행할 명령을 문자열로 적어야 합니다`);
      }
      overrides.preview.command = preview.command;
    }
    if (preview.port !== undefined) {
      const port = preview.port;
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(
          `${CONFIG_FILE}의 preview.port가 잘못되었습니다 — 1~65535 사이의 포트 번호여야 합니다`,
        );
      }
      overrides.preview.port = port;
    }
  }

  if (config.shots !== undefined) {
    if (typeof config.shots !== "boolean") {
      throw new Error(`${CONFIG_FILE}의 shots는 true 또는 false여야 합니다`);
    }
    overrides.shots = config.shots;
  }

  if (config.registry !== undefined) {
    const registry = asRecord(config.registry);
    if (
      !registry ||
      typeof registry.host !== "string" ||
      registry.host.trim() === "" ||
      typeof registry.scope !== "string" ||
      registry.scope.trim() === ""
    ) {
      throw new Error(`${CONFIG_FILE}의 registry는 { "host", "scope" } 형태여야 합니다`);
    }
    const host = registry.host.trim().toLowerCase();
    if (!isPackageHost(host)) {
      throw new Error(
        `${CONFIG_FILE}의 registry.host는 GitHub 패키지 호스트(npm.pkg.github.com)여야 합니다`,
      );
    }
    overrides.registry = { host, scope: registry.scope };
  }

  return overrides;
}

/** 오버라이드 파일이 있으면 읽고, 없으면 빈 오버라이드. */
function readRepoOverrides(root: string): RepoOverrides {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return {};
  return parseRepoOverrides(readFileSync(file, "utf8"));
}

/**
 * 레포가 말하는 것 + 오버라이드 = 데몬이 돌릴 계약. 포트나 미리보기 명령을 끝내
 * 알 수 없으면 던진다 — 그 둘 없이는 미리보기가 뜰 수 없고, 기획자가 읽는 카드는
 * 무엇을 적어야 하는지 말해야 한다.
 */
export function resolveRepoConfig(root: string): RepoConfig {
  const overrides = readRepoOverrides(root);
  const port = overrides.preview?.port;
  if (port === undefined) throw new Error(PREVIEW_PORT_UNKNOWN);

  const locked = lockedManager(root);
  const manager = locked ?? "pnpm";
  const scripts = readPackageScripts(root);
  const declares = (name: string): boolean => typeof scripts[name] === "string";

  const script = PREVIEW_SCRIPTS.find(declares);
  const command = overrides.preview?.command ?? (script ? runScript(manager, script) : null);
  if (command === null) throw new Error(PREVIEW_COMMAND_UNKNOWN);

  const install = overrides.install ?? (locked ? INSTALL[locked] : undefined);
  const check = overrides.check ?? (declares("check") ? runScript(manager, "check") : undefined);
  const build = overrides.build ?? (declares("build") ? runScript(manager, "build") : undefined);
  const registry = overrides.registry ?? deriveRegistry(root) ?? undefined;

  return {
    ...(install !== undefined ? { install } : {}),
    ...(check !== undefined ? { check } : {}),
    ...(build !== undefined ? { build } : {}),
    ...(registry !== undefined ? { registry } : {}),
    ...(overrides.shots !== undefined ? { shots: overrides.shots } : {}),
    preview: { command, port },
  };
}

/** 파일이 선언한 미리보기 포트, 말하지 않았거나 읽을 수 없으면 null. */
export function readDeclaredPreviewPort(root: string): number | null {
  try {
    return readRepoOverrides(root).preview?.port ?? null;
  } catch {
    return null;
  }
}

/** The npm scope form with a leading @, whatever the source wrote. */
export function scopeOf(registry: RepoRegistry): string {
  return registry.scope.startsWith("@") ? registry.scope : `@${registry.scope}`;
}

/**
 * 연결 준비 (PLAN D94) 의 울타리. 준비 턴이 쓰는 것은 포트 하나다 — 명령은 레포가
 * 이미 말한 것에서 읽으므로 Claude 가 명령을 적을 자리가 없고, 적힌 파일은 한 번도
 * 실행되지 않고 거부된다. "그래도 실행" 버튼은 없다.
 */
export function validateBootstrapOverrides(source: string): string | null {
  let overrides: RepoOverrides;
  try {
    overrides = parseRepoOverrides(source);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const commands: string[] = (["install", "check", "build"] as const).filter(
    (key) => overrides[key] !== undefined,
  );
  if (overrides.preview?.command !== undefined) commands.push("preview.command");
  if (commands.length > 0) {
    return `연결 준비는 명령을 적지 않습니다 — ${commands.join(" · ")}를 지우고 preview.port 만 남겨 주세요.`;
  }
  if (overrides.registry !== undefined) {
    return "연결 준비는 registry 를 적지 않습니다 — 레포의 .npmrc 가 말합니다.";
  }
  if (overrides.preview?.port === undefined) {
    return "preview.port 가 없습니다 — 미리보기 개발 서버가 뜨는 포트를 적어야 합니다.";
  }
  return null;
}
