# 화면 작업 하네스 계획 — 재생 벤치 · 화면 색인 · 타입 진단

> **한 줄 요약.** 연결 레포의 화면 작업을 더 빠르고 정확하게 하려고, 지침을 더 쓰는 대신
> 데몬이 기계적으로 대신할 수 있는 셋을 더한다. ① 효과를 숫자로 재는 **재생 벤치**,
> ② 화면 주소와 파일을 레포 구조에서 바로 잇는 **화면 색인**(핀 후보 · `screen_files` ·
> 게이트 입력이 함께 쓴다), ③ 편집 사이사이에 몇 초로 답하는 **증분 타입 진단**.
> 마지막 묶음이 타입 진단을 게이트에 잇고 지침 · README 를 맞춘다.

- **기준**: 브랜치 `harness-int`(= `mcp-int` 64df64a6 위). PLAN-MCP 묶음 A~F 가 모두 들어 있다.
  줄 번호는 2026-09-28 의 것 — 합칠 때 다시 잰다.
- **범위**: `packages/daemon`, `packages/desktop`(벤치 접속 파일 하나), `scripts/bench/`(새 폴더),
  루트 `package.json` · `.gitignore`, README 의 해당 절. **웹 UI 는 건드리지 않는다** — 사용자 면에
  새 문장이 생기지 않는다(`labels.ts` 무변경).
- **원칙**: ① 도구의 실패는 도구 결과다(턴을 죽이지 않는다). ② 새 도구는 `BROWSER_TOOLS` 한
  곳에 더해 세 프로바이더에 같이 실린다. ③ 추측으로 게이트를 걸지 않는다 — 게이트가 여는 화면은
  관찰 · 레포 구조 · 사람이나 AI 가 실제로 가리킨 것에서만 온다. ④ 측정이 먼저다 — 벤치(A)를
  먼저 합친다.

---

## 0. 결정 요약

| # | 논점 | 결정 |
|---|---|---|
| H-1 | 벤치의 몸 | 데몬에 WebSocket 으로 붙는 Node 스크립트(`scripts/bench/`). 새 의존성 없음(Node 22 의 전역 `WebSocket`) |
| H-2 | 벤치의 접속 | 데스크톱 개발 실행이 `COLO_DESIGN_BENCH_ENDPOINT` 가 가리키는 파일에 접속 주소를 적는다(패키징된 앱은 절대 안 적는다). `pnpm dev:daemon` 은 `--url` 로 붙는다 |
| H-3 | 화면 색인의 재료 | 파일 경로의 구조만 — 주소의 조각과 파일 경로의 조각을 맞춘다. Next.js 의 `app/` · `pages/` 동적 경로는 보조로. 파일 내용은 읽지 않는다 |
| H-4 | 색인이 쓰이는 곳 | `screen_files`(`(주소)` 줄), 핀의 `파일 후보:`(`(주소)` 표식), 게이트의 입력(바뀐 파일 → 화면) |
| H-5 | 게이트의 새 입력 | 이 턴에 가리킨 화면이 없을 때만, **바뀐 파일**에서 화면을 되짚는다 — 관찰 지도에 그 파일을 고친 화면이 있거나, 그 파일이 Next.js 의 고정 경로 page 파일일 때. 파일 이름에서 주소를 지어내지 않는다(없는 주소를 열면 404 가 "문제"로 잡혀 AI 가 없는 화면을 고친다) |
| H-6 | 레포 지도 지침 | 이번에는 하지 않는다 — 지금 연결 레포는 모두 CLAUDE.md 가 있거나 프레임워크가 없어 한 번도 켜지지 않는다(§6 O-3) |
| H-7 | 타입 진단의 몸 | 상주 `tsc --watch` 가 아니라 **호출마다의 증분 `tsc --noEmit --incremental`**. 빌드 정보 파일은 클론 밖(`~/.colo-design/projects/<slug>/tsc.tsbuildinfo`) — 상주 메모리 0, 신선도 문제 없음, `git status` 깨끗 |
| H-8 | 새 도구 | `repo_diagnostics {}` — 이번에 바뀐 파일의 타입 오류를 먼저. 미리보기가 없어도 돈다. 첫 턴이 시작될 때 한 번 미리 데운다 |
| H-9 | 게이트의 타입 오류 | 이 턴이 바꾼 `.ts/.tsx` 파일에 타입 오류가 있으면 게이트 브리프에 `### 타입 검사` 절로 싣는다. 화면이 없어도 그 절만으로 게이트가 선다. 카드의 단계 이름은 그대로 `화면 확인`(사용자 면에 새 말 없음). 사용자의 한 턴에 한 번 규칙은 그대로 |
| H-10 | 지침 | `repo_diagnostics` 한 줄, 첫 불릿에 "타입 오류도 함께 본다" 한 구절 |
| H-11 | 레포의 check · build | 여전히 보관 · 제출을 막지 않는다. 게이트가 여는 것은 고침 턴이지 문이 아니다 |

---

## 1. 근거

### 1.1 로컬 턴 통계(2026-09-23 · 25)

| 턴 | 총 시간 | 첫 편집까지 | exec | browser | 컨텍스트 |
|---|---|---|---|---|---|
| Claude Opus 5.5 · 화면 만들기 | 200초 | 58초 | 14 | 17 | 120k |
| Claude · 핀 1개 | 20초 | 편집 없음 | 1 | 2 | 124k |
| omp swe-2 · 화면 3건 | 16~25초 | 9~16초 | 0~1 | 0 | 12k |

- 200초짜리 턴의 exec 14회 대부분이 레포 검사(`pnpm check` = 레지스트리 생성 · API 표 생성 ·
  규칙 검사 · `tsc --noEmit` 전체)다. 편집 사이사이의 확인이 매번 처음부터 돈다.
- 게이트 14건 중 5건이 `no-screens` — 턴이 화면을 고쳤는데 `screen_check` · 링크가 없어
  기계가 볼 화면을 몰랐다(PLAN-MCP §1.1).
- 표본이 작다. 그래서 A(벤치)가 먼저다.

### 1.2 코드

- **게이트 입력**: `preview-drivers.ts:118` `notePinned` 이 유일한 입구 — 핀 · 캡처 · navigate ·
  `screen_check` · 답변 링크(`server.ts:660`). `gatePossible`(`:131`)은 모인 화면이 없으면 false,
  `server.ts:775-790` 이 `no-screens` 로 적고 끝낸다.
