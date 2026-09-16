# 홈 인박스 — 구현 스펙

> 슬라이스: 「홈 인박스」(`mockups/hero/home.html`). 앱의 문 — 켤 때마다, 또는 자리를 비웠다 돌아왔을 때 랜딩하는 화면.
> 범위: 홈 화면 전체(돌아온 배너 · 나를 기다리는 일 · 지금 진행 중 · 방금 있던 일 · 사이드바와의 관계 · 3단계 알림 판정). 대화면 내부(카드 클릭 이후)는 chat 슬라이스 소관 — 여기서는 착지 지점만 명시.
> 결론 먼저: 오늘 데이터로 **결정 카드의 질문 인용은 완전히 됨**, **진행 카드의 "마지막 행동 한 줄"은 부분적으로만 됨**(서브에이전트 경유 작업만), **카드의 상대 시각("12분 전")은 오늘 데이터로 안 됨**(요청에 타임스탬프가 없음), **모바일 푸시는 카피뿐 인프라 없음**. 근거는 각 섹션에 파일·줄 번호로 남긴다.

---

## 0. 핵심 질문에 대한 답 (근거 우선)

### 0.1 결정 카드의 질문 인용 — 됨
`PendingQuestion`(`packages/web/src/lib/daemon-client.ts:382-387`)은 `questions: AskQuestion[]`을 그대로 들고 있고, `AskQuestion`(`packages/protocol/src/messages.ts:613-617`)은 `question`(원문 질문) · `header` · `options: {label, description, preview?}[]` · `multiSelect`를 갖는다. 이 배열은 데몬이 `question.request` 메시지로 브로드캐스트하고(`packages/daemon/src/server.ts:280`), 재연결 시에도 리플레이된다(`server.ts:522`). 목업의 `"반차도 하루짜리 신청과 같은 화면에 넣을까요..."` 인용문과 `같은 화면에 넣기`/`따로 만들기` 칩은 각각 `question` 원문과 `options[].label` 그대로다 — **새 데몬 작업 없이 오늘 그릴 수 있다.**

권한형 결정(`PendingPermission`)은 질문이 아니라 "이 도구를 실행해도 될까요"이므로 인용할 문장이 없다. 대신 `packages/web/src/components/transcript/cards.tsx:100-102`의 `toolHeadline(request.input)` + `bashHeadline` + `toolLabel(request.toolName)`이 이미 "파일을 이렇게 고칠게요" 급의 한국어 한 줄을 만든다 — 홈의 권한형 카드는 이 포매터를 그대로 가져다 쓴다(§2).

### 0.2 진행 카드의 "마지막 행동 한 줄" — 부분적으로만 됨
모델이 30초마다 쓰는 한 줄 근황(`summary`)은 `task.progress` 이벤트에만 있고(`packages/protocol/src/session.ts:161-172`), 이 기능(`agentProgressSummaries: true`)은 **서브에이전트(Task 도구) 호출에만 켜져 있다**(`packages/daemon/src/agent/drivers/claude/session.ts:203`). 메인 턴이 Task 도구를 거치지 않고 직접 파일을 고치는 보통의 경우엔 이 요약 자체가 생성되지 않는다. 남는 신호는 도구 이름의 한국어 라벨(`packages/protocol/src/tool-names.ts` — `Edit`→"파일 고치기" 수준)뿐이라 목업의 "지각 사유를 적는 칸을 만드는 중이에요" 같은 자연문은 오늘 데이터로 못 만든다. §3·§7에 새로 필요한 것으로 명시.

