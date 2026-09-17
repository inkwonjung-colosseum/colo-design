# 코딩 에이전트 프로바이더 기능 조사 — Colo Design 파쿠리 후보 보고서

> 작성일: 2026-09-17 · 조사 방법: 40개 프로바이더를 10개 병렬 리서치로 분해, 각자 공식 사이트/문서/GitHub/릴리즈 노트 1차 자료 기반 웹 리서치 후 종합
> 목적: 각 프로바이더(코딩 에이전트 CLI)가 제공하는 기능 중 **Colo Design에 이식할 가치가 있는 것** 도출
> 대상 제품 전제: 비개발자 대상 화면 제작 채팅 도구 — 레포 연결, 말·그림 입력, 라이브 미리보기 검증, 저장→PR 핸드오프. 현재 하니스는 Claude Code CLI 고정(사용자별 자기 구독, README 정책 섹션), 한국어 제품.
> 선행 문서: `docs/agent-orchestration-competitive-report.md`(2026-09-15) — 오케스트레이션 **제품** 45개 조사. 이 문서는 **프로바이더 CLI 개별 기능**이 대상이라 보완재다. 오케스트레이션 레벨 기능(인박스·태스크 보드·레이스 모드 등)은 선행 문서 §6 참조.

---

## 0. TL;DR — 파쿠리 Top 10

수렴 신호(서로 다른 벤더가 같은 기능으로 수렴)를 우선 신뢰했고, 비개발자 가이드형 제품에 맞지 않는 것(오케스트레이션·클라우드·마켓)은 도메인 불문 탈락시켰다.

| # | 후보 | 출처 | 왜 우리 제품인가 | 난이도 |
|---|---|---|---|---|
| 1 | **rewind 분리: "파일만 / 대화만 / 둘 다" 3모드 복원 + 쓰기 자동 스냅샷** | Kiro(checkpoint vs rewind 분리), Cline(섀도우 git, 툴 콜 단위 3모드), Gemini CLI(/restore), Poolside(VCS 독립 체크포인트), Stakpak(모든 수정 자동 백업) | 기존 rewind는 요청 단위·파일 전용. "말이 잘못됐나 결과물이 잘못됐나"의 구분은 비개발자에게 가장 직관적 안전망 | 중 |
| 2 | **Plan 카드 진화 — 편집 가능 + 실행 중 라이브 진행 목록** | Junie(계획=편집 가능한 구조화 문서), Grok Build(승인 전 코멘트/재작성), Cline Focus Chain(할 일 목록 상시 재주입), DeepAgents(write_todos 라이브 추적), Gemini CLI(planning artifacts 파일 저장) | Plan 승인 모드는 이미 있음. 읽기 전용 확인 → 사용자가 고치고 승인 + "지금 3번째 하는 중" 가시화로 확장이 가장 저비용 고체감 | 하~중 |
| 3 | **권한 승인 피로 해소 — 카테고리 프리셋 + "앞으로 자동 승인" 규칙 + 일괄 승인** | Codex(rules로 명령 자동 상승), Cline(편집/터미널/브라우저 카테고리별 auto-approve), Stakpak(일괄 승인), Qwen(approvalMode 상속), Nova(3단계) | 승인 반복은 비개발자 이탈 1순위. "미리보기 갱신은 자동, 커밋은 수동" 프리셋 + 세션 규칙만으로 체감 급변 | 하 |
| 4 | **완료 보고 — Task Report 카드 + 검증 스크린샷/녹화를 PR에 첨부** | Qoder(Task Report), Cursor(클라우드 에이전트가 영상/스크린샷/로그를 PR에), Claude Code(/verify, artifacts), MiniMax(검증 전담 에이전트) | screen-gate(턴 끝 화면 재확인)가 이미 있음 — 그 결과물을 한국어 요약 카드 + PR 첨부물로 승격하면 핸드오프 신뢰가 즉시 오름 | 중 |
| 5 | **기억 카드 — 자동 메모리 + 사용자 큐레이션 UI** | Claude Code(auto memory + /memory), Auggie(Memories + Memory Review), Devin(Knowledge), Autohand(`#` 한 줄 저장), omp(learn/reflect) | 브랜드 컬러·컴포넌트 취향을 에이전트가 학습하되, 사용자가 카드로 검토/삭제 가능해야 신뢰. 컨벤션 기능의 UX 완성형 | 중 |
| 6 | **음성 받아쓰기** | Claude Code(20개 언어, 한국어 지원, 토큰 미소비), TRAE(음성 입력) | "말·그림·문서로 화면을 만든다"는 정체성과 정확히 일치. 하니스 내장 기능이라 노출 비용 최저 | 하 |
| 7 | **세션 이어하기 — Handoff 요약 카드 + 목표 단위 재개** | Amp(Handoff: 상태 스냅샷을 검토·수정 가능한 카드로), Auggie(session resume), Autohand/Dirac(/goal resume), VT Code(resumable handoffs) | "어제 하던 그 화면 이어서" — 크래시 복구·rewind의 자연 확장. 사용자가 이어갈 내용을 카드로 확인하는 점이 비개발자에게 맞음 | 하~중 |
| 8 | **레포 컨텍스트 투명성 — "이 앱은 이렇게 생겼어요" + 작업 전 "내가 아는 것" 칩** | Qoder(Repo Wiki 자동 문서), Grok Build(inspect: 프롬프트 전 감지 설정 표시), Mistral Vibe(프로젝트 자동 스캔) | 비개발자 신뢰 구축: 도구가 레포에서 뭘 이해했는지 작업 전에 보여주기. 화면·라우트 중심 요약이면 차별화 | 하 |
| 9 | **세션 공유 링크(보기 전용)** | OpenCode(/share, 3모드), omp(/collab, 읽기전용 view) | 기획자가 만든 화면을 디자이너·개발자에게 링크로 — 코멘트 핀 루프와 결합 시 협업 축 확장 | 중 |
| 10 | **스킬/레시피 — 잘된 세션을 재사용 카드로 저장** | goose(Recipes), Codex(Skills UI+팀 공유), Grok(/skillify), Droid(/create-skill) | "설정 화면 만들기" 같은 반복 작업의 원클릭 재사용. 레포 단위 공유면 팀 자산이 됨 | 중 |

