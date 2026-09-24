# PLAN — 신경 쓸 것 없는 사이클: 말하기와 제출만

README 는 지금 배포된 것을 적고, 이 문서는 다음 판이 무엇이고 왜인지, 어떤 순서로
짓는지를 적는다. 결정에는 `L` 번호를 달아 코드 주석이 `PLAN L3` 처럼 가리킬 수 있게
한다. `D` · `P` · `E` 같은 글자는 이미 코드 주석에 쓰이고 있어 겹치지 않는 글자를 골랐다.

줄 번호는 2026-09-24 의 작업 트리 기준이다 — 커밋 `f09a7f10` 위에 커밋되지 않은 변경이
얹힌 상태. 단계 0 이 그 변경을 먼저 커밋하므로 줄 번호는 크게 움직이지 않는다.

## 0. 이 판의 한 문장

비개발자는 **말하고, 제출한다.** 코드가 레포에 쌓이고, 개발자에게 넘어가고, 반영되고,
최신 변경을 받아 오는 사이클 전체와 몇 달의 사용 동안 생기는 문제는 도구가 스스로
제자리로 되돌린다. 도구가 못 하는 일은 사용자가 아니라 개발자에게 간다.

### 0.1 약속

| # | 사용자에게 하는 약속 | 지키는 결정 |
| --- | --- | --- |
| I1 | 누르는 것은 `보내기` 와 `제출` 둘이다. 어떤 상태에서도 새 할 일이 생기지 않는다 | L2 · L6 · L9 · L12 |
| I2 | 화면의 문제 문장은 셋이다 — `AI가 고치는 중이에요` · `개발자에게 알렸어요` · `다시 연결이 필요해요` | L8 |
| I3 | 베이스 브랜치에는 쓰지 않는다. 사이클 브랜치는 언제나 베이스 위에 얹힐 수 있다 | L3 · L4 |
| I4 | 모든 자동화에는 예산이 있고, 예산이 마르면 개발자에게 간다 | L7 · L11 |
| I5 | 어디서 끊겨도 다음 시작이 이어받는다. 복구는 멱등이다 | L1 · L2 · L10 |

세 번째 문장만 사용자의 손이 필요하다. 연결 코드(GitHub 토큰)와 AI 로그인은 사용자
본인의 열쇠라 도구가 대신 만들 수 없다. 손은 한 번이다 — 새 초대 파일을 창에 놓거나,
브라우저에서 한 번 로그인한다.

### 0.2 사용자 가정 (2026-09-24)

사용자는 Claude Desktop 을 써 본 사람이다. 모델 · 생각 시간 · 사용 한도 · `@` 언급 ·
메시지를 고쳐 다시 보내기는 이미 안다. 모르는 것은 git · GitHub · 터미널 · 레포의
구조다. 그래서 이 판은 모델 칩 · 사용량 칩 · `@` · `여기서 새 대화` 를 그대로 두고,
**개발자의 어휘와 개발자의 일**만 화면에서 뺀다.

### 0.3 용어

| 말 | 뜻 |
| --- | --- |
| **감독자** (`CycleSupervisor`) | 프로젝트마다 하나. git · GitHub 상태를 관찰해 바람직한 상태와 다르면 조치한다. 사용자에게 설명할 때는 "관리인" |
| **틱** | 감독자의 관찰 → 판정 → 조치 한 바퀴. 타이머 · 사건 · 시작 때 돈다 |
| **차선** (`GitLane`) | 프로젝트마다 하나인 git 쓰기의 줄. 클론을 바꾸는 모든 git 명령은 이 줄에 서서 하나씩 돈다 |
| **조정 표** | 관찰 → 조치의 우선순위 표(L3). 순수 함수 `nextCycleAction` 이 곧 그 표다 |
| **예산** | 같은 문제에 자동 조치를 시도하는 횟수 · 간격의 상한(L7) |
| **문제 키** | 개발자 알림의 중복을 가르는 안정된 이름. `bring-up:port-undetected`, `push:auth` 처럼 |
| **랜딩** | 병합되거나 반려된 사이클을 닫고 다음 상태로 옮기는 일 |
| **이월** | 랜딩할 때 남은 작업을 새 사이클 브랜치로 옮기는 일 |
| **주의** (`attention`) | 화면이 세 문장 중 무엇을 말할지 정하는 상태값 하나(L8) |
| **보관 · 제출 · 반영됨** | 사용자 어휘. 각각 커밋(자동) · 푸시와 PR · 병합. `저장` · `넘기기` · `검토 요청` · `확인 요청` 은 이 판에서 쓰지 않는다 |

## 1. 진단 — 지금 코드의 빈틈

모두 코드에서 확인한 것이다. 마지막 열이 이 판이 존재하는 이유다.

| 영역 | 빈틈 | 자리 | 사용자가 겪는 것 |
| --- | --- | --- | --- |
| 동시성 | git 쓰기를 묶는 잠금이 없다. 약속 슬롯 넷을 손으로 기다리고, 랜딩 · 보관본 복구 · 배경 푸시 · 준비의 최신화는 슬롯 없이 돈다 | repo-core.ts:303-311 · repo-publish.ts:658, 818 · repo-bringup.ts:81 | 드물게 두 git 명령이 한 클론에서 겹친다 |
| 동시성 | 보관이 겹치면 기다리지 않고 던진다 | repo.ts:375-377 | `저장이 진행 중입니다` 오류 |
| 동시성 | 폴러의 "바쁨" 이 전 프로젝트 공통이다 | session-manager.ts:295-315 · project-fleet.ts:408 | 한 프로젝트가 돌면 다른 프로젝트의 병합 감지가 멈춘다 |
| 보관 | 실패 · 중단된 턴의 변경은 다음 성공 턴까지 보관되지 않는다. 자동 보관 표는 메모리에만 있다 | server.ts:352, 489-493 | 앱이 꺼지면 보관 안 된 변경이 남는다 |
| 푸시 | 배경 푸시가 세 번 실패하면 말없이 멈춘다. 주기적 재시도가 없다 | repo-publish.ts:818-828 | 개발자 쪽에 작업이 안 올라간 채로 모른다 |
| 브랜치 | 이름이 이미 있으면 체크아웃하지 않고 이름만 돌려준다 | repo-publish.ts:275-277 | 다른 브랜치에 보관되고 그 이름으로 푸시된다 |
| 브랜치 | 날짜가 UTC 이고, `checkout -B` 가 같은 이름의 로컬 브랜치를 덮는다 | repo-publish.ts:279, 293 | 아침 9시 전의 이름이 어제 날짜 |
| 최신화 | 사이클 중에 대화가 없으면 fetch 만 하고 합치지 않는다. 활성 프로젝트만 10분마다 받는다 | repo-core.ts:691-694 · project-fleet.ts:511-524 | 비활성 프로젝트의 PR 이 베이스와 멀어진다 |
| 최신화 | 사이클 밖에서 베이스에 커밋이 있으면 "갈라짐" 으로 멈추고, 준비 경로에서는 설치 실패로 잘못 분류된다 | repo-core.ts:706-710 · repo-bringup.ts:491-517 | AI 가 고칠 수 없는 과제를 받고 개발자 알림까지 간다 |
| 충돌 | 브리프가 AI 에게 `stash pop` · `stash drop` · 병합 커밋을 시키는데, git 게이트가 병합 중의 커밋 외에는 거절한다 | repo-core.ts:755-776 · session.ts:362, 969-976 | 임시 보관이 남고 같은 충돌이 되풀이된다 |
| 랜딩 | 더러운 트리면 랜딩이 안 되고, 그 뒤 보관 · 제출이 끝난 브랜치 · 끝난 PR 에 계속 쌓인다 | repo-publish.ts:678-688, 426-434 | 반영된 요청에 새 작업이 섞인다 |
| 랜딩 | 사람이 올 때까지 기다린다(상태 확인 · 프로젝트 전환 · 다음 보관) | project-fleet.ts:492-500 | 반영 뒤에도 옛 상태가 오래 보인다 |
| 반려 | 닫힌 PR 을 병합처럼 랜딩하고 작업을 옮기지 않는다. 닫힘 사건이 없다 | repo-publish.ts:586-588 | 반려된 작업이 다음 제출에서 빠진다 |
| 제출 | 열린 PR 을 head 로 찾지 않는다. 레지스트리가 PR 을 잃으면 422 로 실패 | github.ts(조회 없음) · repo-publish.ts:464 | `제출에 실패했습니다` |
| 제출 | 다시 제출할 때 제목 · 본문을 덮는다 | repo-publish.ts:426-434 | 개발자가 고친 본문이 사라진다 |
| 제출 | 캡처를 사이클 브랜치에 커밋한다 | repo-publish.ts:475-520 | 제출마다 이미지가 main 에 영구히 쌓인다 |
| 제출 | 제출 버튼은 AI 초안을 쓰지 않는다. 제목이 프로젝트 이름이다 | ChatColumn.tsx:179-200 · dispatch.ts:760 | 개발자의 PR 목록이 같은 제목으로 찬다 |
| PR | `mergeable_state` 를 보지 않는다. 개발자가 PR 브랜치에 올린 커밋을 받지 않는다 | github.ts:733-736 | GitHub 에는 충돌, 도구는 모름. 다음 푸시가 거절 |
| 코멘트 | 한 페이지만 읽고, 봇을 거르지 않고, 알려진 id 가 메모리에만 있다 | github.ts:325-378 · repo-publish.ts:74 | CI 봇 코멘트에 AI 가 반응. 재시작 뒤 첫 코멘트를 조용히 삼킨다 |
| 코멘트 | AI 가 반영해도 개발자에게 답이 가지 않는다 | project-fleet.ts:638-675 | 개발자는 반영 여부를 모른다 |
| 사이클 기억 | 끝난 PR 이 메모리에만 있다 | repo-publish.ts:83, 623-644 | 재시작 뒤 같은 반영을 두 번 알린다 |
| 위생 | 끝난 브랜치를 지우는 곳이 없다. gc · 디스크 · 베이스 이름 변경 · 클론 손상을 다루지 않는다 | 전역 | 몇 달 뒤 브랜치 목록과 디스크가 찬다 |
| 알림 | 알림 경로가 사용자가 붙이는 Slack 하나다. 데몬이 `escalationConfigured` 를 채우지 않아 설정 폼과 `개발자 부르기` 가 늘 잠겨 보인다 | server.ts:1482-1496 · protocol/project.ts:141 | 알림이 안 가거나, 가는지 알 수 없다 |
| 알림 | 중복 억제 표시를 보내기 전에 찍는다 | escalation.ts:99-101 | 보내기가 실패하면 10분 동안 같은 알림이 조용히 삼켜진다 |
| 알림 | 문장만 가고 어디서 무엇을 하라는지 없고, 풀렸다는 소식이 없다 | escalation.ts:104-124 | 개발자가 살아 있는 문제인지 모른다 |
| 자기치유 | 되살리기 예산이 되살리기 자신의 닫힘으로 초기화된다 | dispatch.ts:913, 966 · server.ts:615-616 | 망가진 CLI 가 끝없이 되살아날 수 있다 |
| 자기치유 | 턴 도중 로그인 만료를 가르지 않는다 | turn-retry.ts:84-100 | 두 번 헛돌고 실패 카드 |
| 자기치유 | 정상 종료에서도 진행 중이던 턴의 기록을 지운다 | session.ts:753, 779 | 앱을 끄면 하던 요청이 흔적 없이 사라진다 |
| 자기치유 | 잃은 말은 사용자가 되살리기를 눌러야 돌아온다 | Composer.tsx:1208 · queue-store.ts:286-303 | 버튼 두 개가 달린 경고 패널 |
| 지침 | AI 가 무엇을 사용자에게 물어도 되는지 규칙이 없고, 의존성은 사용자가 정하라고 한다 | common-instructions.ts:33 | 기술 질문 카드 |
| 화면 | 영어 원문 · 파일 경로 · 명령줄 · 저장소 이름 · PR 번호가 여러 표면에 남아 있다 | 단계 10 의 표 | 읽을 수 없는 문장 |
| 화면 | 프로젝트 지우기가 메뉴에서는 개발 실행 전용인데 Delete 키로는 누구에게나 열린다 | Sidebar.tsx:414-417 | 제출 안 한 작업을 지울 수 있다 |

