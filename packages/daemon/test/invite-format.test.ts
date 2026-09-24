import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inviteUpdatePatch,
  normalizeInvite,
  planInviteRows,
  readInviteJson,
  repoKey,
  sameRepo,
} from "@colo-design/protocol";

// 쓰는 쪽은 site 의 형식 모듈(.mjs)이다 — 패키지 바깥의 파일 경로라 정적 import
// 로는 쓸 수 없고, 데몬 테스트는 typecheck 대상이 아니므로 경로로 직접 들어온다.
const { buildInvite, sealInvite } = await import(
  new URL("../../../site/invite-format.mjs", import.meta.url).href
);

function sampleInvite() {
  return buildInvite({
    repoUrl: "https://github.com/org/repo.git",
    name: "회원 관리",
    token: "github_pat_TEST123",
    author: "김기획",
    reviewers: ["dev1", "dev2"],
  });
}

test("봉인 왕복 — build → seal → JSON → readInviteJson 이 원본을 돌려준다", async () => {
  const invite = sampleInvite();
  const envelope = await sealInvite(invite);
  const read = await readInviteJson(JSON.stringify(envelope));
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.value, invite);
});

test("봉인된 텍스트에는 토큰도 레포 주소도 드러나지 않는다", async () => {
  const envelope = await sealInvite(sampleInvite());
  const text = JSON.stringify(envelope);
  assert.equal(text.includes("github_pat_TEST123"), false);
  assert.equal(text.includes("org/repo"), false);
  assert.equal(envelope.v, 3);
});

test("data 한 글자가 바뀌면 봉인 실패로 말한다", async () => {
  const envelope = await sealInvite(sampleInvite());
  const flipped =
    envelope.data[0] === "A" ? `B${envelope.data.slice(1)}` : `A${envelope.data.slice(1)}`;
  const read = await readInviteJson(JSON.stringify({ ...envelope, data: flipped }));
  assert.deepEqual(read, { ok: false, reason: "sealed" });
});

test("평문 v2 JSON 은 그대로 통과한다 — 이미 보낸 초대장이 계속 열린다", async () => {
  const invite = {
    v: 2,
    name: "회원 관리",
    repoUrl: "https://github.com/org/repo.git",
    baseBranch: "main",
    token: "github_pat_TEST123",
    approveCommands: true,
    authorName: "김기획",
    reviewers: ["dev1", "dev2"],
    readme: "가져온 뒤 지워 주세요.",
  };
  const read = await readInviteJson(JSON.stringify(invite));
  assert.deepEqual(read, { ok: true, value: invite });
});

test("문법이 깨진 텍스트는 json 실패로 말한다", async () => {
  const read = await readInviteJson("{oops");
  assert.deepEqual(read, { ok: false, reason: "json" });
});

// ---------------------------------------------------------------------------
// 안쪽 v3 — 초대장 하나가 프로젝트 여러 개를 싣는다
// ---------------------------------------------------------------------------

test("여러 프로젝트 봉인 왕복 — normalizeInvite 가 같은 모양을 돌려준다", async () => {
  const invite = buildInvite({
    token: "github_pat_TEST123",
    author: "김기획",
    projects: [
      {
        repoUrl: "https://github.com/org/a.git",
        name: "회원 관리",
        baseBranch: "develop",
        reviewers: ["dev1"],
        instructions: "  목 데이터는 a.mock.ts 에만 둔다  ",
      },
      { repoUrl: "https://github.com/org/b.git", name: "정산" },
    ],
  });
  const read = await readInviteJson(JSON.stringify(await sealInvite(invite)));
  assert.equal(read.ok, true);
  if (!read.ok) return;
  const normalized = normalizeInvite(read.value);
  assert.deepEqual(normalized, {
    ok: true,
    invite: {
      token: "github_pat_TEST123",
      authorName: "김기획",
      readme: invite.readme,
      projects: [
        {
          repoUrl: "https://github.com/org/a.git",
          name: "회원 관리",
          baseBranch: "develop",
          reviewers: ["dev1"],
          instructions: "목 데이터는 a.mock.ts 에만 둔다",
          approveCommands: true,
        },
        {
          repoUrl: "https://github.com/org/b.git",
          name: "정산",
          baseBranch: "main",
          approveCommands: true,
        },
      ],
    },
  });
});