- **관찰 지도**: `screen-map.ts` — 커밋이 한 번 지나가야 채워진다. 처음 만지는 화면에는 비어 있다.
- **`screen_files`**: `server.ts:1532` · `browser-tools.ts:350` `screenFilesAnswer(observed, hunted, title)`
  — 관찰과 제목 글자뿐, 레포 구조를 보지 않는다.
- **핀 후보**: `pin-files.ts` `enrichCommentsTurn` — 정체 사냥 → 관찰의 두 길. 둘 다 빈손이면 줄이 없다.
- **데스크톱 데몬의 접속 정보**: `packages/desktop/src/main.ts:158` 실행마다 새 토큰, 어디에도 적지 않는다.
  독립 데몬은 `~/.colo-design/config/daemon.json` 에 적는다.
- **변경 목록**: `RepoWorkspace.diff()`(`repo.ts:298`) — HEAD 대비 추적 · 미추적 전부, 경로는 레포 루트 상대.
  게이트는 자동 보관 **전**에 돌므로 그 시점의 diff 가 곧 이 턴의 변경이다.

---

## 2. 묶음과 순서

| 묶음 | 내용 | 결정 | 크기 | 선행 | 맡는 이 |
|---|---|---|---|---|---|
| A | 재생 벤치 — 접속 파일 · 스크립트 · 시나리오 · 비교 | H-1 · H-2 | M | — | GLM 5.3 flash |
| B | 화면 색인 — `route-index.ts` · `screen_files` · 핀 · 게이트 입력 | H-3 · H-4 · H-5 | L | — | GLM 5.3 |
| C | 타입 진단 — `type-check.ts` · `repo_diagnostics` · 미리 데우기 | H-7 · H-8 | M | — | GLM 5.3 |
| D | 게이트의 타입 오류 · 지침 · README | H-9 · H-10 · H-11 | M | B · C | (물결 2) |

A · B · C 는 서로 코드 의존이 없어 같이 띄운다. 같은 파일을 만지는 자리는 아래 표대로 나눠
병합 충돌을 줄인다.

| 파일 | A | B | C |
|---|---|---|---|
| `packages/daemon/src/server.ts` | — | `onState` 의 idle 갈래(게이트) · `screenFiles` 처리 | 필드 하나 · `BROWSER_OPS` · `BROWSER_QUIET_OPS` · `notifyDeveloper` 처리 **뒤**의 새 처리 · `onTurnStart` · 데몬 stop |
| `packages/daemon/src/browser-tools.ts` | — | `screen_files` 설명 · `screenFilesAnswer` | `submit_for_review` **앞**에 도구 하나 |
| `packages/daemon/src/preview-drivers.ts` | — | `gateEligible()` 하나 | — |
| `packages/daemon/src/turn-stats.ts` | — | 게이트 행의 `fallback` | — |
| `packages/daemon/src/pin-files.ts` | — | `collectCodeFiles` export · 주소 후보 | — |
| 루트 `package.json` · `.gitignore` | 스크립트 · `bench-results/` | — | — |
| README · `common-instructions.ts` | — | — | — (D 가 한다) |

---

## 3. 묶음별 작업 분해

### 3.A 재생 벤치 (H-1 · H-2)

**A-1 데스크톱의 접속 파일.** 새 파일 `packages/desktop/src/bench-endpoint.ts`:

```ts
/** 적을 파일 — 패키징된 앱이거나 env 가 없으면 null. */
export function benchEndpointPath(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null;
/** 파일의 본문 — JSON 한 줄. */
export function benchEndpointBody(input: { url: string; pid: number; now: Date }): string;
```

- `main.ts` 의 `const url = windowUrl(daemonUrl(server, token));` 바로 뒤에서, `benchEndpointPath(process.env,
  app.isPackaged)` 가 값을 주면 부모 폴더를 만들고 `{ "url": "<ws 주소>", "pid": <pid>, "startedAt": "<ISO>" }`
  를 mode `0o600` 으로 쓴다. ws 주소는 `server.ts` 의 WebSocket 업그레이드가 받는 모양 그대로
  (`ws://127.0.0.1:<port>/?token=<token>` 인지 코드에서 확인한다 — 웹 클라이언트가 붙는 주소와 같아야 한다).
- `will-quit` 에서 그 파일의 `pid` 가 이 프로세스일 때만 지운다(실패는 삼킨다).
- `bench-endpoint.ts` 는 electron 을 임포트하지 않는 순수 파일이다. 시험은
  `packages/daemon/test/bench-endpoint.test.ts` 에 — `invite-discard.test.ts` 가 데스크톱의 순수 파일을
  `new URL("../../desktop/src/…ts", import.meta.url)` 로 직접 읽는 길 그대로(패키징 · 빈 env · 본문 JSON · 0600 은
  main.ts 의 몫이라 시험하지 않는다).

**A-2 스크립트.** 새 폴더 `scripts/bench/`:

| 파일 | 무엇 |
|---|---|
| `bench.mjs` | CLI. `run` · `compare` 두 명령 |
| `client.mjs` | WebSocket 클라이언트 — `hello` 대기, `request(msg)` 는 같은 `id` 의 `ok`/`error` 를 기다린다, `session.state` 구독 |
| `lib.mjs` | 순수 함수 — 시나리오 읽기 · 핀 턴 만들기 · 통계 행 모으기 · 판정 · 요약 · 비교 · 표 |
| `lib.test.mjs` | `node:test` — 순수 함수 전부 |
| `scenarios/fixture.json` | `colo-beta-fixture` 용 7개 |
| `scenarios/cds.json` | CDS 레포(`cds-design-*`)용 5개 |
| `README.md` | 쓰는 법 한 쪽 — 한국어 |

명령:

```bash
# 데스크톱 개발 실행을 접속 파일과 함께 띄운 뒤
COLO_DESIGN_BENCH_ENDPOINT=/tmp/colo-bench.json pnpm dev:desktop
node scripts/bench/bench.mjs run --endpoint /tmp/colo-bench.json --project colo-beta-fixture \
  --scenarios scripts/bench/scenarios/fixture.json --provider omp --model devin/swe-2 --effort high --label before
node scripts/bench/bench.mjs compare bench-results/<a>.json bench-results/<b>.json
```

`run` 의 인자: `--endpoint <file>` 또는 `--url <ws 주소>`(둘 중 하나 필수), `--project <slug>`(필수),
`--scenarios <file>`(필수), `--provider` · `--model` · `--effort`(없으면 `session.create` 에서 뺀다),
`--label <이름>`(기본 `run`), `--only <id,id>`, `--repeat <N>`(기본 1), `--yes`.

