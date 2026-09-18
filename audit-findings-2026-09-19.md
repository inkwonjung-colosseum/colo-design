# colo-design 교차 코드 감사 — 감사 결과

## 2026-09-19 — 3역할 교차 감사 (webview 전환 · home 우선 워크스페이스 이후)

- 기준점: `b5661cdf` (webview 호스트 전환 + P1 후속 커밋 직후). 전회 감사(audit-findings-2026-09-18.md, 202건 승인) 이후 변경분과 미커버 영역 대상.
- 방법: 라운드 1 — 독립 스캔 에이전트 5개(영역 분할: daemon-core / daemon-repo·preview / web / desktop / protocol·scripts·문서)가 서로 결과를 공유하지 않고 개별 판독. 라운드 2 — 반론 에이전트가 critical/major 9건을 전건 재검증(소스 직접 판독, 도구 호출 40+회). 라운드 3 — 리드(swe-2)가 파일:라인 재검증 후 합의분 구현.
- 역할 운영에 관한 투명성 노트: 이 환경에서는 서로 다른 모델 가중치를 기동할 수 없으므로, 3개 역할(swe-2 리드 / glm-5.3 검토 / glm-5.3-flash 스캐너·반론)은 **독립 컨텍스트의 분리 에이전트**로 에뮬레이션했다(결과 비공개 상태로 개별 판독 → 상호 검증). 독립성 성질은 유지되나 모델 다양성은 없다.
- 결과 요약: 라운드 1 후보 29건 → 라운드 2 반론·리드 검증 → **합의 9건(critical 1 · major 7 · major-security 1) 구현**, 기각 3건, 격하 1건, 보류 2건. minor 7건 목록 보고.

### 합의된 수정 (구현 완료)

1. **[critical] scripts/test-parallel.mjs:116** — L5 레인이 삭제된 `test:desktop-cover` 스크립트를 참조해 기본 `pnpm test` 즉시 사망(webview 전환 커밋에서 스크립트만 삭제하고 러너 미수정 — 전환 회귀). 수정: 레인에서 항목 제거. 재현: 수정 전 `pnpm test`는 `suite 'test:desktop-cover' is not a package.json script`로 exit(2).
2. **[major] packages/desktop/src/preview-view.ts:1046-1058** — did-attach 클레임의 같은 origin 재부착 분기가 `page.contents = guest` 후 `this.attach(page)`를 호출하지 않아 재부착 게스트에 팝업 핸들러·이동 가드·did-navigate·콘솔·키 전달이 전부 누락(webview 전환 회귀). 수정: 재부착 분기에서 `this.attach(page)` 호출.
3. **[major] packages/daemon/src/session.ts:1216-1244** — interrupt의 `outcome === "dead"` 분기가 settleTransport 없이 dropHeld+closed만 수행 → `this.pending` 잔존 → anyBusy가 waiting_permission을 세어 데스크톱 종료 가드가 영원히 막힘. 수정: dead 분기에서 `this.settleTransport()` 호출(다른 모든 사망 경로 :608/:643과 동일).
4. **[major] packages/daemon/src/dispatch.ts:222, :864** — 죽은 세션 정리·resurrect가 `manager.close(id)` 기본 reason("user")으로 닫으면서 `disk.clear()`로 lost room(크래시 복구 패널 대기 말)까지 삭제. 수정: 두 경로 모두 `close(id, "shutdown")`로 lost room 보존.
5. **[major] packages/daemon/src/dispatch.ts:731-748** — session.rewind가 running/starting 턴을 막지 않고 checkpointRestore로 워크트리를 되돌림(복원 뒤 에이전트 쓰기 혼입으로 rewind 계약 붕괴). 수정: running/starting 거절("돌고 있는 턴이 있습니다 — 중지한 뒤에 되감을 수 있습니다").
6. **[major] packages/web/src/components/preview/PreviewFrame.tsx:85-94** — webview 전환에서 NativeHost의 `useEffect(() => syncPins(), [sync])` 누락 → 핀 추가·삭제·메모·ghost 변경이 오버레이 배지에 내비게이션 때까지 반영되지 않음(전환 회귀; ScreenPanel.tsx:347-350의 계약 주석과 불일치). 수정: 효과 복원.
7. **[major] packages/web/src/components/preview/PreviewHost.tsx** — stopped/blank 조기 반환 시 PreviewFrame 언마운트 → `<webview>` 요소 철거로 모든 warm 게스트 사막 + main이 `destroyed`로 잊음(프로젝트 하나의 서버 재시작이 다른 프로젝트의 warm 페이지까지 소멸). 수정: 조기 반환을 제거하고 중단 카드·빈 화면을 무대 위 불투명 덮개(`preview__shade`)로 렌더 — 게스트는 덮개 아래 마운트 유지.
8. **[major] packages/web/src/hooks/usePins.ts:135-142 + packages/web/src/components/preview/PreviewFrame.tsx:151-161** — (a) 프로젝트 전환 시 recordError 미리셋 → 이전 프로젝트 기록 실패 경고가 새 프로젝트 동일 실패에 재차 안 뜸, (b) mount→open 체인의 reject 미처리(void 스왈로). 수정: 슬러그 전환 시 setRecordError(null), mount→open 체인 catch.
9. **[major-security] packages/desktop/src/preview-view.ts:1046-1058 (C2와 동일 자리)** — 재부착 게스트가 setWindowOpenHandler 없는 채 노출되면 펜스 없는 네이티브 자식 창 허용(보안 등가). 2번 수정으로 함께 정리.

### 적용 변경 요약 + 테스트 결과

