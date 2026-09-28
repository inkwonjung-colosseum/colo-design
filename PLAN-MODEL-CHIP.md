# PLAN-MODEL-CHIP — 모델 칩 · AI 고르기 · 빠르게 토글

2026-09-28. 구현 전 설계. 실사 결함 셋(AI 를 바꿔도 모델 목록이 안 바뀜 · 빠르게 토글이
안 섬 · 빠르게의 비용 안내가 네이티브 `title` 이고 문장이 틀림)을 한 뿌리에서 고친다.

## 0. 결정

- **D1 — AI 는 대화가 태어나기 전에만 고른다.** 열린 대화의 칩 팝에는 AI 고르기가 없다.
  다음 대화의 AI 는 홈의 칩 · 새 대화 빈 자리의 칩 · 설정의 AI 카드, 세 곳에서 고르고
  셋은 같은 값(`chat.provider`)의 세 얼굴이다.
- **D2 — 칩은 주인을 명시한다.** `next`(다음 대화) 와 `session`(열린 대화) 둘 중 하나.
  `next` 는 열린 대화를 절대 건드리지 않는다.
- **D3 — Claude 도 세션 없이 모델 목록을 읽는다.** 데몬이 이미 가진 probe(명령 목록 ·
  요금제 사용량과 같은 기계)로 `supportedModels()` 를 한 번 묻는다.
- **D4 — 빠르게 툴팁은 `components/Tip`** 이고 문장은 Claude Code 공식 문서(fast-mode) 기준이다.
- **안 하는 것** — 쿨다운의 회색 번개(선로에 새 칸이 필요, 다음 차례), Codex 의 세션 없는
  목록(Codex 는 빠르게가 없다), 선로 버전 올리기(v19 그대로).

## 1. 지금의 결함과 근거

| # | 증상 | 원인 |
| --- | --- | --- |
| 1 | 홈에서 AI 를 Claude 로 바꿔도 모델 목록이 omp 것 | `홈` 은 `dispatch({type:"home"})` 만 하고 `sessions.fresh()` 를 부르지 않는다(`next/lib/use-shell-nav.ts:159`). 대화 칸은 `nx-offstage` 로 숨을 뿐 `activeId`·`selector` 가 살아 있어, 홈의 칩이 AI 체크는 설정(`chatProvider`)에서, 모델 목록은 숨은 세션의 `selector.models` 에서 읽는다(`chat/ModelChip.tsx:77-80`). 스크린샷의 `anthropic/claude-…` 힌트는 omp 카탈로그의 `description: value` 형식(`omp/catalog.ts:100`) |
| 1' | 홈에서 고른 모델이 숨은 대화에 들어감 | `switchModel` 이 `if (!activeId) return` 을 통과해 숨은 세션에 `api.setModel` 을 쏘고, 핀은 `selector.provider`(omp) 아래 적힌다(`hooks/useSessions.ts:960-972`) |
| 2 | 빠르게 토글이 홈에 안 섬 | `fastShown` 이 `pickMode = activeId === null` 로 갈라지는데 홈은 위 이유로 pickMode 가 아니라 `variant === "thread"` 조건에 걸린다(`chat/Composer.tsx:311-317`) |
| 2' | 첫 Claude 대화 전에는 어디에도 안 섬 | 토글은 `row.supportsFastMode === true` 인 행을 요구하는데 Claude 는 세션 없는 목록이 없어(`listModels` 는 omp 만, `server.ts:796`) 행 자체가 없다 |
| 3 | 툴팁이 느리고 포커스에 안 뜸 | 네이티브 `title`(`chat/Composer.tsx:583`) |
| 3' | 문장이 사실과 다름 | `사용량은 약 2배 빨리 닳아요` — 공식 문서: 구독(Pro/Max/Team) 의 빠르게는 요금제 사용량에 포함되지 않고 **사용량 크레딧(추가 결제)** 에서 빠지며, 남은 사용량이 있어도 그렇다. 단가는 표준의 약 2배(Opus 5.5 $8/$40 · Opus 5 · 4.8 $10/$50). 대화 중간에 처음 켜면 그때까지의 대화 전체를 한 번 더 빠르게 단가로 계산한다. 지원 모델은 Opus 5.5 · 5 · 4.8 뿐이고 SDK `ModelInfo.supportsFastMode` 가 행마다 말한다 |