test("옛 단일 인자 buildInvite 는 프로젝트 하나짜리 안쪽 v4 가 된다", () => {
  const invite = sampleInvite();
  assert.deepEqual(invite, {
    v: 4,
    token: "github_pat_TEST123",
    authorName: "김기획",
    readme: invite.readme,
    projects: [
      {
        repoUrl: "https://github.com/org/repo.git",
        name: "회원 관리",
        baseBranch: "main",
        reviewers: ["dev1", "dev2"],
        approveCommands: true,
      },
    ],
  });
});

test("안쪽 v1 표본의 정규화 — parseInvite 규칙 그대로(name 비면 레포 이름, v1 은 authorName·reviewers 무시)", () => {
  const normalized = normalizeInvite({
    v: 1,
    name: "  ",
    repoUrl: "https://github.com/org/legacy.git",
    token: " github_pat_OLD ",
    approveCommands: false,
    authorName: "옛날 이름",
    reviewers: ["nope"],
  });
  assert.deepEqual(normalized, {
    ok: true,
    invite: {
      token: "github_pat_OLD",
      projects: [
        {
          repoUrl: "https://github.com/org/legacy.git",
          name: "legacy",
          baseBranch: "main",
          approveCommands: false,
        },
      ],
    },
  });
});

test("안쪽 v2 표본의 정규화 — authorName·reviewers 를 실고 baseBranch 기본값을 채운다", () => {
  const normalized = normalizeInvite({
    v: 2,
    name: "회원 관리",
    repoUrl: "https://github.com/org/repo.git",
    token: "github_pat_TEST123",
    authorName: "김기획",
    reviewers: ["dev1", " ", 3, "dev2"],
  });
  assert.ok(normalized.ok);
  if (!normalized.ok) return;
  assert.deepEqual(normalized.invite.projects, [
    {
      repoUrl: "https://github.com/org/repo.git",
      name: "회원 관리",
      baseBranch: "main",
      reviewers: ["dev1", "dev2"],
      approveCommands: true,
    },
  ]);
  assert.equal(normalized.invite.authorName, "김기획");
});

test("각 한도 초과는 'limit' 으로 말한다 — 어느 프로젝트의 무엇인지 함께", () => {
  const base = {
    v: 3,
    token: "t",
    projects: [{ repoUrl: "https://github.com/o/r.git", name: "r" }],
  };
  const project = (extra: Record<string, unknown>) => ({
    repoUrl: "https://github.com/o/r.git",
    name: "r",
    ...extra,
  });
  const eleven = Array.from({ length: 11 }, (_, i) => `dev${i}`);
  const cases: Array<[unknown, RegExp]> = [
    // 21개 — 프로젝트 상한(20)을 넘는다.
    [
      {
        v: 3,
        token: "t",
        projects: Array.from({ length: 21 }, (_, i) => ({
          repoUrl: `https://github.com/o/r${i}.git`,
          name: `r${i}`,
        })),
      },
      /최대 20개/,
    ],
    [{ ...base, projects: [project({ name: "r".repeat(65) })] }, /이름이 64자/],
    [{ ...base, projects: [project({ baseBranch: "b".repeat(129) })] }, /기본 가지가 128자/],
    [{ ...base, projects: [project({ reviewers: eleven })] }, /리뷰어가 10명/],
    [{ ...base, projects: [project({ reviewers: ["x".repeat(81)] })] }, /리뷰어/],
    [{ ...base, projects: [project({ instructions: "i".repeat(10_001) })] }, /지침이 10000자/],
  ];
  for (const [value, pattern] of cases) {
    const normalized = normalizeInvite(value);
    assert.equal(normalized.ok, false, JSON.stringify(value).slice(0, 60));
    if (normalized.ok) return;
    assert.equal(normalized.reason, "limit");
    assert.match(normalized.detail ?? "", pattern);
  }
});

