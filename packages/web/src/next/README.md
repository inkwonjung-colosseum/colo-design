# next/ — 셸 (PLAN-UI)

`PLAN-UI.md` 의 화면이 사는 자리다 — 단계 7 이 옛 셸을 걷어 이것이 유일한 셸이다.
기준은 목업 `mockups/redesign.html` — 문장과 토큰은 목업에서 가져온다.

## 여는 법

`App.tsx` 가 연결이 서면 언제나 `NextShell` 을 그린다. 연결 전(브라우저 개발
경로의 url 붙여넣기)만 `ConnectScreen.tsx` 가 선다. 셸 밖에서 빌려 쓰는 것:
훅(`useDaemon` · `useSessions` · `usePins` · `use-invite-import`), 대화록의 블록
(`components/transcript/{blocks,activity,todo,shared}`), 미리보기 무대의 선로
(`components/preview/PreviewFrame` — 데스크톱이 `[data-testid=preview-slot]` 을 찾는다 —
와 `types.ts`), `components/shell/{Palette,Splitter}`, `ShortcutsSheet`, `lib/`.

## 규칙

- **사용자 문자열은 `labels.ts` 에만.** 이 폴더의 다른 `.ts`/`.tsx` 에 한글
  리터럴(문자열 · JSX 텍스트)을 쓰지 않는다. 숫자가 붙는 문장은 `labels.ts` 의
  함수로 만든다(`L.journey.screensBefore(n)`). 금칙어(턴 · 경로 · git · 데몬 ·
  커밋 · 브랜치 · PR)도 `labels.ts` 에 들이지 않는다. 둘 다
  `packages/web/test/next-labels.test.ts` 가 지킨다(`pnpm test`).
- **죽은 문장을 두지 않는다.** `L` 의 칸은 모두 이 폴더 어딘가가 부른다 — 같은
  시험이 센다. 칸을 통째로 건네면(`L.update`) 시험의 `WHOLE_GROUP` 표에 받는 곳을 적는다.
- **폴더 밖의 사용자 문장도 금칙어가 없다** — `test/vocab-sweep.test.ts` 가 `src/**` 의
  한글 리터럴 · JSX 텍스트를 훑는다(면제는 이유와 함께 그 파일의 `EXEMPT` 에).
- **클래스는 `nx-` 로 시작한다.** 토큰은 `next.css` 의 `.nx` 뿌리에 걸려 있어
  `styles.css` 의 전역 변수와 섞이지 않는다. 창 전체를 쓰는 뿌리(처음 한 번의
  `.nx-ob`)는 `.nx` 의 작업 틀 격자를 `display: block` 으로 풀어야 한다.
- 주석은 한국어로 써도 된다 — 검사는 주석을 걷고 본다.

## labels.ts 의 칸

`L` 하나에 칸이 차례로 선다 — 공통(U10 어휘 · 문제 문장 · 여정), `단계 1 뼈대`,
`단계 2 대화`, `단계 3 미리보기`, `단계 4 제출·이번 작업`,
`단계 5 처음 한 번·준비·초대`, `단계 6 설정·업데이트`. 각 단계는 **자기 칸의
끝에만** 더한다; 칸 사이의 빈 줄 셋은 병합의 완충이라 `biome-ignore format` 으로
포매터가 접지 않게 해 두었다(더한 줄의 모양은 손으로 맞춘다).

## 틀

```
NextShell ─ 첫 상태 전 · 프로젝트 0개 · 게이트가 막힘 → onboarding/FirstRun(창 전체)
│           초대 파일 가져오기의 컨트롤러 하나 + onboarding/InviteConfirm(확인판)
└ Workspace ─ useSessions · usePins · useShellNav 를 한 번만 부른다
  ├ sidebar/Sidebar     새 대화 · 홈 · 찾기 / 전환기 / 다른 프로젝트 줄 / 대화 목록 · 도구가 한 일 / 설정
  ├ home/HomeView       인사 · 큰 입력창(HomeComposer) · 받은 편지함(HomeInbox)
  └ 작업 보기(홈에서도 마운트된 채 `nx-offstage` 로 숨는다 — 미리보기 게스트가 살게)
    ├ status/StatusLine  제목 · 만드는 중 · 여정 세 점 · 제출(SubmitPopover) · 이번 작업(WorkPopover)
    ├ status/ProblemLine 문제 문장 셋 · 초대 파일 지우기 줄 — 대화와 미리보기에 걸친 한 줄
    ├ (좁은 창) 대화 | 화면 · <이름> 탭
    ├ chat/ChatColumn     대화록(Thread) · 카드 · 입력창(Composer · ModelChip)
    └ preview/PreviewColumn 막대 · 무대(PreviewHost) · 말풍선 · 준비 화면 · 작업 기록 서랍
```

