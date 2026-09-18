# 미리보기 호스트 전환 계획 — `<webview>` + 페이지 에이전트 (미구현 설계 문서)

> 이 문서는 아직 구현되지 않은 것을 다룬다. 구현 시점에 이 문서가 사실과 다르면
> 코드가 이긴다 — 착지점 파일을 다시 읽고 이 문서를 고친 뒤 손을 대라.
>
> **개정 (2026-09-18)**: `preview-host-alternatives.md`의 판정이 **D(Electron
> 주입 iframe) → B(`<webview>`)**로 뒤집혔다 — 비개발자 UX 기준으로 D가 5곳에서
> 진다(사유 doc §3). 이 문서는 B 기준으로 다시 썼다. D는 `preview-host-alternatives.md`
> §6에 "B가 실측으로 깨질 때의 출구"로 남는다. A(프록시)는 그 문서 §2에 확장
> 후보로 남는다.

## 배경 — 왜 지금 구조를 바꾸나

Colo Design의 미리보기는 네이티브 `WebContentsView`를 웹 UI의 DOM **위**에 얹는
구조다. 대상은 항상 **데몬이 띄운 loopback dev 서버**뿐이라 범용 브라우저가 겪는
문제(임의 사이트·인증·CSP)는 없는데, "DOM 밖의 뷰"라는 선택 하나가 이후 세금을
발생시켰다:

| 세금 | 원인 | 크기 |
|---|---|---|
| z-order 덮개(`cover-reconciler.ts` + `use-preview-cover.ts` + `cover`/`freeze` IPC) | 네이티브 뷰가 React DOM 위에 떠서 모달이 뷰 밑에 깔림 | ~400 + 테스트 480 |
| `NativeHost` bounds 릴레이 · `park`/`evictParked` | 뷰가 DOM 바깥이라 위치·수명을 손으로 동기화 | ~380 |
| `IframeHost` 별도 경로 | 브라우저 개발 경로와 데스크톱 경로가 다른 호스트 — 웹 개발 경로는 핀 미지원 | 60, 기능 결손 |
| preload 샌드박스 → `OWNER_SCRIPT`를 `executeJavaScript`로 main world에 주입 | 샌드박스에선 React fiber를 못 읽음 | 핀 정확도 기능 전부가 우회 통로 위 |
| `preview-view.ts` 1,372 LOC 병목 | 위 전부가 한 파일에 집결 | — |

**판정**: 버그를 막는 코드(덮개·릴레이·이중 경로)가 기능 코드보다 많은 층이
생겼다. 호스트를 **DOM 요소**로 바꾸면 z-order·bounds 문제가 애초에 사라진다.

**호스트 요소로 `<webview>`를 고르는 이유**: `<iframe>`도 같은 DOM 이득을 주지만
게스트가 임베더와 같은 site면 같은 프로세스에 묶여 **격리를 잃는다**(strict
site isolation은 site 단위 — `127.0.0.1` 플래너·미리보기가 같은 site).
`<webview>`는 DOM 요소이면서 게스트가 항상 별 WebContents·별 프로세스라
오늘의 격리를 공짜로 유지한다. 대가는 Electron의 "권장하지 않음" 경고와
Chromium GuestView의 아키텍처 이행 리스크뿐이고, 둘 다 사용자에게 보이지
않는 개발자 쪽 비용이다(비교 근거는 `preview-host-alternatives.md` §3–4).

## 후보 비교 요약 (전체 비교는 `preview-host-alternatives.md`)

| 방식 | 얻는 것 | 잃는 것 | 판정 |
|---|---|---|---|
| **B. `<webview>` + agent 주입** (이 문서가 채택) | 덮개·bounds 릴레이·park 전부 삭제. 격리·배율·로밍·모바일 에뮬레이션·CDP 드라이버 **거의 무수정**. 데몬 무수정 | Electron 공식 "권장하지 않음", MPArch 이행 리스크 — P0 스파이크로 실측 | 채택 |
| D′. Electron 주입 iframe + 플래너 origin 분리 | B와 동일한 삭제 효과, 표준 API만 사용 | 사용자에게 보이는 손실 5개(로밍·배율·모바일 충실도·격리 재검증·설정 리셋), 드라이버 재작성(OOPIF 라우팅) | B 실패 시의 출구 |
| A. 프록시 + iframe | B·D′와 동일한 삭제 효과 + 웹 개발 경로(`pnpm dev:web`)에서도 핀 동작 | 프록시 신규 구현(HTML 재작성·HMR ws 파이프·토큰/쿠키) | 확장 후보(부록) |
| C. 현 구조 유지 + 세금만 감면 | 격리 유지, 덮개 서브시스템만 삭제 | 나머지 세금 그대로, UI 자유도 제약 | 기각 |

