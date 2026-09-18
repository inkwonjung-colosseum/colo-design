# 내장 브라우저(미리보기) 서브시스템 현황 정리

> 현황 문서다 — `dbc8bd2` 기준(작업 트리 변경분 포함). 코드가 이긴다: 여기 적힌
> 줄 번호·LOC가 어긋나면 코드를 읽고 이 문서를 고쳐라.
> 전환 계획은 `preview-proxy-agent-plan.md`, 대안 비교는 `preview-host-alternatives.md`.

## 0. 한 문장

**사용자에게 보이는 창 하나**(레포 dev 서버의 앱을 `WebContentsView`로 그대로 렌더)
위에 **도구 소유 오버레이**(핀·배지)를 얹고, 턴이 끝나면 **보이지 않는 격리 창**이
핀이 가리킨 화면을 다시 열어 검증하며, AI는 **CDP 드라이버**로 그 창들을 만진다.
전부 커밋에 0바이트를 남긴다.

## 1. 창의 종류 (3 + 1)

| 창 | 구현 | 보이나 | 누가 만지나 | 역할 |
|---|---|---|---|---|
| **사용자 pane** | `WebContentsView`, 프로젝트당 페이지 1개, 떠나면 `park`(최대 8 유지) | 보임 | 사용자 + AI(`PaneBrowserDriver`, 권한 카드 필수) | 레포 앱 그대로. origin 펜스(loopback만), 외부 링크는 OS 브라우저로 |
| **게이트 격리 창** | 오프스크린 `BrowserWindow` (`ElectronPreviewDriver`) | 안 보임 | AI·게이트만 | 턴 뒤 핀 화면 재오픈 → settle → 콘솔 판정 → 캡처 |
| **시점 빌드** | 넘긴 브랜치 꼭지를 워크트리로 체크아웃해 **제2 포트**로 서빙(`handoff-preview.ts`) | pane에 로드해 보임 | 개발자(검토용) | "넘긴 시점"의 실제 앱을 여는 길. 데몬당 1슬롯, 15분 유휴 TTL |
| (브라우저 개발 경로) | `IframeHost` — Electron 없이 `pnpm dev:web` | 보임 | 개발자만 | 핀·주소창·오류 배너 **없음**. 개발 편의 전용 |

## 2. 기능 축 9개

| # | 기능 | 한 줄 | 고유/공통 | LOC(src) |
|---|---|---|---|---|
| ① | **코멘트 핀** | ⌥+클릭(요소) / ⌥+드래그(영역) → 트레이 → 한국어 구조화 턴 → `comments.json` → PR `### 수정 요청` | **고유** — 크롭+스타일+a11y+owner+소스 스탬프를 실은 턴이 PR 본문까지 이어지는 파이프 | ~1,750 |
| ② | **화면축** | `data-screen`/`data-state` DOM 규약 + `?state=` 주소 문법 | 고유(축소판). `colo-design.screens` 선언 봉투는 **폐지됨** | ~150 |
| ③ | **게이트 자동재확인** | 턴 끝에 핀이 가리킨 화면(≤6)을 격리 창으로 재오픈, `settled`+콘솔 error/net만 판정, `gate` 마커 턴 | **고유** — "오류를 먼저 발견하는 쪽이 비개발자여선 안 된다" | ~500 |
| ④ | **보낸 화면 동결** | 넘기기 시 캡처를 `.colo-design/shots/`에 커밋 + FrozenStage UI(`[보낸 화면|지금 화면]`) + 시점 빌드 `실제로 열기` | **고유** — PR 핸드오프 정체성의 연장 | ~950 |
| ④′ | **z-order 덮개** | 모달이 뜨면 네이티브 뷰를 숨기는 단언 고리(`cover-reconciler` + `use-preview-cover` + `cover`/`freeze`) | 필수 부속(네이티브 뷰의 결함 우회) | ~400 |
| ⑤ | **상태칩** | (a) 사이클 칩 — 변경 없음/저장 안 함/저장됨/개발자 검토 중/변경 요청/반영됨/반려/치워둠 (`delivery.ts` SSOT) (b) 화면 상태 — 기본/비어 있음/오류(`?state=`) | (a) **정체성 핵심** (b) 고유 | (a) 383+~300 (b) ~50 |
| ⑥ | **warm preview / 포트** | 프로젝트 전환 시 페이지 park, 최근 2 프로젝트 서버 유지, 포트 탐지(stdout 스캔→LISTEN 소켓 폴백), 점유 프로세스 정리 | 공통 인프라 | ~700 |
| ⑦ | **`data-colo-src` 읽기** | 레포가 babel 플러그인으로 새긴 `path:line` 스탬프를 핀에 실음 | 고유(선택 규약). **테스트 0건** | ~30 |
| ⑧ | **화면 캡처 첨부** | 핀 크롭(긴 변 600) · `이 화면 보여 주기` 풀프레임(긴 변 1200) · `preview.capture` 단독 · 넘기기 shots | 공통 + 고유(PR에 shots 커밋·링크) | ~600 |
| ⑨ | **AI 브라우저 조작** | `PaneBrowserDriver`(사용자 창 직결, ref 세대·actionability) + `browser-gate` 권한 카드 + `browser-mcp` 16도구 | 공통 + 권한 카드는 우리 안전장치 | ~1,200 |

