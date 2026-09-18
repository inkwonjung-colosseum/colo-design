# 미리보기 호스트 대안 비교 (미구현 설계 문서)

> 이 문서는 아직 구현되지 않은 것을 다룬다. 구현 시점에 이 문서가 사실과 다르면
> 코드가 이긴다 — 착지점 파일을 다시 읽고 이 문서를 고친 뒤 손을 대라.
>
> **개정 (2026-09-18)**: 최초 판정(D 1순위)을 **B(`<webview>`) 1순위로 뒤집는다.**
> 최초 판정은 "유지보수 비용(Electron 비권장 문구·MPArch 이행)"을 기준으로
> 골랐는데, 그 기준으로는 D가 이기지만 **비개발자 사용자 경험** 기준으로는
> D가 5곳에서 진다(§3). 이 프로젝트의 판단 기준(§1)이 원래 "비개발자 대상"이므로
> 그 기준을 실제로 적용하면 B가 맞다. D는 §6에 "Electron이 webview를 실제로
> 깨뜨릴 때의 출구"로 남긴다.
> `preview-proxy-agent-plan.md`도 이 개정에 맞춰 B 기준으로 다시 썼다.

## 1. 판단 기준

Colo Design 제약에 대고 걸렀다: 비개발자 대상 · 미리보기 대상은 항상 **데몬이
띄운 loopback dev 서버**(범용 브라우저 문제인 임의 사이트·인증은 없음) · 핀은
요소 식별이 정확해야 함 · 게이트 자동재확인 · AI의 실입력(trusted 이벤트) ·
한국어 IME 입력 · 데몬 런타임 deps는 `ws`/`yaml` 최소 유지.

**타이브레이커 (개정으로 명시화)**: 두 방식이 위 기준을 동등히 만족하면,
**사용자에게 보이는 손실이 있는 쪽을 버린다** — 이 도구의 유일한 정체성이
"개발 지식 없는 사람이 겪는 화면"이라서다(README:3-4). 유지보수 편의·API
권장 여부는 사용자에게 안 보이는 한 2차 기준이다.

## 2. 전체 후보

| | 방식 | 핵심 아이디어 | 얻는 것 | 잃는 것 | 판정 |
|---|---|---|---|---|---|
| **B** | `<webview>` 태그 + main world agent 주입 | DOM 요소지만 게스트는 별 WebContents·별 프로세스(오늘의 격리와 동등). agent는 `webview.getWebContentsId()`→`webContents`에 오늘과 같은 CDP/`executeJavaScript` 통로로 주입 | 덮개·bounds 릴레이·park 전부 삭제(D′와 동일) + 격리·배율·로밍·모바일 에뮬레이션·CDP 드라이버 **거의 무수정** + 데몬 무수정 | Electron 공식 "권장하지 않음"(API 안정성), Chromium GuestView가 MPArch로 이행 중 — §6 스파이크로 실측 필요 | **1순위** |
| **D′** | Electron 주입 iframe + 플래너 origin 분리 | 평범한 cross-origin `<iframe src=dev서버>` + main이 `webRequest.onHeadersReceived`로 XFO/CSP 제거 + 프레임 CDP 세션에 agent 주입. 격리를 얻으려면 플래너를 `planner.localhost`로 옮겨야 함(§4) | B와 동일한 삭제 효과, 표준·"권장" API만 사용 | **사용자에게 보이는 손실 5개**(§3) — 로밍 폐지, 배율 폐지, 모바일 에뮬레이션 폭화, 프로젝트 간 격리 재검증 필요, origin 이전으로 설정 1회 리셋. 드라이버 재작성(OOPIF 세션 라우팅, M 규모) | **B 실패 시의 출구**(§6) |
| A | 데몬 프록시 + iframe | 데몬이 dev 서버를 리버스 프록시해 `agent.js` 주입 | D′와 동일한 삭제 효과 + 웹 개발 경로(`pnpm dev:web`)에서도 핀 동작 | 프록시 신규(HTML 재작성·HMR ws 파이프·토큰/쿠키), 격리 상실은 D′와 동일 문제 | 확장 후보 — 웹 전용 배포가 필요해질 때만 |
| A-lite | 프록시만, 호스트는 `WebContentsView` 유지 | A의 P1에서 멈춤 | main world agent, pane/게이트 agent 통일, 격리 유지 | 덮개·릴레이 세금 그대로 | 부분 개선, 채택 안 함 |
| C | 현 구조 + 모달을 네이티브 자식 창으로 | 덮개만 제거 | 격리 유지 | 릴레이·이중 경로·우회 주입 그대로, 모달 UI가 OS 창에 갇힘 | 기각 |
| E | 화면 스트리밍(offscreen + `Page.screencast` → canvas) | 완전 격리·단일 경로·게이트=pane | 격리 최고 | 한국어 IME 입력이 깨짐, 텍스트 블러, 지연, 접근성 상실 — R6 정면 위반 | 기각 |
| F | 레포 측 플러그인 주입(Vite/Next 플러그인) | 레포가 agent를 로드 | 프록시 불필요 | 레포 협조 필수 — "어느 레포든 처음부터 동작" 약속 위반(`data-colo-src`와 같은 함정) | 기각 |
| G | 별도 브라우저(포크·확장) | 사용자 브라우저에 확장 | 실브라우저 | 비개발자 설치 마찰, 제품 정체성 변경 | 기각 |