**전략 과제(별도 판단 필요)**: 멀티프로바이더 추상화(ACP/롤 라우팅), 모바일 승인 컴패니언, best-of-N 화면안, 시크릿 대체, plan/실행 모델 분리 — §2.10·§3 참조.

**파쿠리 비권장**: 멀티에이전트 오케스트레이션 전반(태스크 보드·에이전트 간 메시징·worktree 병렬 — 단일 사용자 가이드형 제품의 복잡도 예산 낭비), 클라우드 VM/orbs, cron·웹훅 자동화, 마켓플레이스·USDC 정산(Agora), 온디바이스 추론(장기 관찰 과제), self-evolving(Autohand), mission mode(Droid).

---

## 1. 조사 대상 40개 한눈표

| 프로바이더 | 벤더 | 정체(1줄) | 가장 주목할 기능 | 파쿠리 판정 |
|---|---|---|---|---|
| Claude Code | Anthropic | 우리가 쓰는 하니스(CLI+Desktop+모바일) | auto memory, /verify 스킬, voice dictation, Remote Control, /usage·/insights | **미노출 내장 기능이 최우선 광산** |
| Codex | OpenAI | CLI+데스크톱 앱, ChatGPT 구독 | 샌드박스 기본값+rules, Skills UI, /personality | 권한 규칙, 톤 선택 |
| Gemini CLI | Google | 오픈소스 CLI(소비자용은 Antigravity CLI로 이관 중) | checkpoint/rewind/restore, planning artifacts | rewind 고도화 |
| Qwen Code | Alibaba | gemini-cli 포크, 문서 충실 | ACP로 claude-code/codex를 서브에이전트 위임, 권한 모드 상속 | 멀티프로바이더 선례 |
| OpenCode | Anomaly | 로컬 서버 하나에 TUI/데스크톱/웹 | 세션 공유 링크, doom_loop 감지, Scout 읽기전용 에이전트 | 공유 링크, 자가수리 |
| Pi | Mario Zechner | 미니멀 하니스(확장으로 조립) | project trust 게이트, 트리 세션/fork, steering vs follow-up 큐 | 신뢰 게이트, 2단 큐 |
| Oh My Pi | Can Bölük | Pi 포크 풀 하니스(현재 세션의 기반) | 9롤 모델 라우팅, Advisor, stream rules, /collab, 8종 설정 상속 | 아키텍처 레퍼런스 |
| Cursor | Anysphere | IDE+CLI+클라우드 에이전트 | **PR에 영상/스크린샷/로그 첨부**, Multi-Agent Judging | 검증 증거물 첨부 |
| Devin CLI | Cognition | Rust 터미널 클라이언트+클라우드 | Playbooks, Knowledge, Session Insights | 반복 템플릿, 회고 |
| Factory Droid | Factory | droid CLI | Spec Mode→계획을 `.factory/docs`에 저장, autonomy 4단계 | 계획 산출물 저장 |
| Amp | Amp(Sourcegraph 분사) | 클라우드 에이전트 플랫폼 | **Handoff(검토 가능한 상태 스냅샷)**, Puck 코디네이터 | 세션 이어하기 |
| goose | Block→AAIF | 오픈소스 로컬 에이전트 | Recipes(YAML 워크플로), 구조화 failed 결과 계약 | 재사용 레시피 |
| Grok Build | xAI | 터미널 에이전트(베타) | **inspect(프롬프트 전 컨텍스트 표시)**, 편집 가능 Plan | 컨텍스트 투명성 |
| Mistral Vibe | Mistral | 통합 에이전트 CLI | `@` 이미지 참조, config.toml 권한 | 입력 문법 참고 |
| Cline | Cline Bot | VS Code+CLI 오픈소스 | **Focus Chain**, 섀도우 git 체크포인트 3모드, auto-approve 카테고리 | 다수(P0 3개 관여) |
| Kilo | Kilo Code | OpenCode 서버 위 재건 | 포터블 코어(IDE·CLI 같은 엔진), 500+ 모델 | 아키텍처 참고 |
| Auggie | Augment | 컨텍스트 엔진 CLI | **Memories + Memory Review(큐레이션)**, 레포 자동 인덱싱 | 기억 카드 |
| Junie | JetBrains | IDE+CLI+웹 | **Plan=편집 가능한 구조화 문서**, plan/구현 모델 분리, guidelines.md | Plan 카드, 규칙 파일 |
| Kiro CLI | AWS | spec-driven 서비스 | **checkpoint vs rewind 의미 분리**, steering, 자연어 훅 | rewind 분리 |
| Qoder | Alibaba | IDE+CLI 플랫폼 | **Task Report**, Repo Wiki, Action Flow | 완료 보고, 레포 소개 |
| TRAE CLI | ByteDance | IDE+오픈소스 CLI | 음성 입력, trajectory 파일(실행 궤적) | 음성, 핸드오프 감사 |
| MiniMax Code | MiniMax | 데스크톱 에이전트 앱 | **모바일 원격 권한 승인**, 검증 전담 에이전트 | 모바일 승인(P2) |
| Kimi Code CLI | Moonshot | 오픈소스 TS CLI | **비디오 입력**, Agent SDK(하니스 임베드) | 영상 입력, SDK 선례 |
| CodeBuddy Code | Tencent | CLI+IDE | Plan 중 중단·방향 수정, ACP+SDK | 미드턴 큐 참고 |
| CodeWhale | 커뮤니티(구 DeepSeek TUI) | Rust TUI | 사이드 git 스냅샷+ /restore, HTTP/SSE 런타임 API | rewind 경량 패턴 |
| Cortex Code | Snowflake | 데이터 특화 CLI | **플랫폼 인지**(스키마·권한 이해), 단일 매니페스트 플러그인 | 레포+미리보기 상태 인지 |
| Poolside | Poolside | 코드 전용 모델+pool CLI | **VCS 독립 체크포인트**, 리소스별 철회 가능 권한 | rewind 아키텍처 |
| Nova | Compass | CLI+데스크톱+웹 | 3단계 승인, 실시간 비용 통계 | 승인 프리셋, 비용 칩 |
| fast-agent | evalstate | MCP 네이티브 프레임워크 | evaluator-optimizer 루프, OAuth paste-URL 폴백 | 검증 루프, 온보딩 |
| DeepAgents | LangChain | batteries-included 하니스 | write_todos 라이브 계획, 파일시스템 작업 메모리, 미들웨어 구조 | 진행 목록, 압축 타이밍 |
| Stakpak | Stakpak | DevOps 에이전트 | **시크릿 대체(키를 쓰되 못 봄)**, 일괄 승인, 알림 channel/target 분리 | 보안 신뢰, 승인 UX |
| crow-cli | crow | 미니멀 ACP 에이전트 | 두뇌/손 분리(에이전트+MCP 서버), sqlite FTS5 세션 검색 | 세션 전문검색 |
| Corust | Corust.ai | Rust 특화 에이전트 | 도메인 특화 포지셔닝 자체 | 전략 참고만 |
| VT Code | vinhnx | Rust TUI 하니스 | 프로바이더 자동 페일오버+지출 상한, tree-sitter 명령 검증, done 전 검증 | 멀티프로바이더 시대 준비 |
| Dirac | dirac-run | 토큰 효율 특화 | /goal(지속 목표), 해시 앵커 편집, AST 아웃라인 | 목표 객체, 비용 절감 |
| DimCode | arcships | 멀티모델 CLI+SDK | steer notification, MCP 2계층 오버라이드 | 설정 계층 참고 |
| Minion Code | femto | Claude Code 재구현체 | (차별점 적음) | 탈락 |
| siGit Code | getsigit | 로컬퍼스트+온디바이스 | 온디바이스 기본 추론, 폰에서 데몬 구동 | 장기 관찰 |
| Autohand Code | autohandai | self-evolving 표방 | **Persistent goal + /goal resume**, `#` 한 줄 메모리 | 목표 재개, 규칙 메모 |
| Agora | Agoragentic | B2A 마켓플레이스(USDC) | 자동 probe 신뢰 등급, trust·price·latency 스코어링, 영수증 | 라우팅 기준, 비용 영수증 |