## 3. 파일 지도

### desktop (`packages/desktop/src`, 4,236 LOC)

| 파일 | LOC | 역할 | 축 |
|---|---|---|---|
| `preview-view.ts` | 1,372 | 사용자 pane + IPC 표면 전부. `PlannerPreviewView`(:235), `relayPin`(크롭·owner 읽기), `snapshot`, `cover`/`freeze`, `park`/`evictParked`, `registerPreviewIpc`(:1265). `OWNER_SCRIPT`(:69-93)를 `executeJavaScript`로 main world에 주입 | ①②④′⑤⑥⑦⑧ — **최상위 병목** |
| `preview-driver.ts` | 1,627 | AI용 드라이버: `ElectronPreviewDriver`(:182, 격리 창) · `PaneBrowserDriver`(:545, 사용자 pane CDP 조작) · `PaneCaptureDriver`(:1518) · 공장 2개(:1593/:1614). `settle`의 `[data-state]` 대기(:134-152) | ②③⑧⑨ |
| `preview-preload.ts` | 989 | pane 안 샌드박스 preload: 핀 피커(⌥+클릭 :558-599, ⌥+드래그 :613-700), 배지 렌더·재앵커(:761-864), `describeElement`(:167-189, HTML/스타일/a11y/attrs/`data-colo-src`), `data-screen`/`data-state` 읽기(:200-219), 레포 브리지 문 `window.coloDesign.post`(:225) | ①②⑦⑧ — 핀의 실체 |
| `windows.ts` | 221 | 플래너 메인 창 호스트·네비게이션 펜스·데몬 URL 조립 | ⑥⑨ |
| `emulation.ts` | 27 | 모바일/태블릿/데스크톱 폭 프리셋 SSOT(`VIEWPORT_METRICS`) | ⑨ |

### daemon (`packages/daemon/src`, 1,985 LOC)