## 2. 결정

### L1. 클론을 바꾸는 git 은 한 줄로 선다

**차선.** 새 `git-lane.ts` 의 `GitLane` 이 프로젝트마다 하나 있다.

```ts
type LaneKind =
  | "save" | "submit" | "refresh" | "land" | "push"
  | "restore" | "recover" | "hygiene" | "supervise";

class GitLane {
  run<T>(kind: LaneKind, job: () => Promise<T>, opts?: { join?: boolean }): Promise<T>;
  get current(): LaneKind | null;
  idle(): Promise<void>;
}
```

- FIFO. `join: true` 이면 같은 종류가 이미 줄에 있을 때 그 약속에 합류한다 — 보관을
  두 번 부르면 한 번 돈다. 지금처럼 던지지 않는다(repo.ts:375-377).
- `RepoCore` 의 git 실행을 `gitRead` 와 `gitWrite` 로 나눈다. `gitWrite` 는 차선
  안에서만 불린다 — 개발 빌드에서는 단언이 어긴 자리를 던진다. 이것이 "모든 쓰기가
  줄에 섰다" 를 기계적으로 보장한다.
- 네 슬롯(`inFlight` · `publishing` · `refreshing` · `shelving`)은 차선의 `current`
  에서 파생되는 getter 로 남긴다. `busyRefreshing`(repo.ts:342-344) 같은 바깥
  호출자가 흔들리지 않는다.
- 배경 푸시(repo-publish.ts:818-828)도 시도 하나가 차선 작업 하나다. 기다림은 줄 밖에서.

**턴과의 관계.** AI 는 차선 밖에서 파일을 고친다. 그래서 클론의 작업 트리를 바꾸는
조치(stash · merge · checkout · reset · cherry-pick)는 그 클론에서 턴이 도는 동안 서지
않는다. `SessionManager.busyIn(cwd)` 를 더한다 — 지금의 `anyBusy`
(session-manager.ts:295-315)를 프로젝트 하나로 좁힌 판이다. fetch · push · GitHub
읽기는 턴 중에도 된다.

### L2. 감독자 하나가 사이클을 조정한다

```
관찰 (cycle-observe.ts) → 판정 (cycle-reconcile.ts, 순수) → 조치 (cycle-supervisor.ts, 차선 안)
        ▲                                                            │
        └────────────── 수렴할 때까지, 한 틱에 최대 5번 ─────────────────┘
```

- **관찰** `observeCycle(core, github) → CycleSnapshot` 은 git 과 GitHub 를 읽기만 한다.
- **판정** `nextCycleAction(snapshot, ledger, now) → { action, ledger }` 는 순수 함수다.
  조정 표(L3)의 우선순위대로 첫 어긋남 하나에 대한 조치를 고른다. 예산(L7)이 마른
  조치는 `escalate` 로 바뀐다.
- **조치** 는 차선 안에서 돈다. 끝나면 다시 관찰한다. 한 틱에 5번을 넘기면 다음 틱으로
  미룬다 — 조치끼리 고리가 생겨도 틱 하나가 무한히 돌지 않는다.

**틱의 방아쇠.**

| 방아쇠 | 지금 | 이 판 |
| --- | --- | --- |
| 타이머 | 2분(server.ts:82). 전역 바쁨이면 전부 건너뜀. 최신화는 활성 프로젝트만 10분 | 2분, **모든 프로젝트**, 프로젝트별 바쁨만 본다. GitHub 읽기는 활성 2분 · 비활성 10분 |
| 턴이 idle 이 된 직후 | 자동 보관만 | 자동 보관 뒤 틱 |
| 보내기 직전 | `pullBeforeSend`(dispatch.ts:1039-1049). 사이클이 없으면 받지 않음 | 틱(`before-send`), 20초 상한. 넘으면 말이 먼저 나가고 틱은 뒤에서 |
| 앱 시작 | 활성 프로젝트 sync + 전 프로젝트 보관본 복구, 서로 경합 | 프로젝트마다 첫 틱. 복구도 조정 표의 한 줄 |
| 창 포커스 · 연결 코드 갱신 · 초대 재가져오기 | 없음 | 틱 |

**흡수표.** 지금의 절차들은 없어지지 않고 조치의 몸통이 된다.

| 지금 | 이 판 |
| --- | --- |
| `pollOpenHandoffs` (project-fleet.ts:407-531) | 감독자의 타이머 틱. 코멘트 브리프는 `briefReviews` 조치 |
| 조용한 최신화 (project-fleet.ts:511-524) · `pullBeforeSend` | `mergeBase` 조치 |
| `retryBackgroundPush` | `push` 조치 + 지속되는 밀림 기록(L10) |
| `landHandoffIfDue` · `landCycle` · `refreshHandoff` 의 랜딩 | `land` 조치(L4) |
| `refreshFromRemote` 앞부분 — MERGE_HEAD · 충돌 파일 · 보관본 | 조정 표 1~3행 |
| `refreshFromRemote` 뒷부분 — stash → fetch → merge → pop | `mergeBaseInto(branch)` 도우미. `mergeBase` 조치가 부른다 |
| 시작 때 `recoverParkedWork` 훑기 (server.ts:833-866) | 프로젝트별 첫 틱 |
| `autoSaveTurn` | 그대로 둔다 — 빠른 길. 놓친 것은 `commitPending` 조치가 줍는다 |
| `autoBriefBringUpFailure` (project-fleet.ts:597-630) | 그대로 둔다 — 준비는 git 이 아니다. 예산과 알림 경로만 L7 · L11 로 옮긴다 |

### L3. 조정 표

감독자는 위에서부터 읽고 첫 번째 어긋남을 고친다. "턴 중" 이 아니요인 조치는 그
클론에서 턴이 돌면 기다린다.

