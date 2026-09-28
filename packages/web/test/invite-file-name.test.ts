import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-labels.test.ts 와 같은 모양).
import { isInviteFile } from "../src/lib/invite-bus.ts";
import { readInviteFile } from "../src/lib/invite-import.ts";

/** 이름만 가진 가짜 파일 — 내용은 JSON 이 아니라 내용 문의 정해진 오류를 낸다. */
function named(name: string): File {
  return new File(["초대장이 아닌 내용"], name, { type: "text/plain" });
}

test("isInviteFile: 두 확장자를 다 받는다 (개명 1단계)", () => {
  assert.equal(isInviteFile(named("회원 관리.nova-invite")), true);
  assert.equal(isInviteFile(named("회원 관리.colo-invite")), true); // read-legacy — 옛 확장자
  assert.equal(isInviteFile(named("사진.png")), false);
  assert.equal(isInviteFile(named("a.colo-invite.txt")), false);
  // 대소문자는 구분한다 — 데스크톱 지우기(invite-discard)와 같은 잣대.
  assert.equal(isInviteFile(named("a.NOVA-INVITE")), false);
});

test("readInviteFile: 초대 파일이 아니면 확장자를 말하지 않는 문장으로 거절한다", async () => {
  const read = await readInviteFile(named("사진.png"));
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.error, "초대 파일이 아닙니다 — 개발자가 보낸 파일을 선택해 주세요.");
});

test("readInviteFile: 두 확장자는 이름 문을 지나 내용 문에서 답한다 (개명 1단계)", async () => {
  const names = ["회원 관리.nova-invite", "회원 관리.colo-invite"]; // read-legacy — 옛 확장자
  for (const name of names) {
    const read = await readInviteFile(named(name));
    assert.equal(read.ok, false, name);
    if (read.ok) continue;
    assert.equal(
      read.error,
      "초대 파일을 읽지 못했습니다 — 개발자에게 파일을 다시 보내달라고 요청하세요.",
      name,
    );
  }
});