| 파일 | LOC | 역할 | 축 |
|---|---|---|---|
| `screen-gate.ts` | 100 | 게이트 **순수 판정층**: `inspectScreens`(상한 6), `gateBrief`. error·net만 세고 warn 제외 | ③ |
| `preview-drivers.ts` | 264 | 게이트 오케스트레이션 `PreviewDrivers`: `notePinned` · `runGate`(origin 펜스 :124-141) · `capture` · `captureHandoffShots` | ③⑥⑧ |
| `preview-driver.ts` | 144 | `PreviewDriver`(보는 창) · `BrowserDriver`(만지는 창) **계약만** — 구현은 desktop | ③⑧⑨ |
| `preview-claim.ts` | 132 | 포트·프로세스 순수 절차: `killTree` · `probePreviewUrl`(html/ok/null) · `pidListeningPorts`(lsof/netstat) · `descendantPids` | ⑥ |
| `comments.ts` | 150 | 핀 코멘트 `comments.json` append-only 저장소 + `captureTargets` | ①⑧ |
| `handoff-preview.ts` | 494 | 시점 빌드 재현: 워크트리 체크아웃 → 제2 포트 서빙, `HandoffPreviews` 1슬롯, node_modules 심링크 대여 | ④⑥ |
| `repo-summary.ts` | 206 | 넘기기 초안 원샷 턴 — `handoffExtras`(핀·파일·shotCount 조립) | ④① |
| `handoff-body.ts` | 122 | PR 본문 `### 수정 요청`·파일 섹션 빌더 | ①④ |
| `common-instructions.ts` | 20 | 모든 세션 공통 지침 — `data-screen`/`data-state` 표식 규칙이 화면축의 유일한 '선언' | ② |
| `browser-mcp.ts` | 353 | AI 브라우저 도구 MCP stdio 중계(16도구) → `POST /internal/browser` → 권한 판정 → 드라이버 | ⑨ |

### web (`packages/web/src`, 5,077 LOC)

| 파일 | LOC | 역할 | 축 |
|---|---|---|---|
| `components/panels/ScreenPanel.tsx` | 1,717 | **우측 열 전체**: 저장/넘기기/상태 확인, 상태칩, 개발자 코멘트, 저장 기록, 치워두기, 동결 무대 배선, 핀 배지 재앵커. 화면축은 그중 `?state=` 전달뿐 | ⑤④① — 사이클 UI |
| `components/preview/PreviewHost.tsx` | 900 | 미리보기 프레임: 툴바·주소창·뒤로/앞으로·폭 토글·배율·오류 배너·`이 화면 보여 주기`·느린 로딩 안내·FrozenStage 장착점. `native` 플래그로 호스트 분기(:154) | ⑤⑧④ |
| `components/preview/NativeHost.tsx` | 231 | 데스크톱 뷰의 빈 슬롯 — bounds 위로(`ResizeObserver`→IPC), location·pins·error·freeze 아래로 | ①⑤ |
| `components/preview/IframeHost.tsx` | 60 | 브라우저 개발 경로 iframe(개발자 전용) | — |
| `components/preview/PinTray.tsx` | 219 | 컴포저 핀 트레이: 행·메모·수정/질문 칩·모두 지우기 | ① |
| `components/preview/FrozenStage.tsx` | 211 | 보낸 화면 동결 UI: 스탬프 바·세그먼트·커밋 캡처·`실제로 열기` | ④ |
| `components/preview/TurnClock.tsx` | 38 | 턴 경과 시계 | — |
| `hooks/usePins.ts` | 241 | 핀 생명주기: sessionStorage 영속, `markSent`(트레이→ghosts→`recordComments`), `pinsSync`(오버레이 투영) | ① |
| `hooks/use-preview-cover.ts` | 43 | 덮개 단언의 유일한 감시자(MutationObserver→reconciler→`cover(on)`) | ④′ |
| `lib/cover-reconciler.ts` | 132 | 덮개 단언 고리: 확인 상태 비교·거부 시 백오프 | ④′ |
| `lib/preview-turns.ts` | 187 | 기계 턴 조립: `pinsToTurn`(핀+문장→한 턴, "파일 경로 없이·컴포넌트 이름 없이·화면은 제목으로") · `errorToTurn` · `lookToTurn` · `reviewToTurn` | ①⑤⑧ |
| `lib/preview-address.ts` | 59 | 주소창 순수 함수: `parseAddress`(origin 펜스) · `splitPath`(`?state=` 분리) | ② |
| `lib/delivery.ts` | 383 | **상태칩 판정 SSOT** — 사이드바 행 표식도 같은 상수 | ⑤ |
| `lib/handoff-draft.ts` | 27 | 넘기기 초안 시드 | ④ |
| `chat-preview.tsx` | 625 | **dev 전용 디자인 하네스** — 헤더가 "delete or keep out of dist freely". 빌드 산물 아님 | — |

