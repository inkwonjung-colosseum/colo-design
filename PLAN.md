# PLAN — 기획자가 믿고 쓰는 도구: 되돌릴 수 있고, 진행이 보이고, 말이 하나다

README는 지금 배포된 것을 적고, 이 문서는 다음 판이 무엇이고 왜인지를 적는다.
결정은 번호를 달아 코드 주석이 `PLAN D40`처럼 가리킨다. 앞 세 판(agent-hub ·
Drafthouse · CDS Design 게이트 넷/사이드바)의 결정 D1–D34는 전부 들어갔거나
폐기됐고, 코드 주석이 아직 그 번호를 부르므로 §9의 대응표로만 남긴다. 이 판의
결정은 **D35**부터 잇는다. **이 문서가 유일하다. 완료 전에 지우지 않는다.**

목적 한 문장: 엔진(프로젝트 · 클론 · 게이트 · 브랜치 · 오버레이 채널)은 끝났다.
남은 것은 **비개발자가 이 도구를 혼자 쓸 때 막히는 자리**다 — 잘못돼도 돌릴 수
없고, Claude가 무엇을 하는지 안 보이고, 화면에 영어와 도구 이름이 새고, 스테퍼는
README에는 있는데 코드에는 없다.

## 0. 진단 — 2026-09-10, 코드와 스크린샷으로 확인한 것

빌드 뒤 오프라인 브라우저 스위트 넷(`settings · publish-ui · onboarding-ui ·
sidebar-ui`)을 돌려 얻은 스크린샷과 소스 기준. 실 Claude 턴(`test:daemon ·
test:planner`)은 구독 사용량을 쓰므로 돌리지 않았다 — 그 구간(권한 카드 · 진행
표시 · 오류 턴)은 코드 기준이다.

**끝난 것.** 앞 판 D1–D34는 33/34 완료(§9). 사이드바 · 게이트 넷 · `~/.cds-design`
· 프로젝트 피커 · 전환 직렬화 · OS 알림(데스크톱) · ⌘K 팔레트(`Palette.tsx`:
대화 · 프로젝트 · 명령 셋) · 대화 이름 바꾸기(`SessionTabs.tsx:74-88`) ·
고정 자동 스크롤 + `맨 아래로` 필(`ChatColumn.tsx:29-57,130-139`) · 사용량 칩의
남은 시간(`Composer.tsx:108-118`).

**README가 코드보다 앞서 있는 것.** README §지금 담긴 것 첫 항목은 스테퍼를
말한다. 코드에 스테퍼는 없다 — `stepper` 는 주석에만 있고(`protocol:393,578`,
`repo.ts:323,464,591,1046`, `server.ts:178`), 실제로는 상태 칩 하나(`변경 있음 ·
넘김 · 반영됨 · 화면 대기 중`, `ScreenPanel.tsx:341-348`)와 상단 바의 버튼 넷(최신화
· 넘기기 전 점검 · 저장 · 개발자에게 넘기기, `:350-394`)이다. `ui-proposal.html`
(커밋된 목업)이 목표 모양이다: 미리보기 열 **아래** 5단계 레일 + 판정 근거 한 줄 +
주 버튼 하나.

**기획자가 막히는 자리 — 코드로 확인한 열 가지.**

1. **실패한 턴이 아무것도 안 보인다.** `components.tsx:432-433` `case "turn": return null`.
   오류로 끝난 턴 뒤는 그냥 빈 자리다. 컴포저는 전송 확인 전에 입력을 지운다
   (`Composer.tsx:652-653`) — 실패하면 문장도 사라진다.
2. **영어가 선을 넘는다.** `"connection lost"`(`daemon-client.ts:428`),
   `"not connected"`(`:576`), `Earlier context was compacted (…)`(`:213`),
   `${event.error} 오류로 잠시 멈췄습니다`에 `overloaded`류 원어(`:196`),
   `Permission denied for <tool>`(`translate.ts:89`), `실패 (exit <HTTP 상태>)`
   (`github.ts:559`, `repo.ts:1294`).
3. **도구 이름이 그대로다.** `Bash · Write · Edit · Read`가 도구 행(`components.tsx:68`)과
   권한 카드 제목 `<toolName> 실행을 허용할까요?`(`:459-460`)에 뜨고, 헤드라인은
   셸 명령이나 파일 경로 원문이다(`:36-44`). 핀 요약은 React 컴포넌트명을 그대로
   보인다(`ScreenPanel.tsx:447`).
4. **되돌리기가 없다.** 프로토콜에 `repo.history · restore · discard · summarize ·
   checkpoint` 가 없다(`protocol/src/index.ts:54-317`). 화면을 망치면 전부 버리는
   길도 없다. 대화 삭제는 영구이고 확인은 설정으로 끌 수 있다(`useSessions.ts:264-266`).
5. **저장 검토가 git diff 원문이다.** `DiffPanel.tsx:96-120` 파일 경로 + 헝크,
   게이트 실패는 터미널 출력 그대로(`:140-144`), 저장 메모는 커밋 메시지다.
6. **미리보기 오류를 도구가 모른다.** 엔벨로프는 `comments · screens · screens? ·
   navigate` 넷(`protocol:624-680`). 앱 안의 런타임/빌드 오류(Next.js 빨간 오버레이)는
   프레임 안에서 기획자 혼자 본다. 서버가 죽었을 때만 `미리보기 서버 중단 · 다시
   시작`(`Preview.tsx:165-176`). 오류 분류는 detail 문자열 부분 일치로 한다
   (`ScreenPanel.tsx:63-73`) — 데몬 문구가 바뀌면 조용히 깨진다.
7. **진행이 안 보인다.** 긴 턴은 스피너와 `생각 중…`뿐. Claude Code가 `TodoWrite`로
   내는 할 일 목록은 그리지 않고 `/todos` 는 숨김(`Composer.tsx:299`).
8. **배경 스레드의 확인 카드가 조용하다.** 권한·질문 카드는 활성 탭에만 그려지고
   (`ChatColumn.tsx:27`), 브라우저 경로에는 알림이 없다(`server.ts:126-129`).
   데스크톱만 OS 알림(`main.ts:117-125`).
9. **새 창이 주소를 흘린다.** `<a href={url} target="_blank">`(`Preview.tsx:305-308`)
   — hover 와 상태 표시줄에 `http://127.0.0.1:<port>` 가 뜬다(`repo.ts:1358`, 토큰은
   없다 — 자격 증명 문제가 아니라 앞 판 D13 이 지우기로 한 개발자 문자열이다).
10. **"데몬"이 설정에 다시 들어왔다.** `SettingsDialog.tsx:361,391,456,463,520`.
    앞 판의 수용 조건(문제 해결 밖 0건)이 깨진 상태다. 칩 셋은 라벨 문형이 셋이다
    (`자동 · 생각 시간 · 물어보고 진행`, `Composer.tsx:897-956`) — 값 · 분류명 ·
    문장이 한 줄에 섞여 있다.

**계획에 없던 구멍.** 화면 선언이 0개일 때 문장이 없다(선택기가 숨겨질 뿐,
`Preview.tsx:192-201`). 미리보기 새로 고침 버튼이 없다. 컴포저 초안은 `sessionStorage`
라 창이 닫히면 사라진다(`Composer.tsx:393-401`). 빠른 동작 칩이 없다. 화면 캡처가
없다(README 가 v1 범위 밖으로 선언).

**길이 셋이다.** 어디로 갈지를 정하는 표면이 사이드바(프로젝트) · 채팅 열 위 탭 줄
(대화, `SessionTabs.tsx`) · ⌘K 팔레트(둘 다) 셋으로 갈라져 있다. 탭은 제목을 자르고
여덟 개를 넘으면 넘치며, 다른 프로젝트의 대화는 어디에도 없다 — `session.list` 가
활성 cwd 만 읽고(`server.ts:745-746`) 비활성 프로젝트의 세션은 행 배지 `작업 중`
한 단어로만 존재한다(`Sidebar.tsx:270`). 기획자가 아는 채팅 도구(ChatGPT · Claude ·
Slack)는 전부 왼쪽 목록이다; 탭은 브라우저 · IDE 의 은유다.

**목업.** `ui-proposal.html` 은 이 문서와 함께 v2 로 고쳤다 — 사이드바 트리(D59),
스테퍼가 주 버튼을 갖는 상단 바(D44), 한국어 상태 칩, 주소 없는 프레임 머리(D40 ·
D47), 할 일 카드(D48) · 캡처 카드(D56) · 실패 카드(D35) · 오류 배너(D49) · 빠른 동작
(D55). 상태는 키로 본다: `T` 테마 · `R` 작업 중 · `E` 미리보기 오류 · `F` 실패 턴.
1280 · 1440 두 폭, 두 테마에서 겹침 없이 렌더링되는 것을 확인했다.

**소유자 결정 10개 — 2026-09-11 에 추천대로 확정.** 이 문서의 기본값은 그 결과다.

