# 인앱 브라우저 전환 계획 v2 (확정판) — Paseo/Orca/Codex/Claude식 에이전트·사용자 공유 탭

> 작성일: 2026-09-17 (v1 대비: glm-5.3 아키텍처 비평 + glm-5.3-flash MCP 주입 검증 + swe-2 착수 분해의 2라운드 토론으로 확정)
> 결정 확정: 에이전트 조작 부활(Paseo식) / 임의 http(s) / pane을 브라우저로 진화(별도 패널 아님).
> v1 정정 2건 (토론에서 코드로 검증됨):
> 1. **pane 파티션은 in-memory였다** — `partition: "preview"`에 `persist:` 접두가 없어 재시작 시 로그인이 남지 않는다(preview-view.ts:847). persist 전환은 1단계 정식 작업.
> 2. **AX·액션 구현은 현재 트리에 없다** — 게이트 재배선(2026-09-17)으로 `PreviewDriver` 계약이 `open/screenshot/consoleLines/destroy`로 축소됐고 desktop `CdpPreviewDriver`에서 axTree·click·type 등이 삭제됐다. 구현은 07bd3bf(~907줄 버전)에서의 **이식**이며 "재사용"이 아니다. 2단계 정식 작업.

## 0. TL;DR

- 참조 4제품 공통 모델: 에이전트와 사용자가 **같은 Chromium 탭을 공유**, 에이전트는 AX 스냅샷+ref 도구로 조작. 임의 http(s), 로그인 공유(persist), 탭 스트립이 표준 기능 집합.
- 4단계로 진행: ① 탭 모델+persist(사용자 가치 독립 배포) → ② BrowserDriver 계약+07bd3bf 이식 → ③ `browser_*` MCP 도구(4 프로바이더) → ④ 게이트 재연결+활동 표시.
- **구현 상태 (2026-09-17)**: 1~4단계 전부 구현·검증 완료. ① 탭 이중 구조(livePages/tabList)·persist:preview·kind 전환·탭 스트립·⌘⇧[/⌘⇧] — 유닛 17시나리오+스모크 통과. ② PaneBrowserDriver(AX ref 세대·actionability·다이얼로그 자동 처리 이식) + PaneCaptureDriver(게이트 캡처가 같은 드라이버 경유, 디버거 단일 소유) — 유닛 27케이스 통과. ③ browser-mcp.js stdio 서버(17도구→/internal/browser) + 세션별 시크릿 + claude/acp/codex 3형태 주입, omp 폴백 — 유닛 6케이스 통과. ④ navigate/openTab→notePinned(게이트 입력) + browser.driving 브로드캐스트→탭 스트립 스피너.

## 1. 현재 구조 (2026-09-17, 재배선 후)

```
Desktop main process                          Daemon (in-process)
┌──────────────────────────────────┐         ┌────────────────────────┐
│ PlannerPreviewView                │         │ PreviewDrivers          │
│  WebContentsView × 최대 3 (parked)│◀─IPC────│  runGate → forIsolated  │
│  origin 키 Map, external 플래그   │         │  capture → for(pane)    │
│  partition "preview" ← in-memory! │         │  captureHandoffShots    │
│  loopback + allowedOrigins 가드   │         └────────────────────────┘
│ CdpPreviewDriver: open/screenshot │                ▲ PreviewDriverFactory
│   /consoleLines/destroy 만 남음   │────────────────┘ (desktop 주입)
└──────────────────────────────────┘
```

- 에이전트 도구 표면 없음(`screen_*` 삭제, 구 `preview-tools.ts`는 07bd3bf 히스토리에만 존재).
- 페이지 모델: `pages = Map<origin, PreviewPage>`, `MAX_PAGES=3`, LRU evict. origin당 1페이지.
- 임의 탐색 부분 지원: `external` 페이지는 http(s) 자유 이동, 주소창 external 모드에서 전체 URL 입력 가능. `window.open`은 같은 탭 내 이동.
- ACP `mcpServers: []`(acp/session.ts:99), Claude는 SDK `query({options})`, Codex는 `thread/start` stdio, omp는 `--mode rpc` stdio.

