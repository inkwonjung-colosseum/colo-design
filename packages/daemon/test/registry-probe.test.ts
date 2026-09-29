// 연결 레포의 private 레지스트리 인증 점검(2026-09-29)의 시험 — 무엇으로 시험할지(레포가 선언한
// 스코프의 의존성), 그 시험이 어떻게 판정되는지, 경고 문장이 무엇을 말하는지. 이 점검은 예전에
// 모든 레포에 `@colosseumcoinckr/cds` 를 물었다 — 그 스코프가 아닌 레포는 공개 레지스트리의 404 를
// 받아 가짜 "확인하지 못했습니다" 경고를 얻었고, 그 레포의 진짜 401 은 가려졌다.
// 진짜 pnpm · 네트워크 없이 도는 가짜 실행 파일로 판다. `../dist` 임포트인 이유는 다른 시험들과 같다.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRegistryAuth, registryProbeTarget, registryWarning } from "../dist/environment.js";

/** package.json 하나만 있는 레포 클론 흉내. */
function repoWith(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-registry-probe-"));
  writeFileSync(
    join(dir, "package.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  return dir;
}

const cleanup = (...dirs: string[]): void => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
};

// ————— registryProbeTarget — 무엇으로 시험할까 —————

test("registryProbeTarget — 레포가 그 스코프에서 가져오는 의존성 하나를 고른다", () => {
  const dir = repoWith({
    dependencies: { react: "^18.0.0", "@acme/ui": "^1.2.0", "@other/x": "1.0.0" },
  });
  try {
    assert.equal(registryProbeTarget(dir, "@acme"), "@acme/ui");
    assert.equal(registryProbeTarget(dir, "@other"), "@other/x", "스코프가 다르면 다른 패키지다");
  } finally {
    cleanup(dir);
  }
});

test("registryProbeTarget — dependencies 가 devDependencies 보다 앞선다", () => {
  const dir = repoWith({
    devDependencies: { "@acme/dev-tools": "1.0.0" },
    dependencies: { "@acme/ui": "1.0.0" },
  });
  try {
    assert.equal(registryProbeTarget(dir, "@acme"), "@acme/ui");
  } finally {
    cleanup(dir);
  }
});

test("registryProbeTarget — devDependencies · optionalDependencies 에만 있어도 고른다", () => {
  const dev = repoWith({ devDependencies: { "@acme/dev-tools": "1.0.0" } });
  const optional = repoWith({ optionalDependencies: { "@acme/extra": "1.0.0" } });
  try {
    assert.equal(registryProbeTarget(dev, "@acme"), "@acme/dev-tools");
    assert.equal(registryProbeTarget(optional, "@acme"), "@acme/extra");
  } finally {
    cleanup(dev, optional);
  }
});

test("registryProbeTarget — 이름만 스코프를 닮은 패키지는 그 스코프가 아니다", () => {
  const dir = repoWith({
    dependencies: { "@acme-ui/button": "1.0.0", "@acmecorp/core": "1.0.0", "acme/plain": "1.0.0" },
  });
  try {
    assert.equal(registryProbeTarget(dir, "@acme"), null);
  } finally {
    cleanup(dir);
  }
});

test("registryProbeTarget — 레지스트리에서 오지 않는 것은 건너뛴다(시험해 봐야 아무것도 증명하지 못한다)", () => {
  const dir = repoWith({
    dependencies: {
      "@acme/a": "workspace:*",
      "@acme/b": "file:../b",
      "@acme/c": "link:../c",
      "@acme/d": "portal:../d",
      "@acme/e": "npm:@other/e@1.0.0",
      "@acme/f": "git+https://example.com/f.git",
      "@acme/g": "github:acme/g",
      "@acme/h": "https://example.com/h.tgz",
      "@acme/real": "^2.0.0",
    },
  });
  try {
    assert.equal(registryProbeTarget(dir, "@acme"), "@acme/real");
  } finally {
    cleanup(dir);
  }
});

test("registryProbeTarget — catalog: 는 레지스트리에서 오는 것이다", () => {
  const dir = repoWith({ dependencies: { "@acme/ui": "catalog:" } });
  try {
    assert.equal(registryProbeTarget(dir, "@acme"), "@acme/ui");
  } finally {
    cleanup(dir);
  }
});

test("registryProbeTarget — 의존성이 없어도 레포 자신이 그 스코프의 패키지면 그 이름으로 시험한다", () => {
  const dir = repoWith({ name: "@acme/design-kit", dependencies: { react: "^18.0.0" } });
  const notInScope = repoWith({ name: "nova-fixture", dependencies: { react: "^18.0.0" } });
  try {
    assert.equal(registryProbeTarget(dir, "@acme"), "@acme/design-kit");
    assert.equal(registryProbeTarget(notInScope, "@acme"), null);
  } finally {
    cleanup(dir, notInScope);
  }
});

test("registryProbeTarget — 시험할 것이 없으면 null 이다", () => {
  const empty = repoWith({});
  const otherScope = repoWith({ dependencies: { "@other/x": "1.0.0" } });
  const noManifest = mkdtempSync(join(tmpdir(), "nova-registry-probe-"));
  const broken = repoWith("{ 이건 JSON 이 아니다");
  const arrayRoot = repoWith("[]");
  const oddFields = repoWith({ dependencies: "@acme/ui", devDependencies: ["@acme/ui"] });
  try {
    for (const dir of [empty, otherScope, noManifest, broken, arrayRoot, oddFields]) {
      assert.equal(registryProbeTarget(dir, "@acme"), null, dir);
    }
    assert.equal(registryProbeTarget(join(noManifest, "없는-폴더"), "@acme"), null);
  } finally {
    cleanup(empty, otherScope, noManifest, broken, arrayRoot, oddFields);
  }
});

test("registryProbeTarget — 명령줄에 실을 수 없는 이름은 버린다(레포가 준 이름이 그대로 셸에 가지 않게)", () => {
  const dir = repoWith({
    dependencies: {
      "@acme/a&calc": "1.0.0",
      "@acme/a b": "1.0.0",
      "@acme/$(touch pwned)": "1.0.0",
      "@acme/UPPER": "1.0.0",
      "@acme/semi;colon": "1.0.0",
      "@acme/": "1.0.0",
      "@acme/a/b": "1.0.0",
      "@acme/ok-name.v2_x~": "1.0.0",
    },
  });
  try {
    assert.equal(registryProbeTarget(dir, "@acme"), "@acme/ok-name.v2_x~");
  } finally {
    cleanup(dir);
  }
  // 스코프 쪽에도 같은 잣대다 — `.npmrc` 가 주는 스코프에 이상한 글자가 있어도 이름은 통과하지 못한다.
  const odd = repoWith({ dependencies: { "@a&b/x": "1.0.0" } });
  try {
    assert.equal(registryProbeTarget(odd, "@a&b"), null);
  } finally {
    cleanup(odd);
  }
});

// ————— readRegistryAuth — 그 시험이 어떻게 판정되나 —————

type Mode = "ok" | "unauthorized" | "notfound" | "offline" | "garbage";

/** 가짜 pnpm — 부른 자리와 인자를 로그에 적고 모드대로 답한다. */
function fakePnpm(mode: Mode): { pnpm: string; log: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "nova-registry-pnpm-"));
  const log = join(dir, "calls.log");
  const bodies: Record<Mode, string> = {
    ok: "echo 1.2.3",
    unauthorized:
      'echo "[ERR_PNPM_FETCH_401] GET https://npm.pkg.github.com/@acme%2Fui: Unauthorized - 401" >&2; exit 1',
    notfound:
      'echo "[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/@acme%2Fui: Not Found - 404" >&2; exit 1',
    offline:
      'echo "[ERR_PNPM_META_FETCH_FAIL] getaddrinfo ENOTFOUND npm.pkg.github.com" >&2; exit 1',
    garbage: "echo 버전이 아닌 말",
  };
  const pnpm = join(dir, "pnpm");
  writeFileSync(pnpm, `#!/bin/sh\necho "$(pwd -P)|$*" >> "${log}"\n${bodies[mode]}\n`, {
    mode: 0o755,
  });
  return { pnpm, log, dir };
}