| # | 물음 | 확정 |
|---|---|---|
| 1 | 대화를 탭에서 트리로 | 트리(D59) |
| 2 | 스테퍼 단계 수 | 다섯; 관찰에서 `저장` 을 따로 부르지 않으면 넷(D44) |
| 3 | 컴포저 칩 | 셋 다 보이되 값으로, 모델 칩 라벨은 `자동`(D42) |
| 4 | 저장 요약 | Claude 한 번 + 캐시 + 폴백; 턴 끝 요약이 있으면 그것을 먼저(D51) |
| 5 | 되돌리기 정책 | 새 커밋 원칙 · 체크포인트 20개 · `변경 버리기` 는 숨김(D52 · D53) |
| 6 | 대화 삭제 | 보관(D54) |
| 7 | 캡처를 PR 브랜치에 | 커밋, 레포가 `cds-design.json#shots: false` 로 거부 가능(D56) — 개발자 팀 확인은 아래 행동 3 |
| 8 | 코멘트 기록 위치 | 로컬 `comments.json`(D57) |
| 9 | Claude 가 화면을 본다 | 기본 켬 · 12장 상한 · 설정 토글(D61); Claude 뷰만 먼저, 기획자 뷰 교체(D60 · D62)는 보류; PiP 기본 켬(D63) |
| 10 | 순서 | 0 → 1 → 2 → 3 되돌리기 → 관찰 → 4 진행 → 5 Claude → 6 첨부 → 7 검증 |

**소유자 행동 4개(코드가 아니다).**
- [ ] Anthropic 담당자 서면 확인(README §정책) — 롤아웃 차단. 이 판이 새로 만드는 확인 항목은 없다
- [ ] 관찰 참가자 섭외: 기획자 1명, 만든 사람 · 데모 본 사람 제외, 40분 — 3단계 끝에
- [ ] 개발자 팀에 묻기: PR 브랜치에 `.cds-design/shots/*.png`(PR당 3~5MB) 를 넣어도 되는가 — 답이 "아니오"면 D56 기본을 `shots: false` 로
- [ ] `reference-repo/` 재클론 권한 · CI 클론 스텝(0단계)

## 1. 결정 — 말과 실패 (한국어 하나, 실패는 항상 보인다)

| # | 항목 | 결정 |
|---|---|---|
| D35 | 실패한 턴은 카드다 | `turn` 블록이 `isError` 거나 중단이면 카드: 제목 `답을 마치지 못했습니다`(중단: `멈췄습니다`), 이유 한 줄(D36 사전), 버튼 `다시 보내기`(마지막 사용자 턴 재전송) · `자세히`(원문). 컴포저는 **`session.send` 가 돌아온 뒤** 비운다 — 실패하면 문장과 첨부가 그 자리에 남는다 |
| D36 | 영어는 선을 넘지 않는다 | 기획자 표면의 모든 문장은 한국어다. `daemon-client.ts` 의 `connection lost` → `연결이 끊어졌습니다 — 다시 연결하는 중`, `not connected` → `아직 연결되지 않았습니다`, compact 알림 → `길어진 대화를 정리했습니다`. 재시도 알림의 `${event.error}` 는 **사전**으로: `overloaded` → `Claude가 붐빕니다`, `rate_limit` → 지금 문장, `api_error`·그 밖 → `잠시 문제가 있었습니다`. 원문 id 는 `자세히`. `translate.ts:89` → `<동작 이름>은 허용되지 않았습니다`. `github.ts:559`·`repo.ts:1294` 의 `(exit N)` 은 `자세히` 접힘으로, 첫 줄은 라벨만 |
| D37 | 도구 이름은 동작 이름이다 | 사전 하나(`packages/web/src/tool-names.ts`, 순수): `Bash` → `명령 실행`, `Read` → `파일 읽기`, `Write` → `파일 만들기`, `Edit`/`MultiEdit` → `파일 고치기`, `Glob`/`Grep` → `파일 찾기`, `WebFetch`/`WebSearch` → `웹 읽기`, `TodoWrite` → `할 일 정리`, 모르는 이름 → 그대로. `Bash` 명령이 `cds-design.json` 의 `install · check · build · preview.command` 값과 같으면 헤드라인은 `검사 실행` 처럼 그 키 이름이다. 권한 카드 제목 `<동작 이름>을 허용할까요?`, 원문 명령·경로는 `자세히` |
| D38 | 핀은 요소의 말로 | 핀 요약 행은 `element.text`, 비어 있으면 `화면의 요소`. 컴포넌트명·CSS 경로는 카드의 `자세히`(코멘트 턴 카드가 이미 그렇게 한다, `ScreenPanel.tsx:469`) |
| D39 | "데몬"은 문제 해결 밖에서 0건 | 설정 → GitHub · 연결 레포 그룹의 다섯 문장을 바꾼다: `데몬에만 저장` → `이 컴퓨터에만 저장`, `데몬에 연결된 뒤` → `연결된 뒤`. 예외는 둘: 문제 해결 접힘 안(고장 났을 때 개발자가 읽는 자리)과 `App.tsx` 브라우저 연결 화면(데스크톱에는 없다). 수용은 `grep -n "데몬" packages/web/src/*.tsx` 가 그 두 자리 밖에서 0건 |
| D40 | 새 창은 주소를 흘리지 않는다 | `새 창` 은 `<a>` 가 아니라 버튼 → `window.open(url, "_blank", "noopener")`. 상태 표시줄 · hover · 우클릭 복사에 주소가 없다. 주소 자체는 `http://127.0.0.1:<port>` 로 토큰이 없으니(`repo.ts:1358`) 데몬 쪽 변경은 없다 |
| D41 | 오류 분류는 데몬이 한다 | `RepoStatus.errorKind: "clone" \| "install" \| "registry-auth" \| "pnpm-missing" \| "preview" \| "conflict" \| null`. 웹의 `classifyError` 부분 일치(`ScreenPanel.tsx:63-73`) 삭제. 문구는 바뀌어도 분기는 안 바뀐다 |
| D42 | 칩은 값을 말한다 | 컴포저 칩 셋은 **현재 값**만: `자동 · 보통 · 물어보고 진행`(분류명 `모델 · 생각 시간 · 확인 방식` 은 툴팁). 모델 칩 라벨은 `자동` 이면 `자동`, 골랐으면 짧은 이름(`Opus`); 정식 모델 id 는 툴팁. 칩은 보인다 — 앞 판 D10 의 "기본과 다를 때만 `⋯`" 은 폐기한다(목업이 보이게 그렸고, 값이 보이는 편이 "왜 느리지"를 줄인다). `전부 맡기기` 는 여전히 설정에서만 |
| D43 | 초안은 살아남는다 | 컴포저 초안·첨부 메타는 `localStorage`(`cds-design.draft.<sessionId>`). 첨부 바이트는 지금처럼 메모리 — 다시 열면 `첨부 N개는 다시 붙여 주세요` 한 줄 |

## 2. 결정 — 구조: 스테퍼 · 대화 트리 (README를 참으로 만든다)

| # | 항목 | 결정 |
|---|---|---|
| D44 | 스테퍼는 미리보기 열 아래에 있다 | `ui-proposal.html` 의 `.stepper` 그대로. 다섯 단계 `화면 만들기 ─ 검토·수정 ─ 저장 ─ 넘기기 ─ 반영됨`, 아래 `stepper__why` 한 줄 + 주 버튼 하나(보조 `넘기기 전 점검` 은 그 옆). 상단 바에는 상태 칩 · `최신화` · `더 보기 ▾` 만 남고 저장 · 넘기기는 스테퍼로 내려간다(항상 필요한 것은 `더 보기 ▾` 에 전부). 프레임 머리(`.frame__chrome`)가 화면 이름 · 상태 · 폭 토글 · 새로 고침 · 새 창을 갖는다 — 화면 단위 조작(어느 화면 · 어느 상태 · 코멘트)은 툴바, 프레임 단위 조작(폭 · 새로 고침 · 새 창)은 프레임 머리 |
| D45 | 판정은 순수 함수 하나 | `packages/web/src/stage.ts#deriveStage({ screens, pendingChanges, branch, handoff, running, phase })` → `{ step, primary, why }`. 사이드바 행 표식(`Sidebar.tsx:268-274`)도 같은 함수의 `step` 을 읽는다 — 행과 스테퍼가 어긋날 길을 없앤다 |

| 단계 | 판정(전부 기계적) | 주 버튼 | why |
|---|---|---|---|
| 화면 만들기 | `screens` 비었고 `pendingChanges = 0`, 브랜치 없음 | `새 대화` (컴포저 포커스) | `기획서를 첨부하고 화면을 시켜 보세요.` |
| 검토·수정 | `pendingChanges > 0` (running 이면 버튼 비활성 `작업 중…`) | `저장` | `저장하지 않은 변경 N건 — 미리보기에서 검토하고 저장하면 이 사이클의 브랜치에 올라갑니다.` 보조: `넘기기 전 점검` |
| 저장 | 브랜치 있음, `pendingChanges = 0`, 넘김 아님 | `개발자에게 넘기기` | `저장한 것을 개발자가 볼 수 있게 보냅니다.` |
| 넘기기 | `handoff.state ∈ {open, changes_requested}` | `상태 다시 확인` | `개발자가 보고 있습니다` / `변경 요청이 왔습니다 — 대화에서 이어 가세요` |
| 반영됨 | `handoff.state = merged` | 없음(칩) | `개발자가 받아 갔습니다. 다음 저장은 새 사이클을 시작합니다.` |

- 경계: 넘김 뒤 새 변경 → `검토·수정` 으로 돌아온다(같은 PR 에 쌓인다는 문장 추가).
  `phase !== "ready"` 면 스테퍼 대신 지금의 `ProgressPanel`.
- 1280px 에서 다섯 단계가 한 줄이어야 한다(목업 기준). 1100 미만은 라벨을 숨기고
  번호만.