## 3. B vs D′ — 사용자가 실제로 겪는 차이

D′가 B를 유지보수 축에서 이기는 것은 사실이지만, 사용자 경험 축에서는 D′가
이기는 행이 하나도 없고 지는 행이 5개다.

| 사용자가 겪는 것 | 오늘(WebContentsView) | B(`<webview>`) | D′(iframe) | 근거 |
|---|---|---|---|---|
| 모달·팝오버가 뜨면 미리보기가 정지 사진으로 바뀜 | ✗ (덮개) | ✓ 해소 | ✓ 해소 | `preview-view.ts:32-33`, `NativeHost.tsx:12-14` |
| 리사이즈 시 미리보기가 한 박자 늦게 따라옴 | ✗ (bounds IPC) | ✓ 해소 | ✓ 해소 | — |
| 레포 앱이 멈춰도 도구는 살아 있음 | ✓ | ✓ 공짜(별 프로세스) | ✓ 단, 플래너 origin 이전 필요 | strict site isolation은 site(scheme+eTLD+1, 포트 무시) 단위 — `127.0.0.1` 플래너·미리보기가 같은 site면 같은 프로세스 |
| 다른 프로젝트 앱이 멈춰도 지금 미리보기는 안 멈춤 | 해당 없음(별 프로세스) | ✓ | 이전 안 하면 **위험** | 위와 동일 근거 |
| 배율 조절 | ✓ (README:125) | ✓ 그대로 | ✗ 삭제 | OOPIF에 zoom이 전파되지 않음(`ShouldEnableSubframeZoom`) |
| 모바일 화면 충실도(터치·DPR·모바일 UA) | ✓ 풀 에뮬레이션 | ✓ 그대로 | 폭만(CSS media query 수준) | `preview-view.ts:886-889` `enableDeviceEmulation`이 게스트/자식 프레임엔 못 걸림 |
| `앱에서 링크 열기` | ✓(기본 꺼짐) | ✓ 그대로 | ✗ 삭제(임의 origin을 iframe에 못 넣음) | `settings.ts:219-224` |
| 업데이트 뒤 설정이 한 번 초기화됨 | 없음 | 없음 | 있음(origin 이전 → localStorage 리셋) | — |
| 사용자가 보는 것 = AI가 검증하는 것 | 같음 | 같음 | 다름(게이트 창은 풀 에뮬레이션, pane은 폭만) | `mcp-roadmap.md:62-63` 약속과 충돌 |

D′ 쪽에서 ✓인 항목은 B에서도 전부 ✓다. **B가 D′를 지는 사용자 체감 항목은 없다.**

## 4. D′를 원래 앞에 뒀던 근거와 반론

- **Electron 문서가 `webview` 비권장**(API 안정성 경고, 문구는 2019년부터 유지).
  → 위험이 현실화될 때 비용을 내는 쪽은 개발자다(마이그레이션), 사용자가 아니다.
  이 앱은 Electron을 고정해 빌드·배포하고(`electron ^44.2.0`), e2e
  (`desktop-comments.mjs`·`browser-driver*.mjs`)가 릴리스 전에 회귀를 잡는다.
- **Chromium GuestView가 MPArch로 이행 중**이라 "게스트=별 WebContents" 전제가
  바뀔 수 있음. → 이행 완료 시점은 미정이고, 완료되어도 `<webview>` 태그 자체가
  제거되는지는 별개다. 확정 리스크가 아니라 **모니터링 항목**(§6)으로 관리한다.