const calls = (log: string): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];

test("readRegistryAuth — 그 레포의 클론에서, 그 레포 스코프의 의존성 하나를 묻는다", async () => {
  const repo = repoWith({ dependencies: { "@acme/ui": "^1.0.0" } });
  const stub = fakePnpm("ok");
  try {
    const got = await readRegistryAuth(stub.pnpm, { dir: repo, scope: "@acme" });
    assert.deepEqual(got, { auth: "ok", target: "@acme/ui" });
    assert.deepEqual(calls(stub.log), [`${realpathSync(repo)}|view @acme/ui version`]);
  } finally {
    cleanup(repo, stub.dir);
  }
});

test("readRegistryAuth — 401 은 unauthenticated, 404 · 오프라인 · 이상한 답은 unknown 이다(토큰으로 풀 문제가 아니다)", async () => {
  const cases: Array<[Mode, string]> = [
    ["unauthorized", "unauthenticated"],
    ["notfound", "unknown"],
    ["offline", "unknown"],
    ["garbage", "unknown"],
  ];
  for (const [mode, want] of cases) {
    const repo = repoWith({ dependencies: { "@acme/ui": "^1.0.0" } });
    const stub = fakePnpm(mode);
    try {
      const got = await readRegistryAuth(stub.pnpm, { dir: repo, scope: "@acme" });
      assert.equal(got.auth, want, mode);
      assert.equal(got.target, "@acme/ui", `${mode}: 시험한 이름은 남는다`);
    } finally {
      cleanup(repo, stub.dir);
    }
  }
});

