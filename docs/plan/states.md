# 상태 기계 + 모달/드로어 + 가장자리

> 슬라이스: 상태 어휘·전이, 장면 밖 표면(모달·드로어·팔레트), 가장자리 상태
> 근거: `.local/share/plan-brief.md`(공통 계약), `docs/hero-synthesis.md`, `mockups/final/*`, `mockups/hero/*`, 기존 구현(`packages/web/src/lib/delivery.ts`, `packages/web/src/lib/daemon-client.ts`, `packages/web/src/components/**`)
> 코드 수정 없음 — 계획만. 이 파일 하나만 씀.

---

## 0. 전제 — 상태는 세 층이다

사용자가 보는 상태 언어는 8단어뿐이다. 그 밑에 두 층이 더 있고, 이 층 구분이 이 슬라이스의 모든 판정의 기준이다.

| 층 | 어휘 | 사는 곳 | 사용자에게 노출 |
|---|---|---|---|
| **사이클 어휘 (8단어)** | 변경 없음 · 저장 안 함 · 저장됨 · 확인 중 · 변경 요청 · 반영됨 · 반려 · 치워둔 작업 | `lib/delivery.ts` `DeliveryState`(clean/unsaved/saved/handed/changes_requested/merged/closed + shelf) | 그대로 (칩·배지·카드의 단어) |
| **턴 오버레이** | 작업 중 / 고치는 중 / 확인 대기 | protocol `SessionState`(starting/idle/running/waiting_permission/waiting_question/error/closed) | 오버레이로만 — 8단어를 덮는 말이지 9번째 상태가 아니다 |
| **기계 상태** | `RepoPhase`, `DiffStatus.stage`, `HandoffStatus.state`, `OnboardingStepId` | 데몬↔클라 프로토콜 | 금지 — UI가 8단어로 번역한다. `computing`, `handed-off`, `colo-design/20260916-1` 같은 단어는 화면에 없다 |

핵심 규율(기존 구현이 이미 가진 것, 유지): **행과 칩이 어긋나지 않는다** — `deriveDelivery()`가 칩·다음 줄·버튼 잠김·강조를 하나의 원천에서 정하고, 사이드바·제목바·인박스가 이 파일의 단어를 빌려 쓴다(`delivery.ts` 머리 주석의 규율). 새 슬라이스(사이드바·product·home)도 이 상수만 읽는다.

---

## 1. 화면/상태 목록

### 1.1 상태 어휘 8개 — 전이표

발화 주체 4종: **[사용자]** 버튼 / **[에이전트]** Claude 턴 완료 / **[개발자]** GitHub 사건 / **[폴링]** 데몬의 주기 읽기(사건을 늦게 전달하는 운반일 뿐, 전이의 원인이 아님).

| From → To | 발화 | 기계 사건 (이미 구현된 것) | 비고 |
|---|---|---|---|
| (새 프로젝트) → **변경 없음** | 사건 | `RepoPhase=ready` + `pendingChanges=0` + `branch=null` | clean 행. 칩 `변경 없음`, 다음 줄 "저장할 새 작업이 없습니다…" |
| **변경 없음 → 저장 안 함** | [에이전트] | 화면을 고친 턴이 끝남 → `refreshPendingChanges` → `repo.status` 방송 | **타이머로 세지 않는다**(RepoStatus 주석 규율). 폴링으로 칩을 갱신하면 버튼이 거짓말을 한다 |
| **저장 안 함 → 저장됨** | [사용자] | `[저장]` → `api.save()` → `diff.status` computing→pushing→published | 첫 저장이면 데몬이 사이클 브랜치(`colo-design/YYYYMMDD-n`) 생성. 실패 시 아래 1.3 |
| **저장됨 → 확인 중** | [사용자] | `[넘기기]` → `api.handoff()` → handing-off→handed-off | `HandoffStatus{state:"open"}` 세팅. 칩 라벨은 오늘 "개발자 검토 중" → **"확인 중"으로 단일화**(아래 1.4) |
| **확인 중 → 변경 요청** | [개발자] (전달은 [폴링]/[사용자]) | GitHub review `changes_requested` → `setCycle` → `project.changed`/`repo.status` | 도달 경로 3개 — §1.5 함정 참조 |
| **확인 중 / 변경 요청 → 반영됨** | [개발자] (전달 동일) | `pull.state=merged` | fleet은 끝을 `endedHandoff`에 **세워만 둔다** — 착지는 사람이 있는 자리에서(§1.5-2). 다음 저장 = 새 사이클 |
| **확인 중 / 변경 요청 → 반려** | [개발자] (전달 동일) | `pull.state=closed` | closed 행. primary=`check`. 다음 저장 = **새 요청** |
| **변경 요청 → 확인 중** | [사용자] | 고쳐서 `[저장]` → 같은 PR에 push → GitHub이 `open`으로 재판정 | "변경 요청 배지가 사이클 끝까지 붙는" 함정 방지 규칙(`github.test.mjs` 주석) |
| **저장 안 함 → 치워둔 작업** | [사용자] | `[잠깐 치워두기]`(더 보기 메뉴, 또는 버리기 확인의 alt 버튼) → `api.shelve()` | `shelf.at` 세팅, `pendingChanges→0`. **치워둔 동안 `변경 없음` 칩은 존재하지 않는다** — 치워둔 것은 없음이 아니라 상태(delivery.ts clean+shelf 행) |
| **치워둔 작업 → 저장 안 함** | [사용자] | `[꺼내기]` → `api.unshelve(sessionId)` | 충돌 시 그 대화의 Claude 다음 턴으로 브리프, 슬롯은 생존 |
| **반영됨/반려 → 저장 안 함** | [에이전트]+[사용자] | 새 사이클의 첫 변경 → 첫 `[저장]`이 새 브랜치 | merged 행의 규칙 승계: 반영 뒤 변경이 쌓이면 칩은 `저장 안 함`(unsaved가 앞선다), "반영됨"이라는 사실은 title과 다음 줄이 전달 |
| (어느 행이든, 칩 표면만) → **작업 중/고치는 중** | [에이전트] | `session.state=running` | `deriveDelivery`의 running 오버레이 — **말만 바뀌고 잠김은 표 그대로** |