```
┌ 미리보기 열 ─────────────────────────────────────────────────────────┐
│ ● 변경 있음 3                                  ⟳ 최신화   더 보기 ▾ │
│ 결제 / PayFailed ▾   [기본][비어 있음][오류]                 💬 코멘트 │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │                        (레포의 앱 그대로)                          │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ✓ 화면 만들기 ── ② 검토·수정 ── 3 저장 ── 4 넘기기 ── 5 반영됨      │
│ 저장하지 않은 변경 3건 — 미리보기에서 검토하고 저장하면 …    [ 저장 ] │
└──────────────────────────────────────────────────────────────────────┘
```

| # | 항목 | 결정 |
|---|---|---|
| D46 | 화면 선언이 없을 때 | 선택기 자리에 문장 `이 레포는 아직 화면을 선언하지 않았습니다 — 첫 화면을 만들면 여기에 목록이 생깁니다.` 숨기지 않는다 |
| D47 | 새로 고침 · 태블릿 | 프레임 머리에 `새로 고침`(iframe `src` 재설정 + `navigate` 재전송). 폭 토글에 `태블릿(768)` 추가 — 값은 이름으로만, 구현은 지금처럼 CSS 폭. 진짜 장치 에뮬레이션은 D62(보류)가 열릴 때 |
| D59 | 대화는 사이드바 트리에 있다 | 채팅 열 위의 탭 줄(`SessionTabs.tsx`)을 없애고, 사이드바의 프로젝트 행이 펼쳐져 그 프로젝트의 대화를 자식으로 보인다(`ui-proposal.html` 의 `.tree` · `.node` · `.leaf`). 채팅 열 머리는 `이 대화` 한 줄(`.thread`): 제목(더블클릭 · F2 이름 바꾸기) · 이 대화가 만든 화면 칩(누르면 미리보기 이동) · `···`. 규칙 다섯: (1) **다른 프로젝트의 대화도 보인다** — 누르면 그 프로젝트가 활성이 되고 대화가 열린다(`project.activate` → `session.create { resume }`, 한 번의 클릭; 미리보기 칸은 지금처럼 `켜는 중 → ready`). (2) 자식 행 표식은 대화의 상태다: `작업 중`(스피너) · `확인 대기`(D50, 주황) · `답이 왔습니다`(고리) · 시각. 프로젝트 행 배지는 그 자식들의 합(D45 의 `step` 과 D15 우선순위 그대로). (3) 프로젝트마다 접기, 최근 5개 + `보관된 대화 N`(D54) — 그 너머는 팔레트. (4) 1100 미만 아이콘 레일에서는 프로젝트 아이콘 클릭이 그 프로젝트의 대화 팝오버를 연다. (5) `+ 새 대화` 는 프로젝트 행 hover 의 `＋` 와 `···` 메뉴, 팔레트 명령. 데몬: `ProjectSummary.threads: { id; title; state: "running" \| "awaiting" \| "finished" \| "idle"; updatedAt }[]` — `manager.list(cwd)` 를 프로젝트별로 캐시하고 세션 이벤트(생성 · 이름 · 상태 · 삭제)에만 다시 읽어 `project.changed` 로 내보낸다(200ms 스로틀은 그대로). 제목은 데몬의 것 위에 웹의 `settings.sessionTitles` 덮어쓰기(이름 바꾸기는 지금처럼 클라이언트). `session.list` · `session.send` 의 활성 스코프는 유지 — 트리는 요약만 읽고, 열 때 활성화가 먼저다. 이 결정으로 없어지는 것: `SessionTabs.tsx`, 탭의 `finished` 점(자식 행으로), `Palette` 의 `대화` 그룹이 활성 프로젝트만 보이던 제한 |

```
┌ 사이드바 ─────────────────┐  왜 트리인가 — 탭과 비교
│ 프로젝트                 │  · 길이 하나: 프로젝트 · 대화 · 팔레트가 같은 목록을 본다
│ ▾ ● payments-web  변경 3 │  · 제목이 잘리지 않고, 여덟 개를 넘어도 넘치지 않는다
│     ● 결제 실패 화면  방금 │  · 다른 프로젝트에서 도는 턴 · 확인 대기가 행으로 보인다
│     ● 회원 가입 화면 확인 대기│  · 기획자의 은유(ChatGPT · Claude · Slack) — 탭은 IDE 것
│     ○ 주문 내역 목록  2일 전│  비용
│       보관된 대화 4       │  · 다른 프로젝트의 대화를 누르면 미리보기 서버가 바뀐다
│ ▾ ◌ member-admin  작업 중 │    (행 툴팁과 `켜는 중` 으로 말한다; 세션은 죽지 않는다)
│     ◌ 회원 탈퇴 화면 작업 중│  · 사이드바 200px 에서 두 단계 들여쓰기 — 자식은 13px 선 하나
│ ▸   design-system  반영됨 │  · 레일 모드(1100 미만)에 팝오버가 하나 더 생긴다
└──────────────────────────┘
```

## 3. 결정 — 진행이 보인다

| # | 항목 | 결정 |
|---|---|---|
| D48 | 할 일 카드 | `TodoWrite` 도구 블록을 접힌 도구 행이 아니라 **카드**로: 제목 `진행 N/M`, 항목마다 `✓ · ● · ○`, 현재 항목 굵게. 같은 턴의 다음 `TodoWrite` 는 카드를 갱신한다(새 카드 아님). 턴이 끝나면 접힌 한 줄 `할 일 M개 끝` |
| D49 | 미리보기 오류는 도구가 받는다 | 오버레이 엔벨로프 다섯째 `cds-design.error { type, kind: "runtime" \| "build", message, route, state }` — 참조 레포의 preview-bridge 가 `window.onerror` · `unhandledrejection` · Next dev overlay 감지에서 보낸다(참조 레포 변경은 커밋까지가 한 작업). 데스크톱 · 브라우저 경로 둘 다 이 길이다(기획자 뷰 이벤트로 받는 것은 D62 보류). 도구는 프레임 위 배너 `화면에 오류가 났습니다` + `Claude에게 고쳐 달라고 하기` + `자세히`(message). 버튼은 마커 `error` 턴을 보낸다(`<!-- cds-design:error {"route","state","kind"} -->` + message; 카드 제목 `화면 오류 고치기`). 서버 중단 상태(`Preview.tsx:165-176`)에도 같은 버튼 — 그때 본문은 `stoppedDetail` |
| D50 | 배경 스레드도 부른다 | 확인 대기(권한 · 질문)인 대화는 트리 자식 행에 `확인 대기` 표식(D59, 주황 점 — `답이 왔습니다` 고리와 다른 모양) + 프로젝트 행 배지 우선순위에 `확인 대기` 를 `작업 중` 앞에. 브라우저 경로는 `Notification` API — 첫 턴이 끝난 뒤 한 번 권한을 묻고, 문구는 데스크톱 `notices.ts` 와 같은 파일에서(`protocol` 로 옮겨 둘이 한 벌) |

```
│ ┌ 진행 3/5 ────────────────────────────────────┐ │
│ │ ✓ 기획서 읽기                                  │ │
│ │ ✓ PayFailed 화면 뼈대                          │ │
│ │ ● 비어 있음 · 오류 상태 추가                    │ │
│ │ ○ 검사 실행                                    │ │
│ │ ○ 미리보기 확인                                │ │
│ └──────────────────────────────────────────────┘ │
```

## 4. 결정 — 되돌릴 수 있다

| # | 항목 | 결정 |
|---|---|---|
| D51 | 저장은 요약으로 읽는다 | `DiffPanel` → `SaveReview`. 위에서 아래로 요약 목록 → 저장 메모(요약 첫 줄로 자동 채움, 고칠 수 있다) → `자세히 보기`(지금의 파일 · 헝크). 요약의 출처 셋, 순서대로: (1) 이번 저장에 들어갈 화면 턴들이 끝에 남긴 `<!-- cds-design:summary -->` 줄(참조 레포 `CLAUDE.md` 가 "턴 끝에 바뀐 것 한 줄" 을 요구; 있으면 호출 없이 쓴다) → (2) `repo.summarize`: 데몬이 SDK `query` 를 한 턴(`maxTurns: 1`, 도구 없음)으로 돌려 diff(파일별 헝크, 4KB 상한)와 화면 목록을 주고 "바뀐 화면과 바뀐 점을 기획자 말로 3줄 이내, 파일 이름 없이" — 저장 검토를 **열 때 한 번**, diff 해시로 캐시 → (3) 폴백(3초 초과 · 실패 · 한도): 경로 둘째 폴더로 묶어 `member: 수정 2 · 추가 1` — 문자열을 자르는 것이지 레포 규약을 읽는 것이 아니다. 화면에 `요약은 Claude가 썼습니다` 한 줄. 게이트 실패 원문(`DiffPanel.tsx:140-144`)도 `자세히` 로 |
| D52 | 되돌리기의 단위는 답변이다 | 화면 턴이 **시작할 때마다** 데몬이 워크트리를 스냅샷한다: 임시 인덱스(`GIT_INDEX_FILE=<tmp>`)에 `git add -A` → `git write-tree` → `git commit-tree`(부모 HEAD) → `git update-ref refs/cds-design/checkpoints/<sessionId>/<n>`. 추적 안 된 **새 화면 파일도 담긴다**(첫 저장 전의 새 파일은 전부 untracked 라 `stash create` 로는 안 된다). HEAD · 실제 인덱스 · 워크트리 불변. 각 어시스턴트 턴 카드 하단에 `이 답변 이전으로 되돌리기` — `repo.checkpoint.restore { id }` 가 그 트리로 워크트리를 되돌린다: `git diff --name-status <tree>` 로 목록을 만들고, 쓰기 정책 허용 경로만 `checkout <tree> -- <paths>`, 스냅샷에 없던 파일은 삭제. 턴이 도는 중이면 비활성. 세션당 최근 20개, 반영됨(머지)에서 그 사이클의 ref 를 지운다 |
| D53 | 저장 기록과 되돌리기 | `repo.history`: `git log <base>..HEAD` → `{ sha, message, at, files }`. `repo.restore { sha }`: 그 시점의 트리를 **새 커밋**으로(`git checkout <sha> -- . && git commit -m "되돌리기: <원 메시지>"` → push). reset · revert · force-push 없음 — 개발자가 그 PR 을 보고 있을 수 있다. 워크트리에 저장 안 한 변경이 있으면 거부: `먼저 저장하거나 되돌려 주세요`. `repo.discard`: 저장 안 한 변경 버리기(허용 경로만, 확인 대화상자, 되돌릴 수 없다고 명시) — D52 가 있으니 주 경로가 아니라 `더 보기 ▾` 안. UI: `더 보기 ▾` → `저장 기록` 드로어, 항목마다 메시지 · 시각 · `이 시점으로 되돌리기`. 단어는 `저장 기록 · 되돌리기 · 변경 버리기` — 커밋 · 리셋은 나오지 않는다 |
| D54 | 대화는 보관한다 | 트리 자식 행의 `···` → `보관`(삭제가 아니다): `settings.archivedSessions[project]` 에 id 를 넣고 목록에서 숨긴다(SDK 대화록은 그대로). 프로젝트 자식 끝의 `보관된 대화 N` 과 팔레트 `대화` 그룹에서 되살리기 · 영구 삭제. `window.confirm` 과 `confirmBeforeDelete` 설정은 없어진다 |

