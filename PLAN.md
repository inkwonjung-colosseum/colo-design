# PLAN — 게이트 넷, 사이드바, 프로젝트는 작업 화면에서

목적: 기획자가 여러 레포에서 화면을 만든다. 첫 실행은 이 컴퓨터에서 한 번만 답하는 네 가지(Claude Code · git · Node·pnpm · GitHub 토큰)로 끝나고, 레포는 작업 화면의 왼쪽 목록에서 고르고 더한다. 미리보기 서버는 지금 보고 있는 프로젝트 하나만 돈다. Claude 세션은 죽지 않는다.

프로젝트 = 연결 레포 하나 = 클론 하나 = 사이클 하나(`cds-design/<YYYYMMDD>-<n>` 브랜치 · PR 하나). 지금과 같다. 레포 안에서 작업을 여럿으로 가르는 층은 "열어둔 것".

이전 두 계획(`PLAN-github-onboarding.md` · `PLAN-sidebar.md`)을 여기 합쳤다. **이 문서가 유일하다. 완료 전에 지우지 않는다.**

## 지금 (읽은 것 — 2026-09-10 감사 후)

**이미 들어간 것(GitHub 토큰 패스).** 게이트는 `claude · git · github`(`onboarding.ts:48-54`), `project` 게이트 · `OnboardingDeps.repo` · `repo-install` 은 없다. PAT 는 머신 하나(`credentials.ts:24 REPO_PAT_ITEM`), `migrateProjectPats`(`168-192`)가 `server.ts:207-213` 에서 돈다. `github.token.set · repos.list · repo.inspect`(`protocol:288,300,309`; `server.ts:828-866`), `GitHubClient.whoAmI/listRepos/hasCdsDesign`(`github.ts:68,117,148`). 웹: `GitHubTokenForm.tsx` · `RepoPicker.tsx`(404줄, 완성) · `AddProjectDialog.tsx`, `Shell.tsx:127-132` 빈 상태 인라인 피커, `Shell.tsx:144-149` 대화상자, `SettingsDialog.tsx:334-364` GitHub 그룹. 위저드는 셋 pass → `시작하기`(`Onboarding.tsx:146-148`). `PROTOCOL_VERSION` 은 아직 8.

**아직인 것 — 이 문서의 나머지.**
- Node · pnpm 은 게이트가 아니다. 데스크톱은 포터블 node + corepack(pnpm shim)을 `resources/bin` 에 싸 가지고(`bundle-runtimes.mjs`) `CDS_DESIGN_EXTRA_PATH` 로 데몬에 넘기며(`main.ts:37-41`), `repo.ts:1225` 가 레포 명령의 PATH 앞에 붙인다. 번들이 없는 경로(브라우저 개발 · 번들 누락 빌드)에서는 `buildStatus` 가 영어 경고 한 줄(`environment.ts:390-392`)을 헤더 배너에 올리고, 실제로는 설치 · 미리보기 단계에서 `PNPM_MISSING_DETAIL`(`repo.ts:1154`)로 터진다 — 클론 몇 분 뒤에야. 우리 조직 레포는 전부 pnpm 이다.
- 프로젝트 = 클론 하나 `projects/<slug>/repo/`. 정확히 하나가 활성. 전환은 나가는 쪽 `repo.stop()` → `setActive` → 들어오는 쪽 `sync()` (`server.ts:389-415 activateProject`). **서버 하나 규칙은 이미 있다.**
- 세션은 cwd(=클론 realpath)로 격리되고 `activateProject` 는 `SessionManager` 를 건드리지 않는다. **세션 유지도 이미 있다.** 비활성 프로젝트의 세션은 `session.list` 에서 걸러지고(`session-manager.ts:154-181`) `session.send` 는 거부된다(`server.ts:665-674`).
- 비활성 프로젝트의 상태는 어디에도 안 보인다: `broadcastFor` 가 활성이 아닌 `repo.status` 를 버리고(`server.ts:340-342`), `ProjectSummary` 는 `slug · name · repoUrl · baseBranch` 뿐(`protocol:378-384`).
- 버그: 턴이 끝나면 `this.repo.refreshPendingChanges()` — **활성** 레포를 다시 센다(`server.ts:178-180`). A 에서 턴이 끝났는데 B 를 보고 있으면 B 를 센다.
- 웹: 헤더 드롭다운 `ProjectSwitcher`(`Shell.tsx:5,90`), 그 안의 `+ 새 프로젝트` 는 이제 `AddProjectDialog` 를 연다. 사이드바 없음. `.planner` 는 `flex column`(`styles.css:1151`), `.planner__body` 는 채팅 | 미리보기 2열(`styles.css:1258-1262`) + 드래그 스플리터(`PageWorkspace.tsx:146-198`, `LayoutSettings.previewWidth` 만 — `settings.ts:23-25`). `Shell.tsx:63-67` 에 `wizardNeeded`(첫 실행에 어느 게이트든 non-pass 면 위저드가 자리를 지킨다) 가 새로 있다.
- `daemon.repo` 는 활성 레포의 것 하나(`daemon-client.ts:490`). `ScreenPanel` · `PageWorkspace` 가 그것을 "그 레포"로 읽는다 — 그대로 둔다. `ScreenPanel.tsx:266` 은 마운트 시 `repoSync()` 를 부르므로 프로젝트가 없으면 `requireActive` 로 던진다.
- 홈 폴더는 점이 없다: `CDS_DESIGN_DIR = join(homedir(), "cds-design")`(`environment.ts:17`). `~/.claude · ~/.paseo · ~/.orca` 옆에서 혼자 Finder 에 보인다. 기획자가 이 폴더에서 할 수 있는 일은 클론 안 파일을 Finder 로 고치는 것 — 쓰기 정책과 diff 검토를 우회하는 사고 — 뿐이다.
- 이름 층위가 겹친다: 개념 "연결 레포" 와 본보기 앱 디렉터리 `connected-repo/`. 클론은 홈에 있고 `connected-repo/` 는 `ui-comments-e2e.mjs:68` 이 로컬 원격으로 클론하는 본보기일 뿐이다. **이 작업 트리에는 그 폴더가 지금 없다**(gitignored, 사라짐) — D3 은 텍스트만 바꾸고, `test:comments-ui` 는 다시 클론해 두기 전엔 못 돈다.
- 설정 → 문제 해결(`SettingsDialog.tsx:402-410`)에는 `처음 설정 다시 보기` · `업데이트 확인`. 데스크톱 다리(`preload.ts:7-11`)는 업데이트 확인 둘만 노출.
- 세 게이트 문구가 남은 자리: `Onboarding.tsx:81` "세 단계", `onboarding.test.mjs:79-83` `["claude","git","github"]` 고정, `README.md:84-91, 273-274`. `daemon-client.ts:763-764` 에 죽은 주석 "repo-install clones and installs".
- `ui-planner-e2e.mjs:218` 이 `.sidebar` 요소 0개를 단언한다("개발자 크롬 없음" — 옛 화면 레일 시절의 것). 사이드바가 들어오면 이 단언이 먼저 깨진다.
- `ui-onboarding-e2e.mjs:203-209` 가 둘째 프로젝트 흐름을 `.project .selector__chip`(ProjectSwitcher)으로 몬다.

