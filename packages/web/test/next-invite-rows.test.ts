import assert from "node:assert/strict";
import { test } from "node:test";
import type { InviteRow, InviteRowTarget } from "@colo-design/protocol";
// 순수 모듈 — src 에서 곧장 읽는다(next-labels.test.ts 와 같은 모양).
import { L } from "../src/next/labels.ts";
import { inviteRowsCopy, inviteUpdateChanges } from "../src/next/lib/invite-rows.ts";

const MEMBER: InviteRowTarget = {
  slug: "member",
  name: "회원 관리",
  repoUrl: "https://github.com/team/member.git",
  baseBranch: "main",
  reviewers: ["dev1"],
  commandsApproved: true,
};

const SETTLE: InviteRowTarget = {
  slug: "settle",
  name: "정산",
  repoUrl: "https://github.com/team/settle.git",
  baseBranch: "main",
};

/** 초대장의 프로젝트 값 — 짝과 대조되는 부분만 바꿔 쓴다. */
function inviteProject(overrides: Partial<InviteRow["project"]> = {}): InviteRow["project"] {
  return {
    name: "회원 관리 서비스",
    repoUrl: "https://github.com/team/member.git",
    baseBranch: "main",
    ...overrides,
  } as InviteRow["project"];
}

test("inviteRowsCopy: 새로 행은 이름과 안내 한 줄", () => {
  const { rows, nothingChanged } = inviteRowsCopy(
    [{ project: inviteProject({ repoUrl: "https://github.com/team/new.git" }), action: "add" }],
    L,
    [MEMBER, SETTLE],
  );
  assert.equal(nothingChanged, false);
  assert.equal(rows[0]?.line, "새로 · 회원 관리 서비스");
  assert.equal(rows[0]?.sub, "처음 열 때 준비에 몇 분 걸려요");
});

test("inviteRowsCopy: 바뀜 행은 무엇이 바뀌었는지까지 한 줄에", () => {
  const row = {
    project: inviteProject({ baseBranch: "develop" }),
    action: "update",
    slug: "member",
    currentName: "회원 관리",
  } as const;
  const { rows } = inviteRowsCopy([row], L, [MEMBER, SETTLE]);
  assert.equal(
    rows[0]?.line,
    "바뀜 · 회원 관리 · 기본 가지 main → develop · 받을 개발자 명단이 바뀌어요",
  );
});

test("inviteRowsCopy: 바뀐 것이 없으면 그대로 행, 판 전체는 연결 코드만", () => {
  const rows: InviteRow[] = [
    {
      project: inviteProject({ reviewers: ["dev1"], approveCommands: true }),
      action: "keep",
      slug: "member",
      currentName: "회원 관리",
    },
    {
      project: {
        ...inviteProject({ repoUrl: "https://github.com/team/settle.git" }),
        name: "정산팀",
      },
      action: "keep",
      slug: "settle",
      currentName: "정산",
    },
  ];
  const copy = inviteRowsCopy(rows, L, [MEMBER, SETTLE]);
  assert.deepEqual(
    copy.rows.map((row) => row.line),
    ["그대로 · 회원 관리", "그대로 · 정산"],
  );
  assert.equal(copy.nothingChanged, true);
});

test("inviteRowsCopy: 이름은 사용자가 지은 것이 이긴다", () => {
  const { rows } = inviteRowsCopy(
    [
      {
        project: inviteProject(),
        action: "update",
        slug: "member",
        currentName: "내 회원 화면",
      },
    ],
    L,
    [MEMBER],
  );
  assert.equal(rows[0]?.name, "내 회원 화면");
});

test("inviteUpdateChanges: 명령 허용이 새로 켜지면 문장이 더해진다", () => {
  const row = {
    project: inviteProject({ approveCommands: true }),
    action: "update",
    slug: "settle",
    currentName: "정산",
  } as const;
  const changes = inviteUpdateChanges(row, L, { ...SETTLE, commandsApproved: false });
  assert.deepEqual(changes, ["명령 실행이 미리 허용됐어요"]);
});

test("inviteRowsCopy: 빈 초대장은 그대로도 아니다", () => {
  const copy = inviteRowsCopy([], L, []);
  assert.deepEqual(copy.rows, []);
  assert.equal(copy.nothingChanged, false);
});