---

## 2. 기능 도메인별 종합 — 수렴 패턴과 판정

### 2.1 승인 게이트와 권한 (가장 넓은 수렴)
- 계획 승인 자체는 업계 표준(Colo 보유). 경쟁의 초점은 **승인 피로 해소**로 이동: Codex rules("이 명령은 앞으로 자동"), Cline 카테고리별 auto-approve + 항상 ON 기본화, Stakpak 일괄 승인, Antigravity(선행 문서)의 "수동 승인이 프로젝트에 학습" 패턴.
- Plan 모드의 실질은 "읽기 전용 보장"(Cline: Plan 중 쓰기 원천 차단, Qwen: plan 권한 상속) — UI 토글이 아니라 하니스 레벨 강제여야 한다.
- **판정**: P0. 권한 프리셋 2~3개(안전/보통/빠름) + 세션 규칙 + 일괄 승인.

### 2.2 안전망: 체크포인트·되돌리기 (5개사 독립 수렴)
- 스펙트럼: 파일만(Gemini /restore) → 파일+대화 분리 선택(Cline 3모드, Kiro 개념 분리) → VCS와 독립된 세이브 포인트(Poolside) → 모든 쓰기 자동 백업(Stakpak).
- Kiro의 대비가 명확: checkpoint=파일 스냅샷, rewind=대화만 포크(파일 불변). "코드는 괜찮은데 대화가 잘못 간" 케이스가 실재한다.
- **판정**: P0. 요청 단위 rewind를 턴/액션 단위로 세분화 + 3모드 복원. 구현은 섀도우 git(Cline 방식)이 우리 브랜치 모델과 잘 맞음.

