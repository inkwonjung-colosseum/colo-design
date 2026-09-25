# next/ — 새 셸 (PLAN-UI)

`PLAN-UI.md` 의 새 화면이 옛 셸 옆에서 자라는 자리다. 기준은 목업
`mockups/redesign.html` — 문장과 토큰은 목업에서 가져온다.

## 여는 법

개발 실행(`DaemonStatus.dev`)에서 주소에 `?shell=next` 를 붙인다
(`App.tsx` 의 병행 셸 스위치, PLAN-UI 4 · P4). 그 밖에는 언제나 옛 `Shell` 이 선다.
두 셸은 같은 훅(`useDaemon` · `useSessions` · `usePins`)을 쓰므로 데몬은 하나다.
단계 6 에서 기본이 되고 단계 7 이 옛 셸을 걷는다.

## 규칙

- **사용자 문자열은 `labels.ts` 에만.** 이 폴더의 다른 `.ts`/`.tsx` 에 한글
  리터럴(문자열 · JSX 텍스트)을 쓰지 않는다. 숫자가 붙는 문장은 `labels.ts` 의
  함수로 만든다(`L.journey.screensBefore(n)`). 금칙어(턴 · 경로 · git · 데몬 ·
  커밋 · 브랜치 · PR)도 `labels.ts` 에 들이지 않는다. 둘 다
  `packages/web/test/next-labels.test.ts` 가 지킨다(`pnpm test`).
- **클래스는 `nx-` 로 시작한다.** 토큰은 `next.css` 의 `.nx` 뿌리에 걸려 있어
  `styles.css` 의 전역 변수와 섞이지 않는다.
- 주석은 한국어로 써도 된다 — 검사는 주석을 걷고 본다.

## labels.ts 의 칸

`L` 하나에 칸이 차례로 선다 — 공통(U10 어휘 · 문제 문장 · 여정), `단계 1 뼈대`,
`단계 2 대화`, `단계 3 미리보기`, `단계 4 제출·이번 작업`,
`단계 5 처음 한 번·준비·초대`, `단계 6 설정·업데이트`. 각 단계는 **자기 칸의
끝에만** 더한다; 칸 사이의 빈 줄 셋은 병합의 완충이라 `biome-ignore format` 으로
포매터가 접지 않게 해 두었다(더한 줄의 모양은 손으로 맞춘다).

## 틀 (단계 1)

```
NextShell ─ 프로젝트 0개 · 마법사 · 첫 상태 전 → 옛 Shell(단계 5 가 바꾼다)
└ Workspace ─ useSessions · usePins · useShellNav 를 한 번만 부른다
  ├ sidebar/Sidebar     새 대화 · 홈 · 찾기 / 전환기 / 다른 프로젝트 줄 / 대화 목록 · 도구가 한 일 / 설정
  ├ home/HomeView       인사 · 큰 입력창(HomeComposer) · 받은 편지함(HomeInbox)
  └ 작업 보기(홈에서도 마운트된 채 `nx-offstage` 로 숨는다 — 미리보기 게스트가 살게)
    ├ status/StatusLine  제목 · 만드는 중 · 여정 세 점 · 제출 · 이번 작업(WorkPopover)
    ├ (좁은 창) 대화 | 화면 · <이름> 탭
    ├ chat/ChatColumn     ← 단계 2 가 바꾼다
    └ preview/PreviewColumn ← 단계 3 이 바꾼다
```

이동 상태(홈 ↔ 대화 · 좁은 창의 탭 · 서랍 · 접힘)는 `lib/nav.ts` 의 줄임 함수,
그 손은 `lib/use-shell-nav.ts` 가 만든다. 주소에 싣지 않는다. 열린 대화의 주인은
`sessions.activeId` 하나다.

## 칸의 계약 (`slots.ts`)

**`ShellNav`** — 모든 칸이 같은 길로 움직인다.

| 손 | 하는 일 |
| --- | --- |
| `openThread(slug, threadId)` | 대화를 연다. 다른 프로젝트면 `project.activate` 뒤, 등록부가 옮겨 앉으면 연다 |
| `newThread(slug?)` | 새 대화의 빈 자리(`sessions.fresh()`) — 세션은 첫 말이 나갈 때 태어난다 |
| `goHome()` · `showThread()` | 홈 · 대화 보기 |
| `switchProject(slug)` | 옮기기 + 토스트. 옮겨 앉으면 셸은 홈부터 |
| `showTab("chat" \| "preview")` | 좁은 창의 탭 |
| `openSettings(category?)` · `toast(text)` | 설정(단계 6 이 바꾼다) · 잠깐 뜨는 한 줄 |

**`SlotProps`** — `ChatColumn`(단계 2)과 `PreviewColumn`(단계 3)이 함께 받는다:
`daemon` · `settings` · `sessions`(`useSessions` 결과) · `pins`(`usePins` 결과 —
두 칸이 같은 목록) · `project`(활성, 없으면 null) · `activeSessionId` · `nav` ·
`narrow` · `onChatChange` · `onRenameSession`. `PreviewColumnProps` 는 여기에
`onScreenName(name | null)` — 지금 화면의 제목을 셸에 알려 좁은 창의 `화면 · <이름>`
탭이 읽는다. 찍은 핀 수(탭 배지)는 셸이 `pins.list` 에서 센다.

**`StatusLineProps`**(단계 4) — `title` · `journey`(셸이 `deriveJourney(…, L)` 로 한 번
판정) · `turnStartedAt`(데몬 시계, `만드는 중 · 12초`) · `narrow` · `nav` ·
`onSubmit`(열린 제출 버튼을 눌렀다 — 지금은 빈 손, 단계 4 가 확인 팝오버로).
잠긴 버튼은 누르면 `journey.submit.reason` 이 버튼 아래 한 줄로 선다.
`이번 작업` 의 몸통은 `status/WorkPopover.tsx` 를 바꿔 채운다.

## 순수 판정 (`lib/`)

- `journey.ts` — `deriveJourney({ repo, diffStatus, handoff?, running, reconnect?, comments?, submitCopy }, L)`:
  세 점의 글자 · 지금 점 · `blocked` · `making` · 제출의 `enabled` · `reason` · `busy` · `more`.
  `repo.cycleScreens` 를 읽고, 없으면 옛 `deriveDelivery` 의 판정으로 물러선다.
- `submit-copy.ts` — `submitCopy(repo?.submit, L)`(U13): 버튼의 말 · 첫 점(막힘) · 잠긴 이유
  (auth 는 새 초대 파일, 그 밖은 개발자에게 알림) · 마지막 제출 시각. 셸이 지어 여정에 건넨다.
- `work-ledger.ts` — 제출 확인 · `이번 작업` 의 목록 판정: 보낼 화면(화면마다 한 줄) · 화면 밖
  변경 · 코멘트 장부(`코멘트 반영 — ` 기록이 뒤에 있으면 반영됨) · 시작일. 장부의 값은
  `status/use-work-ledger.ts` 가 읽는다(`repo.handoffStatus` 의 `reviews` · `repo.history`).
- `project-note.ts` — `projectNote(summary, L, { aiFailed?, comments? })`(다른 프로젝트 줄의
  가장 급한 것) · `projectStatus`(전환기의 둘째 줄) · `isPreparing` · `neverPrepared`.
- 문장을 인자(`L`)로 받는 이유 — 시험이 src 에서 곧장 읽는 순수 모듈은 형제를 부르지
  않는다(확장자 없는 import 를 node 가 풀지 못한다).

시험: `node --test packages/web/test/next-*.test.ts`.