안전: `--project` 가 `colo-beta-fixture` 가 아니면 "이 프로젝트의 원격에 작업 가지가 올라갑니다" 를
찍고 `--yes` 없이는 멈춘다. 벤치는 세션을 지우지 않는다(닫기만).

시나리오 하나의 흐름:

1. 시작할 때 한 번 `project.activate { slug }`.
2. 클론 경로 = `${COLO_DESIGN_PROJECTS_DIR ?? ~/.colo-design/projects}/<slug>/repo`. `git rev-parse HEAD` 를
   `startSha` 로 적는다(읽기만).
3. `session.create { provider?, model?, effort?, title: "벤치 · <id>" }` — 응답의 세션 id 모양은
   `dispatch.ts` 의 `session.create` 처리에서 확인한다.
4. `session.send { sessionId, text, pins?, pinHints? }` — 핀 시나리오는 `lib.mjs` 의 `pinTurnText` 가 만든
   표식 턴(`packages/protocol/dist` 의 `markTurn` 을 쓴다; 모양은 `packages/web/src/lib/preview-turns.ts`
   `pinsToTurn` 을 따르되 필요한 줄만: 문장 · 안내 한 줄 · `1. <label> — "<text>"` · 메모 한 줄).
5. 끝 판정 — 통계 파일(`${COLO_DESIGN_LOG_DIR ?? ~/.colo-design/logs}/turn-stats-<UTC 날짜>.jsonl`, 오늘과
   어제 둘 다)을 2초마다 읽어 이 `sessionId` 의 행을 모은다. 턴 행이 하나 이상이고 그 뒤에 `gateset` 행이
   있으면 끝. 그 `gateset` 행이 `reopened: true` 면 턴 행 하나를 더 기다린다(게이트는 두 번 서지 않는다).
   상한 15분 → 결과 `timeout`.
6. 자동 보관을 기다린다 — `HEAD` 가 `startSha` 에서 움직이거나 20초가 지날 때까지 1초마다.
7. 바뀐 파일 = `git diff --name-only <startSha> HEAD` ∪ `git status --porcelain` 의 경로.
8. 판정(`judge`) — `expect.files` 의 각 항목(부분 문자열)이 바뀐 파일 중 하나에 들어 있다,
   `expect.contains` 의 각 문자열이 바뀐 파일 중 하나의 지금 내용에 있다, 마지막 턴 행의 `isError` 가
   false. 모두 참이면 통과, 아니면 이유 목록.
9. `session.close { sessionId }`.

결과 파일 `bench-results/<YYYYMMDD-HHmm>-<label>.json`(루트 `.gitignore` 에 `bench-results/`):

```json
{ "label": "before", "startedAt": "…", "project": "…", "provider": "…", "model": "…", "effort": "…",
  "scenarios": [{ "id": "search", "pass": true, "reasons": [], "startSha": "…",
                  "turns": [/* 턴 행 그대로 */], "gate": {/* gateset 행 */}, "changed": ["server.js"] }] }
```

`run` 이 끝나면 표를 찍는다 — 시나리오마다 통과 · 총 시간(턴 행 `durationMs` 합) · 첫 편집(첫 턴의
`firstEditMs`) · 컨텍스트(최대 `contextTokens`) · 브라우저 호출(합) · 브라우저 시간(`browserMs` 합, 없으면 -) ·
exec(합) · 게이트 재개. `compare` 는 두 결과의 같은 id 끼리 같은 칸의 중앙값과 변화율, 통과 수를 찍는다.

`fixture.json` — `colo-beta-fixture`(한 파일 `server.js` 가 `/list` · `/member/<id>` · `/join` · `/notice` ·
`/schedule` 을 낸다):

| id | 종류 | 말 | expect.files |
|---|---|---|---|
| `search` | user | 공지 화면에 제목으로 거르는 검색창을 넣어 줘. | `server.js` |
| `detail` | user | 공지를 누르면 그 공지의 상세 화면이 나오게 해 줘. | `server.js` |
| `form` | user | 모임 일정 화면에 새 일정을 적는 폼을 넣어 줘. 날짜와 장소를 적게 해 줘. | `server.js` |
| `sort` | user | 회원 목록을 이름순으로 정렬해 줘. | `server.js` |
| `empty` | user | 모임 일정이 하나도 없을 때 보이는 빈 상태 문구를 넣어 줘. | `server.js` |
| `pin-title` | pin | 핀 screen `list`, text `회원 목록`, 메모 "제목을 더 크게 해 줘" | `server.js` |
| `pin-button` | pin | 핀 screen `join`, text `등록하기`, 메모 "버튼을 파란색으로 바꿔 줘" | `server.js` |

`cds.json` — 화면이 `src/screens/<feature>/<Screen>.screen.tsx` 에 사는 CDS 레포. 시나리오를 쓰기 전에
`~/.colo-design/projects/cds-design-second-repo/repo/src/screens` 를 **읽기만** 해서 실제 있는 기능 폴더로
맞춘다. 기본안: 회원 목록 가입일 필터(`src/screens/member/`) · 상품 상세 화면(`src/screens/product/`) ·
쿠폰 만들기 폼(`src/screens/coupon/`) · 주문 목록 최신순 정렬(`src/screens/order/`) · 회원 목록 검색 결과
없음 문구(`src/screens/member/`). 있는 폴더가 다르면 그 폴더로 바꾼다.

루트 `package.json`: `"bench": "node scripts/bench/bench.mjs"` 를 더하고, `test` 끝에
`scripts/bench/*.test.mjs` 를 잇는다.

**시험(`lib.test.mjs`)**: 시나리오 검증(필수 칸 · 종류 · 중복 id), `pinTurnText` 의 첫 줄이
`<!-- colo-design:comments ` 로 시작하고 items 의 id 가 `pinHints` 의 id 와 같다, 행 모으기(다른 세션 · 깨진 줄
무시 · 이틀 치), 끝 판정(턴만 · 턴+gateset · reopened 뒤 한 턴 더), 판정(파일 부분 일치 · 내용 · isError),
요약 칸 계산, 비교의 중앙값 · 변화율 · 한쪽에만 있는 id.

### 3.B 화면 색인 (H-3 · H-4 · H-5)

**B-1 새 모듈 `packages/daemon/src/route-index.ts`** — 파일 내용은 읽지 않는다. 파일 목록은
`pin-files.ts` 의 `collectCodeFiles` 를 export 해서 같이 쓴다(건너뛰는 폴더 · 확장자 · 상한이 같아야 한다).