### 1.2 턴 오버레이 (8단어 밖의 말)

| SessionState | 사용자가 보는 말 | 어디에 |
|---|---|---|
| `running` | 작업 중 / 고치는 중 | 칩·사이드바 배지·리프 메타 |
| `waiting_permission` | 도구 확인 한 줄(접힘) + 승인 카드 | 대화 안. 사이드바에서는 **확인 대기** |
| `waiting_question` | 결정 카드(질문+즉답 칩) | 대화 안. home 인박스의 "나를 기다리는 일"(home 슬라이스) |
| `error` | 크래시 카드 | 대화 안 |
| `starting/idle/closed` | 무음 | — |

### 1.3 저장·넘기기의 실패 상태 (8단어에 못 미치는 자리)

| 사건 | 표현 | 복귀로 |
|---|---|---|
| 저장 게이트 실패 (`DiffStatus{stage:"failed", gate:"commit"|"push"|"diff"}`) | 진행 한 줄이 실패 문장으로, 상태는 **저장 안 함 유지**(변경은 살아 있음) | 실패 내용이 그 대화의 Claude 다음 턴으로 브리프(`gateThreadFor` — "저장 문제 해결") |
| 푸시 인증 실패 (`reason:"push-auth"`) | 같은 줄 + **[토큰 바꾸기]→설정 직행** (Claude 턴 돌리지 않음) | 설정 연결 그룹 |
| 커밋 착지·푸시 실패 (push-stalled) | worktree는 clean → 빈 검토가 "저장할 게 없다"고 거짓말하지 않게 **저장 버튼이 눌린다 = 올리기 재시도** (`DiffPanel` 427주석, `repo-publish.ts` runSave) | 같은 버튼 |
| 넘기기 게이트 실패 (`gate:"pr"`) | 같은 채널의 진행 한 줄 | "넘기기 문제 해결" 브리프 + pr 실패는 설정 문제로 [설정 열기] |

### 1.4 어휘 단일화 — 기존 라벨 → 8단어

`delivery.ts`의 칩/배지 상수가 단일 원천이다. 바꿀 것:

| 기존 (파일·심볼) | 8단어로 | 비고 |
|---|---|---|
| 칩 `개발자 검토 중`(handed) | **확인 중** | 계약 어휘. journey 목업의 "검토 중" 별칭은 버린다 — 한 단어만 |
| 칩 `개발자가 반려함`(closed) | **반려** | topbar 칩의 "개발자가 반려했어요"(rejected.html)는 문장형 자리라 유지 가능 — 칩은 단어 |
| 칩 `치워둔 작업 1건` | **치워둔 작업** | 개수는 셈에 넣지 않는다(슬롯은 하나뿐) |
| 배지 `넘김`(`HANDOFF_BADGE`) | 유지 — **묶음 명사** | 사이드바 묶음 "넘긴 것"과 짝인 단어. 상태 단어(확인 중)와 역할이 다르다 |
| `변경 N`(`changesBadge`) | 칩에서는 **저장 안 함** | 파일 수 칩 제거 결정(delivery.ts) 유지. 단 계약의 제목바 `바꿈 N`은 별개의 수 — §3 새 데이터 |

### 1.5 폴링 함정 — 명시 (요구 항목)

