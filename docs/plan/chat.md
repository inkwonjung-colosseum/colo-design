# 슬라이스 스펙 — 「대화면」 (chat)

> `mockups/hero/chat.html` 을 구현 스펙으로 번역한다. chat이 척추 — 대화 열(스크롤+컴포저) 전체.
> 근거: `docs/hero-synthesis.md` §3(판정: 기본값은 chat), 공통 계약 `.local/share/plan-brief.md`.

## 0. 범위와 경계

**이 슬라이스가 소유**: `packages/web/src/components/chat/ChatColumn.tsx` 가 담당하는 세로 열 전체 —
트랜스크립트(메시지 8종 렌더), 컴포저(상태 칩·핀 트레이·큐·즉답), 사람 메시지 도착 경로, 카드 내 행동 버튼.

**다른 슬라이스 소유(여기선 경계만)**:
- **미리보기 패널 내부**(문서앱 제목바 `바꿈 N · 저장 안 됨` → [저장] → [넘기기], 동결 도장, 고침 표시 ③④⑤⑥, 지금/저장된 화면 세그) = product 슬라이스. 이 슬라이스는 `onOpenScreen(route, state)` 와 `preview.pinFlash(id)` 배관만 쓴다.
- **홈 인박스**(결정 필요 카드의 즉답 칩이 대화 밖에서 도는 모습) = home 슬라이스. 즉답 칩의 동작 원칙(§4)만 공유한다.
- **대화 상단 여정 띠**(만들기→저장→넘기기→반영 읽기 전용 지도) = journey 슬라이스. 이 슬라이스가 내는 상태(`repo`·`diffStatus`)를 같이 읽는다.
- **사이드바 상태 묶음** = home/sidebar 슬라이스.

같은 상태를 읽는 표면이 여럿이므로(카드·제목바·칩·띠), 상태의 주인은 언제나 데몬(`repo` 브로드캐스트·`diffStatus`)이고 열은 뷰일 뿐이다.

---

## 1. 화면/상태 목록

### 1.1 메시지 종류 8종 — 렌더 규격

| # | 종류 | 목업 | 구성 | 상태 |
|---|---|---|---|---|
| 1 | 내 말 버블 | `.turn-user__bubble` | 오른쪽 정렬 버블, 본문+`이미지 N장` 태그, hover 액션(요청 복사·고쳐서 다시 보내기) | — |
| 2 | AI 산문 | `.turn-ai__prose` | Markdown + 스트리밍 캐럿, 답변 아래에 화면 카드·답변 액션 | streaming / done |
| 3 | 도구 확인 한 줄 | `.tool` | 접힌 머리글(▶ 이름 · 요약) + 열면 본문 | running / done / error / 뒤로 보냄 |
| 4 | 화면 카드 | `.scard` | 미니스샷 + 제목 + `미리보기 · 시각` + 상태 칩들 | `--open`(미리보기가 이 카드를 보는 중, accent 링), 기본; 칩: 지금 화면/저장 전/저장됨/확인 중/반영됨 |
| 5 | 상태 카드 | `.savecard` | 아이콘+제목(저장했어요 / 저장하고 O님께 넘겼어요)+서브(시각·바뀐 파일 N개)+파일 행(화면 제목·설명·`고침` 태그)+힌트 | **대기**(`저장 대기` warn, 행동 버튼 있음) / **진행**(저장 중·넘기는 중, stage 반영) / **완료**(`--done` ok, 버튼 사라짐) / **실패**(오류 문장+다시 시도) |
| 6 | 진행 한 줄 | `.milestone` | 작은 원 아이콘 + 한 문장 + 우측 시각 | `--send`(넘김, warn) / `--ok`(반영, ok) / 기본(muted) |
| 7 | 사람 메시지 | `.devmsg`(+`.cmt`) | 아바타(이니셜) + `이름 · 소속 · 시각` + 본문 버블 + 코멘트 인용 행(번호+굵은 라벨+본문+`대화에서 고치기`) | 도착(live dot `방금`) / 과거 |
| 8 | 결정 카드 | 질문+즉답 칩 | 질문 본문 + 선택지 칩(=즉답) + 메모 | 대기(응답 전) / 응답됨(카드 소멸, 턴으로 이어짐) |