test("같은 레포가 목록에 두 번 있으면 뒤의 것을 버린다", () => {
  const normalized = normalizeInvite({
    v: 3,
    token: "t",
    projects: [
      { repoUrl: "https://github.com/org/repo.git", name: "첫째" },
      { repoUrl: "git@github.com:org/repo.git", name: "둘째" },
      { repoUrl: "https://github.com/Org/Repo/", name: "셋째" },
      { repoUrl: "https://github.com/org/other.git", name: "다른 레포" },
    ],
  });
  assert.ok(normalized.ok);
  if (!normalized.ok) return;
  assert.deepEqual(
    normalized.invite.projects.map((entry) => entry.name),
    ["첫째", "다른 레포"],
  );
});

test("sameRepo — 스킴·ssh·.git·대소문자·사용자 정보를 무시하고 owner 가 다르면 다르다", () => {
  assert.equal(sameRepo("https://github.com/org/repo", "git@github.com:org/repo.git"), true);
  assert.equal(
    sameRepo("https://github.com/Org/Repo.git", "https://user:pat@github.com/org/repo"),
    true,
  );
  assert.equal(sameRepo("https://github.com/org/repo/", "https://github.com/org/repo"), true);
  assert.equal(sameRepo("https://www.github.com/org/repo", "github.com/org/repo"), true);
  assert.equal(sameRepo("https://github.com/org/repo", "https://github.com/other/repo"), false);
  assert.equal(sameRepo("https://github.com/a/repo", "https://github.com/b/repo"), false);
  assert.equal(repoKey("ssh://git@example.com/team/repo.git"), "example.com/team/repo");
  assert.equal(repoKey("https://github.com/org/repo/tree/main"), null);
});

test("중복 제거는 한도보다 먼저다 — 21개에 중복이 섞여 있으면 거절하지 않는다", () => {
  const projects = Array.from({ length: 19 }, (_, i) => ({
    repoUrl: `https://github.com/o/r${i}.git`,
    name: `r${i}`,
  }));
  const normalized = normalizeInvite({
    v: 3,
    token: "t",
    projects: [
      ...projects,
      // 같은 레포의 다른 표기 둘 — 세면 21개지만 실제로는 19개다.
      { repoUrl: "https://github.com/o/r0.git", name: "r0-중복" },
      { repoUrl: "git@github.com:o/r0.git", name: "r0-또중복" },
    ],
  });
  assert.ok(normalized.ok);
  if (!normalized.ok) return;
  assert.equal(normalized.invite.projects.length, 19);
});

test("이름이 비었을 때는 레포 이름이 기본값이다 — 긴 주소가 이름이 되지 않는다", () => {
  const github = normalizeInvite({
    v: 2,
    name: " ",
    repoUrl: "https://github.com/org/very-long-repository-name.git",
    token: "t",
  });
  assert.ok(github.ok);
  if (!github.ok) return;
  assert.equal(github.invite.projects[0]?.name, "very-long-repository-name");
  // 이름이 64자를 넘으면 잘린다 — 거절이 아니라 기본값이다.
  const odd = normalizeInvite({
    v: 2,
    name: "",
    repoUrl: "x".repeat(80),
    token: "t",
  });
  assert.ok(odd.ok);
  if (!odd.ok) return;
  assert.equal(odd.invite.projects[0]?.name, "x".repeat(64));
});