## 결정

### 홈 폴더

| # | 항목 | 결정 |
|---|---|---|
| D1 | 경로 | `~/cds-design` → **`~/.cds-design`**. 도구의 상태지 기획자의 문서가 아니다. 시작 시 옛 폴더가 있고 새 폴더가 없으면 `renameSync`(같은 홈, 즉시; 옛 것이 심링크면 링크가 옮겨진다). 둘 다 있으면 건드리지 않고 `status.warnings` 한 줄. **지금 아니면 못 한다** — SDK 대화록이 cwd 경로로 저장돼 나중에 옮기면 사용자 세션이 사라진다 |
| D2 | 폴더 열기 | 설정 → 문제 해결에 `폴더 열기`(Electron `shell.openPath(CDS_DESIGN_DIR)`). 브라우저 개발 경로(다리 없음)는 경로 텍스트. 지원 대화에 "홈에서 폴더 찾으세요" 는 안 나온다 |
| D3 | 본보기 디렉터리 | `connected-repo/` → `reference-repo/`. 자기 git 히스토리 · GitHub 이름 그대로. 바뀌는 건 `.gitignore:6` · `ui-comments-e2e.mjs:2,7,12,15,68,108,437` · `README.md:199,302`. 폴더는 이 트리에 없으니 GitHub 에서 `reference-repo/` 로 다시 클론해 둔다 |

### 첫 실행 — 머신 게이트 넷

| # | 항목 | 결정 |
|---|---|---|
| D4 | 게이트 | `claude · git · runtime · github`. 전부 머신 단위. 옛 `project` 게이트 **삭제** — `checkProject`(`ls-remote` 포함) · `OnboardingDeps.repo` · `repo-install` fix 제거. 클론 에러 · `cds-design.json` 없음 · 설치 실패는 `RepoWorkspace` 가 `phase: "error"` + 한국어 detail 로 작업 화면에 이미 올린다 |
| D5 | `runtime` 판정 | 제목 `Node · pnpm`. **레포 명령이 실제로 쓸 PATH**(`extraPathPrefix(CDS_DESIGN_EXTRA_PATH)`)에서 `node --version` · `resolvePnpmExecutable()` + `pnpm --version`. 둘 다 있고 node ≥ 22 → pass "node 22.x · pnpm 10.x" (번들이면 "앱에 포함된 node 22.x · pnpm 10.x"). node 없음/22 미만 → fail "Node.js 22 이상이 필요합니다 (지금: 없음 / 20.x)" + fix `install-node`(nodejs.org LTS 링크 ↗, 자동 설치 없음 — 관리자 권한 · 패키지 매니저 판단을 도구가 하지 않는다). pnpm 없음 → fail "pnpm이 없습니다" + fix `install-pnpm`(`corepack enable` 실행; 실패하면 detail 에 `corepack enable` 또는 `npm i -g pnpm` 명령 그대로). 데스크톱 패키지에서는 번들 덕에 항상 pass — 번들이 빠진 빌드를 잡아내는 것이 이 게이트의 데스크톱 쪽 값 |
| D6 | 경고 중복 제거 | `buildStatus` 의 pnpm 영어 경고(`environment.ts:390`) 삭제 — 게이트가 한국어로 말한다. `pnpmAvailable` 필드는 유지 |
| D7 | PAT 범위 | 머신 하나. 아이템은 기존 `REPO_PAT_ITEM = "pat"`. `pat:<slug>` · `project.create/update.repoPat` · `repo.configure.pat` · `RepoStatus.patConfigured` · `ProjectSummary.repoPatConfigured` 제거 |
| D8 | PAT 이관 | 시작 시 `pat` 가 비어 있고 `pat:<slug>` 가 있으면 활성(없으면 첫) 프로젝트의 것을 `pat` 로 복사하고 `pat:*` 삭제. 한 번만 |
| D9 | 토큰 종류 | classic PAT `repo` 스코프 권장. `https://github.com/settings/tokens/new?description=CDS%20Design&scopes=repo` 를 위저드가 연다. fine-grained 도 동작(`verifyPullRequestAccess` 분기 유지) |
| D10 | `github` 판정 | 토큰 없음 → **warn**(비차단 — 공개 레포 · 주소 직접 입력 사용자를 막지 않는다; 카드는 펼쳐져 폼을 보인다). `GET /user` 401 → **fail** "토큰이 유효하지 않거나 만료됐습니다". 네트워크 실패 → fail "GitHub에 연결하지 못했습니다" + 다시 시도. 200 → pass "GitHub @login 로 연결됨" |
| D11 | 위저드 표시 | pass 는 한 줄로 접힘(글리프 · 제목 · detail). 지금 할 첫 단계만 펼침. **fail 이 없으면** `시작하기` — GitHub 가 warn 이면 카드는 펼쳐진 채, `시작하기` 도 살아 있다. `wizardNeeded`(`Shell.tsx:63-67`): 첫 실행에 어느 게이트든 non-pass 면 `시작하기` 를 누르기 전까지 위저드가 자리를 지킨다 — 유지. 재진입은 설정의 `처음 설정 다시 보기` 만. 머리글 "세 단계" → "네 단계"(`Onboarding.tsx:81`) |

### 작업 화면 — 셸과 사이드바