## 목표 구조

```
AI 세션 → MCP stdio → browser-mcp.ts (불변, 16도구)
                          ↓
daemon: RepoStatus.previewUrl = 레포 dev 서버 원주소 그대로 (무수정)
   │
   ├→ screen-gate.ts / PreviewDrivers (불변 계약)
   │
desktop main:
   │  · will-attach-webview 펜스 — src(loopbackHttp)·preload·partition 고정
   │  · PaneBrowserDriver.target(): webContents.fromId(webview.getWebContentsId())
   │    (오늘의 debugger.attach 통로 그대로)
   │  · 게이트 격리 창(오프스크린 BrowserWindow, 무변경)
   │
web: PreviewFrame.tsx (신규) — 프로젝트별 <webview src=dev서버 원주소>, warm 유지
   │        └ preview-preload.cjs를 preload 속성으로 그대로 얹음(1단계),
   │          transport 추상화 agent 패키지는 후속 사이클(§1-b, 선택)
```

## 0. 불변 계약 (건드리지 않는 것)

| 계약 | 위치 | 이유 |
|---|---|---|
| `ColoDesignCommentTarget` / `ColoDesignPinEnvelope` / `ColoDesignPinsSync` | `packages/protocol/src/preview.ts:22-125` | 핀→턴→PR 파이프의 입력 |
| `PreviewDriver` / `BrowserDriver` 인터페이스 | `packages/daemon/src/preview-driver.ts:103-144` | 게이트·MCP·캡처의 계약. 구현 내부(target 획득 방식)만 바뀐다 |
| `screen-gate.ts` · `preview-drivers.ts` 오케스트레이션 · `comments.ts` · `handoff-body.ts` · `pinsToTurn` | daemon/web | 판정·PR 파이프 |
| 레포 브리지 `window.coloDesign.post` (`colo-design.navigate`) | `packages/desktop/src/preview-preload.ts:225` | 연결 레포가 의존하는 유일한 외부 계약 |
| `RepoStatus.previewUrl` (레포 dev 서버 원주소) | `daemon/src/repo.ts:125-127` | 호스트가 바뀌어도 의미 변경 없음 — **daemon 전체 무수정**(D′와 달리 origin 이전이 없다) |
| 데몬 런타임 deps `ws`·`yaml` | `packages/daemon/package.json` | 이번 전환은 desktop/web만 건드린다 |
| `preview-preload.ts`(989 LOC) | `packages/desktop/src/preview-preload.ts` | `<webview preload>` 속성으로 그대로 얹는다 — **1단계에서 이식·재작성 없음** |
| `앱에서 링크 열기`(로밍) · 배율(zoom) · 모바일 풀 에뮬레이션 | `settings.ts:219-224`, `preview-view.ts:886-889` | B에서는 전부 그대로 성립 — D′였다면 강제 폐지됐을 항목 |
| 권한 카드(`session.ts decideBrowserOp`, `isRepoSurface`) | `session.ts:850-869`, `preview-view.ts:486-489` | 로밍이 살아 있으니 판정 조건 그대로 유효 |

## 1. 신규 계약

### 1-a. `<webview>` 호스트 (web, desktop main)

```ts
// desktop main — will-attach-webview 펜스 (BrowserWindow 생성 시 등록)
function fencePreviewWebviews(window: Electron.BrowserWindow, isPreviewOrigin: (url: string) => boolean): void;
```

- 플래너 창에 `webPreferences: { webviewTag: true }` (스코프: 플래너 창뿐 —
  다른 창엔 켜지 않는다)