1. **10분 폴링이 세워 두는 지연.** fleet 폴링은 `HANDOFF_POLL_MS = 10*60_000`(`daemon/src/server.ts`). 확인 중→변경 요청/반영됨/반려 전이는 **개발자가 누른 순간이 아니라 폴링이 본 순간**까지 최대 10분 늦다. home 인박스의 "코멘트 도착"·푸시 판정이 이 시계를 그대로 쓰면 "진짜 막힌 대목" 알림이 늦어진다 — **푸시 기준은 사건 발생이 아니라 앱이 그 사건을 본 시각임을 카피가 정직하게 말해야 한다**("코멘트가 도착했어요"가 아니라 "어제 밤에 달렸어요" 수준의 시각 표기). 알림 게이트 자체는 백엔드 정책(종합 §6 잔여).
2. **착지는 세워만 둔 끝을 사람이 내려앉힌다.** `peekHandoff()`는 merged/closed를 `endedHandoff`에 넣고 `handoffLandingDue`로 다음 폴링을 스킵한다. 사이클 착지(새 사이클 문 열기)는 `landHandoffIfDue()`가 사람이 있는 자리(상태 확인·프로젝트 활성화·다음 저장 머리)에서만 돈다. 함정: 칩은 이미 반영됨인데 내부 규칙은 잠깐 옛 사이클 — 그 창에 저장하면 저장이 착지를 먼저 수행하므로 안전하지만, **이 한 박자를 UI가 말로 덮어선 안 된다**(반영됨 칩 + "다음 저장은 새 사이클" title이 이미 그 답).
3. **pendingChanges는 절대 폴링로 세지 않는다.** 턴 종료·저장 완료에만 셈(RepoStatus 주석). "저장" 버튼의 정직함의 근거. 신규 폴링 장치를 붙일 때 이 규율을 깨는 일이 최대의 회귀 지점.
4. **클라의 조용한 재읽기는 5분 스로틀 + 턴 중/refreshing 중 스킵**(`ScreenPanel` `lastQuietRead`). `handoffStatus()`는 병합을 보면 **체크아웃까지 하는 능동적 읽기**라 백그라운드 타이머에 올리면 안 된다 — 오늘 그래서 사람 존재 조건이 걸려 있다.
5. **문장의 층 혼동 정리.** `daemon-client.ts`의 `handoffStatus` 주석 "Asked for by the planner, never polled"은 **UI 요청 경로**의 말이고, 실제 폴링은 데몬 fleet의 소관이다. 두 주석이 모순처럼 읽히지 않게 이 슬라이스 문서가 공식 해석: *칩의 갱신은 사건 방송(`project.changed`/`repo.status`)을 따르고, 그 사건을 데몬이 발견하는 건 10분 폴링이다.*

### 1.6 8단어가 뜨는 표면 전부 (이 슬라이스가 어휘를 공급, 배치는 각 슬라이스)

| 표면 | 오늘 | 판정 |
|---|---|---|
| ScreenPanel 상단바 칩(상태+저장+넘기기) | `deriveDelivery` | product 슬라이스의 문서앱 제목바로 승격 — 칩은 `바꿈 N · 저장 안 됨` 형(§3) |
| 사이드바 프로젝트 배지 | `badgeFor()` (내려받는 중 > 확인 대기 > 작업 중 > 넘김/반영됨 > 변경 N) | 사이드바 슬라이스가 상태 묶음으로 재배치 — **단어는 이 파일의 상수** |
| 대화 리프 메타 | 턴 상태만(작업 중/확인 대기/답이 왔습니다/시각) | 함정: 사이클은 **프로젝트 단위**라 리프별 사이클 단어는 오늘 없다(§7 리스크). 당분간 리프는 턴 상태만 |
| 대화 안 상태 카드·진행 한 줄·사람 메시지 | 없음(신규, §2) | chat 장면의 본체 |
| journey 지도 띠 / home 인박스 | 없음 | 각 슬라이스. 이 슬라이스는 전이표와 상수를 공급 |

---

## 2. 컴포넌트 계획

### 2.1 모달·드로어 총목록 — 기존 구현 매핑표 (요구 항목)

`mockups/final/modals.html`의 판정이 방향이다: **대화의 일(저장 검토·넘기기·코멘트·기록 서사)은 모달이 아니라 대화 안 카드로. 모달은 앱 자체에 관한 것만.**

