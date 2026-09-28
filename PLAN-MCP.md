# 내장 MCP 개선 계획 — `colo-browser` 도구 상자

> **한 줄 요약.** AI 가 화면을 보고 만지는 유일한 길인 내장 MCP(`colo-browser`, 도구
> 17개)는 잠금 · 직렬화 · 실패 전달이 잘 서 있다. 남은 일은 넷이다 — ① 액션마다 화면
> 전체를 다시 읽히는 **스냅샷 예산**, ② `screen_check` 가 이번 작업 장부에 **적히지
> 않는** 누락, ③ 대화 제출이 **한마디 · 귀속 대화를 흘리는** 빈 칸, ④ op 에 대한
> **관측 부재**. 그 위에 새 도구 넷(`browser_inspect` · `browser_find` ·
> `screen_files` · `notify_developer`)을 같은 상자에 더한다. 서버는 하나로 둔다.

- **기준**: 워크트리 `durable-spider`, 브랜치 `lifecycle`, 데스크톱 `0.3.15`. 줄 번호는
  2026-09-28 의 것 — 합칠 때 다시 잰다.
- **범위**: `packages/daemon`(도구 계약 · 중계 · 통계 · 지침), `packages/desktop`(pane
  드라이버), `packages/protocol`(보고 형태 하나), README 의 해당 절. 웹 UI 는 건드리지
  않는다 — 사용자 면에 새 문장이 생기지 않는 계획이다.
- **원칙**: ① 도구의 실패는 언제나 도구 결과다(예외로 턴을 죽이지 않는다 — 지금 계약
  그대로). ② 새 도구는 세 프로바이더(Claude stdio · Codex stdio · omp host tool)에 같은
  목록으로 실린다 — `browserTools()` 한 곳. ③ 서버 이름은 상수
  `BROWSER_MCP_SERVER_NAME` 만 참조한다 — `RENAME-NOVA-PLAN.md` 가 그 값을 바꿔도 이
  계획의 코드는 흔들리지 않는다. ④ 측정이 먼저다: 다이어트(묶음 C)보다 잣대(묶음 A)를
  먼저 합친다.

---

## 0. 결정 요약

| # | 논점 | 결정 |
|---|---|---|
| M-1 | 서버 수 | **하나 유지.** 새 도구는 `BROWSER_TOOLS` 에 더한다. 두 번째 stdio 자식은 세션마다 프로세스 · 시크릿 · relay 를 하나 더 낳는다 — 값이 없다(§4) |
| M-2 | 스냅샷 표기 | JSON 트리 → **한 줄 표기 트리**(`e12 button "검색" [disabled]`). 이름도 ref 도 없는 구조 노드는 접고, 상한 400줄 + `… N개 더` (§3.C) |
| M-3 | 액션의 답 | 전체 스냅샷 대신 **요약 한 묶음**(주소 · 제목 · 포커스 · 바뀐 줄 ±N). 전체는 `browser_snapshot` 으로. 드라이버 계약은 그대로 — 압축은 데몬이 한다 (§3.C) |
| M-4 | ref 안정성 | 같은 DOM 노드(`backendDOMNodeId`)는 세대가 바뀌어도 **같은 ref**. 문서가 갈릴 때만 비운다 (§3.C) |
| M-5 | `screen_check` | 성공한 확인은 `notePinned` 에 적는다. 인자 `viewport?` · `routes?` · `capture?` 를 더하고 `route` 단수는 그대로 받는다 (§3.B · §3.D) |
| M-6 | `submit_for_review` | 인자 `note?` 추가, `supervisor.submit("chat", sessionId, note)` 로 부른다 (§3.B) |
| M-7 | 통계의 도구 판정 | 문자열 접두가 아니라 **도구 이름 집합**으로 센다 — omp 의 `screen_check` · `submit_for_review` 가 `other` 에서 나온다 (§3.A) |
| M-8 | op 관측 | 턴 행에 `browserMs` · `browserFail` 집계, 데몬 로그에 op 한 줄(`debug`, 주소 없음) (§3.A) |
| M-9 | 시험 자리 | 압축 · 요약 · 찾기 · 판정은 **데몬의 순수 함수**로 두고 `node:test` 로 시험한다. 데스크톱(Electron)은 `pnpm dev:desktop` 의 손 검증 (§5) |
| M-10 | 새 도구 | `browser_inspect` · `browser_find` · `screen_files` · `notify_developer` 넷. `note_screen` 은 보류 (§3.E · §6) |
| M-11 | 공통 지침 | `screen_check` 규칙에 폭 · 그림, `notify_developer` 한 줄, "스냅샷은 필요할 때만" 한 줄 (§3.F) |
| M-12 | 별도 서버 후보 | `colo-cds`(디자인 시스템 조회)는 **이 계획 밖** — 근거만 §6 에 남긴다 |

---

## 1. 지금의 상자 — 사실만