### 2.3 검증 루프 (우리 screen-gate의 다음 단계)
- 검증을 "증거물"로 남기는 것이 표준: Cursor가 PR에 영상/스크린샷/로그, Claude Code /verify(실제 앱으로 검증), Qoder Task Report(무엇을 왜 바꿨고 어떻게 검증했는지), MiniMax 검증 전담 에이전트, VT Code done 전 검증 게이트, fast-agent evaluator-optimizer.
- **판정**: P0(보고 카드)·P1(독립 검증 패스). screen-gate의 판정 결과를 한국어 Task Report 카드로 + 저장/넘기기 시 미리보기 스크린샷·녹화 자동 첨부. 개발자 입장에서 "비개발자가 만든 화면의 검증 증거"는 PR 리뷰 비용을 직접 깎는다.

### 2.4 진행 가시화
- Cline Focus Chain(번호 목록 상시 재주입·갱신), DeepAgents write_todos, Qoder Action Flow(단계별 트레이스), Maestro 동적 타이틀(선행 문서).
- **판정**: Plan 카드와 통합 — 승인 시 만들 것 목록이 그대로 라이브 진행 표시기가 되는 흐름.

### 2.5 메모리·컨벤션
- 자동 학습: Claude auto memory(type 분류 MEMORY.md), Devin Knowledge(자동 회수), Auggie Memories.
- 명시 규칙: Kiro steering, Junie guidelines.md, Stakpak Rule Books, Autohand `#`, omp가 8종 레거시 설정(.claude/.cursor/…)을 읽는 상속 패턴.
- 결정적 차이는 **큐레이션 UI**: Auggie Memory Review(챗에서 검토·편집·삭제). 자동 메모리는 사용자가 못 보면 신뢰가 아니라 불안이 된다.
- **판정**: P0~P1. 기억 카드(검토/삭제 가능) + `#` 즉시 규칙 저장 + 레포 규칙 파일(`.colo/` 계열) 자동 생성.