날짜 구분선(`.day` — 어제/오늘)은 트랜스크립트 안의 장치이므로 이 슬라이스에 포함하되 구현 순서는 마지막(P7, §6).

### 1.2 대화 열 전체의 상태

| 상태 | 모습 | 근거 |
|---|---|---|
| 빈 대화 | 안내 문장 + 스타터 칩(선언 화면 문장 + `그림을 붙여 시작하기`) | `Transcript` blocks.length===0 |
| 기록 여는 중 | 빈 대화와 구분되는 얕은 스켈레톤(현재는 구분 없음 — 개선 항목) | `api.history()` in flight |
| 기록 실패 | 오류 notice + `다시 시도` | `sessions.historyFailed` |
| 실행 중 | 헤더 램프 + `작업 중…` spinner(첫 블록 전) + 컴포저 송신 버튼 = 중지/`정리 중…` | `sessions.running` |
| 오류 줄 | Fold로 접히는 notice(새 오류는 다시 펼침) | `sessions.error` |
| 실패한 턴 | FailedTurn 카드(원인+다시 보내기/고쳐서 다시 보내기) | `turn` 블록 isError |
| 스크롤 위 | `맨 아래로` / `새 내용` pill | pinned/unpinned |
| 연결 끊김 | 컴포저 비활성 | `disabled` |
| 미읽은 검토 도착 | 열 때 마지막 사람 메시지로 스크롤 + flash 링 | `review.arrived` 미읽음 |

### 1.3 컴포저의 상태

| 장치 | 상태 | 근거 |
|---|---|---|
| 상태 칩(inbox-chips) | `저장하지 않은 변경 N개`(warn) / `모두 저장됨`(ok, 클릭 없음) / 렌더 안 함(변경 0) / `치워둔 작업`(shelf tone, 슬롯 차 있을 때) | `repo.pendingChanges`·`repo.shelf` |
| 지금 저장하기 칩 | 나타남(변경>0 && !running) / 숨음(저장됨 직후·도는 중) | `deriveDelivery` 잠금 규칙 재사용 |
| 핀 트레이 | 행(N + 메모 입력 + 수정↔질문 칩 + 포커스) / 빈 = 렌더 안 함 | `Pins` |
| 큐 | `다음 턴에 보냅니다 · N건 대기`(고쳐서 보내기·지금 보내기) / 잃어버린 말(되살리기·지우기) / 뒤에서 도는 작업 | `queue`·`dropped`·`tasks` |
| 즉답 칩 | 턴 끝 + 입력창 비었을 때만 | `suggestion` |
| 본체 | textarea(초안 저장·@보완·/명령·IME), 모델·노력·권한·빠르게 칩, usage | 기존 |

---

## 2. 컴포넌트 계획 — 매핑 표 (핵심)

### 2.1 메시지 8종 × 기존 구현