### protocol (`packages/protocol/src`, 관련분)

| 파일 | 심볼 | 축 |
|---|---|---|
| `preview.ts`(145) | `ColoDesignCommentTarget`(:22) · `ColoDesignPinEnvelope`(:56) · `ColoDesignPinsSync`(:88) · `ColoDesignErrorEnvelope`(:135) | ①⑤⑦⑧ |
| `messages.ts` | `session.send.pins` · `preview.capture` · `repo.handoffShot` · `repo.handoffPreview` · `comments.record` · `comments.reply` · `browser.driving` | ①③④⑧⑨ |
| `repo.ts` | `CommentItem` · `HandoffShot` · `HandoffStatus` · `DeveloperReview` · `HandoffPreviewInfo` · `RepoErrorKind` | ①④⑤⑧ |
| `turn-marker.ts`(284) | `CommentsMarker`/`GateMarker`/`ErrorMarker`/`ReviewMarker` + `markTurn`/`readTurn` | ①③⑤ |
| `session.ts` | `QueuedSendPayload.pins`(게이트 입력 복원) | ③ |

## 4. 데이터 흐름 4개

### 4-a. 핀 → 턴 → PR
```
⌥+클릭 (preview-preload) → describeElement → ColoDesignPinEnvelope
  → IPC colo-overlay:post → preview-view.relayPin (크롭 + OWNER_SCRIPT owner 읽기)
  → web usePins (sessionStorage) → PinTray 메모/의도 칩
  → 보내기: pinsToTurn → 한국어 한 턴 + session.send.pins
  → markSent → comments.record → daemon comments.json
  → 넘기기: handoff-body `### 수정 요청` + captureHandoffShots → .colo-design/shots/ 커밋
```

### 4-b. 게이트
```
턴 종료 → PreviewDrivers.runGate(notePinned 화면들, origin 펜스)
  → factory.forIsolated(previewUrl) → ElectronPreviewDriver(오프스크린 창, CDP attach)
  → open(route, state) → settle([data-state] 대기) → 콘솔 error/net 수집
  → screen-gate.inspectScreens → gateBrief → `gate` 마커 턴 (1회성, gatedSessions)
```

### 4-c. AI 조작
```
에이전트 tools/call → browser-mcp.js (stdio) → POST /internal/browser (세션 시크릿)
  → server.ts op 화이트리스트 → 직렬 큐 → decideBrowserOp (사용자 pane이면 권한 카드)
  → PaneBrowserDriver (webContents.debugger: Accessibility.getFullAXTree · DOM.* · Input.* · Page.captureScreenshot)
