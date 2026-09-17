/**
 * 연결 레포의 계약 — 레포가 이미 말한 것에서만 읽어 낸다. 락파일이 패키지
 * 매니저와 설치 명령을, `package.json` 의 scripts 가 검사 · 빌드 · 미리보기
 * 명령을, 커밋된 `.npmrc` 가 private 레지스트리를 말한다 — 셋 다 어느 레포나
 * 이미 가지고 있으므로 설정 파일 하나를 더 요구할 이유가 없다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RepoRegistry {
  host: string;
  scope: string;
}

/** 데몬이 실제로 돌리는 계약 — 레포가 말한 것에서 추론한 결과. */
export interface RepoConfig {
  install?: string;
  check?: string;
  build?: string;
  preview: {
    command: string;
  };
  registry?: RepoRegistry;
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

export const PREVIEW_COMMAND_UNKNOWN =
  "미리보기 명령을 찾지 못했습니다 — package.json 의 scripts 에 dev · start · serve · preview 중 " +
  "하나가 있어야 합니다.";

/**
 * JSON 이 준 값이 키를 읽어도 되는 객체인지 판정한다 — package.json 이 준 값은
 * 무엇이든 될 수 있으므로, 읽기 전에 한 번 통과시킨다. 통과한 뒤의 값은 여전히
 * unknown 이고, 각 필드는 제 자리에서 검사한다.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 커밋된 락파일이 매니저를 말한다 — 없으면 null 이다. 락파일이 없는 레포에서는
 * 설치를 돌리지 않는다: `pnpm install` 은 락파일을 만들어 레포를 바꾸고, 사용자는
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
 * 레포가 말하는 것 = 데몬이 돌릴 계약. 미리보기 명령을 끝내 알 수 없으면
 * 던진다 — 그것 없이는 미리보기가 뜰 수 없고, 사용자가 읽는 카드는 무엇을
 * 적어야 하는지 말해야 한다.
 */
export function resolveRepoConfig(root: string): RepoConfig {
  const locked = lockedManager(root);
  const manager = locked ?? "pnpm";
  const scripts = readPackageScripts(root);
  const declares = (name: string): boolean => typeof scripts[name] === "string";

  const script = PREVIEW_SCRIPTS.find(declares);
  if (script === undefined) throw new Error(PREVIEW_COMMAND_UNKNOWN);
  const command = runScript(manager, script);

  const install = locked ? INSTALL[locked] : undefined;
  const check = declares("check") ? runScript(manager, "check") : undefined;
  const build = declares("build") ? runScript(manager, "build") : undefined;
  const registry = deriveRegistry(root) ?? undefined;

  return {
    ...(install !== undefined ? { install } : {}),
    ...(check !== undefined ? { check } : {}),
    ...(build !== undefined ? { build } : {}),
    ...(registry !== undefined ? { registry } : {}),
    preview: { command },
  };
}

/** The npm scope form with a leading @, whatever the source wrote. */
export function scopeOf(registry: RepoRegistry): string {
  return registry.scope.startsWith("@") ? registry.scope : `@${registry.scope}`;
}
