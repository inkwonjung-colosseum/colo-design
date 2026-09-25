import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutSelfUpdate } from "../dist/agent-env.js";
import {
  AgentUpdates,
  attemptedKey,
  fetchLatestVersion,
  parseClaudeLatest,
  parseCodexRelease,
  updateStep,
  wantsAutoUpdate,
} from "../dist/agent-update.js";

// ---------------------------------------------------------------------------
// 순수 함수
// ---------------------------------------------------------------------------

test("자기 업데이트 끄기: 받은 환경에 DISABLE_AUTOUPDATER=1 을 더한 새 객체", () => {
  const base = { PATH: "/usr/bin", DISABLE_AUTOUPDATER: "0" };
  const env = withoutSelfUpdate(base);
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
  assert.equal(env.PATH, "/usr/bin");
  // 원본은 건드리지 않는다 — process.env 를 넘겨도 데몬 자신은 그대로.
  assert.equal(base.DISABLE_AUTOUPDATER, "0");
});

test("Claude latest 몸통: 버전 한 줄만 받고 HTML 오류 페이지는 거절", () => {
  assert.equal(parseClaudeLatest("2.1.282\n"), "2.1.282");
  assert.equal(parseClaudeLatest("<!doctype html><title>404</title>"), null);
  assert.equal(parseClaudeLatest(""), null);
});

test("Codex 릴리스: tag_name 먼저, 없으면 name", () => {
  assert.equal(parseCodexRelease({ tag_name: "rust-v0.46.0", name: "0.45.0" }), "0.46.0");
  assert.equal(parseCodexRelease({ name: "Codex 0.44.1" }), "0.44.1");
  assert.equal(parseCodexRelease({ tag_name: "nightly" }), null);
  assert.equal(parseCodexRelease(null), null);
});

test("미루기 판정: 도는 작업이 있으면 pending, 없으면 run, 설치 중이면 그대로", () => {
  assert.equal(updateStep({ busy: true, running: false }), "pending");
  assert.equal(updateStep({ busy: false, running: false }), "run");
  assert.equal(updateStep({ busy: true, running: true }), "already");
  assert.equal(updateStep({ busy: false, running: true }), "already");
});

test("자동 설치 판정: 켬 · 새것 · 처음 시도 · 걸린 것 없음 — 넷이 다 맞아야", () => {
  const base = {
    enabled: true,
    current: "2.1.4 (Claude Code)",
    latest: "2.2.0",
    attempted: null,
  };
  assert.equal(wantsAutoUpdate(base), true);
  assert.equal(wantsAutoUpdate({ ...base, enabled: false }), false);
  assert.equal(wantsAutoUpdate({ ...base, latest: "2.1.4" }), false);
  // 시도한 버전은 다시 돌지 않는다 — 실패하는 업데이트가 한 시간마다 돌지 않게.
  assert.equal(wantsAutoUpdate({ ...base, attempted: "2.2.0" }), false);
  // 더 새 버전이 나오면 다시 시도한다.
  assert.equal(wantsAutoUpdate({ ...base, latest: "2.3.0", attempted: "2.2.0" }), true);
  // 깔려 있지 않은 에이전트는 업데이트의 일이 아니다.
  assert.equal(wantsAutoUpdate({ ...base, current: null }), false);
  assert.equal(wantsAutoUpdate({ ...base, phase: "pending" }), false);
  assert.equal(wantsAutoUpdate({ ...base, phase: "running" }), false);
  assert.equal(wantsAutoUpdate({ ...base, phase: "failed" }), true);
});

test("최신 버전 확인: 환경 변수의 주소를 읽는다 — 실패는 던진다", async () => {
  const seen: string[] = [];
  const fetchLike = (async (url: string | URL | Request) => {
    seen.push(String(url));
    if (String(url).includes("claude")) return new Response("2.1.282\n");
    if (String(url).includes("broken")) return new Response("nope", { status: 503 });
    return Response.json({ tag_name: "rust-v0.46.0" });
  }) as typeof fetch;
  const env = {
    COLO_DESIGN_CLAUDE_LATEST_API: "http://127.0.0.1:1/claude-latest",
    COLO_DESIGN_CODEX_RELEASE_API: "http://127.0.0.1:1/codex-release",
  };
  assert.equal(await fetchLatestVersion("claude", { env, fetchLike }), "2.1.282");
  assert.equal(await fetchLatestVersion("codex", { env, fetchLike }), "0.46.0");
  assert.deepEqual(seen, [env.COLO_DESIGN_CLAUDE_LATEST_API, env.COLO_DESIGN_CODEX_RELEASE_API]);
  await assert.rejects(
    fetchLatestVersion("codex", {
      env: { COLO_DESIGN_CODEX_RELEASE_API: "http://127.0.0.1:1/broken" },
      fetchLike,
    }),
  );
});