### 0.3 즉답 칩의 경로 — 실제 동작이지만 "새 프롬프트"가 아니라 "같은 턴의 도구 응답"
칩 클릭 → `api.respondQuestion(requestId, answers, annotations)`(`daemon-client.ts:526-531`, 호출부 `daemon-client.ts:1196-1205`) → 소켓으로 `question.respond`(`requestId, answers, annotations`) 전송(`packages/protocol/src/messages.ts:211-224`) → 데몬이 그 `requestId`의 `AskUserQuestion` 도구 호출을 그 답으로 해소하고 **멈춰 있던 같은 턴을 그대로 이어간다**(사용자 말풍선이 새로 생기지 않음). 권한형은 `api.respondPermission(requestId, decision, message?)` → `permission.respond`가 같은 방식으로 멈춘 도구 실행을 허용/거절한다. 계약이 요구하는 "장식이 아니라 실제로 다음 턴을 있는" 조건은 만족하지만, **chat 슬라이스와 반드시 맞춰야 할 정의 차이**가 있다: 이건 "새 사용자 메시지 전송"이 아니라 "멈춘 도구 호출의 응답"이다 — 대화창에 새 말풍선이 뜨는 게 아니라 카드가 사라지고 Claude가 이어서 움직인다. 이 뉘앙스를 두 슬라이스가 다르게 이해하면 카드가 사라진 뒤 사용자가 "내가 보낸 말이 어디 갔지"라고 느낄 수 있다.

---

## 1. 화면/상태 목록

| 상태 | 조건 | 표시 |
|---|---|---|
| 로딩(연결 중) | `daemon`의 WS `ConnectionState`가 `connecting`/`idle` | 스켈레톤 카드 3장(뼈대만), 배너 자리 회색 블록 |
| 프로젝트 없음 | `daemon.projects.length === 0`(첫 실행, 온보딩 전) | 홈 도달 불가(온보딩 마법사가 앞을 막음) — 방어적으로 "레포를 먼저 연결해 주세요" 안내만 |
| 활성 프로젝트 전환 중 | `activeSlug`가 바뀌는 순간부터 새 `project.changed` 도착 전까지 | 이전 프로젝트의 카드 즉시 비우고 스켈레톤(잘못된 프로젝트 카드가 잠깐 보이는 것 방지) |
| 활성 레포 미준비 | `repo.phase !== "ready"`(cloning/installing/error 등) | 배너는 그리되 카드 클릭 시 스레드 열기가 실패할 수 있음 — 카드에 "레포 준비 중" 배지, 클릭 비활성 |
| 정상(할 일 있음) | 세 그룹 중 하나 이상 1건 이상 | 목업 그대로: 배너 → 나를 기다리는 일 → 지금 진행 중 → 방금 있던 일 |
| 완전히 빈 상태 | 세 그룹 모두 0건 | 배너만 남기고(또는 배너도 "쌓인 일이 없어요"로 축소) `여기까지예요` 문구, 새 대화 시작 유도 |
| 그룹별 0건 | 한 그룹만 0건 | 그 그룹 헤더(`나를 기다리는 일 0`)째로 숨김 — 목업처럼 카운트 0인 헤더를 그리지 않음 |
| 질문형 결정 카드 | `PendingQuestion` | 인용 + 즉답 칩(단일 질문·단일 선택일 때만) |
| 다중 질문/다중 선택 결정 카드 | `PendingQuestion.questions.length > 1` 또는 `multiSelect` | 인용 대신 "질문 N개"·즉답 칩 없이 "대화에서 답하기" 단일 동작만(§5) |
| 권한형 결정 카드 | `PendingPermission` | 인용 없음, `toolHeadline` 한 줄 + "이번만 허용/항상 허용/거절…" |
| 코멘트 도착 카드 | `HandoffStatusReport.reviews`에 새 항목 | 개발자 코멘트 인용 + "대화에서 보기" |
| 진행 카드 | `SessionState === "running"` (활성 프로젝트) | 마지막 행동 한 줄(가능한 만큼) + 경과 시계 |
| 완료 카드(조용함) | 최근 저장/반영/넘김 완료, 뱃지·푸시 없음 | 조용한 한 줄, 시각 |
| 데몬 연결 끊김/에러 | `ConnectionState === "closed"/"error"` | 홈 전체를 가리지 않고 상단에 "다시 연결하는 중" 배너, 마지막으로 알던 카드는 흐리게 유지 |

---

## 2. 컴포넌트 계획