```ts
/** 주소 → 파일 후보. 없으면 null. files 는 레포 루트 상대 경로(슬래시). */
export async function filesForRoute(
  repoRoot: string,
  route: string,
  max?: number, // 기본 3
): Promise<{ files: string[]; source: "path" | "dynamic" } | null>;

/** 바뀐 파일 → 게이트가 열 화면 주소(경로 모양 `/a/b`). 순수 함수. */
export function routesForFiles(changed: string[], rows: ScreenMapRow[]): string[];
```

규칙(모두 순수 도우미로 나누고 export 해서 시험한다):

- **주소 조각** `routeSegments(route)`: `/member/list` · `member/list` · `index`(= 루트) · 전체 주소(루프백이면
  경로만, 아니면 빈 결과) 를 받는다. `?` · `#` 뒤는 버린다. 각 조각은 `decodeURIComponent`. 빈 조각은 버린다.
- **파일 조각** `fileSegments(rel)`: 확장자를 **모두** 벗긴 이름(`MemberList.screen.tsx` → `MemberList`,
  `page.tsx` → `page`). 이름이 `page` · `index` 면 이름은 바로 위 폴더 이름이 되고 그 폴더는 dirs 에서 빠진다.
  `.test.` · `.spec.` · `.stories.` · `.d.ts` 와 `__tests__` 폴더 안의 파일은 null(후보가 아니다).
- **비교 열쇠** `segmentKey(s)`: 소문자, `-` · `_` · 공백 제거. `member-list` = `MemberList` = `member_list`.
- **점수**: 마지막 주소 조각의 열쇠가 파일 이름의 열쇠와 같아야 한다. 나머지 주소 조각이 파일의 dirs 에
  **순서대로**(부분열) 모두 나오면 "온전한 일치". 온전한 일치만 `source: "path"` 후보다. 정렬: 이름에
  `.mock.` · `.data.` · `.fixture.` 가 없는 것 먼저 → 경로 짧은 것 → 사전순.
- **루트(`/`)**: `app/page.*` · `src/app/page.*` · `pages/index.*` · `src/pages/index.*` 중 있는 것만.
- **동적 경로(보조)**: 온전한 일치가 없을 때만. `app|src/app` 아래 이름이 `page` 인 파일과
  `pages|src/pages` 아래 파일(`api/` 폴더 · `_app` · `_document` · `_error` 제외)을 경로 패턴으로 읽는다 —
  `(group)` 폴더는 없는 셈, `@slot` · `_private` 폴더 안은 제외, `[x]` 는 조각 하나, `[...x]` 는 하나 이상,
  `[[...x]]` 는 0개 이상. 맞는 패턴 중 고정 조각이 가장 많은 **하나**만 `source: "dynamic"` 으로 낸다.
- **routesForFiles**: ① `rows` 를 최근 것부터 — 행의 `files` 에 바뀐 파일이 하나라도 있으면 그 행의
  `screens[].route`(없으면 `routes` 를 `screen-map.ts` 의 `normalizeRoute` 와 같은 규칙으로 편 것; 빈 결과는
  버린다). ② 바뀐 파일이 Next.js 의 **고정** 경로 page 파일이면(위의 동적 규칙으로 읽어 `[` 가 없는 패턴)
  그 주소. 중복을 접고 `screen-gate.ts` 의 `MAX_GATE_SCREENS` 에서 자른다. **파일 이름에서 주소를 지어내지
  않는다**(H-5). `normalizeRoute` 가 export 돼 있지 않으면 export 해서 같이 쓴다(복제 금지).

**B-2 `screen_files`.** `browser-tools.ts`:

- `screenFilesAnswer(observed, hunted, title, routed: string[] = [])` — 넷째 인자를 더한다. 줄 순서는
  `(주소)` → `(관찰)` → `(글자 "…")`, 겹치는 파일은 앞 줄에 한 번, 합의 상한은 그대로 `SCREEN_FILES_MAX`.
  줄 모양: `파일 후보: a · b (주소)`. 셋 다 비면 지금 문장 그대로. 기존 시험은 고치지 않고 통과해야 한다.
- `screen_files` 설명의 첫 문장에 "레포의 파일 구조(주소와 같은 이름의 파일)" 를 더한다.
- `server.ts` 의 `screenFiles` 처리가 `filesForRoute(workspaces.paths.repoRoot, route)` 를 부르고
  (실패는 빈손) 그 files 를 넷째 인자로 넘긴다.

**B-3 핀 후보.** `pin-files.ts` `enrichCommentsTurn`: 정체 사냥이 빈손인 블록은 **주소 → 관찰** 순서로
길을 찾는다. `hint.screen` 이 있으면 `filesForRoute(root, hint.screen)` 가 먼저 — 있으면
`   파일 후보: a · b (주소)`, 없으면 지금의 관찰 길 그대로. 댄 후보는 `candidates` 에 들어간다(pinHit 의 재료).
멱등 규칙(이미 `파일 후보:` 가 있는 블록은 둔다)은 그대로다.

**B-4 게이트의 새 입력.** 이 턴에 모인 화면이 없어도, 게이트를 걸 수 있는 세션이면 바뀐 파일에서 화면을
되짚는다.

- `preview-drivers.ts` 에 `gateEligible(sessionId): boolean` — 드라이버 팩토리가 있고 아직 게이트를 걸지 않은
  세션(= `gatePossible` 에서 "모인 화면이 있다" 조건만 뺀 것).
- `server.ts` `onState` 의 게이트 갈래를 셋으로 나눈다. 지금의 두 몸통은 **글자 그대로** 두 private 메서드로
  옮긴다 — `startGate(sessionId, turnDurationMs)`(지금의 if 몸통) 와 `finishWithoutGate(sessionId, state,
  turnDurationMs)`(지금의 else 몸통). 그리고:

```ts
if (state === "idle" && this.drivers.gatePossible(sessionId)) {
  this.startGate(sessionId, turnDurationMs);
} else if (state === "idle" && this.autoSaveDue.has(sessionId) && this.drivers.gateEligible(sessionId)) {
  void this.gateFromChangedFiles(sessionId).then(
    () => this.gateAfterFallback(sessionId, turnDurationMs),
    () => this.gateAfterFallback(sessionId, turnDurationMs),
  );
} else {
  this.finishWithoutGate(sessionId, state, turnDurationMs);
}
```

  - `gateFromChangedFiles(sessionId)`: 세션의 작업 공간(`workspaceOfSession`)에서 `repo.diff()` 의 경로와
    `readScreenMap(paths.root)` 로 `routesForFiles` 를 구해 각 주소를 `notePinned` 한다. 되짚은 수를
    기억해 둔다(아래 통계).
  - `gateAfterFallback`: 세션이 여전히 `idle` 이고 `gatePossible` 이면 `startGate`, 아니면
    `finishWithoutGate(sessionId, "idle", turnDurationMs)`. 세션이 그 사이 다시 돌기 시작했으면
    (`onTurnStart` 가 이미 모인 화면을 비웠다) 아무것도 걸지 않고 `finishWithoutGate` 도 부르지 않는다 —
    자동 보관의 표(`autoSaveDue`)는 남아 다음 idle 이 치른다. `runAutoSave` 가 도는 턴을 스스로 거르는지
    먼저 확인하고, 거르지 않으면 이 규칙을 지킨다.
