# 미리보기 + 여정 띠 + product 확장 — 구현 스펙

> 슬라이스: `mockups/hero/journey.html`의 상단 여정 지도 + `mockups/hero/product.html`의 미리보기 문법 → 실제 구현.
> 근거 구현: `packages/web/src/components/panels/ScreenPanel.tsx`(사이클 바), `preview/PreviewHost.tsx`·`NativeHost.tsx`·`IframeHost.tsx`·`PinTray.tsx`, `hooks/usePins.ts`, `hooks/use-preview-cover.ts`, `lib/delivery.ts`, `lib/daemon-client.ts`, `shell/PageWorkspace.tsx`.

---

## 0. 기존 구현과의 매핑 (결론 먼저)

| 목업 장치 | 기존 구현 | 판정 |
|---|---|---|
| 여정 지도 띠 (4정류장) | 없음 — `deriveDelivery()`(`lib/delivery.ts`)의 상태표만 존재 | **신규 컴포넌트**, 데이터는 `deriveDelivery` 재사용 |
| 문서앱 제목바 (`바꿈 N · 저장 안 됨` → 저장 → 넘기기 → 동결 도장) | `ScreenPanel`의 `.screenpanel__bar` — 상태 칩 + [저장][개발자에게 넘기기][상태 확인][최신 변경 받아오기][더 보기] | **흡수한다(대체 아님)**. 바는 그대로 두고 칩·버튼의 문법만 문서앱형으로 재편. [상태 확인]은 칩 팝오버로 흡수, [최신 변경 받아오기][더 보기]는 유지 |
| 고침 표시 ③④⑤⑥ ↔ 핀 1:1 | 핀 배지 채널(`pinsSync` → 네이티브 오버레이) + `PinTray` + 고스트 배지 | **같은 채널 확장**. 보낸 핀(수정 의도)이 턴 종료 후 `done` 마크로 남고, 핀 없는 턴은 화면 단위 마크로 보완 |
| "크게 보기" 확장 (전체화면 + 접히는 대화 시트) | `PageWorkspace`의 grid 2열 + `Splitter` | **신규 레이아웃 상태**. 네이티브 뷰는 DOM 위에 그려지므로 시트는 오버레이가 아니라 도킹(아래 §4) |
| '보낸 화면' 동결 | 넘기기 시 `HandoffShot` 캡처 → `.colo-design/shots/` 커밋(PLAN D56, `repo-publish.ts attachShots`) — **이미 존재** | **재사용**. 읽어오는 API만 새로. `usePreviewCover`의 `data-cover-stage` 규칙으로 네이티브 뷰를 가리고 `<img>`를 올림 |

---

## 1. 화면/상태 목록

### 1-A. 여정 지도 (`JourneyMap`) — 제목 행 오른쪽, 읽기 전용

`deriveDelivery`의 `state`를 4정류장으로 기계 번역한다('연결' 정류장은 제외 — 대화 단위에선 노이즈, 계약 확정). 지도는 프레임 제목 행(.planner__header)의 오른쪽 끝에서 프로젝트 이름과 한 행을 쓴다 — 2026-09, 별도의 띠 행과 상태 캡션(`지금 장면 · …`)은 빠졌다: 상태는 점·색이 말하고, 세로 공간은 두 행에서 한 행으로 줄었다.

| `delivery.state` | 지도 |
|---|---|
| `clean` | 만들기=now |
| `unsaved` | 만들기=now |
| `saved` | 만들기✓ 저장=now |
| `handed` (open) | …✓ 넘기기=now |
| `changes_requested` | 넘기기=now(경고 톤) |
| `closed` (반려) | 넘기기=now(경고 톤) |
| `merged` + pendingChanges=0 + !running | 전부✓ 반영=arrived |
| `merged` + (pendingChanges>0 또는 running) | **리셋** → 만들기=now |
| `delivery === null` (phase ≠ ready/error) | 지도 자체를 숨김 — (준비 중엔 지도가 거짓말을 한다) |

**2주차 리셋 규칙(확정)**: `merged` 도착 상태는 "새 작업이 시작되기 전까지"만 유지한다. 리셋 트리거 = `pendingChanges > 0` 또는 `turnState === "running"`(새 고침 턴). 리셋되면 4정류장이 모두 비고 만들기가 now가 된다. 별도 시계·타이머 없음 — `delivery.state`와 `pendingChanges`만으로 결정되는 순수 함수(`deriveJourney(delivery, pendingChanges, running)`).