| # | 관찰 | 조치 | 누가 | 턴 중 | 예산 키 |
| --- | --- | --- | --- | --- | --- |
| 0 | 도구의 조작 흔적(`pendingOp`)이 남았는데 git 은 이미 끝남(gitOp 없음 · 미해결 파일 없음 · stash-pop 이면 그 stash 도 없음) | 원장에서 지움 | 도구 | 예 | — |
| 1 | 도구가 시작하지 않은 rebase · cherry-pick · revert 진행 중 | abort | 도구 | 아니요 | — |
| 2 | 도구가 시작한 병합 · cherry-pick 이 충돌로 멈춤 | 표식이 없으면 마무리, 있으면 AI 에게 표식 정리 턴(L5) | AI → 도구 | 아니요 | `conflict:<파일 해시>` |
| 3 | 도구 태그의 stash 가 남음 | pop. 충돌이면 2행으로 | 도구 | 아니요 | 같음 |
| 4 | HEAD 가 detached 이거나 레지스트리 브랜치가 아님 | 레지스트리 브랜치로 checkout. 없으면 HEAD 에서 새 사이클 브랜치 | 도구 | 아니요 | — |
| 5 | 커밋 안 된 변경, 도는 턴 없음 | 보관. 제목은 마지막 사용자 말, 없으면 `작업 이어 보관` | 도구 | 아니요 | — |
| 6 | 사이클 브랜치 없이 HEAD 가 origin/base 보다 앞섬 | 그 커밋으로 새 사이클 브랜치, 로컬 base 는 origin/base 로 | 도구 | 아니요 | — |
| 7 | origin/base 가 원격에 없음 | GitHub 의 `default_branch` 로 레지스트리 갱신 | 도구 | 예 | `base-missing` |
| 8 | PR 이 병합됨 | 랜딩(L4) | 도구 | 아니요 | — (멱등 조치라 횟수 상한이 없다) |
| 9 | PR 이 병합 없이 닫힘 | 랜딩 + 이월 + 반려 이유 반영 턴(L4 · L9) | 도구 → AI | 아니요 | — (같은 이유) |
| 10 | 원격 브랜치가 로컬보다 앞섬 — 개발자가 PR 브랜치에 올림 | fetch 후 fast-forward. 갈라졌으면 병합, 충돌은 2행 | 도구 | 아니요 | `conflict:*` |
| 11 | origin/base 가 사이클 브랜치에 없음, 또는 PR 이 `mergeable_state: dirty` | 브랜치에 origin/base 병합, 충돌은 2행 | 도구 | 아니요 | `conflict:*` |
| 11b | 사이클 브랜치 없이 HEAD 가 origin/base 보다 뒤처짐(앞선 커밋 없음 · 트리 깨끗함) | fast-forward — 없으면 다음 사이클이 낡은 베이스에서 시작한다 | 도구 | 아니요 | — |
| 12 | 로컬 브랜치가 원격보다 앞섬 | 푸시. 인증 거절이면 `reconnect`, 그 밖은 백오프로 계속 | 도구 | 예 | `push` |
| 13 | 제출 의도가 남음(L6) | 다음 멱등 단계 | 도구 | 예 | `submit` |
| 14 | 새 개발자 코멘트 | 반영 턴(L9) | AI | 예(대기 줄) | `review:<pr>` |
| 15 | 설치 해시가 바뀜 · node_modules 없음 | 재설치 | 도구 | 아니요 | 준비 예산 |
| 16 | 위생 기한 도래 | 정리(단계 9) | 도구 | 아니요 | — |

5행이 뒤의 조치들보다 앞서는 이유: 그 조치들은 깨끗한 트리를 전제로 한다.
보관이 먼저 서면 뒤의 조치는 stash 를 쓸 일이 거의 없다. 8 · 9행이 10 · 11행보다
앞서는 이유: 끝난 PR 의 브랜치에 베이스를 합치는 일은 헛수고다.

**표를 구현하며 정한 것 (단계 2a).**
- 1~4행(클론의 무결성)이 맞았는데 턴이 돌면 아래의 "턴 중 예" 행도 보지 않는다 — 무결성이 깨진 클론에서 푸시 · 제출을 하지 않는다. 예외는 2행(도구의 병합 충돌)이 AI 의 정리를 기다리는 동안의 12행 푸시다. 이미 커밋된 것을 올리는 일이라 작업 트리를 건드리지 않는다.
- 도구의 병합 흔적(`pendingOp`)이 남았는데 git 은 이미 끝난 상태는 0행이 잡아 원장에서 지운다 — 마무리한 실행부가 지우는 것이 원칙이지만, 그 사이에 끊긴 실행은 흔적만 남긴다.
- 11b 의 fast-forward 가 실패하면(그 사이 로컬에 커밋이 생김) 다음 관찰에서 6행이 잡아 사이클 브랜치로 옮긴다.
- 알림을 한 번만 올리는 장치는 둘이다. 예산이 다해 올리는 알림(충돌 · 코멘트 라운드 · 베이스 없음)은 예산 항목의 `escalated` 표식으로, 이어지는 상태의 알림(푸시 밀림 · 푸시 인증)은 원장의 `notices` 기록으로 억제한다. `notices` 는 알림을 실제로 올린 실행부가 적는다.

### L4. 사이클의 끝 — 랜딩과 이월

**병합.** 기준은 병합 순간의 PR head(`pull.head.sha`)다. 커밋이 같은지 대신 이것을 보는
이유는 하나 — 스쿼시 · 리베이스 병합에서는 로컬 커밋이 베이스의 조상이 되지 않는다.

```
남은 것 = rev-list <PR head>..HEAD  +  커밋 안 된 변경 (5행이 먼저 보관하므로 보통 0)
남은 것 없음 → checkout base, reset --hard origin/base, 옛 브랜치 삭제
남은 것 있음 → 새 브랜치 at origin/base, cherry-pick <PR head>..HEAD, 충돌은 L5, 옛 브랜치 삭제
```

**반려.** 남은 것은 브랜치 전체다. 새 브랜치를 HEAD 에서 만들고(커밋 역사를 그대로
가져간다) origin/base 를 합친다. 닫힌 이유를 반영 턴으로 보낸다(L9). 옛 원격 브랜치는
`keepRejectedDays` 뒤에 지운다.

**브랜치 이름.** `colo-design/<로컬 날짜>-<n>`. `n` 은 로컬 · 원격 둘 다에 없는 첫
번호다. 지금은 원격만 보고, ls-remote 실패도 빈 것으로 친다(repo-publish.ts:287-289).
`checkout -B` 대신 `checkout -b` — 같은 이름의 로컬 브랜치를 덮지 않는다.

**이미 있는 이름.** `ensureCycleBranch`(repo-publish.ts:274-303)는 이름을 돌려주기 전에
HEAD 가 그 브랜치인지 확인한다. 아니면 조정 표 4행이 먼저 선다.

**끝난 브랜치.** 병합된 것은 로컬을 바로 지우고, 원격은 `lifecycle.deleteMergedBranches`
(기본 켬)일 때 `git push origin --delete`. 원격이 이미 없으면(GitHub 의 자동 삭제
설정) 건너뛴다. 반려된 것은 `keepRejectedDays`(기본 14일) 뒤에 둘 다.

**사건.** `cycle.merged` 는 지금처럼 두고, `cycle.closed {at, pr}` 와
`cycle.carried {at, from, to, commits}` 를 더한다. 끝난 PR 은 cycle.json 에 남기므로
재시작 뒤 두 번 알리지 않는다.

### L5. AI 는 파일만, git 은 도구만

- git 게이트의 MERGE_HEAD 문(session.ts:969-976)을 닫는다. 세션의 git 쓰기는 예외 없이
  거절된다. `GIT_WRITE_REFUSAL`(session.ts:264-265)의 말도 새 어휘로 — "보관과 제출은
  이 도구가 합니다".
- 충돌 브리프는 하나다. repo-core.ts:755-776 의 두 함수를 `conflictBrief()` 로 대체한다.
  시키는 일은 표식 정리뿐이다.

```
개발자가 반영한 변경과 이번 작업이 같은 곳을 고쳐 자동으로 합치지 못했습니다.
충돌 표식(<<<<<<< ======= >>>>>>>)이 남은 파일: …
개발자 쪽 변경: <커밋 제목들>
이번 작업: <커밋 제목들>
두 변경의 뜻을 모두 살려 표식을 지우고 파일을 정리해 주세요.
git 명령은 쓰지 마세요 — 정리가 끝나면 도구가 마무리합니다.
```

- 턴이 끝나면 감독자가 그 파일들의 표식을 검사한다(순수 `conflictMarkers(text)`).
  없으면 도구가 마무리한다 — 병합은 `add` + `commit --no-edit`, cherry-pick 은
  `add` + `cherry-pick --continue`, stash 복원은 `add` + `reset -q` + `stash drop <ref>`.
- 표식이 남았으면 예산(같은 충돌 2회) 안에서 한 번 더, 넘으면 개발자 알림. 그동안 자동
  보관은 기다리고(`SAVE_CONFLICT_OPEN_DETAIL` 은 사용자에게 보이지 않는다) 화면은
  `AI가 고치는 중이에요`.

**게이트가 실제로 서는 자리 (단계 3 에서 찾음).** 세션의 git 게이트는 드라이버가 권한을
물을 때만 불린다. 그런데 Claude 는 `bypassPermissions` 로, Codex 는 승인 없는 정책으로
뜬다 — Agent SDK 의 판정 순서(hooks → deny 규칙 → 권한 모드 → allow → canUseTool)에서
bypass 는 canUseTool 을 부르지 않는다. 실사용의 두 공급자에서 AI 의 `git push origin
HEAD:main` 을 막는 장치가 없었다(개발용 omp 만 게이트를 탔다). 그래서 두 겹으로 막는다.

- **Claude — PreToolUse 훅.** 메인 query 에 Bash 훅을 달아 `gitWriteDenied` 로 판정하고
  거절 이유로 `GIT_WRITE_REFUSAL` 을 준다. 훅은 bypass 에서도 돈다.