## 2. 참조 제품 대비 갭

| 기능 | Orca | Paseo | Codex | Claude | 현재 | 목표 단계 |
|---|---|---|---|---|---|---|
| 에이전트-사용자 같은 탭 공유 | ● | ● | ● | ● | ◐ | 2·3 |
| 탭 스트립/다중 탭 | ● | ● | ● | ● | ✗ | 1 |
| 임의 http(s) | ● | ● | ● | ● | ◐ | 1 |
| AX 스냅샷+ref 도구 | ● | ● | ● | ● | ✗ | 2·3 |
| 로그인 세션 공유(persist) | ● | ● | ● | ● | ✗(in-memory) | 1 |
| 액션→스냅샷 반환 | ● | ● | – | ● | ✗ | 2·3 |
| 게이트 무오염 재검증 | – | – | – | – | ● | 유지 |

## 3. 확정된 설계 결정 (토론 합의)

1. **공유가 기본, 격리는 검증 전용.** 에이전트 도구는 사용자가 보는 탭을 drive. 게이트·핸드오프 캡처는 `forIsolated` 유지. 4단계 noteOpened 재연결은 bookkeeping일 뿐 무오염과 무충돌(GLM-5.3 판정: 07bd3bf는 명시적 open에서만 발화, 신규는 navigate에서 자동 발화 — origin 필터 규칙은 양쪽 동일).
2. **persist 전환.** `createPage`의 `partition: "preview"` → `"persist:preview"`(한 줄) + 세션 유지 스모크. 임의 사이트 쿠키 영속에 대한 보안 검토 항목 동봉(§6).
3. **탭 이중 자료구조.** `livePages: Map<tabId, PreviewPage>`(WebContents 보유) + `tabList: TabMeta[]`(순서 있는 스트립 메타: `{id, kind, title, lastUrl, favicon, discarded, shownAt}`). `discard`(WebContents 파기, 메타 유지)와 `closeTab`(메타까지 제거) 분리. evict=discard. discarded 활성화 → `createPage`+`lastUrl` 재로드(epoch 검사 포함). `this.page` → `activeTabId`. 창 닫힘(전 탭 동시 소멸)은 evict 복원과 같은 경로로 자연 흡수 — 별도 복원 기능 없음, 탭 메타는 뷰가 소유(WebContents 보유 금지).
4. **repo origin 탭 1개 규칙.** 레포가 선언한 origin(mount origin ∪ allowedOrigins)은 중복 탭 금지 — 해당 origin으로의 이동은 기존 탭 activate+refresh(mount 경로 위임). 중복 허용은 web origin만. mount idempotency·epoch refresh·driveTo가 이 유일성 위에 서 있으므로 보존.
5. **kind는 URL이 결정, 전환은 신규 동작.** `will-navigate`는 `http(s)` 가드만 남기고 분기 삭제. `did-navigate` 순서: ① `kind = repoOrigins.has(origin) ? "preview" : "web"` 재계산 → ② 오버레이 재무장(preview: mode+pins 재전송, web: mode off+빈 pins 스윕 — `show()`의 재생 로직과 동일) → ③ preview 탭이고 epoch 이동 시 refresh. `did-navigate-in-page`는 kind 재계산 불필요, pins 리플레이만 kind 가드.
6. **allowedOrigins는 탭 스냅샷.** 뷰 전역값이 아니라 탭이 마운트/활성화되는 시점에 재스냅샷 — 프로젝트 전환 후 parked preview 탭이 낡은 가드로 오분류되는 것을 막음.
7. **screens sticky.** `show()`의 `onScreens` 전파를 `kind === "preview"`일 때만 — web 탭 활성화가 daemon의 화면 목록(핸드오프 캡처·`preview.capture` 대상)을 비우지 않음. 수명은 기존 `clearScreens()`(프로젝트 전환)에 위임. 게이트 입력(pinnedThisTurn)은 declaredScreens를 읽지 않으므로 이 결정의 동기는 handoff·화면 목록 UX.
8. **단축키: 전역 재배정 금지, 포커스 스코프.** preview 뷰 포커스 시에만 ⌘T=새 탭, ⌘W=탭 닫기(살아있는 탭 ≥2) — 기존 `before-input-event` 키 전달 채널(⌘K/⌘,/Esc 선례)로 구현, 메뉴 가속키 아님. 그 외 포커스에서는 앱 전역 동작(⌘T=새 대화, ⌘W=창 닫기) 유지. ⌘⇧[ / ⌘⇧] 탭 전환은 메뉴 항목으로 추가(APP_SHORTCUTS 확장 + menu 단위 테스트 갱신 — D92 규칙).
9. **주소창 navigate는 active 탭.** external 분기를 새 탭 생성으로 바꾸지 않는다 — 그러면 주소 입력마다 탭이 생김. 활성 web 탭에서는 in-place navigate, 활성 preview 탭에서 off-origin 전체 URL 입력은 신규 web 탭.
10. **debugger 단일 소유자.** `preview.capture`(PanePreviewDriver)와 PaneBrowserDriver의 이중 attach는 webContents당 디버거 1개 제약 위반 — 2단계 계약에 "탭별 attach 소유자 1개"로 명문화, capture도 동일 드라이버 경유로 일원화.
11. **인터페이스 최소화.** `forActive()` 삭제(tabId 생략=active 규칙으로 충분). `browser_do` 배치 도구는 스냅샷 반환 원칙과 가치 중첩 — 후속 단계로 미룸.