**주의 — 지도는 대화가 아니라 프로젝트 사이클의 것이다.** `repo.handoff`·`pendingChanges`는 프로젝트 단위라 같은 프로젝트의 모든 대화가 같은 지도를 본다. 목업의 "이 대화의 여정"은 현 구현에서 대화-사이클 1:1이 아니므로, 지도는 **워크스페이스 전체 폭의 제목 행**(chat+preview 위)에 두어 프로젝트 진실임을 레이아웃으로 말한다. 대화별 지도는 사이클이 대화 단위로 갈라지는 대공사가 선행돼야 하며 이 슬라이스 범위 밖(§7 리스크).

### 1-B. 미리보기 제목바 (문서앱 문법) — `.screenpanel__bar` 재편

| 상태 | docstate 칩 | [저장] | [넘기기] |
|---|---|---|---|
| clean | `변경 없음` (none) | 잠김 `저장할 변경이 없습니다` | 잠김 `먼저 저장해 주세요` |
| unsaved | `바꿈 N · 저장 안 됨` (warn) — N은 §3의 바꿈 수 | **활성 + primary + 심장박동** | 잠김 `저장하지 않은 변경이 있습니다` |
| unsaved + running | `고치는 중` (pending) | 잠김 `Claude가 고치는 중…` | 잠깐 |
| saved | `모두 저장됨 · {시각}` (ok) | 잠깐 | **활성 + primary** |
| handed | `검토 중 — {개발자} 확인 차례` (info) | 잠깐 | 잠깐 `이미 넘겼습니다…` |
| handed + 코멘트 도착 | `검토 중 · 코멘트 N` (info, 미처리 수) | 잠깐 | 잠깐 |
| changes_requested | `변경 요청` (changes) | 잠깐 | 잠깐 |
| merged | `반영됨` (merged) | 새 바꿈 있으면 활성 | 잠깐 `개발자가 이미 받아 갔습니다` |
| closed | `개발자가 반려함` (changes) | 새 바꿈 있으면 활성 | 잠깐 |
| shelf 있음 | `치워둔 작업 1건` (shelf) | 잠김 `치워둔 작업이 있습니다…` | 잠깐 |
| 넘기기 진행 중 (`diff.status.stage === "handing-off"`) | `넘기는 중…` (info) | 잠깐 | 잠깐 |
| phase ≠ ready/error | `화면 대기 중` (none) — 기존 그대로 | — | — |

- 칩 클릭 = 기존 `statusOpen` 팝오버(`delivery.next.line` + `이 프로젝트 → owner/repo` + `지금 확인`). **[상태 확인] 버튼은 이 팝오버로 흡수되어 바에서 사라진다.** 미처리 개발자 코멘트 수는 칩 라벨에 합류(`검토 중 · 코멘트 N`).
- [저장] 심장박동: `unsaved && !running`일 때만. `prefers-reduced-motion`에서 끈다.
- `바꿈 N`의 N: **바뀐 화면 수**(§3 `pendingScreens`) — 없으면 `pendingChanges`(파일 수)로 폴백. 기존 칩이 파일 수를 뺀 이유(체감과 역상관)는 파일 수에 대한 것이고, 화면 수는 체감과 정상관이라 재도입이 정당하다.

### 1-C. 고침 표시 (마크) — 미리보기 위 번호

| 마크 종류 | 생명 | 모양 |
|---|---|---|
| 라이브 핀 (미전송) | `pins.list`에 있는 동안 | 기존 배지 그대로 (accent) |
| 고스트 (턴이 실어간 핀) | 턴 종료까지 | 기존 회색 그대로 |
| **done 마크** (보낸 `intent:"change"` 핀) | 턴 종료 → 사이클 리셋까지 | 초록 실선 테 + 번호 (목업 `mark--done`) |
| **화면 마크** (핀 없이 바뀐 화면) | 사이클 리셋까지 | 화면 프레임 구석의 번호 칩 — 요소 앵커 없음 |
| 진행 중 마크 (턴이 지금 만드는 곳) | 턴 동안 | 점선 + 펄스 (목업 `mark`/`ghost`) — **1차 구현 제외**, §7 |