## 2. 데몬 — Claude 의 세션 없는 모델 목록 (D3)

이미 있는 기계를 그대로 쓴다. `claude/session.ts` 의 `probeQuery`(프롬프트를 절대 내지 않는
`query()`) + `askProbe`(20초 유예 · 데몬 종료 신호) 가 `probeCommands` · `probePlanUsage` 를
돌리고 있다. 말을 보내지 않으므로 사용량은 들지 않고, 실행당 claude 프로세스 부팅 한 번이
비용이다.

- `claude/session.ts`
  - `Session.models()` 의 행 변환(`ModelInfo → SessionModelInfo`, `supportsFastMode ?? false`,
    `isAmbientModelEcho` 거르기)을 `toModelRows(models, pinned)` 로 뽑아 둘이 같이 쓴다.
  - `export async function probeModels(options: { cwd; executable; signal? }): Promise<SessionModelInfo[]>`
    — `askProbe(options, run => run.supportedModels())`. 답이 없으면 `[]`(`probePlanUsage` 와
    같은 삼킴 — 빈 목록은 아래 캐시가 무시한다).
- `agent/driver.ts` — `listModels?(opts: { cwd: string; signal?: AbortSignal })`. 덧붙이는
  인자라 omp 는 무시한다. 주석의 "Absent = a live session is the only source (Claude, Codex)" 를 Codex 만으로 고친다.
- `claude/driver.ts` — `listModels(opts)` → `probeModels({ cwd: opts.cwd, executable: this.executable(), signal: opts.signal })`. 실행 파일이 없으면 `[]`.
- `server.ts:796-800` — `read: () => driver.listModels!({ cwd: probeCwd(), signal })`. `probeCwd` 는
  PlanTracker 에 이미 넘기는 클로저와 같은 것(활성 클론, 없으면 홈).
- `plan-tracker.ts:103-112` — `catalogRead` 를 읽기 **성공 뒤에** 표시한다(지금은 읽기 전에
  표시해 실패하면 그 실행 내내 다시 묻지 않는다). 빈 답도 실패다 — 로그인 전에 뜬 데몬이
  로그인 뒤에 다시 묻게 된다. `refreshModels()` 는 `status()` 마다 불리므로 셋을 지킨다:
  ① 도는 읽기가 있으면 또 띄우지 않는다(in-flight) ② 실패 · 빈 답 뒤에는 5분이 지나야 다시
  묻는다(로그인 안 된 기계가 방송마다 claude 를 띄우지 않게) ③ 성공은 실행당 한 번.
  이 판단은 순수한 문지기 `CatalogGate`(`shouldRead(provider, now)` · `started` · `settled(provider, ok, now)`)
  로 뽑아 export 한다 — `PlanTracker` 는 생성자가 `~/.colo-design/config` 를 읽고 쓰므로 시험은
  문지기만 잰다. `rememberModels` 의 빈 목록 무시는 그대로.
- 결과는 `model-catalog.json` 과 `DaemonStatus.modelsByProvider.claude` 로 흘러, 웹의 `next`
  타깃이 첫 대화 전에도 Claude 행(빠르게 지원 여부 포함)을 갖는다.

## 3. 웹 — 칩의 주인 `ChipTarget` (D2)

### 3.1 모양

```ts
// hooks/useSessions.ts
export interface ChipTarget {
  subject: "next" | "session";
  /** 낙관 상태의 열쇠 — session 은 대화 id, next 는 `next:<provider>` */
  key: string;
  provider: string;
  model: string | null;
  effort: EffortLevel | null;
  fastMode: boolean;
  fastModeBlocked: string | null;
  models: SessionModelInfo[];
  setModel(model: string | null): Promise<void>;
  setEffort(effort: EffortLevel | null): Promise<void>;
  /**
   * session 은 데몬이 답한 상태, next 는 저장된 선택. `key` 는 답한 주인의 열쇠 — 되살린
   * 대화는 새 id 일 수 있어 누른 순간의 `target.key` 와 다를 수 있다. null = 못 했음.
   */
  setFast(on: boolean): Promise<{ on: boolean; blocked: string | null; key: string } | null>;
}
```