test("readRegistryAuth — 시험할 것이 없으면 pnpm 을 부르지도 않고 target 도 없다", async () => {
  const repo = repoWith({ dependencies: { react: "^18.0.0" } });
  const stub = fakePnpm("unauthorized");
  try {
    const got = await readRegistryAuth(stub.pnpm, { dir: repo, scope: "@acme" });
    assert.deepEqual(got, { auth: "unknown", target: null });
    assert.equal(existsSync(stub.log), false, "pnpm 을 부르지 않았다");
  } finally {
    cleanup(repo, stub.dir);
  }
});

test("readRegistryAuth — pnpm · 레지스트리 선언 · 클론 디렉터리 중 하나라도 없으면 unknown 이고 부르지 않는다", async () => {
  const repo = repoWith({ dependencies: { "@acme/ui": "^1.0.0" } });
  const stub = fakePnpm("ok");
  try {
    const none = { auth: "unknown", target: null };
    assert.deepEqual(await readRegistryAuth(null, { dir: repo, scope: "@acme" }), none);
    assert.deepEqual(await readRegistryAuth(stub.pnpm, null), none);
    assert.deepEqual(
      await readRegistryAuth(stub.pnpm, { dir: join(repo, "없는-폴더"), scope: "@acme" }),
      none,
    );
    assert.equal(existsSync(stub.log), false);
  } finally {
    cleanup(repo, stub.dir);
  }
});