| # | 항목 | 결정 |
|---|---|---|
| D12 | 어휘 | 프로젝트. "작업" · "워크스페이스" · "브랜치" 는 UI 에 없다 |
| D13 | 서버 하나 | `activateProject` 그대로. 전환 직후 미리보기 칸은 기존 `ProgressPanel` 의 `starting → ready`. 채팅 · 변경 사항 · 스테퍼는 git 만 읽으니 즉시 |
| D14 | 세션 유지 · 다시 세기 | 그대로. `onState` 의 다시 세기를 **그 세션이 속한 프로젝트**로(`workspaceOfSession(sessionId)` — 세션 cwd 와 각 `repoRoot` realpath 비교). **이 계획의 첫 커밋이다** — 사이드바와 무관하게 지금 틀린 숫자를 만들고 있고, 사이드바가 오면 두 행이 같이 틀리게 보인다 |
| D15 | 행 표식 | 하나만, 우선순위: `내려받는 중…`(phase `cloning|pulling|installing|starting`) > `작업 중`(그 클론의 라이브 세션 중 running) > `넘김` / `반영됨`(handoff) > `변경 N`(pendingChanges, 파일 수 — 스테퍼와 같은 숫자) > 없음. 줄 수(+/−)는 안 보여준다 |
| D16 | 상태 전달 | `repo.*` · `diff.*` · `session.*` 는 **여전히 활성 프로젝트**를 뜻한다(id 없음). 비활성 프로젝트의 상태는 `project.changed` 의 `ProjectSummary` 에: `phase · pendingChanges · working · handoff` |
| D17 | 언제 보내나 | `announceProjects()`: 등록부 변경 + 어느 프로젝트든 `pendingChanges` 변화 + 어느 세션이든 running ↔ 아님 + 어느 프로젝트든 `phase` 변화. 200ms 스로틀 |
| D18 | 시작 시 | 등록부의 **모든** 프로젝트에 `RepoWorkspace` 를 만들고(생성자 동기 · 부작용 없음) 클론된 것은 `refreshPendingChanges()`(ms). 미리보기는 활성만 |
| D19 | 사이드바 폭 | `LayoutSettings.sidebarWidth`(200–360, 기본 240) · `sidebarCollapsed`. 미리보기 폭과 같은 드래그 · 저장 · 클램프. 1100px 미만 자동 접힘 |
| D20 | 행 메뉴 `···` | 이름 바꾸기(`project.update { name }`, 인라인) · 설정 · 프로젝트 지우기 |
| D21 | 지우기 | "`<이름>` 을 지웁니다." + 저장 안 한 변경이 있으면 "저장하지 않은 변경 N개가 있습니다." 버튼 둘: `목록에서만 지우기`(폴더 남음) · `폴더까지 지우기`(`deleteFiles: true`). 데몬 순서: 그 cwd 의 라이브 세션 전부 `close` → `repo.stop()` → 등록부 제거 → (`deleteFiles`) `rmSync`. 지금 `project.remove` 는 세션을 안 건드려 지운 폴더에 Claude 가 쓸 수 있다. 활성이면 다음을 활성화(지금 로직) |
| D22 | 헤더 | `ProjectSwitcher` 삭제(파일도). 헤더는 오른쪽 열 안: 활성 프로젝트 이름 · 연결 힌트 · 설정. 접기 버튼은 헤더 왼쪽 |
| D23 | 빈 상태 | 프로젝트 0개: 사이드바는 브랜드 · `+ 새 프로젝트` 만, 헤더는 `CDS Design`, 본문은 `RepoPicker` 인라인(`.planner__empty`). `PageWorkspace` 는 마운트하지 않는다(`ScreenPanel.tsx:266`). 첫 프로젝트가 만들어지면 같은 프레임 안에서 행 하나 + 작업 화면으로 |
| D24 | 알림 | OS 알림은 기존 `onNotice`. 사이드바 표식 변화가 앱 안의 알림. 새 종류 없음 |
| D34 | 전환 직렬화 | `activateProject` 가 겹치면 두 `sync()` 가 한 포트를 다툰다. 서버에 `activating: Promise<void> | null` 하나 — 진행 중이면 뒤 요청은 앞 것을 기다린 뒤 실행(마지막 요청이 이긴다). 웹의 `disabled` 는 표시일 뿐 방어가 아니다 |

### 프로젝트 추가 — `RepoPicker`

| # | 항목 | 결정 |
|---|---|---|
| D25 | 자리 | 0개 → 본문 인라인(D23). 1개 이상 → 사이드바 `+ 새 프로젝트` 가 `AddProjectDialog`. 같은 컴포넌트. `project.create` 가 돌아오면(ms) 피커는 닫히고/사라지고 새 프로젝트가 활성 — 내려받기 · 설치 · 미리보기 진행은 미리보기 칸이 그린다. 위저드에 `만드는 중…` 없음 |
| D26 | 목록 | `GET /user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100`(`github.ts:117-120`), `Link: next` 따라 최대 5쪽(500). 넘으면 `truncated`. `archived` 제외는 응답 매핑에서(쿼리에 없음 — `github.ts` 매핑에 필터가 실제로 있는지 확인). 데몬이 토큰별 캐시(`server.ts:159,848-856`), 토큰 교체 · 새로고침에 무효화 |
| D27 | 레포 검사 | 목록 전체 프로빙 없음. 선택한 하나만 `GET /repos/{o}/{r}/contents/cds-design.json`(200/404). `permissions.push` 는 목록 응답에 있음 |
| D28 | 클론 전 차단 | `cds-design.json` 없는 레포는 만들기 비활성 + 이유. 지금은 클론 · 설치 몇 분 뒤에야 안다 |
| D29 | 쓰기 불가 | 목록에서 제외 — `permissions.push` 가 false 인 레포는 행째로 안 보여준다(선택해도 넘기기가 막히므로). `주소로 추가` 는 그대로 열려 있다 |
| D30 | 중복 | 이미 프로젝트가 있는 레포는 `추가됨` 배지 + 선택 불가 |
| D31 | 주소 직접 입력 | "목록에 없나요? 주소로 추가" 로 접힘(토큰 없으면 펼쳐진 채 — `RepoPicker.tsx manualOpen`). 주소 하나(토큰 필드 없음). GitHub 외 호스트도 이 길 — `parseRepoSlug` 가 null 이면 PR 게이트는 지금처럼 건너뜀. **남은 것:** GitHub 주소일 때 서버가 `parseRepoSlug` 로 `inspect` 를 같이 돌려 D28 을 적용하는 부분은 아직 안 물렸다(`RepoPicker.tsx:167-183` 는 create 만) |
| D32 | 설정 대화상자 | `개인 액세스 토큰` 을 `연결 레포` 에서 빼 새 `GitHub` 그룹으로: "@login 로 연결됨 · 토큰 바꾸기". `레포 주소` 는 프로젝트별 그대로 |

### 프로토콜

| # | 항목 | 결정 |
|---|---|---|
| D33 | v9 한 번 | 추가 `github.token.set · github.repos.list · github.repo.inspect`. `OnboardingStepId = "claude" \| "git" \| "runtime" \| "github"`. `OnboardingFixKind = "install-claude" \| "login-claude" \| "install-git" \| "install-node" \| "install-pnpm"`(`repo-install` 제거). `OnboardingFix` 에 `href?: string`(`install-node` 는 링크만). `ProjectSummary` 에 `phase · pendingChanges · working · handoff`. 제거 D7 항목. `project.activate · update · remove` 는 그대로. **범프는 마지막에 한 번** — 지금 8 인 채로 `github.*` 가 들어갔다; 필드가 다 붙은 뒤(4단계 전) 올린다. 중간에 올리면 데스크톱 · 웹이 두 번 어긋난다 |

## 화면과 흐름