`Sessions` 는 `chipTarget(subject): ChipTarget` 를 내놓고, `selector` · `setModel` · `setEffort` ·
`setFastMode` · `setFastPick` · `pickProvider` · `chatProvider` 는 걷는다. 남는 소비자는 셋뿐이다 —
`ModelChip` · `Composer` · `ChatColumn.tsx:176`(프로바이더 한 줄 — session 타깃의 `provider`).

### 3.2 `next` 타깃

- `provider = chat.provider`, `model = chat.model`, `effort = chat.effort`, `fastMode = chat.fastMode`, `blocked = null`.
- `models` = 로컬 캐시(`loadModelCatalog(chat.provider)`, 이미 `chat.provider` 가 바뀔 때마다
  갈아끼운다 `useSessions.ts:346-348`) → `daemon.status.modelsByProvider[chat.provider]` → `[]`.
- `setModel/setEffort/setFast` = `onChatChange(withChatPick(chat, chat.provider, …))` 뿐. 세션에
  닿는 길이 없다. `setFast` 는 `{ on, blocked: null, key }` 로 답한다.
- `pickProvider(id)` 는 `next` 에만 있다 — `switchProviderPatch`(설정 카드와 같은 함수).

### 3.3 `session` 타깃

- `selector`(없으면 `provider = chat.provider`, 나머지 빈 값 — 선택자가 오기 전의 잠깐)에서 읽는다.
- `setModel/setEffort` — 지금의 `switchModel/switchEffort` 그대로: 낙관 적기 → `liveTarget()` →
  `api.*` → 거절이면 되돌림. `withChatPick(chat, selector.provider, …)` 도 그대로 남긴다 — 열린
  대화에서 고른 모델이 같은 AI 의 다음 대화 기본값이 되는 지금 동작을 지킨다.
- `setFast(on)` — `liveTarget()` → `api.setFastMode` → `api.selectors(target)` → `applySelectors`
  → `{ on: next.fastMode, blocked: next.fastModeBlocked, key: target }`. 되살리지 못하면 `null`.

### 3.4 걷어내는 효과 둘

- **`pushed` 효과(`useSessions.ts:1023-1038`)** — 설정 대화상자가 모델·생각 시간을 고치던 시절의
  다리인데 설정에는 이제 AI 카드만 있다. 남겨 두면 홈에서 고른 `next` 값이 같은 AI 의 숨은
  대화로 밀려 들어가 D2 를 깬다.
- **씨앗 효과(`useSessions.ts:1050-1108`)** 는 `next` 만 본다 — `chat.model` 이 비어 있고
  `next.models` 가 생기는 순간 첫 행(프로젝트 기본값 우선)을 `next.setModel` 로. 생각 시간도
  같다. 프로바이더당 한 번 가드는 그대로. 열린 대화는 이미 모델을 가지고 있으니 씨앗이 필요 없다.

### 3.5 부르는 쪽

- `Composer` 에 `subject` prop. `HomeComposer` 는 언제나 `"next"`(홈의 보내기는 늘
  `sessions.create()` 로 새 대화를 연다). `ChatColumn` 은 `activeId ? "session" : "next"`.
- `Composer` 의 `pickMode` 분기 · `fastAck.sessionId` 는 `target.key` 하나로 접힌다.
- `ModelChip` 은 `target` 과 `providers`(`disabledProviders` 거른 뒤) 를 받는다.

## 4. 모델 칩 팝 (D1)