번호 규칙: 한 사이클 안에서 1부터 단조 증가. 보낸 핀은 트레이 번호를 그대로 계승(③으로 보냈으면 done도 ③). 화면 마크는 그 다음 번호부터. 대화 속 핀 참조(③④⑤⑥)는 같은 레지스트리를 읽어 1:1을 보장한다 — **chat 슬라이스와의 계약: 번호의 단일 원천은 `useMarks` 레지스트리.**

### 1-D. "크게 보기" 확장 상태

| 상태 | 레이아웃 |
|---|---|
| 기본 | 기존 grid 2열(chat 1fr + preview `previewShown`px) 그대로 |
| 확장 | 미리보기 열이 body 전체 폭. 대화는 미리보기 열 **하단에 도킹된 시트**(높이 ~38vh, 최대 300px 스크롤 영역 — 목업 `talk__scroll` 수치) |
| 확장 + 시트 접힘 | 시트 자리에 알약 스트립 하나(`이 화면에 말 걸기 ⌘.`) — 높이 ~44px |

### 1-E. '보낸 화면' 동결

| 조건 | 표시 |
|---|---|
| `handed`/`changes_requested` + `pendingChanges === 0` + 샷 있음 | 스테이지가 커밋된 캡처 `<img>`로 바뀜 + 도장 `{시각}에 보낸 화면` + 탈색 |
| 위 조건 + 샷 없음(`shots:false`·브라우저 경로·캡처 실패) | 라이브 미리보기 유지 + 도장만 (`보낸 화면 캡처 없음 — 지금 화면을 보고 있어요` 툴팁) |
| handed + `pendingChanges > 0` (새 작업 시작) | 동결 해제 → 라이브. 세그먼트 `[보낸 화면 | 지금 화면]`가 남아 수동 왕복 가능 |
| `merged` | 동결 해제, 도장이 `실제 앱 · 반영된 화면`(ok 톤)으로 6초 후 사라짐 |
| `closed` | 동결 해제, 도장 `반려된 화면` — 라이브로 복귀 |

---

## 2. 컴포넌트 계획

### 신규
- **`packages/web/src/components/chat/JourneyMap.tsx`** — 읽기 전용 지도. props: `journey: Journey`(§3의 derive 결과). 정류장 4개 + 세그먼트. 클릭 핸들러 없음(읽기 전용 계약). `aria-label="이 작업의 여정"`, 정류장마다 `aria-current`. 제목 행(.planner__header) 안에서 프로젝트 이름 오른쪽에 렌더된다(캡션 없음 — 2026-09 제목 행 흡수).
- **`packages/web/src/lib/journey.ts`** — `deriveJourney(input: { delivery: Delivery | null; pendingChanges: number; running: boolean; shelf: boolean }): Journey | null`. 순수 함수, `delivery.ts`와 같은 파일 규율(표 한 곳). `Journey = { stop: 0..3; arrived: boolean; warn: boolean }`.
- **`packages/web/src/hooks/useMarks.ts`** — 고침 표시 레지스트리. `pins.ghosts`의 settle을 감지해 `intent:"change"` 핀을 done 마크로 승격, 핀 없는 바뀐 화면을 화면 마크로 추가, 번호 부여, sessionStorage 영속(`colo-design.marks.<slug>`), 사이클 리셋 시 클리어. 출력: `ColoDesignPinsSync` 확장분(§3).
- **`packages/web/src/components/preview/FrozenStage.tsx`** — 동결 표시: 캡처 `<img>` + 도장 + `[보낸 화면 | 지금 화면]` 세그먼트. `data-cover-stage`를 달아 `usePreviewCover`가 네이티브 뷰를 가리게 한다(기존 규칙 재사용 — 새 z-order 규칙을 만들지 않는다).
- **`packages/web/src/components/preview/TalkSheet.tsx`** — 확장 상태의 도킹 대화 시트 껍데기(헤더·접기 버튼·알약). 내용은 `ChatColumn`을 통째로 얹는다 — 대화를 재구현하지 않는다.