### 2.6 재사용: 스킬·레시피
- goose Recipes(YAML, Block 내부 60% 사용), Codex Skills(생성 UI+팀 공유+큐레이션: Figma→코드 등), Grok /skillify(세션→스킬 캡처), Droid /create-skill, crow SKILL.md.
- 공통 형태: "잘 된 세션을 마치면 그 절차를 저장해 다음에 원클릭".
- **판정**: P1. 비개발자에게는 "이 화면 패턴 자주 쓰기" 카드로 노출, 내부는 Claude Code Agent Skills로 실현 가능.

### 2.7 세션 수명: 재개·핸드오프·공유
- 재개: Amp Handoff(구조화 스냅샷→사용자가 카드로 검토 후 새 세션), Auggie/Kiro(디렉토리 기반 재개), Autohand/Dirac(/goal resume — 대화를 넘어 사는 목표 파일), VT resumable handoffs, crow sqlite+FTS5(과거 세션 전문검색).
- 공유: OpenCode /share(공개 URL 3모드), omp /collab(읽기전용 view·키 봉인), Pi /export·/share.
- **판정**: 재개 P0(기존 크래시 복구 위 확장), 공유 링크 P1(기획자↔디자이너 협업 축).

### 2.8 입력: 음성·이미지·영상
- 음성: Claude voice dictation(한국어 포함 20개 언어, hold/tap, 토큰 미소비) — 사실상 공짜. TRAE도 음성.
- 영상: Kimi 비디오 입력(화면 녹화를 그대로 첨부) — "이 데모 영상처럼"은 말·그림 입력 축의 자연 확장. 모델 멀티모달 지원 전제.
- **판정**: 음성 P0, 영상 P2.

### 2.9 비용·사용량 투명성
- Claude /usage·/insights(캐시 적중률, 스킬별 attribution, 세션 패턴 리포트), Nova 실시간 비용 통계, Agora 영수증 UX, VT 지출 상한.
- 모델 배분으로 비용 절감: goose lead-worker, Junie plan(프론티어)/구현(저가) 분리, omp 9롤 라우팅.
- **판정**: P1. 자기 구독 제품이므로 "이번 달 얼마나 썼는지 칩" + 큰 작업 전 effort 표시. 모델 분리는 하니스 노출 레벨 과제라 P2.

### 2.10 멀티프로바이더 아키텍처 (전략 과제)
- 살아있는 선례들: **Qwen Code가 ACP 어댑터로 claude-code/codex를 서브에이전트로 위임**(executor 교체형), Kimi Agent SDK(하니스를 앱에 임베드), Kilo 포터블 코어, omp 롤 라우팅+폴백 체인, models.dev 레지스트리, VT 자동 페일오버+지출 상한, ACP 자체(crow·CodeBuddy·Cortex·Poolside·Grok·Kimi·Corust·siGit 등이 채택 — 사실상 표준).
- **판정**: 지금 당장 아니고, ToS·제품 단순성("한 사람, 한 구독")과의 트레이드오프를 명시한 전략 결정. 단, 데몬의 에이전트 인터페이스를 설계할 때부터 "하니스 스왑 가능" 경계(ACP 또는 자체 executor 추상화)를 유지하는 비용은 지금近乎 0 — README 정책 섹션과 함께 결정 문서화 권장.

### 2.11 파쿠리 비권장 목록
- 멀티에이전트 오케스트레이션(태스크 보드, 에이전트 간 메시징, worktree 병렬, mission mode, 원격 서브에이전트) — 단일 사용자 가이드 흐름을 깬다. 예외적으로 "화면안 A/B 병렬+자동 추천"(Cursor Judging)은 선택지 UI로 번역하면 P2 후보.
- 클라우드 VM/orbs, 이벤트 드리븐 기동, cron/웹훅 자동화 — 비개발자 페르소나와 불일치. "매주 스크린샷 회귀 체크"(MiniMax Scheduled Tasks) 정도만 원격 승인과 함께 재평가.
- 마켓플레이스·USDC 정산(Agora) — 무관. 단 자동 probe 신뢰 등급과 영수증은 아이디어만 차용.
- 온디바이스 추론(siGit), self-evolving(Autohand) — 장기 관찰.

---

## 3. 우선순위 로드맵 제안