| 칸 | `next` | `session` |
| --- | --- | --- |
| AI (쓸 수 있는 AI 가 둘 이상일 때만) | 지금처럼 고르는 줄. 체크 = `target.provider`. 아래 한 줄 `L.model.aiNext` — `보내면 이 AI 로 대화가 열려요` | 고르는 줄 없이 **한 줄만**: `<b>Claude</b> <small>이 대화의 AI 예요 · 다른 AI 는 새 대화에서 골라요</small>`(`L.model.aiFixed`) |
| 모델 · 생각 시간 · 사용량 | `target` 에서 | `target` 에서 |
| `fastMissing` 안내 | 행이 빠르게를 안 받을 때 | 같다 |

`next` 에서 AI 를 고르면 팝은 **닫히지 않는다** — 거르는 칸을 비우고, 바로 아래 모델 칸이 새 AI 의
목록으로 바뀌는 것을 보인 채 모델을 이어서 고르게 한다(이 결함의 증상이 "AI 를 바꿨는데 모델이
안 바뀐다" 였다). 팝을 닫는 것은 모델 행을 누를 때 · 바깥 · Esc 뿐이다.

`L.model.openConvNote` 는 쓰는 곳이 없어지므로 지운다(`next-labels.test.ts` 의 불리지 않는 칸
검사가 잡는다).

## 5. 빠르게 토글 — 규칙 · 툴팁 · 문장 (D4)

### 5.1 보이는 규칙 — 순수 함수

```ts
// next/lib/thread.ts
export function fastChip(input: {
  capability: boolean;                        // providers[].capabilities.fastMode === true
  row: { supportsFastMode: boolean } | undefined; // target.models 에서 target.model 의 행
  on: boolean;                                // target.fastMode
}): boolean {
  return input.on || (input.capability && (input.row ? input.row.supportsFastMode : true));
}
```

- 켜져 있으면 언제나 보인다(끌 길은 남긴다 — omp 의 `-fast` 변종으로 도는 대화가 이 경우).
- 행을 모르면(아직 목록이 없을 때) 프로바이더 능력으로 보인다 — D3 뒤에는 Claude 도 거의
  늘 행이 있어 이 낙관은 선택자가 오기 전 잠깐뿐이다.
- 홈 · 대화 칸 · 두 주인 모두 같은 규칙. `variant` 로 가르던 것을 없앤다.

### 5.2 툴팁 — `components/Tip`

- 번개 버튼을 `<Tip label={card} side={variant === "thread" ? "top" : "bottom"} align="end" bubbleClass="nx-fast-tip">` 로 감싸고 `title` 은 뗀다. Tip 은 새 셸의 사이드바가 이미 쓰는
  포털 툴팁이라(`sidebar/ConversationList.tsx:227`) 자르는 상자를 벗어나고 포커스에도 뜨며 자리가
  없으면 반대쪽으로 뒤집힌다.
- 카드는 두 줄 — 제목 한 줄, 비용 한 줄(경고 색). **말풍선은 `document.body` 의 포털이라 `.nx`
  밖에 산다** — 선택자는 `.nx .…` 가 아니라 맨 `.nx-fast-tip` 이고, 색은 `.nx` 가 정의하는
  `--amber` · `--ink` 가 아니라 `:root` 의 것(`styles.css` 의 `--warn` · `--text` · `--muted`)을 쓴다.
  `chat.css` 에 `.nx-fast-tip`(최대 폭 280px, `b` 는 블록 한 줄, `small` 은 `--warn`)만 더한다.
- 문장은 순수 함수가 고른다:

```ts
/** thread.ts 는 labels 를 부르지 않는다 — 문장의 모양만 적고 `L.fast` 가 이 모양을 채운다. */
export interface FastWords {
  offTitle: string; nextTitle: string; onTitle: string;
  costClaude: string; costMidway: string; costOmp: string; costOther: string;
  blocked: FastBlockedWords;
}
export interface FastBlockedWords {
  creditsGone: string; credits: string; org: string; orgModels: string;
  network: string; evaluation: string; cooldown: string;
}
export function fastTipWords(
  state: { subject: "next" | "session"; on: boolean; blocked: string | null; provider: string },
  words: FastWords,
): { title: string; note: string | null }
```

| 상태 | 제목 | 비용 줄 |
| --- | --- | --- |
| 꺼짐 · `next` | `다음 대화부터 빠르게 — 같은 모델이 더 빨리 답해요` | 프로바이더별 비용 |
| 꺼짐 · `session` | `빠르게 — 같은 모델이 더 빨리 답해요` | 프로바이더별 비용 + Claude 는 `대화 중간에 켜면 지금까지의 대화도 한 번 더 계산해요` |
| 켜짐 | `빠르게 켜짐 · 누르면 꺼요` | 프로바이더별 비용 |
| 막힘(`blocked`, session 만) | `fastBlockedWords(blocked)` | 없음 |

프로바이더별 비용 줄:

- `claude` — `요금제 사용량과 별도로 사용량 크레딧에서 빠져요 · 같은 답에 약 2배`
- `omp` — `빠른 변종 모델로 답해요 · 사용량이 더 빨리 닳을 수 있어요`
- 그 밖 — `사용량이 더 빨리 닳아요`

### 5.3 막힌 이유의 한국어 — `fastBlockedWords(reason, words)`

데몬은 CLI 의 `fast_mode_disabled_reason` 영어 원문을 그대로 나른다. 단서로 가르고, 모르면 원문.

| 원문 단서 | 문장 |
| --- | --- |
| `usage credits` + `exhausted` | `사용량 크레딧이 다 떨어져 보통 속도로 답해요` |
| `usage credits` | `사용량 크레딧을 켜야 빠르게를 쓸 수 있어요 — claude.ai 설정 → 사용량` |
| `organization` | `조직 설정이 빠르게를 막아 두었어요` |
| `allowed models` | `조직이 허용한 모델에 빠르게 모델이 없어요` |
| `network` · `connectivity` | `연결 문제로 지금은 빠르게를 쓸 수 없어요` |
| `evaluation` | `평가 플랜에서는 빠르게를 쓸 수 없어요` |
| `cooldown` · `rate limit` | `빠르게 한도에 닿아 잠시 보통 속도로 답해요 · 풀리면 저절로 다시 켜져요` |

`fastToast` 의 거절 가지도 같은 함수를 지난다(지금은 원문이 토스트에 그대로 선다) —
`say` 에 선택 칸 `blocked?: FastBlockedWords` 를 더하고, 있으면 `fastBlockedWords(reason, say.blocked)`,
없으면 지금처럼 원문. 선택 칸이라 부르는 쪽을 고치기 전에도 타입이 맞는다.

### 5.4 문장 — `labels.ts`

`composer.fast*` 를 `L.fast` 묶음으로 옮긴다: `name`, `offTitle`, `nextTitle`, `onTitle`,
`costClaude`, `costMidway`, `costOmp`, `costOther`, `blocked.{creditsGone,credits,org,orgModels,network,evaluation,cooldown}`,
`toastOn(cost)`(`빠르게 켜졌어요 · ${cost}` — 켜는 순간 한 번은 비용을 말한다), `toastOff`, `toastFail`.
`model.aiNext` · `model.aiFixed` 를 더하고 `model.openConvNote` 를 지운다. 금칙어(턴 · 경로 · git ·
데몬 · 커밋 · 브랜치 · PR)는 없다.

## 6. 시험

- `web/test/next-thread.test.ts` — `fastChip`(켜짐 · 능력 없음 · 행 없음 · 행이 거절), `fastTipWords`(next/off · session/off · on · blocked × claude/omp/그 밖), `fastBlockedWords`(단서 일곱 + 원문 폴백), `fastToast` 의 거절 가지가 한국어를 지나는지.
- `web/test/next-labels.test.ts` — 자동(지운 칸 · 새 칸 · 금칙어).
- `web/test/chat-settings.test.ts` — 그대로(`withChatPick` · `switchProviderPatch` 는 안 바뀐다).
- `daemon/test/claude-model-rows.test.ts` — `toModelRows`: `supportsFastMode` 기본 `false`, ambient echo 거르기.
- `daemon/test/plan-tracker-catalog.test.ts` — 실패한(빈) 읽기는 다음 `refreshModels()` 에 다시 묻고, 성공한 읽기는 실행당 한 번이다(가짜 source 로).
- 눈으로(`pnpm dev:desktop`): omp 대화를 연 채 홈 → AI 를 Claude 로 → 목록이 Claude 행 · 칩 앞말이 Claude 모델 · 숨은 omp 대화의 모델이 그대로인지(대화로 돌아가 칩 확인). Opus 행에서 번개가 서고 Sonnet 행에서 사라지며 팝에 `fastMissing` 이 서는지. 번개에 마우스 · Tab 포커스로 카드가 뜨는지. 열린 대화의 팝에 AI 고르기 대신 한 줄이 서는지. 새 기계(캐시 지움) 첫 실행 홈에서 Claude 행이 probe 로 오는지.

## 7. 문서

- `README.md` 사용 안내 §5 — `빠르게` 문장에 비용의 진실 한 조각(요금제와 별도 · 사용량 크레딧). 상세 동작의 프로바이더 문단에 "AI 는 대화가 태어나기 전에만" 과 Claude probe 목록 한 줄.
- `packages/web/src/next/README.md` — 입력창 줄에 `subject`(next · session).
- `packages/daemon/src/agent/driver.ts` 의 `listModels` 주석.

## 8. 묶음과 순서

| 묶음 | 물결 | 맡는 것 | 파일 | 모델 |
| --- | --- | --- | --- | --- |
| A | 1 | §2 데몬 probe + 시험 | `claude/session.ts` · `claude/driver.ts` · `agent/driver.ts`(주석 · 시그니처) · `server.ts`(catalogSources 자리만) · `plan-tracker.ts` · 새 시험 둘 | GLM 5.3 flash |
| B | 1 | §3 `ChipTarget` · §4 팝 · 빠르게 버튼의 새 주인(§5.1 규칙은 식으로 제자리에) | `hooks/useSessions.ts` · `chat/ModelChip.tsx` · `chat/Composer.tsx` · `home/HomeComposer.tsx` · `chat/ChatColumn.tsx` · `labels.ts`(`model.*` 칸만) | GLM 5.3 |
| C | 1 | §5.1~5.3 순수 함수 · 시험 · `.nx-fast-tip` | `next/lib/thread.ts`(파일 끝에 더하기 + `fastToast` 의 선택 칸) · `web/test/next-thread.test.ts` · `chat/chat.css`(파일 끝) | GLM 5.3 flash |
| D | 2 | §5.2 `Tip` 감싸기 · `fastChip` · `fastTipWords` 를 입력창에 · §5.4 `L.fast` 로 옮기기 · §7 문서 · 견본 `dev/chip-fixture` | `chat/Composer.tsx`(번개 자리) · `labels.ts`(`composer.fast*` → `fast`) · `README.md` · `next/README.md` | GLM 5.3(B 의 에이전트가 문맥을 이어 맡음) |

- 물결 1 의 셋은 같은 줄을 만지지 않는다. `labels.ts` 는 B 만(`model` 묶음), `Composer.tsx` 는 B 만,
  `thread.ts` · `chat.css` 는 C 만.
- D 는 A · B · C 를 합친 통합 브랜치에서 간다 — 실제로는 `chip-b` 를 통합 상태로 앞당겨 B 의 에이전트가 이어 했다(Composer 의 문맥이 그대로 있다).

## 9. 가장자리

- 선택자가 오기 전의 `session` 타깃: 칩은 AI 이름만, 번개는 능력으로 보였다가 선택자가 오면 정정된다.
- 행을 모른 채 `next` 에서 켜고 대화가 태어나면 Claude CLI 는 빠르게를 안 받는 모델에서 Opus 로 옮길 수 있다(문서의 동작). 태어난 뒤의 첫 선택자 읽기가 실제 모델을 보이고, D3 뒤에는 이 길이 거의 열리지 않는다.
- omp 는 `-fast` 변종 행을 접고(`keepFastValue`) 도는 변종만 남긴다 — 그대로.
- `disabledProviders` 는 `next` 의 AI 줄만 거른다 — 그대로.
- 프로젝트 전환 · 대화 삭제의 `setSelector(null)` 리셋은 `session` 타깃에만 닿고 `next` 는 설정을 따라간다.
