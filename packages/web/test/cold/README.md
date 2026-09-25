# 콜드 리뷰 스크립트

맥락 없는 검토자가 기획자 역할로 아홉 과제를 수행한 기록(PLAN-UI 0.3)을 되돌릴 수
있게 옮겨 둔 것이다. **지금은 목업 `mockups/redesign.html` 을 겨눈다** — PLAN-UI
단계 8 이 개발 실행의 실제 셸로 다시 겨눈다.

- `run.js` — 이미 떠 있는 Chrome(`--remote-debugging-port=9333`)에 붙어 과제 파일
  하나를 `page` · `shot` · `wait` · `ctx` 를 받는 함수 몸으로 돌린다.
  `node packages/web/test/cold/run.js packages/web/test/cold/t1a.js`
- `t<과제><차례>.js` — 과제 하나의 한 걸음. 번호는 과제(1~11), 글자는 순서다.
- 스크린샷은 `/tmp/ui/cold/`, 페이지 오류는 `/tmp/ui/errors.log` 에 쌓인다.

전역 Playwright 가 필요하다 — `run.js` 가 `~/.local/lib/node_modules/playwright` 를
절대 경로로 부른다(`npm i -g --prefix ~/.local playwright`). 레포의 의존성이 아니다.

`pnpm test` 에는 들지 않는다 — 그 glob 은 `packages/web/test/*.test.ts` 뿐이고, 이
폴더의 파일은 `.test.ts` 가 아니다. biome 도 이 폴더를 보지 않는다(`biome.json`):
과제 파일은 함수 몸이라 모듈로 읽히지 않고, 기록 그대로 두어야 한다.

## 격리 데몬으로 실제 셸을 돌리기 (2026-09-25)

`smoke-daemon.sh <repo-dir> [7899] [29174]` 가 사용자의 `~/.colo-design` 을 건드리지 않는
데몬을 띄운다 — 임시 HOME, 픽스처 레포(`scripts/fixture-repo.mjs`), 가짜 `claude`(로그인만
통과), GitHub 픽스처, 에이전트 자동 업데이트 끔. 출력의 `URL …` 줄을 브라우저(또는
`drive.cjs <url> <steps.js>` · `shot.cjs <url> <out.png>`)에 준다. `SMOKE_EMPTY=1` 은
프로젝트 없는 첫 실행, `SMOKE_REAL_CLAUDE=1` 은 사용자의 실제 Claude 로그인(구독을
태운다). 먼저 `pnpm build`, 그리고 `packages/web` 에서 `node_modules/.bin/vite --port 29174`.