- `contents.on("will-attach-webview", (event, webPreferences, params) => ...)`:
  - `params.src`가 `loopbackHttp`(현 `preview-view.ts:142-152`) 밖이면 attach
    자체를 거절(`event.preventDefault()`)
  - `webPreferences.preload`를 desktop이 정한 경로(`preview-preload.cjs`)로
    강제 — 렌더러가 넘긴 값은 무시
  - `webPreferences.nodeIntegration = false`, `webPreferences.contextIsolation = true`
    강제 — 오늘의 preload 보안 등급과 동일
  - `webPreferences.partition`을 **`persist:preview`로 강제** — 오늘과 동일한
    단일 공유 파티션(`preview-view.ts:939-945`). 렌더러가 넘긴 partition 값은
    무시하고, 프로젝트별 분리는 별도 결정 사항으로 남긴다(이 전환의 범위 밖)
- 게스트 획득: 렌더러 IPC 왕복 없이 main이 직접 —
  `contents.on("will-attach-webview", ...)`의 `params.src`로 mount origin→프로젝트
  매핑을 미리 계산하고, `contents.on("did-attach-webview", (_e, guest) => ...)`
  시점에 그 게스트를 `pages` 레지스트리에 클레임한다. `PreviewPage.view:
  WebContentsView` 필드를 `contents: WebContents`로 교체하고, 클레임 직후
  오늘 `WebContentsView` 생성부(`preview-view.ts:939-947` 이후 배선)가 하던
  페이지 배선을 게스트에 그대로 재장착한다 — `will-navigate` 가드,
  `setWindowOpenHandler`→`openInOs`, 콘솔 수집, `did-fail-load`→배너,
  `colo-overlay:*` 송신
- 드라이버: `PaneBrowserDriver`는 레지스트리가 쥔 claimed guest를 그대로 겨눠
  오늘과 같은 `contents.debugger.attach("1.3")` 통로를 쓴다(`webContents.fromId`
  조회는 백업 경로) — CDP 호출부는 **거의 무수정**
- 크롭·스크린샷: `webContents.debugger.sendCommand("Page.captureScreenshot")`가
  이미 게스트 `webContents` 기준이라 무수정

### 1-b. Page Agent (선택, 후속 사이클)

B는 `preview-preload.ts`를 즉시 이식할 필요가 없다 — `<webview preload>`가
오늘의 preload를 그대로 로드하므로 호스트 교체와 agent 이식을 **분리**할 수
있다. transport 추상화는 D′로의 출구를 싸게 만들려는 투자이므로, 이번 사이클
목표(덮개 삭제·사용자 체감 개선)가 끝난 뒤 별도로 판단한다.

```ts
interface Transport {
  send(msg: unknown): void;
  onMessage(fn: (msg: unknown) => void): void;
}
// bridgeTransport      : 오늘 그대로 — window.coloDesign.post(IPC) 송신 +
//                         colo-overlay:* 수신 (preload가 그대로 담당)
// postMessageTransport : D′ 출구로 갈 때만 필요(iframe 모드)
```

착수 조건: `preview-host-alternatives.md` §6의 모니터링 신호(a/b/c) 중 하나가
오거나, 웹 개발 경로(`pnpm dev:web`) 패리티가 요구될 때(그때는 A 확장과 같이
검토).

## 2. 단계별 계획

### P0. 스파이크 (반나일 · 실레포 1개 · 코드 병합 없음)

> **결과 (2026-09-18, Electron 44.2.0 · `test/spike-webview.mjs`): 전항목 통과.**
> ISO 별 프로세스(host 1개 vs 게스트 각각 별 pid) · W4 펜스(외부 src 거절,
> preload/partition 강제 — preload는 격리 월드라 main world 마커는
> `webFrame.executeJavaScript`로 확인) · W5 CDP 실입력(`isTrusted:true`) ·
> W7 한글 텍스트 착지 · W2 토글 50사이클 재로드 0 · W6 park 보존 · W1 리사이즈
> 스톰 추적 · W3 모달 픽셀 위 그리기. 단, CDP `Input.imeSetComposition`은 이
> Chromium이 파라미터 유무와 무관하게 거부한다 — **실제 한국어 조합(한→한글→확정)
> 입력은 P1 수용 기준의 수동 확인 항목**으로 이관한다.

`preview-host-alternatives.md` §5의 W1–W7을 하나의 Electron 스크립트로 실행
(같은 창에서 서로 독립 검증 가능):