test("buildInvite 도 같은 레포를 한 번만 싣는다 — 세어 말한 수와 실제 수가 같다", () => {
  const invite = buildInvite({
    token: "t",
    projects: [
      { repoUrl: "https://github.com/org/a.git", name: "a" },
      { repoUrl: "git@github.com:org/a.git", name: "a-중복" },
      { repoUrl: "https://github.com/org/b.git", name: "b" },
    ],
  });
  assert.equal(invite.projects.length, 2);
  const normalized = normalizeInvite(invite);
  assert.ok(normalized.ok);
  if (!normalized.ok) return;
  assert.equal(normalized.invite.projects.length, invite.projects.length);
});

test("planInviteRows — 짝이 있으면 갱신, 없으면 추가, repoUrl 없는 기존 프로젝트는 짝짓지 않는다", () => {
  const invite = {
    token: "t",
    projects: [
      {
        repoUrl: "https://github.com/org/repo.git",
        name: "회원 관리",
        baseBranch: "main",
        approveCommands: true,
      },
      {
        repoUrl: "https://github.com/org/new.git",
        name: "새 레포",
        baseBranch: "main",
        approveCommands: true,
      },
    ],
  };
  const rows = planInviteRows(invite, [
    { slug: "s1", name: "옛 이름", repoUrl: "git@github.com:org/repo.git" },
    { slug: "s2", name: "주소 없는 프로젝트", repoUrl: null },
  ]);
  assert.deepEqual(rows, [
    {
      project: invite.projects[0],
      action: "update",
      slug: "s1",
      currentName: "옛 이름",
    },
    { project: invite.projects[1], action: "add" },
  ]);
});

test("로컬 절대 경로도 키를 받는다 — .git · 끝 슬래시 · file:// 이 서로 같다", () => {
  assert.equal(sameRepo("/tmp/x/beta.git", "/tmp/x/beta.git/"), true);
  assert.equal(sameRepo("/tmp/x/beta.git", "/tmp/x/beta"), true);
  assert.equal(sameRepo("file:///tmp/x/beta.git", "/tmp/x/beta"), true);
  assert.equal(sameRepo("/tmp/x/beta.git", "/tmp/x/gamma.git"), false);
  assert.equal(repoKey("/Tmp/X/Beta.GIT/"), "/tmp/x/beta");
});

test("planInviteRows 는 로컬 경로의 기존 프로젝트도 update 로 짝짓는다", () => {
  const invite = {
    token: "t",
    projects: [
      {
        repoUrl: "/tmp/x/beta.git",
        name: "베타 새이름",
        baseBranch: "main",
        approveCommands: true,
      },
    ],
  };
  const rows = planInviteRows(invite, [
    { slug: "s1", name: "베타 서비스", repoUrl: "file:///tmp/x/beta.git" },
  ]);
  assert.deepEqual(rows, [
    {
      project: invite.projects[0],
      action: "update",
      slug: "s1",
      currentName: "베타 서비스",
    },
  ]);
});

// ---------------------------------------------------------------------------
// 안쪽 v4 — 기계 몫(notify)과 프로젝트별 defaults·lifecycle (PLAN 단계 5)
// ---------------------------------------------------------------------------

