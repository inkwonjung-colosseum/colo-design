# MCP 확장 계획 (미구현 설계 문서)

> 이 문서는 아직 구현되지 않은 것을 다룬다. 구현 시점에 이 문서가 사실과 다르면
> 코드가 이긴다 — 착지점 파일을 다시 읽고 이 문서를 고친 뒤 손을 대라.

## 배경 — MCP가 서는 자리

Colo Design의 목적은 비개발자가 채팅으로 연결 레포의 화면을 만들고 고치는 것이다.
에이전트의 일 루프는 말 이해 → 코드 수정 → **실제 앱에서 검증** → 반복이고, 품질
병목은 검증이다. `colo-browser` MCP가 정확히 그 자리를 맡고 있다. 확장 방향도
"에이전트가 검증할 수 있는 것의 범위를 넓힌다"로 골라진다.

### 판정 기준 — 무엇이 MCP이고 무엇이 아닌가

**"화면을 보고 만지는 능력"은 이 프로젝트의 몫, "서비스가 어떻게 돌아가는지의
내용(데이터·규칙·스크립트)"은 연결 레포의 몫.**

| 소속 | 근거 |
| --- | --- |
| 이 프로젝트 MCP | pane(`WebContentsView`)과 개발 서버의 수명주기는 데몬/데스크톱이 소유하는 장치다 |
| 연결 레포 | 시드 스크립트, 스택·디자인 시스템 규칙, 화면 위치는 레포의 자기 파일(`CLAUDE.md`, `package.json` scripts)이 정한다 — README "연결 레포 만들기"의 선언된 설계 |

## 현황 — colo-browser MCP (구현 완료)

실행 체인과 검증이 전부 실재한다:

```
에이전트 tools/call → browser-mcp.js (stdio 자식, 의존성 0)
  → POST /internal/browser (세션별 시크릿)
  → server.ts: op 화이트리스트 → op 큐(직렬) → 실행 직전 권한 판정(isRepoSurface)
  → PaneBrowserDriver (desktop): webContents.debugger(CDP)
  → 사용자가 보는 WebContentsView에 실제 조작
```

- 도구 16개: navigate · snapshot · screenshot · click · fill · type · press ·
  scroll · hover · select · drag · wait · console · evaluate · back · forward
- 테스트: `packages/daemon/test/browser-mcp.test.mjs`(진짜 stdio 자식),
  `browser-driver.test.mjs`(진짜 Electron), `acp-session.test.mjs`(주입 와이어),
  `drivers.test.mjs`(드라이버별 주입 경로 핀)

## 1단계 — 기존 MCP에 op 추가

공통 착지점(정착된 패턴 그대로):

1. `packages/daemon/src/browser-mcp.ts` `TOOLS` — 도구 정의
2. `packages/daemon/src/server.ts` `BROWSER_OPS` — 화이트리스트
   (읽기 op는 `BROWSER_QUIET_OPS`에도 — "브라우저 조작 중" 표시를 켜지 않음)
3. `server.ts` `callBrowserOp` switch — op → 드라이버 호출
4. `packages/daemon/src/preview-driver.ts` `BrowserDriver` — 인터페이스 시그니처
5. `packages/desktop/src/preview-driver.ts` `PaneBrowserDriver` — CDP 구현
6. 테스트: `browser-mcp.test.mjs` 도구 수 단언(16→N), `browser-driver.test.mjs`
   시나리오 추가

### 1-1. `browser_viewport` — 최우선

- **빈틈**: 모바일·태블릿 폭 검증 불가. 폭 토글은 UI에만 있고 에이전트는 못 돌린다.
- **왜 비용이 낮은가**: 폭 장치가 이미 공유로 설계돼 있다 — `PreviewViewport`
  타입("the 폭 toggle's, shared"), pane의 `viewportRect`가 그 폭을 그대로 쓴다.
  숨은 창 드라이버(`ElectronPreviewDriver.emulate`)에
  `Emulation.setDeviceMetricsOverride` 선례도 있다.