| 자리 | 파일 | 무엇 |
|---|---|---|
| 도구 계약 17개 | `packages/daemon/src/browser-tools.ts:48` `BROWSER_TOOLS` | 이름 · 설명 · op · 인자 스키마. `browserTools(submitFromChat)` 이 세션별 목록 |
| stdio 서버 | `packages/daemon/src/browser-mcp.ts` | 줄 단위 JSON-RPC, SDK 의존 없음. Claude · Codex 가 자식으로 띄운다 |
| host tool | `packages/daemon/src/agent/drivers/omp/session.ts:224` | omp 는 자식 없이 같은 목록을 in-process 로 |
| 기동 명세 | `packages/daemon/src/browser-launch.ts` | `BROWSER_MCP_SERVER_NAME`, 세 와이어 형태 |
| 중계 끝 | `packages/daemon/src/server.ts:1293` `onInternalBrowser` | 시크릿 · 화이트리스트(`:97`) · 세션당 직렬 큐 · 90초 상한 · 레포 밖 표면의 권한 카드 |
| op 풀기 | `server.ts:166` `callBrowserOp` | flat 인자 → `BrowserDriver` 위치 인자 |
| 검증 창 판정 | `server.ts:1514` `runScreenCheck` | 게이트와 같은 드라이버 · 기준 |
| pane 드라이버 | `packages/desktop/src/preview-driver.ts:985` `axTree` | CDP `Accessibility.getFullAXTree` → 계층 그대로, ref 는 `:995` 에서 매번 새로 |
| 통계 | `packages/daemon/src/turn-stats.ts:275` | `browser_` 접두 · `colo-browser` 문자열로 브라우저 도구 판정 |
| 시험 | `packages/daemon/test/browser-tools.test.ts` | 제출 도구 필터 1건 |

### 1.1 근거 — 로컬 턴 통계(2026-09-23 · 25, 사용자 턴 20건)

| 턴 | 프로바이더 | 브라우저 호출 | 컨텍스트 토큰 | 걸린 시간 |
|---|---|---|---|---|
| 9/23 16:10 | Claude | 17 | 120k | 200초 |
| 9/25 13:26 | omp | 13 | 34k | 482초 · 스트림 실패 |
| 9/25 14:14 | omp | 14 | 42k | 245초 |
| 9/25 13:31 | omp | 7 | 49k | 156초 |
| 9/25 10:10 | omp | 0 | 12k | 23초 |

브라우저 호출이 많은 턴일수록 컨텍스트와 시간이 함께 커진다 — 인과는 아직 재지
못했다(op 별 시간이 없다, §3.A). 게이트 14건 중 5건이 `no-screens` 다 — 이 턴들이
`screen_check` 로만 화면을 확인했다면 §3.B 의 누락과 같은 사건이다.

### 1.2 근거 — 코드

- **스냅샷 상한 없음**: `axTree` 는 노드를 세지 않고, `browser-tools.ts:284` 는 결과를
  `JSON.stringify` 그대로 싣는다. 노드마다 `"states":[]` · `"children":[]` 가 붙는다.
  액션 11개의 성공 답이 모두 새 전체 트리다(`BrowserDriver` 계약).
- **ref 매번 새로**: `preview-driver.ts:995` `state.refs.clear()` + `refSeq += 1`. 같은
  버튼이 클릭마다 다른 이름을 얻는다 — "낡은 ref" 오류(`:1497`)의 원인 하나.
- **`screen_check` 미기록**: `server.ts:1479` 는 `navigate` 만 `notePinned` 를 부른다.
  `pinnedThisTurn` 은 게이트 · `screen-map.jsonl` · `cycleScreens`(`project-fleet.ts:903`
  `screensOfTurn`) 의 유일한 재료다.
- **제출 인자 누락**: `server.ts:1373` `supervisor.submit("chat")`. 시그니처는
  `cycle-supervisor.ts:359` `submit(via, sessionId?, note?)`.
- **통계 판정**: `turn-stats.ts:275`. Claude 는 `mcp__colo-browser__screen_check`, Codex 는
  `colo-browser/screen_check`(`drivers/codex/session.ts:767`) 라 잡히지만 omp 는 맨
  `screen_check` 라 `other` 다.
- **관측 0줄**: `onInternalBrowser` 안에 로그 호출이 없다. 실패 종류(낡은 ref · 타임아웃 ·
  거절 · pane 없음)는 대화록에만 남는다.

---

## 2. 묶음과 순서

| 묶음 | 내용 | 결정 | 크기 | 선행 |
|---|---|---|---|---|
| A | 잣대 — 도구 판정 집합, op 집계 · 로그, 시험 뼈대 | M-7 · M-8 · M-9 | S | — |
| B | 한 줄짜리 둘 — `screen_check` 기록, 제출의 `note` · 귀속 | M-5(기록) · M-6 | S | — |
| C | 스냅샷 다이어트 — 한 줄 표기 · 액션 요약 · 안정 ref · `browser_find` | M-2 · M-3 · M-4 · M-10(일부) | L | A |
| D | `screen_check` 확장 — `viewport` · `routes` · `capture` | M-5(인자) | M | B |
| E | 새 도구 셋 — `browser_inspect` · `screen_files` · `notify_developer` | M-10 | L | A · C |
| F | 지침 · README 동기화 | M-11 | S | C · D · E |

