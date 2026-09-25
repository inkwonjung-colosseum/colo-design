import assert from "node:assert/strict";
import { test } from "node:test";

// 데스크톱 메인의 순수 문 — electron 을 부르지 않는 파일이라 경로로 직접 들어온다
// (invite-format.test.ts 가 site 의 형식 모듈을 읽는 것과 같은 길).
const { inviteDiscardRefusal } = await import(
  new URL("../../desktop/src/invite-discard.ts", import.meta.url).href
);

test("초대 파일 지우기 — 절대 위치의 .colo-invite 만 통과한다 (PLAN-UI U11)", () => {
  assert.equal(inviteDiscardRefusal("/Users/me/Downloads/회원 관리.colo-invite"), null);
  // 윈도 위치는 윈도에서만 절대 위치다.
  const windows = inviteDiscardRefusal("C:\\Users\\me\\Downloads\\a.colo-invite");
  assert.equal(windows === null, process.platform === "win32");
  for (const bad of [
    undefined,
    42,
    "",
    "   ",
    "a.colo-invite",
    "../a.colo-invite",
    "/Users/me/.ssh/id_rsa",
    "/Users/me/a.colo-invite.txt",
    "/Users/me/a.COLO-INVITE",
    "/Users/me/a\0.colo-invite",
  ]) {
    assert.notEqual(inviteDiscardRefusal(bad), null, String(bad));
  }
});