- 패키지별: scripts/test-parallel.mjs(1행), packages/desktop/src/preview-view.ts(클레임 재부착 attach), packages/daemon/src/session.ts(dead 분기 settleTransport), packages/daemon/src/dispatch.ts(rewind 가드 + shutdown close ×2), packages/web/src/components/preview/PreviewFrame.tsx(동기 효과 + mount 체인 catch), packages/web/src/components/preview/PreviewHost.tsx(덮개 구조), packages/web/src/hooks/usePins.ts(recordError 리셋), packages/web/src/styles.css(shade), README.md(삭제 스크립트 행 제거 + webview 구조 갱신), packages/web/src/components/shell/HistoryDrawer.tsx(주석 갱신), docs/preview-proxy-agent-plan.md(진단 기록).
- 검증: `pnpm typecheck` 0 error · `pnpm build` 성공 · `pnpm test:unit` 334/334 · `test:rewind` 8/8 · `test:crash` 6/6 · `test:comments-ui` 28/28(전건 통과 — 6번 수정이 "트레이 잔여" 실패의 원인이었고 함께 해결됨) · `test:desktop-switch` 7/7 · `test:pane` · `test:browser-driver` · `test:desktop-unit` 33/33 · `test:desktop-smoke` 10/10 · `test:browser-mcp` 6/6 · `test:contrast` 0 failures.
- 재현 테스트: 1번(러너)은 수정 전 `pnpm test` 즉시 exit(2)가 재현이며 수정 후 레인 정상 기동으로 대체 확인(전체 스위트 특성상 단위 재현은 생략). 3·4·5번은 session/dispatch 수준 재현이 e2e 하네스에 결합되어 있어 해당 e2e(test:rewind·test:crash) 회귀 없음으로 검증.

### 전체 `pnpm test` 결과와 표본 분석 (구현 종료 후 1회)

- 전체 스위트: 6레인 중 실패 레인 3개(L2 rewind·midturn-queue, L3 clear-all-ui·sidebar-ui·onboarding-ui, L5 comments-ui) + 성공 레인 다수. 표본 재실행으로 성격 분리:
  - `test:rewind`(7/8)·`test:midturn-queue`(28/30): **기준점 커밋(b5661cdf, round-3 수정 stash)에서 동일 실패 재현** — 선존재 WIP 드리프트(images→attachments 리네임 미적용 단언, checkpoint 2 대기 타임아웃). round-3 수정과 무관.
  - `test:clear-all-ui`: 단독 실행 5/5 통과 — 병행 실행 플레이크.
  - `test:sidebar-ui`(29/30): popover 위치 1건 — sidebar는 본 감사 수정 파일과 교집합 없음(수정 CSS는 .preview 스코프), WIP 드리프트로 판정.
  - `test:comments-ui`: 단독 28/28 전건 통과, 병행 실행 시 타이밍 플레이크 존재(ⓣ 드래그).
- 결론: round-3 수정으로 인한 신규 실패 없음. 선존재 실패(WIP 드리프트 3건 + 병행 플레이크)는 별도 목록으로 보고.


### 보류한 minor 목록과 사유

1. preview-view.ts 펜스가 포트를 묶지 않음(렌더러 침해 시 로컬 포트 스캔 가능) — 하드닝 후보, 플러밍 필요(daemon origin 전달).
2. self-update TOCTOU(다운로드 → 검증 1회 → detached 교체) — 수정은 교체 스크립트 내 재검증 추가인데 실제 업데이트 흐름 e2e가 없어 무시험 변경이 릴리스 경로에 들어가는 리스크. 별도 작업 권고.
3. smoke-live.mjs 인자 검증 부재 — 개인 스크립트 성격.
4. preview:mount의 `origins` 사망 파라미터 — 제거 시 preload·d.ts·호출부 3곳 동시 수정 필요(무행위 차이).
5. desktop-bridge.d.ts/preload.ts의 onError `kind: string` 재선언(프로토콜 유니언과 불일치) — 타입 정리.
6. docs/preview-subsystem-inventory.md webview 전환 이전 서술 — 전면 재작성 필요(부분 수정보다 신규 기술 권고).
7. titleForScreen 사슬(chat-preview 전용) — 화면 목록 제거 WIP의 귀속 결정.

### 합의 실패 항목과 각 모델 입장

- **claude-trust ENFORCE 경로의 statusLine·apiKeyHelper·mcpServers 누락**: 스캐너는 보고 유지 주장. 리드는 docs/repo-settings-trust.md와 커밋 97f907ed·6751c2a7·c3436dec의 운영 결정(기본 신뢰로 뒤집고, 남은 확장 벡터를 의도적으로 개방, ENFORCE는 외부 레포 배포용 옵션)을 근거로 **코드 수정 보류** 판정 — 문서화된 수용이며, ENFORCE 경로의 키 추가는 별도 운영 결정 사항으로 minor 성격으로 기록한다.
- **session-manager fork 대기 루프(init 조기 break → memoryKept 오표시)**: 스캐너는 major 주장. 리드 검증 결과 루프가 init에도 깨지는 것은 사실이나, 거절 turn.end가 init 뒤에 도착하는 실제 CLI 이벤트 순서가 검증되지 않아(실제 CLI resume 거부 시나리오 재현 불가) 수정이 fork 의미를 바꿀 위험이 있다. **보류** — 실제 CLI에서 거절 시 이벤트 순서를 확인한 뒤 처리.
- **PreviewFrame void IPC reject 스왈로 전반**: 리드는 mount→open 체인(사용자 가시 경로)만 catch로 수정했고, 나머지 fire-and-forget 채널의 전면 래퍼 도입은 스캐너가 유지, 리드는 과도한 변경으로 기각(합의: 현 구조 유지).
