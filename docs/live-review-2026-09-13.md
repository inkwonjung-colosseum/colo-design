# Colo Design 실사 리뷰 — 2026-09-13

브라우저 개발 경로에서 앱을 직접 실행해 첫 접속부터 저장·되돌리기까지 실제
사용자처럼 한 번씩 써 본 실사 기록이다. 이 날 발견해 고친 결함 세 가지와
검증 결과를 남긴다.

## 실행 방법과 격리

- `pnpm build` 후 `COLO_DESIGN_PORT`, `COLO_DESIGN_PROJECTS_SETTINGS`,
  `COLO_DESIGN_PROJECTS_DIR`, `COLO_DESIGN_CREDENTIAL_STORE=memory` 로
  스칼치 구성의 두 번째 데몬을 띄우고, 별도 포트의 `vite` 로 웹을 띄웠다.
  사용자의 실제 `~/.colo-design` 프로젝트 레지스트리와 키체인은 읽지도
  쓰지 않는다(데몬 설정 파일은 존재할 때 다시 쓰지 않으므로 읽기만 했다).
- 연결 레포는 `packages/daemon/test/fixture-repo.mjs` 가 만드는 로컬 bare
  원격을 `주소로 추가` 로 연결했다. 저장·넘기기의 push 도 전부 로컬 원격으로
  간다. 채팅 턴은 실제 Claude CLI(사용자 구독)로 돌렸다.

## 통과한 것

- 온보딩 마법사: Claude Code·git·Node·pnpm 게이트가 실제 CLI 를 읽어 통과,
  GitHub 게이트는 토큰 없음 = 주의. 잘못된 토큰의 한국어 오류 안내.
- 프로젝트 추가: 주소 입력 → 명령 실행 동의 체크 → 클론 → 설치 → 미리보기
  ready. 이후 사이드바에서 같은 흐름이 `+ 새 프로젝트` 로도 열린다.
- 채팅: 실제 턴 스트리밍, 사이드바 표식(작업 중 → 확인 대기 → 방금),
  AskUserQuestion 이 확인 카드로 렌더되고 답을 고르면 턴이 이어진다.
  기계 턴(넘기기 전 점검)이 마커 카드로 그려진다.
- 미리보기: 화면 선택기 → 상태 칩(기본/비어 있음) → 실제 목 데이터 렌더,
  모바일·태블릿 폭 전환, 새 창, 새로 고침. 핀 오버레이는 데스크톱 전용
  (README 대로 — 브라우저 경로는 화면 목록·이동만).
- 저장: 저장 검토 대화상자(diff 자세히 보기 + 저장 메모) → check 게이트 →
  `colo-design/<날짜>-1` 브랜치 생성·push, main 은 건드리지 않는다.
  검토한 파일만 커밋됐다. 상태 칩: 변경 없음 → 저장 안 함 N건 → 저장됨.
- 최신화, 저장 기록, 넘기기(토큰 없음 = 설정 열기 안내와 함께 한국어로
  거절 — 설계된 실패), 되돌리기, 이름 바꾸기, 지우기 대화상자, 테마 19종,
  ⌘K 팔레트, ⌘/ 단축키 시트.
- 데스크톱(desktop-smoke): 창 생성, in-process 데몬 /health(protocol v13),
  planner 셸 렌더까지 직접 확인.

## 이 날 고친 결함

### 1. 되돌리기(이 답변 이전으로 되돌리기)가 항상 2분 뒤 "daemon did not respond"

- **증상.** 답변 카드의 되돌리기를 누르면 파일은 돌아가는데(상태 칩 갱신,
  클론의 git 상태 변경 모두 정상) 응답이 UI 에 닿지 않아 120초 뒤 대화에
  `daemon did not respond` 오류 카드가 떨어지고, 체크포인트 목록 갱신도
  함께 유실된다.
- **원인.** 선로 계약의 필드 충돌. `call()` 이 `JSON.stringify({ id, ...payload })`
  로 보내는데 `repo.checkpoint.restore` 의 payload 도 체크포인트 식별자를
  `id` 로 실는다 — 스프레드 순서상 상관 id 가 payload 로 덮여, 서버가 회신을
  그 `id` 로 돌려도 클라이언트의 대기 중 호출과 영영 매칭되지 않는다.
  publish-e2e 는 우연히도 상관 id 자리에 체크포인트 id 를 써 왔기에 이
  충돌이 스위트를 전부 통과했다. wire 재현: 복원 요청이 응답 없이 40초+
  유지(수정 전) → 필드명 분리 후 192ms 로 `ok`.
- **수정.** `protocol` — 메시지 필드를 `checkpoint` 로 개명하고
  `PROTOCOL_VERSION` 12 → 13. `server.ts` — `message.checkpoint` 로 읽도록.
  `daemon-client.ts` — 필드명 정리에 더해 `call()` 이 상관 id 를 항상
  마지막에 쓰도록 순서를 뒤집어 같은 부류의 결함이 조용히 재발하지 않게
  했다. `publish-e2e` 도 새 계약에 맞춰 상관 id 를 분리해 넣었다.

### 2. 새로고침하면 마지막 대화가 "빈 대화"로 열린다

- **증상.** 앱을 새로고침하면 기록이 가득한 대화가 선택돼 있는데 트랜스크립트는
  비어 있다 — "메시지를 보내면 대화가 여기에 이어집니다" 영웅 상태.
