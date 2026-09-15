/**
 * REST golden pass for 개발자에게 넘기기 (PLAN D5[넘기기]): the client's request shapes
 * and its state mapping are checked against the recorded fixtures in
 * fixtures/github/. The fixture transport deep-equals POST/PATCH JSON bodies,
 * so consuming the whole pair set in order is also the assertion that the
 * create call sends title/body/head/base and nothing else.
 *
 * The state mapping is the load-bearing part: 반영됨 (merged) arrives as
 * `state: "closed"` with `merged: true`, and 변경 요청 is a review verdict
 * that a later approval by the same reviewer must clear.
 *
 * Run: node --test packages/daemon/test/github.test.mjs
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createGitHubTransport, GitHubClient, parseRepoSlug } from "../dist/github.js";
import { FixtureTransport, loadFixturePairs } from "../dist/rest-transport.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures", "github");
const pairs = loadFixturePairs(fixtureDir);

const TOKEN = "ghp_never_in_any_message";
const REPO = { owner: "colosseumcoinckr", repo: "colo-open-design" };

const byName = (name) => {
  const pair = pairs.find((candidate) => candidate.name === name);
  assert.ok(pair, `github fixture ${name}`);
  return pair;
};

test("every fixture pair cites its endpoint", () => {
  for (const pair of pairs) {
    assert.ok(pair.name, "a human name");
    assert.match(pair.cite, /^(GET|POST|PATCH) \/(repos|user)/, `cite for ${pair.name}`);
    assert.match(pair.request.url, /^\//, "site-relative path");
  }
});

test("the golden pass runs end to end, in order", async () => {
  // Only the handoff pairs: the picker/gate fixtures (user, repos, contents)
  // have their own tests below.
  const transport = new FixtureTransport(
    pairs.filter((pair) => pair.request.url.includes("colosseumcoinckr")),
  );
  const client = new GitHubClient(TOKEN, transport);

  // 개발자에게 넘기기 — the create body is deep-equalled by the fixture.
  const created = await client.createPullRequest({
    ...REPO,
    head: "colo-design/20260909-1",
    base: "main",
    title: "회원 관리 기획서",
    body: byName("pr-create").request.bodyJson.body,
  });
  assert.deepEqual(created, {
    number: 7,
    url: "https://github.com/colosseumcoinckr/colo-open-design/pull/7",
    title: "회원 관리 기획서",
    state: "open",
    branch: "colo-design/20260909-1",
    // 리뷰어 보고(2026-09-15): 새 요청에는 아직 아무도 지정되지 않았다 —
    // 빈 배열은 "모른다"가 아니라 "없다"이고, 칩은 그때 조용하다.
    reviewers: [],
  });

  // 열림 — no review yet.
  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "open");

  // 변경 요청 — the newest verdict of the one reviewer, with COMMENTED rows
  // on both sides of it that carry no verdict at all.
  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "changes_requested");

  // …and the same reviewer's later approval clears it. Reviews supersede each
  // other per user; counting every CHANGES_REQUESTED ever submitted would
  // pin the tree badge to 변경 요청 for the rest of the cycle.
  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "open");

  // 반영됨 — GitHub says closed + merged, and merged wins.
  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "merged");

  // Closed without a merge: not 반영됨, and no reviews call is spent on it.
  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "closed");

  // A later 저장 renames the standing pull request.
  const updated = await client.updatePullRequest({
    ...REPO,
    number: 7,
    title: byName("pr-update").request.bodyJson.title,
    body: byName("pr-update").request.bodyJson.body,
  });
  assert.equal(updated.title, "회원 관리 기획서 · 주문 정책 기획서");
  assert.equal(updated.state, "open");

  // 403 — the API's own message reaches the reader, the token does not.
  await assert.rejects(
    () => client.getPullRequest({ ...REPO, number: 99 }),
    (error) => {
      assert.match(error.message, /GitHub 403/);
      assert.match(error.message, /Resource not accessible by personal access token/);
      assert.ok(!error.message.includes(TOKEN), "the token never reaches an error message");
      return true;
    },
  );

  // The onboarding gate: permissions.push is the answer when GitHub gives one.
  assert.deepEqual(await client.verifyPullRequestAccess(REPO), {
    ok: true,
    detail: null,
  });

  const readOnly = await client.verifyPullRequestAccess(REPO);
  assert.equal(readOnly.ok, false);
  assert.match(readOnly.detail, /쓰기 권한이 있는 계정의 토큰/);
  assert.ok(
    !/브랜치|커밋|푸시|PR|머지/.test(readOnly.detail),
    "no git vocabulary reaches the planner",
  );

  // No permissions block: a classic token is judged by x-oauth-scopes.
  assert.equal((await client.verifyPullRequestAccess(REPO)).ok, true, "repo scope is enough");
  const missingScope = await client.verifyPullRequestAccess(REPO);
  assert.equal(missingScope.ok, false, "repo:status is not repo");
  assert.match(missingScope.detail, /repo 권한을 켜고/);

  // A fine-grained token sends no scopes header at all; absence is not a no.
  assert.deepEqual(await client.verifyPullRequestAccess(REPO), {
    ok: true,
    detail: null,
  });

  const notFound = await client.verifyPullRequestAccess(REPO);
  assert.equal(notFound.ok, false);
  assert.match(notFound.detail, /레포에 접근할 수 없습니다/);

  assert.equal(transport.pending, 0, "every recorded pair was used");
});

test("a refused reviews call leaves the pull request 열림 instead of failing", async () => {
  // The link the planner needs is already in hand; a badge one poll behind
  // beats a status read that throws.
  const transport = new FixtureTransport([
    byName("pr-open"),
    {
      name: "reviews refused",
      cite: "GET /repos/{owner}/{repo}/pulls/{number}/reviews",
      request: {
        method: "GET",
        url: "/repos/colosseumcoinckr/colo-open-design/pulls/7/reviews?per_page=100",
      },
      response: { status: 403, json: { message: "Resource not accessible" } },
    },
  ]);
  const client = new GitHubClient(TOKEN, transport);

  assert.equal((await client.getPullRequest({ ...REPO, number: 7 })).state, "open");
});

test("an unreachable GitHub answers the onboarding gate instead of breaking it", async () => {
  // checkProject() calls this without a try/catch: a throw here would take
  // the whole onboarding list down on a machine that is merely offline.
  const client = new GitHubClient(TOKEN, {
    request: async () => {
      throw new Error("fetch failed");
    },
  });

  const access = await client.verifyPullRequestAccess(REPO);
  assert.equal(access.ok, false);
  assert.match(access.detail, /GitHub에 연결하지 못해/);
  assert.ok(!access.detail.includes(TOKEN));
});

test("a 422 names the field GitHub complained about", async () => {
  // The one failure the planner will actually hit: pressing 넘기기 twice.
  const transport = new FixtureTransport([
    {
      name: "duplicate pull request",
      cite: "POST /repos/{owner}/{repo}/pulls",
      request: {
        method: "POST",
        url: "/repos/colosseumcoinckr/colo-open-design/pulls",
      },
      response: {
        status: 422,
        json: {
          message: "Validation Failed",
          errors: [
            {
              message: "A pull request already exists for colosseumcoinckr:colo-design/20260909-1.",
            },
          ],
        },
      },
    },
  ]);
  const client = new GitHubClient(TOKEN, transport);

  await assert.rejects(
    () =>
      client.createPullRequest({
        ...REPO,
        head: "colo-design/20260909-1",
        base: "main",
        title: "회원 관리 기획서",
        body: "본문",
      }),
    /개발자에게 넘기기에 실패했습니다 — GitHub 422: Validation Failed — A pull request already exists/,
  );
});

test("parseRepoSlug reads every remote form the planner can paste", () => {
  const slug = { owner: "colosseumcoinckr", repo: "colo-open-design" };
  assert.deepEqual(parseRepoSlug("https://github.com/colosseumcoinckr/colo-open-design"), slug);
  assert.deepEqual(parseRepoSlug("https://github.com/colosseumcoinckr/colo-open-design.git"), slug);
  assert.deepEqual(parseRepoSlug("git@github.com:colosseumcoinckr/colo-open-design.git"), slug);
  assert.deepEqual(
    parseRepoSlug("ssh://git@github.com/colosseumcoinckr/colo-open-design.git"),
    slug,
  );
  // authenticatedUrl() embeds the PAT as userinfo; the slug is still the slug.
  assert.deepEqual(
    parseRepoSlug("https://ghp_token@github.com/colosseumcoinckr/colo-open-design.git"),
    slug,
  );
  assert.deepEqual(
    parseRepoSlug("  https://github.com/colosseumcoinckr/colo-open-design/  "),
    slug,
  );

  assert.equal(parseRepoSlug("https://gitlab.com/org/repo.git"), null, "not GitHub");
  assert.equal(parseRepoSlug("https://github.enterprise.io/org/repo.git"), null, "not github.com");
  assert.equal(parseRepoSlug("https://github.com/colosseumcoinckr"), null, "no repo");
  assert.equal(parseRepoSlug(""), null);
});

test("COLO_DESIGN_GITHUB_FIXTURE picks the recorded transport", () => {
  const chosen = createGitHubTransport({
    COLO_DESIGN_GITHUB_FIXTURE: fixtureDir,
  });
  assert.ok(chosen.transport instanceof FixtureTransport);
  assert.equal(chosen.fixtureDir, fixtureDir);

  // Without it the daemon talks to the real api — a usable transport either
  // way, because the api base is a constant and needs no caller fallback.
  const live = createGitHubTransport({});
  assert.ok(live.transport, "a transport, not null");
  assert.equal(live.fixtureDir, null);

  // An unloadable directory still reports what was asked for, so a caller
  // cannot mistake a broken fixture set for "no fixtures configured".
  const broken = createGitHubTransport({
    COLO_DESIGN_GITHUB_FIXTURE: join(fixtureDir, "nope"),
  });
  assert.equal(broken.fixtureDir, join(fixtureDir, "nope"));
  assert.ok(!(broken.transport instanceof FixtureTransport));
});

test("whoAmI reads the token's login, and answers a refused token in Korean", async () => {
  const client = new GitHubClient(TOKEN, new FixtureTransport([byName("user")]));
  assert.deepEqual(await client.whoAmI(), { ok: true, login: "jik-dev" });

  const refused = await new GitHubClient(
    TOKEN,
    new FixtureTransport([byName("user-401")]),
  ).whoAmI();
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /유효하지 않거나 만료/);
  assert.ok(!refused.detail.includes(TOKEN));
});

test("an unreachable GitHub answers whoAmI instead of breaking the gate", async () => {
  const client = new GitHubClient(TOKEN, {
    request: async () => {
      throw new Error("fetch failed");
    },
  });
  const answer = await client.whoAmI();
  assert.equal(answer.ok, false);
  assert.match(answer.detail, /GitHub에 연결하지 못했습니다/);
});

test("listRepos follows Link pages, drops archived repos, maps the picker's fields", async () => {
  const client = new GitHubClient(
    TOKEN,
    new FixtureTransport([byName("user-repos-1"), byName("user-repos-2")]),
  );
  const { repos, truncated } = await client.listRepos();

  assert.equal(truncated, false);
  assert.deepEqual(
    repos.map((repo) => repo.fullName),
    ["colo-org/payments-web", "colo-org/legacy-docs", "jik-dev/sandbox"],
  );
  assert.deepEqual(repos[0], {
    fullName: "colo-org/payments-web",
    owner: "colo-org",
    name: "payments-web",
    cloneUrl: "https://github.com/colo-org/payments-web.git",
    defaultBranch: "main",
    canPush: true,
    pushedAt: "2026-09-08T09:00:00Z",
  });
  // permissions.push drives the picker's pushable-only filter — read, never re-fetched.
  assert.equal(repos[1].canPush, false);
});

test("listRepos marks the list truncated when the page cap stops it", async () => {
  const transport = new FixtureTransport([
    byName("user-repos-cap-1"),
    byName("user-repos-cap-2"),
    byName("user-repos-cap-3"),
    byName("user-repos-cap-4"),
    byName("user-repos-cap-5"),
  ]);
  const { repos, truncated } = await new GitHubClient(TOKEN, transport).listRepos();

  assert.equal(truncated, true);
  assert.equal(repos.length, 5);
  // The sixth page's pair is still there: the cap is what stopped the walk.
  assert.equal(transport.pending, 0);
});

test("listRepos throws with the picker's line when a page fails", async () => {
  const unauthorized = new GitHubClient(TOKEN, {
    request: async () => ({
      status: 401,
      body: new TextEncoder().encode(JSON.stringify({ message: "Bad credentials" })),
    }),
  });
  await assert.rejects(unauthorized.listRepos(), /토큰이 유효하지 않거나 만료/);
});

test("hasColoDesign reads presence off one request, before any clone", async () => {
  const withIt = new GitHubClient(TOKEN, new FixtureTransport([byName("contents-colo-design")]));
  assert.equal(await withIt.hasColoDesign({ owner: "colo-org", repo: "payments-web" }), true);

  const without = new GitHubClient(TOKEN, new FixtureTransport([byName("contents-missing")]));
  assert.equal(await without.hasColoDesign({ owner: "colo-org", repo: "payments-web" }), false);
});

test("hasColoDesign refuses to answer a non-200/404 with a guess", async () => {
  const serverError = new GitHubClient(TOKEN, {
    request: async () => ({
      status: 500,
      body: new TextEncoder().encode(JSON.stringify({ message: "boom" })),
    }),
  });
  await assert.rejects(
    serverError.hasColoDesign({ owner: "colo-org", repo: "payments-web" }),
    /colo-design.json 확인/,
  );

  const unauthorized = new GitHubClient(TOKEN, {
    request: async () => ({
      status: 401,
      body: new TextEncoder().encode(JSON.stringify({ message: "Bad credentials" })),
    }),
  });
  await assert.rejects(
    unauthorized.hasColoDesign({ owner: "colo-org", repo: "payments-web" }),
    /토큰이 유효하지 않거나 만료/,
  );
});

test("inspectRepo judges one repo from the two calls the picker needs", async () => {
  const calls = [];
  const client = new GitHubClient(TOKEN, {
    request: async (input) => {
      calls.push(input.url);
      if (input.url === "/repos/colo-org/payments-web") {
        return {
          status: 200,
          body: new TextEncoder().encode(
            JSON.stringify({
              default_branch: "develop",
              permissions: { push: false },
            }),
          ),
        };
      }
      return {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify({ name: "colo-design.json" })),
      };
    },
  });

  const inspection = await client.inspectRepo({
    owner: "colo-org",
    repo: "payments-web",
  });
  assert.deepEqual(inspection, {
    hasColoDesign: true,
    canPush: false,
    defaultBranch: "develop",
  });
  assert.deepEqual(calls, [
    "/repos/colo-org/payments-web",
    "/repos/colo-org/payments-web/contents/colo-design.json",
  ]);
});
