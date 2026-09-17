# UI/UX 개선 마스터 계획 — chat 척추 + home 문 + journey 띠 + product 확장

> 작성일: 2026-09-16
> 근거: `docs/hero-synthesis.md`(확정 방향) + 4개 슬라이스 스펙 — `chat.md` · `home.md` · `preview.md` · `states.md`
> 방법: 공통 계약(`.local/share/plan-brief.md`)으로 어휘·경계 고정 → 4 에이전트가 기존 구현(`packages/web`, `daemon-client`)과 대조해 슬라이스별 상세 스펙 작성 → 본 문서가 크로스 슬라이스 정합성을 묶는다.

---

## 0. 한 줄

**기반 작업 하나가 네 장면 전부를 가능하게 한다: 사이클 사건(저장·넘김·반영·코멘트 도착)을 `ChatEvent`로 세션 테이프에 기록하는 것.** chat과 states가 독립적으로 같은 결론에 도달했다 — 지금 `diffStatus`·`devReviews`는 창의 휘발 상태라, 기록 없는 카드화는 "새로고침하면 사라지는 이야기"다.

---

## 1. 슬라이스별 핵심

| 슬라이스 | 파일 | 한 줄 | 기존 재사용 | 신규 |
|---|---|---|---|---|
| 대화면 | `chat.md` | 메시지 8종 중 3종은 이미 있음 | 버블·Markdown·`ActivitySummary`·`QuestionCard`·`PinTray`·큐 | `ScreenCard`·`MilestoneRow`·`SaveCard`·`HumanMessage` + 컴포저 상태 칩 |
| 홈 인박스 | `home.md` | 결정 카드 인용은 오늘 데이터로 됨 | `PendingQuestion.questions[]` 원문·`respondQuestion`·`openThread` 내비 | "마지막 행동 한 줄"(메인 턴용) + pending 타임스탬프 |
| 미리보기·띠 | `preview.md` | 제목바는 대체가 아니라 흡수 | `.screenpanel__bar`·`deriveDelivery`·`pinsSync`·`HandoffShot`(이미 커밋됨) | `JourneyMap`(제목 행 흡수)·`deriveJourney()`·`useMarks` 레지스트리·`FrozenStage` |
| 상태·모달 | `states.md` | 8단어 어휘 = `DeliveryState` 유일 원천 | `deriveDelivery`·`ConfirmDialog`·저장 기록 드로어·push-stalled 재시도 | 토큰 만료 오버레이 + 모달 3종의 대화 카드화 |

## 2. 크로스 슬라이스 정합성 — 합의된 것과 조정한 것

### 독립적으로 같은 결론 (신뢰도 높음)
- **`ChatEvent` 사이클 기록** — chat(`cycle.saved/handed/merged/review.arrived`)과 states(전이의 ChatEvent 기록)가 같은 제안. 신규 API 메서드 불필요, `session.history` 재생 포함.
- **`deriveDelivery`가 유일 원천** — preview(제목바 칩)와 states(8단어 어휘)가 같은 상수를 읽는 규율 승계. `delivery.chip.docLabel` 신규 필드 하나로 제목바·컴포저 칩·카드가 수렴.
- **동결 스냅샷은 싸다** — `HandoffShot`이 넘기기 시 `.colo-design/shots/`에 이미 커밋됨(PLAN D56). `git show`로 읽어 `<img>`로 표시하면 됨.

### 조정이 필요했던 것 (마스터가 판정)
- **즉답 칩의 정체** — 계약은 "다음 턴으로 프롬프트"라 했으나 home이 발견: 실제 경로는 `respondQuestion`(멈춘 도구 호출의 응답). **판정: 두 경로를 구분해 명시** — 결정 카드의 칩 = `respondQuestion`(같은 턴 계속), 개발자 코멘트 카드의 "고치기" = 새 턴 전송. 둘 다 "대화를 열지 않고 답하는 척"은 아니므로 원칙 준수.
- **여정은 프로젝트의 것** — 목업은 대화 단위로 그렸으나 사이클은 프로젝트 단위(preview·states 둘 다 지적). **판정: 띠를 전체 폭에 두어 프로젝트 진실임을 레이아웃으로 표현.** 대화 단위 지도는 사이클 모델 대공사가 선행 — 2주차 과제.
- **오버레이 시트 불가** — 네이티브 `WebContentsView`가 모든 DOM 위에 그려짐. **판정: product 확장의 대화 시트는 미리보기 열 하단 도킹**(`ResizeObserver`가 bounds 추적). `usePreviewCover`는 손대지 않음.
- **"12분 전" 불가** — `PendingPermission`/`PendingQuestion`에 타임스탬프 없음. **판정: 데몬이 `requestedAt` 추가 — 신규 필드, 저비용.**
- **"휴대폰으로도 알림" 카피 금지** — 모바일 푸시 인프라 없음. **판정: v1 카피에서 제거, 3단계 위계는 로그/뱃지/네이티브 알림으로.**
- **크로스 프로젝트 인박스 불가** — 비활성 프로젝트는 웹소켓 브로드캐스트 없음. **판정: v1 홈은 활성 프로젝트 스코프.**

