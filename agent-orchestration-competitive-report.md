# 코딩 에이전트 오케스트레이션 프로덕트 경쟁 조사 보고서 (v2 — 전체 앱 심층 분석판)

> 작성일: 2026-09-15 · 조사 방법: 각 프로젝트 공식 사이트/문서/GitHub/릴리즈 노트 1차 자료 기반 웹 리서치 (2차 심층 패스: 앱별 공식 문서 페이지 단위 분석 포함)
> 목적: Paseo 류(코딩 에이전트 관리/오케스트레이션) 제품군의 전체 지도 작성 + 벤치마킹할 기능·UI/UX 도출
> 범위: 식별된 ~45개 프로젝트 전원 분석. 마케팅 문구만 있는 항목은 신뢰도를 명시.

---

## 0. TL;DR

- 이 카테고리는 2025년 하반기~2026년에 폭발했다. "worktree 당 에이전트 하나 + 중앙 대시보드 + diff 리뷰 + 모바일 동행 앱"이 사실상 표준 공식으로 수렴했다.
- **모든 벤더가 '에이전트 커맨드센터'로 수렴 중**: Claude Desktop(Code 탭), Codex app, Antigravity 2.0(Agent Manager), Devin Desktop(구 Windsurf, Agent Command Center가 기본 화면), Amp, Warp Oz. 프로바이더 중립+셀프호스트+모바일 parity가 Paseo의 차별점이 되는 이유.
- **가장 가까운 경쟁군(로컬 멀티에이전트 데스크톱)**: Orca, Conductor, Superset, Nimbalyst(구 Crystal), T3 Code, amux, Maestro, CodeAgentSwarm, Parallel Code, Sculptor, Paseo.
- **죽거나 피벗한 것들**: Crystal→Nimbalyst, Terragon→셧다운+OSS, Vibe Kanban→커뮤니티 유지(2026-04 이후 커밋 없음), Windsurf→Devin Desktop, opcode(Claudia)→2025-10 이후 공개 커밋 없음(3rd-party 검증 기준). 레슨: 단순 "세션 래퍼"는 생존이 어렵고, **리뷰/조정(coordination) 레이어**가 가치를 만든다.
- 파쿠리 최우선 후보: **공유 태스크 보드(atomic claiming) + 에이전트 간 메시징(provenance 보장) + 와치독/자가회복 + diff 주석→에이전트 피드백 루프 + needs-you 인박스(3단계 알림 위계) + best-of-N 레이스/심판 + 세션 전문검색 + 사용량/레이트리밋 대시보드 + CI 워처(PR 자동수리)**.
- 2차 패스에서 새로 확인된 고가치 패턴: **Devin Spaces(에이전트 간 공유 컨텍스트 그룹)**, **Amp Puck(개인 비서형 코디네이터)**, **Sculptor CI Babysitter(실패 CI 자동수리 전용 에이전트)**, **Claude Desktop side chat/task chips**, **Orca orchestration(Run/Task/Dispatch/decision gate)**, **Kiro checkpoint vs rewind 분리**, **Superset 이벤트 기반 Task→Workspace 파이프라인**.

---

## 1. 시장 카테고리 맵

| 카테고리 | 정의 | 대표 프로젝트 |
|---|---|---|
| A. 로컬 멀티에이전트 데스크톱 (ADE/컨트롤 플레인) | 내 머신의 CLI 에이전트들을 worktree 격리로 병렬 실행·감독 | **Paseo**, Orca, Conductor, Superset, Nimbalyst, T3 Code, amux, Maestro, CodeAgentSwarm, Parallel Code, Sculptor, Verdent, Claude Code Studio, opcode(Claudia), AionUi, OpenChamber |
| B. 벤더 공식 데스크톱/커맨드센터 | 모델 회사가 직접 만든 에이전트 커맨드센터 | Claude Desktop, Codex app, Antigravity 2.0, OpenCode Desktop/Web, Devin Desktop(구 Windsurf) |
| C. IDE 통합형 | 에디터 안의 에이전트 패널/관리면 | Cursor, Zed(ACP), Kiro, Trae SOLO, Cline/Roo/Kilo |
| D. 클라우드 비동기 에이전트 | 클라우드 VM/샌드박스에서 태스크→PR | Devin Cloud, Cursor Cloud Agents, Copilot coding agent, Jules, Factory, Amp(orbs), OpenHands, Replit Agent, Warp Oz, Terragon(종료) |
| E. 모바일/원격 컴패니언 | 폰에서 로컬 세션 감시·승인·조향 | Paseo mobile, Happy, Omnara, SeaWork, T3 Code mobile, amux iOS/PWA, Orca companion, Nimbalyst iOS, Claude Dispatch, Kiro iOS(TestFlight), conductor-remote(비공식) |
| F. TUI/경량 세션 매니저 | 터미널 안에서 tmux+worktree 관리 | claude-squad, ccmanager, dmux, agent-deck, csq, Gas Town |
| G. 범용 에이전트 오케스트레이터(인접 시장) | 코딩 외 지식노동까지 커버 | Perplexity Computer, OpenClaw 류, AI Maestro, Chorus(UX 참조) |

---

## 2. 프로젝트 리스트업 (요약 테이블)

### A. 로컬 멀티에이전트 데스크톱 — 핵심 경쟁군

| 프로젝트 | 형태/플랫폼 | 지원 에이전트 | 한 줄 차별점 | 상태 |
|---|---|---|---|---|
| **Paseo** | 데스크톱+모바일+웹+CLI, daemon 아키텍처, E2E 릴레이 | Claude Code, Codex, Copilot, OpenCode, Pi/OMP 등 30+ (네이티브+ACP) | 데몬-클라이언트 분리, 네이티브 모바일 parity, 음성, worktree 프록시 포트, 플러그인 시스템, Hub | 활발 (⭐~15.9k) |
| **Orca** (stablyai) | mac/Win/Linux + iOS/Android 컴패니언, MIT | 27+ 사전설정 + 임의 CLI | "ADE" 포지셔닝, Design Mode, diff 주석→에이전트, 계정 스위처+사용량, SSH/원격 서버/클라우드 VM, orchestration(Run/Task/Gate), `orca` CLI로 에이전트가 앱 구동 | 활발, YC |
| **Conductor** (Melty Labs) | macOS 전용, 독점 | Claude Code, Codex, Cursor, OpenCode | 가장 다듬어진 Mac 경험: workspace=worktree+브랜치+채팅+diff+PR 경로, Checks 탭(merge readiness), Spotlight 테스트, Conductor Cloud(Vercel 샌드박스), API | 활발, 유료 |
| **Superset** | macOS(+Linux AppImage), 소스공개(ELv2) | 모든 CLI 에이전트 + 내장 채팅 | Tasks(Linear/GitHub 이슈→워크스페이스 팬아웃), Automations(RRule+실행이력), Remote Access(relay+포트 포워딩), usage, TS SDK+MCP+host server | 활발, YC |
| **Nimbalyst** (구 Crystal) | mac/Win/Linux + iOS, MIT | Claude Code, Codex (OpenCode/Copilot 알파) | "비주얼 워크스페이스": 세션 칸반, 세션별 파일 추적, 전문검색+재개, 세션 브랜치, Excalidraw/Mermaid/목업/시트/마인드맵 에디터, 멀티플레이어 | 활발 |
| **T3 Code** (pingdotgg) | 로컬 서버 + 웹/Electron/iOS/Android, MIT | Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity | `npx t3` 무설치 컨트롤 플레인, BYO 구독, 원버튼 PR(제목/본문/체인지로그 자동), 페어링 링크, SSH 실행, 멀티계정, 프로바이더별 권한모드 매트릭스 | 활발 (⭐22.7k) |
| **amux** | 단일 Rust 바이너리 + 웹 대시보드 + iOS + PWA, MIT | Claude Code, Codex, Gemini, OpenCode, Ollama, 임의 CLI | "AI 엔지니어링 팀": 공유 칸반(CAS 클레임+blocked_on), 출처 스탬핑 에이전트 메시징, 와치독(자동 compact/재시작/재전송), self-paced 루프, owner alert(푸시+iMessage), 스코프 상속(card→worker→group→global) | 활발, Cloud $20/월 |
| **Maestro** (RunMaestro) | 크로스플랫폼 데스크톱, 오픈소스 | Claude Code, Codex, OpenCode + Droid/Copilot-CLI 등 베타 | 키보드 파워유저: 메시지 큐, 스누즈 탭, 그룹챗(모더레이터), @멘션 자문, 플레이북+Exchange, `!` 커맨드 모드, QR 원격, Concerto(에이전트가 네이티브 UI 렌더), Director's Notes | 활발 |
| **CodeAgentSwarm** | macOS/Windows, 유료(베타 무료) | Claude Code, Codex, Antigravity, OpenCode, Kimi, Grok, Cursor | 터미널 그리드(최대 25), MCP 태스크 보드(에이전트가 직접 갱신), 동적 타이틀, 전체 이력 검색, Turbo+가드레일, 스킬 마켓 | 베타 |
| **Parallel Code** | macOS/Linux, MIT | Claude Code, Codex, Gemini, Copilot, Antigravity CLI | 미니멀: worktree 자동생성(node_modules 심링크), BYO 에디터, 원클릭 머지 | 활발 |
| **Sculptor** (Imbue) | 데스크톱, 오픈소스 | Claude Code, Pi, 임의 터미널 에이전트 | worktree 대신 **컨테이너 격리**, Pairing Mode(컨테이너→로컬 적용), **CI Babysitter**(실패 CI/머지충돌 자동수리), 스킬=서브에이전트, JS/TS 플러그인 | 활발 (니치) |
| **Verdent** | 데스크톱 + VS Code/JetBrains 연동 | 자체 에이전트 + BYOK | Manager가 목표→단계→서브태스크 자동 분해·디스패치, 전 프로젝트 칸반+리뷰 컬럼, Pulse 진행 피드 | 활발 |
| **Claude Code Studio** | Electron | Claude Code (+SSH 원격) | 워크스페이스 격리(회사/개인), SSH+tmux, Broadcast, Task Chain(A 완료→B), Config Map(규칙 시각화), Activity Map | 커뮤니티 |
| **opcode/Claudia** (getAsterisk) | Tauri 2 | Claude Code | 세션 타임라인+체크포인트+브랜치, 사용량/비용 분석, CC Agents 라이브러리+백그라운드 실행, MCP GUI, CLAUDE.md 에디터, 샌드박스+감사로그 | ⚠️ 2025-10 이후 커밋 없음(3차 검증) |
| **AionUi** (iOfficeAI) | mac/Win/Linux, 오픈소스 | 내장 에이전트 + 자동감지 20+ CLI | "Cowork" 프레임(코딩 외 사무작업), cron, Telegram/WeChat/Lark/DingTalk 원격, 9+ 포맷 프리뷰, MCP 통합관리 | 활발 (⭐32.8k) |
| **OpenChamber** | 데스크톱/웹 | OpenCode 중심 멀티 | OpenCode 멀티세션 GUI | 활발 (경량) |