## 4. 단계별 계획 (확정)

### 1단계 — 탭 모델 + persist (desktop + web)

**desktop `preview-view.ts`**:
1. `PreviewPage`에 `id`·`kind`·`title`·`lastUrl`·`originSnapshot`(allowedOrigins 스냅샷) 추가, `external`→`kind` 일반화. `livePages`/`tabList` 이중 구조, `activeTabId`(작업 ①·③).
2. `createPage:847` `partition: "persist:preview"`(작업 ②).
3. `mount`: repo origin 탭 탐색→activate+refresh, 없으면 생성(규칙 4). `refresh` epoch 로직 탭 단위 이전.
4. `openExternal`→`openTab`: repo 레지스트리 origin은 mount 경로 위임, 아니면 항상 새 web 탭+activate. bounds 없으면 OS 폴백 유지.
5. attach 핸들러 재작성: `setWindowOpenHandler` http(s)→새 탭(포그라운드), 비-http(s) deny+OS. `will-navigate` http(s) 가드만. `did-navigate` kind 재계산→오버레이 재무장→epoch 확인(규칙 5). `page-title-updated`/`page-favicon-updated` → 탭 메타+`colo-preview:tabs` 푸시.
6. `activateTab/closeTab/newTab/listTabs` + `discard`/`closeTab` 분리, `evictParked`=discard, discarded 재활성화 재로드.
7. `show()`의 `onScreens` kind 가드(규칙 7). `commentsMode/syncPins/pinFlash`의 external 가드→kind. `sendLocation`에 `tabId`·`kind` 포함. `unmount`는 active가 preview 탭일 때만 park.
8. IPC: `preview:tabs/tab-activate/tab-close/tab-new` 신설, `preview:navigate`·`preview:open`에 `tabId`, `preview:open-external`은 `openTab` 위임. `onOverlayPost`는 livePages 순회로.