| # | 검증 | 통과 기준 | 실패 시 |
|---|---|---|---|
| W1 | 리사이즈 연속 변경 | 잔상·깜빡임 1프레임 이내 | `preview-host-alternatives.md` §6 출구(D′) |
| W2 | DOM 안 안정성(전환·토글·모달 100회) | 게스트 재로드 0회 | 마운트 위치 재설계 → 지속 실패 시 출구 |
| W3 | z-order | 모달·팝오버가 webview 위에 그려짐 | — |
| W4 | `will-attach-webview` 펜스 | 펜스 밖 attach 거절 | 펜스 재설계 |
| W5 | 드라이버 접근 | `webContents.fromId(getWebContentsId())` → 기존 CDP 통로 통과 | 규모 재산정 |
| W6 | park 상태 보존 | 1.5초 안 복귀, 스크롤·입력 유지 | park 구현 재설계 |
| W7 | 한국어 IME | 조합 중 글자 깨짐 없음 | — |

### P1. 호스트 교체 + 덮개 서브시스템 삭제 (규모 M — D′안의 P1+P2+P3를 합친 것보다 작다)

> **구현 완료 (2026-09-19).** 착지: `PreviewFrame.tsx`(web, 신규) ·
> `attachWindow` 펜스·클레임(desktop main) · `PreviewPage.contents` 레지스트리 ·
> IPC 정리(bounds/cover/freeze 삭제, host-ready 신설) · 드라이버 조회부 교체 ·
> `NativeHost`/`IframeHost`/`use-preview-cover`/`cover-reconciler` 삭제 ·
> `desktop-switch` 재작성(7/7) · `desktop-comments` 27/28 PASS.
> 실측 교훈(코드가 이긴다): (a) `webviewTag`는 반드시 `webPreferences` 안 —
> 밖에 두면 조용히 무시된다; (b) webview 요소에는 `allowpopups`가 없으면
> window.open이 조용히 차단된다(main 핸들러가 심판하려면 속성이 필요);
> (c) home 우선 워크스페이스에서 무대를 언마운트하면 게스트가 죽으므로
> `planner__body`(미리보기 열 포함)를 home에서도 마운트 유지한다(0폭 접힘).
> (d) **한 핀 주기 뒤 그 게스트 문서의 main→게스트 전달이 조용히 죽는다**
> (send·executeJavaScript 함께; 게스트→main은 산다) — 게스트 `capturePage(clip)`
> 이 유력한 발동조건이다. 크롭은 플래너 창 capturePage(`captureViaWindow`)로
> 대체했고, 핀 스윕(ⓒ)은 오버레이의 `colo-overlay:pins-poll` 폴백(게스트→main
> invoke)이 잇는다 — ⓒ 해결. 상류(Electron webview) 이슈로 보고할 가치가 있다.
> `desktop-comments` 잔여 1건(28 중, 재현율 100%): 둘째 ⌘T 스레드의 전송 뒤
> markSent 동기가 렌더러에서 아예 발화하지 않는다(진단: 렌더러 동기 카운터가
> 핀 추가 동기에서 동결, main lastPins 는 sent:false 로 멈춤 — 스레드 1의 같은
> 체인은 통과; 단일 usePins 인스턴스 확인, applyPinsSync 내부 예외 없음).
> 스윕 전달로 자체는 폴링 폴백으로 해결됐다(ⓒ 통과). 남은 조사는 웹측
> usePins/PageWorkspace 의 상태 전파 — suite 주석 스스로 stub-exit race
> 지뢰밭이라 부르는 영역. ⓚ 문구 기대치는 경로 계약(member/MemberList)으로
> 바로잡았다. 수동 확인 1건: macOS 한글 IME 조합 입력.