- 통계: `TurnStats.noteGateCheck` 의 outcome 과 `TurnGateRow` 에 `fallback?: number`(바뀐 파일에서 되짚은
  화면 수, 0 이면 싣지 않는다). `startGate` 가 그 수를 넘긴다.
- 되짚은 화면도 `screenMapDue` 스냅샷(지금 코드)을 그대로 타서 관찰 지도에 적힌다 — 지도가 스스로 자란다.

**시험**: `packages/daemon/test/route-index.test.ts` — 조각 · 열쇠 · 점수 · 정렬(순수), 임시 클론으로
`filesForRoute`(CDS 모양 `src/screens/member/MemberList.screen.tsx` + `.mock.ts` → 둘 다, 화면 파일 먼저;
Next `app/member/list/page.tsx` → path; `app/(admin)/member/[id]/page.tsx` 와 `/member/7` → dynamic;
`pages/index.tsx` 와 `/`; 테스트 · 스토리 파일 제외; 빈손 null), `routesForFiles`(관찰 행 적중 · 외부 주소 버림 ·
고정 page · 동적 page 는 안 냄 · 지어내지 않음 · 상한). `screen-files.test.ts` 에 `(주소)` 줄 순서 · 중복 ·
상한 셋. `pin-files` 의 주소 후보는 기존 핀 시험이 있으면 거기에, 없으면 route-index 시험에 한 건.
`turn-stats-measure.test.ts` 에 `fallback` 한 건. 게이트 갈래(server.ts)는 순수 시험이 어려우면 손 검증
시나리오(§5)로 둔다.

### 3.C 타입 진단 (H-7 · H-8)

**C-1 새 모듈 `packages/daemon/src/type-check.ts`.**

```ts
export interface TscDiagnostic { file: string; line: number; col: number; code: string; message: string }
export type TypeCheckResult =
  | { status: "ok"; diagnostics: TscDiagnostic[]; ms: number }
  | { status: "unavailable"; reason: string }
  | { status: "timeout"; ms: number }
  | { status: "failed"; reason: string };

/** 무엇을 돌릴지 — 레포 루트에 tsconfig.json 과 node_modules/typescript/bin/tsc 가 둘 다 있어야 한다. */
export function typeCheckPlan(repoRoot: string, buildInfoFile: string):
  { command: "node"; args: string[] } | { unavailable: string };
/** `--pretty false` 출력 → 진단. 순수. */
export function parseTscOutput(text: string): TscDiagnostic[];
/** 도구의 답 문장. 순수. changed 는 레포 루트 상대 경로. */
export function diagnosticsAnswer(result: TypeCheckResult, changed: string[]): string;

export class TypeChecker {
  constructor(deps?: { spawn?: typeof import("node:child_process").spawn; timeoutMs?: number });
  check(repoRoot: string, projectRoot: string, env: NodeJS.ProcessEnv): Promise<TypeCheckResult>;
  /** 빌드 정보 파일이 아직 없고 도는 검사가 없을 때만 한 번 돈다. 실패는 삼킨다. */
  prewarm(repoRoot: string, projectRoot: string, env: NodeJS.ProcessEnv): void;
  /** 도는 자식을 모두 끝낸다(데몬 stop). */
  dispose(): void;
}
```

- 인자: `[<repoRoot>/node_modules/typescript/bin/tsc, "--noEmit", "--pretty", "false", "--incremental",
  "--tsBuildInfoFile", <projectRoot>/tsc.tsbuildinfo, "-p", "tsconfig.json"]`, cwd 는 repoRoot, env 는
  `repo-bringup.ts` 의 `repoCommandEnv(process.env)`(번들 node 가 PATH 앞에 온다). 실행 파일은 `"node"` —
  데스크톱에서 `process.execPath` 는 Electron 이므로 쓰지 않는다.