### 신규
- `packages/web/src/components/home/HomeInbox.tsx` — 최상위 컨테이너. `mockups/hero/home.html`의 `.ret-work/.ret-col` 구조를 이식. props: `pending`, `sessions`, `activeProject`(ProjectSummary), `repo`, `onOpenThread(sessionId)`.
- `packages/web/src/components/home/ReturnBanner.tsx` — "N시간 만에 돌아오셨어요" + recap 칩. `last-seen.ts`(아래)와 세 그룹의 카운트만 소비.
- `packages/web/src/components/home/DecisionCard.tsx` — 질문형/권한형/코멘트형 3변형을 갖는 "나를 기다리는 일" 카드. 질문형은 **새로 만든다**(§0.3 이유로 chat의 `QuestionCard`를 통짜로 못 쓴다 — 아래 "수정" 항목 참고). 권한형은 `cards.tsx`의 헤드라인 포매터를 그대로 호출.
- `packages/web/src/components/home/ProgressCard.tsx` — "지금 진행 중". `SessionView.tasks`/`turnStartedAt` 소비.
- `packages/web/src/components/home/DoneCard.tsx` — "방금 있던 일" 조용한 카드.
- `packages/web/src/lib/home-feed.ts` — 순수 함수. `(pending, sessions, projects, activeSlug) → { asking: DecisionItem[]; running: ProgressItem[]; done: DoneItem[] }`. `progress.ts`(기존)처럼 순수 함수로 두어 단위 테스트 가능하게 — React 밖에서 그룹핑 규칙(정렬, 0건 숨김, 다중 질문 처리)을 검증.
- `packages/web/src/lib/last-seen.ts` — `localStorage`에 마지막 방문 epoch ms 기록/조회. 데몬과 무관한 순수 클라이언트 상태.

### 수정(기존 재사용, 두 번째 관례 금지)
- `packages/web/src/components/transcript/cards.tsx` — 질문 카드의 **단일 질문·단일 선택** 조합에서 "고르기 = 보내기"가 되는 즉시-응답 경로가 없다(현재는 `pick` 후 별도 "답변 보내기" 버튼, `cards.tsx:301-310`). 여기에 `onQuickPick?: (label: string) => void` 같은 콜백을 하나 추가해 단일 질문 카드의 옵션 버튼이 (그 prop이 있을 때만) 클릭 즉시 `onRespond`까지 호출하게 하면, **홈과 대화창이 같은 옵션 라벨·같은 응답 경로를 공유**한다. 홈의 `DecisionCard`는 이 확장된 `QuestionCard`를 컴팩트 모드로 import해서 쓴다 — 인용문 렌더링과 옵션 버튼 마크업을 두 곳에 베끼지 않는다.
- `packages/web/src/components/shell/PageWorkspace.tsx` — `useImperativeHandle`에 이미 있는 `openThread(slug, thread)`(`PageWorkspace.tsx:281-284`)를 홈의 카드 클릭이 그대로 호출하게 배선. 새 `view: "home" | "thread"` 상태 추가: 프로젝트 활성화 직후 · 앱 첫 로드 시 기본값 `"home"`, 카드/사이드바 스레드 클릭 시 `"thread"`로 전환. `"＋ 새 대화"`는 오늘처럼 즉시 새 스레드를 만들며 `"thread"`로 전환(홈을 거치지 않음 — 기존 동작 유지).
- `packages/web/src/components/shell/Shell.tsx` — 홈으로 돌아가는 길 배선(레일 상단 브랜드 버튼 클릭, 또는 새 `topbar__title "지금"`을 클릭 가능하게). 목업엔 명시적 "뒤로" 버튼이 없으므로 브랜드 로고 재사용을 제안.
- `packages/web/src/components/preview/TurnClock.tsx`의 로직(1초 tick) — 그대로 재사용하기엔 홈 카드 다수가 동시에 리렌더되므로, `waitedFor(now - turnStartedAt)`(`packages/web/src/lib/format.ts`)만 가져오고 tick 주기는 10초로 낮춘 경량 버전을 `ProgressCard` 내부에 둔다(신규, 작은 함수).

---

## 3. 데이터 요구