### B. 벤더 공식

| 프로젝트 | 핵심 |
|---|---|
| **Claude Desktop** | Chat/Cowork/Code 3탭. 환경(Local/Cloud/SSH/WSL), 5단계 권한, 브라우저 페인(자동검증+외부사이트 승인), diff 라인 코멘트+Review code, PR CI 감시(auto-fix/auto-merge/auto-archive), 페인 드래그/팝아웃, side chat, tasks 페인, 세션 간 확인/메시지/아카이브+task chips, Dispatch(폰), 컴퓨터 사용(앱별 티어), iOS 시뮬레이터, usage ring |
| **Codex app** | 프로젝트별 스레드, worktree 내장, diff 코멘트, CLI/IDE 이력 흡수, Skills(전용 UI+레포 체크인+라이브러리), Automations→리뷰 큐, `/personality`, 샌드박스 규칙, ChatGPT 구독+크레딧, Windows 추가 |
| **Antigravity 2.0** | Agent Manager→Projects(워크트리, 스코프드 설정/권한—학습하여 지속, 멀티폴더), 스크래치 대화, 스케줄 태스크, 음성 전사(스마트 정리), JSON hooks, 브라우저 서브에이전트(DevTools MCP, webm 녹화), Remote Control(웹→데스크톱+푸시), VCS 페인, Artifacts(Plan/Walkthrough/Screenshots/Recordings에 코멘트), `/boost`, `/teamwork`, sidecars, AGY CLI(vim/headless/`/voice`), SDK(personas/policies), IDE 확장 5종 |
| **OpenCode** | TUI/데스크톱/웹이 같은 로컬 서버(`opencode-cli` 사이드카)에 접속, 세션 공유 링크→포크, 타임라인/stash/compact, 빌트인 에이전트(Build/Plan/General/Explore/Scout), 75+ 프로바이더(models.dev), ChatGPT/Copilot 계정 로그인, LSP, 플러그인 |
| **Devin Desktop** (구 Windsurf) | Agent Command Center가 기본 서피스: 로컬+클라우드 에이전트 칸반, **Spaces**(세션/PR/파일/컨텍스트를 묶어 에이전트 간 공유), ACP로 임의 에이전트 수용(Codex/Claude Agent/OpenCode/자체 제작), Devin Local(Rust 재작성, 30% 토큰 절감, 서브에이전트), 완전한 IDE 유지 |

### C. IDE 통합형