### P0 — 기존 기능 위에 얹는 것 (하~중 난이도, 체감 즉시)
1. rewind 3모드 분리 + 쓰기 자동 스냅샷 (Kiro/Cline/Gemini/Poolside)
2. Plan 카드: 편집 가능 → 승인 후 라이브 진행 목록 (Junie/Cline/DeepAgents)
3. 권한 프리셋 + "앞으로 자동 승인" + 일괄 승인 (Codex/Cline/Stakpak)
4. 턴 완료 Task Report 카드 + 넘기기 시 검증 스크린샷/녹화 PR 첨부 (Qoder/Cursor)
5. 음성 받아쓰기 (Claude 내장, 한국어)
6. 레포 소개 문서 + 작업 전 "내가 아는 것" 칩 (Qoder Wiki/Grok inspect)
7. `#` 규칙 메모 → 기억 카드 큐레이션 (Autohand/Auggie/Claude auto memory)
8. 세션 이어하기 요약 카드 (Amp Handoff/Auggie resume)

### P1 — 차별화 (중 난이도)
9. 세션 공유 링크(보기 전용) — 핀 루프와 결합 (OpenCode/omp)
10. 화면 패턴 재사용 카드(스킬) — 세션 캡처형 (goose/Codex/Grok)
11. 완료·승인 요청 알림 라우팅(채널/대상 분리) (Stakpak/MiniMax)
12. 시크릿 대체 + 명령 "이게 뭐 하는 거예요?" 설명 (Stakpak/VT)
13. 사용량 칩 + 큰 작업 effort 표시 (Claude /usage/Nova)
14. doom_loop 감지·자가수리 + stream rule형 컨벤션 위반 시점 주입 (OpenCode/omp)

### P2/전략 — 구조 결정 수반 (상 난이도)
15. 모바일 승인 컴패니언 — 권한·Plan 승인을 폰에서 (Claude Remote Control/MiniMax/siGit)
16. 멀티프로바이더 추상화 — ACP/executor 경계, 롤 라우팅, 페일오버 (Qwen/Kimi/Kilo/omp/VT) — ToS·단순성 트레이드오프 명시 후
17. best-of-N 화면안(2~3안 병렬→자동 추천→선택) (Cursor Judging/Chorus UX)
18. 영상 입력, plan/실행 모델 분리, 온디바이스 폴백 (Kimi/Junie/siGit)

---

## 4. 프로바이더별 상세 (요약 인벤토리)

### Claude Code (Anthropic) — 신뢰도 상 (code.claude.com 문서)
우리 하니스이므로 "이미 제공하는데 UI로 안 노출한 것"이 1차 광산. auto memory(MEMORY.md 인덱스+토픽 파일, /memory), Agent Skills(/run·/verify·/doctor 번들, context: fork 격리), checkpointing+Summarize from/up to here, effort 슬라이더, /usage·/insights(사용량 바·스킬별 attribution·세션 패턴 리포트), Remote Control(QR로 폰 이어보기·푸시 승인·Trusted Devices), voice dictation(한국어, 토큰 무소비), /goal(완료까지 자율+백오프), hooks, channels(MCP가 세션에 push), Advisor(제2모델 자문), auto mode(안전 분류기), computer use, routines, artifacts, deep links, plugins. → P0 5·6·7·8, P1 13의 직접 재료.

### Codex (OpenAI) — 상
시스템 샌드박싱 기본값+rules 자동 상승, Skills 앱 UI+팀 공유(Figma→코드 큐레이션), Automations→리뷰 큐, /personality(톤만 교체), 워크트리 스레드. → 권한 규칙(P0-3), 톤 선택(P1 후보).

### Gemini CLI (Google) — 상 (전환기: 소비자용은 Antigravity CLI로)
checkpoint/rewind/restore, Plan mode+planning artifacts(계획이 파일로), Extensions 번들, policy engine. → rewind 고도화(P0-1), 계획 산출물 저장(P0-2).

### Qwen Code (Alibaba) — 상
서브에이전트 md+yaml 3계층, fork 서브에이전트(프롬프트 캐시 히트로 토큰 80% 절감 주장), **ACP로 claude-code/codex 위임**, 권한 모드 상속, 알림 큐(상한+소거 규칙). → 멀티프로바이더 선례(P2-16), 권한 상속(P0-3).

### OpenCode (Anomaly) — 상
로컬 서버(OpenAPI 공개)+멀티 클라이언트, 세션 공유 링크 3모드, Scout 읽기전용 에이전트, 명령 glob 단위 permission, doom_loop 감지. → 공유 링크(P1-9), 자가수리(P1-14).

### Pi (Mario Zechner) — 상
4모드 단일 엔진, 트리 세션/fork, Extensions API, **project trust 게이트**(레포 동적 설정 신뢰 전 로드 차단), steering vs follow-up 2단 큐. → 신뢰 게이트(온보딩 닥터 확장), 2단 큐(미드턴 큐 고도화).