test("readRegistryAuth — 같은 레포 · 같은 패키지는 캐시가 한 번만 묻고, 패키지가 바뀌면 다시 묻는다", async () => {
  const repo = repoWith({ dependencies: { "@acme/ui": "^1.0.0" } });
  const stub = fakePnpm("ok");
  try {
    await readRegistryAuth(stub.pnpm, { dir: repo, scope: "@acme" });
    await readRegistryAuth(stub.pnpm, { dir: repo, scope: "@acme" });
    assert.equal(calls(stub.log).length, 1, "상태 요청마다 네트워크를 타지 않는다");
    // 레포의 의존성이 바뀌어 다른 이름을 묻게 되면 옛 답을 물려받지 않는다.
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { "@acme/charts": "^1.0.0" } }),
    );
    const got = await readRegistryAuth(stub.pnpm, { dir: repo, scope: "@acme" });
    assert.equal(got.target, "@acme/charts");
    assert.equal(calls(stub.log).length, 2);
  } finally {
    cleanup(repo, stub.dir);
  }
});

test("readRegistryAuth — CDS 로 못 박히지 않는다: 그 스코프가 아닌 레포는 CDS 를 묻지 않고, CDS 스코프 레포는 그대로 묻는다", async () => {
  const acme = repoWith({ dependencies: { "@acme/ui": "^1.0.0" } });
  const cds = repoWith({ dependencies: { "@colosseumcoinckr/cds": "^0.1.0" } });
  const stub = fakePnpm("ok");
  try {
    await readRegistryAuth(stub.pnpm, { dir: acme, scope: "@acme" });
    await readRegistryAuth(stub.pnpm, { dir: cds, scope: "@colosseumcoinckr" });
    const asked = calls(stub.log).map((line) => line.split("|")[1]);
    assert.deepEqual(asked, ["view @acme/ui version", "view @colosseumcoinckr/cds version"]);
  } finally {
    cleanup(acme, cds, stub.dir);
  }
});

// ————— registryWarning —————

test("registryWarning — 거절은 시험한 패키지 이름을 말한다", () => {
  const note = registryWarning({ auth: "unauthenticated", target: "@acme/ui" });
  assert.equal(
    note,
    "GitHub 패키지 저장소가 @acme/ui 요청을 거절했습니다 — 설정의 개인 액세스 토큰(read:packages 권한)을 확인해 주세요.",
  );
});

test("registryWarning — 확인하지 못한 것은 이름 없이 말하고, 통과 · 시험할 것 없음은 조용하다", () => {
  assert.match(
    registryWarning({ auth: "unknown", target: "@acme/ui" }) ?? "",
    /^GitHub 패키지 저장소 접근을 확인하지 못했습니다/,
  );
  assert.equal(registryWarning({ auth: "ok", target: "@acme/ui" }), null);
  // 시험할 것이 없었다 — 그 자체는 문제가 아니므로 어떤 답이어도 경고가 없다.
  for (const auth of ["ok", "unauthenticated", "unknown"] as const) {
    assert.equal(registryWarning({ auth, target: null }), null, auth);
  }
});

// ————— 제품 코드는 특정 레지스트리 패키지를 못 박지 않는다 —————

test("제품 코드에 회사 디자인 시스템 패키지가 못 박혀 있지 않다 — 이 도구는 연결 레포의 규칙을 따른다", () => {
  // 연결 레포가 무엇을 쓰든(회사 DS · 유틸리티 CSS · 제 손의 스타일) 도구는 그것을 전제하지 않는다.
  // 특정 패키지 이름이 코드에 들어가면 그 패키지를 안 쓰는 레포는 거짓 경고를 받거나 다른 대접을 받는다.
  // 시험 폴더와 견본(dev)은 뺀다 — 여기서 찾는 것은 출하되는 코드다.
  const root = join(import.meta.dirname, "..", "..");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.(ts|tsx|js|mjs|css)$/.test(entry)) {
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (/@colosseumcoinckr/.test(line)) {
              offenders.push(`${path.slice(root.length + 1)}:${index + 1}`);
            }
          });
      }
    }
  };
  for (const pkg of ["daemon", "protocol", "desktop", "web"]) {
    const src = join(root, pkg, "src");
    if (existsSync(src)) walk(src);
  }
  assert.deepEqual(offenders, [], `회사 패키지 이름이 출하 코드에 있다: ${offenders.join(", ")}`);
});