| 종류 | 기존 구현(파일) | 판정 | 할 일 |
|---|---|---|---|
| 내 말 버블 | `transcript/Transcript.tsx` `case "user"` → `.bubble--user` (+ 요청 복사·고쳐서 다시 보내기·이미지 태그) | **있음** | 스타일 조정만(목업 어휘) |
| AI 산문 | `case "text"` → `.bubble--assistant` + `Markdown.tsx` + streaming caret + 답변 액션(되돌리기·다시 요청) | **있음** | 그대로 |
| 도구 한 줄(접힘) | `transcript/activity.tsx` `ActivitySummary`(묶음) + `transcript/blocks.tsx` `ToolBlock`/`CaptureCard`, `showTools` 토글 | **있음** | 그대로 |
| 화면 카드 | `transcript/turn.tsx` `ScreenChips`(답변 텍스트↔선언 화면 **대조**, 칩 형태) + `MachineTurn` 영수증(핀 턴, 썸네일 있음) + `CaptureCard` | **부분** | 신규 `ScreenCard`로 승격: 미니스샷+제목+상태 칩. 대조 로직(`ScreenChips`의 선언 화면 매칭)은 그대로 가져온다 |
| 상태 카드 | 없음 — 저장 UI는 `panels/ScreenPanel.tsx` 저장 검토 + `panels/DiffPanel.tsx` + `shell/HistoryDrawer.tsx`에 있음 | **신규** | 신규 `SaveCard` + 대화 삽입 이벤트 경로(§3) |
| 진행 한 줄 | `sysline`(`TAPE_LINES` CLI 하우스키핑)·`notice` 블록은 있으나 넘김·반영용 아님 | **신규(부분)** | 신규 `MilestoneRow` — 넘김/반영 전용. sysline과는 다른 어휘(아이콘 원+시각) |
| 사람 메시지 | 없음 — `DeveloperReview`는 ScreenPanel 개발자 패널(답하기 입력·고치기)로만 렌더 | **신규** | 신규 `HumanMessage`. 데이터는 이미 있음(`handoffStatus().reviews`), **도착 경로**가 신규(§3) |
| 결정 카드 | `transcript/cards.tsx` `QuestionCard`(AskQuestion)·`PlanCard` — pending 요청으로 렌더, 칩 응답 = `respondQuestion`/`respondPermission` 실제 전송 | **있음(다른 옷)** | 카드 문법(savecard 계열)으로 재스타일만. 즉답 원칙은 이미 지켜짐 |

### 2.2 컴포저 × 기존 구현

| 장치 | 기존 | 할 일 |
|---|---|---|
| 상태 칩 | 없음(상태 계산은 `lib/delivery.ts` `deriveDelivery` 가 이미 함) | 신규 `chat/ComposerChips.tsx` — 계산은 deriveDelivery 재사용 |
| 핀 트레이 | `preview/PinTray.tsx`(Composer 안에 이미 렌더됨) | 그대로 |
| 큐·드롭·작업 | `Composer.tsx` queue/dropped/tasks | 그대로 |
| 즉답 칩 | `composer__next` suggestion 칩 | 그대로, 원칙 문서화만 |

### 2.3 파일별 계획

**재사용(수정 없음)**: `Markdown.tsx`, `Fold.tsx`, `CopyButton.tsx`, `preview/PinTray.tsx`, `preview/TurnClock.tsx`, `shell/Tip.tsx`.

**수정**:
- `lib/daemon-client.ts` — `Block` union에 4종 추가(`save`·`milestone`·`human`·화면 카드용 메타), `foldEvent`/`applyEvent`에서 새 ChatEvent 접기.
- `components/chat/ChatColumn.tsx` — 저장 카드 액션(`api.save`→`api.handoff`) 핸들러, ComposerChips 장착, 사람 메시지 도착 시 스크롤·3단계 알림 연결, 열림 시 미읽은 검토로 스크롤.
- `components/transcript/Transcript.tsx` — 새 블록 라우팅(switch 확장), 살아있는 저장 제안(대기 카드) 렌더.
- `components/transcript/turn.tsx` — `ScreenChips` 를 `ScreenCard` 렌더로 교체(대조 함수 유지).
- `components/transcript/cards.tsx` — QuestionCard/PlanCard 카드 문법 재스타일.
- `components/chat/Composer.tsx` — ComposerChips 자리(입력 상자 위)만 마련; 로직은 ComposerChips 로.
- `hooks/useSessions.ts` — 변경 최소(저장 완료는 이벤트로 돌아오므로 submit 후 처리 불필요).
- `styles.css` — `mockups/mockup.css`·`mockups/final/final.css` 에서 `savecard`·`scard`·`state-chip`·`devmsg`·`cmt`·`milestone`·`day`·`inbox-chips`·`chip--*` 토큰 포팅(설계변수 `--ok` 등은 이미 공유 어휘).