test("v4 왕복 — notify·defaults·lifecycle 이 봉인과 정규화를 거쳐 살아남는다", async () => {
  const invite = buildInvite({
    token: "github_pat_TEST123",
    author: "김기획",
    notify: { slack: { kind: "webhook", url: "https://hooks.slack.com/services/T/B/X" } },
    projects: [
      {
        repoUrl: "https://github.com/org/a.git",
        name: "회원 관리",
        defaults: { provider: "claude", model: "sonnet", effort: "high" },
        lifecycle: { deleteMergedBranches: false, keepRejectedDays: 30, autoReply: false },
      },
      {
        repoUrl: "https://github.com/org/b.git",
        name: "정산",
        lifecycle: { submitFromChat: false },
      },
    ],
  });
  const read = await readInviteJson(JSON.stringify(await sealInvite(invite)));
  assert.ok(read.ok);
  if (!read.ok) return;
  const normalized = normalizeInvite(read.value);
  assert.deepEqual(normalized, {
    ok: true,
    invite: {
      token: "github_pat_TEST123",
      authorName: "김기획",
      readme: invite.readme,
      notify: { slack: { kind: "webhook", url: "https://hooks.slack.com/services/T/B/X" } },
      projects: [
        {
          repoUrl: "https://github.com/org/a.git",
          name: "회원 관리",
          baseBranch: "main",
          approveCommands: true,
          defaults: { provider: "claude", model: "sonnet", effort: "high" },
          lifecycle: { deleteMergedBranches: false, keepRejectedDays: 30, autoReply: false },
        },
        {
          repoUrl: "https://github.com/org/b.git",
          name: "정산",
          baseBranch: "main",
          approveCommands: true,
          lifecycle: { submitFromChat: false },
        },
      ],
    },
  });
});

test("v4 의 모르는 값은 버리고 나머지를 살린다 — 잘못된 effort·http 웹훅·범위 밖 일수", () => {
  const normalized = normalizeInvite({
    v: 4,
    token: "t",
    notify: { slack: { kind: "webhook", url: "http://hooks.slack.com/x" } },
    projects: [
      {
        repoUrl: "https://github.com/org/a.git",
        name: "a",
        defaults: { model: "sonnet", effort: "extreme" },
        lifecycle: { keepRejectedDays: 0, autoReply: false },
      },
    ],
  });
  assert.ok(normalized.ok);
  if (!normalized.ok) return;
  // http 웹훅은 통째로 버린다 — 연결 코드를 실은 알림이 평문으로 새는 일이 없게.
  assert.equal(normalized.invite.notify, undefined);
  const project = normalized.invite.projects[0];
  // 잘못된 effort 만 떨어지고 model 은 산다.
  assert.deepEqual(project?.defaults, { model: "sonnet" });
  // 범위 밖 일수만 떨어지고 autoReply 는 산다.
  assert.deepEqual(project?.lifecycle, { autoReply: false });
});

test("v4 의 봇 알림은 토큰과 채널이 함께 있을 때만 산다", () => {
  const bot = normalizeInvite({
    v: 4,
    token: "t",
    notify: { slack: { kind: "bot", token: "xoxb-1", channel: "#dev" } },
    projects: [{ repoUrl: "https://github.com/org/a.git", name: "a" }],
  });
  assert.ok(bot.ok);
  if (!bot.ok) return;
  assert.deepEqual(bot.invite.notify, {
    slack: { kind: "bot", token: "xoxb-1", channel: "#dev" },
  });
  // 채널이 빠진 봇은 없는 것이다.
  const half = normalizeInvite({
    v: 4,
    token: "t",
    notify: { slack: { kind: "bot", token: "xoxb-1" } },
    projects: [{ repoUrl: "https://github.com/org/a.git", name: "a" }],
  });
  assert.ok(half.ok);
  if (!half.ok) return;
  assert.equal(half.invite.notify, undefined);
});

test("inviteUpdatePatch — 이름·지침은 사용자의 것이라 보내지 않고, 없는 개발자 값은 지운다", () => {
  const patch = inviteUpdatePatch({
    repoUrl: "https://github.com/org/a.git",
    name: "초대장의 이름",
    baseBranch: "develop",
    approveCommands: true,
    instructions: "초대장의 지침",
    defaults: { model: "sonnet" },
  });
  assert.deepEqual(patch, {
    baseBranch: "develop",
    reviewers: null,
    defaults: { model: "sonnet" },
    lifecycle: null,
    approveCommands: true,
  });
  // 이름·지침은 패치에 아예 없다 — 사용자가 고른 값을 덮는 일이 없다.
  assert.equal("name" in patch, false);
  assert.equal("instructions" in patch, false);
});
