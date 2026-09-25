import assert from "node:assert/strict";
import { test } from "node:test";
// `../dist` 임포트인 이유: repo-bringup 은 형제를 `.js` 지정자로 부르므로 src
// 직접 로드가 그 지정을 못 고친다(bundled-tools.test.ts 와 같은 길).
import { repoCommandEnv } from "../dist/repo-bringup.js";

test("레포 명령 환경은 pnpm 11 의 run 앞 자동 설치를 끈다 (N1)", () => {
  const env = repoCommandEnv({});
  // pnpm 11 은 verify-deps-before-run: "install" 이 기본이라 락파일 없는
  // 레포에서 `pnpm dev` 가 스스로 설치를 돌린다 — 이 키만 끈다.
  assert.equal(env.pnpm_config_verify_deps_before_run, "false");
});

test("물려받은 참값도 덮어쓴다 — 사용자 셸의 설정이 새어 들어와도", () => {
  const env = repoCommandEnv({ pnpm_config_verify_deps_before_run: "install" });
  assert.equal(env.pnpm_config_verify_deps_before_run, "false");
});

test("그 밖의 약속은 그대로 — 과금 키는 없고 번들 경로는 PATH 앞자리다", () => {
  const env = repoCommandEnv({
    ANTHROPIC_API_KEY: "sk-should-not-survive",
    COLO_DESIGN_EXTRA_PATH: "/opt/colo-design/bin",
    COLO_DESIGN_PORT: "7823",
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.ok(env.PATH?.startsWith("/opt/colo-design/bin"), `PATH=${env.PATH}`);
  assert.equal(env.COLO_DESIGN_PORT, "7823");
});