```
┌ 저장 검토 ─────────────────────────────────────────────── ✕ ┐
│ 바뀐 것                                                     │
│  · 결제 실패 화면에 비어 있음 · 오류 상태를 추가했습니다     │
│  · 다시 시도 버튼이 결제 수단 선택으로 이어집니다             │
│  · 결제 실패 화면의 목 데이터에 승인 거절 사유를 넣었습니다   │
│  요약은 Claude가 썼습니다                                    │
│ 저장 메모  [결제 실패 화면에 비어 있음 · 오류 상태 추가     ] │
│ ▸ 자세히 보기 (파일 4개)                                      │
│                                          [ 그만두기 ] [ 저장 ] │
└──────────────────────────────────────────────────────────────┘
```

## 5. 결정 — 첨부 · 캡처 · 코멘트

| # | 항목 | 결정 |
|---|---|---|
| D55 | 빠른 동작 칩 | 컴포저 위, 대화가 비었거나 마지막 턴이 끝났을 때: `빈 상태 추가 · 로딩 상태 추가 · 오류 상태 추가 · 기획서와 대조 · 이 화면 설명해 줘`. 클릭 = 문장 삽입, 자동 전송 없음. 목록은 도구 상수; `cds-design.json#quickActions: string[]` 이 있으면 뒤에 붙인다(`hello.status.quickActions`). 도구가 레포 코드를 읽는 것이 아니라 레포가 도구에 말하는 것이다 |
| D56 | 화면은 캡처로 남는다 | 데스크톱만(D61 드라이버가 있을 때): 화면 턴이 끝나면 Claude 드라이버가 현재 화면 · 상태를 한 장 찍어 답변 아래 카드(전 · 후 — 직전 캡처가 있으면 둘 나란히). Claude 가 D61 로 직접 찍은 스크린샷도 같은 카드다(`Claude가 본 화면` 태그). 넘기기 때 선언된 화면 × 상태마다 드라이버로 캡처해 브랜치에 `.cds-design/shots/<route>--<state>.png` 로 커밋하고 PR 본문이 링크한다 — 개발자가 앱을 띄우기 전에 읽는다. 레포는 `cds-design.json#shots: false` 로 거부할 수 있다(그러면 카드만, 커밋 없음). 드라이버가 없는 브라우저 경로는 카드 없음(기능 부재를 말하지 않는다). README v1 의 "스크린샷은 범위 밖" 문장을 이 결정이 대신한다 |
| D57 | 코멘트는 해결될 때까지 남는다 | 핀 봉투는 지금처럼 한 통이지만 도구가 항목을 `projects/<slug>/comments.json` 에 적는다(`{ id, screen, state, text, element.text, at, resolved }`). 화면별 코멘트 목록(툴바 `💬 코멘트` 팝오버): 미해결 · 해결 토글, `다시 보내기`. 턴이 끝나면 핀은 사라지되 목록은 남는다. 스테퍼 why 에 `미해결 코멘트 N` |
| D58 | 코멘트 모드는 툴바에 있다 | 목업의 `💬 코멘트` 토글. 엔벨로프 `cds-design.comments.mode { on }` 을 오버레이로 보내고 오버레이가 모드를 켠다. 오버레이 안의 자기 토글은 남는다(둘이 같은 상태를 본다) |

## 6. 결정 — 내장 브라우저 (Claude 도 화면을 본다)

가능한가 — 그렇다, 새 의존성 없이. 데스크톱은 이미 Chromium(Electron 44)이다:
오프스크린 `BrowserWindow` · `webContents.debugger`(CDP) · `capturePage` 가 문서화된
API 다. Claude 쪽은 Agent SDK 가 세션 옵션 `mcpServers` 에 **인프로세스** 서버를
받는다(`createSdkMcpServer` + `tool`, `sdk.d.ts:59,511,1802,8590`) — 지금
`session.ts:217-250` 의 `query` 옵션에는 하나도 없다. 데스크톱은 `new DaemonServer({…})`
로 데몬을 안고 있어(`main.ts:53`) 드라이버를 옵션 하나로 넘길 수 있다. Cursor ·
Windsurf 의 에이전트 브라우저, Replit Agent 의 자기 앱 검증, Claude Code 자체의 Chrome
확장이 같은 모양이다. 우리 것은 범위가 좁아 더 쉽다: 볼 곳이 미리보기 서버 하나다.

**이 판에 들어가는 것은 Claude 의 뷰(D61 · D63)다.** 기획자의 미리보기를 iframe 에서
네이티브 뷰로 바꾸는 것(D60 · D62)은 **보류** — D61 이 D60 없이 성립하고(Claude 는
자기 뷰만 쓴다, 캡처도 거기서 찍는다), D60 은 z-order 규칙과 데스크톱/브라우저 경로
분기를 새로 들인다. iframe 이 실제로 불편해질 때(진짜 모바일 에뮬레이션 · 레포 훅 없는
오류 배너가 필요할 때) 연다.

| # | 항목 | 결정 |
|---|---|---|
| D60 | 미리보기를 앱의 브라우저 뷰로 — **보류** | 열 때의 설계: `WebContentsView` — `session.fromPartition("preview")`, `contextIsolation` · `sandbox`, `preload: preview-preload.js`. 렌더러가 rect 를 IPC 로, 메인이 `setBounds`(드래그 중 rAF); 모달 · 팝오버가 열리면 `preview:cover` 로 숨긴다 — 뷰는 항상 DOM 위에 있으므로 이것이 유일한 z-order 규칙. 오버레이 채널은 `preview-preload` 의 `window.cdsDesign.post` → IPC; 참조 레포 오버레이는 `(window.cdsDesign?.post ?? (e) => parent.postMessage(e, "*"))` 한 줄. 웹은 `PreviewHost` 하나에 `NativeHost` · `IframeHost` 둘. 선로 변경 없음. Electron `<webview>` 태그는 쓰지 않는다 |
| D61 | Claude 가 화면을 본다 | 데몬이 화면 세션의 `mcpServers` 에 인프로세스 서버 `cds-preview` 를 단다. 도구 여섯: `screen_list`(레포가 선언한 화면 · 상태 — 오버레이 엔벨로프 캐시) · `screen_open { route, state }` · `screen_screenshot`(JPEG q70, 긴 변 900px) · `screen_read`(CDP `Accessibility.getFullAXTree` 를 텍스트 개요로 — 스크린샷보다 훨씬 싸다; 도구 설명이 이것을 먼저 쓰라고 말한다) · `screen_click { text \| selector }` · `screen_console`(마지막 이동 이후 error · warn). 구동은 Claude 전용 **숨은 오프스크린 `BrowserWindow`**(`show: false`, `webPreferences.offscreen: true` — 문서화된 경로)에 `webContents.debugger` 로 CDP. 같은 dev 서버, 다른 창 — 기획자가 보는 iframe 은 그대로고, Claude 가 클릭으로 바꾼 상태는 거기 남지 않는다. 데몬은 Electron 을 import 하지 않는다: `DaemonServer` 옵션 `previewDriver?: PreviewDriver`(`open · screenshot · axTree · click · console · destroy`) 를 데스크톱 부트가 넘기고, 브라우저 개발 경로는 없음 → 서버 미등록. `canUse` 는 `mcp__cds-preview__*` 를 조용히 허용(미리보기만 만지는 읽기 도구). **기본 켬**, 설정 → 대화에 `Claude가 화면을 직접 확인` 토글. 상한: 턴당 스크린샷 12장 — 넘으면 도구가 `이 턴의 캡처 한도에 닿았습니다` 를 돌려주고 턴은 계속된다. 턴이 끝나면 창을 destroy. 참조 레포 `CLAUDE.md` 한 줄: "화면을 만들거나 고친 뒤, 볼 수 있으면 선언한 상태를 각각 한 번 열어 보고 콘솔 오류를 고친 뒤 끝낸다." |
| D62 | 오류 · 캡처 · 폭을 기획자 뷰에서 — **보류(D60 과 함께)** | 열 때: `console-message`(error) → D49 배너(레포 훅 없이), `capturePage()` → D56, 폭 토글 → `enableDeviceEmulation` + 모바일 UA. 그때까지 D49 는 오버레이 훅, D47 은 CSS 폭, D56 은 Claude 뷰의 캡처다 |
| D63 | Claude 시점 보기 | Claude 창이 움직이는 동안 무대 구석에 PiP 썸네일(오프스크린 `paint` 이벤트를 8fps · JPEG 로 브리지 IPC), 라벨 `Claude가 보는 중 · <화면> · <상태>`. 클릭하면 크게(기획자 iframe 위에 겹침), 턴이 끝나면 접힌다. **기본 켬**, 설정에서 끔. Claude 가 찍은 스크린샷은 대화에 D56 카드(`Claude가 본 화면`)로 남고, `screen_read` · `screen_click` 은 활동 줄에 `화면 N곳 확인` 으로 합쳐진다(D37 사전: `screen_*` → `화면 보기`) |