- **모든 공급자 — git 수준 가드.** AI CLI 를 띄울 때 환경의 `GIT_CONFIG_*` 로
  `core.hooksPath` 를 `~/.colo-design/tools/git-guard/` 에 겨눈다. 그 폴더의
  `reference-transaction`(prepared 에서 거절)과 `pre-push` 가 커밋 · 리셋 · 브랜치 이동 ·
  stash · 병합 · 푸시를 막는다. 도구 자신의 git 은 이 환경을 쓰지 않는다.
- 한계: 협조적인 AI 의 실수를 막는 장치다. 환경을 지우는 적대적 명령까지는 막지 않는다.

### L6. 제출은 한 번 누르면 끝까지 간다

**의도와 단계.** 제출은 cycle.json 에 의도를 적는 것으로 시작한다
(`submit: {requestedAt, via: "button" | "chat"}`). 그 뒤 네 단계를 차례로 보장한다.
각 단계는 멱등이고, 어디서 멈춰도 다음 틱이 이어서 한다. 네 단계가 모두 서면 의도를
지운다.

| 단계 | 하는 일 | 실패하면 |
| --- | --- | --- |
| `ensureCommitted` | 남은 변경 보관 | 충돌 중이면 L5 가 끝날 때까지 기다림 |
| `ensurePushed` | 로컬 = 원격까지 푸시 | 인증 거절 → `reconnect`. 그 밖 → 백오프, 예산 뒤 개발자 알림 |
| `ensurePullRequest` | 열린 PR 보장 | 백오프, 예산 뒤 개발자 알림 |
| `ensureReviewers` | 초대 파일의 리뷰어 요청 | 조용히 넘어감(지금처럼 최선) |

웹의 두 번 부르기(ChatColumn.tsx:179-200 — 보관 뒤 넘기기)는 `repo.submit` 하나로
바뀐다. 사용자에게 `다시 제출하기` 가 뜨는 일은 없다.

**PR 보장.** 레지스트리의 열린 PR → 없으면
`GET /repos/{o}/{r}/pulls?head={o}:{branch}&state=open` 으로 찾아 입양 → 그래도 없으면 생성.

- 제목은 생성할 때만 정한다. `handoffDraft`(repo-summary.ts:48-80)의 초안, 8초 안에
  없으면 `<프로젝트 이름> · <첫 커밋 제목>`.
- 본문은 도구 구간만 갱신한다. `<!-- colo-design:start -->` 와
  `<!-- colo-design:end -->` 사이가 도구의 것이고, 그 밖은 개발자의 것이다. 순수
  `mergeToolBlock(existing, block)`. 지금은 제목 · 본문을 통째로 덮는다
  (repo-publish.ts:426-434).

**캡처.** 사이클 브랜치에 커밋하지 않는다. 병합되지 않는 고아 브랜치
`colo-design-assets` 에 plumbing(`hash-object` · `mktree` · `commit-tree` ·
`push <sha>:refs/heads/colo-design-assets`)으로 올린다 — 체크아웃이 없어 작업 트리를
건드리지 않는다(repo-shelf.ts 가 이미 쓰는 방식). 링크는 브랜치 이름이 아니라 커밋
sha 로 걸어 브랜치 정리 뒤에도 살아 있다. → 열린 항목 O4.

**채팅으로 제출.** 호스트 도구 `submit_for_review` 를 브라우저 도구 서버
(browser-mcp.ts — `screen_check` 가 사는 곳)에 더한다. 도구는 의도를 적을 뿐이고, 공통
규칙이 "사용자가 개발자에게 보내 달라고 분명히 말할 때만 부른다" 고 가르친다. 버튼은
그대로다. → 열린 항목 O6.

### L7. 예산은 한 표에 있다

새 `budgets.ts` 가 상수와 순수 도우미 `spend(ledger, key, now) → { allowed, ledger }`
를 갖는다. 지금 흩어진 상한을 여기로 옮기고, 초과 시의 행동은 언제나 같다 — 개발자
알림 한 번, 화면은 `개발자에게 알렸어요`.

| 자동화 | 시도 | 간격 | 지금 |
| --- | --- | --- | --- |
| 턴 일시 실패 재시도 | 5 | 4초 · 16초 · 1분 · 5분 · 15분 | turn-retry.ts:16 — 2회 |
| 사용량 한도 기다림 | 재충전까지 | 최대 24시간 | turn-retry.ts:19 — 15분 |
| 크래시 되살리기 | 10분 안에 3 | 1.5초 | turn-retry.ts:24 — 2, 초기화 결함 |
| 푸시 | 무한 | 30초에서 두 배씩, 최대 10분. 알림은 1시간 밀린 뒤 한 번 | repo-publish.ts:818-828 — 3회 |
| 충돌 정리 턴 | 같은 충돌에 2 | 즉시 | 없음 |
| 준비 실패 턴 | 같은 단계에 2, 한 바퀴에 4 | 즉시 | bring-up-briefs.ts:22-24 — 같음 |
| 제출 단계 | 단계마다 5 | 백오프 | 없음 |
| 코멘트 반영 | PR 당 5 라운드 | 도착 즉시 | 없음 |
| 재클론 | 하루 1 | 즉시 | 없음 |
| 같은 문제의 개발자 알림 | 문제 키당 | 10분에 한 번 갱신 | escalation.ts:28 — 문장 기준 |

웹의 화면 오류 고침 상한(ScreenPanel 의 `MAX_AUTO_FIXES`)은 웹에 남긴다 — 그 고리는
웹이 돌린다. 값만 이 표와 같게 둔다.

### L8. 화면의 문제 문장은 셋이고, 상태값 하나가 정한다

```ts
type Attention =
  | { kind: "ai-fixing"; since: string }
  | { kind: "developer-notified"; since: string; via: "pr" | "issue" | "slack" }
  | { kind: "reconnect"; since: string; what: "github" | "agent-login" };
```

- 프로젝트의 주의는 `RepoStatus.attention` 과 `ProjectSummary.attention`, 기계 전체의
  주의(연결 코드 · AI 로그인)는 `DaemonStatus.attention` 에 싣는다.
- 쓰는 쪽은 감독자 · 턴 자기치유 · 준비 복구다. 그리는 쪽은 웹의 `AttentionLine` 하나다.
- 원문(git 출력 · 영어 오류 · 경로)은 기록 파일로만 간다(log.ts 의 생니타이저를
  거친다). 개발자 알림의 `자세히` 가 그 원문을 싣는다.
- 주의가 없을 때 무언가 도는 중이면 상태 칩이 지금처럼 `만드는 중` 을 말한다.

**대체되는 표면.**

| 지금 | 자리 | 이 판 |
| --- | --- | --- |
| 제출 · 넘기기 실패 배너 + `다시 제출하기` | ChatColumn.tsx:591-607 | 주의 한 줄 |
| 넘기기 카드의 PR 실패 안내와 원문 `자세히` | HandoffCard.tsx:247-258 | 주의 한 줄 |
| 환경 경고 띠 — API 키 · CLI · git · 패키지 토큰 | Shell.tsx:517-555 | 데몬이 개발자에게 알리고 주의 한 줄. 개발 실행에서는 지금처럼 |
| 로그인 만료 띠 | Shell.tsx:556-569 | `reconnect/agent-login` — 버튼 하나, 브라우저 로그인 |
| 토큰 만료 카드 | TokenExpiryDialog.tsx | `reconnect/github` — 초대 파일 놓기 |
| 크래시 알림의 영어 원문 | session.ts:670-672, 716 | 원문은 기록으로. 되살린 뒤에만 `AI 프로그램을 다시 켰어요` 한 줄 |
| 사이드바 · 기록 · 되돌리기의 원문 오류 + `다시 시도해 주세요` | Sidebar.tsx:1189 · HistoryDrawer.tsx:202-206 | 자동 재시도, 실패는 주의 |

### L9. 개발자의 코멘트와 반려는 AI 가 받고, AI 가 답한다

**읽기.**
- 코멘트 · 리뷰 · 이슈 코멘트 셋 다 페이지를 끝까지 읽는다(`nextLink`,
  github.ts:628-642 재사용). 지금은 50개 한 페이지.
- 봇을 거른다 — `user.type === "Bot"` 또는 로그인이 `[bot]` 으로 끝남.
- `whoAmI` 는 토큰마다 캐시한다. 지금은 읽을 때마다 `/user` 를 한 번 더 부른다
  (repo-publish.ts:711).

**장부.** cycle.json 의 `reviews[<pr>] = { known, briefed, rounds }`. review-ledger.json
을 읽어 한 번 옮기고 지운다. 메모리 전용 `knownReviewIds`(repo-publish.ts:74)는 이것으로
대체된다.

**답장.** 반영 턴의 문장(`reviewToTurn`, turn-marker.ts:296-315)에 규칙 한 줄을 더한다 —
코멘트마다 `개발자에게 (#<id>):` 로 시작하는 한두 문장을 답변 끝에 남긴다.
- 턴이 끝나고 보관 · 푸시가 서면 도구가 그 줄을 뽑아(순수
  `extractDeveloperReplies(text, ids)`) 해당 스레드에 올린다(`replyToReview`,
  repo-publish.ts:795-815).
- 줄이 없는 코멘트에는 `반영했습니다 · <sha7>`, 바뀐 파일이 없으면
  `확인했고 바꾼 것은 없습니다`.
- 모든 답장 끝에 `— Colo Design 이 <작성자> 님 대신 남김`. → 열린 항목 O5.
- 턴의 마지막 답변 문장은 세션이 모아 둔다 — `Session.lastAssistantText`(새 필드, 그
  턴의 `text.done` 을 잇는다).