| 표면 | 기존 구현 (파일) | 판정 | 새 어휘에서 |
|---|---|---|---|
| 저장 검토 | `panels/DiffPanel.tsx` (`.modal`) | **그릇 바뀜, 내용 승계** | 대화 안 저장 카드. 승계: 비개발어 요약(`summarizeDiff`, claude/fallback), 메모 프리필, 파일 접기(`자세히 보기`), 3걸음 레일(바뀐 점 모으기→올리기→완료), push-stalled 재시도, **복도**(검토 끝→넘기기로 이어가기) |
| 넘기기 | `panels/HandoffPanel.tsx` (`.modal`) | **그릇 바뀜** | 대화 안 넘기기 카드: 읽기 우선 미리보기(제목·본문=handoffDraft), 자동 첨부 명시(`extras.commentsSection`=### 수정 요청, `shotCount`=### 화면 미리보기), `직접 고치기` 폴드, 목적지(owner/repo) 표기, `DEFAULT_HANDOFF_BODY` 폴백. 신규: **함께 넘어가는 것** 목록(product.html "오늘 바꿈 N개") + 전송 후 **동결 도장**(§3-3) |
| 저장 기록 | `shell/HistoryDrawer.tsx` (드로어) | **드로어 유지, 역할 재정의** | 대화의 상태 카드 연쇄가 사이클의 1차 기록(서사). 드로어는 **되돌리기 도구**: 전체 기록 + 행별 `[이 시점으로]`(`restore(sha)`, 새 커밋으로) |
| 개발자 코멘트 | `ScreenPanel` devPanel(슬라이드) + 답하기 ConfirmDialog | **그릇 바뀜** | **사람 메시지**(아바타+이름+인용, chat.html devmsg) + jcard 타임라인 "개발자에게 넘긴 뒤 이야기"(rejected.html). 답하기는 컴포저에서(`replyToReview` 유지). 고침 표시↔핀 1:1은 preview 슬라이스와 공유 |
| 설정 | `dialogs/SettingsDialog.tsx` | **유지 + 확장** | 연결 그룹에 `토큰 다시 붙여넣기` 행(modals.html), 알림 그룹에 3단계 위계 스위치 2개(개발자 답변 알림, 저장 안 한 채 끌 때 물어보기) |
| 온보딩 | `onboarding/Onboarding.tsx`(전면 wizard: claude/git/runtime/github) + `RepoPicker` + `AddProjectDialog` | **유지 + 통합** | 첫 화면에 2단 흐름(토큰→레포→첫 대화)을 흡수(onboarding.html). 기계 게이트 wizard는 실패 시에만 전면 방해(오늘 규칙 유지: 막는 단계가 없으면 나가는 길 존재) |
| ⌘K 팔레트 | `shell/Palette.tsx` | **유지** | 그룹 대화→화면→프로젝트→명령. 명령 그룹에 `상태 확인` 노출 검토(§4) |
| 파괴 확인 | `dialogs/ConfirmDialog.tsx` | **유지** | 6곳(변경 버리기·대화 삭제·접속 주소 지우기·되돌리기·답 되감기·체크포인트 되돌리기) + `alt=잠깐 치워두기` 장치 승계. 신규 변형: 저장 안 하고 끄기 3버튼(§5) |
| 연결 끊김/토큰 만료 | `App.tsx` ConnectScreen(데몬 주소용) / `onboarding/GitHubTokenForm.tsx` | **신규 카드** | 만료 전용 오버레이 카드(modals.html "연결이 끊겼어요"): 토큰 붙여넣기→[다시 연결], "대화와 저장된 작업은 그대로" 문구. GitHub 토큰과 데몬 페어링 토큰은 별개임을 문구로 구분(§5) |
| 단축키 시트 | `dialogs/ShortcutsSheet.tsx` | **유지** | protocol `APP_SHORTCUTS` 단일 상수(데스크톱 메뉴와 한 벌) |
| 프로젝트 추가 | `dialogs/AddProjectDialog.tsx` | **유지** | 빈 작업대의 인라인 RepoPicker와 같은 컴포넌트 2곳 사용(오늘 규칙) |

### 2.2 표면별 스펙 — 진입점·내용·나가는 길

**저장 카드** (구 DiffPanel)
- 진입: 상단바/제목바 `[저장]`, ⌘S, 컴포저 위 `저장 안 된 변경 N` 배너 칩. 저장됨·확인 중 행에서는 잠김(title에 이유).
- 내용: 요약 1~3문장(`summarizeDiff` — "무엇이 바뀌었는지, 파일 이름 없이") → 저장 메모 필드(Claude 제안 프리필, `source:"claude"`만) → `자세히 보기` 폴드(파일·훈크) → 3걸음 레일. 검토만으로는 아무것도 나가지 않는다(오늘 문구 유지: "저장해도 아직 개발자에게는 가지 않습니다").
- 나가는 길: `[저장하기]`→진행 한 줄→`저장했어요` 상태 카드→**복도** `[개발자에게 넘기기로 이어가기]` / `아직이요, 더 고칠래요`(카드 접기, 상태는 저장 안 함 유지).

**넘기기 카드** (구 HandoffPanel)
- 진입: 상단바/제목바 `[넘기기]`(저장됨 행에서만 열림 — 저장 전 잠김, title=이유), 저장 카드의 복도.
- 내용: 개발자가 읽을 것의 렌더 미리보기(제목+본문 draft, `handoffDraft()`, 캐시는 사이클 tip 기준) + **함께 넘어가는 것**(이 사이클의 저장 묶음, 핀 기록이 `### 수정 요청`으로, 캡처 N장이 `### 화면 미리보기`로 — 자동 섹션임을 명시) + 목적지 표기.
- 나가는 길: `[넘기기]`→진행 한 줄("→ 박지훈님께 넘겼어요")→확인 중 칩+`[상태 확인]` 등장 / 취소=접기. 넘긴 뒤 미리보기 패널에 동결 도장.

**저장 기록 드로어**
- 진입: 미리보기 더 보기 메뉴(오늘 자리 유지).
- 내용: 이 사이클의 저장 행(메모·시각·파일 목록)+`[이 시점으로]`. busy(저장/넘기기/되돌리기 진행) 중 잠김 — `RUNNING` 공유 상수.
- 나가는 길: 행 클릭=되돌리기 확인(ConfirmDialog, "새 저장으로 돌아갑니다" 문장) / 밖 클릭·Escape.

**개발자 코멘트 (사람 메시지)**
- 진입: 없음(수동 진입 표면의 해체가 목적). 도착은 전이(변경 요청/반려)와 같이 온다. 수동 갱신은 `[상태 확인]`.
- 내용: 아바타+이름+인용("…") + 그 대화의 고치기 칩 + jcard 행(넘김 ✓ → 반려 ✕ 순 타임라인).
- 나가는 길: 답하기=컴포저(`replyToReview`), 고치기=그 자리에서 말하기(새 화면 없음 — chat 장면의 정점). 읽음 추적은 오늘의 `readReviews` 세트 승계.

**설정**
- 진입: 레일 풋터 ⚙, ⌘K 명령, 오류 카드의 `[설정 열기]`(push-auth·pr 게이트).
- 내용: 기존 행 + 연결 그룹(프로젝트 상태·`토큰 다시 붙여넣기`→GitHubTokenForm) + 알림 그룹(스위치 2).
- 나가는 길: Escape/닫기. 저장 개념 없음(즉시 적용, 오늘과 같음).

**온보딩 (첫 실행 흐름)**
- 진입: 첫 실행 자동(프로젝트 0), 설정의 `처음 설정 다시 보기`.
- 내용: 같은 화면에서 2단 — ①토큰 붙여넣기(`github.token.set`, GitHubTokenForm 재사용) ②레포 목록(`githubReposList`)+선택→`projectCreate`(클론 진행은 작업대의 RepoProgress). 기계 게이트(claude/git/runtime)는 그 위에서 조용히 확인되고, 실패한 첫 행만 카드로 연다(오늘의 one-card-open 규칙).
- 나가는 길: 레포 선택 완료=첫 대화 화면(빈 상태 §5-1)으로 전환. 막는 단계 없으면 언제든 닫기.

**⌘K 팔레트**
- 진입: ⌘K(전체 프레임), 사이드바 더 보기(프로젝트 스코프).
- 내용: 대화·화면·프로젝트·명령 4그룹(오늘 유지).
- 나가는 길: 실행=이동, Escape/밖 클릭=닫기.

### 2.3 파일별 작업

| 파일 | 작업 |
|---|---|
| `lib/delivery.ts` | 수정 — 칩 라벨 8단어 단일화(§1.4), `primary`·잠김 규칙 유지. **이 파일이 어휘의 유일 원천** |
| `panels/DiffPanel.tsx` | 수정 — 모달 몸통을 카드 본체로 발칵(로직 승계), `panels/HandoffPanel.tsx` 복도 유지 |
| `panels/HandoffPanel.tsx` | 수정 — 동일. 함께 넘어가는 것 섹션 추가 |
| `panels/ScreenPanel.tsx` | 수정 — devPanel 해체→대화 브리지, `[상태 확인]`·조용한 재읽기 유지 |
| `transcript/blocks.tsx`·`cards.tsx` | 신규 블록 — 상태 카드·진행 한 줄·사람 메시지·저장/넘기기 카드(§3 cycle 이벤트 전제) |
| `shell/HistoryDrawer.tsx` | 수정 — 되돌리기 도구로 문구·구성 정리 |
| `dialogs/SettingsDialog.tsx` | 수정 — 연결·알림 그룹 확장 |
| `onboarding/Onboarding.tsx` + `Shell.tsx` | 수정 — 첫 화면 2단 통합 |
| `dialogs/ConfirmDialog.tsx` | 수정 — 3버튼 변형(계속/저장하고 끝/저장 안 하고 끝) |
| `lib/daemon-client.ts` | 수정 — `cycle` ChatEvent fold, 신규 필드 타입 반영(§3) |
| `packages/daemon/src/*` | 수정 — cycle 이벤트 기록·방송, 코멘트 도착의 세션 브리프(§3-4) |

---

## 3. 데이터 요구

### 이미 데몬이 주는 것 (메서드·필드명 수준) — 신규 없이 그대로 쓰는 것

- 사이클 판정: `repo.pendingChanges`, `repo.branch`, `repo.handoff`(`HandoffStatus{number,url,state,reviewers}`), `repo.shelf`, `repo.phase` → `deriveDelivery()` 입력 전부.
- 진행: `diffStatus`(`stage`/`gate`/`reason:"push-auth"`/`detail`/`commit`/`message`), `diff.status` 방송.
- 검토·초안: `summarizeDiff()`(`lines`/`memo`/`source`), `handoffDraft()`(`title`/`body`/`extras{commentsSection,shotCount}`/`source`).
- 행동: `save()`, `handoff()`, `handoffStatus()`(+`reviews[]`), `saveHistory()`, `restore(sha)`, `shelve()`, `unshelve(sessionId)`, `discard()`, `recordComments()`, `replyToReview(id,body)`.
- 턴: `session.state`(waiting_question→결정 카드, waiting_permission→도구 확인), `pending`/`queue`/`tasks`.
- 온보딩·토큰: `onboardingCheck()`, `githubTokenSet()`, `githubReposList()`, `githubRepoInspect()`, `onboardingFix()`.
- 알림: 데몬 notice(`notices.ts` merged/closed/changes_requested/comments) + 클라 백그라운드 알림(`backgroundNotice`).

### 새로 필요한 것

1. **상태의 대화 기록 (최우선).** 전이를 ChatEvent로 기록·방송해야 상태 카드·진행 한 줄·사람 메시지가 재생(replay)에도 산다. 제안: `{kind:"cycle", event:"saved"|"handed"|"changes_requested"|"merged"|"closed"|"shelved"|"unshelved", at, detail?}` — `foldEvent`는 카드 블록으로, `applyEvent`는 상태 갱신만. 이게 없으면 카드화는 "새로고침하면 사라지는 이야기"가 된다. 폴백(이벤트 도입 전): hydration 시 `saveHistory()`+`repo.handoff`에서 마지막 상태 하나만 카드로.
2. **바꿈 N.** 계약의 제목바 `바꿈 N · 저장 안 됨`의 원천. 파일 수(`pendingChanges`)와 다른 수다 — delivery.ts가 칩에서 파일 수를 뺀 이유(핀 1개가 파일 3개를 건드림 = 체감 역상관)와 정합. 정의: **이 사이클에서 화면을 실제로 바꾼 턴 횟수**(파일을 쓴 턴 종료 시 +1, 저장 시 리셋 없이 사이클 누적). 데몬이 셈 → `RepoStatus.cycleChanges` 추가.
3. **동결 도장의 그릇.** 넘긴 시점의 화면은 `HandoffShot`으로 이미 PR에 커밋돼 있으나 UI에 돌려줄 참조가 없다. 최소안: 캡처 수만(있음) + "오후 4:40에 넘긴 그대로" 문장. 1차안: `HandoffStatus.shots?: Array<{path,url}>`(캡처가 PR의 정적 파일로 남아 있으니 URL만 있으면 된다). 스크린샷+시각으로 시작하고 재현 빌드로 업그레이드(종합 §6 잔여 승계).
4. **코멘트 도착의 세션 라우팅.** fleet의 comments notice는 휘발성이다. 사람 메시지가 되려면 어느 대화로 갈지 판정이 필요 — `briefTo(stage)` 확장(예: `stage:"review"`)으로 해당 프로젝트의 최근 활성 세션 다음 턴에 브리프하거나, 1의 cycle 이벤트에 reviews 요약을 실어 방송.
5. (선택, 2주차) 대화 단위 사이클 기여 추적 — 리프 배지를 대화별 단어로 쓰려면 필요. 당분간 리프는 턴 상태만(§7).

---

## 4. 상호작용 상세

| 상호작용 | 결과 |
|---|---|
| `[저장]`/⌘S (저장 안 함, 턴 쉼) | 저장 카드 열림(요약 로딩 → 문장). 턴 도는 중이면 잠김, title="Claude가 고치는 중 — 끝나면 저장할 수 있습니다" |
| 저장 카드 `[저장하기]` | 버튼 잠김+진행 한 줄(computing→pushing) → `저장했어요` 상태 카드(메모가 그대로 `diffStatus.message`) → 칩 저장됨 → 복도 버튼 |
| 저장 카드 `아직이요` | 카드 접기. 변경은 그대로 — 칩 저장 안 함 |
| `[넘기기]` (저장됨) | 넘기기 카드 열림(draft 로딩 — 캐시 hit면 즉시). 저장 전이면 잠김, title="먼저 저장해 주세요" |
| 넘기기 카드 `[넘기기]` | 진행 한 줄("넘기는 중") → 완료 줄("→ {개발자}님께 넘겼어요 — 확인 요청") → 칩 확인 중, `[상태 확인]` 등장, 미리보기 동결 도장 |
| `[상태 확인]` (primary=check 행) | `handoffStatus()` → 변화 없으면 한 줄 노트(빈 모달 금지 — 오늘의 `checkNote` 규칙) / 변경 요청·반려면 대화에 사람 메시지+jcard 행 / 반영이면 `반영됐어요` 카드+칩 반영됨. `마지막 확인 HH:MM` 표기(오늘 유지) |
| 더 보기 `잠깐 치워두기` | `shelve()` → 칩 치워둔 작업, 미리보기는 저장 전 상태로 되돌아감 |
| 더 보기 `치워둔 작업 꺼내기` | `unshelve(sessionId)` → 충돌 없으면 칩 저장 안 함, 있으면 그 대화에 Claude 브리프 카드 |
| 기록 드로어 행 `[이 시점으로]` | ConfirmDialog(되돌리기=새 저장 문장) → `restore(sha)` → 진행 한 줄 → 칩 갱신. 미저장 변경 있으면 거절 문장이 드로어 안에(닫지 않음 — 실사 결함 수정 사례 유지) |
| 버리기 ConfirmDialog | 3번째 문: `[잠깐 치워두기]`(alt)가 늘 함께 — 파괴의 옆에 비파괴 출구(오늘 장치 승계) |
| 사람 메시지 고침 칩 | 클릭=컴포저에 그 코멘트 인용이 채워짐(프롬프트 프리필) — 전송은 사용자가 |
| 즉답 칩(home/결정 카드) | **그 대화의 다음 턴으로 프롬프트를 실제 전송**(respondQuestion or send) — 장식 금지(계약) |
| Escape | 모달(설정·온보딩·팔레트·드로어·확인)=닫기. 대화 카드=접기(포커스 함정 없음 — 카드는 모달이 아니므로 `useModalFocus` 안 씀) |
| ⌘K → 명령 `상태 확인` | 팔레트 어디서든 사이클 재읽기 — 확인 중 행에서 자연스러운 다음 수가 항상 한 번에 닿게 |

---

## 5. 엣지 케이스

1. **빈 상태 — 연결했으나 대화 없음.** 세 층: ①프로젝트 0 = 첫 화면 곧 온보딩(빈 레일은 자리만, `새 대화` 비활성 — onboarding.html 그대로) ②프로젝트 있고 대화 0 = ChatColumn 스타터 칩(선언된 screens 기반 — 오늘 규칙 유지), 칩은 `변경 없음`+"화면을 만들어 달라고 하면 시작됩니다" ③대화 있고 화면 0 = `화면 대기 중` 칩(오늘 유지). 어느 층에서도 공백 화면 금지 — 항상 다음 한 문장이 있다(delivery `next.line` 규율).
2. **미리보기 빌드 실패.** `RepoPhase=error`(+`errorKind` preview/port-busy) → 재시도 판이 **미리보기 자리만** 대신한다. worktree와 원격은 살아 있으므로 칩·`[저장]`·`[넘기기]`는 유지(`workable = ready||error` — 실사 결함 수정 사례: "포트 충돌 카드가 변경 4 채 넘길 길을 가렸다"). 화면 단위 오류는 `forwardError`로 그 대화의 Claude 턴이 되고(같은 오류 반복은 N번째 표시), 미리보기 재시작은 살아 있는 턴 위에서 쏘지 않는다. 저장·넘기기는 check/build 게이트를 돌리지 않는다(DiffStatus 주석) — 빌드가 어긋나도 저장은 막지 않고 문제는 PR로 간다. 넘기기 캡처는 서버가 살아 있을 때 먼저 찍는다(dispatch 순서).
3. **토큰 만료.** 셋을 구분해 말한다: ①GitHub 토큰(레포·넘기기) — push 저장 실패(`reason:"push-auth"`)/`pr` 게이트 → 오류 줄 옆 `[토큰 바꾸기]`→설정 연결 그룹(GitHubTokenForm, write-only 재붙여넣기 프리필 유지). ②GitHub 게이트 자체 실패(온보딩 github 행 fail) — RepoPicker는 "토큰이 없어 목록을 읽지 못한다"는 빈 목록(오늘 규칙). ③데몬 페어링 토큰/연결 — §5-4와 ConnectScreen. 만료 카드의 공통 문구: "대화와 저장된 작업은 그대로 남아 있어요"(modals.html) — 이 말이 참이려면 어떤 만료도 레일·기록 데이터를 지우면 안 된다.
4. **오프라인.** 웹소켓 끊김 → 지수 백오프 재연결(1s→5s 캡, 오늘 구현). 한 번 연결된 적 있으면 앱에 남아 조용한 오프라인 띠(3단계 위계의 최하층 — 푸시 없음), 못 들어간 처음이면 ConnectScreen. 날아간 호출은 "연결이 끊어졌습니다 — 다시 연결하는 중"으로 일괄 거절(오늘 `flushPending`). **저장 도중 오프라인** = push 게이트 실패 → push-stalled 재시도 경로(§1.3) — 커밋은 착지했으므로 빈 검토가 "없다"고 거짓말하는 게 최악의 함정. 재연결 시 `hello`/`status`가 프로젝트·레포·온보딩 캐시를 재시딩, 대기 요청은 requestId dedupe로 재생.
5. **첫 실행.** 데스크톱은 페어링 토큰이 URL로 와 ConnectScreen 없이 시작(`desktopDaemonUrl`), 브라우저 개발 경로만 주소 붙여넣기 — 이 화면은 **비개발자 온보딩이 아니라 개발자 도구**임을 문구로 구분. 온보딩 통과 캐시(`ONBOARDING_CACHE_KEY`)로 이미 통과한 사람이 재접속마다 wizard로 떨어지지 않게(오늘 규칙). 알림 권한 요청은 첫 전송 후 딱 한 번(`NOTIFICATION_ASKED_KEY`, 데스크톱은 본인 경로 있어 묻지 않음).

---

## 6. 이 슬라이스 안의 구현 순서

1. **어휘 단일화** — `delivery.ts` 칩 라벨을 8단어로(§1.4), 사이드바 배지·topbar가 같은 상수를 읽는지 확인. 가장 싸고 다른 슬라이스가 기다리는 원천.
2. **cycle 이벤트 기록(§3-1)** — 데몬 기록·방송 + 클라 fold + 카드 블록 4종(상태 카드·진행 한 줄·사람 메시지·기록 행). 3번 이하의 전제.
3. **저장 카드·넘기기 카드** — DiffPanel/HandoffPanel 로직 승계, 그릇만 교환. 복도 유지.
4. **사람 메시지·jcard + 답하기** — devPanel 해체, `replyToReview` 컴포저 연결.
5. **기록 드로어 재정의** — 되돌리기 도구로.
6. **설정 확장 + 만료 카드 + 저장 안 하고 끄기 3버튼** — 토큰 만료·종료 확인 완결.
7. **온보딩 2단 통합 + 빈 상태 3층 정리.**
8. **⌘K·단축키 상수 정리** — `상태 확인` 명령 추가 검토.

## 7. 리스크

- **폴링 지연이 알림 정책을 삼킨다(§1.5-1).** 10분 공백을 UI가 숨기면 "도착했어요"가 거짓말이 된다. 시각 표기 원칙과 푸시 게이트 기준을 백엔드와 합의 전에 카드 문구를 굳지 않는다.
- **착지 한 박자(§1.5-2).** 반영됨 칩과 옛 사이클 규칙의 짧은 창. 규칙을 UI에서 재구현하지 말고 `deriveDelivery` 하나만 보게 유지 — 분산시키는 PR이 최대의 회귀 지점.
- **기록 승격 없는 카드화.** 2번을 건너뛰고 3번부터 하면 재생 시 사라지는 대화가 된다. 순서 계약.
- **바꿈 N의 정의 합의.** 파일 수가 아닌 수(§3-2) — 이 정의가 흔들리면 제목바 칩과 저장 검토의 개수 표기가 어긋난다.
- **사이클 단위 vs 대화 단위 배지.** 사이클은 프로젝트당 하나라 대화 리프마다 다른 사이클 단어는 원리적으로 없다. 여정 사이드바 묶음(사이드바 슬라이스)이 리프별 상태 단어를 요구하면 기여 추적(§3-5)까지 못 붙인다 — 당분간 리프=턴 상태로 문서 고정.
- **모달→카드 전환의 실수 클릭.** 카드는 모달의 강제가 없다. 보상은 진행 한 줄+되돌리기(커밋 단위)지만 **미저장 실수**(버리기)는 치워두기 alt가 유일한 안전망 — ConfirmDialog alt 장치를 모든 파괴 지점에 유지.
- **반려에 사유가 없을 수 있다.** closed인데 `reviews`가 비으면 인용 카드의 몸통이 없다 — 폴백 문장("이유는 코멘트에 없어요 — 개발자에게 직접 물어보세요")과 `[상태 확인]` 유지.
- **동결 스냅샷 비용.** 재현 빌드는 인프라 몫(가장 무거운 항목) — 스크린샷+시각으로 시작, `HandoffStatus.shots` URL이 생기면 그때 교체.
