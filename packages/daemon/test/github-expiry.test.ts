// U17(PLAN-UI §10) — 연결 코드의 만료를 미리 안다. 순수 판정(머리글 해석 ·
// 남은 날 판정)과 브리지의 감시점(전송 래퍼가 머리글을 읽어 값이 바뀔 때만
// 알린다)을 본다. 개발자 알림의 배달(이슈 하나 · 중복 없음 · 새 토큰에 해결)은
// developer-notice.test.ts 의 github:expiring 케이스가 맡는다.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUDGETS } from "../dist/budgets.js";
import { MemoryCredentialStore, REPO_PAT_ITEM } from "../dist/credentials.js";
import { GitHubBridge } from "../dist/github-bridge.js";
import { expiryJudgement, expiryNoticeStep, parseTokenExpiration } from "../dist/github-expiry.js";

const DAY = 86_400_000;
/** GitHub 머리글의 꼴 — `YYYY-MM-DD HH:MM:SS UTC`. */
const githubStamp = (msFromNow: number) => {
  const date = new Date(Date.now() + msFromNow);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)} UTC`;
};

// ————— 순수: parseTokenExpiration —————

test("parseTokenExpiration — GitHub 의 UTC 꼴과 ISO 꼴을 같은 ISO 로 내린다", () => {
  assert.equal(
    parseTokenExpiration({ "github-authentication-token-expiration": "2026-10-15 12:00:00 UTC" }),
    "2026-10-15T12:00:00.000Z",
  );
  assert.equal(
    parseTokenExpiration({ "github-authentication-token-expiration": "2026-10-15T12:00:00Z" }),
    "2026-10-15T12:00:00.000Z",
  );
  // 시간대를 밝히지 않은 값도 UTC 로 읽는다 — 기계의 시간대마다 답이 달라지면 안 된다.
  assert.equal(
    parseTokenExpiration({ "github-authentication-token-expiration": "2026-10-15 12:00:00" }),
    "2026-10-15T12:00:00.000Z",
  );
});

test("parseTokenExpiration — 머리글이 없으면 null, 해석할 수 없으면 null", () => {
  assert.equal(parseTokenExpiration(undefined), null);
  assert.equal(parseTokenExpiration({}), null);
  assert.equal(parseTokenExpiration({ "github-authentication-token-expiration": "" }), null);
  assert.equal(
    parseTokenExpiration({ "github-authentication-token-expiration": "언젠가 금요일" }),
    null,
  );
});

// ————— 순수: expiryJudgement —————

test("expiryJudgement — 14일 경계는 포함(경고), 15일은 아니다, 지난 날짜는 401 의 일", () => {
  const now = Date.now();
  assert.deepEqual(expiryJudgement(new Date(now + 12 * DAY).toISOString(), now), {
    daysLeft: 12,
    warn: true,
  });
  assert.deepEqual(expiryJudgement(new Date(now + 14 * DAY).toISOString(), now), {
    daysLeft: 14,
    warn: true,
  });
  assert.deepEqual(expiryJudgement(new Date(now + 15 * DAY).toISOString(), now), {
    daysLeft: 15,
    warn: false,
  });
  const past = expiryJudgement(new Date(now - DAY).toISOString(), now);
  assert.ok(past.daysLeft <= 0);
  assert.equal(past.warn, false, "지난 시각은 예고가 아니라 실제 만료(401)의 일이다");
  // 창은 예산표에서 온다 — 표가 움직이면 경계 시험이 함께 움직인다.
  assert.equal(BUDGETS.tokenExpiry.warnBeforeMs, 14 * DAY);
});

// ————— 순수: expiryNoticeStep —————

test("expiryNoticeStep — 거둠은 저장된 슬러그(machine.json)에서 오므로 재시작을 넘는다", () => {
  const now = Date.now();
  const warn = expiryJudgement(new Date(now + 12 * DAY).toISOString(), now);
  const calm = expiryJudgement(new Date(now + 15 * DAY).toISOString(), now);
  // 경고 창에 들어섰다 — 활성 프로젝트로 알린다.
  assert.deepEqual(expiryNoticeStep({ judged: warn, storedSlug: null, activeSlug: "app" }), {
    raise: "app",
  });
  // 재시작 뒤 여전히 경고 창 — 다시 알릴 뿐 거두지 않는다.
  assert.deepEqual(expiryNoticeStep({ judged: warn, storedSlug: "app", activeSlug: "app" }), {
    raise: "app",
  });
  // 재시작 뒤 새 토큰 — 판정은 없고 저장된 슬러그만 남아, 그것으로 거둔다.
  assert.deepEqual(expiryNoticeStep({ judged: null, storedSlug: "app", activeSlug: "app" }), {
    resolve: "app",
  });
  // 창 밖으로 나가도 거둔다.
  assert.deepEqual(expiryNoticeStep({ judged: calm, storedSlug: "app", activeSlug: "app" }), {
    resolve: "app",
  });
  // 저장된 것이 없으면 아무 일도 아니다.
  assert.deepEqual(expiryNoticeStep({ judged: null, storedSlug: null, activeSlug: "app" }), {});
  assert.deepEqual(expiryNoticeStep({ judged: calm, storedSlug: null, activeSlug: "app" }), {});
  // 알릴 프로젝트가 없으면 알리지 않는다.
  assert.deepEqual(expiryNoticeStep({ judged: warn, storedSlug: null, activeSlug: null }), {});
});
/**
 * 만료 머리글을 실어 주는 fixture 전송 — 브리지의 생성자가 process.env 를
 * 보므로 환경을 잠깐 갈아끼운다. 두 끝(/user · /user/repos)이 같은 머리글을
 * 내는 모양으로, 같은 값의 둘째 응답이 다시 알리지 않는지를 본다.
 */
function withExpiryFixture(headerValue: string, run: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "colo-expiry-"));
  const headers = { "github-authentication-token-expiration": headerValue };
  const pairs = [
    {
      name: "user",
      cite: "GET /user",
      request: { method: "GET", url: "/user" },
      response: { status: 200, json: { login: "colo-planner" }, headers },
    },
    {
      name: "repos",
      cite: "GET /user/repos",
      request: {
        method: "GET",
        url: "/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100",
      },
      response: { status: 200, json: [], headers },
    },
  ];
  writeFileSync(join(dir, "fixtures.json"), JSON.stringify(pairs));
  const before = process.env.COLO_DESIGN_GITHUB_FIXTURE;
  process.env.COLO_DESIGN_GITHUB_FIXTURE = dir;
  return run().finally(() => {
    if (before === undefined) delete process.env.COLO_DESIGN_GITHUB_FIXTURE;
    else process.env.COLO_DESIGN_GITHUB_FIXTURE = before;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("브리지 — 첫 응답에서 만료 시각을 알고, 같은 값의 둘째 응답은 다시 알리지 않는다", async () => {
  await withExpiryFixture(githubStamp(12 * DAY), async () => {
    const seen: Array<string | null> = [];
    const credentials = new MemoryCredentialStore();
    await credentials.save(REPO_PAT_ITEM, "t");
    const bridge = new GitHubBridge({
      credentials,
      claudeExecutableOverride: () => undefined,
      onToken: () => {},
      onExpiryChange: (iso) => seen.push(iso),
    });
    await bridge.load();
    const iso = new Date(githubStamp(12 * DAY)).toISOString();
    // 첫 응답 — 관찰의 첫 틱에서 추가 요청 없이 만료 시각을 안다.
    await bridge.client()?.whoAmI();
    assert.equal(bridge.tokenExpiresAt, iso);
    // 둘째 응답(다른 끝, 같은 머리글) — 값이 같으므로 다시 알리지 않는다.
    assert.equal(await bridge.writeRepoCount(), 0);
    assert.deepEqual(seen, [iso]);
    // 새 토큰 — 새 자격의 생애가 시작되며 예고를 지운다. 토큰 없는 게이트
    // 재판정은 GitHub 을 부르지 않으므로 fixture 는 그대로 남는다.
    await bridge.setToken(null);
    assert.equal(bridge.tokenExpiresAt, null);
    assert.deepEqual(seen, [iso, null]);
  });
});