A 와 B 는 서로 독립이라 같은 날 합칠 수 있다. C 는 A 의 잣대가 있어야 효과를 잰다.
E 의 `browser_inspect` 는 C 의 안정 ref 위에서만 값이 있다(ref 가 세대마다 바뀌면
"방금 찾은 요소를 조사한다" 가 두 번에 한 번 실패한다).

---

## 3. 묶음별 작업 분해

### 3.A 잣대 (M-7 · M-8 · M-9)

**바꾸는 파일**: `browser-tools.ts` · `turn-stats.ts` · `server.ts` · `log.ts`(필요 시) ·
`test/browser-tools.test.ts` · `test/turn-stats.test.ts`(없으면 새로).

1. `browser-tools.ts` 에 `export const BROWSER_TOOL_NAMES: ReadonlySet<string>` 을 두고
   `BROWSER_TOOLS` 에서 파생한다. `isBrowserToolName(name)` 은 셋을 본다 — 맨 이름
   (omp), `mcp__<server>__<name>`(Claude), `<server>/<name>`(Codex). `<server>` 는
   `BROWSER_MCP_SERVER_NAME` 상수다.
2. `turn-stats.ts:275` 의 판정을 `isBrowserToolName` 으로 바꾼다. 같은 자리에서
   `tool.start` 의 시각을 `toolUseId` 별로 기억했다가 `tool.end`(있으면)에서 `browserMs`
   에 더한다. 프로바이더가 `tool.end` 를 주지 않으면 그 칸은 null 로 솔직하다.
3. `server.ts onInternalBrowser` 가 op 하나를 끝낼 때 `this.stats.noteBrowserOp(sessionId,
   { op, ms, error?: BrowserFailKind })` 를 부른다. `BrowserFailKind` 는 다섯이다 —
   `stale-ref`(드라이버 메시지 `는 지금 화면의 것이 아닙니다`) · `timeout`(센티넬) ·
   `refused`(권한 카드 거절) · `no-pane`(404 계열) · `other`. 판정은 순수 함수
   `classifyBrowserFailure(message)` 로 빼서 시험한다.
4. 턴 행에 `browserMs: number | null` 과 `browserFail: Record<BrowserFailKind, number>` 를
   더한다(비면 생략). 턴 통계의 README 표(`~/.colo-design/logs/turn-stats-…`)에 두 칸을
   적는다.
5. 데몬 로그에 op 마다 `debug` 한 줄: `[browser] op=<op> ms=<n> ok=<bool> fail=<kind>`.
   주소 · ref · 인자는 싣지 않는다(새니타이저를 믿지 않고 애초에 안 담는다).
6. 시험 뼈대 — `test/browser-tools.test.ts` 에 더한다:
   - `callBrowserTool` — 가짜 `fetch`(전역 교체)로 401 · 404 · `ok:false` · 도달 실패 ·
     계약 밖 응답 · 스크린샷의 image 블록 여섯 경우가 각각 `isError` 텍스트 / image 로
     내려오는지.
   - `browser-mcp.ts` 의 악수 — 자식 프로세스로 띄워 `initialize` → `tools/list` →
     모르는 도구 `tools/call` 이 프로토콜 오류가 아니라 도구 결과인지. `COLO_DAEMON_URL`
     은 닫힌 포트로 둬 중계 실패가 결과로 오는 것까지 본다.
   - `isBrowserToolName` 세 형태와 `classifyBrowserFailure` 다섯 종류.

**끝 조건**: omp 턴의 `screen_check` 가 `tools.browser` 로 센다. 턴 행에 `browserMs` 가
선다. `pnpm test` 에 브라우저 시험이 셋 이상.

### 3.B 한 줄짜리 둘 (M-5 기록 · M-6)

**바꾸는 파일**: `server.ts` · `browser-tools.ts` · `test/cycle-screens.test.ts`(경계
확인) · `test/browser-tools.test.ts`.

1. `runScreenCheck` 가 `opened.ok === true` 로 답하기 직전에
   `this.drivers.notePinned(sessionId, target.toString())` 를 부른다 — `navigate` 와 같은
   자리, 같은 전체 주소. 게이트가 그 화면을 턴 끝에 한 번 더 열게 되는 것은 의도다:
   AI 가 확인 뒤에도 편집할 수 있고, 판정은 사람이 아니라 기계의 몫이다(README 「턴
   끝의 화면 확인」).
