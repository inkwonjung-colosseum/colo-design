import assert from "node:assert/strict";
import { test } from "node:test";
// `../dist` 임포트인 이유: auto-thread 는 형제를 `.js` 지정자로 부른다 — src
// 직접 로드는 그 지정을 못 고친다(cycle-reconcile.test.ts 와 같은 길).
import { DriverRegistry } from "../dist/agent/registry.js";
import { AutoThreads, openAutoThread, pickAutoThreadProvider } from "../dist/auto-thread.js";

interface FakeDiagnostic {
  ok: boolean;
  executable?: string;
  loggedIn?: boolean;
}

/** 가짜 드라이버 — isAvailable 의 답만 정한다. 세션은 가짜 관리자가 만든다. */
function fakeDriver(id: string, diagnostic: FakeDiagnostic) {
  return {
    id,
    describe: () => ({ id, label: id, capabilities: {} }),
    isAvailable: async () => diagnostic,
    createSession: () => {
      throw new Error("가짜 드라이버는 세션을 만들지 않는다");
    },
  };
}

const MISSING: FakeDiagnostic = { ok: false };
const CLAUDE: FakeDiagnostic = { ok: true, executable: "/opt/claude", loggedIn: true };
const CODEX: FakeDiagnostic = { ok: true, executable: "/opt/codex", loggedIn: true };

/** 등록 순서가 곧 후보 순서 — 서버의 registerAgentDrivers 와 같은 claude → codex. */
function registryOf(claude: FakeDiagnostic, codex: FakeDiagnostic): DriverRegistry {
  const registry = new DriverRegistry();
  registry.register(fakeDriver("claude", claude) as never);
  registry.register(fakeDriver("codex", codex) as never);
  return registry;
}

const CWD = "/tmp/colo-auto-thread/repo";

interface FakeLive {
  id: string;
  cwd: string;
  sendable: boolean;
  lastActivity: number;
}

/** manager.create 가 받는 것 중 시험이 읽는 몫. */
interface CreatedOptions {
  cwd: string;
  provider: string;
  title: string;
  writePolicy: unknown;
  launch: { executable?: string; appendSystemPrompt?: string; model?: string; effort?: string };
}

/** 가짜 세션 관리자 — 살아 있는 대화 · 저장된 목록을 정하고 create 의 옵션을 모은다. */
function fakeManager(
  opts: { live?: FakeLive[]; stored?: Array<{ provider?: string; lastModified: number }> } = {},
) {
  const created: CreatedOptions[] = [];
  const manager = {
    all: () => opts.live ?? [],
    // 실제 list 처럼 최근 것이 앞이다.
    list: async () => [...(opts.stored ?? [])].sort((a, b) => b.lastModified - a.lastModified),
    create: (options: CreatedOptions) => {
      created.push(options);
      return { id: `auto-${created.length}`, cwd: options.cwd, provider: options.provider };
    },
  };
  return { manager: manager as never, created };
}

function open(
  drivers: DriverRegistry,
  manager: never,
  over: { defaults?: Record<string, string> } = {},
) {
  return openAutoThread(
    { manager, drivers, queueDiskFor: () => ({}) as never },
    { cwd: CWD, title: "리뷰 반영", instructions: "공통 규칙", ...over },
  );
}

test("Codex 만 쓸 수 있으면 자동 대화가 codex 로 열린다 — 실행 파일 · 지침 · 제목을 싣는다", async () => {
  const { manager, created } = fakeManager();
  const opened = await open(registryOf(MISSING, CODEX), manager);
  assert.equal(opened?.created, true);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.provider, "codex");
  assert.equal(created[0]?.cwd, CWD);
  assert.equal(created[0]?.title, "리뷰 반영");
  assert.equal(created[0]?.launch.executable, "/opt/codex");
  assert.equal(created[0]?.launch.appendSystemPrompt, "공통 규칙");
  assert.equal(typeof created[0]?.writePolicy, "function");
});

test("그 클론의 최근 대화가 codex 였으면 codex — claude 가 먼저 등록돼 있어도", async () => {
  const { manager, created } = fakeManager({
    stored: [
      { provider: "claude", lastModified: 1 },
      { provider: "codex", lastModified: 2 },
    ],
  });
  await open(registryOf(CLAUDE, CODEX), manager);
  assert.equal(created[0]?.provider, "codex");
});

test("defaults.provider 가 있으면 그것 — 모델 · 생각 시간은 그 공급자에게만", async () => {
  const both = registryOf(CLAUDE, CODEX);
  const first = fakeManager();
  await open(both, first.manager, {
    defaults: { provider: "codex", model: "gpt-5.5", effort: "high" },
  });
  assert.equal(first.created[0]?.provider, "codex");
  assert.equal(first.created[0]?.launch.model, "gpt-5.5");
  assert.equal(first.created[0]?.launch.effort, "high");

  // 그 공급자를 쓸 수 없으면 다음 후보로 — 다른 공급자의 모델은 싣지 않는다.
  const fallback = fakeManager();
  await open(registryOf(CLAUDE, MISSING), fallback.manager, {
    defaults: { provider: "codex", model: "gpt-5.5" },
  });
  assert.equal(fallback.created[0]?.provider, "claude");
  assert.equal(fallback.created[0]?.launch.model, undefined);

  // 공급자를 정하지 않은 defaults 는 모든 공급자의 처음 값이다.
  const open3 = fakeManager();
  await open(both, open3.manager, { defaults: { model: "sonnet" } });
  assert.equal(open3.created[0]?.provider, "claude");
  assert.equal(open3.created[0]?.launch.model, "sonnet");
});