```
│ 결제 / PayFailed ▾   [기본][비어 있음][오류]                 💬 코멘트 1 │
│ ┌──────────────────────────────────────────┐ ┌─ Claude가 보는 중 ──┐ │
│ │                                          │ │ 결제 실패 · 오류    │ │
│ │          (기획자 뷰 — 그대로)              │ │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │ │
│ │                                          │ └────────────────────┘ │
│ └──────────────────────────────────────────┘                        │
│ ✓ 화면 만들기 ── ② 검토·수정 ── 3 저장 ── 4 넘기기 ── 5 반영됨      │
│ Claude 가 세 상태를 확인하는 중 — 끝나면 저장할 수 있습니다   [ 작업 중… ] │
```

## 7. 프로토콜 v10

| 메시지 | 변경 |
| --- | --- |
| `repo.status` | `errorKind` 추가(D41) |
| `project.changed` · `hello.status.projects` | `ProjectSummary.threads?: { id; title; state; updatedAt }[]`(D59) — 선택 필드, 활성 스코프 메시지는 그대로 |
| `hello.status` | `quickActions?: string[]`(D55) |
| `repo.summarize` | 신규 → `{ lines: string[]; source: "claude" \| "fallback" }`(D51) |
| `repo.history` | 신규 → `{ base: string; entries: { sha; message; at; files: string[] }[] }`(D53) |
| `repo.restore` | 신규 `{ sha }` → `diff.status` 스트림 재사용(`pushing → published`) |
| `repo.discard` | 신규 → `{ removed: string[] }` |
| `repo.checkpoints` | 신규 → `{ entries: { id; sessionId; turn; at }[] }`; `repo.checkpoint.restore { id }` → `{ restored: string[] }`(D52) |
| `repo.handoff` | `shots?: { route; state; png: base64 }[]`(D56, 데스크톱만 보낸다) |
| `comments.list` · `comments.resolve` | 신규(D57) |
| 오버레이 엔벨로프 | `cds-design.error`(D49), `cds-design.comments.mode`(D58) — zod 타입을 `protocol` 에 |
| 턴 마커 | 종류 `error` 추가(D49) — `turn-marker.ts` 한 파일 |
| `session.*` | 변경 없음 — 실패 카드는 이미 오는 `turn` 이벤트의 `isError` 를 읽는다(D35) |
| 미리보기(D61 · D63) | **선로 변경 없음** — Claude 의 도구는 세션 안의 MCP, PiP 프레임은 데스크톱 브리지(IPC). 웹은 `window.cdsDesignDesktop?.preview` 의 존재로 PiP 를 켠다 |

범프는 **마지막 선로 변경이 들어가는 6단계 끝에 한 번**. 앞 판 D33 과 같은 이유 —
중간에 올리면 데스크톱 · 웹이 두 번 어긋난다. 그때까지의 추가는 전부 선택 필드 또는
v9 클라이언트가 보내지 않는 신규 메시지라 깨지지 않는다.


### 구현 상태 — 2026-09-11 (Wave D 후, D35–D63 구현 완료)

- **들어감(4판, 6단계 완료):** D56(드라이버 캡처 → `.cds-design/shots/` 커밋 + PR 본문 `### 화면 미리보기` 절, `#shots: false` 거부), D57(`comments.json` 저장소 + `comments.record/list/resolve`, 팝오버 해결 토글·다시 보내기, 스테퍼 `미해결 코멘트 N`), D58(💬 코멘트 토글 → `comments.mode` 엔벨로프), D55 잔여(`hello.status.quickActions` → 칩 병합), **프로토콜 v10 범프**.
- **검증:** typecheck 4 패키지 · build 4 · `test:unit`(22+77+26=125) · `test:onboard-unit` 26 · `test:desktop-unit` 10(+1 skip) · `test:desktop-smoke` 9 · `test:projects` 21 · `test:repo` 21 · `test:publish` **64** · `test:publish-ui` 16 · `test:settings` 25 · `test:sidebar-ui` 21 · `test:onboarding-ui` 16 · `test:onboarding` 14 — 전부 통과.
- **남음:** 관찰(기획자 1명), 7단계 실 Claude 스위트 둘(`test:daemon`·`test:planner` — 구독 사용량), comments-ui(reference-repo 재클론 대기 — GitHub 주소 필요), 패키징 앱에서 shots 캡처 실동작 확인(desktop-smoke 몫).
- **구현 완료 선언:** D35–D63 전부. 이 문서의 남은 의무는 관찰 기록 반영과 7단계 뒤 삭제뿐이다.
- **알려진 경계:** (1) `screen_list` 는 오버레이 브리지가 화면 선언을 넘겨주기 전까지 빈 목록(주석 문서화). (2) 오프스크린 입력·콘솔 다리는 유닛에서 불안정 — desktop-smoke(pack 앱)에서 재확인 항목. (3) PiP 프레임은 데스크톱 전용 — 브라우저 경로 미표시(설계대로).

## 8. 단계

순서는 소유자 결정 10(§0)을 따른다: **0 → 1 → 2 → 3(되돌리기) → 관찰 → 4 → 5 → 6 → 7.**
"잘못돼도 돌릴 수 있다"(3)가 진행 표시(4)보다 먼저다. 각 단계는 `pnpm typecheck` 가
통과하는 지점에서 끝나고 그 단계의 스위트만 돌린다. 끝나면 "설계에서 실제로 달라진
것"을 이 문서에 적는다.

### 0. 앞 판 마무리 · 번호 정리 (반나절)

- [ ] `reference-repo/` 를 GitHub 에서 다시 클론해 두고 `pnpm install` — `test:comments-ui` 가 다시 돈다(`ui-comments-e2e.mjs:107-109`). CI 에도 같은 클론 스텝(`.github/workflows`, 지금 없음)
- [ ] 낡은 주석: `protocol/src/index.ts:592`(`connected-repo/…`), `onboarding.ts:1-9`("three machine-wide gates … ends at the third gate")
- [ ] 충돌 번호에 꼬리표: 코드 주석의 `PLAN D2 · D5 · D10 · D12` 는 판마다 뜻이 다르다(§9). 그 네 번호만 `PLAN D5[넘기기]` · `PLAN D5[런타임 게이트]` 식으로 의미를 붙인다. 나머지는 §9 대응표로 읽는다
- [ ] README §지금 담긴 것 첫 항목(스테퍼)에 "(2단계에서 들어간다)" 를 달지 않는다 — 대신 2단계가 끝날 때까지 이 문서가 그 사실을 들고 있다

### 1. 말과 실패 — D35 · D36 · D37 · D38 · D39 · D40 · D41 · D42 · D43 (2~3일)

- 파일: `components.tsx`(실패 카드 · 도구 행 · 권한 카드), 신규 `tool-names.ts` · `error-words.ts`(사전 둘, 순수), `Composer.tsx`(전송 뒤 비우기 · 칩 라벨 · `localStorage` 초안), `daemon-client.ts`(문장 셋 · 사전 적용), `ScreenPanel.tsx`(핀 요약 · `classifyError` 삭제 → `errorKind`), `Preview.tsx`(새 창 버튼), `SettingsDialog.tsx`(데몬 문장 다섯), 데몬 `translate.ts:89` · `github.ts:559` · `repo.ts:1294`(첫 줄 라벨, 원문은 detail) · `repo.ts`(`errorKind` 판정 — 지금 `classifyError` 가 보던 문구의 출처에서), `protocol`(`errorKind` 선택 필드)
- 테스트: `tool-names.test.mts` · `error-words.test.mts` 신규(사전 · 모르는 값 통과 · `cds-design.json` 키 매칭); `ui-publish-e2e` — 스텁 턴을 `isError` 로 끝내고 실패 카드와 `다시 보내기` 가 보이며 컴포저 문장이 남아 있다; `ui-settings-e2e` — `데몬` 0건 단언(문제 해결 밖); `ui-comments-e2e` — 핀 요약에 컴포넌트명이 **보이지 않는다**
- 수용: 스크린샷 셋(publish · comments · settings)에서 영문 도구 이름 · `exit` · 원어 오류 id · `데몬` 이 한 글자도 없다. `grep -n "데몬" packages/web/src/*.tsx` 가 `App.tsx` 와 설정 문제 해결 접힘 밖에서 0건