2. `submit_for_review` 의 `properties` 에 `note: { type: "string", description: "개발자에게
   한마디(선택) — 사용자가 그렇게 말했을 때만 그 말 그대로." }` 를 더한다.
   `server.ts:1373` 을 `supervisor.submit("chat", sessionId, note)` 로 바꾼다. `note` 는
   `HANDOFF_BODY_MAX_CHARS` 보다 훨씬 짧게 자른다(200자) — 영수증 한 줄의 크기다.
3. 결과 문장은 그대로(`개발자에게 보냈어요 …`). 한마디가 실리면 영수증(U20 의
   `noteSent`)이 그것을 말한다 — 웹은 이미 그 길을 안다.

**시험**: 순수 — `browserTools(true)` 의 제출 도구가 `note` 를 선언한다. 하네스 없음 —
`runScreenCheck` 의 기록은 `pinnedThisTurn` 을 읽는 기존 서버 시험이 있으면 그 옆에,
없으면 §5 의 손 검증 항목으로.

**끝 조건**: `screen_check` 만 부른 턴 뒤에 「이번 작업」 에 그 화면이 선다. 대화로
"개발자에게 보내 줘, 한마디는 '주말에 봐 주세요'" 가 영수증에 한마디를 남긴다.

### 3.C 스냅샷 다이어트 (M-2 · M-3 · M-4 · `browser_find`)

**바꾸는 파일**: 새 `packages/daemon/src/browser-snapshot.ts`(순수) · `server.ts`
`callBrowserOp` 결과 가공 · `browser-tools.ts` 설명 · `packages/desktop/src/preview-driver.ts`
`PageState` · `axTree` · 새 `test/browser-snapshot.test.ts`.

**C-1 한 줄 표기 (데몬, 순수).** `renderSnapshot(nodes: PreviewAxNode[], opts) →
{ text, lines, truncated }`.

```
textbox "이름 검색" e4
button "검색" e5 [disabled]
list e6
  listitem e7
    link "김바다" e8
    text "부산 · 2019년 가입"
… 312개 더 — browser_snapshot { ref: "e6" } 로 그 아래를 읽으십시오
```

규칙: ① ref 도 이름도 없는 노드(`generic` · `none` 따위)는 접고 자식만 올린다 — 들여쓰기
한 단을 아낀다. ② `value` 는 `= "…"` 로 뒤에, 상태는 `[…]` 로 뒤에. ③ 이름은 80자에서
자른다. ④ 상한 `SNAPSHOT_MAX_LINES = 400` — 넘으면 마지막 줄이 몇 개가 남았는지와 부분
읽기의 방법을 말한다. ⑤ `ref` 가 주어지면 그 노드의 부분 트리만 그린다(ref 는 드라이버
쪽 `state.refs` 에서 찾으므로 데몬은 `snapshot` 결과에서 그 ref 의 노드를 찾아 자르는
것으로 충분하다 — 드라이버 계약 변경 없음).

**C-2 액션의 답 (데몬).** `callBrowserOp` 의 액션 결과(`PreviewAxNode[]`)를 그대로
내리지 않고 `summarizeAction(before, after) → text`:

```
회원 목록 · http://127.0.0.1:5274/member/MemberList
포커스: textbox "이름 검색" e4 = "김"
바뀐 줄: +2 −1
+ listitem e21
+   link "김바다" e22
− text "회원이 없습니다"
```

`before` 는 세션별로 데몬이 기억하는 **마지막 렌더 줄 목록**(`Map<sessionId, string[]>`,
프로젝트 전환 · 세션 종료에 비운다). 차이는 줄의 집합 차 — 상한 20줄, 넘으면
`… 더 바뀜 — browser_snapshot 으로 읽으십시오`. 제목 · 주소는 `navigate` 결과의
`settled` 옆에 이미 있는 값이 아니라면 드라이버 `evaluate` 없이 얻을 수 없으므로,
`BrowserDriver` 액션 답에 `{ url, title }` 을 얹는 **작은 계약 확장**을 한다 —
`PreviewAxNode[]` → `{ url: string; title: string; snapshot: PreviewAxNode[] }`. 옛 모양을
받는 호출자는 `server.ts` 뿐이다.

**C-3 안정 ref (데스크톱).** `PageState.refs: Map<string, number>` 옆에
`refOfNode: Map<number, string>` 을 둔다. `axTree` 는 `refs.clear()` 대신 이번 트리에
없는 노드만 지우고, 있는 노드는 `refOfNode.get(backendId) ?? 새 번호` 를 쓴다.
`refSeq` 는 지금처럼 단조 증가한다(옛 ref 가 새 노드를 가리키는 충돌은 지금 주석의
이유 그대로 막힌다). 비우는 자리는 문서가 갈릴 때 — 이미 있는 `:715` · `:728` 의
`refs.clear()` 자리에서 둘 다 비운다. `recover()`(`:1449`)도 같다.

**C-4 `browser_find` (데몬, 순수).** 새 도구:

```
browser_find { text?: string; role?: string; limit?: number }
→ 맞는 줄만 (한 줄 표기, 기본 10 · 최대 30)
```

`snapshot` op 를 부른 뒤 `findInSnapshot(nodes, query)` — 이름의 부분 일치(대소문자 무시)와
역할의 일치. 빈손이면 `맞는 요소가 없습니다 — browser_snapshot 으로 화면을 읽으십시오`.
새 op 는 없다 — `BROWSER_OPS` 에 `find` 를 더하고 `callBrowserOp` 가 `snapshot` 을 부른 뒤
데몬에서 거른다.

**C-5 설명 갱신.** `browser_snapshot` 설명에 `ref` · `maxLines` 인자를, 액션 도구 설명의
"새 스냅샷을 돌려준다" 를 "바뀐 줄의 요약을 돌려준다" 로.

**시험**(`test/browser-snapshot.test.ts`, 순수): 접기 · 상한과 마지막 줄 · 부분 트리 ·
값과 상태의 표기 · 요약의 집합 차와 상한 · `findInSnapshot` 의 역할 · 이름 · 빈손.
안정 ref 는 Electron 이라 손 검증(§5) — 같은 버튼을 두 번 클릭할 때 두 번째 ref 가 첫
번째와 같은지.

**끝 조건**: 같은 화면에서 `browser_click` 의 답이 30줄을 넘지 않는다. 묶음 A 의
`browserMs` · `contextTokens` 로 전후를 비교해 표로 남긴다(§5.2).

### 3.D `screen_check` 확장 (M-5 인자)

**바꾸는 파일**: `browser-tools.ts` · `server.ts runScreenCheck` · `protocol/src/preview.ts`
`ScreenCheckReport`(선택 칸) · README 「턴 끝의 화면 확인」.

```
screen_check {
  route?: string;                       // 옛 인자 — 그대로 받는다
  routes?: string[];                    // 1 ~ 6 (MAX_GATE_SCREENS)
  viewport?: "mobile" | "tablet" | "desktop";   // 기본 desktop
  capture?: boolean;                    // 그림 한 장(긴 변 640) — 문제일 때만 싣는다
}
→ 화면마다 { url, settled, blank, errors[] } 텍스트 + capture 면 image 블록
```

- 창은 **한 번** 세운다 — `factory.forIsolated(previewUrl)` 을 만들고 화면마다 `open` 을
  이어 부른 뒤 마지막에 `destroy`. `inspectScreens`(`screen-gate.ts`) 가 이미 이 모양이라
  그 함수를 재사용한다 — 게이트와 판정이 갈라지지 않는 길이기도 하다.
- `viewport` 는 `driver.open(route, { viewport })` 로 — `PreviewOpenOptions` 가 이미 받는다.
- `capture` 는 문제(`!settled || blank || errors.length > 0`)인 화면에만 — 멀쩡한 화면의
  그림은 토큰만 태운다. 형식은 `image/webp`, MCP image 블록(`callBrowserTool` 의 스크린샷
  분기와 같은 길 — `payload.result.capture` 를 보게 한 줄 넓힌다).
- 결과가 여럿이면 `notePinned` 도 여럿. 상한을 넘는 `routes` 는 잘라서 답하고 마지막 줄에
  말한다.

**시험**: 순수 — 인자 정규화(`route` 와 `routes` 의 합집합 · 중복 · 상한 · origin 밖 거절)를
`normalizeScreenCheckArgs` 로 빼서 시험. `inspectScreens` 는 가짜 드라이버 시험이 있으면
`viewport` 전달을 한 줄 더한다.

**끝 조건**: 휴대폰 폭에서만 넘치는 화면을 AI 가 턴 안에서 잡아 고친다(손 검증 시나리오
§5.1 의 D-1).

### 3.E 새 도구 셋 (M-10)

#### E-1 `browser_inspect { ref }` — AI 가 스스로 핀을 찍는다

```
→ 요소: button "검색"  (컴포넌트: MemberSearch › SearchBar)
   testid: member-search  · 경로: main > section:nth-of-type(1) > form > button
   글자: 검색
   파일 후보: src/screens/member/MemberSearch.tsx · src/components/SearchBar.tsx
   파일 발췌 src/screens/member/MemberSearch.tsx 12-72줄: …
   스타일: color #0a0a0a · background #f3f4f6 · font 14px/20px
```

**데스크톱** — `BrowserDriver.inspect(ref) → ElementIdentity`.
- `preview-preload.ts:165` 의 `describeElement` 와 그 부품(`ownText` · `cssPath` ·
  `describeHtml` · `describeStyles` · `describeA11y` · `describeAttrs`)을 새
  `packages/desktop/src/element-identity.ts` 로 옮긴다. Electron import 가 없는 순수
  DOM 함수라 preload 와 드라이버가 함께 쓴다. 드라이버는 `resolveNode`(`:1548`) 로 얻은
  objectId 에 `Runtime.callFunctionOn` 으로 그 함수 소스를 건넨다(`rectOfRef` `:1489` 와
  같은 방식).