### 수정
- **`packages/web/src/components/shell/PageWorkspace.tsx`** — ① `JourneyMap`을 제목 행(`.planner__header`, 프로젝트 이름과 한 행)에 삽입 — 2026-09 제목 행 흡수로 별도의 띠 행은 없다. ② 확장 상태 `previewExpanded` 추가: grid를 `1fr`로 바꾸고 `ScreenPanel`만 렌더, `ChatColumn`은 `TalkSheet` 안으로 이동(언마운트 금지 — 스크롤·컴포저 상태 보존). ③ `⌘.` 토글(시트 접기), 확장 토글 키는 `⌘⇧E`(미사용 확인). ④ `useMarks` 마운트, `pinsSync` 대신 `marksSync`를 `ScreenPanel`→`PreviewHost`로 전달.
- **`packages/web/src/components/panels/ScreenPanel.tsx`** — `.screenpanel__bar` 재편: ① 칩을 docstate 문법으로(`chipGlyph` 유지, 라벨만 `delivery.chip.label` → docstate 문자열 매핑 — **문자열 생성은 `delivery.ts`로 내린다**, 컴포넌트에 분기를 두지 않는다). ② [상태 확인] 버튼 제거 → 칩 클릭이 `statusOpen` 팝오버를 열고 `지금 확인`이 그 안에 남는다(기존 `statusOpen`·`readHandoffState` 재사용). ③ `working` 표시(`다시 그리는 중`)는 유지. ④ `FrozenStage`를 `.previewcol__stage` 안에 조건부 렌더. ⑤ `PreviewHost`에 `frozen` props 전달.
- **`packages/web/src/components/preview/PreviewHost.tsx`** — ① 툴바에 `크게 보기` 버튼 추가(`onExpandToggle`). ② `핀` 버튼 옆에 `고침 표시` 토글(마크 on/off — `pinsSync`에 done/화면 마크를 포함할지의 플래그를 위로 올림). ③ `frozen` 모드: 주소창·상태 칩·핀 모드 비활성 + `FrozenStage` 렌더.
- **`packages/web/src/components/preview/NativeHost.tsx`** — 변경 없음(커버는 `usePreviewCover`가 처리). 단 `sync` prop이 확장 스키마를 받는다.
- **`packages/web/src/components/preview/PinTray.tsx`** — 번호를 `numberStart + index` 대신 `useMarks`의 `numberFor(pin.id)`로 교체(1:1 계약의 단일 원천).
- **`packages/web/src/lib/delivery.ts`** — `Delivery.chip`에 docstate 문자열 필드 추가(또는 `label`을 docstate 문법으로 교체 — 사이드바 배지가 이 라벨을 빌려 쓰는 규율이 있으니 **필드 추가**가 안전: `chip.docLabel`).
- **`packages/web/src/styles.css`** — `.jbar`(journey.html 19-156행), `.docstate`·`.mark`·`.stamp`·`.talk`·`.saypill`(product.html 78-300행) 이식. 목업 클래스명 그대로 가져오되 `--*` 변수는 기존 토큰에 매핑.

### 건드리지 않는 것
- `use-preview-cover.ts` / `cover-reconciler.ts` — `data-cover-stage` opt-in으로 해결.
- `IframeHost.tsx` — 브라우저 경로는 동결 시 `<img>`가 iframe을 덮는 DOM이라 커버 불필요.
- `DiffPanel`·`HandoffPanel` — 저장·넘기기 게이트 자체는 그대로.

---

## 3. 데이터 요구

### 이미 있는 것 (재사용)
- `daemon.repo.pendingChanges` — 바꿈 수 폴백·리셋 트리거.
- `daemon.repo.handoff: HandoffStatus { number, url, title, state, branch, reviewers? }` — 넘기기·반영·반려 판정.
- `daemon.repo.branch`, `daemon.repo.phase`, `daemon.repo.shelf` — 저장됨·치워둠 판정.
- `daemon.diffStatus.stage` — `handing-off`/`handed-off` 진행 표시.
- `api.diff(): DiffFile[]` — 바뀐 화면 추정의 원천.
- `api.saveHistory(): SaveHistory` — `모두 저장됨 · {시각}`의 시각.
- `api.handoffStatus(): HandoffStatusReport` — 코멘트 수·상태 재확인(기존 `readHandoffState`).
- **`HandoffShot` 파이프라인 전체** — 넘기기 시 선언 화면×상태 캡처가 `.colo-design/shots/<route>--<state>.<ext>`로 사이클 브랜치에 커밋됨(`repo-publish.ts:315-335`). 동결 표시의 1단계 데이터.
- `pinsSync`/`ColoDesignPinsSync` — 마크 투영 채널.
- `window.coloDesignDesktop.preview.snapshot()` — 화면 보여 주기가 쓰는 프레임 캡처(동결 폴백에 재사용 가능).