## 3. 데몬/프로토콜 작업 목록 (통합)

| # | 작업 | 필요 슬라이스 | 비용 |
|---|---|---|---|
| D1 | `ChatEvent` 4종: `cycle.saved`/`cycle.handed`/`cycle.merged`/`review.arrived` + `session.history` 재생 | chat·states | 중 — 기반 작업 |
| D2 | `PendingPermission`/`PendingQuestion`에 `requestedAt` | home | 소 |
| D3 | 메인 턴의 "마지막 행동 한 줄" — `agentProgressSummaries`를 서브에이전트 전용에서 확장 | home | 중 |
| D4 | `api.handoffShot(route, state)` — `git show <branch>:`로 커밋된 샷 읽기 | preview·states | 소 |
| D5 | `HandoffStatus.handedAt`/`mergedAt` + `shots` URL | preview·states | 소 |
| D6 | `delivery.chip.docLabel` — `바꿈 N · 저장 안 됨` 문법(파일 수 아니라 화면을 바꾼 턴 수) | preview·states·chat | 소 |
| D7 | `pinsSync`에 `tone`/`screenMark` 필드 — 고침 표시↔핀 1:1 | preview·chat | 소 |
| D8 | 개발자 코멘트 도착의 세션 라우팅 | states·chat | 중 |
| D9 | (2주차) 대화 단위 사이클 기여 / 크로스 프로젝트 브로드캐스트 / 모바일 푸시 | 전체 | 대 |

## 4. 구현 순서 (슬라이스 통합)

**P0 — 기반(기록과 어휘)**
1. D1 `cycle` ChatEvent 4종 + history 재생 → D6 `docLabel` → `JourneyMap`+`deriveJourney()`(제목 행, 읽기 전용) → 컴포저 상태 칩.
   검증: 저장→넘기기→반영이 새로고침 후에도 대화에 카드로 남는가.

**P1 — 대화면 + 홈**
2. `SaveCard`·`MilestoneRow`·`HumanMessage` → `ScreenCard` 승격 → 결정 카드 재스타일.
3. 홈 인박스(활성 프로젝트): 결정 카드(인용+`respondQuestion` 칩) → 진행 중(D3 필요) → 방금 있던 일. 카드 클릭 = `openThread` 착지.
   검증: 원클릭 저장+넘기기 시나리오(chat.md 4단계), 검토 도착 시나리오(6단계).

**P2 — 미리보기 + 모달**
4. 제목바 흡수(`docLabel` 칩 + 팝오버 + `⌘S`) → `useMarks`+`pinsSync` 확장 → `FrozenStage`(D4·D5) → "크게 보기" 도킹 시트.
5. 모달 카드화: 저장 검토·넘기기·개발자 코멘트 → 대화 안 카드. 토큰 만료 오버레이. 온보딩 2단(토큰→레포).

**P3 — 2주차(명시적 보류)**
6. 대화 단위 사이클 → 크로스 프로젝트 인박스 → 모바일 푸시 → 시점 빌드 재현(`api.handoffPreview` 워크트리+두 번째 포트).

## 5. 통합 리스크

| 리스크 | 출처 | 완화 |
|---|---|---|
| 기록 없는 카드화 = 새로고침하면 사라지는 이야기 | chat·states | D1이 P0의 첫 항목인 이유 |
| 폴링 10분 지연을 카드가 숨기면 거짓말 | states | "도착했어요" 대신 시각 표기로 정직하게 |
| 대화 단위 목업 vs 프로젝트 단위 사이클 | preview·states | 띠 전체 폭 + 2주차 과제로 명시 |
| 미니스샷 인프라 부재 | chat | `CaptureCard` 재사용→플레이스홀더, 진짜 스냅샷은 D4와 공유 |
| `DeveloperReview`에 핀 id 없음 | chat | 1차는 인용 행을 핀 없이 렌더 |
| 알림 과신(카피가 곧 정책) | home | 푸시 판정을 데몬에서 엄격히 — "진짜 막힌 대목"만 |
| `WebContentsView` 오버레이 불가 | preview | 도킹 시트로 결정됨 — 목업 해석만 바뀜 |

## 6. 검증 시나리오 (실사)

1. **원클릭 저장+넘기기**: 카드가 대기→진행→완료 전이, milestone 추가, 칩 `모두 저장됨` 전환, 새로고침 후에도 카드 잔존.
2. **검토 도착**: 개발자 코멘트가 `HumanMessage`로 대화에 도착 → "고치기"가 새 턴 전송 → 고침 표시 번호가 핀과 1:1.
3. **돌아왔을 때**: 홈이 결정 필요→진행 중→방금 있던 일 순서, 카드 클릭이 해당 대화의 해당 카드로 착지.
4. **넘긴 후**: `FrozenStage`가 보낸 시점 화면을 표시, 미리보기 잠금 도장.
5. **가장자리**: 빌드 실패 시 미리보기 자리만 교체(저장·넘기기는 살아있음), 토큰 만료 3종 구분, 오프라인 push-stalled 재시도.