### 이미 있음 (그대로 소비)
| 필요한 것 | 소스 | 비고 |
|---|---|---|
| 결정 카드 질문 인용 + 즉답 칩 라벨 | `pending: Pending[]` → `PendingQuestion.questions[].question` / `.options[].label` (`daemon-client.ts:382-387`, `messages.ts:613-617`) | §0.1 |
| 즉답 응답 전송 | `api.respondQuestion(requestId, answers, annotations)` (`daemon-client.ts:526-531,1196-1205`) | §0.3 |
| 권한형 결정 헤드라인 | `toolHeadline`/`bashHeadline`/`toolLabel`/`objectParticle` (`cards.tsx:100-102`, `lib/labels.ts`) | §0.1 |
| 권한형 응답 전송 | `api.respondPermission` (동일 패턴, `permission.respond`) | |
| 진행 중 세션 목록 | `sessions: Record<string, SessionView>` — `permission.request`/`question.request`와 달리 `session.event`/`session.state`는 **모든 세션에 대해** 브로드캐스트되고 클라이언트는 `ensureSession` 없이도 `prev[sessionId] ?? EMPTY_SESSION`로 누적한다(`daemon-client.ts:969-981`) | 활성 프로젝트의 세션이면 창을 열지 않아도 상태가 쌓인다 — 홈이 별도로 구독할 필요 없음 |
| 백그라운드 작업 설명(있을 때만) | `SessionView.tasks: {taskId, type, description}[]` — `background_tasks_changed` REPLACE 스냅샷(`event-mapper.ts:217-231`) | Task 도구로 위임된 작업만 값이 있음(§0.2) |
| 경과 시간 기준시각 | `SessionView.turnStartedAt` / `SessionSummary.turnStartedAt` — 데몬 시각, 창이 새로고침돼도 같음 | `waitedFor()` 재사용 |
| 프로젝트 요약(리캡 칩, 다른 프로젝트 배지) | `daemon.projects: ProjectSummary[]` — `threads?: ThreadSummary[]`, `handoff`, `pendingChanges` | |
| 카드→대화 착지 | `api.locateSession(sessionId)`(`daemon-client.ts:1112-1113`) + `PageWorkspace`의 `openThread(slug, thread)` imperative handle(`PageWorkspace.tsx:245-284`) | OS 알림 클릭 때 쓰던 것과 동일 경로 — 신규 없음 |
| 개발자 코멘트 인용(활성 프로젝트만) | `repo.handoffStatus` RPC → `HandoffStatusReport.reviews: DeveloperReview[]`(`.body`, `.author`, `.at`) (`dispatch.ts:667-668`, `repo-publish.ts:473-511`) | 풀 방식(요청해야 옴), 활성 프로젝트 한정 — 아래 "신규" 참고 |
| 3단계 알림 중 "푸시"(데스크톱) 판정 기준 | `backgroundNotice`/`notifyBackgroundThread`(`daemon-client.ts:763-823`): `waiting_permission`·`waiting_question`·`error`는 **항상** 알림, `idle`(턴 완료)은 사용자 설정(`off`/`long`/항상)에 따름 | 이미 코드로 존재하는 정책 — §6에서 그대로 카피 정책으로 승격 제안 |