- React owners 는 `preview-view.ts:66` `OWNER_SCRIPT` 를 **요소를 `this` 로 받는** 모양으로
  고쳐 같은 상수를 두 자리(핀 relay · inspect)가 쓴다 — 핀은 지금처럼 `data-colo-pick`
  으로 요소를 찾아 그 함수를 부르고, inspect 는 objectId 로 부른다. 메인 월드 실행이
  필요하므로 `executeJavaScript(…, true)` 가 아니라 `Runtime.callFunctionOn` 에
  `executionContextId` 를 메인 월드로 준다(격리 preload 는 fiber 를 못 본다 — 주석 그대로).
- 답 모양은 `ColoDesignCommentTarget` + `owners` — 핀 봉투의 `element` 와 같다. 새
  타입을 만들지 않는다.

**데몬** — `BROWSER_OPS.inspect` 를 더하고 `callBrowserOp` 뒤에 `enrichIdentity`:
- `huntPinFiles(root, [{ id: ref, text, owners, testId, screen }])`(`pin-files.ts:205`) 로
  후보, 정확한 적중이면 `excerptLines`(지금 private — export) 로 발췌. `observedFilesFor`
  는 정체가 빈손일 때만(핀 턴과 같은 순서).
- 이 요소가 사는 화면을 `notePinned` 에 적는다 — 조사한 화면은 이 턴의 화면이다.
- 결과는 파일 경로를 싣는다 — 이 도구의 독자는 AI 다(사용자 면이 아니다). 공통 규칙이
  답변에 경로를 쓰지 말라고 가르치므로 화면에는 새지 않는다.

**시험**: 순수 — `enrichIdentity` 를 가짜 정체 · 임시 클론으로(`pin-files` 의 시험이
쓰는 fixture 그대로). 드라이버는 손 검증.

#### E-2 `screen_files { route, title? }` — 화면 이름으로 파일 찾기

```
→ 파일 후보: src/screens/member/MemberList.tsx · src/screens/member/MemberList.mock.ts (관찰)
   파일 후보: src/routes.tsx (글자 "회원 목록")
```

데몬만 — pane 이 없어도 돈다(브라우저 개발 경로 · 준비 중에도). `observedFilesFor(projectRoot,
repoRoot, route)` 가 먼저, `title` 이 있으면 `huntPinFiles` 에 `{ text: title }` 힌트로 한 번
더. 후보 합쳐 상한 6. 빈손이면 `이 화면을 고친 기록이 아직 없습니다` — 오류가 아니다.

`projectRoot` 는 `workspaceOfSession(sessionId)` 의 것 — 활성 프로젝트가 아니라 세션의
프로젝트(게이트와 같은 이유).

**시험**: 순수 — 임시 `screen-map.jsonl` 과 클론으로 관찰 · 글자 · 빈손 · 상한.

#### E-3 `notify_developer { title, what, ask }` — 개발자에게 쪽지

공통 규칙 "꼭 필요하면 이유를 적어 개발자에게 묻는다(사용자에게 묻지 않는다)" 가 처음으로
길을 얻는다.

- 데몬만. `DeveloperNotice.raise({ key: "agent:" + hash(title), slug, title, what, tried:
  "AI 가 대화 안에서 시도한 것 — 답변 참조", ask, detail: 세션 제목 })`
  (`developer-notice.ts:350`). 열린 요청이 있으면 그 PR 코멘트, 없으면 이슈 — 지금의 길
  그대로다.
- 예산: `budgets.ts` 의 `BUDGETS` 에 `agentNotice: { max: 3, windowMs: 24 * 60 * 60_000 }`.
  세는 원장은 프로젝트의 `cycle.json` `budgets`(같은 모양). 다하면 결과가
  `오늘은 더 보낼 수 없습니다 — 답변에 이유를 적어 두십시오` 이고 `isError` 는 아니다.
- 결과 문장: `개발자에게 알렸어요` / `개발자에게 닿지 못했어요 — 답변에 이유를 적어
  두십시오`(via `none`). 상태 줄의 문제 문장은 세우지 않는다 — 그것은 도구가 스스로
  발견한 문제의 자리다(README 「화면의 문제 문장은 셋이다」).
- 화이트리스트 `BROWSER_OPS.notifyDeveloper`. pane · 검증 창 모두 필요 없다.
- 실림 조건은 없다(제출 도구와 달리 lifecycle 스위치 없음) — 예산이 울타리다.

**시험**: 순수 — `developer-notice.test.ts` 의 가짜 GitHub 로 raise 한 번, 같은 제목
두 번째는 중복(`inFlight` · 10분 창), 예산 넷째 호출의 문장.

#### E-4 보류 — `note_screen { route, title }`