### Oh My Pi (Can Bölük) — 상
9롤 라우팅+폴백, Advisor, Agent Hub, **time-traveling stream rules**(위반 시점에 규칙 주입), hashline 편집, /collab, 8종 레거시 설정 상속, /review. → 아키텍처·컨벤션 주입(P1-14) 레퍼런스.

### Cursor — 상
**클라우드 에이전트가 dev server 기동→브라우저 조작→영상/스크린샷/로그를 PR에 첨부**, Multi-Agent Judging, worktrees.json, hooks.json, automations. → 검증 증거물(P0-4), best-of-N(P2-17).

### Devin CLI — 중상
Playbooks(절차+성공기준 템플릿), Knowledge(자동 회수), Session Insights(회고 지표), 로컬↔클라우드. → 재사용 템플릿(P1-10), 회고 카드(P1 후보).

### Factory Droid — 상
Spec Mode(계획→승인→`.factory/docs` 저장), autonomy 4단계, Custom Droids(md 정의), mission mode. → 계획 산출물 저장(P0-2), 승인 단순 프리셋(P0-3).

### Amp — 상
**Handoff(상태 스냅샷을 카드로 검토·수정 후 새 스레드)**, orbs(클라우드 VM), 이벤트 드리븐 기동, Puck(메타 코디네이터), 멀티플레이어. → 세션 이어하기(P0-8).

### goose (Block→AAIF) — 상
Recipes(YAML 워크플로, 재시도 로직 포함), MCP-first, **구조화 failed 결과 계약**(서브에이전트 실패가 크래시가 아닌 JSON), lead-worker 모델 라우팅. → 재사용 레시피(P1-10), 부분 실패 UX(P1-14).

### Grok Build — 중 (베타, 문서 얇음)
병렬 서브에이전트(worktree 격리), 편집 가능 Plan, **grok inspect(프롬프트 전 감지 설정 표시)**, /skillify. → 컨텍스트 투명성(P0-6), 스킬 캡처(P1-10).

### Mistral Vibe — 상
`@` 이미지 참조, config.toml 권한, 프로젝트 자동 스캔, 에이전트 프로필. → 입력 문법, 프로필 프리셋 참고.

### Cline — 상
**Focus Chain(할 일 목록 상시 재주입)**, 섀도우 git 체크포인트(툴 콜 단위, Restore Files/Task Only/Files & Task), auto-approve 카테고리+항상 ON 기본화, Plan 중 쓰기 차단. → P0-1·2·3의 핵심 출처.

### Kilo — 중~상
OpenCode 서버 위 포터블 코어(IDE·CLI 동일 엔진), worktree 병렬, 500+ 모델 BYOK. → 아키텍처 참고(P2-16).

### Auggie (Augment) — 상
레포 자동 인덱싱 컨텍스트 엔진, **Memories+Memory Review(생성된 메모리를 챗에서 검토·편집)**, session resume. → 기억 카드(P0-7) 최강 참조.

### Junie (JetBrains) — 상
**Plan=편집 가능한 구조화 문서(요구사항/설계/단계 탭)**, plan(프론티어)/구현(저가) 모델 분리, guidelines.md, manual/brave 2모드. → P0-2, P2-18, 규칙 파일.

### Kiro CLI (AWS) — 상
Specs(EARS 3단계), steering files, 자연어 이벤트 훅, **checkpoint(파일 스냅샷) vs rewind(대화 포크) 명시 분리**, `.kiro/` IDE↔CLI 공유. → P0-1 핵심 출처, 스펙 2단 세분화 참고.

### Qoder (Alibaba) — 상
**Task Report(무엇을 왜 어떻게 검증했는지 보고)**, Repo Wiki(자동 문서+변경 추적), Action Flow(단계 트레이스), 비동기 실행+알림. → P0-4·6 핵심 출처.

### TRAE CLI (ByteDance) — 중
음성 입력, trajectory 파일(도구 호출 포함 실행 궤적), SOLO 통합 워크스페이스. → 음성(P0-5), 핸드오프 감사 자료(P1).

### MiniMax Code — 상
**모바일 원격 권한 승인**, Scheduled Tasks, Agent Team(검증 전담 역할), stdout/stderr 분리 structured mode. → 모바일 승인(P2-15), 검증 패스(P1).

### Kimi Code CLI — 상
**비디오 입력**, 대화형 /mcp-config, Agent SDK(하니스 임베드), explore 서브에이전트. → 영상 입력(P2-18), SDK 선례(P2-16).

### CodeBuddy Code (Tencent) — 상
Plan 중 중단·방향 수정, ACP+Agent SDK, skills, 단일 매니페스트 플러그인. → 미드턴 큐 방향 수정 참고.

