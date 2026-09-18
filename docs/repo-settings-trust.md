# 연결 레포 설정 신뢰 — 운영 결정 기록 (2026-09-18)

## 결정

연결 레포는 사내 전용이고 개발자가 사전에 구성한 것이므로, **운영자는 연결 레포가 싣는 에이전트 설정을 신뢰한다.** 레포가 실어 보내는 훅·플러그인·프로젝트 MCP 중 아래 "열어둔 벡터"는 의도적으로 차단하지 않는다.

## 이미 배포된 절단 (유지)

`sanitizeRepoAgentSettings`(`packages/daemon/src/claude-trust.ts`)는 클론·갱신·기동·세션 시작마다 프로젝트 설정의 권한 확장 키를 잘라내고 원본을 `~/.colo-design/config/settings-quarantine/` 에 0600 으로 보관한다. 잘라낸 내역은 헤더 경고로 호명된다.

- claude: `permissions.allow` · `hooks` · `env`
- omp: `tools.approval` allow 항목 · `approvalMode: write|yolo` · `bash.patterns` allow 항목 · `bash.allowCompoundCommands` · `extensions`
- opencode: `permission` allow · 로컬 `mcp` · `plugin`

축소 규칙(deny · ask · prompt)은 살린다. Codex 는 정책이 턴 파라미터라 해당 없음.

## 의도적으로 열어둔 벡터

| 벡터 | 무엇이 일어나는가 |
| --- | --- |
| omp `.omp/hooks/pre\|post/*.ts`, `.omp/extensions/` | 세션 시작 시 레포가 싣은 코드 적재 |
| omp 프로젝트 MCP(`mcp.enableProjectConfig` 기본 ON) | `.omp/mcp.json`·`mcp.json`·`.mcp.json` 과 번역 소스(프로젝트 `.codex/config.toml` 등)의 stdio 서버 — 시작 시 명령 스폰 |
| opencode `.opencode/plugin/*.ts` | 세션 시작 시 레포가 싣은 코드 적재 |
| opencode `opencode.json` 의 `lsp`·`formatter` command | lsp 는 시작 시 스폰, formatter 는 편집 뒤 실행 |
| claude `.claude/hooks/` 프로젝트 디렉터리, `.mcp.json` | 훅 스크립트·MCP 서버. 닫는 스위치가 있으나(`managedSettings.strictPluginOnlyCustomization`) 일부러 쓰지 않음 |
| omp `bash.direnv` | 실제 direnv 바이너리의 allow 게이트에 의존. 기계에 direnv 가 없으면 비활성 |

## 이 결정이 깨지는 조건 (재검 트리거)

- 외부 레포(오픈소스·고객 제공·에이전트 자율 클론)를 연결하는 기능이 생길 때
- 클론을 일반 사용자 기기에서 여는 흐름이 기본이 될 때
- 레포 계정 침해 사고 등으로 사내 레포 신뢰 전제가 흔들릴 때

다시 차단하려면: claude 는 `managedSettings.strictPluginOnlyCustomization: ["hooks", "mcp"]` 한 줄, omp 프로젝트 MCP 는 `omp acp` 런치에 `mcp.enableProjectConfig: false` 오버레이(문서상 acp 가 `--config` 지원), 디렉터리 코드 적재는 파일 통째 검역 메커니즘이 필요(2026-09-18 분석 — 키 절단과 달리 정당한 훅을 깨뜨리므로 레포별 옵트인 UX 를 함께 설계할 것).