### 신규 필요 (없음 — 새로 만들어야 함)
1. **진행 카드의 자연어 한 줄**(§0.2). 메인 턴에도 `agentProgressSummaries`급 30초 요약을 켜거나, 최소한 마지막으로 돈 도구의 input(파일 경로 등)을 한국어 문장으로 포매팅하는 데몬 쪼가리가 필요하다. 없으면 배포 시 "파일 고치는 중" 수준으로 품질을 낮춰야 한다(§7).
2. **결정/카드의 발생 시각**. `PendingPermission`/`PendingQuestion`(`daemon-client.ts:373-387`)에는 타임스탬프 필드가 전혀 없다 — 목업의 "12분 전"/"40분 전"을 오늘 데이터로 못 만든다. `permission.request`/`question.request` 메시지(`messages.ts:638-651`)에 `requestedAt` 같은 필드를 추가하거나, 근사값으로 그 세션의 `ThreadSummary.updatedAt`을 대신 쓰는 타협이 필요(정확하지 않음, §5·§7에 명시).
3. **비활성 프로젝트의 실시간 상태**. `activateProject`가 이전 클론을 `setActive(false)`로 내리므로(`packages/daemon/src/project-fleet.ts:491`) 비활성 프로젝트엔 살아있는 Claude 세션이 없다 — `pending`/`session.event` 자체가 발생하지 않는다. `pollOpenHandoffs`(`project-fleet.ts:306-354`)는 등록된 **모든** 프로젝트를 10분마다 순회해 merged/closed/changes_requested/comments를 감지하지만, 결과는 `DaemonNotice`로 오직 호스트(데스크톱 네이티브 알림)에만 전달되고(`server.ts` `onNotice`, WS 브로드캐스트 아님) 웹 클라이언트(`daemon-client.ts`)에는 전혀 도달하지 않는다. 여러 프로젝트를 홈 하나에서 보려면 이 폴러의 결과도 `ServerMessage`로 브로드캐스트해야 한다 — **v1은 활성 프로젝트로 스코프를 좁히는 제품 결정을 전제**로 한다(§7).
4. **개발자 표시 이름**. `DeveloperReview.author`는 GitHub 로그인 원문이다(`repo-publish.ts:481-505`) — "준호 님" 같은 표시 이름 매핑이 없다. GitHub API의 `user.name`을 추가로 읽어오거나 로그인 그대로 보여주는 결정이 필요.
5. **모바일/휴대폰 푸시 채널**. 저장소 전체에 web-push/APNs/FCM 인프라가 없다(grep 무결과) — 데스크톱 `Notification` API(`daemon-client.ts:799-823`)만 존재. 목업의 "📱 휴대폰으로도 알려드렸어요" 카피는 오늘 배포하면 거짓 약속이다(§7).
6. **"N시간 만에 돌아오셨어요" 배너 근거**. 데몬 데이터가 아니라 클라이언트 로컬 상태(`last-seen.ts`) — 데몬 신규 작업 아님, 프론트 전용 신규.
7. **"대화에서 답하기" 3번째 칩**. `AskQuestion.options`에 없는, 홈이 합성하는 UI 전용 동작(그냥 `onOpenThread` 호출) — 데이터 아님.

---

## 4. 상호작용 상세

| 동작 | 결과 |
|---|---|
| 결정 카드의 빈 영역(칩 이외) 클릭 | `openThread(project.slug, {id: sessionId})` — 그 대화를 열고 맨 아래로(기존 `ChatColumn`의 마운트 시 `jumpToLatest` 기본 동작 재사용, `ChatColumn.tsx:267-270`). 같은 `pending` 카드가 대화창 하단에 그대로 보임(`cards.tsx`가 이미 렌더링) |
| 질문형 즉답 칩 클릭(단일 질문·단일 선택일 때만) | `api.respondQuestion(requestId, {[question]: label}, {})` 즉시 호출 → 성공 시 `resolvePending(requestId)`로 카드 제거, 대화는 열지 않음(멈춘 턴이 백그라운드에서 이어짐) |
| "대화에서 답하기" 칩 | 응답 전송 없이 `openThread`만 — 대화창의 원래 `QuestionCard`(다중 질문/직접 입력 포함)로 착지 |
| 권한형 카드의 "이번만 허용"/"항상 허용"/"거절…" | `api.respondPermission(requestId, decision, message?)` — 거절은 대화창의 `PermissionCard`처럼 이유 입력 한 단계 거침 |
| 코멘트 도착 카드의 "대화에서 보기" | `openThread` — 코멘트는 별도 사람 메시지 블록으로 이미 대화 안에 있음(chat 슬라이스 소관) |
| 진행 카드 클릭 | `openThread` — 스트리밍 중인 도구/작업 행이 실시간으로 보이는 대화창 |
| 완료(조용한) 카드 클릭 | `openThread` — 저장/반영/넘김 상태 카드가 있는 지점까지는 chat 슬라이스가 스크롤 위치를 보장하지 않는 한 "맨 아래"로만 이동(§5 엣지케이스) |
| 레일의 벨(🔔) 뱃지 숫자 | `pending.length` 그대로(목업의 `2`와 동일 소스) — 신규 카운트 로직 불필요 |
| 사이드바 스레드 행 클릭(홈이 아니라 사이드바에서) | 동일한 `openThread` 함수를 호출해야 함 — 홈 카드와 사이드바 행이 서로 다른 네비게이션 함수를 갖지 않도록 `PageWorkspace`의 단일 imperative handle을 공유(§2) |
| 홈이 열려 있는 동안 새 `pending`/`session.event` 도착 | 소켓이 이미 실시간 푸시하므로 폴링 없이 리액트 상태만으로 갱신 — 새 결정 카드는 그룹 맨 위(최신 우선, §5) |
| 프로젝트 전환 중 카드 클릭 | 비활성화(§1) — 전환 완료(`project.changed`) 후에만 클릭 가능 |