**web**:
1. 탭 스트립 컴포넌트를 `preview__device` 안 `frame__progress`와 `frame__chrome` 사이, `native` 조건으로 삽입. early return(`stopped`/`!url`) 경로에서도 스트립이 살아있는지 확인해 배치.
2. `submitAddress`: 활성 탭 in-place navigate(규칙 9). "미리보기" 버튼→preview 탭 activate, "닫기"→tab-close.
3. `NativeHost.onLocation` `tabId===activeTabId` 필터. `desktop-bridge.d.ts`·`preload.ts`에 tabs/onTabs 노출. `colo-preview:error`는 active 탭 전용임을 문서화(탭 전환 시 배너 초기화 — 1단계 범위: 전환 시 error state 리셋).
4. IframeHost(브라우저 경로)는 단일 iframe 유지, 스트립 숨김.

**menu** (규칙 8): ⌘⇧[/⌘⇧] 메뉴 항목+APP_SHORTCUTS 확장+테스트. ⌘T/⌘W는 before-input-event 채널(뷰 포커스, 탭 ≥2 조건)로.

**테스트**: `desktop.test.mjs`의 `runDriverUnit` 패턴(spawn electron + `COLO_DESIGN_DESKTOP_UNIT=1` + JSON 한 줄)을 `runElectronUnit(entry, env)`로 추출해 탭 유닛 엔트리 추가 — 케이스: 생성/전환/닫기/8개 초과 evict 후 재로드/`window.open`→새 탭/kind 전환 양방향/repo origin 중복 금지/persist 세션 유지. 메뉴 테스트에 ⌘⇧[/⌘⇧] 단언.

### 2단계 — BrowserDriver 계약 + 07bd3bf 이식 (daemon + desktop)

- daemon `preview-driver.ts`에 `BrowserDriver` 신설(listTabs/openTab/closeTab/activateTab/navigate/snapshot/screenshot(tabId, ref)/click/type/press/scroll/hover/select/drag/consoleLines/evaluate/waitFor) — tabId 생략=active. `forActive()` 없음(규칙 11).
- desktop: `PaneBrowserDriver` — 07bd3bf 버전에서 axTree(ref 세대)·ref 액션·actionability(ACTIONABLE_RECT_OF_SELF)·다이얼로그 자동 처리(alert accept, confirm/prompt/beforeunload dismiss+보고)를 **이식**. 당시 테스트 복원 포함.
- debugger 단일 소유자(규칙 10): 탭별 attach 소유 1개, DevTools 충돌 시 도구 오류 보고, `preview.capture`도 동일 경유.
- `evaluate` 반환 JSON 캡 8KB. `waitFor` 폴링(100ms/5s).
- 게이트용 `PreviewDriver`/`forIsolated` 무변경.

### 3단계 — `browser_*` MCP 도구 (claude·acp·codex 3사 + omp 폴백) — 확정

**flash 에이전트의 라이브 실증으로 확정된 프로바이더별 판정**:

| 프로바이더 | 판정 | 주입점 | 근거 |
|---|---|---|---|
| claude | **지원** | `query({options})`의 `mcpServers` | SDK `sdk.d.ts:1802` `McpStdioServerConfig = { type:"stdio", command, args?, env? }` — `session.ts:145`의 메인 query에만 주입(one-shot·probe 사이트는 `tools: []` 의도적 무도구, 제외) |
| acp | **지원** | `session/new`의 `mcpServers`(현재 `[]`) | ACP v1 스키마상 stdio는 모든 에이전트의 MUST. 단 형태 다름: `{type:"stdio", name, command(절대경로), args, env:{name,value}[]}` — args·env 생략 불가 |
| codex | **지원(라이브 실증)** | `thread/start { config: { mcp_servers } }` 권장 / `-c` spawn 인자 폴백 | v2 스키마 `ThreadStartParams.config`가 `additionalProperties: true`; 격리 `CODEX_HOME` 실증에서 MCP 프로세스 실제 기동·`mcp.connections.live: 1` 확인. config.toml 사전 기록 불요, 세션 시작 즉시 기동 |
| omp | **불가 → 폴백** | 없음 | `--mode rpc` 명령 집합에 도구 주입 wire 없음, CLI v18.2.3에 mcp 플래그 없음, `config get mcpServers` 미지원. `capabilities.browserTools=false`로 UI가 도구 의존 기능을 숨김. (`-e` 확장 파일은 가능하나 단일 stdio 경로를 깨므로 v2) |

