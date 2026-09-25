/**
 * 데몬이 띄우는 에이전트 자식의 환경 (PLAN-UI U12). Claude Code 는 스스로
 * 업데이트한다 — 앱의 `업데이트` 줄과 CLI 의 자기 업데이터가 둘 다 돌면 서로
 * 바꾸는 세계가 되므로, 데몬이 띄우는 모든 Claude 자식(세션 · 단답 턴 · 로그인
 * · 설치)에서 자기 업데이트를 끈다. Codex 는 이 변수를 읽지 않으니 같은 환경을
 * 받아도 해가 없다.
 */

/** 자기 업데이트를 끈 환경 — 받은 객체는 건드리지 않고 새 객체를 돌려준다. */
export function withoutSelfUpdate(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, DISABLE_AUTOUPDATER: "1" };
}