| 프로젝트 | 벤치마크 포인트 |
|---|---|
| **Cursor** | cloud agents(VM+컴퓨터 사용, PR에 영상/스크린샷/로그, 원격 데스크톱 탈취), **Multi-Agent Judging**, worktrees.json 셋업, automations(스케줄/이벤트), iOS+웹+Slack/GitHub/Linear 트리거, 멀티레포 환경, 라이프사이클 훅 |
| **Zed** | **ACP** 주창: 외부 에이전트 레지스트리 설치, 스레드 사이드바, 에이전트별 체크포인트, "New From Summary", 멀티버퍼 diff 승인 |
| **Kiro** (AWS) | 단일 하니스를 IDE/CLI/Web/Mobile/**Crew(24/7 상주)**가 공유. Specs(EARS), Steering, 이벤트 훅, 커스텀 에이전트, **checkpoint(파일+컨텍스트 복원) vs rewind(대화 포크) 분리**, 클라우드 세션, 자율 모드, memory, Powers |
| **Trae SOLO** (ByteDance) | IDE↔SOLO 토글, Spec/Plan 문서화, 서브에이전트 스마트 생성, Figma→코드 |
| **Cline/Roo/Kilo** | VS Code 확장군: 체크포인트, 마켓플레이스, 워크트리 병렬(Kilo) |

### D. 클라우드 비동기

| 프로젝트 | 벤치마크 포인트 |
|---|---|
| **Devin Cloud** | Interactive Planning(30초 자동진행, 코드 인용→IDE 딥링크), Automations(트리거→세션 시작/기존 세션 메시지/**triage monitor**), Slack 키워드(!ask/!deep/mute/sleep/archive/!fast/!ultra/!dana), Linear(신뢰도 🔴🟠🟢 표시), Session Insights, Devin Review, Search/Wiki |
| **Copilot coding agent** | 이슈 assignee 모델, Actions 기반 환경, 모바일 assign, 리뷰→수정 루프, 커스텀 프로필, 인간 승인 전 CI 차단 |
| **Jules** | 계획 승인 게이트, **오디오 체인지로그**, `jules` 라벨, CLI+TUI |
| **Factory** | 프리뷰 탭+포인트-앤-코멘트, Missions, Custom Droids, exec CI 모드, 디바이스 동기화 |
| **Amp** | 스레드=URL, 포크=레시피 재실행, **orbs**(스레드당 클라우드 머신, 크기/비용 선택), **Portals**(오브 웹서버 노출), Agent-to-Agent(파일 교환/타 프로젝트/러너 위임), **Puck**(개인 비서 코디네이터+Slack), The Dial, multiplayer/Space |
| **OpenHands** | Agent Canvas 컨트롤센터, 로컬/Docker/VM/클라우드 백엔드, 사전빌드 자동화, 임의 ACP 에이전트 |
| **Warp Oz** | 클라우드 에이전트(트리거/스케줄/연동), Runs 관측면, 로컬↔클라우드 핸드오프, Agent Profiles, 셀프호스트 워커, 공유 컨텍스트(rules/skills/MCP/memory) |
| **Replit Agent** | 파일+대화+DB+환경 통째 체크포인트/롤백, 모바일 앱 빌드→Expo Go QR→스토어 플로우, Lite/Economy/Power, Design Canvas |
| **Terragon** | ⚠️ 2026-02 종료 → OSS 공개. 유산: `terry pull`(클라우드→로컬), 레이트리밋 큐잉 |

### E. 모바일/원격 & F. TUI & G. 인접 — §3 개별 분석 참조

---

## 3. 프로젝트별 심층 분석

> 각 항목: **정체** / **눈에 띄는 기능·UX** / **Paseo가 베낄 것** / **약점·한계** / **신뢰도**.

### A-1. Orca (stablyai/orca, MIT, YC)

- **정체**: "IDE는 사람용, ADE는 사람+에이전트용"이라는 포지셔닝의 데스크톱 에이전트 개발환경. mac/Win/Linux + iOS/Android 컴패니언.
- **눈에 띄는 것**:
  - **Orchestration 레이어**(experimental): `Run`(네임스페이스+코디네이터 인박스) → `Task`(spec+의존+상태: pending/ready/dispatched/completed/failed/blocked) → `Dispatch`(시도 단위, worker_done/heartbeat의 생명주기 권한). **Decision gate**(코디네이터 소유 질문이 태스크를 블록), `ask`(워커→코디네이터 블로킹 질문+옵션), 그룹 주소(`@all` `@idle` `@codex` `@worktree:<id>`), 태스크 ID가 터미널에서 클릭 가능 링크, **federated worker**(다른 머신/SSH 런타임에 워커 배치).
  - **Agents feed**: 전 워크트리의 완료/블로킹/응답 미리보기/워크트리 생성 이벤트를 하나의 스레드 피드로 — 실행 중 항목 상단 고정.
  - 알림: working→idle 전환 감지(래퍼가 아니라 에이전트를 실행하므로 정확), 헤더 벨+Dock 뱃지+워크트리 칩, **읽지않음으로 되돌리기**, 카테고리별 커스텀 사운드+볼륨.
  - **Design Mode**: 워크트리별 Chromium에서 요소 클릭→HTML+CSS+크롭 스크린샷이 에이전트 프롬프트로.
  - 계정 스위처+사용량: Claude/Codex 사용량(5h/주간), 레이트리밋 리셋, Codex 계정 핫스왑.
  - 모바일: 라이브 상태/사용량/계정 전환/터미널 조향, 데스크톱 페어링, "Agents spawned / Agent time / PRs created" 스탯 화면.
  - 기타: agent hibernation, session restore, worktree checkpoints, attribution, Linear/Jira 아이템 드로어, Monaco+오토세이브, WebGL 터미널(무한 스플릿+스크롤백 복원+전문검색), SSH worktree(자동재접속+포트포워딩+패스프레이즈 캐시), 원격 Orca 서버, 워크스페이스별 클라우드 VM, skills 레지스트리+MCP, 컴퓨터 사용, 스케줄 자동화.
  - `orca` CLI가 곧 API: 에이전트가 `orca worktree create/snapshot/click/fill`로 **앱 자체를 구동**.
- **Paseo가 베낼 것**: 오케스트레이션 프리미티브(Dispatch ID로 stale worker 완료 오인 방지, gate, 그룹 주소), Agents feed, Design Mode, 계정 핫스왑+사용량, "클릭 가능한 태스크 ID".
- **약점**: 무료 MIT+YC라 지속가능성 질문, 기능 폭이 넓어 복잡도 높음, 오케스트레이션은 아직 experimental.
- **신뢰도**: 공식 docs/사이트 직접 확인 — 높음.

### A-2. Conductor (Melty Labs)

- **정체**: macOS 전용 유료 앱. "워크스페이스=위임 단위, 브랜치/PR=통합 단위"라는 명확한 멘탈 모델.
- **눈에 띄는 것**: Checks 탭(git status+PR 메타+CI+배포+코멘트+todo — **머지 전 마지막 게이트로 설계**, 미해결 todo/실패 체크는 머지를 사실상 차단), diff 인라인 코멘트→컴포저 첨부로 반송, Review 액션(에이전트 리뷰), Spotlight 테스트, setup/run 스크립트, `CONDUCTOR_PORT`, 체크포인트, 계획 승인, GitHub/Linear 이슈→워크스페이스, History 페인에서 아카이브 복원(채팅 포함), Conductor Cloud(Vercel 샌드박스 8코어/16GB), API, BYO 구독(Bedrock/Vertex/커스텀 프로바이더).
- **Paseo가 베낼 것**: "Checks"라는 머지 레디니스 집계면 — git/CI/코멘트/todo를 한 화면에 모으고 미해결 시 머지 억제.
- **약점**: Mac only, 클로즈드, 2026-03 샌드박스 이탈 사례 보고(래퍼 기본값이 사용자 샌드박스 설정을 덮음), 공식 모바일 없음→conductor-remote/Telegram 브릿지가 공백을 메움(시장 신호), 클라우드 세션은 Conductor 서버 저장.
- **신뢰도**: 공식 docs + 독립 리뷰(tomrochette) — 높음.

### A-3. Superset

- **정체**: "100+ 에이전트" 스케일의 데스크톱 워크스페이스. 소스공개(ELv2)+Pro 구독.
- **눈에 띄는 것**:
  - **Tasks 뷰**: Linear 동기화+GitHub 이슈+네이티브 태스크를 한 보드로. 시맨틱 검색, 멀티셀렉트→**태스크당 워크스페이스 일괄 생성**(Auto-run 토글, 에이전트별 Task Prompt Template). 태스크→워크스페이스→PR이라는 완결 파이프라인.
  - **상태 감지 아키텍처**: 각 에이전트 config에 lifecycle hook/래퍼(`~/.superset/bin`, `superset-hooks`)를 심어 start/finish/waiting-for-input을 보고. Superset 터미널 밖에서는 no-op. "Clear Status"로 찌꺼기 상태 리셋.
  - **Automations(Pro)**: RRule 스케줄(프리셋+커스텀 검증, 일회성 규칙 거부), 한 자동화에 복수 트리거, 실행이력(created/creating/failed—"성공=워크스페이스 생성됨"이라고 정직하게 명시), 7일 건강 스탯, Up next 정렬, Mine/Team 탭, 실패 시 **Retry all**, 태그→사이드바 폴더 자동 수집, at-least-once 주의 명시.
  - **Remote Access(Pro)**: Superset Relay로 다른 머신의 워크스페이스에 접속. 조직 기반 호스트+멤버 권한, 헤드리스는 API 키(`SUPERSET_API_KEY`+`--org`), 디바이스 필터, **원격 포트 포워딩**(같은 포트로 매핑, 충돌 시 `3000→54321` 리매핑 제안, 워크스페이스 전환 시 포워드 교체, TCP only).
  - 포트 관리 패널, 인앱 브라우저, Computer Control, Pages, Usage, Skills, TS SDK, MCP 서버, Slack/Linear 연동, lifecycle 스크립트.
- **Paseo가 베낼 것**: Task→Workspace 파이프라인(특히 멀티셀렉트 팬아웃+프롬프트 템플릿), 자동화 실행이력+재시도 UX, 원격 포트 리매핑 UX, lifecycle hook 방식의 상태 감지.
- **약점**: Automations/Remote는 Pro 전용, Linux 지원은 AppImage 수준, ELv2(자유로운 fork/재배포 제한).
- **신뢰도**: 공식 docs — 높음.

### A-4. Nimbalyst (구 Crystal)

- **정체**: Karl Wirth의 "비주얼 멀티에이전트 워크스페이스". Crystal(2026-02 폐기)의 후속, MIT.
- **눈에 띄는 것**: 세션 칸반(세션=카드, 상태 컬럼), **세션별 파일 추적**(그 세션이 읽고/쓴 파일 사이드바), 세션 트랜스크립트 전문검색+어디서든 재개, **세션 브랜칭**(원본 보존하며 대안 탐색), 리치 문서 에디터(마크다운/Excalidraw/Mermaid/목업/스프레드시트/마인드맵 — 에이전트 산출물이 문서로), 턴 요약 스탯("Finished in 6m57s — 3 files +45 −12"), 멀티플레이어 실시간 공동편집+팀 채팅, iOS 앱.
- **Paseo가 베낼 것**: 세션→파일 매핑, 세션 브랜칭 UX, "에이전트 산출물=리치 문서" 방향(플러그인으로 구현 용이).
- **약점**: Claude Code/Codex 중심(나머지 알파), 조정 프리미티브는 얕음.
- **신뢰도**: 공식 docs — 중상.

### A-5. T3 Code (pingdotgg)

- **정체**: `npx t3@latest`로 무설치 실행되는 로컬 서버 + 웹/Electron/모바일 클라이언트의 오픈소스 컨트롤 플레인. ⭐22.7k.
- **눈에 띄는 것**: 서버-클라이언트 분리(로컬 서버에 다수 클라이언트 — Paseo와 같은 구조), BYO 구독, **프로바이더별 권한 모드 매트릭스**(Supervised/Auto-accept/Auto/Full access + 프로바이더별 차이 문서화: Auto는 Codex/Claude/Cursor만 지원, Grok은 "이 세션에서 항상 허용"이 명령 단위 기억, Antigravity는 자체 승인 요청), 원버튼 PR(제목/본문/체인지로그 자동생성), 페어링 링크, SSH 실행, 멀티계정, 스레드/프로젝트 모델, 프로젝트별 권한 기본값 오버라이드.
- **Paseo가 베낼 것**: 프로바이더별 권한 의미 차이를 표로 문서화하는 접근 — Paseo의 provider별 지원 한계 정리에 그대로 적용 가능.
- **약점**: 조정/보드 없음, 젊은 프로젝트.
- **신뢰도**: GitHub docs — 높음.

### A-6. amux (mixpeek, MIT + Cloud $20/월)

- **정체**: "5~50 에이전트, 제로 조정 오버헤드"를 표방하는 단일 Rust 바이너리 컨트롤 플레인. 웹 대시보드(localhost:8824)+iOS+PWA.
- **눈에 띄는 것**:
  - **공유 보드**: SQLite CAS로 클레임 원자성 보장(두 워커가 같은 카드 불가), `blocked_on` 의존, `GET /api/board/ready`=의존 해소된 태스크만, **상태별 게이트**(done은 증거 필수, verified는 피어 체크 필수).
  - **출처 스탬핑 메시징**: 서버가 진짜 발신자를 기록 — 위조/오인 불가. 메시지 레저(모든 전달이 id 있는 행).
  - **Self-healing**: 와치독이 컨텍스트 감시→자동 compact, 크래시 세션 재시작+마지막 메시지 리플레이.
  - **Self-paced 루프**: 에이전트가 자기 다음 wakeup을 스케줄, ready 큐 소진 후 잠듦 ("하룻밤 7카드, 0개입" 데모).
  - **Owner alert 위계**: "진짜 막힐 때만" 푸시+iMessage, 나머지는 보드에.
  - Groups(레인별 공유 메모리/환경/게이트), Scope(설정이 card→worker→group→global로 해소), Worker awareness(피어 목록/소유/현재 작업, peek으로 터미널 엿보기), 실행 중 모델 스왑, API 레퍼런스가 에이전트 메모리에 자동 주입(자연어 오케스트레이션이 그냥 됨).
- **Paseo가 베낼 것**: 이 제품 전체가 Paseo 오케스트레이션의 레퍼런스. CAS 클레임, provenance, 와치독, 스코프 상속, "API를 에이전트 메모리에 주입" 패턴.
- **약점**: 워크스페이스 격리/리뷰 UX는 얕음(코디네이션에 특화), 젊음(2026 초 출시).
- **신뢰도**: 공식 사이트/docs — 높음(수치는 자사 주장).

### A-7. Maestro (RunMaestro)

- **정체**: "Linear/Superhuman급 키보드 파워유저" 멀티에이전트 데스크톱. 오픈소스.
- **눈에 띄는 것** (기능 목록이 이 카테고리 최장):
  - **메시지 큐**: 작업 중 메시지를 큐잉→준비되면 자동 전송. 큐에서 편집/복사/보류/재정렬/삭제.
  - **Snooze 탭**: 탭을 숨기고 자연어("next friday 3pm")로 귀환 예약+메모, AI 탭은 돌아오는 순간 지정 프롬프트 자동 실행.
  - **`!` 커맨드 모드**: 빈 컴포저에 `!`→쉘 명령이 트랜스크립트로 스트리밍(파일/브랜치 탭 완성, 에이전트 턴 중에도 동작).
  - **Group Chat**: 모더레이터 에이전트에 질의 위임→적절한 에이전트에게 라우팅, 얕은 답은 후속 질문, 종합해 반환. vs **Cross-agent @mention**: 단발 자문(대화 조각을 포워드, 백그라운드 실행, 답변 스트리밍+귀속), 그룹 팬아웃.
  - **Auto Run+Playbooks**: 마크다운 체크리스트를 파일시스템 태스크 러너가 순차 실행(태스크당 새 세션=깨끗한 컨텍스트), 루프, 이력. **Playbook Exchange**로 커뮤니티 플레이북 원클릭 임포트.
  - **Agent Resilience**: 529/쿼터 소진 시 에러가 읽은 실제 리셋 시간까지 백오프 후 **같은 프롬프트 자동 재전송**, 라이브 상태 카드 하나로 에러 다이얼로그 대체, Auto Run 배치 자동 재개.
  - **Concerto**: 에이전트가 텍스트 대신 **라이브 네이티브 뷰(Movement 패널)를 스테이지에 렌더**, 상시 HUD 카드(Cadenza).
  - **Director's Notes**: 전 에이전트 활동 통합 타임라인+AI 요약. Usage Dashboard(히트맵, CSV), WakaTime, 비용 추적.
  - 그 외: 듀얼 터미널(AI/쉘), 세션 자동발견·import(설치 전 이력 포함), 이미지 어노테이터(편집 가능 상태 유지), 문서 그래프, Parquet/CSV 뷰어(쿼리 언어), 출력 필터(정규식), 크로스탭 메시지 검색, 드래프트 자동저장, 자동 탭명, 탭 타일링, 커스텀 알림(완료 시 임의 명령 실행), 18 테마+빌더, QR+Cloudflare 터널 원격, SSH 실행, Symphony(OSS에 토큰 기부→이슈 처리→PR), 업적, **대화형 피드백**(에이전트가 진단 실행→중복 체크→GitHub 이슈 작성).
- **Paseo가 베낼 것**: 메시지 큐, 스누즈, `!` 모드, 그룹챗/자문 구분, 회복탄력성, 완료 시 임의 명령 실행, Director's Notes류 통합 타임라인. Concerto는 Paseo 플러그인 서피스와 방향 일치.
- **약점**: 기능 과잉(Encore Features에 숨겨둠으로 완화), 프로바이더 폭이 Paseo보다 좁음.
- **신뢰도**: 공식 docs — 높음.

### A-8. CodeAgentSwarm

- **정체**: 터미널 그리드(최대 25개) 중심의 유료 데스크톱(macOS/Windows). 자사 비교 가이드가 "검증일 명시+자사 약점도 기술"로 신뢰도 높은 2차 소스.
- **눈에 띄는 것**: **MCP로 노출된 태스크 보드** — 에이전트가 카드를 직접 생성/이동/갱신(사람이 아니라 에이전트가 보드를 운영), 동적 타이틀(지금 하는 일이 탭에), 벤더 교차 전체 이력 검색, Turbo 모드+가드레일(루틴 승인 스킵, protected 브랜치 push/삭제/민감 명령은 차단), 스킬/MCP 마켓플레이스.
- **Paseo가 베낼 것**: "보드를 에이전트에게 MCP로 노출" — Paseo 보드 기능의 핵심 설계.
- **약점**: 유료, 클로즈드, 베타.
- **신뢰도**: 자사 자료 — 중간.

### A-9. Parallel Code

- **정체**: 미니멀 MIT(mac/Linux). BYO 에디터.
- **눈에 띄는 것**: worktree 자동생성 시 **node_modules 심링크**(설치 시간 제거 — 작지만 실전 감각), 원클릭 머지, 정직한 자사 비교 페이지(타 카테고리의 사실 체크용으로도 유용).
- **약점**: 감독/조정 기능 최소.
- **신뢰도**: 자사+GitHub — 중상.

### A-10. Sculptor (Imbue)

- **정체**: worktree 대신 **컨테이너 격리**를 택한 오픈소스 데스크톱. Pi 하니스+임의 터미널 에이전트.
- **눈에 띄는 것**:
  - **CI Babysitter**(experimental): 열린 PR을 30초 폴링→CI 실패/머지충돌 감지→워크스페이스가 **idle일 때만** 전용 "CI Babysitter" 에이전트 탭에 프롬프트(조사→수정→푸시). 재시도 상한(기본 3, 1~10), PR당 pause(재시작 후에도 기억), 프롬프트 편집 가능, 파이프라인 통과 시 카운터 리셋, 머지/클로즈 시 은퇴, 실패를 두 번 쏘지 않음(새 실패만 재장전), GitHub 레이트리밋 감안 자동 감속.
  - **Pairing Mode**: 컨테이너 작업 결과를 로컬 repo에 원클릭 적용.
  - Changes 탭=커밋 전 누적 diff, Commit 버튼이 **에이전트에게 커밋 메시지 작성을 시키고** 커밋(버튼 우클릭→프롬프트 편집), 파일별 Discard.
  - 스킬이 서브에이전트를 스폰 가능, JS/TS 플러그인, 하니스 교체.
- **Paseo가 베낼 것**: CI Babysitter는 "watcher agent"의 교과서 — Paseo의 heartbeat/schedule 위에 PR 감시+수리 루프로 직결. "작업 중엔 개입 안 함" 규칙이 중요.
- **약점**: 컨테이너는 worktree보다 무겁고 머신 요구량 큼, 커뮤니티 작음(⭐230).
- **신뢰도**: GitHub docs 원문 — 높음.

### A-11. Verdent

- **정체**: 목표→자동 분해→디스패치의 "Manager" 컨셉 데스크톱+IDE 브릿지.
- **눈에 띄는 것**: Manager가 목표를 단계/서브태스크로 나눠 워커에 배정, 전 프로젝트 칸반+리뷰 컬럼(태스크 보드가 기본 화면), Pulse=실시간 진행 피드, 자체 에이전트+BYOK 혼합.
- **Paseo가 베낼 것**: "사람이 카드를 나누는 게 아니라 Manager 에이전트가 분해" — Paseo의 orchestration 스킬과 결합 가능.
- **신뢰도**: 공식 docs — 중상.

### A-12~15 (간이)

- **Claude Code Studio**: 워크스페이스 분리(회사/개인), SSH+tmux, Broadcast(N개 세션 동시 지시), Task Chain, **Config Map**(CLAUDE.md/MCP/hooks/skills/memory 시각화), Activity Map. → Paseo: Config Map은 플러그인 후보.
- **opcode/Claudia**: 타임라인+체크포인트+세션 브랜치, 사용량/비용 대시보드, CC Agents 라이브러리, MCP GUI, CLAUDE.md 에디터. ⚠️ 공개 커밋 2025-10 이후 없음(CAS 검증) — **"스타 수≠활성"의 대표 사례**.
- **AionUi**(iOfficeAI, ⭐32.8k): 코딩+사무작업 "Cowork" 프레임, 20+ CLI 자동감지, cron, Telegram/WeChat/Lark/DingTalk 봇 원격, 다양한 포맷 프리뷰, MCP 관리. → 메신저 채널 원격은 아시아 시장에서 실수요.
- **OpenChamber**: OpenCode 멀티세션 GUI. 경량, 기능 깊이 얕음.

### B-1. Claude Desktop — Code 탭 (벤치마크의 사실상 표준)

- **정체**: Chat/Cowork/Code 3탭 통합 데스크톱. "세션"=독립 채팅+프로젝트 폴더, 사이드바 병렬.
- **눈에 띄는 것** (공식 문서 확인분):
  - **환경 선택**: Local/Cloud(Anthropic 인프라, 앱 꺼도 계속+claude.ai+모바일에서 조향)/SSH/WSL.
  - **권한 5단계**: Manual/AcceptEdits/Plan/Auto(백그라운드 안전 검사, 특정 모델+)/BypassPermissions(엔터프라이즈 정책 연동). 폴더별 기억.
  - **브라우저 페인**: dev 서버 자동 실행→스크린샷/DOM/클릭/폼으로 **자기 검증**, 서버 드롭다운+**Persist sessions**(쿠키/스토리지 유지), `.claude/launch.json`, 정적 파일/PDF/영상 프리뷰, 외부 사이트 탐색(사이트별 승인 카드 Allow once/Always/Deny, 서브도메인 개별, 안전 분류기가 외부 쓰기 액션 검사, allowlist/blocklist, Chrome 확장과 역할 분리: 로그인 필요 작업은 확장).
  - **Diff 리뷰**: 라인 클릭→코멘트→Cmd+Enter 배치 전송, **Review code** 버튼(컴파일 오류/논리 오류/보안 등 high-signal만 — 스타일/린터 영역은 제외한다고 명시), +N −M 인디케이터.
  - **PR 감시**: CI 상태 바, **Auto-fix**(실패 읽고 반복 수정), **Auto-merge**(체크 통과 시 squash), 완료 데스크톱 알림, 머지/클로즈 시 **세션 자동 아카이브** 옵션.
  - **페인 시스템**: chat/diff/browser/terminal/file/plan/tasks/subagent 드래그 배치+리사이즈+**윈도우 팝아웃**.
  - **View modes**: Normal(툴콜 요약)/Verbose(전부)/Summary(최종 응답+변경만) — 멀티세션 스캔용.
  - **Side chat**(`/btw`, Cmd+;): 세션 컨텍스트 읽되 메인 스레드 오염 없는 질의. 디스크 미저장.
  - **Tasks 페인**: 서브에이전트/백그라운드 쉘/dynamic workflows 목록+중지.
  - **Work across sessions**: 에이전트가 다른 세션 목록/내용 열람/메시지/아카이브(아카이브는 전 모드에서 사람 승인 필수, 메시지는 출처 카드+수신 세션의 인바운드 정책 검사, 감시자 없는 세션에서는 발신 불가). 범위: 데스크톱 세션 최근 20개(터미널 세션은 별도 cross-session 메시징 채널). **Task chips**: 현재 범위 밖 작업 발견 시 칩 제안→클릭하면 새 세션+워크트리.
  - 워크트리: `.claude/worktrees/`, 위치 커스텀, 브랜치 프리픽스, `.worktreeinclude`(gitignored 파일 포함).
  - **컴퓨터 사용**: 앱 카테고리별 고정 티어(브라우저=view only, 터미널/IDE=click only, 나머지=full), 세션 승인(Dispatch 세션은 30분), 거부 목록, 작업 중 다른 창 숨김, 도구 우선순위(커넥터>Bash>Chrome확장>iOS시뮬>화면제어).
  - Usage ring(세션 컨텍스트%+플랜 사용량), 스케줄 태스크, **Dispatch**(폰에서 세션 생성), 커넥터/스킬/플러그인, managed settings.
- **Paseo가 베낼 것**: side chat, view modes, task chips, PR 자동 아카이브, 브라우저 persist-sessions, 사이트별 승인 카드 모델, "high-signal만" 리뷰 프롬프트 설계.
- **약점**: Claude 온리, 팀/공유 없음, 데스크톱 세션만 상호 인식(터미널 세션 제외는 실제 혼란 포인트).
- **신뢰도**: 공식 docs 전문 — 매우 높음.

### B-2. Codex app (OpenAI)

- **정체**: "에이전트의 커맨드 센터" — 프로젝트로 조직된 스레드. macOS→Windows(2026-03).
- **눈에 띄는 것**: 내장 worktree(로컬 git state 건드리지 않고 진행), diff 인라인 코멘트, 에디터로 열어 수동 수정, CLI/IDE 확장의 이력·설정 흡수, **Skills 전용 UI**(생성/관리/명시 호출/자동 선택, 레포 체크인으로 팀 공유, 공식 라이브러리: Figma→코드, Linear 관리, Cloudflare/Netlify/Render/Vercel 배포, 이미지 생성, OpenAI API 문서, PDF/xlsx/docx), **Automations**(스케줄+스킬 결합, 결과는 **리뷰 큐**로), `/personality`(간결/정서적 두 스타일), 시스템 레벨 샌드박스+명령별 elevated 규칙, ChatGPT 구독 포함+크레딧 구매.
- **Paseo가 베낼 것**: 스킬 라이브러리 UX(제작→레포 체크인→팀 공유→자동 선택), 자동화 결과를 "리뷰 큐"로 받는 멘탈 모델, personality 프리셋.
- **약점**: OpenAI 온리, 생태계 종속.
- **신뢰도**: 공식 발표+docs — 높음.

### B-3. Antigravity 2.0 (Google)

- **정체**: IDE와 분리된 독립 에이전트 매니저(v2에서 Agent Manager→Projects 구조). AGY CLI/SDK/IDE 확장 5종까지 있는 스택.
- **눈에 띄는 것**: **Projects**(네이티브 워크트리, **프로젝트별 스코프드 설정**—Default/Full machine/Unrestricted 프리셋, 대화 중 수동 승인한 권한이 **프로젝트에 지속되어 "학습"**, 멀티폴더), 프로젝트 밖 스크래치 대화, 스케줄 태스크, **음성 전사+스마트 정리**(말더듬/자기수정 정리, 모든 입력면+artifact 코멘트에서), JSON hooks(툴콜 전/응답 후/루프 정지 시 로컬 스크립트), `/browser` 서브에이전트(DevTools MCP, **webm 영상 녹화**), **Remote Control**(웹 브라우저→데스크톱 세션, 푸시 알림), VCS 페인(미커밋/브랜치/에이전트 diff), Artifacts(Plan/Walkthrough/Screenshots/Browser Recordings에 **코멘트→에이전트 반영**), `/boost` 딥리즈닝, `/teamwork` 에이전트 팀, sidecars, AGY CLI(vim, headless, `/voice`, `/usage` 쿼터), SDK(personas/policies/lifecycle hooks/structured output).
- **Paseo가 베낼 것**: 프로젝트 스코프 권한이 "학습"되는 모델, artifact 코멘트 루프, 음성 스마트 정리, webm 검증 녹화.
- **약점**: Gemini 중심, 팀 협업 얕음.
- **신뢰도**: 공식 docs — 높음.

### B-4. OpenCode (anomalyco)

- **정체**: TUI/데스크톱/웹이 하나의 로컬 서버에 붙는 구조. 오픈소스 에이전트 자체이자 플랫폼.
- **눈에 띄는 것**: **세션 공유 링크→포크**(읽기전용 공유 후 누구나 분기), 세션 타임라인/fork/stash/compact/child 세션 네비게이션, 빌트인 에이전트 역할(Build/Plan/General/Explore/Scout), 75+ 프로바이더(models.dev)+ChatGPT Plus/Pro·Copilot 계정 로그인, LSP 자동, 플러그인(문제 시 플러그인 비활성화 가이드까지), 커스텀 키바인드 전면 설정.
- **Paseo가 베낼 것**: 공유→포크가 곧 "레시피 배포"라는 개념.
- **신뢰도**: 공식 docs — 높음.

### B-5. Devin Desktop (구 Windsurf, 2026-06-02 리브랜딩) — 신규 최상위 경쟁자

- **정체**: Windsurf IDE 위에 Agent Command Center를 **기본 서피스**로 올린 제품. Devin Cloud/Desktop/CLI/Review로 브랜드 통합.
- **눈에 띄는 것**: 로컬+클라우드 에이전트 **단일 칸반**, **Spaces** — 세션/PR/파일/컨텍스트를 묶어 **관련 에이전트끼리 컨텍스트 공유**(협업 단위), **ACP 수용**(Codex/Claude Agent/OpenCode/자체 제작 에이전트가 Devin과 같은 인터페이스·칸반·Spaces에), Devin Local(Cascade의 Rust 재작성, 30% 토큰 효율, 서브에이전트), IDE 완전 유지(VS Code 호환).
- **Paseo가 베낼 것**: **Spaces가 가장 중요** — "워크스페이스 그룹+공유 컨텍스트"는 amux groups와 같은 방향의 수렴 증거. Paseo도 workspace grouping+공유 메모리가 다음 프리미티브.
- **신뢰도**: 공식 블로그+docs — 높음.

### C. IDE 통합형 — 심화 요약

- **Cursor**: cloud agent가 PR에 **영상/스크린샷/로그**를 첨부(리뷰어가 체크아웃 없이 검증), 원격 데스크톱 탈취, Multi-Agent Judging(병렬 결과 자동 평가+승자 추천+이유), worktrees.json, automations, 모든 서피스(iOS/웹/Slack/GitHub/Linear `@cursor`). → Paseo: "증거 첨부형 PR"이 리뷰 UX의 다음 표준.
- **Kiro**: 5 서피스가 같은 하니스+컨텍스트 공유(IDE/CLI/Web/Mobile-TestFlight/**Crew**=24/7 상주 에이전트). **checkpoint(파일+컨텍스트 동시 복원) vs rewind(대화만 포크, 파일 불변)의 명시적 분리**는 개념적으로 깔끔. Specs(EARS), Steering, hooks, Powers(서드파티 capability 팩), compaction, autonomous mode.
- **Zed**: ACP 레지스트리+에이전트별 체크포인트+**"New From Summary"**(요약만 이어받아 새 스레드 — 컨텍스트 한계 대응).
- **Trae SOLO**: spec/plan 문서 직접 편집(계획=편집 가능한 산출물), Figma→코드.
- **Cline/Roo/Kilo**: 체크포인트+마켓플레이스(MCP/스킬)+worktree 병렬(Kilo).

### D. 클라우드 — 심화 요약

- **Devin Cloud**: **Automations의 3종 액션**(새 세션/기존 세션에 메시지/**triage monitor**=Slack 채널 상주 감시→필요 시 자식 세션 생성), Slack 인라인 키워드 언어(`!ask` 빠른 답, `!deep`, `mute/sleep/archive/EXIT`, `!fast/!lite/!ultra/!fusion/!swe` 모드 선택, `!dana` 데이터분석), Linear 연동 시 **신뢰도 🔴🟠🟢 표시**, Interactive Planning(초기 평가→상세 계획, 코드 인용 클릭 시 IDE 딥링크, 30초 무응답 자동진행 설정 가능), Session Insights(사후 분석).
- **Amp**: 스레드=URL/포크=레시피는 이미 유명. 2차 패스에서 확인: **orbs**(스레드당 전용 머신, 크기/비용 선택, secrets, 파일 첨부), **Portals**(orb 웹서버를 외부 노출), **Agent-to-Agent**(side quest 스폰, N개 팬아웃, **파일 교환**, 과거 스레드 발굴, 다른 프로젝트/**러너**=타 머신 위임), **Puck**=개인 비서(Ctrl+/ 어디서나, 에이전트 시작/조향/스레드 검색 `puck:true`/아카이브/프로젝트 생성/**여러 에이전트로 분해·취합**, Slack @Amp, 공유시트 이미지→Puck, Shortcuts 딕테이션), The Dial(노력도), Multiplayer/Space/Workspaces, 엔터프라이즈(셀프호스트 orbs, MCP allowlist, 스레드 가시성, 최소 데이터 보존). → Puck은 "오케스트레이션을 채팅 한 곳으로" — Paseo의 advisor 스킬을 상시 존재로 만든 형태.
- **Warp Oz**: 트리거/스케줄/연동(Slack/GitHub/Datadog), Runs 페이지(소스/상태/트리거/소유자 필터, 트랜스크립트 공유 링크), 로컬↔클라우드 핸드오프, Agent Profiles(자율성/모델/도구/명령 권한 프리셋 — "Safe&cautious"/"YOLO"), 셀프호스트 워커(daemon 또는 CI에서 `oz agent run`), 공유 컨텍스트 스택.
- **Copilot coding agent**: assignee 멘탈 모델, Actions 환경, 인간 승인 전 CI 차단, 커스텀 프로필, 모바일 assign.
- **Jules**: 계획 승인 게이트, 오디오 체인지로그(차별점은 작지만 인용 가치), 라벨 트리거, CLI/TUI.
- **Factory**: 프리뷰 탭(문서/슬라이드/시트/PDF/라이브 사이트/diff)+포인트-앤-코멘트, Missions, Custom Droids, exec CI 모드.
- **OpenHands**: 백엔드 교체(로컬/Docker/VM/클라우드), ACP 임의 에이전트, 사전빌드 자동화.
- **Replit**: 전체 상태 체크포인트(파일+대화+DB+환경)+롤백 미리보기, 모바일 앱 빌드 플로우.
- **Terragon**: 종료. 유산 `terry pull`, 레이트리밋 큐잉.

### E. 모바일/원격 — 심화

- **Happy**: `happy` CLI로 세션 시작→E2E 암호화 릴레이(TweetNaCl)→폰/데스크톱 키 하나 전환, 권한 푸시→1탭 승인, 오프라인 이력, 셀프호스트 가능, 무료. → Paseo 릴레이와 구조적으로 동일, "권한 승인이 모바일의 본질" 확인.
- **Omnara**: 로컬↔클라우드 핸드오프(노트북 오프라인 시 세션+미커밋 보존), 양방향 보이스, 폰에서 localhost 프리뷰, Orchestrator 서브에이전트, Apple Watch.
- **conductor-remote**(비공식): Conductor의 SQLite를 읽는 PWA. 라이브 워크스페이스 목록(상태/레포/브랜치/모델/ctx%), **폰에서 읽으면 unread 해제**(데스크톱과 다른 동기화 포인트), 트랜스크립트/디프, 프롬프트 전송 2전략(applescript=실제 UI 구동/sidecar), Tailscale Funnel 토큰 게이트. → "공식 모바일 부재를 커뮤니티가 메운다"는 수요 증거.
- **Telegram 브릿지**(xudong963): Conductor 채팅↔Telegram 토픽 바인딩, 실시간 스트림, 큐 상태, requestUserInput 처리, 슬래시 명령 자동 동기화.
- **SeaWork**: E2E 셀프호스트. **Claude Dispatch/Kiro iOS/Codex Remote**: 벤더 공식 폰→세션 시작/조향.

### F. TUI — 심화

- **claude-squad**: 원조 tmux+worktree TUI, yolo, diff→apply. **ccmanager**: 10+ 에이전트, 세션 간 컨텍스트 이관(대화 이력 복사→새 worktree), 상태변경 훅, DevContainer. **dmux**: tmux pane+worktree, 원키 머지, pre/post-merge 훅. **csq**: 멀티 Claude Max 계정 풀링+세션 내 `!csq swap` 무중단 교체+OAuth 자동갱신. **Gas Town**(steveyegge): 20~30 에이전트 극단 — Beads(git-backed 이슈 레저), Mayor(포먼), convoys, sling 할당, Hook 큐+GUPP(일 있으면 무조건 실행), Witness/Deacon 감시 에이전트, mailboxes. → 가스타운의 "감시 에이전트"와 amux 와치독은 같은 수렴.
- **agent-deck**: beaufour/orca(다른 orca!)의 백엔드 세션 매니저 — 이름 충돌 주의.

### G. 인접

- **Perplexity Computer**: ~19개 모델 자동 라우팅+서브에이전트+커넥터 400+, "디지털 워커". **Chorus**(meltylabs, OSS): 다중 모델 동시 스트리밍 나열+토큰/초 표시+**합성 답변** — Race 모드 결과 화면의 UX 레퍼런스. **AI Maestro**: 멀티머신 메시+에이전트 간 메일 프로토콜+3단계 트리 네이밍 자동 색상. **GitButler**: 버추얼 브랜치 레인+hunk 드래그 재배치+스택드 PR.

---

## 4. 기능별 파쿠리 포인트 (What to Steal) — v2 갱신

### 4.1 작업 단위 & 격리
- Worktree-per-task 기본기 + 설정 자동화: Conductor setup+`.worktreeinclude`, Superset lifecycle, Parallel Code `node_modules` 심링크, 포트 주입(`CONDUCTOR_PORT`/Paseo 프록시 포트).
- 컨테이너 격리+Pairing(Sculptor): 환경 공유 문제(포트/디펜던시/데몬)의 정답 후보.
- 멀티레포 워크스페이스(Orca 상위폴더, Antigravity 멀티폴더, Cursor 멀티레포 env).
- **Spaces/Groups = 공유 컨텍스트 묶음**(Devin Spaces, amux groups의 공유 메모리/환경/게이트) — 차세대 조직 단위.

### 4.2 리뷰 & 머지
- Diff 라인 주석→배치 전송(Orca/Claude Desktop/Conductor/Codex).
- **머지 레디니스 집계면**(Conductor Checks: git+CI+배포+코멘트+todo, 미해결 시 머지 억제).
- **PR 감시 자동화 스펙트럼**: 알림(대부분) → auto-fix(Claude Desktop) → auto-merge(Claude Desktop) → **전담 수리 에이전트(Sculptor CI Babysitter: idle 대기+재시도 상한+PR당 pause+커스텀 프롬프트)** → triage monitor(Devin).
- AI 보조 리뷰: Devin Review(hunk 논리 그룹핑+설명+심각도+인라인 Ask), Claude "Review code"(high-signal만 명시), Cursor judging.
- 증거 첨부형 PR: Cursor(영상/스크린샷/로그), Codex Appshots, Jules 오디오.
- GitButler hunk 재배치, 원버튼 PR(T3 Code/Conductor/Superset).

### 4.3 감독 & 주의력
- **"홈=인박스" 패턴**: Orca Agents feed(스레드형, 실행 중 상단 고정), Antigravity Inbox, amux owner alert.
- **3단계 알림 위계**: 조용히 기록(피드/보드) → 뱃지(사이드바/Dock) → 푸시(진짜 막힘만). 카테고리별 사운드/채널(Orca 커스텀 사운드, amux iMessage, Maestro 임의 명령).
- 사이드바 라이브 상태: 마지막 행동 한 줄+ctx%(Orca/amux peek/Conductor 게이지)+unread.
- Peek(읽기전용 터미널 엿보기), Config Map(Claude Code Studio), Director's Notes(전체 통합 타임라인+AI 요약, Maestro).
- **View modes**(Normal/Verbose/Summary)로 멀티세션 스캔 속도 확보.

### 4.4 에이전트 간 조정 — 최전선
- **공유 보드+CAS 클레임+증거 게이트**(amux) / 보드를 MCP로 에이전트에 노출(CAS).
- **출처 보장 메시징**: amux 서버 스탬핑, Claude Desktop 출처 카드+인바운드 정책 검사, Orca Run inbox+Dispatch ID.
- **질문 프리미티브**: Orca `ask`(옵션+타임아웃)/decision gate, Maestro 자문 vs 모더레이터 그룹챗.
- **코디네이터 계층**: Gas Town Mayor+감시자, Verdent Manager, Orca Run, **Amp Puck**(사람 말→분해/배정/취합), Devin triage monitor.
- **공유 컨텍스트**: Devin Spaces, amux groups, Warp 공유 컨텍스트 스택.
- Task Chain(CCS)/Broadcast(CCS, Orca)/group addresses(Orca `@idle` `@codex`).

### 4.5 스케줄 & 자동화
- cron 스케줄은 표준(Paseo 이미 보유). 차별점:
  - **이벤트 트리거**: Devin(Slack/GitHub/Linear/웹훅→세션 시작/기존 세션 메시지/triage), Warp Oz, OpenHands, Kiro hooks.
  - **실행 관측성**: Superset(실행 이력+실패 재시도+건강 스탯+태그 폴더링).
  - **Self-paced 루프**(amux) / **회복탄력성**(Maestro: 529 리셋 시간 읽어 재전송, amux 와치독) / **레이트리밋 큐잉**(Terragon 유산).
  - **플레이북**: Maestro Auto Run+Exchange, Amp 포크=레시피, Goose recipes, Codex 스킬 라이브러리.

### 4.6 모바일 & 원격
- 본질=**1탭 승인+needs-you 푸시**(Happy/Omnara/amux/Dispatch).
- 핸드오프 스펙트럼: 폰→데스크(Dispatch), 로컬↔클라우드(Omnara/Warp/`terry pull`), 웹→데스크(Antigravity Remote Control), QR/링크 페어링(Happy/Maestro/T3).
- 커버리지 경쟁: Apple Watch(Omnara), Telegram/WeChat/Lark(AionUi, 커뮤니티 브릿지), iMessage(amux).
- **unread 동기화 디테일**: conductor-remote는 폰에서 읽으면 unread 해제(데스크톱과 다른 정책) — 읽음 상태의 크로스디바이스 정책 설계 포인트.

### 4.7 세션 관리 & 이력
- 전문검색+재개(Nimbalyst/CAS/Maestro 자동발견), **포크/브랜치**(Nimbalyst/OpenCode/Amp/Kiro rewind), **체크포인트 스펙트럼**: 파일만(Zed/Cursor) → 파일+컨텍스트(Kiro checkpoint) → 파일+대화+DB+환경(Replit).
- 핸드오프 요약: Zed "New From Summary", Amp "Handoff and …", Devin→Spaces.
- **메시지 큐+스누즈+side chat**(Maestro/Claude Desktop) — 입력 UX의 숨은 보석.
- 자동명명(Maestro/CAS), unread 정책, 아카이브 자동화(PR 머지 시, Claude Desktop).

### 4.8 컴포저/입력
- `!` 쉘 모드(Maestro), @멘션(파일/에이전트/그룹), 이미지 어노테이터(편집 가능 상태), 드래그앤드롭, **권한 모드를 프로바이더별 의미 차이와 함께 문서화**(T3 Code), 스코프드 권한 학습(Antigravity), Plan/계획 문서 편집(Trae/Kiro/Jules/Devin 30초 자동진행), 음성+스마트 정리(Antigravity/Paseo).

### 4.9 프리뷰 & 검증
- 인앱 브라우저+element→프롬프트(Orca Design Mode, Codex 코멘트, Factory 포인트-앤-코멘트) — Paseo는 브라우저 도구가 있으니 **사람→에이전트 방향 picker**만 추가.
- dev 서버 표면화: Paseo 프록시 포트가 이미 최상위, 참고로 Amp Portals/Superset 원격 포워딩 리매핑.
- 검증 증거: 자동 검증(Claude: 스크린샷/DOM/클릭/폼), webm 녹화(Antigravity), PR 영상(Cursor), iOS 시뮬 페인(Claude), Expo QR(Replit).

### 4.10 사용량·비용·계정
- Usage 대시보드( Orca 5h/주+리셋, opcode 분석, Maestro 히트맵+CSV, Superset Usage, amux 세션별 비용, AGY `/usage`), 컨텍스트% 표시, **계정 풀링/핫스왑**(csq 무중단 스왑, Orca Codex 핫스왑, T3 멀티계정).

### 4.11 생태계 & 팀
- 스킬/플레이북 마켓(Codex 라이브러리, Maestro Exchange, CAS, Kiro Powers, crystl 브라우저) — Paseo 플러그인+Hub 방향과 일치.
- 멀티플레이어(Nimbalyst 실시간, Amp Multiplayer/Space, Warp 팀 관측, Vibe Kanban 공유, Paseo Hub).

---

## 5. UI/UX 패턴 정리 — v2

| 패턴 | 모범 사례 | 메모 |
|---|---|---|
| 홈 = "무엇이 나를 필요로 하나" | Orca Agents feed, amux owner alert, Antigravity Inbox | 첫 질문은 "뭐 만들까"가 아니라 "뭐가 막혔나" |
| 스레드형 활동 피드 | Orca Agents feed(실행 중 상단 고정+응답 미리보기) | 알림과 별개로 "돌아왔을 때 읽는 면" |
| 3단계 알림 위계 | amux(보드/뱃지/푸시+iMessage) | 알림 피로=리텐션 킬러 |
| 사이드바=세션+라이브 상태 한 줄 | Orca(마지막 행동), Conductor, Claude Desktop | 아이콘보다 텍스트 |
| 칸반을 작업 단위로 | Devin Desktop(기본 화면), Nimbalyst, amux/CAS/Verdent | 리뷰 컬럼 필수 |
| ⌘K 커맨드 팔레트 | Maestro(~100 바인딩+마스터리 트래킹) | 파워유저 유지율 |
| 스레드=공유 가능 URL→포크 | Amp, OpenCode, Warp | 팀 협업의 기본 단위 |
| 페인 자유 배치+팝아웃 | Claude Desktop, Orca 무한 스플릿, Maestro 타일링 | 채팅/diff/브라우저/터미널 |
| 트랜스크립트 상세도 토글 | Claude Desktop(Normal/Verbose/Summary) | 멀티세션 스캔용 |
| 메타 채널 분리 | Claude side chat(`/btw`), Nimbalyst 메타챗 | 세션 오염 없는 질의 |
| 진행 문서화 | Kiro Specs, Trae plan, Antigravity Artifacts+코멘트 | 계획=편집 가능 산출물 |
| 증거 첨부 | Cursor PR 영상, Codex Appshots | "체크아웃 없이 검증" |
| 자동명명+색상 | Maestro, AI Maestro | "New Session 43" 해결 |
| 페어링=QR/링크 | Happy, Maestro, T3 | 모바일 온보딩 마찰 제거 |
| 컴포저 내 상태 | Claude usage ring, 권한/모델 셀렉터 | 숨기지 않기 |
| 게임화/피지컬 | Codex Pets/Micro, Maestro 업적 | 바이럴 요소 |
| 에이전트가 UI 렌더 | Maestro Concerto(네이티브 패널/HUD) | Paseo 플러그인 서피스로 가능 |
| 코디네이터=채팅 | Amp Puck(Ctrl+/ 어디서나) | 오케스트레이션의 자연어화 |

---

## 6. Paseo 관점: 갭 분석과 우선순위 제안 — v2

### Paseo가 이미 선두인 영역
데몬-클라이언트 분리(멀티 호스트+셀프호스트), 네이티브 모바일 parity+E2E 릴레이, 로컬 퍼스트 음성, worktree 프록시 포트, 플러그인 시스템(서피스/패널/컴포저 pill/타임라인 변환/테마/RPC), Hub(멘션→에이전트), schedules/heartbeats, 프로바이더 폭(30+, ACP), 오케스트레이션 스킬(handoff/advisor/committee), 브라우저 자동화 도구, 메타데이터 자동생성(브랜치/커밋/PR).

### P0 — 경쟁사 표준 중 결정적 갭
1. **Needs-you 인박스/Agents feed**: 전 워크스페이스 이벤트를 스레드형 피드로(완료/블로킹/응답 미리보기/워크스페이스 생성), 실행 중 상단 고정, 3단계 알림 위계(피드 기록/뱃지/푸시는 진짜 블로커만). [Orca/amux/Antigravity]
2. **에이전트 갱신 가능한 태스크 보드**: 카드+상태 컬럼+MCP로 에이전트가 갱신. CAS 클레임, `blocked_on`, done=증거, verified=피어 체크까지가 차별화. [amux/CAS/Verdent]
3. **Diff 라인 코멘트→에이전트 반송** + 머지 레디니스 면(git/CI/코멘트/todo 집계). [Claude Desktop/Orca/Conductor]
4. **에이전트↔에이전트 프로토콜**: `@에이전트` 자문(단발), 작업 위임(완료 콜백), 출처 스탬핑, 피어 peek, task chain. Paseo의 notifyOnFinish/subagents 위에 명시적 레이어. [Maestro/amux/Orca/Claude]
5. **와치독/회복**: 크래시 감지·재시작·마지막 메시지 리플레이, 컨텍스트% 자동 compact, 529/쿼터 시 리셋 시간 읽고 재전송. [amux/Maestro]
6. **세션 전문검색+재개+포크**: 트랜스크립트 FTS, 임의 지점 분기. [Nimbalyst/CAS/OpenCode]

### P1 — 차별화
7. **Race 모드**: 동일 프롬프트 N provider 병렬→비교(Chorus식 나열)→승자 머지(+심판 에이전트). 멀티프로바이더 강점과 정확히 일치. [Orca/Cursor/Superset recipe]
8. **PR 워처**: CI 실패/충돌 시 idle 대기 후 전담 세션이 수리(재시도 상한+PR당 pause). Sculptor babysitter 패턴 → Paseo heartbeat+schedule로 구현 자연스러움.
9. **Workspace 그룹+공유 컨텍스트(Spaces)**: 레인별 공유 메모리/환경/게이트. [Devin Spaces/amux groups]
10. **Usage/계정 대시보드**: provider별 사용량+레이트리밋 리셋+계정 스위처(+멀티계정 풀링). [Orca/csq/Maestro]
11. **Element-picker→프롬프트** + artifact 코멘트 루프. [Orca/Antigravity/Factory]
12. **입력 UX 삼총사**: 메시지 큐(편집/재정렬/보류), 탭 스누즈(자연어 귀환+프롬프트 자동실행), side chat(오염 없는 질의). [Maestro/Claude]
13. **플레이북**: 마크다운 체크리스트 순차 실행+커뮤니티 임포트 — skills와 연결. [Maestro/Codex]
14. **이벤트 트리거**: GitHub/Linear/웹훅→새 세션 또는 기존 세션 메시지. [Devin/Warp/OpenHands]
15. **퍼스널 코디네이터**: advisor 스킬을 Puck처럼 상시 채널(Ctrl+/, 스레드 검색/아카이브/분해·취합)로. [Amp]

### P2 — 완성도/실험
16. 체크포인트 vs rewind 분리(파일+컨텍스트 복원 / 대화만 포크), Config Map, view modes, 커스텀 알림 사운드/임의 명령, `!` 쉘 모드, 이미지 어노테이터, Director's Notes(통합 타임라인+AI 요약), Concerto식 에이전트 렌더 패널(플러그인), webm 검증 녹화, 오디오 체인지로그, 메신저 채널(Telegram/iMessage), 멀티플레이어, 게임화.

### 리스크/트레이드오프
- **기능 폭=복잡도**: Maestro/Claude Desktop이 보여주듯 표면적 단순함(Encore features, 프리셋) 없이는 압도됨. P0는 "인박스+보드+리뷰 루프"처럼 하나의 멘탈 모델로 묶어 출시 권장.
- **보안**: Conductor 샌드박스 이탈 사례 — 래퍼가 사용자 격리 설정을 조용히 덮으면 신뢰 붕괴. 권한/샌드박스 정책은 사용자 설정 우선을 명시.
- **벤더 수렴 리스크**: 모든 모델 회사가 커맨드센터를 낸 지금, Paseo의 moat는 프로바이더 중립+셀프호스트+모바일+플러그인 생태계. 단일 벤더 기능 종속(예: Claude 전용 권한 API)에 기대지 말 것.
- **자동화 안전**: Superset이 명시하듯 at-least-once/멱등 프롬프트 가이드 필요.

---

## 7. 전략 메모

- **"래퍼"는 죽고 "조정면"이 산다**: Crystal/Terragon/Vibe Kanban/opcode의 정체는 세션 래핑의 한계. 가치는 리뷰(Conductor), 조정(amux/Gas Town), 생태계(Orca/Paseo)로 이동.
- **모바일은 푸시 승인이 본질**: 본격 코딩이 아니라 "막힌 에이전트를 1탭으로 풀기". Paseo는 이미 최상위권 — needs-you 신호 품질이 다음 승부처.
- **ACP가 연합 프로토콜로 부상**: Zed/JetBrains/OpenHands/Kiro/Devin Desktop이 ACP로 외부 에이전트 수용. Paseo의 ACP 지원 방향 정합.
- **공유 컨텍스트 그룹이 신 프리미티브**: Devin Spaces, amux groups — "워크스페이스 묶음+레인별 메모리/정책"이 팀 스케일의 단위가 됨.
- **코디네이터의 자연어화**: Puck(Amp)/Mayor(Gas Town)/Run(Orca)/triage(Devin) — "사람은 결과를 받고, 코디네이터가 분해·감시·취합"이 수렴점.
- **감시 에이전트는 카테고리가 됨**: 와치독(amux), Witness/Deacon(Gas Town), CI Babysitter(Sculptor), triage monitor(Devin) — 에이전트가 에이전트를 보살핀다.

---

## 8. 부록 — 1차 자료 링크

- Paseo: https://paseo.sh · https://github.com/getpaseo/paseo
- Orca: https://www.onorca.dev · https://www.onorca.dev/docs (orchestration, notifications, activity) · https://github.com/stablyai/orca
- Conductor: https://www.conductor.build/docs (workflow, checks)
- Superset: https://docs.superset.sh (tasks, agent-status, automations, remote-access)
- Nimbalyst: https://nimbalyst.com · https://docs.nimbalyst.com
- T3 Code: https://t3.codes · https://github.com/pingdotgg/t3code (docs/user/permission-modes.md)
- amux: https://amux.io
- Maestro: https://docs.runmaestro.ai/features
- CodeAgentSwarm: https://www.codeagentswarm.com/en/guides/best-tools-to-run-multiple-ai-coding-agents
- Parallel Code: https://parallelcode.app/compare/
- Sculptor: https://github.com/imbue-ai/sculptor (docs/help/ci_babysitter.md, changes.md)
- Verdent: https://www.verdent.ai/docs
- opcode/Claudia: https://github.com/getAsterisk/claudia
- Claude Code Studio: https://github.com/wat-hiroaki/claude-code-studio
- AionUi: https://github.com/iOfficeAI/AionUi
- Claude Desktop Code: https://code.claude.com/docs/en/desktop
- Codex app: https://openai.com/index/introducing-the-codex-app
- Antigravity: https://www.antigravity.google/docs/features/
- OpenCode: https://opencode.ai/docs/
- Devin Desktop: https://devin.ai/blog/windsurf-is-now-devin-desktop · https://docs.devin.ai/desktop/devin-desktop-faq
- Devin Cloud: https://docs.devin.ai/work-with-devin/interactive-planning · https://docs.devin.ai/product-guides/automations · https://docs.devinenterprise.com/integrations/slack
- Cursor cloud agents: https://cursor.com/docs/cloud-agent
- Zed ACP: https://zed.dev/docs/ai/external-agents
- Kiro: https://kiro.dev/docs (checkpoints, mobile)
- Trae SOLO: https://docs.trae.ai/ide/solo-mode
- Copilot agent: https://docs.github.com/en/copilot/how-tos/use-copilot-agents
- Jules: https://jules.google/docs
- Factory: https://docs.factory.ai
- Amp: https://ampcode.com/docs (orbs/agent-to-agent, puck)
- OpenHands: https://github.com/OpenHands/agent-server-gui
- Warp: https://docs.warp.dev/agents · https://docs.warp.dev/platform/
- Replit: https://docs.replit.com/features/agent/overview
- Happy: https://github.com/slopus/happy
- Omnara: https://omnara.com
- conductor-remote: https://github.com/hyldmo/conductor-remote
- Gas Town: https://github.com/steveyegge/gastown
- Perplexity Computer: https://www.perplexity.ai/products/computer
- AI Maestro: https://github.com/23blocks-OS/ai-maestro
- GitButler: https://docs.gitbutler.com
- Chorus(UX 참조): https://chorus.sh