### 새로 필요한 것
| 필요 | 위치 | 내용 |
|---|---|---|
| `HandoffStatus.handedAt?: string` (ISO) | `packages/protocol/src/repo.ts` + 데몬 `refreshHandoff` | 도장의 `{시각}에 보낸 화면`. GitHub PR `created_at`이 원천, 없으면 데몬이 넘기기 성공 시각을 기록. `mergedAt`도 같은 자리에(반영 도장용). |
| `api.handoffShot(route, state): Promise<{ mediaType: string; data: string } \| null>` | `daemon-client.ts` + dispatch | `.colo-design/shots/` 파일을 **`git show <handoff.branch>:<path>`로 읽는다** — 워크트리가 아니라 커밋에서 읽어야 넘긴 뒤 이어진 작업·반려·베이스 복귀에도 '보낸 그대로'가 보존된다. |
| `RepoStatus.pendingScreens?: string[]` | `repo.ts` + 데몬 | 바뀐 화면 route 목록. 추정 규칙: `api.diff()` 경로의 폴더(`fallbackGroup`과 같은 절단) ↔ 선언 화면 route 첫 세그먼트 매칭. 매칭 실패 시 빈 배열(거짓 마크보다 부재가 낫다). |
| `ColoDesignPinsSync.pins[]` 확장 | `preview.ts` + 네이티브 오버레이 | `{ tone?: "live" \| "sent" \| "done"; screenMark?: boolean }`. `screenMark: true`는 `path` 없이 화면 프레임 구석에 앵커. 오버레이(데스크톱 main)의 배지 렌더가 `done`을 초록 실선으로 그린다. |
| 마크 영속 | `useMarks` | sessionStorage `colo-design.marks.<slug>` — 핀과 같은 수명 규칙(리로드 생존, 사이클 리셋·프로젝트 전환 시 클리어). |

### 2단계 경로 (시점 빌드 재현 — 후속)
- `api.handoffPreview(): Promise<{ url: string } | null>` — 데몬이 `handoff.branch` tip을 별도 워크트리(`git worktree add`)로 체크아웃하고 두 번째 포트에서 프리뷰를 띄워 반환. `FrozenStage`의 `[보낸 화면]`이 이미지 대신 이 URL의 읽기 전용 호스트가 된다. 인프라(포트 펜스·수명 관리)가 무거워 1단계는 커밋된 스크린샷으로 시작 — 합성 문서의 "스크린샷+시각으로 시작하고 업그레이드" 그대로.

---

## 4. 상호작용 상세

### 여정 지도
- **클릭 없음.** 정류장·세그먼트 전부 읽기 전용. 호버 시 `Tip`으로 그 정류장의 의미 한 줄(`저장 — 고친 것을 우리 팀 앱 개발자가 볼 수 있게 묶어 둡니다`).
- 전환은 `delivery.state` 변화에만 반응 — CSS `transition`으로 점·세그먼트가 채워진다(목업 `.jseg::after` scaleX).
- `merged` 도착 시 `arrived` 펄스 1회(기존 `mergedFlash`와 같은 박자 — `colo-design:merged` 이벤트 재사용).

### 제목바
- **docstate 칩 클릭** → `statusOpen` 팝오버(기존). Escape·백드롭 닫기 기존 그대로.
- **[저장] 클릭** → 기존 `setSaveOpen(true)` → `DiffPanel`. **`⌘S` 추가**: `PageWorkspace` 키 핸들러에 `s` 분기 — `delivery.actions.save.enabled`일 때만, 아니면 무시(잠긴 이유는 칩 title이 말한다). 네이티브 뷰 포커스 중엔 기존 키 릴레이(`NativeHost onKey`)가 `key:"s"`를 되말리므로 같은 리스너가 받는다.
- **[넘기기] 클릭** → 기존 `setHandoffOpen(true)` → `HandoffPanel`. 저장 전 잠김은 `delivery.actions.handoff.reason` 그대로.
- **넘기기 완료(`stage:"handed-off"`)** → `handoffShot` 조회 → 성공 시 `FrozenStage` 진입 + 도장. 실패·없음 시 라이브 유지(도장만).