- **설계**: 인자 `{ viewport: "mobile" | "tablet" | "desktop" }`. pane의 폭을
  바꾸는 것은 사용자의 토글과 같은 장치를 같이 쓰는 것이므로 "사용자와 같은 화면"
  약속과 충돌 없다. 응답은 navigate와 같이 `{ snapshot }`.
- **주의**: UI 폭 토글과 상태가 한 곳에 모이도록 — 데스크톱의 토글 IPC와 같은
  상태원을 쓰게 한다(두 곳에서 따로 놀면 공유 약속이 깨진다).

### 1-2. `browser_upload`

- **빈틈**: 파일 입력(프로필 사진·첨부파일) 화면을 에이전트가 테스트 불가. 지금은
  파일 선택 대화상자에서 막힌다.
- **설계**: CDP `DOM.setFileInputFiles`로 붙임 없이 주입. 인자
  `{ ref, files: string[] }` — 파일은 에이전트가 exec 도구로 세션 cwd 안에 만든
  경로를 넘긴다. 드라이버에 파일 선택 가로채기 코드는 현재 없다(신규).
- **안전**: 경로는 세션 cwd 안으로 한정 — 밖이면 거절 결과(모델이 읽고 고침).
  조작 op이므로 레포 밖 표면에서는 권한 카드(기존 게이트가 그대로 처리).

### 1-3. `browser_inspect` (읽기)

- **빈틈**: "이 글자 좀 키워줘"에 현재값이 필요한데 snapshot에는
  role·name·value·states만 있고 위치·크기·스타일이 없다.
- **설계**: `{ ref }` → getBoundingClientRect + getComputedStyle(선별 속성).
  반환은 evaluate의 8KB JSON 캡 선례(`BROWSER_EVALUATE_JSON_LIMIT`) 따름.
- **선례**: 드라이버 안 actionability 검사가 이미 rect 평가 스니펫을 갖고 있다.
- `BROWSER_QUIET_OPS`에 추가(관찰이다).

### 1-4. `browser_network` (후순위)

- **빈틈**: "목록이 비어 있어요" 원인 진단. 콘솔에 `net` 줄로 부분 커버 중이라
  우선순위를 낮춘다 — 상태코드·메서드·소요시간의 구조화 목록이 필요해지면 추가.
- CDP Network 도메인 붙임. 읽기 op.

## 2단계 — preview-lifecycle: 별도 MCP 엔트리 (새 MCP 유일 후보)

**별도 엔트리로 간다** — 같은 자식에 넣지 않는 이유:

- 수명이 다르다. 브라우저 도구는 "pane이 있을 때만"(`forPane()`이 null이면
  도구 자체가 없다)이 계약인데, 서버 도구는 "항상"이다 — 데몬 개발 경로
  (browserDriverFactory 미주입)에서도 서버 진단은 필요하다.
- 시크릿을 와이어 수준에서 분리할 수 있다. 브라우저 MCP 자식이 서버를 만지면
  안 된다 — 능력별 자격 발급(`issueBrowserSecret`과 같은 패턴의
  `issuePreviewSecret`).

### 소유자는 이미 데몬 안에 있다

`repo-bringup.ts`(스폰·포트 자동 배정), `project-fleet.ts`(웜 서버 최대 2개·
스위치 펜스), `repo-config.ts`(레포의 스크립트 이름 해석). Electron 주입이
불필요 — 브라우저보다 단순하다.

### 추가할 것 4조각

1. **상태 모델 노출** — workspace별 bringup 상태(starting/up/failed/stopped,
   포트, URL, exit code, 실행한 스크립트)를 꺼내는 창구.
2. **로그 링 버퍼** — 자식 stdout/stderr는 이미 pipe로 받는다
   (`stdio: ["ignore","pipe","pipe"]`, `absorb`). workspace별 마지막 N줄
   (예: 500) 보관으로 확장하면 `logs`는 읽기만 하면 된다.
3. **와이어** — `server.ts`에 `POST /internal/preview` + `PREVIEW_OPS`
   화이트리스트(status·logs·restart). 시크릿은 브라우저 것과 분리 발급.
   세션→프로젝트→workspace 해석은 세션 스코프 패턴 그대로.