**신규**:
- `components/transcript/SaveCard.tsx` — 상태 카드(대기/진행/완료/실패).
- `components/transcript/MilestoneRow.tsx` — 진행 한 줄.
- `components/transcript/HumanMessage.tsx` — 사람 메시지 + 코멘트 인용 행.
- `components/transcript/ScreenCard.tsx` — 화면 카드.
- `components/chat/ComposerChips.tsx` — 상태 칩.
- `lib/screen-state.ts` — route → 상태 칩 판정 순수 함수(§3.3).

---

## 3. 데이터 요구

### 3.1 daemon-client 가 이미 주는 것

| 데이터 | 메서드/필드 | 쓰임 |
|---|---|---|
| 저장 대기 개수 | `Daemon.repo.pendingChanges` | 컴포저 상태 칩, 대기 카드 존재 판정 |
| 저장/넘기기 진행 | `Daemon.diffStatus: DiffStatus`(stage: computing→pushing→published→handing-off→handed-off / failed, gate, reason, commit, message) | 카드의 진행→완료 전이, 실패 문장 |
| 저장·넘기기 실행 | `api.save(message?, sessionId?)`, `api.handoff({title?, body?, sessionId?})` | 카드 행동 버튼. handoff 의 title/body 생략 시 데몬이 `handoffDraft()` 기본값으로 씀 → 원클릭 가능 |
| 개발자 코멘트 | `api.handoffStatus()` → `HandoffStatusReport.reviews: DeveloperReview[]`(id, kind, author, body, pr, path?, line?, at) | 사람 메시지 본문·인용 |
| 코멘트 답하기 | `api.replyToReview(id, body)` | 사람 메시지의 답하기(필요 시) |
| 저장 기록 | `api.saveHistory()` → `{sha, message, at, files[]}[]` | 완료 카드의 시각·파일 수(과거 분) |
| PR 상태 | `repo.handoff: HandoffStatus`(state, reviewers), `repo.branch`, `repo.shelf` | 확인 중/반영됨/치워둔 작업 어휘 |
| 저장 요약 | `api.summarizeDiff()` → `{lines, memo}` | 카드 서브 문장·저장 메모 초안 |
| 칩 상태 계산 | `lib/delivery.ts` `deriveDelivery`(tone·잠금 이유 상수 포함) | ComposerChips 가 그대로 호출 |
| 고치기 턴 발송 | `sessions.submit` + `lib/preview-turns.ts` `reviewToTurn`(현재는 ScreenPanel 이 배치로 부름) | 인용 행 `대화에서 고치기`의 단건판 |
| 즉답 | `api.respondQuestion(respondId, answers, annotations)` | 결정 카드 칩 |

### 3.2 새로 필요한 것 — 대화 기록화 (이 슬라이스의 핵심 데이터 과제)

"모든 이야기는 이 대화에 모여 있어요"(목업)가 참이려면 저장·넘김·반영·코멘트 도착이 **세션 테이프에 영구 기록**되어야 한다. 지금은 `diffStatus`·`devReviews` 모두 창의 휘발 상태다 — 리로드하면 대화에서 사라진다. `ChatEvent`(protocol/src/session.ts) 확장 제안:

```ts
| { kind: "cycle.saved";   at: string; commit: string; message: string;
    files: string[];
    screens: Array<{ route: string; title: string; note?: string }> }   // → 상태 카드
| { kind: "cycle.handed";  at: string; pr: number; reviewer?: string }  // → 진행 한 줄(넘김)
| { kind: "cycle.merged";  at: string; pr: number }                     // → 진행 한 줄(반영)
| { kind: "review.arrived"; reviews: DeveloperReview[] }                // → 사람 메시지
```

- 데몬이 이미 아는 순간(저장 완료·handoff 완료·병합 감지·`peekHandoff` 의 신규 코멘트)에 세션 채널로 발송 + `session.history` 재생에 포함. `sessionId` 귀속: 저장/넘김은 `api.save`/`api.handoff` 가 받는 `sessionId`(없으면 마지막 활성 세션 — 데몬 판단).
- `foldEvent` 는 이 네 종류를 **블록으로 접는다**(기록이므로). `Block` union 에 `save`·`milestone`·`human` 추가.
- `DaemonApi` 신규 메서드는 불필요 — 기존 호출의 부수효과로만 발송된다.