`cycle-screens.ts` 가 답변의 `[제목](주소)` 를 정규식으로 긁는 것을 대체하는 도구. 링크
규칙은 사용자가 누르는 문이라 남겨야 하고, 그러면 AI 는 같은 사실을 두 번 말하게
된다. 지금 링크 파싱이 실제로 빗나간 사례가 통계에 없다 — 사례가 생기면 연다(§6).

### 3.F 지침 · README (M-11)

- `common-instructions.ts` `COMMON_INSTRUCTIONS`:
  - `screen_check` 불릿에 "휴대폰 폭도 한 번 본다(`viewport: "mobile"`)" 와 "문제가 있으면
    `capture` 로 그림을 본다" 를 잇는다.
  - 새 불릿: `- 화면의 요소를 다시 읽을 때는 필요한 부분만 읽는다 — browser_find 로 찾고
    browser_inspect 로 조사한다. 화면 전체 읽기(browser_snapshot)는 처음 한 번과 화면이
    통째로 바뀌었을 때만.`
  - "꼭 필요하면 이유를 적어 개발자에게 묻는다" 를 `notify_developer` 도구로 묻는다로.
    하루 세 번의 예산을 한 줄로 말한다.
  - 새 불릿은 `- ` 한 줄 형식을 지킨다 — `stripCommonInstructions` 가 그 모양만 규칙으로
    센다(파일 머리 주석).
- `browser-mcp.ts` `serverInfo.version` 에 앱 버전. 데몬은 지금 앱 버전을 모른다
  (`versions.ts` 는 비교 도우미뿐) — `DaemonConfig.appVersion?` 을 더해 데스크톱이
  `app.getVersion()` 을, `pnpm dev:daemon` 이 데몬 package.json 의 값을 넣고,
  `browserMcpEntry` 가 env `COLO_APP_VERSION` 으로 자식에 실어 준다. 없으면 지금처럼 `"0"`.
  `instructions` 에 "스냅샷은 필요할 때만" 한 문장.
- `browser_wait` 의 답: `false` 를 `조건을 N초 안에 만족하지 못했습니다` 텍스트로(`isError`
  아님 — 기다림의 실패는 오류가 아니라 사실이다).
- README: `:402-403`(omp 의 host tool 문단 — 도구 수 · 새 도구 이름), `:614-617`
  (`screen_check` — "스냅샷 없음" 을 "그림은 문제일 때만, 폭은 골라서" 로), 「턴 통계」 표의
  `browserMs` · `browserFail`, 「개발자 알림」 에 AI 의 쪽지 한 줄(예산 포함).

---

## 4. 왜 서버는 하나인가 (M-1)

| 대안 | 값 | 비용 |
|---|---|---|
| `colo-browser` 하나에 도구를 더한다 | relay · 시크릿 · 자식 프로세스 · omp host tool 목록이 그대로. `browserTools()` 한 곳 | 이름이 "browser" 인데 `screen_files` · `notify_developer` 가 산다 — 이름의 어색함뿐 |
| `colo-project` 를 둘째 stdio 서버로 | 이름이 맞다 | 세션마다 프로세스 하나 더, 시크릿 발급 · 회수 두 벌, Codex `mcp_servers` · Claude `mcpServers` · omp `set_host_tools` 세 자리 모두 두 배. RENAME 계획의 이름 사전에 항목 하나 더 |

이름의 어색함은 `serverInfo.title`(`콜로디자인 인앱 브라우저`) 을 `콜로디자인 도구` 로 바꾸는
것으로 푼다. 이미 `screen_check` · `submit_for_review` 가 브라우저가 아닌 채 여기 산다.

---

## 5. 검증

### 5.1 손 검증 (`pnpm dev:desktop`, fixture 레포)

| # | 시나리오 | 기대 |
|---|---|---|
| A-1 | omp 로 화면 하나 고치고 `screen_check` 가 불린 턴 | `turn-stats` 행의 `tools.browser ≥ 1`, `browserMs` 가 숫자 |
| B-1 | 새 화면을 만들고 AI 가 `screen_check` 만 부른 턴 | 「이번 작업」 에 그 화면, 작업 기록 둘째 줄에도 |
| B-2 | "개발자에게 보내 줘. 한마디는 '주말에 봐 주세요'" | 영수증에 한마디, PR 본문 `> 한마디:` |
| C-1 | 검색창에 글자를 치는 턴 | `browser_fill` 의 답이 30줄 이내, `+`/`−` 줄이 목록의 변화를 말한다 |
| C-2 | 같은 버튼을 두 턴에 걸쳐 누른다 | 두 번째 클릭이 첫 번째의 ref 를 그대로 써서 성공 |
| C-3 | 300개 넘는 목록 화면에서 `browser_snapshot` | 400줄에서 잘리고 마지막 줄이 남은 수와 부분 읽기를 말한다 |
| D-1 | 휴대폰 폭에서만 넘치는 카드 | `screen_check { viewport: "mobile", capture: true }` 뒤 AI 가 고친다 |
| E-1 | 핀 없이 "머리 부분 글씨가 너무 커" | AI 가 `browser_find` → `browser_inspect` → 편집. 통계 `pinHit` 는 그대로 null(핀 턴이 아니다) |
| E-2 | "회원 목록 화면의 빈 상태 문구 바꿔 줘"(핀 없음) | 첫 도구가 `screen_files`, 첫 편집이 그 후보 안 |
| E-3 | AI 가 새 의존성이 필요하다고 판단하는 요청 | 락파일을 건드리지 않고 `notify_developer` — PR 코멘트 또는 이슈에 쪽지, 넷째부터는 예산 문장 |