### ① 첫 실행 — 위저드. 펼친 카드가 지금 할 일 하나.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          CDS Design 시작하기                             │
│           이 컴퍼터에서 한 번만 확인하는 네 단계입니다.                     │
│                                                                          │
│   ✓ 1 Claude Code     Claude Code 1.0.x · 구독 로그인됨                  │
│   ✓ 2 git             git 준비됨 (2.50.0)                                │
│   ┌ ✗ 3 Node · pnpm ──────────────────────────────────────── 실패 ┐     │
│   │ 레포를 설치하고 미리보기를 띄우는 데 씁니다.                        │     │
│   │ Node.js 22 이상이 필요합니다 (지금: 20.11)                          │     │
│   │ pnpm이 없습니다                                                    │     │
│   │                        [ Node.js 내려받기 ↗ ]   [ pnpm 설치 ]      │     │
│   └──────────────────────────────────────────────────────────────────┘     │
│   · 4 GitHub          Node · pnpm 뒤에                                   │
└──────────────────────────────────────────────────────────────────────────┘
```
- 데스크톱 패키지에서는 3 이 `✓ 3 Node · pnpm   앱에 포함된 node 22.12 · pnpm 10.4` 로 접혀 있다. 기획자는 이 카드를 펼친 채 보지 않는다 — 브라우저 개발 경로와 번들 빠진 빌드가 보는 카드다.
- `pnpm 설치` → `onboarding.fix install-pnpm`(`corepack enable`) → 재검사. `Node.js 내려받기 ↗` 는 새 창; 설치 뒤 `다시 확인`.
- 3 이 pass 면 4 GitHub 카드가 펼쳐진다:

```
│   ✓ 3 Node · pnpm     node 22.12 · pnpm 10.4                             │
│   ┌ ! 4 GitHub ────────────────────────────────────────── 연결 안 됨 ┐   │
│   │ 레포 목록을 가져오고 개발자에게 넘길 때 쓰는 토큰입니다.              │   │
│   │ 값은 이 컴퓨터의 자격 증명 저장소에만 있고 다시 보이지 않습니다.      │   │
│   │ [●●●●●●●●●●●●●●●●●●●●●●●●●●            ]  [연결]   토큰 만들기 ↗ │   │
│   └──────────────────────────────────────────────────────────────────┘   │
│                                                          [ 시작하기 ]    │
```
- `연결` → `github.token.set` → `✓ 4 GitHub  @jik-dev 로 연결됨   토큰 바꾸기` 한 줄로. 401 이면 필드는 두고 detail 만 빨간 줄.
- `토큰 만들기 ↗` 는 D9 링크 새 창(`target="_blank" rel="noreferrer"`) — 스코프 · 이름 미리 채움.
- 토큰 없이도(warn) `시작하기` 는 살아 있다. 1·2·3 중 하나라도 fail 이면 `시작하기` 없음.

### ② 시작하기 → 프로젝트 0개의 작업 화면. 본문이 피커다.

```
┌ 사이드바 240 ────┬ CDS Design                                          ⚙ ┐
│ CDS Design    ‹  │                                                       │
│                  │     ┌ 프로젝트 추가 ────────────────────────────────┐  │
│                  │     │ 화면을 만들 레포를 고르세요.                     │  │
│                  │     │ [🔍 레포 이름으로 찾기                     ]   │  │
│                  │     │ ┌────────────────────────────────────────────┐ │  │
│                  │     │ │ cds-org / payments-web       3일 전        │ │  │
│                  │     │ │ cds-org / member-admin       1주 전        │ │  │
│                  │     │ │ jik-dev / sandbox            5달 전        │ │  │
│                  │     │ └────────────────────────────────────────────┘ │  │
│                  │     │ 접근 가능한 레포 47개   목록에 없나요? 주소로 추가 │  │
│                  │     └────────────────────────────────────────────────┘  │
│ + 새 프로젝트    │                                                       │
└──────────────────┴───────────────────────────────────────────────────────┘
```

### ③ 행 클릭 → 확정 행. 클론 전에 `cds-design.json` 을 본다.

```
│     │ │ ▶ cds-org / payments-web       3일 전        │ │
│     │ └────────────────────────────────────────────┘ │
│     │ ─────────────────────────────────────────────  │
│     │ ✓ cds-design.json 있음 · 기본 브랜치 main        │
│     │ 프로젝트 이름 [payments-web        ] [프로젝트 만들기] │
│     │ 레포를 내려받고 설치·미리보기까지 합니다 — 처음에는 몇 분 걸립니다. │
```
- 검사 줄 세 상태: `확인 중…` → `✓ cds-design.json 있음 · 기본 브랜치 main` → `✗ 이 레포에는 cds-design.json이 없습니다 — 개발자에게 CDS 설정을 요청해 주세요`(버튼 비활성).
- 목록 캐시가 낡아 검사가 `canPush: false` 를 답하면 `! 이 토큰으로는 이 레포에 넘길 수 없습니다 — 화면 작업은 되지만 PR은 열지 못합니다` 덧붙임. 버튼은 산다.
- 이름은 레포 이름으로 미리 채움. 입력 필드 하나.

### ④ 프로젝트 만들기 → 같은 프레임이 작업 화면으로. 진행은 미리보기 칸이.

```
┌ 사이드바 240 ────┬ payments-web                                       ⚙ ┐
│ CDS Design    ‹  │ [ 새 대화 ]                    │                      │
│                  │                                │  내려받는 중…         │
│ ● payments-web   │                                │  ▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯  │
│    내려받는 중…  │      기획서를 첨부하고          │  설치                 │
│                  │      화면을 시켜 보세요.        │                      │
│                  │ ┌────────────────────────────┐ │ ○ 화면 만들기 ─ 검토·수정│
│                  │ │ 메시지, @files, /commands  │ │   ─ 저장 ─ 넘기기 ─ 반영됨│
│ + 새 프로젝트    │ │ +  Opus · 보통 · 기본       │ │                      │
└──────────────────┴────────────────────────────────┴──────────────────────┘
```
`ready` 가 되면 행의 `내려받는 중…` 이 사라지고 미리보기 칸에 `화면 대기 중`.

### ⑤ 기획서 첨부 → 턴 → 턴 종료. 숫자가 행과 스테퍼에 같이 선다.

```
┌ 사이드바 240 ────┬ payments-web                                       ⚙ ┐
│ CDS Design    ‹  │ 결제 실패 화면 ×  [ + ]        │ 화면 ▾ 결제/PayFailed  │
│                  │                                │ 상태: [기본][empty][error]│
│ ● payments-web   │  ▸ 기획서: 결제실패_v2.pdf     │   ┌────────────────┐ │
│         변경 3   │  결제 실패 화면 세 상태를      │   │ ✕ 결제에 실패했어요│ │
│                  │  만들었습니다. 미리보기에서…    │   │ [다시 시도]      │ │
│                  │ ┌────────────────────────────┐ │   └────────────────┘ │
│                  │ │                            │ │ ● 검토·수정  변경 3개  │
│ + 새 프로젝트    │ │ +  Opus · 보통 · 기본       │ │        [ 저장 ]        │
└──────────────────┴────────────────────────────────┴──────────────────────┘
```

### ⑥ `+ 새 프로젝트` → 같은 피커가 대화상자로. 이미 있는 레포는 `추가됨`.

```
        ┌ 프로젝트 추가 ───────────────────────────────────── ✕ ┐
        │ [🔍 mem                                          ]  │
        │ ┌──────────────────────────────────────────────────┐ │
        │ │   cds-org / payments-web    3일 전       추가됨  │ │
        │ │ ▶ cds-org / member-admin    1주 전               │ │
        │ └──────────────────────────────────────────────────┘ │
        │ ✓ cds-design.json 있음 · 기본 브랜치 main             │
        │ 프로젝트 이름 [member-admin      ]  [프로젝트 만들기]  │
        └──────────────────────────────────────────────────────┘