- **원인.** `useSessions` 의 마지막 스레드 복원이 `setActiveId(saved)` 만 하고
  대화록을 읽지 않았다. 히스토리 적재는 `open()` 에만 있었다.
- **수정.** `open()` 의 적재를 `loadHistory()` 로 뽑아 복원 경로에서도 같은
  적재를 지나게 했다. 빈 대화 판정(`historyFailed`)도 두 경로가 같이 쓴다.
- **검증.** 새로고침 후 트랜스크립트가 스스로 채워진다(라이브 확인).

### 3. GitHub 토큰을 잘못 넣으면 마법사에 갇힌다

- **증상.** 온보딩에서 유효하지 않은 토큰을 연결하는 순간 GitHub 단계가
  `실패` 가 되고 `시작하기` 버튼이 사라진다. 카드에는 토큰을 치우는
  수단이 없어, 토큰 없이도 쓸 수 있는 제품(주소로 직접 추가)에
  영구 갇힌다.
- **원인.** `checkGitHub` 이 저장된 토큰의 401 을 `fail` 로 판정. 설계 문서
  (파일 머리 주석과 README)는 "토큰이 없는 것은 차단이 아니라 주의"라며
  warn 은 "이유를 말하고 지나가게 한다"고 못박는다. 기능적으로 거절된
  토큰은 없는 토큰과 같다.
- **수정.** `checkGitHub` — `!me.ok` 를 `warn` 으로 판정하고 상세에 이유와
  "그대로 시작해도 된다"는 말을 담는다. 폼은 열려 다시 붙여넣기를
  받는다. 단위 테스트를 하나 추가했다(401 → warn, 시작 안내 포함).

## 고치지 않고 기록해 둔 관찰

- Claude 가 화면 조사를 서브에이전트+`ScheduleWakeup` 으로 돌리는 워크플로를
  택하면 도구 쪽 실패 카드는 접힌 채로 남고, 최종 말은 "백그라운드에서
  완료되면 알려 드릴게요"처럼 읽혀 기획자가 기다리게 된다(이번 실사에서는
  같은 대화 안에서 조사가 이어져 마무리 됐다). 시나리오별 후속 설계 과제.
- 저장 검토의 요약기(`repo.summarize`)는 실제 Claude 턴이라 3초 뒤 폴백
  문구가 먼저 보이고 늦게 도착해 교체된다 — 설계대로지만 느린 기계에서는
  폴백 문구로 저장을 누르게 될 수 있다.
- 데스크톱 Electron 스위트(desktop-comments, desktop-smoke)는 이 세션의
  이 머신에서 playwright ↔ Electron CDP 연결이 자주 시간 초과됐다. 수동
  실행으로는 앱이 protocol v13 으로 정상 기동했다. smoke 의 `.onboarding`
  대기는 "모든 게이트가 통과한 기계에서는 마법사가 뜨지 않는다"는
  기계 의존 전제를 깔고 있다.

## 이 날의 검사 결과

- `pnpm build`, `pnpm typecheck` 전 패키지 통과.
- test:unit 51/51 · test:onboard-unit 27/27(결함 1 회귀 포함) ·
  publish-e2e 69/69(새 계약의 되돌리기 절 포함) · test:web-unit 51/51 ·
  test:projects 26 · test:rewind · test:bootstrap · test:repo ·
  test:onboarding · test:settings · test:sidebar-ui · test:port-busy-ui ·
  test:publish-ui · test:onboarding-ui · theme-contrast 306 쌍 전부 통과.
- desktop-unit 20 통과. desktop-comments·desktop-smoke 은 위의 환경 사유로
  이 세션에서는 끝까지 못 돌렸다.

## 같은 날 늦은 후속 — smoke 의 환경 사유는 기계가 아니라 격리 결함이었다

- desktop-smoke 이 이 머신에서만 죽던 원인: Playwright 은 Electron 의
  userData 를 격리하지 않아 앱이 개발 머신의 진짜 credentials.json 으로
  시작했다 — GitHub 게이트가 통과하면 "fresh machine" 전제가 깨져 마법사가
  뜨지 않는다(CI 러너엔 토큰이 없어 통과). 실제 레지스트리(~/.colo-design)
  도 같은 방식으로 새어 목록에 실려 있었다.
- 수정: `COLO_DESIGN_DESKTOP_SMOKE` 에 임시 폴더 경로를 실으면 main.ts 가
  `app.setPath("userData", …)` 로 옮긴다(레포의 `COLO_DESIGN_DESKTOP_UNIT`
  훅과 같은 부류). 테스트는 레지스트리도 `COLO_DESIGN_PROJECTS_SETTINGS`·
  `COLO_DESIGN_PROJECTS_DIR` 로 임시 폴더에 둔다. 3회 연속 9/9.
- 되돌리기 응답 불일치(결함 1)와 새로고침 대화록(결함 2)은 수정 뒤
  lanes L1·L2·L3 를 CI 와 같은 순차 모양으로 재확인했다. projects-e2e 의
  off-screen 집계 검사는 로컬 4레인 동시 실행 아래서만 타임아웃(90초)이
  나고, 단독·순차 재실행으로는 연속 통과 — 부하 플레이크 로 기록해 둔다.
- 버전을 0.3.2 로 올려 묶는다(corepack 번들 결함 수정 포함).