### 고침 표시
- **마크 클릭** → 대화의 해당 핀 참조로 스크롤(chat 슬라이스 계약; 없으면 `onPinFocus`로 트레이 행 포커스 — 기존 동작 폴백).
- **`고침 표시` 툴바 토글** → done/화면 마크만 숨김(라이브 핀·고스트는 핀 모드의 것이라 그대로). 목업 `nohl`과 동일 의미.
- **핀 모드(⌘⇧P)** — 기존 그대로. 마크와 무관.

### 크게 보기
- **툴바 `크게 보기` 버튼 / `⌘⇧E`** → `previewExpanded` 토글. 확장 진입 시 `previewWidth` 드래그 상태는 무시(전체 폭).
- **시트 접기 `⌘.` / 헤더 chevron** → 알약 스트립만 남김. 알약 클릭·`⌘.`로 재개방.
- **확장 해제** → 기존 2열 + `previewShown` 복원(선호도는 `settings.layout.previewWidth`에 이미 있다).
- **네이티브 뷰 제약(결정)**: `WebContentsView`는 모든 DOM 위에 그려지므로 시트를 스테이지 **위에 띄우는 것은 불가** — `usePreviewCover`로 가리면 미리보기가 얼어붙어 확장의 존재 이유가 죽는다. 따라서 시트는 미리보기 열 하단에 **도킹**(뷰 bounds가 ResizeObserver로 따라 줄어든다 — `NativeHost`의 기존 메커니즘이 그대로 처리). 목업의 오버레이 미학과 다르지만 유일하게 라이브를 유지하는 형태. iframe 경로도 같은 도킹으로 통일(두 경로의 레이아웃 분기 금지).

### 동결
- `FrozenStage` 안에서 스크롤·클릭은 이미지에 대한 것뿐(확대 없음 — 1단계).
- `[지금 화면]` 선택 시 커버 해제 → 라이브 뷰 복귀(`cover(false)`는 reconciler가 상태로 수렴).
- `pendingChanges > 0`이 되는 순간 자동으로 `[지금 화면]`으로 돌아온다 — 새 작업이 시작됐는데 얼린 화면을 보여주는 것은 거짓말.

---

## 5. 엣지 케이스

- **반려(`closed`)**: 지도는 넘기기 정류장에 경고 톤으로 머문다(반영으로 위장 금지 — 기존 `saved` 위장 버그의 교훈). 동결은 해제.
- **넘긴 뒤 추가 저장**: `handed + unsaved`는 지도상 넘기기=now 유지 + docstate는 `바꿈 N · 저장 안 됨`(unsaved가 PR 상태보다 앞선다는 기존 규칙). 동결은 `pendingChanges>0` 규칙으로 자동 해제.
- **샷이 없는 넘기기**: `shots:false` 레포, 브라우저 경로(드라이버 없음), 캡처 실패 → 동결 없이 도장만. 기능 부재를 말하지 않되, `[보낸 화면]` 세그먼트는 렌더하지 않는다(눌러도 없는 것은 버튼이 아니다).
- **프로젝트 전환**: `useMarks`·`JourneyMap` 모두 `activeSlug` 키로 리셋 — `usePins`의 `loadedSlug` 패턴 그대로.
- **리로드**: 마크는 sessionStorage에서 복원, 고스트는 소멸(기존 규칙 — 리로드는 턴의 끝). 동결 상태는 `delivery.state`에서 재계산되므로 영속 불필요.
- **화면 마크 추정 실패**: diff 폴더↔route 매칭이 하나도 안 되면 화면 마크 0개 — done 핀만 표시. 추정이 틀릴 바엔 없는 게 낫다.
- **대화 없는 상태**: `delivery === null`(준비 중)엔 지도 자체를 숨긴다 — 빈 지도는 "아직 아무 데도 못 갔다"로 오독된다.
- **여러 대화가 한 사이클 공유**: 지도는 프로젝트 진실이라 대화를 바꿔도 같은 지도. 대화별 지도처럼 보이는 것을 막기 위해 지도를 전체 폭 제목 행에 둔다(§1-A).
- **`pendingScreens` 미구현 데몬**: 필드 optional — 없으면 `pendingChanges` 폴백과 화면 마크 생략.
- **확장 상태 + 모달**: `DiffPanel`·`HandoffPanel` 등 `.modal`은 `COVER_LAYERS`로 이미 커버됨 — 확장 여부와 무관하게 동작.
- **확장 상태에서 핀 찍기**: 시트가 도킹이라 뷰가 가려지지 않으므로 핀 모드 정상 동작. 시트에 가려진 영역은 뷰 bounds 밖이라 핀 불가 — 자연스러운 결과.