### 2. 구조 — 스테퍼 · 대화 트리 — D44 · D45 · D46 · D47 · D59 (2주)

스테퍼 먼저, 트리 다음. 둘은 같은 파일(`Sidebar.tsx` · `PageWorkspace.tsx`)을 건드리므로 한 단계지만, 커밋은 둘로 나눈다.

- 스테퍼 파일: 신규 `stage.ts` · `StageBar.tsx`, `ScreenPanel.tsx`(상단 바 → 상태 칩 · 최신화 · `더 보기 ▾`; 스테퍼 마운트), `Sidebar.tsx`(표식을 `deriveStage.step` 으로), `Preview.tsx`(빈 선언 문장 · 프레임 머리: 폭 · 새로 고침 · 새 창), `styles.css`(`.stepper*` · `.frame__chrome`, 1280 한 줄 · 1100 번호만), `PageWorkspace.tsx`(주 버튼 → 기존 `saveOpen` · `handoffOpen`)
- 트리 파일: `Sidebar.tsx`(`.node` 펼침 · `.leaf` 자식 · `＋` · 접기 상태 `settings.treeFolded[slug]` · 레일 팝오버), `ChatColumn.tsx`(머리 `.thread`: 제목 · 화면 칩 · `···`), `PageWorkspace.tsx`(활성 대화 선택을 트리에서 받는다; 다른 프로젝트 자식 클릭 → `activateProject` 뒤 `attach`), `useSessions.ts`(이름 바꾸기 · 보관 훅은 유지, 탭 전용 `finished` 표식 제거), `Palette.tsx`(`대화` 그룹이 `threads` 를 읽어 전 프로젝트), **삭제** `SessionTabs.tsx`; 데몬 `server.ts`(`projectSummaries()` 에 `threads`, 세션 이벤트에서 프로젝트별 캐시 무효화 → `announceProjectsThrottled`), `session-manager.ts`(`list(cwd)` 결과 캐시 + 상태 합류), `protocol/index.ts`(`threads` 선택 필드)
- 테스트: `stage.test.mts` 신규 — 표의 5행 + 경계(넘김 뒤 새 변경 → 검토·수정, running 이면 주 버튼 비활성, `phase !== ready` 면 null); `ui-publish-e2e` · `ui-comments-e2e` 의 버튼 · 탭 셀렉터를 스테퍼 · 트리로 옮긴다(테스트 이름 유지) + "1280 스크린샷에서 다섯 단계가 한 줄"; `ui-sidebar-e2e` — 프로젝트 행 아래 대화 행, 비활성 프로젝트의 자식 클릭 → 그 프로젝트 활성 + 대화 열림 + 앞 포트 닫힘, 자식 행 `작업 중` → `답이 왔습니다`, 접기가 새로 고침을 살아남음, 960 폭 레일에서 아이콘 클릭 → 팝오버; `projects-e2e` — 스텁 세션 생성 · 이름 · 종료가 `project.changed.threads` 에 반영되고 다른 프로젝트의 `threads` 는 그대로
- 수용: 어느 시점에도 주 버튼은 하나이고 라벨이 표와 같다. 채팅 열에 탭이 없고, 사이드바에서 두 프로젝트의 대화가 동시에 보인다. README 첫 항목이 참이 되고, 프로젝트 목록 문단에 "대화가 그 아래 놓인다" 한 문장이 붙는다

### 3. 되돌리기와 요약 — D51 · D52 · D53 · D54 (2~3주)

- 파일: 데몬 `repo.ts`(`summarize` · `history` · `restore` · `discard` · `checkpoint`/`checkpointRestore` · 머지 시 ref 정리), `server.ts`, `protocol/index.ts`(신규 메시지 — 범프는 아직); 웹 신규 `SaveReview.tsx`(`DiffPanel` 대체) · `HistoryDrawer.tsx`, `components.tsx`(턴 카드 `이 답변 이전으로 되돌리기`), `useSessions.ts` · `Sidebar.tsx` · `Palette.tsx`(보관), `settings.ts`(`archivedSessions`), `daemon-client.ts`
- 테스트: `repo.test.mjs` — 폴백 묶기(경로 → 폴더), 체크포인트가 **추적 안 된 새 파일**을 담고 HEAD · 인덱스를 안 건드림, 허용 경로 밖 파일은 복원 대상이 아님; `publish-e2e` — 두 번 저장 → `history` 2건, `restore(첫 sha)` → 세 번째 커밋(`git log --oneline | wc -l` = 3), 더티에서 `restore` 거부, `discard` 는 허용 경로만, 턴 둘 → 체크포인트 둘 → 첫 것으로 복원 → 워크트리가 그 시점(새 파일은 지워지고 지운 파일은 돌아온다), 머지 뒤 ref 0개; `ui-publish-e2e` — 저장 검토 첫 화면에 `+`/`-` 줄과 파일 경로가 없고 `자세히 보기` 뒤에 있다; 자식 행 `···` → 보관 뒤 `보관된 대화 1`; `summarize` 의 Claude 경로는 `test:daemon` 한 케이스만
- 수용: 저장 검토 첫 화면에 파일 경로가 없다. 되돌리기 뒤 미리보기가 그 시점 화면을 보인다(`comments-ui` 의 실제 dev 서버로)

### 관찰 (반나절, 코드 없음) — 3단계 뒤

기획자 한 명(만든 사람 · 데모 본 사람 제외)에게 목표만 말하고 시킨다: "이 기획서로 화면을
만들어 확인해 주세요" · "두 곳을 고치고 개발자에게 넘겨 주세요" · "방금 고친 것을 되돌려
주세요". 멈춘 자리 · 물어본 말 · 쓴 단어만 적는다. 여기서 확정하는 것: 스테퍼 다섯 단어
(참가자가 `저장` 을 따로 부르지 않으면 넷으로), 카드 제목(`답을 마치지 못했습니다` ·
`진행 N/M` · `이 답변 이전으로 되돌리기`), 오류 사전의 문장. 관찰이 이긴다.

### 4. 진행과 오류 — D48 · D49 · D50 (1~2주)

- 파일: `components.tsx`(`TodoCard`, 같은 턴 갱신), `protocol`(엔벨로프 `error` · 마커 `error` · `notices` 문구 이동), `Preview.tsx`(배너 · 버튼), `ScreenPanel.tsx`(마커 턴 발신 — `commentsToTurn` 옆에 `errorToTurn`), `Sidebar.tsx`(자식 행 `확인 대기` 표식, `threads.state = "awaiting"`), `daemon-client.ts`(브라우저 `Notification`), `session-activity.ts`(확인 대기 전이), 데스크톱 `notices.ts` → `protocol` 로. **참조 레포** `preview-bridge`: `window.onerror` · `unhandledrejection` · Next dev overlay 감지 → `cds-design.error` 송신(커밋까지)
- 테스트: `turn-marker.test.mts` — `error` 종류; `ui-comments-e2e` — 프레임이 `cds-design.error` 를 보내면 배너가 뜨고 버튼이 마커 턴을 만들며 카드 제목이 `화면 오류 고치기`; 스텁 턴이 `TodoWrite` 둘을 내면 카드 하나가 갱신된다; `session-activity.test.mts` — 확인 대기 전이
- 수용: 참조 레포 화면에 `throw` 를 심은 커밋으로 `test:comments-ui` 가 배너 → 턴까지 간다

### 5. Claude 가 화면을 본다 — D61 · D63 (2주)

- 파일: 데몬 신규 `preview-tools.ts`(`createSdkMcpServer("cds-preview")` · 도구 여섯 · 턴당 상한 · `PreviewDriver` 인터페이스), `session.ts`(화면 세션의 `query` 옵션에 `mcpServers`, `canUse` 가 `mcp__cds-preview__*` 허용, 턴 끝에 `driver.destroy`), `server.ts`(`DaemonServer` 옵션 `previewDriver?` — `previewUrl` 을 드라이버에 준다), 데스크톱 `main.ts`(오프스크린 `BrowserWindow` 드라이버 — `webContents.debugger` CDP: `Page.captureScreenshot` · `Accessibility.getFullAXTree` · `Runtime.evaluate` · `Input.dispatchMouseEvent` · `Runtime.consoleAPICalled`; `paint` → PiP 프레임 8fps), `preload.ts`(PiP 프레임 브리지), 웹 `ScreenPanel.tsx`(PiP · 크게 보기), `components.tsx`(`screen_screenshot` 결과 → 캡처 카드, `screen_*` → 활동 줄 `화면 N곳 확인`), `tool-names.ts`(`screen_*` → `화면 보기`), `SettingsDialog.tsx`(대화 그룹 토글 둘); **참조 레포** `CLAUDE.md` 한 줄(커밋까지)
- 테스트: 데몬 단위 `preview-tools.test.mjs` — 가짜 드라이버로 도구 여섯의 스키마 · 화면 목록 · 12장 상한 · 드라이버 없음이면 서버 미등록; `desktop-smoke` — 패키징 앱에서 드라이버가 fixture 앱을 열어 `screenshot` 이 JPEG 를, `axTree` 가 fixture 제목 텍스트를 돌려주고, 창은 보이지 않는다(`BrowserWindow.getAllWindows()` 중 visible 은 하나); `test:planner`(실 Claude, 선택 — 사용량) 한 단언: 턴 안에서 `screen_screenshot` 이 1회 이상 불리고 대화에 `Claude가 본 화면` 카드가 남는다; `test:comments-ui` 는 iframe 경로 그대로
- 수용: 데스크톱에서 화면 턴이 끝나면 대화에 Claude 가 찍은 상태별 캡처가 있고, PiP 가 턴 중에만 보인다. 브라우저 개발 경로의 모든 스위트가 그대로 통과한다. `ui-proposal.html` 의 `R` 상태에 PiP 를 그린다

