import { isAbsolute } from "node:path";

/** 앱이 대신 지울 수 있는 파일의 끝 — 웹의 isInviteFile 과 같은 잣대다. */
const INVITE_SUFFIX = ".colo-invite";

/**
 * 초대 파일 지우기(PLAN-UI U11)를 거절할 이유 — 없으면 null. 렌더러가 건넨
 * 값은 믿지 않는다: 문자열이고, 절대 위치이고, `.colo-invite` 로 끝나야 한다.
 * 이 문 뒤에서도 지우기는 OS 휴지통으로 옮기기뿐이다(되살릴 수 있게).
 */
export function inviteDiscardRefusal(path: unknown): string | null {
  if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) {
    return "지울 초대 파일을 찾지 못했어요.";
  }
  if (!isAbsolute(path)) return "지울 초대 파일을 찾지 못했어요.";
  if (!path.endsWith(INVITE_SUFFIX)) return "초대 파일만 지울 수 있어요.";
  return null;
}