| 작업 | 파일 |
|---|---|
| `PreviewFrame.tsx` 신설: 프로젝트별 `<webview>` 맵(활성만 visible, 나머지 warm — `display:none` 금지), `MAX_LIVE_PAGES` 상한 이관, `epoch` 변화 시 `src` 재설정, `preload`=`preview-preload.cjs` 고정 | `web/src/components/preview/PreviewFrame.tsx` 신규 |
| desktop main에 `fencePreviewWebviews` 등록(§1-a) — 플래너 창에 `webviewTag` 활성화 + `will-attach-webview` 펜스 | `desktop/src/preview-inject.ts` 신규(또는 `windows.ts`에 인라인, 규모로 판단) |
| `PaneBrowserDriver.target()`: 레지스트리가 클레임한 게스트 `webContents`를 겨누도록 조회부만 교체(§1-a) — 오늘의 `debugger.attach` 이하 전부 무수정, 프레임 타깃·OOPIF 라우팅 **불필요**(D′라면 필요했던 것) | `desktop/src/preview-driver.ts:545-1492`(조회부 소폭 수정) |
| `PreviewHost.tsx` `native` 분기 제거, trail 상태 제거(`location`은 preload가 여전히 보고) | `PreviewHost.tsx:154, 216-222, 271-301, 463` |
| 삭제: `NativeHost.tsx`(231) · `IframeHost.tsx`(60) · `cover-reconciler.ts`(132) · `use-preview-cover.ts`(43) · `PlannerPreviewView` 뷰/park/cover/freeze/bounds(`preview-view.ts:193-233, 527-600, 1105-1170`) · `registerPreviewIpc` 중 `preview:bounds`·`preview:cover`와 freeze·park 가시성 계열만(`:1275-1370`) | — |
| IPC 유지(그대로): `preview:mount/unmount/open/open-external/navigate/history/reload/stop/zoom/comments-mode/pins/pin-flash/snapshot/emulate` + 위치·오류·로딩 릴레이 — 전부 main이 게스트를 겨누는 통로라 호스트가 DOM 요소로 바뀌어도 수신자만 `PreviewPage.contents`로 바뀐다 | `preview-view.ts:1275-1370` |
| e2e 핸들 계약 불변: `globalThis.coloDesignPlannerPreview.webContents()`·`.page.mountedUrl` 접근자가 claimed guest를 돌려주게만 하면 `desktop-comments.mjs`·`desktop-switch.mjs`의 main-process 실행 경로(`executeJavaScript` via `app.evaluate`)는 셀렉터 수정 없이 통과한다 — Playwright가 창을 입양하지 못하는 문제(`desktop-comments.mjs:17-21`)도 webview 게스트에서 동일하게 main 핸들로 해결된다 | `desktop/test/desktop-comments.mjs:176,207,1028` |
| 유지(무수정): `preview-preload.ts`(989) 전체, `OWNER_SCRIPT` 우회 주입(1-b 착수 전까지), 로밍(`kind: web`, `openTab`) · 배율(`enableDeviceEmulation`) · 모바일 풀 에뮬레이션 | `preview-view.ts`, `preview-preload.ts` |
| 데스크톱에 남는 것: `openInOs`(외부 링크) · 크롭(오늘과 같은 `capturePage`/`Page.captureScreenshot` 경로, 좌표 기준만 webview rect로) | `preview-view.ts` |
| 시점 빌드 `실제로 열기`: FrozenStage가 같은 `PreviewFrame`에 시점 빌드 서버 주소(`handoff-preview.ts` 무수정)를 로드 | `FrozenStage.tsx`, `ScreenPanel.tsx:566-670` |
| 테스트: `desktop-cover.mjs`(260)·`cover-reconciler.test.mts`(221) 삭제, `desktop-switch.mjs`(253) → "webview 마운트 유지·1.5초 복귀"로 재작성, `desktop-comments.mjs`·`browser-driver*.mjs` 셀렉터만 정정(기능 동일 — W5가 이걸 미리 증명) | — |

**롤백**: P1을 하나의 PR로 묶는다 — revert 한 번이 롤백이다(플래그 없음; 플래그를
남기면 삭제해야 할 것이 하나 더 늘어난다).

**수용 기준**: 모달·팝오버·`Tip` 호버카드가 프리뷰 위에 그려짐(스크린샷),
프로젝트 전환 후 복귀 시 스크롤·입력 상태 보존, 리사이즈 시 프레임 위치 지연
없음, **수동: macOS 한글 IME로 미리보기 input에서 조합 입력(한→한글→확정) —
스파이크가 CDP로 못 잰 항목**(`test/spike-webview.mjs` W7 비고), `desktop-comments.mjs`(셀렉터 정정 후 기능 동일 통과), `browser-driver*.mjs`
29케이스 통과, `browser-mcp.test.mjs` 통과, `screen-gate.test.mjs`·`browser-gate`·
`repo-handoff`·`preview-detect-e2e` 통과, **로밍·배율·모바일 에뮬레이션 회귀
없음**(D′라면 여기서 깨졌을 항목들).