### 6. 첨부 · 캡처 · 코멘트 — D55 · D56 · D57 · D58 · 프로토콜 v10 범프 (1~2주)

- 파일: `Composer.tsx`(빠른 동작 칩), 데몬 `repo.ts`(`cds-design.json#quickActions` · `#shots` 읽기 · `shots` 커밋) · `handoff-draft.ts`(PR 본문 링크), `components.tsx`(캡처 카드 전 · 후), 신규 `CommentsPopover.tsx`, 데몬 `comments.json` 읽기 · 쓰기, `Preview.tsx`(`💬 코멘트` 토글 → 엔벨로프), `protocol/index.ts`(v10 범프), **참조 레포** 오버레이(`comments.mode` 수신). 촬영은 5단계의 Claude 드라이버가 한다 — 드라이버가 없으면(브라우저 경로) 카드 · 첨부 없음
- 테스트: `publish-e2e` — `shots` 가 `.cds-design/shots/` 로 커밋되고 PR 본문에 링크, `shots: false` 인 레포와 드라이버 없는 경로에서는 본문에 캡처 절이 없다; `ui-comments-e2e` — 봉투 뒤 `comments.list` 1건 · 해결 토글 · 핀은 사라지고 목록은 남는다; 칩 클릭이 문장을 넣고 보내지 않는다
- 수용: 넘긴 PR 본문을 GitHub 에서 열면 화면마다 캡처가 보인다(실 레포 한 번)

### 7. 검증

- [ ] `pnpm typecheck`; `test:unit` · `test:repo` · `test:publish` · `test:projects`
- [ ] `pnpm --filter @cds-design/web build` 후 `test:publish-ui` · `test:comments-ui` · `test:settings` · `test:sidebar-ui` · `test:onboarding-ui`
- [ ] `test:daemon` 한 번(요약 실 Claude 케이스) — 구독 사용량을 쓴다
- [ ] 실제로(데스크톱 pack 빌드): 기획서 첨부 → 턴 중 할 일 카드 → 끝나면 캡처 카드 · 스테퍼 `검토·수정` → 화면에 오류 심기 → 배너 → 고치기 턴 → `이 답변 이전으로 되돌리기` → 저장 검토에 요약 · 파일 없음 → 저장 → 두 번째 저장 → 저장 기록에서 첫 시점으로 → 넘기기 → PR 본문에 캡처 → 다른 프로젝트의 대화를 트리에서 눌러 전환 → 창 뒤에서 권한 카드 → 트리 행 `확인 대기` + 알림. 1280 · 1100 폭에서 스테퍼 한 줄 · 번호만, 레일에서 팝오버
- [ ] 관찰(3단계 뒤)의 기록으로 단어를 바꿨다면, 바꾼 것만 여기 적는다
- [ ] 이 문서는 여기까지 끝난 뒤 지운다. §9 대응표는 README 끝으로 옮긴다

## 9. 번호 대응표 — 코드 주석이 부르는 앞 판의 결정

코드 주석의 `PLAN D<n>` 은 세 판에 걸쳐 쌓였고 같은 번호가 다른 뜻으로 두 번 쓰인
자리가 있다. 이 표가 그 번호를 푼다(0단계가 충돌 넷에 꼬리표를 붙인다).

| 번호 | 뜻 | 어디서 부르나 |
|---|---|---|
| D1 | 홈 폴더 `~/.cds-design` + 이주 | `environment.ts` · `index.ts` · `server.ts` · `home-dir.test.mjs` |
| D2 | **충돌.** ⓐ 프로젝트 = 연결 레포 하나 (Drafthouse 판 D3 의 뜻) — `projects.ts` · `server.ts:328` · `projects-e2e.mjs`; ⓑ `폴더 열기` — `main.ts` · `preload.ts` | |
| D4 | 게이트 넷, `project` 게이트 삭제 | `onboarding.ts` |
| D5 | **충돌.** ⓐ 저장 · 개발자에게 넘기기 · 반영됨(git 어휘 셋) — `github.ts` · `repo.ts` · `protocol` · `projects.ts` · `github.test.mjs` · `publish-e2e.mjs`; ⓑ `runtime` 게이트 판정 — `onboarding.ts:129` · `onboarding.test.mjs:359` | |
| D6 | pnpm 영어 경고 삭제 | `environment.ts:453` |
| D7 | 레포가 선언하는 화면(`cds-design.screens` 엔벨로프) | `protocol:632` |
| D8 | `pendingChanges` — 스테퍼의 숫자, 폴링 없음 | `repo.ts` · `server.ts` · `protocol:575` · `publish-e2e.mjs` |
| D9 | 기계 텍스트는 마커 카드로 | `repo.ts:75` · `session.ts:486` · `turn-marker.ts` · `publish-e2e.mjs` |
| D10 | **충돌.** ⓐ 모델 · 생각 시간 · 권한을 설정으로, 컴포저는 `⋯` — `Composer.tsx:96` · `settings.ts:43` (이 판 D42 가 칩 표시를 되살린다; 저장 위치 규칙은 유지); ⓑ `github` 게이트 판정(warn 비차단) — 직접 부르는 주석 없음 | |
| D12 | **어긋남.** 주석은 "프로젝트는 게이트가 아니다"(= 앞 판 D4)의 뜻으로 쓴다 — `onboarding.ts:6,213` · `index.ts:76`. 앞 판 표의 D12 는 어휘(`프로젝트`) | |
| D15 | 사이드바 행 `작업 중` | `session-manager.ts:97` |
| D16 · D17 · D18 | 비활성 프로젝트 상태는 `project.changed` 로 · 200ms 스로틀 · 시작 시 전 프로젝트 워크스페이스 | `server.ts` · `protocol:13,381` · `repo.ts:514` · `AddProjectDialog.tsx:7` |
| D19 · D21 · D25 · D28 · D31 | 사이드바 폭 · 지우기 순서 · 피커 자리 · `cds-design.json` 없는 레포 차단 · 주소로 추가 | `Shell.tsx` · `Sidebar.tsx` · `RepoPicker.tsx` · `settings.ts` |
| M1 · M5.5 | 첫 판의 단계 번호(프로젝트 모델 토대 · 배포 파이프라인) | `index.ts:61` · `electron-builder.yml:11` |
| DESIGN §5–§8 | 이 트리에 없는 문서(`DESIGN.md`)의 절 — 미리보기 origin 검사 · 데스크톱 패키징 · 온보딩 | `Preview.tsx` · `onboarding.ts` · `electron-builder.yml` · `preload.ts` |

앞 판(게이트 넷 · 사이드바)의 D1–D34 는 33/34 완료. 남은 하나(D3, `reference-repo/`
재클론 + 낡은 주석 둘)는 0단계다.

## 10. 리스크

- **요약과 캡처에 구독 사용량 · 시간이 든다**(D51 · D56). 요약은 저장 검토를 열 때
  한 번, 해시 캐시. 한도가 찼으면 폴백 + `지금은 요약을 만들 수 없어 파일 목록을
  보입니다`. 캡처는 턴 끝에 한 장, 넘기기 때 화면 × 상태 — 열 장 넘으면 진행 표시.
- **체크포인트 ref 가 쌓인다**(D52). 사이클(머지)마다 지우고, 세션당 최근 20개만
  둔다. `git gc` 는 건드리지 않는다.
- **되돌리기가 PR 히스토리를 길게 만든다**(D53). 의도한 것 — 리뷰 중인 브랜치를
  다시 쓰는 것보다 낫다. 메시지가 `되돌리기:` 로 시작해 리뷰어가 알아본다.
- **참조 레포의 오류 훅이 Next 버전에 묶인다**(D49). dev overlay 내부 API 가 아니라
  `window.onerror` · `unhandledrejection` · `console.error` 의 빌드 오류 문자열만
  본다. 못 잡는 오류는 지금처럼 프레임 안에 보이고, 서버 중단 경로는 그대로다.
- **마커를 Claude 가 따라 쓴다**(D49 `error`). 사용자 블록에서만 파싱하므로 카드가
  되지 않는다. `CLAUDE.md` 의 "이 주석은 쓰지 않는다" 한 줄은 이미 있다.
- **스테퍼 판정이 틀리면 주 버튼이 틀린다**(D45). 순수 함수 + `더 보기 ▾` 에 모든
  동작이 항상 있으니 막히지는 않는다. 어긋난 사례는 `stage.test.mts` 행으로.
- **대화 한 번 클릭이 미리보기 서버를 바꾼다**(D59). 다른 프로젝트의 자식 행은 툴팁으로
  미리 말하고, 전환 중 그 행은 `전환 중…`, 미리보기 칸은 `켜는 중`. 세션은 죽지 않으니
  잃는 것은 몇 초다. 그래도 잦으면 `열어둔 것` 의 "서버 둘 동시에"를 앞당긴다.