- 두 근거 모두 **미래·불확실한 개발 비용**인데, B→D′ 손실 5개는 **확정·현재의
  사용자 손실**이다. 비개발자 제품에서 이 교환은 성립하지 않는다.
- 출구는 닫히지 않는다: agent 패키지(transport 추상화)와 호스트를 감싸는
  `PreviewFrame` 컴포넌트를 B·D′ 공용으로 설계하면, 강제 이행이 오는 시점에
  바뀌는 것은 호스트 요소 하나(`<webview>`→`<iframe>`) + 드라이버의 프레임
  타깃 지정뿐이다. 지금 그 비용을 선불하는 것이 D′, 필요할 때 내는 것이 B다.

## 5. B의 스파이크 — 실측할 위험 (반나일, 실레포 1개)

| # | 검증 | 방법 | 통과 기준 | 실패 시 |
|---|---|---|---|---|
| W1 | 리사이즈 | pane 폭을 드래그로 연속 변경 | 잔상·깜빡임 1프레임 이내, 레이아웃 튐 없음 | D′로 후퇴 |
| W2 | DOM 안 안정성 | 프로젝트 전환·사이드바 토글·모달 열닫 100회 | 게스트 재로드 0회(`<webview>`는 DOM에서 떼면 게스트가 죽는다 — 마운트 위치 고정 + 안정 `key`로 확인) | 마운트 위치 재설계, 실패 지속 시 D′ |
| W3 | z-order | 모달·팝오버·`Tip` 호버카드가 webview 위에 그려짐 | 스크린샷 확인 | (DOM 요소라 실패 가능성 낮음) |
| W4 | `will-attach-webview` 펜스 | `src`를 `loopbackHttp`로 제한, `preload`·`nodeIntegration`·`partition` 고정 | 펜스 밖 attach가 거절됨(렌더러가 임의 origin·임의 preload를 못 지정) | 펜스 재설계 |
| W5 | 드라이버 접근 | `webContents.fromId(webview.getWebContentsId())` → 오늘의 CDP `debugger.attach` 그대로 | `browser-driver*.mjs` 시나리오 하나가 이 경로로 통과 | 드라이버 수정 규모 재산정 |
| W6 | park 상태 보존 | `visibility:hidden`/오프스크린 배치 후 복귀 시 스크롤·입력 유지 | 1.5초 안 복귀(`desktop-switch.mjs` 계약), `display:none` 미사용 확인 | park 구현 재설계 |
| W7 | 한국어 IME | 게스트 안 한국어 조합 입력 | 조합 중 글자 깨짐 없음 | (실패 가능성 낮음) |

D′의 S1′(주입 타이밍)·S2(프로세스 격리)·S3(OOPIF 세션 라우팅)는 **필요 없다** —
B는 오늘의 `preview-preload.cjs`를 `<webview preload>` 속성으로 그대로 얹어
주입 타이밍 문제가 없고, 격리는 별 WebContents가 공짜로 주고, 드라이버는
프레임이 아니라 게스트의 최상위 `webContents`를 그대로 겨눈다(OOPIF 라우팅 불필요).

## 6. 권고

**B를 1순위로 채택.** 판정 근거는 §3의 UX 비교표 — D′가 이기는 사용자 체감
항목이 없고 지는 항목이 5개다. `preview-proxy-agent-plan.md`를 B 기준으로
다시 썼다(P0=W1–W7, P1=호스트 교체, agent 이식은 선택·후순위).

**D′는 출구로 유지, 모니터링 항목**: 다음 신호가 오면 D′ 재검토를 시작한다 —
(a) Electron이 `<webview>`를 실제로 제거/deprecate 예고, (b) MPArch 이행이
`webContents.debugger`/`getWebContentsId` 계약을 깨는 릴리스 노트, (c) W1–W7
스파이크 중 하나가 실측으로 치명적으로 실패. agent 패키지의 transport
추상화(`postMessageTransport`)는 이 출구를 싸게 만들려고 유지한다.

A(프록시)는 여전히 "웹 개발 경로(`pnpm dev:web`) 패리티가 필요해질 때의 확장"
부록으로 둔다 — B와도 독립적으로 얹을 수 있다(agent 패키지 공유).