**전송 설계(확정)**:
- stdio MCP 서버 1개 — **별도 번들 엔트리** `browser-mcp.js`(stdio가 파일 경로를 요구하므로 데몬 번들과 분리).
- 프로바이더별 와이어 형태 차이(claude record / acp 배열·절대경로·필수 env / codex config 객체)는 **단일 빌더가 3형태를 생성**.
- 세션 스코프: 데몬의 `config.token`은 전역 공유 시크릿(`server.ts:71-72`, `?token=` + timingSafeEqual)이므로 **세션별 시크릿을 발급해 메모리 매핑**(권장 — 자식이 타 세션 RPC를 못 침), 또는 `COLO_SESSION_ID` env + 핸들러 스코프 검증.
- 데몬 수신단: `server.ts:459-475`의 createServer 핸들러에 `/internal/browser` 라우트 추가. 데몬이 MCP 자식을 직접 spawn하므로 바인딩 주소(ephemeral 포트 포함)와 토큰은 env 전달로 충분.

**도구셋**(v1 계획 유지): `browser_list_tabs / new_tab / navigate / snapshot / screenshot / click / fill / type / press / scroll / hover / select / drag / wait / console / evaluate / close_tab / back / forward` — 모든 액션 도구는 실행 후 새 스냅샷 반환, ref 세대는 탭별 독립, `browser_do`는 후속. 권한은 일반 canUseTool 흐름(첫 호출 시 사용자 확인 + 항상 허용).

### 4단계 — 게이트 재연결 + 활동 표시

- `browser_navigate`가 preview origin에 착지하면 route·state를 `notePinned` 경로로 기록 → 턴 끝 `forIsolated` 재검증(규칙 1). web 탭 제외(origin 필터 재사용).
- 탭 스트립에 에이전트 조작 인디케이터(`colo-preview:agent-driving { tabId, on }`).

## 5. 실행 순서

```mermaid
flowchart LR
  P1["1단계 탭 모델+persist"] --> P2["2단계 BrowserDriver<br/>+07bd3bf 이식"]
  P2 --> P3["3단계 browser_* MCP"]
  P3 --> P4["4단계 게이트 재연결"]
```

## 6. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| persist 전환으로 임의 사이트 쿠키가 디스크에 영속 | 보안 검토: 파티션은 preview/web 공용 — 민감 사이트 자격증명이 로컬 디스크에 남음. 설정의 "미리보기 데이터 지우기" 동반 검토 |
| 사용자 입력과 에이전트 액션 경합 | actionability 대기(이식) + 4단계 "에이전트 조작 중" 인디케이터 |
| 프롬프트 인젝션 | untrusted-data 규칙 명시, `browser_evaluate` 권한 대상, canUseTool 게이트 |
| codex MCP 주입 | 해소 — `thread/start config` 라이브 실증 완료, `-c` 폴백 확보 |
| omp MCP 주입 불가 | `capabilities.browserTools=false` 폴백 확정 — claude·acp·codex 3사로 진행 |
| evicted 탭의 stale epoch 재로드 | 활성화 시 epoch 검사(규칙 3·5) |
| `colo-preview:error` 배너가 탭 전환에 잔존 | 1단계: 탭 전환 시 error state 리셋 |
| onScreens 공백 회귀 | sticky 가드(규칙 7)로 해소 — 회귀 테스트 포함 |

## 7. 열린 결정

1. **다운로드**: v1 미지원(차단+로그).
2. **DevTools**: 탭별 openDevTools — debugger 단일 소유자 규칙과 함께 2단계에서 정리.
3. **프로필/파티션 분리**: v2.
4. **검색 엔진 fallback**: v2.
5. **omp MCP 지원**: 확정 — 미지원. `capabilities.browserTools=false` 폴백으로 3단계에서 제외; `-e` 확장 파일 경로는 v2 검토.