- **트리가 세 단계로 깊어지고 싶어진다**(D59) — 화면별 · 날짜별 묶기. 두 단계에서
  멈춘다. 대화가 스무 개를 넘는 프로젝트는 보관(D54)과 팔레트가 답이다.
- **`TodoWrite` 를 안 쓰는 턴**(D48)은 카드가 없다. 그때는 지금의 활동 줄. 카드를
  강제하려고 `CLAUDE.md` 에 규칙을 넣지 않는다 — 짧은 턴에 할 일 목록은 소음이다.
- **보관이 삭제를 숨긴다**(D54). SDK 대화록은 디스크에 남는다. 영구 삭제는 보관함에
  있고, `프로젝트 지우기 → 폴더까지` 가 여전히 전부 지운다.
- **1단계 어휘 사전은 도구 이름 목록에 묶인다**(D37). Claude Code 가 새 도구를 내면
  원어가 보인다 — 사전에 없는 이름은 그대로 통과시키고, 발견하면 한 줄 추가.
- **뷰는 DOM 위에 뜬다**(D60 — 보류). 열 때의 규칙 하나: 미리보기 칸 위에 무엇이든
  그리는 컴포넌트는 `cover` 를 건다. 이 판에서는 해당 없음 — Claude 창은 보이지 않는다.
- **Chromium 프로세스가 하나 더**(D61) + Next dev. Claude 창은 턴이 끝나면 destroy 하고,
  PiP 프레임은 턴 중에만 8fps. 메모리는 데스크톱 pack 에서 실측한다.
- **스크린샷은 토큰이다**(D61). 턴당 12장, 긴 변 900px JPEG q70, `screen_read` 를
  먼저 쓰라고 도구 설명에 적는다. 한도에 닿으면 도구가 문장으로 말하고 턴은 계속된다.
- **Claude 가 클릭으로 목 데이터를 바꾼다**(D61). 자기 뷰라 기획자 뷰에는 없고, 목은
  파일에서 오는 값이라 새로 고침이면 돌아온다.
- **정책**(D61). `mcpServers` 는 Agent SDK 의 공개 옵션이다 — 바이너리는 그대로,
  로그인은 사용자 것(README §정책). 새로 생기는 서면 확인 항목은 없다.
- **브라우저 개발 경로가 뒤처진다**(D61 · D63). Claude 는 거기서 화면을 못 본다.
  개발자 경로라 받아들인다; Playwright 드라이버는 `열어둔 것`.

## 11. 열어둔 것 (이 판 이후)

- **개발자 리뷰 코멘트를 도구 안에서.** `changes_requested` 가 칩으로만 보인다
  (`HandoffPanel.tsx:8-14`). 리뷰 코멘트를 카드로, `Claude에게 넘기기` 한 번.
  기획자가 GitHub 을 열지 않는다는 약속의 마지막 조각. D57 의 `comments.json` 모양을
  그대로 쓸 수 있을 때 연다.
- **토큰 대신 로그인.** GitHub Device Flow · OAuth 앱 등록이 필요하고 조직 정책
  확인이 먼저다. 지금은 `토큰 만들기 ↗`(스코프 미리 채움)가 우회로.
- **기획자 미리보기를 네이티브 뷰로**(D60 · D62, 보류). iframe 이 실제로 불편해질 때 —
  진짜 모바일 에뮬레이션, 레포 훅 없는 오류 배너, 그리고 그 뒤에 `새 창을 앱 안 탭으로`.
  설계는 §6 표에 그대로 있다.
- **Claude 가 외부 문서를 본다**(Confluence · Figma 링크). D61 의 뷰에 URL 허용 목록만
  더하면 되지만, 로그인 세션 · 사내 문서 접근 정책이 먼저다.
- **브라우저 개발 경로의 `PreviewDriver`** — Playwright 헤드리스(이미 devDependency).
  개발자만 쓰는 경로라 급하지 않다.
- **레포 안에서 작업 여럿(worktree · 독립 PR).** 앞 판이 열어둔 그대로 — 넘긴 뒤
  저장이 같은 PR 에 쌓이는 것, A 화면의 `check` 실패가 B 저장을 막는 것이 실제
  불평이 되면.
- **포트가 다른 레포 둘의 서버를 동시에.** "보이는 것만 켜져 있다"가 아직 더 값지다.
- **다중 GitHub 계정 · Node 자동 설치 · `⌘1…⌘9`.** 앞 판 §열어둔 것 그대로.
- **채팅 · 미리보기가 좁은 창에서 겹쳐 쌓이기.** 1100 미만은 사이드바만 접힌다
  (`styles.css:1554`). 노트북 반 화면 사용이 관찰되면.
- **Anthropic 담당자 서면 확인**(README §정책) — 여전히 롤아웃 차단 항목.

## 12. 구현 가능성 판단 — 2026-09-11, 코드 기준

결정 D35–D63 을 지금 코드에 대고 확인했다. **막는 것은 없다.** 확인한 사실, 스파이크가
필요한 셋, 그리고 앞선 초안에서 틀렸던 것.

**확인한 사실(그대로 쓸 수 있다).**
- D35: `turn` 블록에 `isError` 가 이미 온다(`daemon-client.ts:167-182`, `protocol:356-358`). 카드는 렌더링만.
- D42: 칩 셋이 이미 보인다(`Composer.tsx:897-956`). 라벨 문형만 바꾼다.
- D44 · D45: 판정 입력이 전부 `RepoStatus` 에 있다 — `branch` · `handoff` · `pendingChanges` · `phase`(`protocol:553-583`); `screens` 는 웹 상태, `running` 은 세션 상태.
- D59: `manager.list(cwd)` 가 SDK `listSessions({ dir })` 로 프로젝트별 목록을 이미 만든다(`session-manager.ts:123-124`). 다른 프로젝트 대화 열기는 `project.activate` → `session.create { resume }`(`session.ts:247`) — 새 메시지 없음. `session.rename` 은 프로토콜에 없고 웹 `settings.sessionTitles` 다 — 그대로 둔다.
- D61: SDK `query` 옵션 `mcpServers` + `createSdkMcpServer` · `tool` 이 타입에 있다(`sdk.d.ts:59,511,1802,8590`); `canUse` 는 `EDIT_TOOLS` 집합만 특별 취급하므로(`session.ts:304-312`) `mcp__cds-preview__*` 허용 분기 한 줄. 데스크톱은 `new DaemonServer({…})`(`main.ts:53`) — 옵션 하나로 드라이버 주입.
- D55 · D56: `cds-design.json` 파서가 한 곳(`repo.ts:129-197`)이라 `quickActions` · `shots` 선택 키 추가가 한 함수.
- D51: 데몬이 이미 SDK `query` 를 쓰므로 요약도 같은 길(`-p` 프로세스가 아니라 `query({ maxTurns: 1 })`) — 새 실행 경로 없음.
- 브라우저 스위트 넷(`settings · publish-ui · onboarding-ui · sidebar-ui`)이 지금 빌드에서 전부 통과한다(2026-09-10 실행).

**스파이크 셋(각 반나절 이내) — 1단계 전에 돌려 답을 이 문서에 적는다.**
1. **오프스크린 `BrowserWindow` + CDP** (D61): Electron 44 에서 `show: false, offscreen: true` 창에 `webContents.debugger.attach("1.3")` → `Page.captureScreenshot` · `Accessibility.getFullAXTree` · `Input.dispatchMouseEvent` 가 fixture 앱에서 값을 돌려주는가, `paint` 이벤트가 8fps 로 오는가. 실패 시 대안: `show: false` 일반 창(오프스크린 없이) — `capturePage` 는 숨은 창에서도 동작한다.
2. **체크포인트 write-tree** (D52): fixture 클론에서 untracked 새 파일 + 수정 + 삭제 상태를 임시 인덱스로 스냅샷 → 되돌리기 → 세 종류가 전부 원상. `git add -A` 가 `.gitignore` 를 존중하는지(node_modules 제외) 확인.
3. **동시 `query`** (D51 · D61): 화면 세션이 도는 동안 같은 cwd 에서 요약용 `query` 하나를 더 띄워도 CLI 가 충돌하지 않는가(세션 파일 · 락). 충돌하면 요약은 세션이 idle 일 때만.

**앞선 초안에서 틀렸던 것(고쳤다).**
- `git stash create` 는 추적 안 된 파일을 담지 않는다 — 첫 저장 전의 새 화면 파일이 전부 빠진다. D52 를 임시 인덱스 `write-tree` 로 바꿨다.
- `session.attach` 라는 메시지는 없다 — `session.create { resume }` 다(D59).
- `WebContentsView` 의 `offscreen` 은 문서화된 경로가 아니다 — Claude 창은 `BrowserWindow` 로(D61).
- 미리보기 주소에 토큰이 있다고 의심했으나 `http://127.0.0.1:<port>` 다(`repo.ts:1358`) — D40 은 어휘 문제.

**전제 하나.** `reference-repo/` 가 이 트리에 없다. 4단계(오류 훅) · 5단계(`CLAUDE.md`) · 6단계(`comments.mode`)와 `test:comments-ui` 가 그 폴더를 필요로 한다 — 0단계의 재클론이 먼저다.

**기간.** 0 반나절 · 1 2~3일 · 2 2주 · 3 2~3주 · 관찰 반나절 · 4 1~2주 · 5 2주 · 6 1~2주 = **약 9~12주**, 스파이크 셋 별도 1~2일.