첫 가져오기(프로젝트 0개)의 행이 모두 `새로` 면 확인판 없이 곧바로 적용하고, 첫
프로젝트의 문제 문장 자리에 `초대 파일을 가져왔어요 — 파일 지우기 · 나중에` 가 선다.
다시 받기는 확인판을 거친다.

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
| `openSettings()` · `toast(text)` | 설정 대화상자 · 잠깐 뜨는 한 줄 |

**`SlotProps`** — `ChatColumn`(단계 2)과 `PreviewColumn`(단계 3)이 함께 받는다:
`daemon` · `settings` · `sessions`(`useSessions` 결과) · `pins`(`usePins` 결과 —
두 칸이 같은 목록) · `project`(활성, 없으면 null) · `activeSessionId` · `nav` ·
`narrow` · `onChatChange` · `onRenameSession`. `PreviewColumnProps` 는 여기에
`onScreenName(name | null)` — 지금 화면의 제목을 셸에 알려 좁은 창의 `화면 · <이름>`
탭이 읽는다. 찍은 핀 수(탭 배지)는 셸이 `pins.list` 에서 센다.

**`StatusLineProps`**(단계 4) — `title` · `journey`(셸이 `deriveJourney(…, L)` 로 한 번
판정) · `turnStartedAt`(데몬 시계, `만드는 중 · 12초`) · `narrow` · `nav` ·
`onSubmit`(열린 제출 버튼을 눌렀다 — 확인 팝오버는 StatusLine 이 연다).
잠긴 버튼은 누르면 `journey.submit.reason` 이 버튼 아래 한 줄로 선다.
`이번 작업` 의 몸통은 `status/WorkPopover.tsx` 를 바꿔 채운다.

## 순수 판정 (`lib/`)

- `journey.ts` — `deriveJourney({ repo, diffStatus, handoff?, running, reconnect?, comments?, submitCopy }, L)`:
  세 점의 글자 · 지금 점 · `blocked` · `making` · 제출의 `enabled` · `reason` · `busy` · `more`.
  `repo.cycleScreens` 를 읽고, 없으면 커밋 수 · 요청 상태만으로 판정한다.
- `submit-copy.ts` — `submitCopy(repo?.submit, L)`(U13): 버튼의 말 · 첫 점(막힘) · 잠긴 이유
  (auth 는 새 초대 파일, 그 밖은 개발자에게 알림) · 마지막 제출 시각. 셸이 지어 여정에 건넨다.
- `work-ledger.ts` — 제출 확인 · `이번 작업` 의 목록 판정: 제출할 화면(화면마다 한 줄) · 화면 밖
  변경 · 코멘트 장부(`코멘트 반영 — ` 기록이 뒤에 있으면 반영됨) · 시작일. 장부의 값은
  `status/use-work-ledger.ts` 가 읽는다(`repo.handoffStatus` 의 `reviews` · `repo.history`).
- `project-note.ts` — `projectNote(summary, L, { aiFailed?, comments? })`(다른 프로젝트 줄의
  가장 급한 것) · `projectStatus`(전환기의 둘째 줄) · `isPreparing` · `neverPrepared`.
- `update-row.ts` — 설정의 업데이트 줄 한 줄(`updateRowCopy`) · 홈의 `방금 있던 일` 에
  서는 AI 프로그램 업데이트 소식(`agentUpdateEvents` — `DaemonStatus.agentUpdates` 의 done).
- `problem.ts` · `invite-rows.ts` · `revert-summary.ts` · `thread.ts` · `nav.ts` ·
  `preview-geometry.ts` — 문제 문장 · 초대 확인판의 행 · 되돌리기 문구 · 대화록 · 이동 ·
  말풍선 좌표의 판정.
- 문장을 인자(`L`)로 받는 이유 — 시험이 src 에서 곧장 읽는 순수 모듈은 형제를 부르지
  않는다(확장자 없는 import 를 node 가 풀지 못한다).

시험: `node --test packages/web/test/next-*.test.ts packages/web/test/vocab-sweep.test.ts`.