- 없을 때의 이유 문장: `tsconfig.json 이 없습니다` · `typescript 가 설치돼 있지 않습니다`.
- 파싱: `^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$` 가 한 진단. 들여 쓴 다음 줄들은 앞 진단의 이어진
  말이다 — `message` 에는 첫 줄만 두고 버린다. `error TS5083: …` 처럼 파일 없는 줄은 `file: ""`.
  경로의 `\` 는 `/` 로.
- 종료 코드 0 → ok(0건). 0 이 아니고 진단이 하나 이상 → ok. 0 이 아니고 진단이 없음 → failed(비지 않은
  마지막 출력 줄, 200자). 상한(기본 120초)을 넘으면 자식을 죽이고 timeout.
- **줄 세우기**: 같은 repoRoot 에 도는 검사가 있으면 **하나만** 뒤에 줄을 세운다 — 줄 선 동안 온 호출은
  모두 그 줄 선 검사의 결과를 받는다(편집이 그 사이 있었을 수 있으니 도는 검사의 결과를 재사용하지 않는다).
- `diagnosticsAnswer`:
  - ok · 0건 → `타입 오류 없음 (N초)`
  - ok · 있음 → 첫 줄 `타입 오류 N건 — 이번에 바뀐 파일에서 M건`, 이어서 `- <file>:<line>:<col> <code> <message
    200자>` 를 바뀐 파일의 것 먼저, 그다음 나머지, 합쳐 30줄. 넘으면 `… 나머지 K건`.
  - unavailable → `이 레포에는 타입 검사가 없습니다 — <reason>`
  - timeout → `타입 검사가 N초 안에 끝나지 않았습니다 — 레포의 검사 명령으로 확인하십시오`
  - failed → `타입 검사를 실행하지 못했습니다 — <reason>`
  - 어느 것도 `isError` 가 아니다(사실을 알리는 답이다).

**C-2 도구 `repo_diagnostics`.** `browser-tools.ts` 의 `BROWSER_TOOLS` 에서 `submit_for_review` **바로 앞**에
(`screen-files.test.ts` 가 목록 끝의 둘을 본다):

```ts
{
  name: "repo_diagnostics",
  op: "repoDiagnostics",
  description:
    "레포의 타입 검사를 돌려 이번에 바뀐 파일의 오류부터 돌려준다 — 두 번째부터는 바뀐 곳만 다시 보므로 " +
    "몇 초 안에 끝난다. 편집 사이사이의 확인은 이것으로 하고, 레포의 검사 명령 전체는 답하기 전에 한 번만 " +
    "돌린다. 미리보기가 없어도 돈다.",
  properties: {},
}
```

- `server.ts`: `BROWSER_OPS` · `BROWSER_QUIET_OPS` 에 `repoDiagnostics: true`. `notifyDeveloper` 처리 **뒤**에
  새 처리 — 세션의 작업 공간을 찾고(없으면 `ok: false` 와 `이 세션의 프로젝트를 찾지 못했습니다.`),
  `this.typeChecker.check(paths.repoRoot, paths.root, repoCommandEnv(process.env))` 와 `repo.diff()` 의 경로로
  `diagnosticsAnswer` 를 만들어 `ok: true` 로 답한다. `observeBrowserOp` 로 시간을 잰다(다른 처리와 같이).
- 서버 필드 `private readonly typeChecker = new TypeChecker();` — 데몬 stop 에서 `dispose()`.
- `onTurnStart` 에서 세션의 작업 공간이 있으면 `prewarm` — 첫 턴의 AI 가 생각하는 동안 첫 검사(가장 느린
  한 번)가 끝난다.

**시험**: `packages/daemon/test/type-check.test.ts` — 파싱(한 줄 · 이어진 줄 · 윈도우 경로 · 파일 없는 오류),
답 문장(0건 · 바뀐 파일 먼저 · 30줄 상한과 나머지 · 셋의 상태 문장), 계획(tsconfig 없음 · typescript 없음 ·
둘 다 있으면 빌드 정보 파일이 레포 밖), 줄 세우기(가짜 spawn — 동시에 셋이 불러도 자식은 둘, 셋째는 둘째의
결과를 받는다), 상한(가짜 spawn 이 끝나지 않으면 timeout · 자식이 죽는다). **진짜 tsc 한 건**: 임시 폴더에
`tsconfig.json` 과 타입 오류가 있는 `a.ts` 를 두고 `node_modules/typescript` 를 이 모노레포의 설치본으로
심볼릭 링크해 `check` 가 그 오류를 돌려주는지, 두 번째 호출이 빌드 정보 파일을 쓰는지 본다. 도구 목록 시험에
`repo_diagnostics` 의 자리(`submit_for_review` 앞) 한 건.

### 3.D 게이트의 타입 오류 · 지침 · README (H-9 · H-10 · H-11) — 물결 2

B · C 가 합쳐진 `harness-int` 위에서 한다. B 가 `server.ts` 의 게이트 갈래를 `startGate` ·
`finishWithoutGate` · `gateFromChangedFiles` · `gateAfterFallback` 로 나눴고, C 가 `TypeChecker` 와
`repoCommandEnv` 를 서버에 들였다 — 이 묶음은 그 둘을 잇는다.

**D-1 순수 판정 — `type-check.ts` 에 더한다.**

```ts
/** 게이트 브리프의 타입 절 상한. */
export const MAX_TYPE_LINES = 10;
/** 이 턴이 바꾼 TypeScript 파일인가 — `.ts` · `.tsx` · `.mts` · `.cts`(`.d.ts` 포함). */
export function isTypeScriptFile(rel: string): boolean;
/**
 * 게이트가 브리프에 실을 타입 오류 — result 가 ok 이고 changed 안의 파일에 오류가 있을 때만.
 * lines 는 `- <file>:<line>:<col> <code> <message 200자>` 를 MAX_TYPE_LINES 까지, 넘으면 끝에
 * `… 나머지 K건`. errors 는 changed 안의 오류 전체 수. 없으면 null.
 */
export function typeTroublesOf(result: TypeCheckResult, changed: string[]): { lines: string[]; errors: number } | null;
```

**D-2 브리프 — `screen-gate.ts` `gateBrief(troubles, typeLines: string[] = [])`.** 둘째 인자를 더한다.
기존 호출 · 시험은 그대로 통과해야 한다. 표식은 그대로 `{ kind: "gate", step: "화면 확인" }`(사용자 면에
새 말 없음).

- 타입 절: `### 타입 검사` · `이번 턴에 고친 파일에서 타입 검사가 찾은 오류입니다.` · typeLines 를 줄마다.
- 화면 문제가 있으면: 지금의 머리 문장과 화면 블록들, 그 뒤에 타입 절.
- 화면 문제가 없고 타입 절만 있으면 머리 문장은
  `이번 턴에 고친 파일을 도구가 타입 검사했습니다. 아래를 고친 뒤 답해 주세요.`

**D-3 게이트 — `preview-drivers.ts`.**

- `PreviewDriverDeps` 에 선택 콜백
  `typeTroubles?(sessionId: string): Promise<{ lines: string[]; errors: number; ms: number } | null>`.
- `GateOutcome` 의 모든 갈래에 선택 칸 `typeErrors?: number` · `typeMs?: number` 를 더한다(교차 타입 하나로).
  `gateOutcomeStats` 가 그 둘을 그대로 넘긴다.
- `runGate` 의 순서:
  1. `no-driver` · `no-session` 판정은 지금 그대로 먼저.
  2. `typeTroubles` 를 부른다(실패는 null). 결과가 있으면 `typeErrors` · `typeMs` 를 결과의 모든 갈래에 싣는다.
  3. 모인 화면이 없고 타입 줄도 없으면 지금처럼 `no-screens`.
  4. 모인 화면이 있으면 지금의 미리보기 · origin · 검사 흐름. 단 미리보기 주소가 없을 때(`no-preview`)와
     origin 을 지난 화면이 0 일 때는, 타입 줄이 있으면 화면 없이 계속 간다.
  5. 게이트 자신이 깨진 것(`broken`)은 지금 그대로 `broken` 으로 끝낸다(타입 줄도 버린다 — 드물고, 다음
     사람의 턴이 다시 본다).
  6. 화면 문제도 타입 줄도 없으면 `ok`. 있으면 지금의 `busy` 판정 · `gatedSessions` · 알림 · 그림 첨부
     그대로 하고 `session.send(gateBrief(troubles, typeLines), captures)`.
- 사용자의 한 턴에 한 번 규칙(`gatedSessions`)은 그대로다.