```

### 4-d. warm preview
```
프로젝트 전환 → PlannerPreviewView.park(페이지 유지, 최대 8) → 복귀 시 1.5초 안 재부착
서버는 최근 2 프로젝트 유지 (repo-core) · epoch 변화 → 보관 페이지 reload
```

## 5. 테스트 지도 (3,624 LOC)

| 파일 | LOC | 검증 |
|---|---|---|
| `desktop/test/desktop-comments.mjs` | 1,059 | 핀 e2e 총괄: ⌥+클릭→트레이→한 턴→즉시 소비, 리로드 생존, 크롭 순간 고정, 무선언 페이지, 줌/주소창 |
| `daemon/test/repo-handoff.test.mjs` | 469 | 넘기기 캡처 커밋·PR 본문 링크 + 치워두기 |
| `daemon/test/browser-gate.test.mjs` | 405 | AI 민감 브라우저 op 권한 카드(`session.ts decideBrowserOp`) |
| `daemon/test/browser-mcp.test.mjs` | 304 | MCP stdio 중계 16도구 |
| `desktop/test/desktop-cover.mjs` | 260 | 덮개 3계약: ack 순서·⌘,·창 재오픈 재부착 |
| `desktop/test/browser-driver*.mjs` | 412 | `PaneBrowserDriver` 29케이스(ref 세대·actionability·waitFor) |
| `desktop/test/desktop-switch.mjs` | 253 | warm preview: 전환 시 보관·1.5초 복귀 |
| `daemon/test/preview-detect-e2e.mjs` | 229 | 포트 자동탐지: stdout 스캔→LISTEN 폴백 |
| `daemon/test/screen-gate.test.mjs` | 157 | 게이트 판정: settled+조용=무죄, error/net만, 핀 화면만 재오픈 |
| `web/test/cover-reconciler.test.mts` | 221 | 덮개 단언 고리 |
| `web/test/preview-address.test.mts` | 74 | 주소창 origin 펜스·`?state=` 분리 |
| `web/test/handoff-draft.test.mts` | 34 | 넘기기 초안 시드 |

**테스트 0건**: ⑦ `data-colo-src` 읽기.

## 6. 보존 필수 (제품 정체성) vs 삭제·단순화 후보

### 보존 필수
| 항목 | 이유 |
|---|---|
| 비개발자 언어 상태칩(`delivery.ts` + ScreenPanel 칩) | "저장/넘기기/반영됨" 판정이 기계 신호에서 온다는 README 약속 |
| PR 핸드오프 파이프(`comments.ts`→`### 수정 요청`+shots 커밋) | 핀의 마지막 독자는 대화를 못 보는 개발자 |
| 한국어 오류 안내(오류 배너·`RepoErrorKind`·게이트 실패 문구) | 비개발자가 오류를 읽는 유일한 표면 |
| 게이트 자동재확인 | 입력이 **사람의 핀**이라는 설계가 핀 파이프와 맞물림 |
| 핀→한국어 구조화 턴(`pinsToTurn`) | 비개발자 언어 규칙의 실행체 |
| warm preview/포트 관리 | 다중 프로젝트 UX의 전제 |
| `data-colo-src` 읽기 | 30줄로 "수정이 바로 그 줄로 향함" — 레버리지 최상 |

### 삭제·단순화 후보 (의존 폭 좁은 순)
| 순위 | 후보 | 절감 | 상태 |
|---|---|---|---|
| 1 | `chat-preview.tsx` + `chatpreview.html`(dev 하네스) | 625+ | 즉시 가능 — 단, 작업 트리 변경분이 이 파일을 손봤음(첨부 기능) — 커밋 후 재확인 |
| 2 | `ColoDesignPinsSync` 사장 필드 `n`/`tone`/`screenMark`(생산자 없음) | ~40 | 즉시 |
| 3 | `titleForScreen` prop 사슬(주입처가 dev 하네스뿐) | ~30 | 즉시 |
| 4 | `errorKind:"look"` 마커 겸용 → `TurnMarker`에 `look` 신설 | ~20 | 이번 사이클 |
| 5 | React owner 출력 필드(`owners`) | ~80 | 소스맵 자동화 착수 시 |
| 6 | `preview.capture` 단독 경로 | ~150 | 조건부 — visual diff 착수 시 |
| 7 | `data-colo-src` 전면 | ~30 | 조건부 — 소스맵 2단계 안정 후 |
| — | **④′ 덮개 서브시스템** | ~400 + 테스트 480 | **호스트를 DOM 요소로 바꾸면 통째로 소멸** → `preview-proxy-agent-plan.md` |

**삭제 비추천**: 영역 핀(Codex도 ⇧클릭 영역 선택 제공 — 패리티) · 시점 빌드 재현(PR 핸드오프 차별점) · `IframeHost`(dev 생산성) · 배율(전환 시 재검토).

## 7. 문서-코드 어긋남 (즉시 정정 대상)

1. **README `화면 축` 절**(:474-484) — `colo-design.screens` 봉투·툴바 선택기는 폐지됨(`preview-preload.ts:13`, `preview-view.ts:39-40`). 남은 계약은 `data-screen`/`data-state` 표식 + `?state=` 주소만
2. `useMarks` 잔재 — `usePins.ts:156-158`·`PinTray.tsx:68` 주석이 철거된 레지스트리를 가리킴
3. `journey*` 파일은 **존재하지 않음** — 그 역할은 ④ 보낸 화면 동결 + 시점 빌드가 담당
