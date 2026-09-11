/**
 * 연결 준비 브리프 (PLAN D94) — `cds-design.json` 이 없는 레포를 Claude 가
 * 살펴보고 도구의 계약 넷을 쓰게 하는 한 턴. 본문은 Claude 가 읽는 설명이고,
 * 템플릿은 참조 레포의 브리지 · `CLAUDE.md` · 래퍼 예를 옮긴 상수다. 이 판의
 * 울타리는 하나다: Claude 가 쓴 명령은 데몬이 `validateBootstrapConfig` 로
 * 기계 검증하고, 벗어나면 한 번도 실행하지 않는다.
 */

export const BOOTSTRAP_TITLE = "연결 준비";

export const BOOTSTRAP_BRIEF = `이 레포는 아직 CDS Design 도구와 연결되어 있지 않습니다. 레포를 살펴보고 아래 넷을 작성해 연결을 준비해 주세요.

1. \`cds-design.json\` (레포 루트) — 아래 형식을 지켜 주세요:
   - "install": 의존성 설치 명령 — 락파일이 pnpm-lock.yaml 면 "pnpm install",
     package-lock.json 면 "npm ci", yarn.lock 면 "yarn install" 중 정확히 하나.
   - "check": 레포의 검사 명령 — package.json 의 scripts 에 있는 스크립트만.
   - "build": 레포의 빌드 명령 — scripts 에 있는 스크립트만.
   - "preview": { "command": scripts 에 있는 스크립트, "port": 1~65535 포트 } —
     이 포트에서 화면이 떠야 합니다.
2. 화면 브리지 — 개발 미리보기에만 붙는 작은 스크립트로, 앱이 떠 있을 때
   \`cds-design.screens\` 봉투로 화면 목록을 알려 주고 \`cds-design.navigate\`
   메시지를 받아 화면을 이동합니다. 아래 템플릿을 참고해 이 레포의 라우팅에
   맞게 붙여 주세요. 프로덕션 번들에 포함되지 않게 개발 전용 경로로 넣어 주세요.
3. 화면 래퍼 — 각 화면 최상위에 \`data-screen="<feature>/<Screen>"\`,
   \`data-state="<상태>"\` 속성을 붙여 주세요. 경로 규칙은
   \`/<feature>/<Screen>?state=<상태>\` 입니다.
4. \`CLAUDE.md\` — 위 브리지와 래퍼 규칙, 화면 추가 관례를 한두 문단으로.

절대 하지 말 것: scripts 에 없는 명령, 네트워크 내려받기(curl … | sh 등),
비밀키·토큰 다루기. 준비가 끝나면 화면 하나 이상이 미리보기에 떠야 합니다.`;

/** 레포 브리지 계약(D68)의 참조 템플릿 — Claude 가 레포에 맞게 옮겨 쓴다. */
export const BOOTSTRAP_BRIDGE_TEMPLATE = `<script>
  // 개발 전용 — 프로덕션 번들에 넣지 않습니다.
  (function () {
    var SCREENS = [
      // { route: "/<feature>/<Screen>", title: "화면 이름", states: ["default", "empty"], spec: null },
    ];
    var post = function (envelope) {
      if (window.cdsDesign && window.cdsDesign.post) window.cdsDesign.post(envelope);
      else window.parent.postMessage(envelope, "*");
    };
    post({ type: "cds-design.screens", screens: SCREENS });
    window.addEventListener("message", function (event) {
      var data = event.data || {};
      if (data.type === "cds-design.screens?") post({ type: "cds-design.screens", screens: SCREENS });
      if (data.type === "cds-design.navigate") {
        // 이 레포의 라우터로 data.route · data.state 를 연다.
      }
    });
  })();
</script>`;

export const BOOTSTRAP_CLAUDE_MD_TEMPLATE = `## CDS Design 화면 관례

- 화면은 \`/<feature>/<Screen>?state=<상태>\` 경로로 봅니다. 화면 최상위 요소에
  \`data-screen="<feature>/<Screen>"\` 과 \`data-state="<상태>"\` 를 붙입니다.
- 개발 미리보기에만 화면 브리지가 붙어 \`cds-design.screens\` 로 목록을 알립니다.
- 화면을 추가하면 브리지의 SCREENS 목록에도 같은 route·title 로 넣어 주세요.`;