### 5.2 잣대 — 묶음 C 의 전후 비교

같은 fixture, 같은 프롬프트 다섯 개(검색창 · 상세 화면 · 폼 · 목록 정렬 · 빈 상태)를 C
전과 후에 omp · swe-2 로 한 번씩 돌려 `turn-stats` 에서 뽑는다.

| 잣대 | 어디서 | 기대 |
|---|---|---|
| 턴당 브라우저 호출 | `tools.browser` | 줄거나 같다 |
| 턴의 컨텍스트 토큰 | `contextTokens` | 브라우저 호출이 같은 턴에서 눈에 띄게 준다 |
| 브라우저에 쓴 시간 | `browserMs` | 준다 |
| 낡은 ref 실패 | `browserFail.stale-ref` | 0 에 가깝다 |
| 첫 편집까지 | `firstEditMs` | 핀 없는 E-2 시나리오에서 준다 |

수치는 이 문서의 §1.1 표 아래에 덧붙인다 — 계획서가 성적표를 품는다.

### 5.3 자동

- `pnpm test` — 새 순수 시험: `browser-snapshot`(렌더 · 요약 · 찾기), `browser-tools`
  (relay 여섯 경우 · 악수 · 이름 판정 · 실패 분류 · 인자 정규화), `pin-files`(inspect 의
  보강), `screen-files`, `developer-notice`(예산).
- `pnpm typecheck` · `pnpm build` — CI 의 문 그대로.
- `next-labels` · `vocab-sweep` 은 건드릴 것이 없다 — 이 계획은 사용자 면에 문장을 더하지
  않는다.

---

## 6. 열린 항목

| # | 항목 | 여는 조건 |
|---|---|---|
| O-1 | `note_screen` 도구(§3.E-4) | 답변 링크 파싱이 빗나가 「이번 작업」 에 제목이 비는 사례가 통계 · 로그에 보일 때 |
| O-2 | `colo-cds` 디자인 시스템 조회 서버 | `@colosseumcoinckr/cds` 의 설치본에서 컴포넌트 · props 를 읽어 주는 읽기 전용 도구. 근거: `pin-files` 는 `node_modules` 를 건너뛰고, 레포 CLAUDE.md 는 다섯 개만 적으라 한다. 캐시 키는 락파일 해시. AI 가 `node_modules` 를 뒤지는 시간이 `firstEditMs` 에서 보일 때 |
| O-3 | AI 쪽지의 대화 카드 | `notify_developer` 의 결과를 대화록이 카드로 그리는 일(지금은 도구 결과 텍스트뿐). 사용자가 "개발자에게 뭐라고 했어?" 를 물을 때 |
| O-4 | `browser_inspect` 의 Vue · Svelte owners | `OWNER_SCRIPT` 는 React fiber 만 안다. 연결 레포가 React 가 아닌 사례가 생길 때 |
| O-5 | 액션 요약의 `before` 를 세션 재개 뒤에도 잇기 | 지금은 데몬 메모리 — 재시작 뒤 첫 액션은 차이 없이 요약만. 불편이 보고될 때 |

---

## 7. 이 계획 밖 — 조사 중에 본 것

- **게이트 턴 7건이 0.5초 안에 실패**(9/25, `claude-opus-5-5[1m]`, `fail=other`,
  `tools` 전부 0). 게이트 브리프가 그 모델에서 돌지 않았을 가능성 — MCP 와 무관하나 따로
  봐야 한다. `turn-stats-2026-09-25.jsonl` 의 `kind: "gate"` 행.
- **`RENAME-NOVA-PLAN.md`** 가 `colo-browser` 이름과 `mcp__colo-browser__*` 접두를 바꿀
  수 있다. 이 계획의 코드는 `BROWSER_MCP_SERVER_NAME` 상수만 본다(§3.A-1) — 어느 쪽이
  먼저 합쳐져도 충돌은 상수 한 줄이다.
- 옛 `PLAN.md` · `PLAN-UI.md` 는 `5dfe2a65` 에서 걷혔다. 이 문서는 그 번호 체계(L · O · U)를
  잇지 않고 `M-` 로 새로 센다.
