# 코멘트(핀) 기능 재설계 — 구현 상세 계획

- 날짜: 2026-09-14
- 대상: 미리보기 코멘트 핀 파이프라인 전체 — `packages/desktop/src/preview-preload.ts`(오버레이) · `preview-view.ts`(크롭·IPC) · `preload.ts` · `packages/protocol`(봉투·스키마·마커) · `packages/web`(전송·카드·기록) · `packages/daemon`(`comments.json`·PR 본문).
- 한 줄 결정: **핀은 첨부, 문장은 컴포저, 턴은 하나.** 오버레이는 가리키는 도구(피커)로 축소하고, 전송·영수증·재시도는 컴포저가 이미 가진 것을 쓴다.
- 근거가 된 레퍼런스(1차 문서): [Orca Design Mode](https://www.onorca.dev/docs/browser/design-mode) — 클릭한 요소가 HTML·computed CSS·크롭·소스 위치와 함께 채팅에 **첨부로** 떨어지고 문장은 사용자가 쓴다, 주석 트레이에 여러 개를 쌓아 일괄 전송. [ChatGPT/Codex 앱 Browser](https://learn.chatgpt.com/docs/browser?surface=app) — Annotation mode, 요소 클릭 **또는 드래그 영역**, 주석 저장 뒤 **일반 메시지로** 요청. [Claude Code Desktop](https://code.claude.com/docs/en/desktop) — `⌘⇧S` 요소 선택, diff 코멘트는 여러 줄에 달고 `⌘Enter`로 일괄 제출.
- 결정 번호는 `C1…`로 매긴다(코드의 `PLAN D-번호`와 충돌 방지). 본문의 `파일:줄`은 이 날짜의 작업트리 기준.

## 0. 결정 요약

| # | 결정 | 대체하는 현행 |
|---|---|---|
| C1 | 핀 하나 = 컴포저 첨부(`PinAttachment`) 하나. 웹이 핀 상태를 소유하고 오버레이는 그 투영(배지)이다 | 오버레이가 초안을 소유(`drafts`, preview-preload.ts:181) |
| C2 | 전송은 컴포저의 `submit` 한 곳. 핀 N개 + 문장 → 턴 1개 | 핀 에디터의 `⏎ 보내기`가 핀 하나를 즉시 턴으로(:626-631), 전송바가 배치로(:556-570) |
| C3 | 오버레이의 전송·영수증·복원·토스트 로직 삭제(`sendDrafts`/`pending`/`settle`/`SENT_ACK_MS`, `colo-overlay:sent`, `colo-overlay:busy`) | D35 영수증 왕복(ScreenPanel.tsx:517-522 → preview-view.ts:910-932 → :713-737) |
| C4 | 크롭은 **핀 찍는 순간** 1장(요소 rect) — "기획자가 본 것"이 그대로 첨부 썸네일·턴 이미지가 된다 | 전송 시점 재측정 후 크롭(:688-695, preview-view.ts:479-505) |
| C5 | 핀은 화면·라우트 전환·리로드에 살아남는다(웹 상태 + `sessionStorage`). 배지는 같은 화면에 있을 때만 그린다 | 화면 바뀌면 초안 삭제(:469-476, `pruneDrafts` :323-332) |
| C6 | 마커·`comments.json`·PR 본문 `### 수정 요청`·D88 답하기 경로는 **재사용**. 스키마는 아이템별 `screen/state`로만 바뀐다 | 배치 단위 `screen/state`(index.ts:535-536) |
| C7 | 턴 본문의 `json` fence 삭제 — 마커 + 목록이 이미 전부를 실는다 | preview-turns.ts:76 |
| C8 | 레포 코드 무개입(D68) 유지. 소스 위치(`data-colo-src`)만 3단계에서 **레포가 선택하는 규약**으로, 앱 주입이 아니라 부트스트랩 브리프로 안내 | — |
| C9 | 2단계: 드래그 영역 핀 + 캡처 강화(outerHTML·computed style·a11y·React owner 이름) | DOM 4필드(:76-85) |
| C10 | 4단계: 칩 의도(`수정`/`질문`) + 전송 후 턴 동안만 회색 고스트 배지. 해결 상태는 부활시키지 않는다(자동 정리 유지) | — |
| C11 | iframe(브라우저) 경로엔 오버레이를 만들지 않는다 — 설계 의도 유지(index.ts:1224-1228). "범용"은 **어떤 페이지든(래퍼 없는 페이지 포함) · 어떤 의도든** 가리킬 수 있음을 뜻한다 | — |
| C12 | 1단계는 단독 출시 가능해야 한다. 2~4단계는 1단계 계약 위에 필드만 더한다 | — |

## 1. 현재 구조 (as-is)

```
⌥+클릭 / 💬모드 클릭 ─▶ preview-preload.ts  describeElement(:76) {component,text,path,rect}
                        DraftPin{comment,editing} · draftEditor(:601) · 전송바(:556)
                        ⏎ 보내기 → sendDrafts(:678) → ipc colo-overlay:post {type:"colo-design.comments",batch,screen,state,items}
                        pins 숨김 + pending(batch) + 10s 타이머
        ─▶ preview-view.ts onOverlayPost(:557) → relayComments(:479): withOverlayHidden → 최대 6장 크롭 600px q70 → colo-preview:comments
        ─▶ NativeHost.tsx(:143) 빈 봉투 드롭 → ScreenPanel.forwardComments(:496): 이미지 추출, 제목 해석
        ─▶ PageWorkspace.forwardComments(:334): 스레드 없으면 화면 이름으로 생성 → sessions.sendTurn(turn, images)
        ─▶ preview-turns.commentsToTurn(:47): 마커 + 한국어 목록 + json fence
        ─▶ 영수증 commentsSent → preview:comments-sent → colo-overlay:sent → settle(:713): 토스트 / 실패 시 핀 복원
        ─▶ api.recordComments → server.ts comments.record(:1963) → comments.ts recordComments(:65) append(resolved:true)
카드: components.tsx MachineTurn(:580) — 마커 items + block.thumbs(alignThumbs)
기록: CommentsPopover(더 보기 ▾ 코멘트 목록, ScreenPanel.tsx:964-978) · PR 본문 buildCommentsSection(repo.ts:3017)
```

기능적 결함이 아니라 **모델의 문제**다: 핀 에디터가 컴포저의 축소 복제(전송·대기·영수증·복원)라서, 컴포저가 가진 것(문장, 기획서·이미지 첨부, `계획 먼저`, 모델·권한 칩, 대기줄 D86, D35 실패 시 보존, 드래프트 D43)을 하나도 못 쓴다. 그리고 핀 하나당 턴 하나가 나가는 구조는 기획자에게 "여러 곳 짚고 한 번에 말하기"를 허락하지 않는다.

## 2. 목표 구조 (to-be)

```
가리키기(모드 토글 또는 ⌥+클릭 / 2단계: 드래그) ─▶ 오버레이: describeElement → ipc colo-overlay:post {type:"colo-design.pin", pin}
   ─▶ main relayPin: 크롭 1장 → colo-preview:pin → 웹 usePins.add(pin) → sessionStorage
   ─▶ 컴포저 PinTray: [1] 썸네일 · 라벨 · 화면 · 메모(선택) · ×      (칩 클릭 → 배지 깜빡임)
   ─▶ 웹 → main preview:pins(전체 동기화) → colo-overlay:pins → 오버레이가 번호 배지를 요소 위에 그림
문장 입력 + Enter ─▶ ChatColumn onSend(text, attachments, pins) → pinsToTurn(pins, text) → sessions.submit(turn, images=핀 크롭≤6 + 첨부)
   ─▶ 성공: usePins.markSent(pins) → api.recordComments(items) → 핀 비움 → 배지 사라짐 (4단계: 턴 동안 고스트)
   ─▶ 실패: 컴포저가 원래대로 문장·첨부·핀을 그대로 쥔다 (D35는 컴포저의 것)
```

소유권: **핀 상태 = `PageWorkspace`의 `usePins` 훅**(프로젝트 슬러그 단위). 채팅 열(컴포저)과 미리보기 열(NativeHost) 양쪽이 읽는다. 스레드 단위 드래프트가 아닌 이유 — 스레드가 없을 때 찍은 핀이 전송 시 스레드 생성(M5)까지 살아야 한다.

## 3. 1단계 — 핀을 컴포저 첨부로 옮기고 오버레이를 피커로 축소

### 3.1 프로토콜 계약 (`packages/protocol/src/index.ts`)

추가:

```ts
/** 오버레이 → main → 웹: 핀 하나. `shot`은 main이 채운다 (요소 rect 크롭 1장). */
export interface ColoDesignPinEnvelope {
  type: "colo-design.pin";
  pin: {
    /** 오버레이가 만든 UUID — 칩·배지·기록이 같은 id로 만난다. */
    id: string;
    screen: string;
    state: string;
    element: ColoDesignCommentTarget;
    shot?: { mediaType: string; data: string };
  };
}

/** 웹 → main → 오버레이: 살아 있는 핀의 전체 목록 (멱등 동기화). 순서 = 번호. */
export interface ColoDesignPinsSync {
  pins: Array<{ id: string; screen: string; state: string; path: string; sent: boolean }>;
}
```

- `ColoDesignCommentTarget`(:1236-1245) 유지, 1단계 필드 추가 없음.
- 삭제: `ColoDesignComment`(:1248, 참조 0건), `ColoDesignCommentsEnvelope`(:1266 — IPC를 더 이상 건너지 않음), `ColoDesignCommentsSent`(:1297).
- `comments.record` 스키마(:532-566) → 아이템별 화면:

```ts
z.object({
  ...withId,
  type: z.literal("comments.record"),
  items: z.array(z.object({
    screen: z.string().min(1),
    state: z.string().min(1),
    text: z.string().min(1),          // 메모가 비면 기획자의 문장(첫 200자)이 들어간다 — 3.8
    elementText: z.string(),
    element: z.object({ component, path, rect }).optional(),
  })).min(1),
})
```

- `CommentItem`(:594-621) 변경 없음 — 이미 행 단위 `screen/state`.

### 3.2 마커 (`packages/protocol/src/turn-marker.ts`)

```ts
export interface CommentMarkerItem { label: string; comment: string; shot?: true; screen?: string; }
export interface CommentsMarker {
  kind: "comments";
  screen: string;          // 화면 하나면 제목, 둘 이상이면 "화면 N곳"
  state: string;
  items: CommentMarkerItem[];
  /** 기획자가 컴포저에 쓴 문장. 없으면 생략 — 카드는 목록만 그린다. */
  note?: string;
}
```

`hydrate`(:171-225)의 `comments` 분기에 `note: str(data.note)`(빈 문자열이면 필드 생략), 아이템 `screen`을 추가한다. 옛 마커(필드 없음)는 그대로 읽힌다 — `turn-marker.test.mts`의 하위호환 케이스에 "note/screen 없는 마커"를 추가한다. `alignThumbs`(:73-78) 변경 없음.

### 3.3 IPC 채널

| 채널 | 방향 | 1단계 |
|---|---|---|
| `colo-overlay:post` `{type:"colo-design.pin", pin}` | 오버레이→main | **페이로드 변경** (`colo-design.screens`는 그대로) |
| `colo-preview:pin` | main→웹 | **신규** (대체: `colo-preview:comments`) |
| `preview:pins` → `colo-overlay:pins` | 웹→main→오버레이 | **신규** — 핀 목록 전체 동기화 |
| `preview:pin-flash` → `colo-overlay:flash {id}` | 웹→main→오버레이 | **신규** — 칩 클릭 시 배지 600ms 강조 |
| `preview:comments-mode` → `colo-overlay:mode` | 유지 | 라벨만 바뀜(3.9) |
| `colo-overlay:capture` / `colo-overlay:capture-done` | 유지 | 크롭 3박자(D87) 그대로 |
| `preview:comments-sent` → `colo-overlay:sent` | **삭제** | preview-view.ts:910-932, preview-preload.ts:772-783 |
| `preview:busy` → `colo-overlay:busy` | **삭제** | preview-view.ts:903-906, preload.ts:57, ScreenPanel.tsx:636-638, preview-preload.ts:767-769 |

### 3.4 오버레이 (`packages/desktop/src/preview-preload.ts`)

유지: `ownText`/`cssPath`/`roundRect`/`describeElement`/`pageContext`/`screenContext`(:33-112), 브리지 문(:118-131), 루트 마운트·`boot`(:804-836), 호버 하이라이트+라벨(:345-385), 클릭 게이트 `pickingNow`(:339-343), Alt 추적(:429-450), `anchorWatch`·scroll·resize 재배치(:480-482), `colo-overlay:mode`(:756-765), `colo-overlay:capture`(:785-798), `toast()`(:740-749, 힌트 한 줄 전용).

삭제: `DraftPin.comment/editing`, `draftEditor`(:601-670), 전송바(:555-580), `sendDrafts`(:678-705), `settle`(:713-737), `pending`/`nextBatch`/`SENT_ACK_MS`/`EDITOR_MAX_HEIGHT`(:197-204), `busy`/`setBusy`(:180, :229-231), mousedown 접기(:456-466), `screenWatch` 초안 삭제(:469-476 — C5), `pruneDrafts`의 "경로 바뀌면 전부 삭제"(:325-326), `draftsPath`(:189), `placeColumn`(:286-298 — 배지는 요소 우상단 고정 배치로 충분), `colo-overlay:sent`/`colo-overlay:busy` 핸들러.

변경:

```ts
interface Badge { id: string; anchor: Element; number: number; sent: boolean }
let badges: Badge[] = [];

// 클릭 (:387-426): 초안 생성 대신 봉투 하나
const id = crypto.randomUUID();
ipcRenderer.send("colo-overlay:post", { type: "colo-design.pin", pin: { id, ...screenContext(element), element: describeElement(element) } });
badges.push({ id, anchor: element, number: badges.length + 1, sent: false });   // 낙관적 — 동기화가 곧 덮어쓴다
renderOverlay();

// 동기화 (신규)
ipcRenderer.on("colo-overlay:pins", (_e, sync: ColoDesignPinsSync) => {
  const here = pageContext();
  badges = sync.pins.flatMap((pin, index) => {
    if (pin.screen !== here.screen) return [];                                   // 다른 화면의 핀은 배지 없음
    const anchor = badges.find((b) => b.id === pin.id && b.anchor.isConnected)?.anchor ?? resolvePath(pin.path);
    return anchor ? [{ id: pin.id, anchor, number: index + 1, sent: pin.sent }] : [];
  });
  renderOverlay();
});
function resolvePath(path: string): Element | null { try { return document.querySelector(path); } catch { return null; } }

// 강조 (신규)
ipcRenderer.on("colo-overlay:flash", (_e, { id }) => { /* 배지·요소 outline 600ms */ });
```

- `renderOverlay`(:494-594) → 배지만: 24px 원형 번호(빨강, `sent`면 회색), 요소 우상단(`rect.right-12, rect.top-12`), 클릭하면 `ipcRenderer.send("colo-overlay:post", {type:"colo-design.pin-focus", id})` → 웹이 해당 칩의 메모 입력에 포커스. `layoutOverlay`(:301-313)는 배지 위치만 갱신.
- 리로드·SPA 이동 뒤 재앵커: `boot`와 `did-navigate-in-page`에 대응해 웹이 `preview:pins`를 다시 보낸다(3.6 NativeHost). 오버레이는 상태를 저장하지 않는다.
- 힌트 토스트(:821-832) 문구: "요소를 ⌥+클릭하면 핀이 찍혀 입력창에 붙습니다. 여러 개 찍고 한 번에 말하세요."
- 줄 수 목표: 836 → 약 420.

### 3.5 main (`packages/desktop/src/preview-view.ts`)

- `onOverlayPost`(:557-569): `colo-design.pin` → `void this.relayPin(payload)`; `colo-design.pin-focus` → `this.send("colo-preview:pin-focus", payload)`.
- `relayPin(payload: ColoDesignPinEnvelope)`: `withOverlayHidden` 안에서 `cropRect(pin.element.rect, viewportCss())` → `capturePage` → `fitInside(600).toJPEG(70)` → `pin.shot`; `finally` `this.send("colo-preview:pin", payload)`. **그다음** `this.window()?.webContents.focus()`(`window`는 팩토리, :188) — 핀 하나가 제스처 하나로 끝나려면(D80의 뜻) 포커스가 컴포저로 넘어가야 한다. `MAX_SHOTS`는 이 파일에서 제거(상한은 3.6 `submit`이 6장으로 쥔다), `SHOT_LONG_SIDE` 유지.
- 삭제: `relayComments`(:479-505), `commentsSent`(:424-426), `setBusy`/`busy`(:183-184, :903-906), `preview:comments-sent`(:910-932).
- 추가 IPC: `preview:pins` `(sync) => view.syncPins(sync)` → `this.webContents()?.send("colo-overlay:pins", sync)`; 페이지가 `did-finish-load`/`did-navigate-in-page`(:705-709 근처)에 `mode`·`busy`를 되말하듯 **마지막 sync를 되말한다**(`private lastPins: ColoDesignPinsSync | null`). `preview:pin-flash` → `colo-overlay:flash`.

### 3.6 desktop preload · 브리지 타입 · 웹

`preload.ts`(:35-89): `onComments` → `onPin: subscribe<ColoDesignPinEnvelope>("colo-preview:pin")`, `onPinFocus: subscribe<{id}>("colo-preview:pin-focus")`, `pins: (sync) => invoke("preview:pins", sync)`, `pinFlash: (id) => invoke("preview:pin-flash", {id})`. 삭제: `commentsSent`, `busy`. `desktop-bridge.d.ts`(:77-85) 동일하게.

**`packages/web/src/usePins.ts` (신규)**

```ts
export interface PinAttachment {
  id: string; screen: string; state: string;
  element: ColoDesignCommentTarget;
  shot?: { mediaType: string; data: string };
  note: string;
}
export interface Pins {
  list: PinAttachment[];
  add(pin: ColoDesignPinEnvelope["pin"]): void;      // 중복 id 무시
  remove(id: string): void;
  setNote(id: string, note: string): void;
  clear(): void;
  /** 전송 성공 뒤: 기록 → 비움. 기록 실패는 턴을 막지 않는다(현행 ScreenPanel.tsx:525-544 규칙 유지). */
  markSent(sent: PinAttachment[], fallbackText: string): Promise<void>;
  /** 기록이 바뀐 횟수 — ScreenPanel의 refreshComments 트리거. */
  version: number;
}
```

- 저장: `sessionStorage["colo-design.pins.<slug>"]`(shot 포함; 6장 × ~40KB). 슬러그 바뀌면 그 슬러그의 목록을 읽는다. 컴포저 텍스트 드래프트(`colo-design.draft.*`, Composer.tsx:141)와 같은 원칙(D43).
- `list`가 바뀔 때마다 `window.coloDesignDesktop?.preview?.pins?.({ pins: list.map(p => ({id, screen, state, path: p.element.path, sent: false})) })`.

**`Composer.tsx`**

- 새 props: `pins: PinAttachment[]`, `onPinRemove(id)`, `onPinNote(id, note)`, `onPinFocus(id)`, `focusPinId?: string | null`(배지 클릭 → 그 행의 메모 입력에 포커스).
- `onSend: (text, attachments, pins) => …`(:311). 보내기 활성 조건(:591, :1196)에 `pins.length > 0` 추가. 성공 시 `setEditor(EMPTY_EDITOR)`(:606)는 그대로 — 핀 비움은 `usePins.markSent`가 한다.
- `.chips`(:896-930) 위에 `PinTray`(신규 `PinTray.tsx`) 렌더:

```
┌ 핀 3개 · 회원 목록                                   모두 지우기 ┐
│ ① [썸네일 40px] 회원 목록 · 기본   [메모(선택)__________]  × │
│ ② [썸네일]       상세 버튼 · 기본  [여백 좁아요__________]  × │
│ ③ [—]            h1 · settings     [_________________]  × │   ← 크롭 없음(뷰포트 밖)이면 대시
└──────────────────────────────────────────────────────────┘
```

  행 클릭(메모 입력 외) → `onPinFocus(id)` → `preview.pinFlash(id)`. 메모 입력 Enter → 본문 textarea로 포커스 이동(전송 아님). 화면이 둘 이상이면 머리글 `핀 3개 · 화면 2곳`.
- 대기줄 D86: 핀이 있는 전송이 대기에 들어가면 `QueuedSend`에는 문장(턴 본문)+이미지로 남고, `고쳐서 보내기`(:641-652)로 되돌리면 **텍스트+이미지 첨부**로 복원된다(핀으로는 아님). 1단계의 알려진 한계 — 7절.

**`useSessions.ts`**

- `submit(text, attachments, planFirst = false, thread?: { name?: string })`(:574): `targetSession()`이 스레드를 새로 만들 때 `name`을 넘긴다 — `targetSession(wanted?, name?)` → `startSession(undefined, name)`(:494). 핀이 있는 첫 전송은 화면 제목으로 스레드를 이름 짓는다(M5, 현행 PageWorkspace.tsx:342).
- 이미지: `[...pinShots(≤6), ...attachments.filter(image)]`. 핀 크롭이 먼저 — 데몬 `thumbs`(session.ts:1079-1081)가 앞 6장을 카드 썸네일로 돌려주고 `alignThumbs`가 `shot` 플래그로 행에 맞춘다.
- `sendTurn`(:671-687)은 오류·화면 보여 주기 턴이 계속 쓴다 — 유지.

**`ChatColumn.tsx`**(:427-462)

```ts
onSend={async (text, attachments, pins) => {
  const turn = pins.length ? pinsToTurn(pins, text, titleForScreen) : text;
  const name = !sessions.activeId && pins.length ? titleForScreen(pins[0].screen) ?? undefined : undefined;
  await sessions.submit(turn, attachments, planArmed, { name, pinShots: pins.map(p => p.shot).filter(Boolean).slice(0, 6) });
  if (planArmed) setPlanArmed(false);
  if (pins.length) void pinsApi.markSent(pins, text);
}}
```

`titleForScreen(screen)` = `screens.find(s => s.route === `/${screen}`)?.title ?? screen`(현행 ScreenPanel.tsx:506 규칙). `ChatColumn`은 이미 `screens`를 받는다(PageWorkspace.tsx:456).

**`preview-turns.ts`** — `commentsToTurn`(:47-78) → `pinsToTurn(pins, note, titleFor)`. 템플릿은 3.8.

**`components.tsx` MachineTurn**(:599-608): `note`가 있으면 머리글 아래 `<p className="machine__note">{note}</p>`; 행 `label`에 화면이 둘 이상이면 `· <item.screen>` 접미; `text`가 비면(메모 없음) 행은 라벨만. 제목은 `수정 요청 N건` 유지(4단계에서 의도별로 바뀜).

**`ScreenPanel.tsx`**: `forwardComments`(:484-545) 삭제; `onComments` prop → 그대로 두되 오류·보여 주기 턴 전용으로 `onMachineTurn`으로 개명(PageWorkspace.tsx:334 `forwardComments`도 `forwardMachineTurn`); `busy` 효과(:636-638) 삭제; `commentsOn`(:236) 유지; `refreshComments`(:272-285)를 `pins.version` 변화에도 호출; `더 보기 ▾ 코멘트 목록`(:964-978) 유지.

**`NativeHost.tsx`**: `onComments`(:143-148) → `onPin`(빈 봉투 가드 불필요), `onPinFocus`; `pins` prop을 받아 변화 시와 `onLocation`(:137) 수신 시 `preview.pins(sync)` 재전송(리로드·SPA 이동 뒤 재앵커).

**`PreviewHost.tsx`**(:351-365): 버튼 라벨 `💬 코멘트` → `<PinIcon/> 핀`(icons.tsx `make(MapPin, …)`), `aria-pressed` 유지, title "핀 모드 — 클릭이 화면에 전달되지 않고 핀만 찍힙니다. ⌥+클릭은 언제든 핀을 찍습니다". `onComments` prop 제거.

**`PageWorkspace.tsx`**: `const pins = usePins(daemon.activeSlug, daemon.api)`; `ChatColumn`에 `pins`, `ScreenPanel`에 `pins`(→ `PreviewHost` → `NativeHost`) 전달.

### 3.7 daemon

- `comments.ts` `recordComments(file, items, now)`(:65-89): 아이템별 `screen` 정규화(`replace(/^\/+/, "")`, :79-80 규칙). 시그니처에서 `screen, state` 인자 제거.
- `server.ts`(:1963-1970): `recordComments(join(root,"comments.json"), message.items)`.
- `repo.ts buildCommentsSection`(:3017-3048) 변경 없음.
- `publish-e2e.mjs`(:762-776, :822-840) 페이로드를 아이템별 `screen/state`로.

### 3.8 턴 텍스트 템플릿 (정확한 문자열)

```
<!-- colo-design:comments {"kind":"comments","screen":"회원 목록","state":"기본","note":"<문장>","items":[{"label":"회원 목록","comment":"여백이 좁아요","screen":"회원 목록","shot":true},…]} -->
<문장>                                                              ← note가 비면 이 줄과 다음 빈 줄 생략

미리보기에서 가리킨 요소 N개입니다. 아래 위치를 기준으로 고친 뒤 화면을 다시 보여 주세요.

1. <component> — "<text>" · <screen 제목> (<stateLabel> 상태)
   메모: <note>                                                     ← 메모 없으면 생략
   위치: <path> (rect x,y w×h)

2. …
```

- `screen` 제목 해석 실패 시 원 id(현행 :506 폴백). 화면이 둘 이상이면 마커 `screen`은 `"화면 2곳"`, 아이템별 `screen`이 진실.
- `comments.record`의 `text`: 메모가 있으면 메모, 없으면 문장 첫 200자, 둘 다 없으면 `"(메모 없음)"` — 스키마 `min(1)`을 지키면서 PR 본문(`"<text>"`, repo.ts:3040 근처)이 빈 따옴표를 내지 않게.
- `json` fence 삭제(C7). Claude가 필요로 한 것은 `path`·`rect`이고 목록 줄이 이미 실는다. e2e 스텁의 판별 문자열 `"화면 수정 요청"`(desktop-comments.mjs:110)은 `"미리보기에서 가리킨 요소"`로 바꾼다.

### 3.9 UX 명세

| 상황 | 동작 |
|---|---|
| 핀 모드 OFF, ⌥+클릭 | 핀 찍힘, 페이지는 클릭을 못 봄(현행 D79). 포커스 → 컴포저의 새 행 메모 입력 |
| 핀 모드 ON, 클릭 | 같음. 호버 하이라이트 + 요소 이름 탭(현행) |
| 핀 찍힌 직후 | 배지 ① 요소 우상단, 컴포저 PinTray에 행 추가, 썸네일 즉시 |
| 메모 입력 Enter | 본문 textarea로 포커스 이동(전송 아님). 전송은 컴포저의 Enter/⌘Enter(설정 `sendKey`) |
| 행 클릭 / 배지 클릭 | 배지 깜빡임 / 그 행 메모 입력 포커스 |
| × / 모두 지우기 | 행·배지 제거. 되돌리기 없음(핀은 다시 찍는 게 더 싸다) |
| 다른 화면·상태로 이동 | 핀 유지. 배지는 그 화면에서만. 행에 `화면 · 상태` 표기(회색) |
| 새로 고침 / 앱 재시작(같은 세션) | 핀 유지(sessionStorage), 배지 재앵커. 요소를 못 찾으면 배지 없음, 행은 남음 |
| 전송 성공 | 행·배지 사라짐, 카드 1장(문장 + N행 + 썸네일), 기록 팝오버에 N행 추가 |
| 전송 실패(D35) | 문장·첨부·핀 전부 그대로. 경고 띠에 이유(컴포저 현행) |
| 턴 도는 중 전송 | 컴포저 대기줄(D86) — 오버레이는 관여하지 않음 |
| 핀 0개, 문장만 | 현행과 동일한 일반 턴 |
| 핀만, 문장 없음 | 전송 가능. 턴은 목록만. 카드 제목 `수정 요청 N건` |

### 3.10 테스트

`packages/desktop/test/desktop-comments.mjs` — 검사 항목의 뒤바뀜을 명시한다.

| 현행 검사 | 1단계 |
|---|---|
| ⓐ ⌥+클릭 → 초안 textarea, 페이지 클릭 0 (:285-304) | ⌥+클릭 → PinTray 행 1개 + 배지 1개, 페이지 클릭 0, 포커스가 메모 입력에 |
| ⓑ ⏎ 보내기 → 핀 하나 즉시 (:306-333) | 메모 입력 + 본문 문장 + Enter → 카드 1장에 문장·행이 함께, 스레드 1개(화면 이름) |
| 가장자리 편집기 클램프 (:335-373) | **삭제**(편집기 없음) |
| ⓖ 크롭 JPEG ≤600 (:412-434) | 유지 — PinTray 썸네일과 카드 썸네일 모두 |
| ⓒ 보낸 핀 즉시 사라짐 (:440) | 전송 성공 뒤 행·배지 0 |
| ⓓ 리로드 뒤 아무것도 안 돌아옴 (:442-445) | **뒤바뀜**: 미전송 핀은 리로드 뒤 배지가 **돌아온다** |
| 전송 시점 rect (:447-496) | **뒤바뀜**: 크롭·rect는 **찍은 시점**의 것(C4) |
| ⓔ 기록 팝오버 (:498-535) | 유지(아이템별 screen) |
| ⓕ 상태 전환 → 초안 삭제 토스트 (:537-575) | **뒤바뀜**: 핀 유지, 배지 숨김, 행에 `기본` 표기 |
| Esc (:577-604) | **삭제** |
| 래퍼 교체 → 핀 삭제 (:606-623) | **뒤바뀜**: 행 유지 |
| ⓚ 래퍼 없는 페이지 (:625-676) | 유지, 턴 판별 문자열 교체 |
| ⓘ 미드턴 핀 → 대기줄 (:747-777) | 핀 + 문장을 턴 도는 중 전송 → 컴포저 대기줄 |
| ⓛ ⓜ ⓝ ⓞ ⓟ ⓠ ⓡ | 변경 없음 |

추가 검사: 두 화면에서 핀 하나씩 → 한 턴 → 카드 머리 `화면 2곳` · 행별 화면 표기 · `comments.list`에 두 행이 각자 화면으로.

- `packages/daemon/test/repo.test.mjs`(:1120-1215): `recordComments(file, items)` 시그니처, 아이템별 정규화.
- `packages/web/test/turn-marker.test.mts`: `note`·아이템 `screen` 라운드트립, 옛 마커 하위호환.
- `packages/daemon/test/publish-e2e.mjs`: 페이로드 형태.
- 스텁 CLI 판별 문자열(desktop-comments.mjs:110).

### 3.11 삭제 목록 (knip 통과 기준)

`ColoDesignComment` · `ColoDesignCommentsEnvelope` · `ColoDesignCommentsSent` · `commentsToTurn` · `PlannerPreviewView.relayComments/commentsSent/setBusy` · `preview:comments-sent` · `preview:busy` · `coloDesignDesktop.preview.commentsSent/busy/onComments` · `ScreenPanel.forwardComments` · `NativeHost` 빈 봉투 가드 · 오버레이의 `draftEditor/sendDrafts/settle/pending/placeColumn/screenWatch/pruneDrafts(경로 삭제 분기)/busy` · README 5절 "핀은 보내는 순간 화면을 떠난다" 문장 갱신(README.md:111-116, 360-368).

### 3.12 1단계 수용 기준

1. 핀 3개(그중 1개는 다른 화면) + 문장 1줄 → 턴 **1개**, 카드에 문장·3행·썸네일(≤6), `comments.json`에 3행(각자 화면).
2. 전송 실패(데몬 거부 주입) → 문장·첨부·핀·배지 전부 그대로, 경고 띠 1곳.
3. 리로드·상태 전환·라우트 이동 뒤 핀 행 유지, 같은 화면에서 배지 복귀.
4. `⌥+클릭` 뒤 추가 클릭 없이 바로 타이핑 가능(포커스 이전).
5. `계획 먼저` 칩 + 핀 전송 → 계획 카드가 먼저 온다(컴포저 경로 공유의 증거).
6. `pnpm typecheck` · `pnpm knip` 통과, 삭제 목록의 심볼 0건.
7. `preview-preload.ts` 줄 수 절반 이하.

## 4. 2단계 — 영역 선택 + 캡처 강화

### 4.1 드래그 영역

- `ColoDesignCommentTarget`에 `kind: "element" | "region"` 추가(1단계 데이터는 `kind` 없음 = element로 읽음).
- 오버레이: 피킹 중 `mousedown → mousemove(6px 넘으면 드래그 시작) → mouseup`. 영역 = `{ kind:"region", component:"영역", text:"", path:"", rect }`. 클릭(6px 미만)은 1단계 요소 핀 그대로.
- 배지 앵커: 요소 없음 → 오버레이가 `{pageX, pageY, w, h}`를 쥐고 스크롤에 맞춰 사각 테두리+배지를 그린다. 리로드 재앵커는 `pageX/pageY` 기준(요소 경로 없음).
- 크롭: `cropRect(rect)` 그대로. 턴 줄: `N. 영역 · <screen> (<state> 상태)` + `위치: rect x,y w×h` (path 줄 생략).
- PinTray 행: 라벨 `영역 320×48`.

### 4.2 캡처 강화 (`describeElement`)

`ColoDesignCommentTarget`에 선택 필드:

```ts
html?: string;                      // outerHTML, 오버레이·data-colo-* 제거, 1.5KB 상한(초과 시 "…" 절단)
styles?: Record<string, string>;    // getComputedStyle 부분집합: color, background-color, font-family, font-size,
                                    // font-weight, line-height, padding, margin, border-radius, display, width, height, gap
a11y?: { role?: string; name?: string };  // role 속성, aria-label|alt|title|연결된 label 텍스트
attrs?: { id?: string; testId?: string; classes?: string[] /* ≤5 */ };
owners?: string[];                  // React 컴포넌트 이름 체인(가까운 것부터 ≤3) — 4.3
```

턴 줄에 추가:

```
   컴포넌트: PayFailed › RetryButton › Button          ← owners 있을 때
   HTML: <button class="btn btn--primary" …>다시 시도</button>
   스타일: color #fff · bg #e05252 · 14px/600 · padding 8px 16px · radius 8px
```

`component`는 `data-component ?? owners?.[0] ?? tag`.

### 4.3 React owner 이름 — main world 조회

preload는 isolated world라 fiber expando를 못 본다(:27-29). 절차:

1. 오버레이가 클릭 시 요소에 `data-colo-pick="<id>"`를 붙이고 봉투를 보낸다.
2. main `relayPin`이 크롭 **전에** `contents.executeJavaScript(OWNER_SCRIPT(id), true)`:
   - `el = document.querySelector('[data-colo-pick="<id>"]')`; 키 `__reactFiber$*`(React 17+) 또는 `__reactInternalInstance$*`(16) 탐색.
   - `for (o = fiber._debugOwner; o && names.length < 3; o = o._debugOwner) names.push(displayName || name)`.
   - `el.removeAttribute("data-colo-pick")`; 반환 `string[] | null`.
   - React가 아니거나 production 빌드면 `null` — 오류 없이 생략.
3. `pin.element.owners = names`.

id는 UUID만 통과시켜 문자열 삽입을 막는다. 페이지는 연결 레포의 미리보기(도구의 신뢰 경계 안)이고 스크립트는 상수라 D68("레포 코드 무개입")을 깨지 않는다.

### 4.4 2단계 테스트

- 드래그 → 영역 핀 행·테두리·크롭 크기 = 드래그 크기(±2px).
- fixture 페이지(React dev)에서 `owners[0]`이 컴포넌트 이름과 일치; production 빌드 fixture에선 `owners` 없음.
- `html` 1.5KB 절단, 오버레이 노드 미포함.

## 5. 3단계 — 소스 위치

- **사실 확인**: React 19가 fiber `_debugSource`를 제거했다(react/react PR #28265, 이슈 #32574). fiber에서 파일:줄을 읽는 길은 React ≤18 dev에서만 성립한다. 따라서 기본 경로는 레포 측 규약이다.
- 규약 `data-colo-src="src/pages/PayFailed.tsx:42"`: 레포의 Vite 플러그인(`enforce: "pre"`, dev 전용)이 소문자 태그 JSX 오프닝에 속성을 넣는다. 예시 30줄을 **부트스트랩 브리프**(`bootstrap-brief.ts`)에 싣는다 — 쓰는 주체는 세션, 승인은 개발자 PR(`docs/repo-common-settings-injection-debate-2026-09-14.md` §3의 결론과 같은 결). 앱은 파일을 주입하지 않는다(C8).
- 오버레이: `element.closest("[data-colo-src]")?.getAttribute("data-colo-src")` → `source?: string`. 턴 줄 맨 위에 `파일: src/pages/PayFailed.tsx:42`. PinTray 행에 회색 파일명.
- React ≤18 폴백: 4.3 스크립트에서 `fiber._debugSource ?? fiber._debugOwner?._debugSource` → `{fileName, lineNumber}` → 같은 `source` 필드.
- 보류: React 19 `_debugStack` + 소스맵 역추적. 플러그인 채택률을 본 뒤 결정.

## 6. 4단계 — 의도 · 고스트 · 단축키

- 의도: `PinAttachment.intent: "change" | "question"`(기본 change). PinTray 행에 토글 칩. 마커 아이템 `intent`. 턴 머리: 전부 질문이면 "아래 요소에 대한 질문입니다 — 고치지 말고 설명해 주세요."; 혼합이면 행마다 `요청:`/`질문:`. 카드 제목 `수정 요청 N건` / `질문 N건` / `수정 N · 질문 M`.
- 고스트: `markSent`가 `sentPins`를 `sessionId`와 함께 쥐고 `preview.pins`에 `sent:true`로 보낸다(회색 배지). `useSessions`의 `active.state`가 `running → idle/error`로 바뀌면 비운다. 해결 상태를 저장하지 않는다(C10).
- 단축키 `⌘⇧P` 핀 모드 토글: `PageWorkspace.tsx:303-314`의 코드는 `shiftKey`를 걸러내므로 별도 분기; D71 키 릴레이(`colo-preview:key`, preload.ts:85)에 `shift` 플래그 추가.
- 보류: Codex식 스타일 조절기("Adjust") — 기획자 도구엔 과함.

## 7. 리스크 · 미결

| 항목 | 위험 | 대응 |
|---|---|---|
| 포커스 이전(main→웹) | `webContents.focus()` 뒤 React 포커스가 늦게 붙을 수 있음 | `colo-preview:pin` 수신 → `requestAnimationFrame` 뒤 메모 입력 `focus({preventScroll:true})`; e2e ⓐ가 검증 |
| `querySelector(path)` 재앵커 | 숫자로 시작하는 id 등 잘못된 선택자 예외 | try/catch → 배지 없음, 행은 유지 |
| sessionStorage 용량 | 크롭 base64 6장 × ~40KB | 핀 7개째부터 `shot` 저장 생략(턴에도 안 실림 — 상한 6과 일치) |
| 카드 썸네일 혼선 | 기획자 JPEG 첨부가 핀 크롭 뒤에 섬 | 핀 크롭을 앞에 두고 `alignThumbs`가 `shot` 개수만 소비 |
| 대기줄 복원 | `고쳐서 보내기`가 핀을 텍스트+이미지로 되돌림 | 1단계 한계로 명시. 필요해지면 `QueuedSendPayload`에 `pins` 추가 |
| 대기줄 × 기록 (커미티 판정 3, 2026-09-14) | 대기줄(D86)에 들어간 턴이 드랍돼도 `markSent`는 이미 수락 뒤에 돌아 기록·PR 본문은 "보냄"으로 남는다 | 계약을 "수락=기록"으로 명시(스키마 주석 갱신 완료). 기록은 배달부의 영수증이 아니라 기획자의 "요청한 것"의 로그다. 드랍된 말은 컴포저의 전달되지 못한 말로 돌아온다 |
| 마커 한 줄 규칙 | `note`에 줄바꿈 | `JSON.stringify`가 `\n`로 이스케이프 — 정규식 `[^\n]*` 통과 |
| owner 조회 실패 | non-React·production·SSR | `null` 생략, 턴 줄 없음 |
| 스텁 CLI 판별 | `"화면 수정 요청"` 문자열 의존 | 3.8 문자열로 교체 |

## 8. 순서 · 게이트 · 작업 분할

| 단계 | 산출물 | 게이트 |
|---|---|---|
| 1 | 3.1~3.11 전부 | 3.12 수용 기준 7건 + `pnpm test:comments-ui test:repo-unit test:web-unit test:publish` |
| 2 | 4.1~4.3 | 4.4 + 1단계 회귀 |
| 3 | 5 | fixture 레포에 플러그인 적용 → 턴 첫 줄 `파일:` |
| 4 | 6 | 의도 혼합 카드 · 고스트 소멸 타이밍 e2e |

1단계 병렬 분할(계약은 3.1~3.3·3.8로 고정, 파일 소유 분리):

- **A 프로토콜·데몬**: `protocol/index.ts`, `turn-marker.ts`, `daemon/comments.ts`, `server.ts`, `repo.test.mjs`, `publish-e2e.mjs`, `turn-marker.test.mts`.
- **B 데스크톱**: `preview-preload.ts`, `preview-view.ts`, `preload.ts`, `desktop-bridge.d.ts`.
- **C 웹**: `usePins.ts`, `PinTray.tsx`, `Composer.tsx`, `ChatColumn.tsx`, `useSessions.ts`, `preview-turns.ts`, `components.tsx`, `ScreenPanel.tsx`, `NativeHost.tsx`, `PreviewHost.tsx`, `PageWorkspace.tsx`, `styles.css`, `icons.tsx`.
- **D 통합·e2e**: `desktop-comments.mjs` 재작성(3.10), README 갱신 — A·B·C 병합 뒤 순차.

A→(B, C 병렬)→D. B와 C의 유일한 접점은 3.3 채널명과 3.1 타입이며 둘 다 A가 먼저 확정한다.
