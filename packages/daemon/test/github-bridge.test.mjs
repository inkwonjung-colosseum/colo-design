/**
 * GitHubBridge 의 인증 감시 (states.md §5-3): 데몬 자신의 GitHub 읽기가 본
 * 401 이 status.githubAuthExpired 로 나가 만료 카드를 연다. 판정은 전이에서만
 * 방송되고, 그 뒤의 성공 응답이 되돌린다 — 숨긴 레포의 404 도 인증을 마친
 * 뒤의 대답이라 401 만이 만료의 증거다.
 *
 * The bridge's transport comes from COLO_DESIGN_GITHUB_FIXTURE, so the test
 * writes its own pair file into a temp dir — the shared fixture's pairs are
 * consumed in order and cannot express this test's 401→401→200 sequence.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryCredentialStore, REPO_PAT_ITEM } from "../dist/credentials.js";
import { GitHubBridge } from "../dist/github-bridge.js";

function fixtureDir(pairs) {
  const dir = mkdtempSync(join(tmpdir(), "colo-bridge-fixture-"));
  writeFileSync(join(dir, "fixtures.json"), JSON.stringify(pairs));
  return dir;
}

const userPair = (status, json) => ({
  name: `user-${status}`,
  cite: "GET /user — https://docs.github.com/rest/users/users#get-the-authenticated-user",
  request: { method: "GET", url: "/user" },
  response: { status, json },
});
test("a 401 the daemon itself saw flips the expiry flag, and a later answer flips it back", async () => {
  const dir = fixtureDir([
    userPair(401, { message: "Bad credentials" }),
    userPair(401, { message: "Bad credentials" }),
    userPair(200, { login: "jik-dev" }),
  ]);
  const previousFixture = process.env.COLO_DESIGN_GITHUB_FIXTURE;
  process.env.COLO_DESIGN_GITHUB_FIXTURE = dir;
  try {
    const store = new MemoryCredentialStore();
    await store.save(REPO_PAT_ITEM, "ghp_dead");
    const events = [];
    const bridge = new GitHubBridge({
      credentials: store,
      claudeExecutableOverride: () => undefined,
      onToken: () => undefined,
      onAuthChange: (expired) => events.push(expired),
    });
    await bridge.load();
    assert.equal(bridge.authExpired, false);

    // The first refusal is news; the second is the same news again.
    const first = await bridge.client().whoAmI();
    assert.equal(first.ok, false);
    assert.equal(first.reason, "unauthorized");
    assert.equal(bridge.authExpired, true);
    assert.deepEqual(events, [true]);

    const second = await bridge.client().whoAmI();
    assert.equal(second.ok, false);
    assert.deepEqual(events, [true], "a repeated 401 must not rebroadcast");

    const third = await bridge.client().whoAmI();
    assert.deepEqual(third, { ok: true, login: "jik-dev" });
    assert.equal(bridge.authExpired, false);
    assert.deepEqual(events, [true, false]);
  } finally {
    if (previousFixture === undefined) delete process.env.COLO_DESIGN_GITHUB_FIXTURE;
    else process.env.COLO_DESIGN_GITHUB_FIXTURE = previousFixture;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new token retires the old token's 401 before the gate re-judges it", async () => {
  const dir = fixtureDir([
    userPair(401, { message: "Bad credentials" }),
    // setToken's gate re-check: whoAmI on the new token.
    userPair(200, { login: "jik-dev" }),
  ]);
  const previousFixture = process.env.COLO_DESIGN_GITHUB_FIXTURE;
  process.env.COLO_DESIGN_GITHUB_FIXTURE = dir;
  try {
    const store = new MemoryCredentialStore();
    await store.save(REPO_PAT_ITEM, "ghp_dead");
    const events = [];
    const bridge = new GitHubBridge({
      credentials: store,
      claudeExecutableOverride: () => undefined,
      onToken: () => undefined,
      onAuthChange: (expired) => events.push(expired),
    });
    await bridge.load();
    await bridge.client().whoAmI();
    assert.equal(bridge.authExpired, true);

    // The paste itself clears the flag — the gate's own whoAmI then judges
    // the NEW token, and a still-bad one flips it right back.
    const step = await bridge.setToken("ghp_fresh");
    assert.equal(step?.status, "pass");
    assert.equal(bridge.authExpired, false);
    assert.deepEqual(events, [true, false]);
  } finally {
    if (previousFixture === undefined) delete process.env.COLO_DESIGN_GITHUB_FIXTURE;
    else process.env.COLO_DESIGN_GITHUB_FIXTURE = previousFixture;
    rmSync(dir, { recursive: true, force: true });
  }
});