### P2. Page Agent 이식 (선택 · 후속 사이클 — §1-b 착수 조건 성립 시)

D′ 출구를 싸게 만들 목적일 때만 착수. `packages/agent` 신설,
`preview-preload.ts:33-219`(describe*)·`:242-986`(오버레이·입력·배지) 이식,
`Transport` 추상화. 착수 전까지 `preview-preload.ts`는 그대로 유지된다.

### P3. 잔재·문서 (규모 S)

- `useMarks` 주석(`usePins.ts:156-158`, `PinTray.tsx:68`) 정리
- README `화면 축`·`미리보기 구조` 절 갱신 — "웹 개발 경로는 핀 미지원"이
  P1 뒤에도 그대로면 그 문구 유지, `IframeHost` 삭제로 개발 경로 전체가
  `PreviewFrame`(webview)으로 통일된다면 문구 삭제
- `chat-preview.tsx` 하네스는 `PreviewFrame` 기준으로 재점검

## 3. 규모 합계

| | 삭제 | 신규 |
|---|---|---|
| desktop | ~1,100 (`preview-view` 뷰/park/cover 부분 + 테스트 480) | ~150 (펜스·드라이버 target 조회 수정) |
| web | ~470 (NativeHost·IframeHost·reconciler·hook) + 테스트 221 | ~250 (PreviewFrame) |
| daemon | 0 | 0 |
| agent(P2, 선택) | — | ~650(착수 시에만) |
| **순 (P1까지)** | **≈ -1,190 LOC**, 우회 코드 층 그대로(agent 이식 전), daemon 무수정, **로밍·배율·모바일 에뮬레이션·권한 카드 전부 유지** | |

D′안(-1,540 LOC)보다 순감이 작은 이유는 `preview-preload.ts`·`OWNER_SCRIPT`
우회 주입을 P1에서 안 건드리기 때문이다 — 그 대가로 드라이버 재작성(M)과
사용자 손실 5개가 없다.

## 4. 리스크 → 대응

| 리스크 | 대응 |
|---|---|
| Electron이 `<webview>`를 실제로 deprecate/제거 | `preview-host-alternatives.md` §6 모니터링 신호(a) — 오면 D′ 재검토 착수 |
| MPArch 이행이 `getWebContentsId`/`debugger` 계약을 깨는 릴리스 | 신호(b) — Electron 릴리스 노트 추적, W5가 매 업그레이드마다 재확인할 회귀 스파이크가 됨 |
| W1–W7 중 하나가 실측 실패 | 신호(c) — 해당 항목만 재설계하거나 즉시 D′ 출구 |
| 두 프로젝트가 `127.0.0.1` 쿠키/스토리지 공유 | 오늘도 동일 문제(dev 서버가 같은 호스트) — B로 바뀌지 않는다, 별도 이슈 |
| `preview:mount` IPC와 `did-attach-webview`의 순서 경합(attach가 늦게 오거나, mount 요청이 클레임보다 앞서는 경우) | 클레임 전 op는 보류 큐에 쌍고 attach 시 배출 — 오늘의 `activePage` null 처리(`preview-view.ts`)와 같은 자리 |
| P1 착수 시점에 `desktop-comments.mjs`·`desktop-switch.mjs`에 미커밋 변경분이 있으면(2026-09-18 작업 트리) 테스트 정정이 섞여 원인 추적이 깨진다 | 착수 전 해당 변경분 커밋·정리 선행 |
| Playwright e2e가 `WebContentsView` 전제 | main 핸들(`coloDesignPlannerPreview.webContents()`)이 계약이라 영향 최소 — W5가 드라이버 접근 경로를 미리 증명 |

## 5. 결정 필요

없음 — D′안의 결정 필요 3개(로밍 폐지 여부·배율 폐지 여부·호스트 스킴)는 B가
전부 "폐지 안 함"으로 답을 대신한다. 유일한 조건부 결정은 §1-b(agent 이식)
착수 시점이고, 그건 착수 조건이 성립할 때 별도로 정한다.

## 다음 행동

P0 스파이크(W1–W7) 착수.