**반려.** 랜딩(L4)의 이월 뒤, 닫힌 이유를 반영 턴으로 보낸다. 이유는 닫힘 전후의
마지막 이슈 코멘트와 리뷰 본문이다. 이유가 없으면 턴을 열지 않고 개발자 알림으로
"반려 이유를 남겨 주세요" 를 보낸다 — AI 가 짐작으로 고치지 않게.

**PR 브랜치에 개발자가 올린 커밋.** 조정 표 10행.

### L10. 상태는 디스크에 있다

새 파일 `~/.colo-design/projects/<slug>/cycle.json`. 원자 쓰기(임시 파일 + rename —
review-ledger.ts:57-68 방식).

```ts
interface CycleLedger {
  v: 1;
  ended: { pr: number; state: "merged" | "closed"; headSha: string; seenAt: string } | null;
  submit: { requestedAt: string; via: "button" | "chat"; step?: string } | null;
  push: { behindSince: string; lastError?: "auth" | "network" | "rejected" | "other" } | null;
  reviews: Record<string, { known: number[]; briefed: number[]; rounds: number }>;
  budgets: Record<string, { spent: number; firstAt: string; lastAt: string; escalated: boolean }>;
  notices: Record<string, { via: "pr" | "issue" | "slack"; ref?: number; raisedAt: string; count: number }>;
  branches: Array<{ name: string; endedAt: string; state: "merged" | "closed" }>;
  hygiene: { gcAt?: string; fsckAt?: string; pruneAt?: string };
}
```

레지스트리(projects.json)는 지금처럼 `branch` · `handoff` 를 들고, 두 결함을 고친다 —
`parseHandoff` 가 `reviewers` 를 버리는 것(projects.ts:158-174), `peekHandoff` 가 끝난
PR 을 레지스트리에 적지 않는 것(repo-publish.ts:623-644).

진행 중 턴의 기록(queue-store 의 `inflight`)은 정상 종료에서도 남긴다(L12).

### L11. 개발자 알림은 GitHub 이 먼저, Slack 은 보조

새 `developer-notice.ts`.

```ts
interface Problem {
  key: string;          // "bring-up:port-undetected", "push:auth", "submit:pr", "revive:exhausted" …
  slug: string | null;  // null 이면 기계 전체
  title: string;        // 한 줄
  what: string;         // 무엇이 막혔나
  tried: string;        // 도구가 무엇을 해 봤나
  ask: string;          // 개발자에게 무엇을 부탁하나
  detail?: string;      // 기록 30줄, 생니타이저를 거친다
}

class DeveloperNotice {
  raise(problem: Problem): Promise<"pr" | "issue" | "slack" | "none">;
  resolve(key: string, slug: string | null): Promise<void>;
}
```

**경로.**

```
PR 이 열려 있다       → 그 PR 에 코멘트. 문제 키마다 하나.
                        다시 나면 그 코멘트를 고쳐 횟수 · 마지막 시각 갱신.
                        풀리면 코멘트 첫 줄을 "해결됨" 으로 고친다.
PR 이 없다           → 저장소에 이슈. 라벨 colo-design, 본문 표식 <!-- colo-design:problem <key> -->.
                        열린 이슈 중 표식이 같은 것이 있으면 코멘트만 덧붙인다.
                        풀리면 코멘트 한 줄 + 닫기.
GitHub 에 닿지 않는다 → 초대 파일에 실린 Slack.
(인증 만료 · 권한 없음 · 네트워크)
```

**본문.** 네 줄 구조 — 무엇이 · 해 본 것 · 부탁 · 자세히(`<details>` 접힘). 첫 줄에
프로젝트 이름과 작성자 이름.

**풀림.** 감독자 · 준비 복구가 문제가 사라진 것을 관찰하면 `resolve` 를 부른다 — 준비가
`ready` 에 닿음, 밀린 푸시가 올라감, PR 이 섬, 되살린 대화가 한 턴을 마침.

**GitHub 쪽 추가.** `github.ts` 에 PR 찾기(head), 이슈 만들기 · 목록(라벨 · 작성자) ·
고치기(닫기), 이슈 코멘트 고치기(`PATCH /issues/comments/{id}`), PR 의
`mergeable_state` · `head.sha` 읽기. 브랜치 삭제는 git 으로 하므로 전송 계층에 DELETE 를
더하지 않는다(rest-transport.ts:22).

**권한.** 초대장 페이지가 연결 코드로 이슈를 쓸 수 있는지 확인한다. 지금 호출자가 없는
`verifyPullRequestAccess`(github.ts:430-506)를 넓혀 쓴다. 이슈를 못 쓰는 코드면 페이지가
Slack 칸을 필수로 바꾼다 — 그래서 v4 초대 파일로 연결된 기계에는 경로가 없는 경우가
없다.

**지금의 호출 지점 이관.**

| 지금 | 문제 키 |
| --- | --- |
| server.ts:450-456 — GitHub 401 | `github:auth` (기계 전체 → Slack) |
| repo-publish.ts:852-857 — 푸시 인증 · PR 실패 | `push:auth` · `submit:pr` |
| project-fleet.ts:604-613 — 준비 실패 예산 초과 | `bring-up:<errorKind>` |
| dispatch.ts:712-723 — `개발자 부르기` 버튼 | 없앤다. 환경 경고는 데몬이 `env:<종류>` 로 스스로 올린다 |
| dispatch.ts:724-731 — 시험 보내기 | 개발자용 설정에 남긴다 |

**채팅으로 묻기.** 사용자가 "개발자에게 물어봐 줘" 라고 하면 AI 가 호스트 도구
`ask_developer(question)` 를 부르고, 같은 경로로 간다. 문제 키는 `question:<해시>` 이고
풀림은 개발자의 답장이다.

지금의 결함 둘 — `escalationConfigured` 미설정(server.ts:1482-1496), 보내기 전 중복
표시(escalation.ts:99-101) — 은 단계 0 에서 먼저 고친다.

### L12. 턴은 스스로 다시 선다

- **재시도 사다리** — L7 표대로 5회. 다 쓰면 개발자 알림, 화면은 `개발자에게 알렸어요`.
  실패 카드(turn.tsx:275-368)의 `고쳐서 다시 보내기` 는 남긴다 — 사용자가 이미 아는
  대화의 동작이다. 영어 원문 `자세히` 는 기록으로.
- **로그인 만료** — `classifyRetry`(turn-retry.ts:84-100)에 `auth` 를 더한다
  (`authentication_error` · `invalid api key` · `oauth` · `please run /login` ·
  `not logged in`). 재시도하지 않고 `reconnect/agent-login`. 로그인이 끝나면 마지막 말을
  한 번 스스로 다시 보낸다(`selfRedeliver`).
- **크래시** — 되살리기 예산을 "대화 + 10분 창" 으로 센다. 되살리기 자신의 닫힘이 예산을
  지우지 않게 한다(server.ts:615-616). 성공한 턴 끝에서만 지운다. 예산 초과는 개발자 알림.
- **앱이 꺼질 때 돌던 턴** — 정상 종료에서도 inflight 를 남긴다(session.ts:753, 779 가
  종료 중에는 지우지 않게). 다음 시작에 2시간 안의 inflight 는 그 대화를 되살려
  `brief` 턴 한 번을 보낸다 — "직전 요청이 중단됐습니다: <원문 첫 줄>. 지금 파일 상태를
  보고 마무리해 주세요." 같은 말을 그대로 다시 보내지 않는 이유: 반쯤 적용된 작업이
  겹친다. 2시간이 지난 것은 입력창의 초안으로 돌아온다.
- **잃은 말** — 되살리기 · 지우기 패널(Composer.tsx:1208)을 없앤다. 30분 안의 것은
  스스로 대기 줄로 돌아가 다음 턴에 나가고, 오래된 것은 입력창 초안으로 돌아온다.
- **대화 길이** — Claude 는 CLI 가 스스로 요약한다. 길이 초과로 실패하면
  (`PERMANENT_RESULT`, turn-retry.ts:50-51) 도구가 `/compact` 를 보내고 한 번 다시
  시도한다. 드라이버 능력 `compact` 가 없는 공급자는 지금의 `대화가 길어졌어요` 안내를
  유지한다 — 사용자가 이미 아는 개념이다.
- **질문 정책** — 공통 규칙(common-instructions.ts)에 한 줄: "사용자에게는 화면의 모양 ·
  문구 · 흐름만 묻는다. 라이브러리 · 파일 구조 · 상태 관리 · 명령 같은 기술 선택은
  레포의 관례를 따라 스스로 정한다." 락파일 규칙(:33)의 "사용자가 정하게 한다" 는 "새
  의존성 없이 풀고, 꼭 필요하면 `ask_developer` 로 묻는다" 로 바꾼다.

## 3. 데이터 모델 · 프로토콜 v18

선로 모양이 바뀌므로 프로토콜을 v17 → v18 로 올린다. 데스크톱은 앱과 데몬이 함께 나가고,
브라우저 개발 경로는 둘 다 다시 빌드한다.