**D-4 서버 — `server.ts`.**

- `new PreviewDrivers({ … })` 에 `typeTroubles` 를 준다: 세션의 작업 공간 → `repo.diff()` 의 경로 중
  `isTypeScriptFile` 인 것 → 없으면 null(검사를 돌리지 않는다) → 있으면 `this.typeChecker.check(repoRoot,
  paths.root, repoCommandEnv(process.env))` 와 `typeTroublesOf` → `{ lines, errors, ms }`(오류가 없으면
  lines `[]` · errors 0 — 검사를 돌린 사실은 통계에 남긴다).
- 화면이 없어도 타입 오류로 게이트가 서도록: `gateFromChangedFiles` 가 `{ tsChanged: boolean }` 을
  돌려주고(바뀐 경로 중 `isTypeScriptFile` 이 하나라도 있으면 true), `gateAfterFallback(sessionId,
  turnDurationMs, tsChanged)` 가 `gatePossible || tsChanged` 이면 `startGate`, 아니면 지금처럼
  `finishWithoutGate`. 되짚는 사이 새 턴이 시작된 경우의 규칙은 그대로다.
- `startGate` 는 지금 그대로 — `runGate` 가 화면 없는 타입 게이트를 스스로 처리한다.

**D-5 통계 — `turn-stats.ts`.** `TurnGateRow` 와 `noteGateCheck` 의 outcome 에 `typeErrors?: number` ·
`typeMs?: number`. 검사를 돌렸으면 0 도 싣는다(돌지 않은 게이트와 오류 0 인 게이트를 가른다).

**D-6 지침 — `common-instructions.ts`.**

- 첫 불릿의 `턴이 끝나면 기계가 그 화면을 다시 열어 확인하므로,` 를
  `턴이 끝나면 기계가 그 화면을 다시 열고 이번에 고친 파일의 타입 오류도 함께 보므로,` 로.
- `screen_files` 불릿 바로 뒤에 새 불릿 한 줄(소스는 템플릿 문자열이라 백틱은 이웃 불릿들처럼 `\`` 로 쓴다):
  `- 편집 사이사이의 확인은 \`repo_diagnostics\` 로 한다 — 이번에 바뀐 파일의 타입 오류부터 몇 초 안에 돌려준다. 레포의 검사 명령 전체는 답하기 전에 한 번만 돌린다.`
- 머리 주석에 날짜 한 줄(2026-09-28 — repo_diagnostics · 게이트의 타입 오류, PLAN-HARNESS §3.D).
- 불릿은 `- ` 한 줄 형식을 지킨다(`stripCommonInstructions` 가 그 모양만 규칙으로 센다).
  `common-instructions.test.ts` 가 세는 것이 있으면 맞춘다.

**D-7 README.** 같은 목소리로, 해당 문단만 고친다(새 절을 만들지 않는다).

| 자리 | 고칠 것 |
|---|---|
| 「턴 끝의 화면 확인」 | 가리킨 화면이 없을 때 바뀐 파일에서 되짚는 두 길(한 화면에만 속한 코드 파일의 관찰 · Next.js 고정 page), 파일 이름으로 주소를 짓지 않는 이유 한 문장. 이번 턴에 고친 TypeScript 파일의 타입 오류가 브리프의 `### 타입 검사` 절로 가고, 화면이 없어도 그 절만으로 게이트가 선다. "판정의 범위가 '이 턴이 연 화면' 인 이유는 하나다: 바뀐 파일에서 화면 주소를 끌어낼 길이 없다" 는 문장은 지금 사실에 맞게 고친다 |
| 「자동 보관 · 제출 · 반영됨」 의 check · build 문단 | 타입 오류는 게이트가 고침 턴으로 AI 에게 돌려줄 뿐 보관 · 제출을 막지 않는다는 한 문장 |
| 「코멘트 핀」 | 정체가 빈손인 핀의 후보 길이 주소(`(주소)`) → 관찰(`(관찰)`) 순서 |
| `screen_files` · 도구 목록을 말하는 자리 | `(주소)` 줄, 새 도구 `repo_diagnostics`(도구 수를 말하면 그 수도) |
| 「도구가 기계에 남기는 것」 표 | `~/.colo-design/projects/<slug>/tsc.tsbuildinfo` 한 줄. 턴 통계 줄에 게이트 행의 `fallback` · `typeErrors` · `typeMs` |
| 환경 변수 표 | `COLO_DESIGN_BENCH_ENDPOINT` — 개발 실행의 데스크톱이 벤치 접속 파일을 적는 자리, 패키징된 앱은 보지 않는다 |
| 「테스트」 | 재생 벤치 한 단락과 명령 셋(데스크톱을 접속 파일과 함께 띄우기 · `pnpm bench run …` · `pnpm bench compare …`), 자세한 것은 `scripts/bench/README.md` |

**시험**: `type-check.test.ts` 에 `isTypeScriptFile` · `typeTroublesOf`(바뀐 파일만 · 10줄 상한과 나머지 ·
ok 아닌 결과는 null · 오류 0 은 null). 게이트 브리프 시험이 있는 파일(`screen-check.test.ts` 등 —
`rg gateBrief packages/daemon/test` 로 찾는다)에 타입 절만 · 화면+타입 · 둘째 인자 없음(기존 모양 그대로).
`runGate` 의 타입 갈래는 가짜 deps 로 부를 수 있으면 시험(화면 없음+타입 줄 → 브리프 전송 · `no-preview`
+타입 줄 → 전송 · 타입 줄 없음 → 지금과 같은 skipped), 어려우면 손 검증 시나리오로 둔다.
`turn-stats-measure.test.ts` 에 `typeErrors: 0` 이 실리는 것 한 건.

---

## 4. 왜 이렇게

| 대안 | 버린 이유 |
|---|---|
| 상주 `tsc --watch` | 프로젝트마다 수백 MB 가 늘 산다. 편집 직후 물으면 아직 다시 컴파일하지 않은 결과를 준다 — 신선도를 맞추는 규칙이 따로 필요하다 |
| 파일 이름으로 주소를 지어 게이트에 넣기 | `src/screens/member/MemberList.screen.tsx` → `/member/MemberList` 는 이 레포에서는 맞지만 레포마다 접두가 다르다. 틀린 주소는 404 문서 요청 실패로 "문제"가 되어 AI 가 없는 화면을 고친다 |
| 레포 검사(`check`)를 데몬이 돌리기 | 레포마다 무엇을 하는지 모른다(생성 · 규칙 검사 · 빌드). 타입 검사는 모든 TypeScript 레포에서 같은 뜻이다 |
| 공통 지침에 규칙을 더 쓰기 | 모든 턴의 프롬프트가 커질 뿐 방향 잡기가 줄지 않는다. 레포의 규칙은 레포의 CLAUDE.md 가 맡는다 |

