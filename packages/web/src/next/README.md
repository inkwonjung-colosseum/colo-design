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