---

## 6. 구현 순서 (이 슬라이스 안)

1. **`lib/journey.ts` + `JourneyMap`** — `deriveDelivery` 출력만 읽는 순수 추가. 데몬 변경 0. 먼저 놓고 전환이 실제 상태를 따라가는지 눈으로 검증.
2. **제목바 재편** — `delivery.ts`에 `docLabel` 추가 → `ScreenPanel` 칩 교체 + [상태 확인] 흡수 + `⌘S`. 기존 동작(팝오버·다이얼로그) 전부 재사용이라 회귀 면이 작다.
3. **`useMarks` + 오버레이 `done` 톤** — 고스트→done 승격과 번호 레지스트리. `PinTray` 번호 교체로 1:1 완결. 화면 마크는 `pendingScreens`가 올 때까지 뒤로 미룬다(프로토콜·데몬 선행 필요).
4. **동결 1단계** — `handedAt` 필드 + `api.handoffShot` + `FrozenStage`(`data-cover-stage`). 샷은 이미 커밋되고 있으므로 읽기 경로만.
5. **크게 보기** — `PageWorkspace` 레이아웃 상태 + `TalkSheet` 도킹 + `⌘⇧E`/`⌘.`. 가장 독립적이라 마지막.
6. (후속·별도 슬라이스급) `handoffPreview` 시점 빌드 재현.

---

## 7. 리스크

- **지도의 단위 불일치(최대 리스크)**: 여정은 프로젝트 사이클, 목업은 대화 단위로 그렸다. 한 프로젝트에 대화가 여러 개면 "이 대화의 여정"이라는 프레임이 깨진다. 완화: 전체 폭 제목 행 배치(캡션은 2026-09에 뺐다 — `journey.scope === "thread"`일 때만 대화 제목 칩이 붙는다). 근본 해결(대화별 사이클)은 데몬의 사이클 모델을 갈아야 해 별도 결정 사항.
- **`바꿈 N`의 N 정의**: 화면 수(`pendingScreens`)는 폴더↔route 추정이라 레포 관례가 다르면 빈 배열로 떨어진다. 폴백(파일 수)은 기존에 "체감과 역상관"이라 버린 숫자 — N이 파일 수로 떨어질 때 칩이 옛 병으로 돌아간다. 추정 커버리지를 실측하고 안 되면 N을 빼고 `저장 안 됨`만 쓰는 퇴로를 남긴다.
- **시트 도킹 ≠ 목업 오버레이**: 네이티브 뷰 제약상 목업의 "화면 위에 얹히는 층"을 그대로 못 한다. 도킹은 뷰를 세로로 줄인다 — 38vh 시트가 뷰를 너무 누르면 확장의 가치가 줄어든다. 실측 후 시트 기본 높이 조정.
- **done 마크의 오버레이 작업량**: 배지 톤 추가는 데스크톱 main 프로세스의 오버레이 코드(`PlannerPreviewView`) 수정이 필요 — 이 문서 범위의 유일한 네이티브 변경.
- **동결의 진실성**: 1단계는 "넘긴 시점의 스크린샷"이지 "개발자가 지금 보는 화면"이 아니다(개발자가 브랜치에 커밋을 얹으면 어긋남). 도장 문구를 `보낸 화면`으로 유지해 약속을 과장하지 않는다. 2단계(시점 빌드)도 같은 한계를 공유 — 완전한 진실은 PR의 현재 tip 빌드뿐.
- **`⌘S` 충돌**: Electron 메뉴·OS 가로채기 확인 필요. 브라우저 경로는 페이지 저장 다이얼로그를 `preventDefault`로 막는다 — 개발자 도구 사용자에게만 이례적이나 이 앱의 사용자는 비개발자.
- **마크 번호와 대화 참조의 결합**: 번호 원천이 `useMarks` 하나로 가므로 chat 슬라이스가 같은 레지스트리를 읽지 않으면 ③이 두 군데서 다른 것을 가리킨다 — 크로스 슬라이스 계약으로 명시.