test("아무것도 쓸 수 없으면 null — 세션을 만들지 않는다", async () => {
  const { manager, created } = fakeManager({ stored: [{ provider: "codex", lastModified: 1 }] });
  assert.equal(await open(registryOf(MISSING, MISSING), manager), null);
  assert.equal(created.length, 0);
});

test("그 클론의 살아 있는 보낼 수 있는 대화가 있으면 그것 — 새로 열지 않는다", async () => {
  const { manager, created } = fakeManager({
    live: [
      { id: "old", cwd: CWD, sendable: true, lastActivity: 1 },
      { id: "recent", cwd: CWD, sendable: true, lastActivity: 5 },
      { id: "other-project", cwd: "/tmp/other/repo", sendable: true, lastActivity: 9 },
      { id: "crashed", cwd: CWD, sendable: false, lastActivity: 10 },
    ],
  });
  const opened = await open(registryOf(CLAUDE, CODEX), manager);
  assert.equal((opened?.session as unknown as FakeLive | undefined)?.id, "recent");
  assert.equal(opened?.created, false);
  assert.equal(created.length, 0);
});

test("같은 클론에서 동시에 두 번 열면 대화는 하나 — 뒤의 것은 앞의 것이 연 대화에 싣는다", async () => {
  // 만든 대화가 곧바로 살아 있는 대화가 되는 관리자 — 실제 SessionManager 와 같다.
  const live: FakeLive[] = [];
  const created: CreatedOptions[] = [];
  const manager = {
    all: () => live,
    list: async () => [],
    create: (options: CreatedOptions) => {
      created.push(options);
      const session = {
        id: `auto-${created.length}`,
        cwd: options.cwd,
        sendable: true,
        lastActivity: 1,
      };
      live.push(session);
      return session;
    },
  };
  const threads = new AutoThreads({
    manager: manager as never,
    drivers: registryOf(MISSING, CODEX),
    queueDiskFor: () => ({}) as never,
  });
  const request = { cwd: CWD, title: "최신 변경 합치기", instructions: "" };
  const [first, second] = await Promise.all([threads.open(request), threads.open(request)]);
  assert.equal(created.length, 1, "대화를 둘 만들면 한 클론을 두 AI 가 동시에 고친다");
  assert.equal(first?.created, true);
  assert.equal(second?.created, false);
  assert.equal(second?.session, first?.session);

  // 앞의 열기가 던져도 줄은 이어진다.
  const failing = new AutoThreads({
    manager: {
      all: () => [],
      list: async () => [],
      create: () => {
        throw new Error("CLI 가 뜨지 않았다");
      },
    } as never,
    drivers: registryOf(CLAUDE, MISSING),
    queueDiskFor: () => ({}) as never,
  });
  const [thrown, after] = await Promise.allSettled([failing.open(request), failing.open(request)]);
  assert.equal(thrown.status, "rejected");
  assert.equal(after.status, "rejected", "뒤의 것도 제 차례에 시도한다");
});

test("공급자 고르기 — 로그인이 확인된 것이 먼저, 없으면 설치만 된 첫 것", async () => {
  const loggedOut = (diagnostic: FakeDiagnostic) => ({ ...diagnostic, loggedIn: false });
  // 최근 대화의 공급자라도 로그아웃이면 로그인된 다른 공급자가 먼저다.
  assert.deepEqual(await pickAutoThreadProvider(registryOf(CLAUDE, loggedOut(CODEX)), ["codex"]), {
    provider: "claude",
    executable: "/opt/claude",
  });
  // 모두 로그아웃이면 앞의 후보 — 그 턴은 로그인을 기다렸다가 다시 나간다(L12).
  assert.deepEqual(
    await pickAutoThreadProvider(registryOf(loggedOut(CLAUDE), loggedOut(CODEX)), ["codex"]),
    { provider: "codex", executable: "/opt/codex" },
  );
  // 등록되지 않은 이름(개발 실행 밖의 omp)은 건너뛴다.
  assert.deepEqual(await pickAutoThreadProvider(registryOf(CLAUDE, CODEX), ["omp", undefined]), {
    provider: "claude",
    executable: "/opt/claude",
  });
  // 실행 파일이 없는 판정은 쓸 수 없는 것이다.
  assert.equal(await pickAutoThreadProvider(registryOf({ ok: true }, MISSING), []), null);
});