### 3.3 화면 카드의 상태 칩 — 계산 규칙 (순수 함수, `lib/screen-state.ts`)

입력: route, `repo.pendingChanges`, 마지막 `cycle.saved.screens`, `repo.handoff.state`.
판정: 마지막 저장에 route 없음 && 변경 있음 → `저장 전`; 저장됨 && handoff 없음 → `저장됨`; handoff 열림 → `확인 중`; 병합 → `반영됨`. 미니스샷은 1차로 **그 턴의 `CaptureCard` 스크린샷 재사용**(없으면 도형 플레이스홀더) — 진짜 스냅샷 인프라는 journey 슬라이스의 동결 스냅샷 과제와 같음(경계).

### 3.4 그 밖의 작은 확장

- `HandoffStatus.reviewers` 에 표시 이름: 지금은 login 뿐 — `reviewers: Array<{ login: string; name?: string }>` 확장. 없으면 login 표시(1차).
- 날짜 구분선용: `user.echo`·`turn.end` 에 `at: string`(데몬 시계). P7.
- 옛 테이프 호환: 새 이벤트가 없으면 그 행이 없을 뿐(무손실). 반대 방향(옛 클라·새 데몬)은 `foldEvent` 기본 무시로 이미 관용적.

---

## 4. 상호작용 상세

### 4.1 카드 내 행동 버튼 (이 슬라이스의 심장)

| 버튼 | 클릭 결과 |
|---|---|
| 상태 카드 `저장하고 다시 넘기기` | `api.save(undefined, sessionId)` → `DiffStatus` 전이를 카드에 반영(computing→published) → 완료 시 `api.handoff({sessionId})` → handed-off 에서 카드 `--done` 전이: 제목 `저장하고 O님께 넘겼어요`, 태그 `확인 요청`(ok), 서브 `방금 · O님이 이어서 확인해요`, 힌트 교체, 버튼은 `대화에서 계속 고치기` 하나로. 동시에 진행 한 줄 추가 + 그 줄로 스크롤. 컴포저 칩 → `모두 저장됨`, `지금 저장하기` 숨음 |
| 상태 카드 `더 고칠래요` | 카드는 대기 상태로 대화에 그대로 남고(목업의 `saveHint` 문안 교체) 컴포저 포커스 |
| 상태 카드 실패 시 | `stage: failed` → 카드에 오류 문장(`detail`) + `다시 시도`. `reason: "push-auth"` → 기존 어휘(설정의 토큰 안내) |
| 인용 행 `대화에서 고치기` | `reviewToTurn([해당 리뷰 단건])` 을 `sessions.submit` — ScreenPanel `handleReview` 의 단건판. 턴이 나가면 그 답변 아래 새 화면 카드·새 대기 상태 카드가 따라온다 |
| 사람 메시지 자체 | 클릭 없음(읽기). 단 도착 시 flash 링(panering 0.9s×2) |

저장 버튼은 저장만 하는 변형도 필요(저장했어요 카드): 제목 분기는 `api.save` 만 호출하는 경로 — 넘기기 없이 저장만 하는 플로우(기존 저장 검토의 대응물). 카드 액션 구성: `변경 있음 && PR 없음` → `[더 고칠래요] [저장하고 넘기기]`; `PR 열려 있고 새 변경`(재검토) → `[더 고칠래요] [저장하고 다시 넘기기]`.

### 4.2 화면 카드

- 클릭 → `onOpenScreen(route, state)`(기존 배관 — 미리보기 패널 열림 여부·크게 보기는 product 슬라이스).
- 미리보기가 그 route/state 를 보고 있으면 `scard--open`(accent 링). 감지: 기존 `preview.opened` 이벤트의 route/state 와 대조.
- 코멘트 인용 행 ↔ 패널 핀 하이라이트: 핀이 있는 코멘트(§5 제약 참조)는 `onPinFocus` → `preview.pinFlash(id)` 기존 배관.