| 자리 | 바뀜 |
| --- | --- |
| `RepoStatus` · `ProjectSummary` | `attention?: Attention \| null` |
| `DaemonStatus` | `attention?: Attention \| null` (기계 전체). `escalationConfigured` 는 `noticeRoute: "github" \| "slack" \| "none"` 로 |
| `ChatEvent` | `cycle.closed {at, pr}` · `cycle.carried {at, from, to, commits}` |
| 클라이언트 메시지 | `repo.submit {sessionId?}` 추가. `repo.save` · `repo.handoff` 는 개발자용으로 남김. `repo.handoffStatus` 는 웹이 더 부르지 않는다 |
| `ProjectSummary` | `defaults?: {provider?, model?, effort?}` · `lifecycle?: Lifecycle` (초대 v4) |
| 초대 파일 안쪽 | v4 (아래). 봉투는 v3 그대로 |
| 새 파일 | `projects/<slug>/cycle.json` (L10) |
| 레지스트리 | 프로젝트에 `defaults` · `lifecycle`. `reviewers` 를 읽을 때 버리지 않음 |

**초대 파일 v4 — 안쪽.**

```ts
interface InviteV4 {
  v: 4;
  token: string;
  authorName?: string;
  readme: string;
  notify?: {
    slack?: { kind: "webhook"; url: string } | { kind: "bot"; token: string; channel: string };
  };
  projects: Array<{
    repoUrl: string;
    name: string;
    baseBranch: string;
    approveCommands: true;
    reviewers?: string[];
    instructions?: string;
    defaults?: { provider?: string; model?: string; effort?: EffortLevel };
    lifecycle?: {
      deleteMergedBranches?: boolean; // 기본 true
      keepRejectedDays?: number;      // 기본 14
      autoReply?: boolean;            // 기본 true
      submitFromChat?: boolean;       // 기본 true
    };
  }>;
}
```

- `notify.slack` 은 가져올 때 자격 증명 저장소로 간다(지금 `escalation.set` 이 쓰는 자리).
- `defaults` 는 새 대화의 처음 값이다. 사용자가 칩에서 고르면 그것이 이긴다 — 사용자는
  모델을 안다.
- 다시 가져오기: `defaults` · `lifecycle` · `notify` 는 개발자의 것이라 덮는다. 이름 ·
  지켜 줄 것은 지금처럼 사용자의 것으로 둔다(invite-import.ts:80-82).
- 읽는 쪽 `normalizeInvite`(protocol/src/invite.ts:159-272)는 v1~v4 를 받는다. 봉투
  판별은 바깥 `v === 3` 이라 안쪽 v4 와 부딪히지 않는다(invite.ts:307-311).

## 4. 단계

각 단계는 하나의 리뷰 가능한 변경이다. 끝났다고 부르는 조건은 늘 `pnpm typecheck` ·
`pnpm build` · `pnpm test` 통과를 포함한다. 크기는 S(하루 안) · M(이틀 안팎) ·
L(사흘 이상).

```
단계 0 → 1 → 2 ─┬→ 3 ──────────┐
                ├→ 4 ─┬→ 5     ├→ 7 ─┐
                │     ├→ 6 ────┘     ├→ 10
                │     └→ 8 ──────────┤
                └→ 9 ────────────────┘
```

2 가 끝나면 3 · 4 · 9 는 나란히 갈 수 있다. 5 · 6 · 8 은 4 의 알림 경로와 주의 상태를
쓴다.

**진행 (브랜치 `lifecycle`, 2026-09-24).** 구현은 위임한 에이전트가 하고, 단계마다 검토 ·
시험 · 합치기를 거친다.

| 단계 | 상태 | 메모 |
| --- | --- | --- |
| 0 | 합침 | 결함 일곱. 여덟째(끝난 PR 을 레지스트리에)는 단계 2 의 cycle.json 이 맡았다. 어휘 통일은 단계 10 으로 옮겼다 — 단계 4 · 10 이 같은 문자열을 다시 쓴다 |
| 1 | 합침 | 차선 + 작업별 표식(끝난 작업의 문맥이 번지지 않게) + 나가는 문의 `lane.outside` |
| 2 | 합침 | 넷으로 나눴다 — 2a 판정 · 장부 · 예산(순수), 2b 관찰 · 시험 하네스, 2c 감독자 골격, 2d 랜딩 · 이월 · 베이스 따라가기 · 폴러 흡수 |
| 3 | 합침 | 2c 에 묶었다 — 도구의 병합을 원장에 적지 않으면 1행이 그것을 남의 것으로 보고 중단시킨다. git 가드 두 겹(L5) |
| 4 | 합침 | DeveloperNotice · 주의 · 프로토콜 v18 |
| 5 | 합침 | 초대 v4 |
| 6 · 8 | 진행 중 | 나란히 |
| 7 · 9 · 10 | 남음 | |

### 단계 0. 준비와 드러난 결함 — S

**준비.**
- 작업 트리의 커밋되지 않은 변경을 먼저 커밋한다. 이 계획이 손대는 파일
  (project-fleet · repo-* · session · server · dispatch)이 모두 그 안에 있다.
- 이후 단계는 main 이 아니라 단계별 브랜치에서 한다.

**결함 — 각각 한 커밋, 각각 시험 하나.**

| 결함 | 고칠 곳 | 시험 |
| --- | --- | --- |
| Delete 키로 프로젝트 지우기가 열림 | Sidebar.tsx:414-417 — `canRemoveProject` 일 때만 | 타입 검사 · 눈으로 |
| `escalationConfigured` 를 채우지 않음 | server.ts:1482-1496 `status()` | 상태 스냅샷 단위 |
| 중복 표시를 보내기 전에 찍음 | escalation.ts:99-101 — 성공 뒤에 | escalation 단위(가짜 fetch) |
| 되살리기 예산 초기화 | server.ts:615-616 · dispatch.ts:913, 966 — 되살리기의 닫힘은 예산을 지우지 않음. 예산 셈을 순수 `ReviveBudget` 으로 뽑음 | ReviveBudget 단위 |
| 브랜치 이름이 UTC · `checkout -B` | repo-publish.ts:279, 293 | 이름 함수 단위 |
| 이미 있는 이름에서 체크아웃하지 않음 | repo-publish.ts:275-277 — HEAD 확인 | git 픽스처 |
| `parseHandoff` 가 reviewers 를 버림 | projects.ts:158-174 | 레지스트리 왕복 단위 |
| 끝난 PR 을 레지스트리에 적지 않음 | repo-publish.ts:623-644 | 픽스처 전송 |

**어휘 통일 (단계 10 으로 옮김).** 사용자에게 보이는 문자열의 `저장` · `넘기기` · `넘긴` · `넘김` ·
`검토 요청` · `확인 요청` 을 `보관` · `제출` · `제출한` · `반영됨` 으로 맞춘다. 주석을
빼고 웹 100여 곳, 데몬 · 프로토콜 50여 곳이다. 공통 규칙의 "저장 · 넘기기 · 반영됨으로
말한다"(common-instructions.ts:30)도 "제출 · 반영됨" 으로. 뒤 단계가 다시 쓸 문자열
(실패 배너 · 넘기기 카드)은 여기서 건드리지 않는다.

### 단계 1. 차선 — M

- 새 `git-lane.ts`(L1). `RepoCore` 에 `lane` 을 두고 `gitRead` · `gitWrite` 로 나눈다.
- 옮길 곳 — 약속 슬롯을 손으로 기다리는 자리 전부: repo.ts:163-173(sync) · 249-296
  (pull) · 364-409(save · handoff) · 552-572(asWorktreeWriter), repo-shelf.ts:87-108,
  repo-core.ts:557-565 · 575-594 · 920-941, repo-publish.ts:107-108 · 325-326 ·
  658-696 · 818-828, repo-bringup.ts:81.
- `save()` 는 줄에 합류한다. `"저장이 진행 중입니다"` 오류가 사라진다.
- `SessionManager.busyIn(cwd)` 를 더하고, 폴러(project-fleet.ts:408)의 전역 바쁨을
  대체한다.
- 시작 때의 두 복구 경합(server.ts:822 · 845)은 둘 다 차선에 서므로 저절로 풀린다.

**시험.** `git-lane.test.ts` — 순서 · 합류 · 한 작업의 실패가 줄을 막지 않음 · 개발
빌드의 `gitWrite` 단언. git 픽스처: 최신화 도중 보관을 부르면 던지지 않고 뒤에 선다.

**끝.** 슬롯을 손으로 기다리는 코드가 없다(`await this.core.refreshing` 류 검색 0).
쓰기 git 은 전부 `gitWrite`.

### 단계 2. 감독자 골격과 상위 조정 — L

**새 파일.**
- `cycle-observe.ts` — `observeCycle()`. git 은 `gitRead`, GitHub 는 PR 한 번
  (`GET /pulls/{n}` — `merged` · `state` · `head.sha` · `mergeable_state`).
- `cycle-reconcile.ts` — `nextCycleAction()`. 조정 표(L3)의 1 · 3 · 4 · 5 · 6 · 8 ·
  9(이월까지, 반려 턴은 단계 7) · 11 · 12행. 2행은 단계 3, 13행은 단계 6, 10 · 14행은
  단계 7, 7 · 15 · 16행은 단계 9.
- `cycle-supervisor.ts` — 틱 · 방아쇠 · 조치 실행 · 사건과 주의 방송.
- `cycle-ledger.ts` — cycle.json 읽기 · 원자 쓰기 · review-ledger.json 이관.
- `budgets.ts` — L7 표와 `spend()`.

**바꿀 곳.**
- server.ts:811 의 타이머 → 감독자. `pollOpenHandoffs` 는 감독자로 옮기고 fleet 에서
  지운다.