### CodeWhale — 중 (단일 공식 채널 불명확)
사이드 git 스냅샷+/restore, HTTP/SSE 런타임 API, 프롬프트 헌법(톤 강제). → rewind 경량 패턴.

### Cortex Code (Snowflake) — 상
**플랫폼 인지 에이전트**(스키마·웨어하우스·RBAC 이해로 오류 사전 차단), 단일 매니페스트 플러그인(Git 공유), 웹검색 기본 off(명시 opt-in). → "레포+미리보기 상태를 아는 에이전트" 방향 근거, opt-in 기본값 원칙.

### Poolside — 상
**VCS 독립 체크포인트**(AI 작업의 세이브 포인트), 리소스별 철회 가능 권한, 샌드박스 검증 후 반영. → P0-1 아키텍처 참조.

### Nova — 하 (독립 검증 부족)
3단계 승인(Manual/Auto/Strict), 실시간 토큰·비용 통계, 세션 동기화. → 승인 프리셋·비용 칩 참고만.

### fast-agent — 상
evaluator-optimizer 워크플로, MCP 서버 역노출, **OAuth 로컬 콜백+paste-URL 폴백**. → 검증 루프(P1), 온보딩 인증 플로우(P1).

### DeepAgents (LangChain) — 상
write_todos 라이브 계획, 파일시스템 작업 메모리(컨텍스트 외부화), 미들웨어 구조, 태스크 경계 기회적 요약. → P0-2, 압축 타이밍(P1).

### Stakpak — 상
**Dynamic Secret Substitution**(키를 읽고/쓰되 실제값 노출 없음, 레닥션 기본 ON), Warden(인프라 레벨 차단), 모든 수정 자동 백업, 일괄 승인, 알림 channel(수단)/target(목적지) 분리, Rule Books. → P0-3, P1-11·12.

### crow-cli — 상
두뇌/손 분리(ACP 에이전트+MCP 도구 서버), sqlite FTS5 세션 전문검색, SKILL.md. → 세션 검색·재개(P1), ACP 채택 참고(P2-16).

### Corust — 하 (기능 상세 미검증)
도메인 특화 에이전트 컨셉만 참고(우리도 "화면 디자인 특화").

### VT Code — 상
프로바이더 자동 페일오버+지출 상한, tree-sitter-bash 구조적 명령 검증(비개발자에게 설명 가능), done 전 검증 게이트, resumable handoffs, 백그라운드 서브에이전트. → P1-12·14, P2-16.

### Dirac — 상
/goal(세션 넘는 목표 객체), 해시 앵커 편집(편집 실패율↓), AST 아웃라인 우선 컨텍스트(토큰 절감). → 목표 객체(P0-8 융합), 비용 절감 기법(P2, 하니스 레벨).

### DimCode — 중상 (도메인 분산, 정체성 불명확)
steer notification, MCP 유저/프로젝트 2계층 오버라이드. → 설정 계층 참고.

### Minion Code — 중
Claude Code 클론. 신규 가치 낮음 → 탈락.

### siGit Code — 중상
온디바이스 기본 추론(프라이버시), ACP 네이티브, Paseo로 폰에서 로컬 에이전트 구동. → 모바일 컴패니언 방향 검증(P2-15).

### Autohand Code — 중상
**Persistent goal files + /goal resume**, `#` 한 줄 메모리(세션 간 컨텍스트), self-evolving(미검증 주장). → P0-7·8.

### Agora — 중 (자사 주장 중심, 독립 검증 얇음)
자동 probe 신뢰 등급, trust·price·latency·success 스코어링 라우팅, 영수증 원장, USDC 정산(무관). → 라우팅 기준·영수증 아이디어만(P2-16 전제).

---

## 5. 신뢰도 총괄

- 상(공식 문서/릴리즈 직접 확인): Claude Code, Codex, Gemini CLI, Qwen, OpenCode, Pi, omp, Cursor, Droid, Amp, goose, Mistral, Cline, Auggie, Junie, Kiro, Qoder, MiniMax, Kimi, CodeBuddy, Cortex, Poolside, fast-agent, DeepAgents, Stakpak, crow, VT, Dirac
- 중~중상(공식 자료 있으나 단일 채널/서드파티 혼재): Devin, Kilo, TRAE, CodeWhale, DimCode, siGit, Autohand
- 하(독립 검증 부족, 참고만): Grok Build(베타), Nova, Corust, Minion, Agora
- 본 문서의 수치 주장(토큰 80% 절감, 비용 64.8% 절감 등)은 각 벤더 주장 그대로이며 독립 검증되지 않았다.