---

## 5. 엣지 케이스

- **다중 질문 요청**(`PendingQuestion.questions.length > 1`): 즉답 칩을 그리지 않는다(어느 칩이 몇 번째 질문에 응답하는지 모호해짐) — "질문 N개" 배지 + 첫 질문만 인용 + "대화에서 답하기" 단일 동작.
- **다중 선택 질문**(`multiSelect: true`): 한 번의 클릭으로 완결되지 않으므로(추가/해제를 반복해야 함) 즉답 칩을 그리지 않고 "대화에서 답하기"로만 유도.
- **`pending` 항목의 `sessionId`가 이미 사라진 스레드를 가리킴**(삭제/리와인드 경합): `openThread` 실패 시 "이 대화는 더 이상 없어요" 안내 후 카드 유지(응답은 여전히 유효할 수 있으므로 칩은 살려둠).
- **상대 시각 부재**(§3 신규 2): 정확한 요청 시각이 없으므로 v1은 "지금"(정확한 분 단위 배지 없이) 또는 `ThreadSummary.updatedAt` 근사값 중 하나를 택해야 한다 — 근사값을 쓸 경우 라벨을 "약 N분 전"처럼 부정확함을 숨기지 않는 문구로.
- **재연결 시 `pending` 리플레이 순서**(`server.ts:522`): 발생 순서가 아니라 도착 순서로 배열이 채워질 수 있음 — 타임스탬프가 없는 한(위 참고) "새 일이 맨 위" 정렬은 완벽히 보장되지 않는다. 정렬 키가 없다는 사실 자체를 리스크로 남긴다(§7).
- **활성 레포가 `ready`가 아닐 때** 카드 클릭 → 열기 실패: 카드에 "레포 준비 중" 배지, 클릭 비활성.
- **`turnStartedAt`이 `null`인데 `state === "running"`**(레이스): 경과 시계 대신 "방금 시작" 문구로 폴백.
- **긴 코멘트/질문 인용**: `.ret-quote`에 라인클램프(2~3줄) 적용, 전체는 "대화에서 보기"로만.
- **치워둔 작업(`RepoShelf`)**: 세션 상태가 아니라 레포/제목바 상태이므로 홈 카드가 관여하지 않음 — 사이드바·제목바 슬라이스 소관으로 명확히 선을 긋는다.
- **완전히 빈 상태에서 배너**: "3시간 만에 돌아오셨어요" 자체가 부적절해 보일 수 있음 — 세 그룹 모두 0이면 배너를 "쌓인 일이 없어요, 새 대화를 시작해 보세요"류로 대체.
- **다중 프로젝트 등록**: 비활성 프로젝트는 홈에 카드로 나타나지 않는다(§3 신규 3) — 사이드바/프로젝트 스위처에만 뱃지(`pendingChanges`, `handoff.state`)로 존재. 이 비대칭을 사용자에게 어떻게 알릴지는 별도 결정(예: "다른 프로젝트에도 확인할 게 있어요" 한 줄 링크는 `ProjectSummary.handoff`만으로 만들 수 있음 — 코멘트 인용 없이).
- **스크린리더**: 결정 카드는 `role="alert"`(기존 `cards.tsx` 패턴, `card--permission`/`card--question`) 유지, 홈의 컴팩트 옵션 버튼도 동일 시맨틱을 물려받는다(§2 확장 지점 재사용).