- dispatch.ts:1039-1049 `pullBeforeSend` → `supervisor.tick("before-send")`.
- repo-publish.ts 의 `landCycle` · `refreshHandoff` 의 랜딩 · `retryBackgroundPush` →
  감독자 조치. `refreshFromRemote` 는 둘로 쪼갠다(L2 흡수표).
- server.ts:833-866 시작 훑기 → 프로젝트별 첫 틱.
- 비활성 프로젝트도 틱을 받는다. 비활성이라 미리보기가 없을 뿐, 클론의 git 조치는 같다.

**하네스.** 서버 없이 `RepoCore` + `PublishCycle` + 감독자를 세우는 시험 도우미
`test/helpers/cycle-harness.ts` — 임시 bare 원격, 클론, 가짜 GitHub 전송
(rest-transport.ts 의 FixtureTransport 를 녹화 대신 메모리 상태로 돌리는 판), 가짜
"AI"(파일을 고치는 콜백). 이 하네스가 단계 2~9 시험의 바닥이다.

**시험.**
- 순수 — 조정 표의 행마다 하나, 우선순위가 겹치는 조합, 틱 안의 5회 상한.
- 하네스 — 5장의 S1 · S2 · S4 · S5 · S7 · S8 · S11.

**끝.** 조정 표의 해당 행이 모두 시험으로 덮였다. 푸시가 말없이 멈추는 경로가 없다.
반영 뒤 남은 작업이 새 브랜치로 옮겨진다.

### 단계 3. 충돌 — AI 는 파일만 — M

- session.ts:969-976 MERGE_HEAD 문을 지운다. `GIT_WRITE_REFUSAL` 새 말.
- repo-core.ts:755-776 의 두 브리프를 `conflictBrief()` 하나로(L5). 양쪽 커밋 제목은
  `git log --format=%s` 로 읽는다.
- 새 순수 `conflict-markers.ts` — `conflictMarkers(text)`.
- 조정 표 2행: 충돌 턴의 끝을 감독자가 받아(`onState` idle) 표식 검사 → 도구 마무리 →
  예산.
- 충돌 턴이 열릴 대화: 지금처럼 `autoFixThreadFor`(project-fleet.ts:557-579), 제목은
  `최신 변경 합치기`.

**시험.** 순수 — 표식 검사(표식 모양이 코드 안 문자열에 있는 경우 포함). 하네스 — S3.
가짜 AI 가 표식을 남김 → 한 번 더, 그 뒤 개발자 알림.

**끝.** 세션이 git 쓰기를 할 수 있는 경로가 없다. 충돌 뒤 도구 태그의 stash 가 남지 않는다.

### 단계 4. 개발자 알림과 주의 — M

- 새 `developer-notice.ts`(L11), `github.ts` 에 이슈 · PR 찾기 · 코멘트 고치기.
- `attention` 을 protocol · RepoCore · DaemonStatus 에 싣는다(L8). 프로토콜 v18.
- 호출 지점 이관(L11 표). `escalation.ts` 는 Slack 전송부로 남아 `developer-notice` 의
  한 경로가 된다.
- 환경 경고(environment.ts:499-545)는 데몬이 `env:<종류>` 로 스스로 올린다.
- 웹: `AttentionLine` 새 컴포넌트, 우선 채팅 칼럼 위 한 자리에만 그린다. 옛 표면을 걷는
  일은 단계 10.

**시험.** 순수 — 경로 고르기(`PR 열림` · `없음` · `GitHub 불가` · `Slack 없음`), 본문
네 줄 조립과 생니타이저, 이슈 표식 찾기. 픽스처 — 이슈 만들기 → 다시 나면 코멘트 →
풀리면 닫기.

**끝.** 사용자가 설정하지 않아도 준비 실패 예산 초과가 GitHub 에 이슈로 선다. 풀리면
닫힌다.

### 단계 5. 초대 파일 v4 — M

- site/invite-format.mjs `buildInvite` · `buildProject`, protocol/src/invite.ts
  `normalizeInvite` · 한도, web/src/lib/invite-import.ts `applyInvite`, site/invite.js ·
  site/index.html 폼(Slack 칸 · 기본 모델 · 수명 설정), scripts/make-invite.mjs 플래그
  (`--slack-webhook` · `--model` · `--effort` · `--keep-rejected-days` ·
  `--no-auto-reply` · `--instructions`).
- 초대장 페이지의 권한 확인(L11 권한).
- 데몬: 레지스트리에 `defaults` · `lifecycle`. `session.create`(dispatch.ts:243 부근)가
  칩의 값이 없을 때 `defaults` 를 쓴다.

**시험.** invite-format.test.ts 확장 — v4 왕복, v3 · v2 · v1 여전히 읽힘, 새 한도.
`applyInvite` 의 다시 가져오기 규칙(지금 시험이 없다 — 이번에 더한다).

**끝.** 페이지와 스크립트가 같은 v4 파일을 만든다. 옛 초대 파일이 그대로 열린다.

### 단계 6. 제출 멱등화 — M

- repo-publish.ts `runHandoff`(305-466)를 네 단계로(L6). `repo.submit` 클라이언트 메시지,
  웹의 ChatColumn.tsx:179-200 을 그것 하나로.
- `findPullRequestByHead`, `mergeToolBlock`, 초안 제목.
- 캡처를 고아 브랜치로(attachShots 475-520 대체). 이미 사이클 브랜치에 커밋된 옛 캡처는
  건드리지 않는다.
- `submit_for_review` 호스트 도구(browser-mcp.ts)와 공통 규칙 한 줄 —
  `lifecycle.submitFromChat` 일 때만 도구를 싣는다.
- 조정 표 13행.

**시험.** 순수 — `mergeToolBlock`(개발자가 구간 밖을 고침 · 구간을 지움 · 구간이 둘).
하네스 — S9, 제출 중 네트워크 끊김 → 다음 틱에 PR 이 섬, 두 번 눌러도 PR 하나.

**끝.** 어떤 실패 뒤에도 사용자에게 제출 버튼 말고 누를 것이 생기지 않는다.

### 단계 7. 코멘트와 반려 — M

- github.ts:325-378 세 목록에 페이지네이션 · 봇 거르기, whoAmI 캐시.
- `reviewToTurn` 에 답장 규칙, `Session.lastAssistantText`, `extractDeveloperReplies`,
  답장 게시(settleAutoSave, project-fleet.ts:638-675 의 끝).
- 반려 턴(L9), `cycle.closed` 사건, 조정 표 9행의 AI 몫과 10 · 14행.
- `lifecycle.autoReply` 가 꺼져 있으면 답장만 건너뛴다.

**시험.** 순수 — 답장 줄 뽑기(줄 없음 · 중복 id · 모르는 id). 픽스처 — 3페이지 코멘트,
봇 코멘트 무시, 재시작 뒤 첫 코멘트를 삼키지 않음. 하네스 — S6 · S10.

**끝.** 개발자는 코멘트마다 답을 받는다. 반려된 작업은 다음 제출에 그대로 실린다.

### 단계 8. 턴 자기치유 — M

- turn-retry.ts 사다리 · `auth` 분류를 budgets.ts 로.
- 로그인 뒤 한 번 다시(`selfRedeliver`), `reconnect/agent-login` 주의.
- 크래시 알림의 원문을 기록으로(session.ts:670-672, 716). 되살리기 예산(단계 0 의
  ReviveBudget) 초과 → 개발자 알림.
- 정상 종료의 inflight 보존(session.ts:753, 779), 시작 때 중단 턴 브리프(dispatch 의
  되살리기 길 재사용), 잃은 말 자동 복귀(queue-store.ts:286-303 · Composer).
- 길이 초과 → `/compact` 뒤 한 번. 드라이버에 `capabilities.compact` 를 더한다(Claude 만 참).
- 공통 규칙 두 줄(L12 질문 정책).

**시험.** turn-retry-failure.test.ts 확장(auth · 사다리 · 한도 24시간).
queue-inflight.test.ts 확장(정상 종료 뒤 남음). 가짜 드라이버로 세션 단위 — 종료 →
시작 → 브리프 한 번.

**끝.** 실패 카드가 사람의 손을 기다리는 경로는 사다리를 다 쓴 뒤뿐이고, 그때 개발자는
이미 알고 있다.

### 단계 9. 위생 — M

- 끝난 브랜치 정리(L4), 조정 표 7 · 15 · 16행.
- 고아 캡처 브랜치의 크기 기록. 정리 방식은 열린 항목 O4 의 결정을 따른다.
- 도구 태그 stash 는 조정 표가 늘 비우므로 따로 정리하지 않는다. 사용자가 손으로 만든
  stash 는 건드리지 않는다.
- 주 1회 `git gc --auto`, 주 1회 `git fsck --connectivity-only`. 손상 신호
  (`bad object` · `index file corrupt` · checkout 불가)가 보이면 재클론 — 커밋 안 된
  변경과 올라가지 않은 커밋을 `projects/<slug>/salvage/<시각>/` 에 patch 로 뽑아 둔 뒤
  새로 받고 다시 얹는다.
- `summary/` 임시 폴더와 요약 대화 기록 7일.
- 설치 판정: `installUpToDate` 에 호출자가 없다. node_modules 가 없으면 해시가 같아도
  설치하고, 워크스페이스 패키지의 package.json 도 해시에 넣는다(repo-bringup.ts:162-196).