### 4.3 컴포저 상태 칩

- `저장하지 않은 변경 N개` 클릭 → 살아있는 저장 카드로 스크롤 + flash.
- `지금 저장하기` 클릭 → 스크롤 + 저장 즉시 실행(§4.1과 같은 핸들러).
- 도는 중(`running`)이면 지금 저장 칩은 잠김(`BUSY_SAVE` 사유 Tip) — `deriveDelivery` 규칙 그대로.

### 4.4 결정 카드·즉답 칩 (원칙 — home 슬라이스와 공유 계약)

즉답 칩은 장식이 아니다. 누르면 **그 대화의 다음 턴으로 실제 프롬프트가 나간다**: QuestionCard 칩 → `respondQuestion`, suggestion 칩 → 문장이 컴포저에 들어가고 송신은 계획자의 손(현재 동작 유지), 인용 행의 `대화에서 고치기` → `submit`. 어떠한 칩도 "열지 않고 답하는 것처럼 보이는" 경로를 만들지 않는다.

### 4.5 키보드·전환 (기존 유지 + 추가)

Enter/⌘Enter 송신(sendKey 설정), ⌥Enter 끊고 보내기, Esc 메뉴·오류 닫기, F2 대화 이름, ⌘N 새 대화. 새로: 대기 상태 카드의 행동 버튼은 Tab 포커스 순서가 컴포저보다 앞(읽는 순서 = 포커스 순서). 사람 메시지 도착: 스크롤이 바닥에 붙어 있을 때만 따라감(pinned 규칙 재사용); 열 때 미읽은 검토가 있으면 `block:"start"` 로 스크롤(목업의 `devmsg.scrollIntoView`).

### 4.6 3단계 알림과의 접점

사람 메시지 도착 = 조용한 로그(대화 행). 뱃지·푸시 판정은 home 슬라이스의 게이트가 소유 — 이 슬라이스는 `review.arrived` 이벤트를 노출하기만 한다.

---

## 5. 엣지 케이스

1. **도는 턴 중 저장 카드**: 행동 잠김 + 사유(`Claude가 고치는 중 — 끝나면 저장할 수 있습니다`). 칩도 같은 규칙.
2. **두 창**: 한 창의 저장 → `diffStatus` 브로드캐스트로 다른 창 카드·칩 동시 갱신(이미 오는 채널). 카드와 제목바(product)가 같은 상태를 읽으므로 찰나의 어긋남만 가능, 수렴함.
3. **코멘트 대량 도착**: `review.arrived` 하나에 인용 행으로 정렬(목업과 동일). 스크롤은 첫 도착 시 한 번.
4. **반려(closed)**: 별도 카드 아님 — 반려 코멘트(사람 메시지) + 진행 한 줄(`반려됐어요`, danger tone)로 표현. 상태 어휘 `반려` 는 칩에서만.
5. **DeveloperReview ↔ 핀 매핑 부재**: `DeveloperReview` 는 `path:line` 만 가지고 핀 id가 없다. 1차는 path 기반 유추하지 않고 **인용 행을 핀 없이 렌더**(라벨=코드 위치). 핀 연결이 필요하면 `DeveloperReview.pinId?` 확장 — 별도 합의 후.
6. **선언에서 사라진 화면**: 카드의 route 가 `screens` 대조에 없으면 제목=route 로 렌더, 열기 실패는 미리보기 오류(product 슬라이스)에 맡김.
7. **치워둔 작업**: 슬롯 차 있으면 상태 칩이 `변경 없음` 이 아니라 `치워둔 작업`(shelf tone) — 부재로 분실이 시작되지 않게(기존 PARKED_AWAY 규칙).
8. **빈 대화 + 미연결/화면 0**: `GENERIC_STARTERS` 폴백(기존). 저장 카드 자체가 없음.
9. **세션 삭제**: 사람 메시지도 세션 소속이라 함께 사라짐 — 의도됨(대화가 단위).
10. **리로드 도중 도착**: 기록화(§3.2) 덕에 `session.history` 재생으로 복원. 재생 테이프의 `review.arrived` 는 live dot 없이 과거 시각으로.
11. **옛 세션**: 새 이벤트 없음 → 없는 행(무손실). 마이그레이션 불필요.
12. **미니스샷 없는 턴**: 도형 플레이스홀더(§3.3) — 빈 상자가 아니라 "화면 있음"을 알리는 최소 도식.
13. **같은 PR 재검토 라운드**: 넘김→코멘트→고침→재넘김에서 milestone 이 여러 줄 쌓임 — 목업의 의도(진행 한 줄이 대화의 연대기).