// ---------------------------------------------------------------------------
// 업데이트 담당 — 가짜 진행기로
// ---------------------------------------------------------------------------

type Events = {
  onProgress(line: string): void;
  onDone(ok: boolean, detail: string, executable?: string | null): void;
};

function harness(
  opts: { latest?: Record<string, string | null>; current?: Record<string, string | null> } = {},
) {
  const state = {
    busy: false,
    settings: new Map<string, string>(),
    started: [] as string[],
    events: new Map<string, Events>(),
    broadcasts: [] as Array<Record<string, unknown>>,
    announces: 0,
    notices: [] as Array<Record<string, unknown>>,
    adopted: [] as string[],
    current: {
      claude: "2.1.4 (Claude Code)",
      codex: "codex-cli 0.45.0",
      ...opts.current,
    } as Record<string, string | null>,
  };
  const updates = new AgentUpdates({
    installer: {
      start: (kind: string, events: Events) => {
        if (state.events.has(kind)) return { started: false, guidance: "이미" };
        state.started.push(kind);
        state.events.set(kind, events);
        return { started: true, guidance: "시작" };
      },
      isRunning: (kind: string) => state.events.has(kind),
    } as never,
    busy: () => state.busy,
    setting: {
      get: (key: string) => state.settings.get(key) ?? null,
      set: (key: string, value: string | null) => {
        if (value === null) state.settings.delete(key);
        else state.settings.set(key, value);
      },
    },
    currentVersion: async (agent: string) => state.current[agent] ?? null,
    adoptClaudeExecutable: (path: string) => state.adopted.push(path),
    broadcast: (message) => state.broadcasts.push(message as never),
    announce: () => {
      state.announces += 1;
    },
    notice: (notice) => state.notices.push(notice as never),
    fetchLatest: async (agent) => {
      const value = opts.latest?.[agent];
      if (value === undefined) throw new Error("offline");
      return value;
    },
    now: () => Date.parse("2026-09-25T02:27:00Z"),
  });
  /** 진행기의 끝을 흉내 낸다 — 설치가 끝난 뒤 깔린 버전도 바꾼다. */
  const finish = async (kind: string, ok: boolean, executable?: string, nowInstalled?: string) => {
    const events = state.events.get(kind);
    assert.ok(events, `${kind} 가 시작되지 않았다`);
    state.events.delete(kind);
    if (nowInstalled) state.current[kind.replace("update-", "")] = nowInstalled;
    events.onDone(ok, ok ? "바꿨어요" : "설치가 실패했어요 — 다시 시도해 주세요.", executable);
    // finish 는 버전을 읽느라 한 박자 늦게 끝난다.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { state, updates, finish };
}

test("미루기: 도는 작업이 있으면 pending — 마지막 턴이 내려앉는 순간 깐다", async () => {
  const { state, updates, finish } = harness();
  state.busy = true;
  assert.equal(updates.request("codex"), "pending");
  assert.deepEqual(state.started, []);
  assert.equal(updates.snapshot()?.codex?.phase, "pending");
  assert.equal(updates.snapshot()?.codex?.at, "2026-09-25T02:27:00.000Z");
  // 아직 다른 턴이 돈다 — settle 은 아무것도 하지 않는다.
  updates.settle();
  assert.deepEqual(state.started, []);
  state.busy = false;
  updates.settle();
  assert.deepEqual(state.started, ["update-codex"]);
  assert.equal(updates.snapshot()?.codex?.phase, "running");
  // 설치 중의 두 번째 요청은 그대로 running.
  assert.equal(updates.request("codex"), "running");
  assert.deepEqual(state.started, ["update-codex"]);

  await finish("update-codex", true, undefined, "codex-cli 0.46.0");
  assert.deepEqual(updates.snapshot()?.codex, {
    phase: "done",
    at: "2026-09-25T02:27:00.000Z",
    version: "0.46.0",
  });
  assert.deepEqual(state.notices, [{ kind: "update-done", agent: "codex", version: "0.46.0" }]);
  assert.deepEqual(state.broadcasts.at(-1), {
    type: "onboarding.install.done",
    kind: "update-codex",
    ok: true,
    detail: "바꿨어요",
  });
  assert.ok(state.announces >= 3);
});

test("Claude 업데이트: 성공 판정의 경로를 방송보다 먼저 심는다 — 실패는 failed 와 한 줄", async () => {
  const { state, updates, finish } = harness();
  assert.equal(updates.request("claude"), "running");
  await finish(
    "update-claude",
    true,
    "/home/u/.local/share/claude/versions/2.2.0",
    "2.2.0 (Claude Code)",
  );
  assert.deepEqual(state.adopted, ["/home/u/.local/share/claude/versions/2.2.0"]);
  assert.equal(updates.snapshot()?.claude?.version, "2.2.0");

  updates.request("claude");
  await finish("update-claude", false);
  assert.equal(updates.snapshot()?.claude?.phase, "failed");
  assert.equal(updates.snapshot()?.claude?.detail, "설치가 실패했어요 — 다시 시도해 주세요.");
  assert.equal(state.notices.length, 1);
});

test("확인: 새 버전을 기억하고, 자동 설치는 버전마다 한 번만", async () => {
  const { state, updates, finish } = harness({ latest: { claude: "2.2.0", codex: "0.45.0" } });
  await updates.check();
  assert.equal(updates.latest("claude"), "2.2.0");
  assert.equal(updates.latest("codex"), "0.45.0");
  // Codex 는 이미 최신 — Claude 만 건다, 시도한 버전을 먼저 적고.
  assert.deepEqual(state.started, ["update-claude"]);
  assert.equal(state.settings.get(attemptedKey("claude")), "2.2.0");
  await finish("update-claude", false);
  // 실패한 같은 버전은 다음 확인에서 다시 돌지 않는다.
  await updates.check();
  await updates.applyAuto();
  assert.deepEqual(state.started, ["update-claude"]);
});

test("확인: 자동 설치가 꺼져 있으면 버전만 기억한다 — 켜는 순간 건다", async () => {
  const { state, updates } = harness({ latest: { claude: "2.2.0", codex: "0.46.0" } });
  state.settings.set("agentAutoUpdate", "off");
  await updates.check();
  assert.deepEqual(state.started, []);
  assert.equal(updates.latest("codex"), "0.46.0");
  state.settings.delete("agentAutoUpdate");
  state.busy = true;
  assert.equal(await updates.applyAuto(), true);
  // 도는 작업이 있어 둘 다 미뤄진다.
  assert.equal(updates.snapshot()?.claude?.phase, "pending");
  assert.equal(updates.snapshot()?.codex?.phase, "pending");
  state.busy = false;
  updates.settle();
  assert.deepEqual(state.started.sort(), ["update-claude", "update-codex"]);
});

test("확인의 실패는 조용하다 — 던지지 않고, 아는 버전도 지우지 않는다", async () => {
  const { state, updates } = harness({ latest: { claude: null } });
  await updates.check();
  assert.equal(updates.latest("claude"), undefined);
  assert.equal(updates.latest("codex"), undefined);
  assert.equal(updates.snapshot(), undefined);
  assert.equal(state.announces, 0);
});

test("상태 요청의 곁가지: 한 시간 안에는 다시 확인하지 않는다", async () => {
  let calls = 0;
  let now = 0;
  const updates = new AgentUpdates({
    installer: { start: () => ({ started: false, guidance: "" }), isRunning: () => false } as never,
    busy: () => false,
    setting: { get: () => "off", set: () => {} },
    currentVersion: async () => null,
    adoptClaudeExecutable: () => {},
    broadcast: () => {},
    announce: () => {},
    notice: () => {},
    fetchLatest: async () => {
      calls += 1;
      return "1.0.0";
    },
    now: () => now,
  });
  updates.maybeCheck();
  await updates.check();
  assert.equal(calls, 2);
  now = 30 * 60_000;
  updates.maybeCheck();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  now = 61 * 60_000;
  updates.maybeCheck();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 4);
});