- 저장소 이동 — `GET /repos/{o}/{r}` 의 `full_name` 이 다르면 `git remote set-url` 과
  레지스트리 갱신. 지금의 `project.update` 경로(repo.ts:181-219)는 다시 클론하므로 쓰지
  않는다.
- 디스크: `fs.statfs` 로 `~/.colo-design` 이 든 볼륨의 여유를 본다. 2GB 아래면 도구의
  것부터 치운다. → 열린 항목 O8.

**시험.** 하네스 — S12, 반려 브랜치는 기한 뒤 삭제, 손상된 인덱스 → 재클론 뒤 변경이
살아 있음.

**끝.** 사이클 50번을 흉내 낸 하네스에서 브랜치 · stash · 임시 파일 수가 늘지 않는다.

### 단계 10. 화면 정리 — M

**남기는 것.** 모델 · 생각 시간 칩, 사용량 칩, `@` 언급, `여기서 새 대화`, 작업 기록
되돌리기, 설정의 프로바이더 방.

**걷는 것 · 바꾸는 것.**

| 표면 | 자리 | 바뀜 |
| --- | --- | --- |
| 실패 배너 · 원문 오류 전부 | L8 대체 표 | `AttentionLine` 으로 |
| 잃은 말 패널 | Composer.tsx:1208-1241 | 없앰(L12) |
| `/로 명령` 안내 | PageWorkspace.tsx:690-692 | 개발 실행이 아니면 뺌 — `/` 목록이 비어 있다 |
| 상단 바 `상태 확인` | ScreenPanel.tsx:1252-1283 | 없앰 — 감독자가 확인한다. 창 포커스가 틱을 부른다 |
| 상태 칩 팝오버의 저장소 이름 · 요청 번호 | ScreenPanel.tsx:1140-1186 | 개발자 이름과 `마지막 확인 N분 전` 만 |
| 상태 칩의 브랜치 모양 아이콘 | delivery.ts:81 | 연필 |
| 개발자 코멘트 창 | ScreenPanel.tsx:1465-1580 | 없앰 — 코멘트는 대화록의 개발자 메시지로 이미 선다 |
| 코멘트의 파일 경로:줄 | HumanMessage.tsx:67 · turn.tsx:111 | 화면 제목, 없으면 뺌 |
| 넘기기 카드 | HandoffCard.tsx | 영수증만 — 누구에게 갔는지 · 링크 · 되돌리기 안내 |
| 핀 트레이의 컴포넌트 이름 · testid | PinTray.tsx:115-118 | 요소 글자만 |
| 프로젝트 카드의 미리보기 주소 · 저장소 이름 | Sidebar.tsx:1320-1365 | 개발 실행에서만 |
| 저장 메모 담당 · Slack 폼 · 실제 빌드 열기 | SettingsDialog.tsx:346-415, 1473 · FrozenStage.tsx:165-193 | 개발자용 칸으로 |
| 팔레트의 `화면` 약속 | Palette.tsx:334-337 | 자리 표시를 `대화, 프로젝트 찾기` 로 — 화면 결과를 내는 곳이 없다 |
| `개발자 부르기` 버튼 | CallDeveloper.tsx · Shell.tsx:546-551 | 없앰(L11) |

README 의 비개발자 부분을 이 판에 맞춰 다시 쓴다 — 일곱 걸음 중 `상태 확인` ·
받아오기 · 되살리기 문장, 알림 문단.

**끝.** 개발 실행 밖에서 개발자 어휘가 남은 표면이 0.

## 5. 검증

**순수 시험** — 판정은 모두 순수 함수이고 표 하나당 시험 하나다: `nextCycleAction` ·
`spend` · `conflictMarkers` · `mergeToolBlock` · `extractDeveloperReplies` · 알림 경로
고르기 · 본문 조립 · `classifyRetry` · `ReviveBudget` · `normalizeInvite` v4. 지금의
`bring-up-briefs.test.ts` 와 같은 모양이다.

**하네스 시험** — 임시 bare 원격 위에서 실제 git 을 돌린다(shelf-recover.test.ts 와 같은
방식). 가짜 GitHub 은 메모리 상태 전송, 가짜 AI 는 파일을 고치는 콜백이다.

| # | 장면 | 확인하는 것 |
| --- | --- | --- |
| S1 | 오프라인에서 턴 5번 → 복귀 | 밀린 커밋이 전부 올라감, 1시간 전에는 알림 없음 |
| S2 | 비활성 프로젝트의 베이스가 움직임 | 그 브랜치에 병합되고 푸시됨 |
| S3 | 베이스와 충돌 | 가짜 AI 정리 → 도구 병합 커밋 → stash 없음 |
| S4 | 스쿼시 병합 뒤 남은 커밋 2개 | 새 브랜치에 그 둘만 |
| S5 | 반려 | 새 브랜치에 전부, 반려 턴 한 번 |
| S6 | 개발자가 PR 브랜치에 커밋 | fast-forward 또는 병합, 다음 푸시 성공 |
| S7 | 병합 도중 강제 종료 | 시작 첫 틱이 이어받음 |
| S8 | 사이클 밖 base 에 커밋 | 새 사이클 브랜치로 옮겨짐, 작업 손실 없음 |
| S9 | 레지스트리가 PR 을 잃음 | head 로 입양, PR 하나 |
| S10 | 반려 이유 없음 | 턴 없이 개발자 알림 |
| S11 | 재시작 | 같은 반영 · 같은 코멘트를 두 번 알리지 않음 |
| S12 | 사이클 50번 | 브랜치 · stash · 임시 파일 수가 늘지 않음 |

**사람의 점검** — README 의 깨끗한 기계 점검에 긴 사용 장면을 더한다: 네트워크 끊고 턴
→ 다시 연결, GitHub 에서 스쿼시 병합, 반려, 코멘트, 작업 중 `kill -9`, 연결 코드 만료.
각 장면에서 사용자가 누른 것이 `보내기` · `제출` 과 세 번째 문장의 한 번뿐인지 센다.

CI 의 문은 지금처럼 `typecheck` 와 `build` 다. `pnpm test` 는 로컬에서 돌린다.

## 6. 리스크

| 리스크 | 대비 |
| --- | --- |
| 감독자가 AI 가 고치는 중인 트리를 흔든다 | 작업 트리 조치는 `busyIn(cwd)` 일 때 서지 않는다(L1) |
| 조치끼리 고리 | 틱 안 5회 상한 + 예산 |
| PR 에 베이스 병합 커밋이 쌓인다 | 개발자가 스쿼시 병합하면 사라진다. 리베이스는 강제 푸시가 필요해 개발자의 커밋을 지울 수 있다 → O1 |
| GitHub API 한도(토큰당 시간 5000) | 비활성 프로젝트는 10분, whoAmI 캐시, 조건부 요청(ETag)은 필요해지면 |
| 개발자 저장소에 이슈 · 코멘트가 쌓인다 | 문제 키 중복 억제, 풀리면 닫음, 라벨 하나로 모음 |
| 자동 답장이 사용자의 이름으로 나간다 | 답장 끝의 대리 표기, 초대로 끌 수 있음 → O5 |
| 고아 캡처 브랜치가 개발자 클론에 딸려 온다 | 기본 refspec 은 모든 브랜치를 받는다 → O4 |
| 옛 초대 파일(v3)은 Slack 이 없고 이슈 권한을 모른다 | 이슈를 먼저 시도한다 → O9 |
| 프로토콜 v18 | 데스크톱은 함께 나간다. 브라우저 개발 경로는 둘 다 다시 빌드 |
| 하네스 비용 | 단계 2 에서 한 번 세우고 모든 단계가 쓴다 |

## 7. 열린 항목

권장 값으로 계획을 세웠다. 다르게 정하면 해당 단계만 바뀐다.

| # | 정할 것 | 권장 | 바뀌는 단계 |
| --- | --- | --- | --- |
| O1 | 베이스를 따라가는 방식 | 병합(merge). 리베이스는 강제 푸시가 필요하다 | 2 |
| O2 | 병합된 브랜치의 원격 삭제 | 켬 | 9 |
| O3 | 반려 브랜치 보존 | 14일 | 9 |
| O4 | 화면 캡처를 둘 곳 | 고아 브랜치 `colo-design-assets`. 다른 길: 지금처럼 사이클 브랜치(main 에 쌓임), 외부 저장소 | 6 · 9 |
| O5 | 코멘트 자동 답장 | 켬, 대리 표기, 초대로 끌 수 있음 | 7 |
| O6 | 채팅으로 제출 | 켬, 분명한 요청일 때만 | 6 |
| O7 | 알림 이슈의 라벨 · 담당자 | 라벨 `colo-design`, 담당자는 초대 파일의 리뷰어 첫 사람 | 4 |
| O8 | 도구가 치워도 디스크가 모자랄 때 | 사용자 기계의 일이라 개발자가 고칠 수 없다. 네 번째 문장 `저장 공간이 부족해요` 를 둘지 | 9 |
| O9 | 옛 초대 파일에서 GitHub 도 Slack 도 막힐 때 | 화면에 `개발자 확인이 필요해요` 한 줄(주의의 네 번째 종류), GitHub 이 닿는 첫 순간 새 초대 파일을 요청하는 알림 | 4 · 5 |
| O10 | 커밋되지 않은 작업 트리 변경 | 단계 0 에서 먼저 커밋 — 누가 어떤 단위로 할지 | 0 |