```
만들기 → 대화상자 닫힘 → `member-admin` 행이 활성 · `내려받는 중…`, payments-web 의 서버는 죽고 세션 · 변경은 그대로.

### ⑦ 여러 프로젝트 — 보이는 것만 켜져 있다.

```
┌ 사이드바 240 ────┬ member-admin                                       ⚙ ┐
│ CDS Design    ‹  │ 회원 탈퇴 화면 ×  [ + ]        │ 화면 ▾ 회원/Withdraw  │
│                  │                                │   ┌────────────────┐ │
│ ◐ payments-web   │  탈퇴 사유 선택 화면을         │   │ 탈퇴 사유를 알려주세요│ │
│         작업 중  │  만들었습니다.                 │   │ ○ 더 이상 쓰지 않아요│ │
│                  │                                │   └────────────────┘ │
│ ● member-admin   │ ┌────────────────────────────┐ │ ● 검토·수정  변경 1개  │
│         변경 1   │ │                            │ │        [ 저장 ]        │
│                  │ │ +  Opus · 보통 · 기본       │ │                      │
│   design-system  │ └────────────────────────────┘ │                      │
│         넘김     │                                │                      │
│ + 새 프로젝트    │                                │                      │
└──────────────────┴────────────────────────────────┴──────────────────────┘
```
- `◐ payments-web 작업 중`: 거기서 시켜 둔 Claude 턴이 배경에서 돈다(세션은 안 죽는다). 끝나면 `변경 5` + OS 알림 「결제 실패 화면 — 작업 완료」.
- `payments-web` 클릭 → 헤더 · 채팅 · 변경 사항은 즉시, 미리보기 칸만 `켜는 중` → `ready`. member-admin 의 서버는 죽는다.
- 행 `···`: 이름 바꾸기 · 설정 · 프로젝트 지우기(두 버튼).

### 사용자 흐름 한 줄씩

1. 앱 실행 → 위저드. 데스크톱이면 1·2·3 은 대개 이미 ✓(Node · pnpm 은 앱에 포함). GitHub 카드에 토큰 붙이고 `연결`(또는 건너뜀).
2. `시작하기` → 빈 작업 화면. 본문의 목록에서 레포를 고른다(검색 · ↑↓ · Enter). 검사 줄이 ✓ 면 `프로젝트 만들기`.
3. 사이드바에 행 하나, 미리보기 칸이 내려받기 · 설치 · 시작을 그린다. `ready`.
4. 기획서 첨부 → 화면 생성 → 미리보기 · 코멘트 핀 → `변경 N` → 저장 → 넘기기 → 반영됨. (지금과 같음)
5. `+ 새 프로젝트` → 대화상자에서 둘째 레포. 활성이 옮겨지고 앞 서버는 죽는다. 앞 프로젝트에 시켜 둔 턴은 계속 돈다 → 행이 `작업 중` → 끝나면 `변경 N` + 알림.
6. 행 클릭으로 오간다. 매번 바뀌는 칸은 미리보기 하나.
7. 토큰이 만료되면 넘기기가 실패한 자리에서 설정 → GitHub → `토큰 바꾸기`. 한 번이면 모든 프로젝트가 산다.

### 세부 규칙

**목록의 상태**

| 상태 | 표시 |
|---|---|
| 가져오는 중 | 회색 자리표시 행 3개(36px, 텍스트 없음). 검색 비활성 |
| 토큰 없음 | 검색 · 목록 대신 한 줄 `GitHub에 연결하면 목록에서 고를 수 있습니다 — 설정 → GitHub`(설정 여는 링크) + `주소로 추가` 펼쳐진 채 |
| 0개 | `이 토큰에 쓰기 권한이 있는 레포가 없습니다.` + 안내(읽기 전용 제외 · fine-grained 접근 범위와 Contents 권한 · 조직 SSO authorize). `주소로 추가` 펼쳐진 채 |
| 검색 무일치 | `'pay' 와 맞는 레포가 없습니다.` + `주소로 추가` 링크 |
| 500 초과 | 하단 `최근 500개만 보여줍니다 — 이름으로 찾거나 주소로 추가하세요` |
| 목록 실패 | 검색 대신 `레포 목록을 가져오지 못했습니다 — (첫 줄)` + `다시 시도` |
| 만드는 중 | 확정 행 버튼 `만드는 중…`, 목록 · 검색 비활성 — `project.create` 가 등록부에 쓰고 돌아올 때까지(ms) |

**피커 행**: `owner /` 는 `--muted`, `name` 은 `--text` 600. 오른쪽 `pushed_at` 상대 시각(`--muted`, mono 11px). 배지 하나: `추가됨`(회색). 토큰에 푸시 권한이 없는 레포는 행째로 목록에서 뺀다(D29). 자물쇠 · 설명 · 별 수 없음. 검색 autofocus, `↓↑` 강조, `Enter` 선택, `Esc` 해제. `role="listbox"` · `option` · `aria-activedescendant`. `max-height: 320px`, 강조 행 `scrollIntoView({block:"nearest"})`. 정렬은 서버의 `pushed` 순.

**주소로 추가(접힘)**: 클릭 → `[https://github.com/<조직>/<레포>.git] [추가]` + "토큰 없이 접근할 수 있는 주소나, GitHub 밖의 git 주소를 쓸 때만." GitHub 주소면 서버가 `parseRepoSlug` 로 `inspect` 를 같이 돌려 D28 적용.

**사이드바 행**: 이름 한 줄 + 표식 한 줄(`--muted`, mono 11px). `●` 활성, `◐` 작업 중(`--accent`). 클릭 → `project.activate`, 전환 중 행은 `전환 중…`, 다른 행 비활성. `···` 는 hover/포커스. `role="listbox"` · `option` · `↑↓` · `Enter` · `F2` 이름 바꾸기 · `Delete` 지우기. 폭: 1280 에서 240 + 채팅 320 + 미리보기 380 = 940. 1100 미만 접힘(아이콘 열 44px: 첫 글자 원형 + 표식 점).

**설정 대화상자**

```
GitHub
  계정         @jik-dev 로 연결됨                    [토큰 바꾸기]
               값은 데몬에만 저장되고 다시 보여지지 않습니다
연결 레포
  레포 주소    [https://github.com/cds-org/payments-web.git] [저장]
문제 해결
  처음 설정 다시 보기          폴더 열기  ~/.cds-design
               클론과 설정이 있는 곳입니다. 여기 파일을 직접 고치지 마세요 — 화면은 대화로, 저장은 버튼으로.
```
`토큰 바꾸기` 는 인라인 password + `연결`(위저드와 같은 `GitHubTokenForm`). 토큰 없음이면 계정 줄 `연결되지 않음` + 폼 펼침.

**UI 어휘**: Claude Code, git, Node · pnpm, Node.js 내려받기, pnpm 설치, 다시 확인, GitHub, 연결, 토큰 만들기, 토큰 바꾸기, @login 로 연결됨, 앱에 포함된, 시작하기, 프로젝트 추가, 새 프로젝트, 레포 이름으로 찾기, 접근 가능한 레포 N개, 추가됨, cds-design.json 있음, 기본 브랜치, 프로젝트 만들기, 목록에 없나요? 주소로 추가, 내려받는 중…, 작업 중, 변경 N, 넘김, 반영됨, 전환 중…, 이름 바꾸기, 프로젝트 지우기, 목록에서만 지우기, 폴더까지 지우기, 저장하지 않은 변경 N개가 있습니다, 폴더 열기

## 선로 (protocol v9)

```ts
export type OnboardingStepId = "claude" | "git" | "runtime" | "github";
export type OnboardingFixKind =
  | "install-claude" | "login-claude" | "install-git" | "install-node" | "install-pnpm";
export interface OnboardingFix { kind: OnboardingFixKind; label: string; /** 링크만인 fix(install-node). */ href?: string }

export interface GitHubRepo { fullName; owner; name; cloneUrl; defaultBranch; private; canPush; pushedAt }
export interface GitHubRepoList { repos: GitHubRepo[]; truncated: boolean }
export interface GitHubRepoInspection { hasCdsDesign: boolean; canPush: boolean; defaultBranch: string }

export interface ProjectSummary {
  slug: string; name: string; repoUrl: string | null; baseBranch: string;
  /** 디스크 기준. 활성만 ready 까지 오르고, 비활성 클론은 ready(클론됨) 또는 missing. */
  phase: RepoPhase;
  /** 마지막으로 센 저장 안 한 변경 파일 수. 스테퍼와 같은 출처. */
  pendingChanges: number;
  /** 이 클론에서 running 인 라이브 세션이 있는가. */
  working: boolean;
  handoff: HandoffStatus | null;
}
```

클라이언트 메시지 추가: `github.token.set { token: string | null }` → `OnboardingStep`; `github.repos.list { refresh?: boolean }` → `GitHubRepoList`; `github.repo.inspect { owner; repo }` → `GitHubRepoInspection`. `onboarding.fix.kind` enum 은 `OnboardingFixKind` 와 같다. `project.changed` 와 `DaemonStatus.projects` 가 새 `ProjectSummary` 를 나른다.

## 단계

각 단계는 `pnpm typecheck` 가 통과하는 지점에서 끝난다. 테스트는 마지막에 한 번 돈다.

### 0. 홈 폴더 · 본보기 디렉터리

- [ ] `environment.ts:17` → `".cds-design"`. `migrateHomeDir(home = homedir()): string | null`(순수: 옛 것만 → rename; 둘 다 → 경고 문장 반환). 호출은 `daemon.json` 읽기 **전** — `index.ts` main · doctor, 데스크톱 main 의 in-process 부트. `ProjectRegistry.load` 보다 앞
- [ ] 옮긴 뒤 등록부 클론마다 `trustWorkspace(repoRoot)`(`repo.ts:1518`) — `~/.claude.json` 항목이 경로별. `node_modules`(상대 심링크) · `.git/cds-design-install-hash` 는 같이 움직임. `.next` 캐시는 첫 미리보기가 한 번 다시 빌드
- [ ] 데스크톱: `preload.ts` 에 `openHome`, main 에 `desktop:open-home` → `shell.openPath(CDS_DESIGN_DIR)`
- [ ] `SettingsDialog.tsx:402-406` 문제 해결: `폴더 열기`(다리 있을 때) 또는 경로 텍스트 + 힌트 한 줄
- [ ] `connected-repo/` → `reference-repo/`: `.gitignore:6` · `ui-comments-e2e.mjs:2,7,12,15,68,108,437`. 워크플로 · `package.json` 에는 없음(확인함). 폴더를 GitHub 에서 `reference-repo/` 로 클론해 두고 `pnpm install`
- [ ] `README.md` 폴더 표 · 이주 단락 · 환경 변수 기본값 · `connected-repo/` 언급 · 패키지 표. `projects.ts:9-10, 43, 76, 355, 363, 412` 주석
- [ ] `test/home-dir.test.mjs`(`test:unit`): 옛 것만 · 새 것만 · 둘 다 · 심링크

### 1. protocol — `packages/protocol/src/index.ts`

- [ ] D33 전부. 헤더 주석: 게이트 넷 · 사이드바 한 단락(비활성 프로젝트 상태는 `project.changed` 로만). 버전 v9

### 2. daemon

- [x] `credentials.ts`: `loadRepoPat(store, env)`(두 인자 — `CDS_DESIGN_REPO_PAT` 환경 오버라이드를 테스트가 쓴다, `credentials.test.mjs:100-101`; 계획의 "한 인자" 는 폐기). `migrateProjectPats`(D8). `repoPatItem` 은 이관과 그 테스트(`credentials.test.mjs:106-127`)가 쓰니 export **유지**(계획의 "제거" 폐기)
- [x] `github.ts`: `whoAmI · listRepos · hasCdsDesign`. 남은 확인 하나: `archived` 필터가 매핑에 실제로 있는가(D26)
- [ ] `environment.ts`: `resolveNodeVersion(env): Promise<{ version: string; bundled: boolean } | null>` — `extraPathPrefix(CDS_DESIGN_EXTRA_PATH)` 를 PATH 로 `node --version`; `bundled` 는 찾은 실행 파일이 `CDS_DESIGN_EXTRA_PATH` 아래인지. `resolvePnpmExecutable()` 도 같은 PATH 규칙을 쓰는지 확인(지금 `~/Library/pnpm` 등 관습 경로도 본다 — 유지). `buildStatus` 의 pnpm 영어 경고 삭제(D6)
- [ ] `onboarding.ts`: `checkRuntime(deps)`(D5: node ≥ 22 파싱은 `major` 하나로; detail 에 버전 둘, 번들이면 "앱에 포함된"). `runOnboardingChecks` 순서 `claude, git, runtime, github`. fix: `install-pnpm` = `corepack enable`(같은 PATH 규칙, stdout/stderr 를 detail 로; 권한 실패는 명령을 그대로 보여줌). `install-node` 는 서버가 실행하지 않는다 — `href` 만. (`checkGitHub` · `hasToken` · `checkProject` 삭제는 끝남)
- [ ] `repo.ts`: `pendingChangeCount` · `phase` 게터. `refreshPendingChanges` 가 숫자를 **바꿨을 때만** `onPendingChanges`, `setPhase` 도 `onPhase`(신규 옵션). `requirePnpmIfReferenced` 는 그대로 — 게이트 뒤에 pnpm 을 지운 기계를 잡는 마지막 방어. (PAT 프로젝트별 제거는 끝남)
- [ ] `session-manager.ts`: `anyRunning(cwd): boolean`
- [ ] `server.ts`
  - 시작(`199-221`): 등록부 전 프로젝트 `workspacesFor(slug)` 생성 → 클론된 것 `refreshPendingChanges()`(D18). 활성만 `sync()`. (`migrateProjectPats` → `loadRepoPat` → `setPat` 은 끝남)
  - `onboarding.fix`(`817-826`): `install-pnpm` 추가. (`repo-install` · `onboarding.check` 의 repo 인자 제거는 끝남)
  - `projectSummaries()`(`365-372`): `phase · pendingChanges · handoff` + `manager.anyRunning(realpath(repoRoot))`. `announceProjects()` 200ms 스로틀(마지막 호출 뒤 한 번은 꼭). `workspacesFor` 옵션에 `onPendingChanges · onPhase → announceProjects`
  - `onState`(`172-187`): running ↔ 아님 → `announceProjects`; 다시 세기는 `workspaceOfSession(sessionId)?.refreshPendingChanges()`(D14)
  - `broadcastFor` 그대로 — `repo.status` 는 활성만
  - `activateProject` 에 `activating` 직렬화(D34). `project.remove`: 그 cwd 라이브 세션 `manager.closeWhere(cwd)` → `stop()` → 등록부 → `rmSync`(D21)
  - 첫 커밋: D14 만 따로(`server.ts:179` + `workspaceOfSession`) — `projects-e2e` 의 D14 회귀 케이스와 함께
- [ ] `index.ts` doctor: 게이트 4개 + 활성 프로젝트 `repo.status` 한 줄

### 3. web — 셸 · 사이드바 · 위저드 · 피커

- [ ] `daemon-client.ts`: `onboardingFix(kind)` 의 kind 타입 갱신, `763-764` 죽은 주석("repo-install clones and installs") 삭제. `ProjectSummary` 새 모양은 타입만. (`github*` · `repoPat` 제거는 끝남)
- [ ] `Onboarding.tsx`: `runtime` 카드 — detail 두 줄(node · pnpm 각각), fix 버튼 둘: `href` 있는 fix 는 `<a target="_blank" rel="noreferrer">`, 없는 fix 는 `onboardingFix` 버튼; 링크 fix 옆에 `다시 확인`(`onboardingCheck`). 머리글 `:81` "세 단계" → "네 단계". (접힘/펼침 · GitHub 카드 · `시작하기` · `project` 단계 삭제는 끝남)
- [x] `GitHubTokenForm.tsx` · `RepoPicker.tsx` · `AddProjectDialog.tsx`
- [ ] `RepoPicker.tsx`: 주소로 추가 경로에 GitHub 주소면 `inspect` 를 같이(D31 남은 것)
- [ ] `Sidebar.tsx`(신규): 목록 · 표식(D15) · 인라인 이름 바꾸기 · `···` 메뉴(기존 `.selector__menu` 패턴, `styles.css:738-801`) · 지우기 대화상자(D21) · `+ 새 프로젝트` → `AddProjectDialog` · 접기 · 드래그 경계(`PageWorkspace` 의 `Splitter` 를 `Splitter.tsx` 로 뽑고 `side: "left" | "right"`)
- [ ] `Shell.tsx`: `.planner` → `display: grid; grid-template-columns: <sidebar>px minmax(0, 1fr)`. 왼쪽 `Sidebar`, 오른쪽 열에 헤더 + 경고 + 기존 분기(`127-132` 빈 상태 인라인 피커 / `PageWorkspace`). `onboardingBlocked`(`56-57`) · `wizardNeeded`(`63-67`) 그대로. `ProjectSwitcher` import(`:5`) · 사용(`:90`) · 파일 삭제 — `AddProjectDialog` 열기(`144-149`)는 `Sidebar` 의 `+ 새 프로젝트` 가 잇는다. 헤더 이름 = 활성 프로젝트, 0개면 `CDS Design`
- [ ] `settings.ts`: `LayoutSettings.sidebarWidth · sidebarCollapsed`, `SIDEBAR_WIDTH_BOUNDS = { min: 200, max: 360 }`, `loadLayout` 클램프
- [ ] `SettingsDialog.tsx:402-410` 문제 해결에 `폴더 열기`(0단계). (GitHub 그룹 `334-364` 는 끝남)
- [ ] `useSessions.ts:176-185` · `ScreenPanel.tsx` · `PageWorkspace.tsx`: 불변이 목표
- [ ] `styles.css`: `.onboarding__line`, `.onboarding__fixes`, `.repopicker*`, `.ghlink`, `.planner__empty`, `.sidebar`, `.sidebar__brand/list/row(--active)/name/badge(--progress|--working|--handoff|--merged|--changes)/menu/new`, `.sidebar--collapsed`, `@media (max-width: 1100px)`. 기존 토큰만(`--panel · --line · --muted · --text · --accent · --warn-line · --r-md · --r-lg · --mono`)

### 4. 테스트

수정:
- [ ] daemon: `onboarding.test.mjs`(`79-83` 의 셋 고정 → 넷; **runtime 게이트**: 스텁 PATH 에 가짜 `node` 가 `v22.12.0` · `v20.11.0` · 없음, 가짜 `pnpm` 있음/없음 → pass/fail 과 detail 문구, `CDS_DESIGN_EXTRA_PATH` 아래 node 면 "앱에 포함된"; `install-pnpm` fix 가 `corepack enable` 을 부르고 실패 stderr 가 detail 에 남음), `onboarding-e2e.mjs`(네 게이트; 프로젝트 0개에서 `onboarding.check` 가 넷을 돌려줌), `projects-e2e.mjs`(`project.changed` 페이로드; 비활성 프로젝트 클론에 파일 쓰고 스텁 턴 종료 → **그 프로젝트의** `pendingChanges`(D14 회귀); 재시작 뒤 `hello.status.projects[*].pendingChanges` 유지(D18)). (`github.test.mjs` · `credentials.test.mjs` · fixtures 는 끝남)
- [ ] web: `ui-onboarding-e2e.mjs`(네 줄 위저드 — 스텁 PATH 의 node/pnpm 으로 3 pass; `203-209` 의 `.project .selector__chip` → `.sidebar__new`; 만들기 뒤 사이드바 행 `내려받는 중…`), `ui-planner-e2e.mjs:218`("개발자 크롬 없음" 단언의 목록을 다시 정한다 — `.sidebar` 를 빼는 게 아니라 지키려던 것(모드 스위치 · 화면 레일 · 헤더 액션)을 이름으로; 사이드바는 기획자 크롬), `ui-settings-e2e.mjs`(폴더 열기 텍스트). `ui-publish-e2e.mjs` 는 `.selector.project` 를 안 쓴다(확인함) — 수정 없음. `projects-e2e.mjs` 에 D34(동시 `project.activate` 둘 → 마지막 것이 활성, 포트 하나만 열림) · D21(라이브 세션 있는 프로젝트 지우기 → 세션 `closed`, 폴더 없음)
- [ ] `test:desktop-smoke`: 패키징된 앱의 `onboarding.check` 에서 `runtime` 이 pass 이고 detail 이 "앱에 포함된" 으로 시작한다 — 번들 누락 빌드를 CI 가 잡는다
- [x] `fixtures/github/fixtures.json`

신규:
- [ ] `test/home-dir.test.mjs`(0단계)
- [ ] `ui-sidebar-e2e.mjs`(포트 5402): 프로젝트 둘 → 행 둘 · 활성 표시 → 비활성 클릭 → 헤더 · 채팅 즉시, 미리보기 `starting → ready`, 앞 포트 닫힘 → 비활성에서 스텁 턴 → `작업 중` → 끝나면 `변경 N` → 이름 바꾸기 → 지우기 두 버튼 → 960 폭 접힘

### 5. 문서

- [ ] `README.md`: 온보딩 문단(게이트 넷 · 프로젝트는 작업 화면에서), 요구 사항 문단("Node 22 + pnpm" 은 데스크톱에선 포함, 브라우저 개발 경로에선 게이트가 검사), 프로젝트 단락에 사이드바 · 비활성 세션은 계속 돈다, 폴더 표 `~/.cds-design`, `reference-repo/`, 테스트 표(`test:sidebar-ui`), 설정 항목, 프로토콜 v9
- [ ] 이 문서는 6단계까지 끝난 뒤 지운다

### 6. 검증

- [ ] `pnpm typecheck`
- [ ] `pnpm test:unit` · `test:onboard-unit` · `test:projects` · `test:repo` · `test:publish` · `test:onboarding`
- [ ] `pnpm --filter @cds-design/web build` 후 `test:onboarding-ui` · `test:settings` · `test:publish-ui` · `test:comments-ui` · `test:sidebar-ui`
- [ ] `node packages/desktop/scripts/bundle-runtimes.mjs && pnpm --filter @cds-design/desktop pack` 후 `test:desktop-smoke` — `runtime` pass "앱에 포함된"
- [ ] 0단계: `~/cds-design` 있는 개발 기계에서 실행 → `~/.cds-design` 으로 옮겨지고 목록 · 클론 · 미리보기가 산다. `폴더 열기` 가 Finder 를 연다. `test:comments-ui` 가 `reference-repo/` 로 돈다
- [ ] 실제로(브라우저 개발 경로, PATH 에서 pnpm 을 잠깐 뺀 채): 위저드 3 이 fail → `pnpm 설치` → pass. 빈 머신 → 토큰 연결 → `시작하기` → 빈 화면 목록에서 선택 → 만들기 → 진행 → `ready` → A 에서 Claude 에게 화면 시키고 `+ 새 프로젝트` 로 B → `lsof -i :<A 포트>` 비어 있음 · B 포트 열림 → A 행 `작업 중` → 끝나면 `변경 N` + OS 알림 → A 클릭 → 서버 다시 뜨고 코멘트 핀 → 저장 · 넘기기 · 반영됨 표식. `처음 설정 다시 보기` 에서 1·2·3·4 접힘 + `시작하기`. 1280 · 960 폭

## 열어둔 것

- **레포 안에서 작업 여럿(worktree · 독립 PR).** 지금 모델의 두 약점이 실제 불평이 되면 연다: (1) 넘긴 뒤의 저장이 같은 PR 에 쌓인다, (2) A 화면의 `check` 실패가 B 저장을 막는다. 열 때의 규칙: 작업은 "따로 넘길 묶음"이고, 기획자가 "새 작업"을 누르는 게 아니라 `넘김` 상태에서 새 기획서를 붙일 때 도구가 "따로 넘길까요 / 함께 넘길까요"를 한 번 묻는다. 기계는 worktree(설치 표식 gitdir · stash 메시지 id · 로컬 브랜치 검사 · 반영 뒤 detach · fetch 뮤텍스). `ProjectSummary` 아래 `workspaces[]` 가 붙는 모양이라 선로를 다시 쓰지 않는다
- 포트가 다른 레포 둘의 서버를 동시에 살려두기. "보이는 것만 켜져 있다" 하나가 지금은 더 값지다
- 사이드바 행의 `+줄 −줄`. 스테퍼가 파일 수를 쓰는 동안은 같은 숫자
- 다중 GitHub 계정(개인 + 회사, GHES). 지금은 주소로 추가(D31)가 우회로
- 목록에서 `cds-design.json` 을 미리 배지로(N 요청)는 하지 않는다(D27). 이름으로 못 알아보는 문제가 실제로 나오면 보이는 행만 지연 프로빙
- Node 자동 설치(nvm · fnm · 패키지 매니저). 관리자 권한과 셸 설정을 건드리는 일이라 링크로 둔다. 데스크톱은 번들이라 해당 없음

## 감사에서 나온 제안 — 보류 (필요가 실제로 나올 때)

채택한 것은 결정표로 올라갔다: D14(버그 선행) · D21(세션 닫기) · D34(전환 직렬화) · D33(범프 시점) · D26(`archived` 확인) · 4단계(`ui-planner-e2e` 단언 재정의) · 5단계(README 요구 사항).

- **토큰 만료 사전 알림.** 시작 시 `checkGitHub` 가 돈다 — 401 이면 헤더 힌트 한 줄. 넘기기 실패 지점에 이미 한국어 이유가 뜬다. fine-grained 30일 만료 불평이 오면
- **`⌘1…⌘9`** 로 n번째 프로젝트. 프로젝트 셋 미만인 기획자가 대부분
- **doctor 에 프로젝트별 한 줄.** D18 뒤에 쉽다. 개발자 도구라 급하지 않음
- **CI 가 `reference-repo/` 를 클론.** 폴더 사라진 건 이 트리의 사고. CI 에서 `test:comments-ui` 가 실제로 깨질 때
- **모든 fail 카드에 `다시 확인`.** `runtime` 카드엔 있다. Claude · git 카드는 fix 버튼이 곧 재검사
