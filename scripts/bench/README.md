# 재생 벤치 (PLAN-HARNESS §3.A)

화면 작업의 효과를 숫자로 재는 스크립트다. 데몬에 WebSocket 으로 붙어 시나리오
(사람의 말 또는 핀 턴)를 실제 세션으로 돌리고, 턴 통계와 바뀐 파일에서 통과
여부를 판정해 결과 파일로 남긴다. 새 의존성은 없다 — Node 22 의 전역
`WebSocket` 과 `node:child_process`, `node:test` 만 쓴다.

## 전제

- 데스크톱 개발 실행이 접속 파일을 쓰게 한다 — 이 파일이 데몬의 ws 주소를
  적어 둔다(패키징된 앱은 절대 쓰지 않는다):

  ```bash
  NOVA_DESIGN_BENCH_ENDPOINT=/tmp/nova-bench.json pnpm dev:desktop
  ```

  대신 독립 데몬(`pnpm dev:daemon`)을 쓸 때는 인쇄되는 `client url` 을
  `--url` 로 직접 건다.
- 대상 프로젝트가 이미 등록돼 있고(초대 파일), 클론이 준비돼 있어야 한다.
  벤치는 `project.activate` 를 부를 뿐 준비를 기다리지 않는다.

## 돌리기

```bash
# fixture 앱(한 파일 server.js) — 원격에 작업 가지가 올라가는 것을 확인했으면 --yes
node scripts/bench/bench.mjs run \
  --endpoint /tmp/nova-bench.json \
  --project nova-beta-fixture \
  --scenarios scripts/bench/scenarios/fixture.json \
  --provider omp --model devin/swe-2 --effort high \
  --label before

# CDS 레포 — fixture 가 아니면 --yes 가 필요하다(원격에 작업 가지가 올라간다)
node scripts/bench/bench.mjs run \
  --endpoint /tmp/nova-bench.json \
  --project cds-design-second-repo \
  --scenarios scripts/bench/scenarios/cds.json \
  --label before --yes
```

| 인자 | 뜻 |
|---|---|
| `--endpoint <파일>` | dev:desktop 이 적어 둔 접속 파일(`--url` 과 둘 중 하나 필수) |
| `--url <ws 주소>` | `ws://127.0.0.1:<포트>/?token=<토큰>` 꼴을 직접 건다 |
| `--project <slug>` | 프로젝트 — 필수. `nova-beta-fixture` 가 아니면 `--yes` 를 요한다 |
| `--scenarios <파일>` | 시나리오 JSON — 필수 |
| `--provider` · `--model` · `--effort` | `session.create` 에 그대로 실린다(없으면 데몬 기본값) |
| `--label <이름>` | 결과 파일 꼬리표(기본 `run`) |
| `--only <id,id>` | 이 id 의 시나리오만 |
| `--repeat <N>` | 시나리오마다 N번(비교는 중앙값으로 접는다) |
| `--yes` | 안전 확인 건너뛰기 |

시나리오 하나의 한 바퀴: `project.activate`(시작에 한 번) → `git rev-parse
HEAD` 로 시작점 → `session.create` → `session.send`(핀 시나리오는
`lib.mjs` 가 만든 표식 턴과 `pins` · `pinHints`) → 턴 통계 파일을 2초마다
읽어 끝을 판정(턴 행 뒤 gateset 행, `reopened` 면 턴 하나 더 — 상한 15분) →
자동 보관 대기(HEAD 가 움직이거나 20초) → 바뀐 파일 판정 → `session.close`.
세션은 닫을 뿐 지우지 않는다.

## 결과와 비교

결과는 `bench-results/<YYYYMMDD-HHmm>-<label>.json` 에 쌓인다(루트
`.gitignore` 에 들어 있다). `run` 이 끝나면 시나리오마다 통과 · 총 시간 · 첫
편집까지 · 컨텍스트 · 브라우저 호출 · 브라우저 시간 · exec · 게이트 재개의
표를 찍는다.

```bash
node scripts/bench/bench.mjs compare bench-results/…-before.json bench-results/…-after.json
```

`compare` 는 같은 id 끼리 같은 칸의 중앙값(`--repeat` 이 쌓은 여러 행을
젶는다)과 총 시간 변화율, 통과 수를 나란히 찍는다. 한쪽에만 있는 id 도 행으로
남는다.

## 시나리오 파일

배열 하나다. 두 종류가 있다:

```json
[
  { "id": "search", "kind": "user",
    "text": "공지 화면에 제목으로 거르는 검색창을 넣어 줘.",
    "expect": { "files": ["server.js"], "contains": ["<input"] } },

  { "id": "pin-title", "kind": "pin",
    "note": "제목을 더 크게 해 줘",
    "pins": [{ "screen": "list", "text": "회원 목록" }],
    "expect": { "files": ["server.js"] } }
]
```

- `expect.files` 의 각 항목은 바뀐 파일 경로(레포 루트 상대)의 **부분
  문자열**이다 — `src/screens/member/` 처럼 폴더를 겨눠도 된다.
- `expect.contains` 는 바뀐 파일 어느 하나의 지금 내용에 있어야 할 문장이다
  (생략 가능).
- 판정에 턴 오류가 더해진다 — 마지막 턴 행의 `isError` 가 참이면 실패다.
- 핀의 `screen` 은 미리보기 주소창의 경로(앞 슬래시 없는 id, 루트는
  `index`)다. `pins` · `pinHints` 는 웹의 핀 턴(`pinsToTurn`)과 같은 모양의
  표식 턴으로 실린다 — 마커의 `items[].id` 와 `pinHints[].id` 가 같아서
  데몬의 파일 후보 강화가 붙는다.

저장소에 둘레가 마련돼 있다 — `scenarios/fixture.json`(nova-beta-fixture 의
7개)과 `scenarios/cds.json`(CDS 레포의 5개, 실제 화면 폴더에 맞춰 뒀다).

## 시험

`pnpm test` 가 `scripts/bench/*.test.mjs` 를 함께 돌린다 — 순수 함수(시나리오
검증 · 핀 턴 · 행 모으기 · 끝 판정 · 판정 · 요약 · 비교)의 시험이다. 데몬이나
미리보기를 부르지 않는다.

## 주의

- 벤치는 실제 세션을 돌린다 — 구독이 타고, 클론에 커밋이 쌓이고, `--yes` 로
  돌린 프로젝트의 원격에 작업 가지가 올라간다. 되돌리기는 결과 파일의
  `startSha` 가 기준이다(자동 되돌리기는 없다 — PLAN-HARNESS O-4).
- 턴 통계 파일은 7일 보존이다 — 결과 파일에 턴 행이 통째로 들어가므로 비교는
  결과 파일끼리 하면 오래간다.
- 접속 파일(`NOVA_DESIGN_BENCH_ENDPOINT`)에는 그 실행의 토큰이 들어 있다.
  임시 폴더에 적게 하고 앱을 끄면 데몬이 지운다.