4. **도구 3개** — `preview_status` · `preview_logs`(읽기, 조작 중 표시 없음) /
   `preview_restart`(권한 카드 필수 — 사용자가 보고 있는 화면을 죽이는 조작.
   기존 `session/request_permission` 흐름, 55초 무응답 거절 재사용).

```
에이전트 tools/call → preview-mcp.js (stdio 자식 — 별도 엔트리)
  → POST /internal/preview (세션별 프리뷰 시크릿 — 브라우저 시크릿과 별개)
  → server.ts: PREVIEW_OPS 화이트리스트 → restart는 권한 카드
  → repo-bringup / project-fleet (데몬이 이미 소유한 수명주기)
```

### 구현 시 손대는 파일 목록

- `packages/daemon/src/preview-mcp.ts` — 신규 stdio 서버(browser-mcp.ts와 같은
  골격: readline JSON-RPC, 실패도 isError 텍스트)
- `packages/daemon/src/preview-launch.ts` — 기동 명세 + claude/acp/codex 와이어
  빌더 3종(browser-launch.ts 패턴)
- `packages/daemon/package.json` — `./preview-mcp` export 추가
  (`./browser-mcp` 선례)
- `packages/desktop/electron-builder.yml` — `asarUnpack`에
  `dist/preview-mcp.js` 추가(plain node 자식이 읽어야 하므로 — browser-mcp.js
  선례)
- `packages/daemon/src/server.ts` — `/internal/preview`, `PREVIEW_OPS`,
  `issuePreviewSecret`, 세션 종료 시 시크릿 회수(browserSecrets 선례)
- `packages/daemon/src/session-manager.ts` — previewMcpFor 훅
  (browserMcpFor 선례)
- 드라이버 3종 claude/acp/codex session — 두 번째 stdio 서버 주입
- `drivers.test.mjs` — 주입 경로 핀을 두 번째 서버로 확장("새 드라이버가 이걸
  빼먹는 것을 drift가 아니라 결정으로 만드는" 핀)
- 데스크톱 `main.ts` — 서버 도구는 데몬 자체 소유라 host 주입 불필요 확인

### restart가 건드리는 것

- pane이 보고 있는 서버를 죽인다 → pane 오류 배너 → 서버 복귀 시 재접속(기존
  오류 배너 경로 재사용).
- 웜 프리뷰 정책(`fenceWarmPreviews`)과 포트 재배정(`repo-bringup`의 "서버가
  인쇄한 주소 → 프로세스 트리 LISTEN" 판정)을 그대로 타게 한다 — restart 전용
  새 길을 만들지 않는다.

## 하지 않기로 한 것 (다시 검토하지 말 것)

- **데이터 시딩 MCP** — 시드 방식은 레포 소유. 레포가 자기 파일에 스크립트를
  선언하면 에이전트가 exec 도구로 직접 돌리면 끝. MCP로 감쌀 근거 없음.
- **레포 규칙·디자인 시스템 MCP** — 레포의 자기 파일(`CLAUDE.md` 등)이 원래
  담당. MCP로 감싸면 중복 + 관리 부담만 추가.
- **before/after 화면 비교 MCP** — `browser_screenshot`으로 에이전트가 직접
  비교 가능, 턴 끝 검증은 스크린 게이트(`runGate`)가 이미 한다.

## 열린 결정 (구현 시 정할 것)

1. **브라우저 미주입 시 서버 도구 제공** — 별도 엔트리로 해소됐지만, 데몬 개발
   경로에서 preview-mcp 자식을 띄울지(항상) vs 데스크톱에서만(브라우저와 함께)
   는 구현 시 판단. 데몬이 소유자이므로 "항상"이 자연스럽다.
2. **로그 보존량** — 링 버퍼 크기(줄 수)와 메모리 비용. 웜 서버 2개분.
3. **`preview_restart`의 허용 메모리** — 권한 카드의 "항상 허용"에 넣을지.
   사용자 화면을 죽이는 조작이라 기본은 넣지 않는 쪽을 권한다.