---

## 6. 이 슬라이스 안의 구현 순서

1. **프로토콜·데몬**: `ChatEvent` 4종 + 데몬 발송 지점(저장/handoff/병합/peekHandoff 신규 코멘트) + `history` 재생 포함.
2. **웹 수신**: `daemon-client.ts` `Block` 확장·`foldEvent` — 이 시점에서 데이터만 흐름.
3. **스타일 포팅**: `styles.css` 에 카드·칩·행 어휘(§2.3).
4. **상태 카드 + 진행 한 줄**: `SaveCard`·`MilestoneRow` + ChatColumn 액션 핸들러 + DiffStatus 전이 연결. **검증 지점**: 원클릭 저장→넘기기가 카드 전이·milestone·칩을 모두 바꾸는 시나리오.
5. **컴포저 상태 칩**: `ComposerChips`(deriveDelivery 재사용) + 카드로 스크롤·flash.
6. **사람 메시지**: `HumanMessage` + `review.arrived` + 인용 행 고치기·스크롤·알림 접점. ScreenPanel 의 개발자 패널은 이 시점부터 이중 표면 — product 슬라이스와 제거 시점 조정(제목바가 상태를 이어받음).
7. **화면 카드**: `ScreenCard`(ScreenChips 대체) + `lib/screen-state.ts` + `scard--open`.
8. **결정 카드 재스타일** + 날짜 구분선(`at` 필드) + 기록 로딩 스켈레톤.

각 단계 뒤 실제 표면에서 확인(브라우저 대시보드·데몬 시나리오 스크립트) — 4와 6이 실사 검증 지점.

---

## 7. 리스크

| 리스크 | 왜 | 완화 |
|---|---|---|
| 테이프 기록화의 주관 자리 | 저장이 어느 세션에 기록되는지(`sessionId` 없는 저장) 모호 | 저장 카드가 항상 `sessionId` 를 실어 보내게 UX 강제; 데몬 폴백은 마지막 활성 |
| 이중 저장 표면(카드↔제목바) | product 슬라이스 제목바와 같은 동작 두 곳 | 하나의 `DiffStatus`·하나의 api 로 수렴; 데몬이 한 번에 하나만 실행(이미 보장됨) |
| 미니스샷 인프라 부재 | 진짜 스냅샷은 없음 | CaptureCard 재사용→플레이스홀더; journey 의 동결 스냅샷과 함께 업그레이드 |
| reviewer 실명 없음 | login 만 있음 | `name?` 확장 전까지 login 표시 — 문장 어휘는 `O님` 유지 |
| ScreenChips 폐기 회귀 | 칩이 사라지며 대조 로직 망실 위험 | 대조 함수만 분리 재사용, 렌더만 교체 |
| Composer 비대(52KB) | 칩 로직 추가 가중 | `ComposerChips` 별도 파일로 격리 |
| 기록화된 review body 의 영속성 | 세션 기록에 개인 코멘트 영구 저장 | 이미 `comments.json` append-only 로그가 같은 데이터를 가짐 — 새로 노출되는 것은 아님 |
| 옛 클라이언트/새 데몬 | 알 수 없는 이벤트 | `foldEvent` 기본 무시(기존 관용) — 검증 항목에 포함 |