---

## 6. 이 슬라이스 안의 구현 순서

1. `lib/last-seen.ts` + `ReturnBanner`(데몬 무관, 리스크 없음, 우선 착수).
2. `lib/home-feed.ts` 순수 함수 — `pending`/`sessions`/`projects`를 3-tier로 접는 규칙(0건 숨김, 다중 질문/다중 선택 판별, 정렬)을 단위 테스트 가능하게 먼저 고정.
3. `cards.tsx`의 질문 카드에 `onQuickPick` 확장 지점 추가(§2) — chat 슬라이스와 인터페이스를 맞추는 가장 위험한 변경이라 먼저 처리.
4. `DecisionCard`(질문형은 확장된 `QuestionCard` 컴팩트 모드 재사용, 권한형은 `cards.tsx` 포매터 재사용, 코멘트형은 `DeveloperReview` 매핑) → `ProgressCard` → `DoneCard` → `HomeInbox` 순서로 조립, `mockups/hero/home.html`의 클래스(`.ret-*`)를 `styles.css`로 이식.
5. `PageWorkspace`/`Shell`에 `view: "home"|"thread"` 배선 + 카드 클릭 → `openThread` 연결.
6. 진행 카드의 "마지막 행동 한 줄"은 신규 데몬 작업(§3-1)이 오기 전까지 `toolLabel` 폴백 문장으로 임시 배선 — 빈 문장으로 두지 않는다.
7. 엣지 케이스(다중 질문, 다중 선택, 전환 중 스켈레톤, 빈 상태) 마무리.

---

## 7. 리스크

- **진행 카드 품질 저하**: §0.2/§3-1의 백엔드 확장이 없으면 목업의 자연문장 대신 "파일 고치는 중" 급 기계적 라벨로 나간다 — 이 슬라이스 혼자서는 못 고치는 데몬 쪼가리 의존.
- **상대 시각 부재**: `pending` 요청에 타임스탬프가 전혀 없다(§3-2). "12분 전"을 근사값으로 흉내 내면 부정확한 정보를 확정적인 어조로 보여주는 위험 — 백엔드에 `requestedAt` 필드 추가를 요청하거나, UI 카피를 "지금"류로 낮춰야 한다.
- **다중 프로젝트 인박스 불가**: 오늘 아키텍처상 비활성 프로젝트엔 살아있는 세션이 없고, 크로스 프로젝트 폴러(§3-3)의 결과가 웹 클라이언트에 도달하지 않는다 — v1을 활성 프로젝트로 좁히는 제품 결정이 필요하며, "다른 프로젝트에 뭐가 있었지"를 홈 하나로 못 보여주는 한계를 사용자에게 어떻게 알릴지 미해결.
- **모바일 푸시 카피와 실제의 불일치**: 인프라가 전혀 없는데 목업 문구를 그대로 배포하면 거짓 약속이 된다 — 데스크톱 알림만 있다고 카피를 낮추거나, 모바일 채널을 별도 인프라 과제로 명시 분리해야 한다.
- **개발자 표시 이름**: GitHub 로그인 그대로면 "준호 님" 톤이 깨진다 — 별도 매핑이 없으면 로그인 원문("@junho502")으로 나가는데, 비개발자 사용자에게 "@" 기호가 낯설 수 있다.
- **`cards.tsx` 확장이 chat 슬라이스와 충돌**: `onQuickPick` 같은 새 prop을 잘못 설계하면 대화창의 기존 다단계 질문 흐름(메모·시안 비교·직접 입력)을 깨뜨릴 수 있다 — chat 슬라이스 작업자와 이 확장 지점의 시그니처를 먼저 맞춰야 한다(§0.3의 "새 프롬프트가 아니라 도구 응답" 정의도 같이 맞출 것).
- **재연결 리플레이 순서**: `pending` 배열의 리플레이가 원 발생 순서를 보장하지 않는다(§5) — "새 일이 맨 위" 정렬이 흔들릴 수 있다.