---

## 5. 검증

### 5.1 자동

- `pnpm test`(빌드 뒤 단위 시험 — 새 시험: `route-index` · `type-check` · `screen-files` 추가분 ·
  `turn-stats-measure` 추가분 · `scripts/bench/lib.test.mjs`), `pnpm typecheck`(`pnpm build` 뒤), `pnpm build`.

### 5.2 손 검증 (`pnpm dev:desktop`)

| # | 시나리오 | 기대 |
|---|---|---|
| A-1 | `COLO_DESIGN_BENCH_ENDPOINT=/tmp/colo-bench.json pnpm dev:desktop` | 파일이 생기고 0600, 앱을 끄면 지워진다 |
| A-2 | `bench.mjs run … --only sort` | 세션이 하나 열려 돌고 닫힌다, 결과 파일과 표 |
| B-1 | CDS 레포에서 "회원 목록 화면의 빈 상태 문구 바꿔 줘"(핀 없음) | `screen_files` 의 첫 줄이 `(주소)` 로 화면 파일과 목 파일 |
| B-2 | 한 번 고친 적 있는 화면을 AI 가 `screen_check` 없이 고친 턴 | 게이트 행 `fallback ≥ 1`, 그 화면이 다시 열린다 |
| B-3 | testid 없는 요소에 핀 | `파일 후보: … (주소)` |
| C-1 | CDS 레포에서 AI 에게 "타입 오류를 확인해 줘" | 첫 호출 수십 초 안, 둘째 호출 몇 초 |
| C-2 | fixture(TypeScript 없음) | `이 레포에는 타입 검사가 없습니다 — tsconfig.json 이 없습니다` |

### 5.3 벤치 — 전후 비교

A 가 합쳐지면 `harness-int` 의 A 만 든 빌드로 `before`, B · C · D 를 합친 빌드로 `after` 를 같은
fixture 에서 omp · swe-2 로 돌린다. 기대: `firstEditMs`(핀 · 이름 시나리오) 감소, exec 감소(CDS),
게이트 `no-screens` 비율 감소. 수치는 이 절 아래에 덧붙인다.

---

## 6. 열린 항목

| # | 항목 | 여는 조건 |
|---|---|---|
| O-1 | 파일 이름에서 주소를 지어 게이트에 넣기 | 게이트 전에 그 주소가 실제로 서는지(문서 요청 200) 확인하는 값싼 길이 생길 때 |
| O-2 | Vite · Next 의 오류 오버레이 탐지 | 개발 서버의 컴파일 오류가 콘솔 error 없이 오버레이로만 서서 게이트를 지나간 사례가 보일 때 |
| O-3 | 레포 지도 지침(H-6) | CLAUDE.md 없는 Next.js 레포가 연결될 때 |
| O-4 | 벤치의 클론 되돌리기 | 시나리오가 쌓여 전후 비교가 흐려질 때 — 지금은 결과에 `startSha` 를 적어 둔다 |
| O-5 | references 만 가진 `tsconfig.json` | 그런 레포가 연결될 때 — 지금은 검사할 파일이 없어 "타입 오류 없음" 으로 답한다. `tsc -b` 로 돌릴지, `unavailable` 로 말할지 정한다 |

---

## 7. 진행 기록

### 2026-09-28 — 묶음 A~D 합침 (`harness-int`)

| 묶음 | 맡은 이 | 커밋 | 검토에서 돌려보낸 것 |
|---|---|---|---|
| C 타입 진단 | GLM 5.3 | `1e99fab6` · 합침 `690199a6` | 없음 |
| B 화면 색인 | GLM 5.3 | `fe1016f0` · 합침 `0e03e3f9` | ① 관찰 길이 공용 파일로 화면을 몰아 열었다 — fixture 지도에서 `server.js` 한 파일이 화면 다섯에 이어져 있었다. 코드 파일만, 지도 전체에서 화면 둘 이하에 이어진 파일만 본다(`MAX_ROUTES_PER_FILE`). ② `pin-files` ↔ `route-index` 순환 임포트 → `code-files.ts` |
| A 재생 벤치 | GLM 5.3 flash | `37da4b0d` · 합침 `2cbc01f4` | ① 오류 · 중지 턴 뒤에는 gateset 행이 서지 않아 15분을 헛기다렸다 ② 접속 파일의 0600 이 새로 만들 때만 걸렸다 |
| D 게이트의 타입 오류 | GLM 5.3 | `ba584b69` · 합침 `a9f42cef` | ① 미리보기 없음이 `ok` 로 바뀌었다(통계 회귀) ② 게이트가 첫 타입 검사를 120초까지 기다렸다 → 30초 예산(`GATE_TYPE_BUDGET_MS`), ok 아닌 결과는 "보지 않음" ③ README 빈 줄 둘 · 주석 한 줄 · 앞 묶음 주석 어구 |

- 시험: 기준선 667 → 738(새 71건), `pnpm typecheck` 0 오류.
- 13:14 ~ 13:26 KST 에 GLM 5시간 한도로 세 에이전트가 `devin/swe-2` 로 내려가 돌았다. 그 구간의 diff 도 같은 잣대로 검토했다.
- 이 브랜치는 `lifecycle` 에 합치지 않았다 — `lifecycle` 작업 트리의 미커밋 변경과 README · server.ts 가 겹친다.

### 남은 것

- **§5.3 벤치 전후 비교는 아직 돌지 않았다.** `before` 는 `mcp-int`(또는 A 만 얹은 빌드), `after` 는 이 브랜치로 같은 fixture 에서 돌린다. 수치는 이 절에 덧붙인다.
- **§5.2 손 검증은 아직이다.** 특히 B-2(한 번 고친 화면을 `screen_check` 없이 고친 턴의 `fallback`) 와 C-1(CDS 레포의 첫 · 둘째 호출 시간).
- 검토 중에 본 한계, §6 에 더할 것: references 만 가진 `tsconfig.json` 은 아무것도 검사하지 않고 "타입 오류 없음" 으로 답한다(O-5). CDS 레포에서 **처음 만드는** 화면은 관찰 행이 없고 Next 고정 page 도 아니라 되짚기가 닿지 않는다 — 그 턴의 게이트 입력은 여전히 AI 의 `screen_check` · 링크다(O-1 과 같은 뿌리).
