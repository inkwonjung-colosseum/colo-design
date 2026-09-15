/**
 * 연결 준비 브리프 (PLAN D94) — `colo-design.json` 이 없는 레포를 Claude 가
 * 살펴보고 도구의 계약 넷을 쓰게 하는 한 턴. 이 판의 울타리는 하나다: 준비 턴이
 * 설정 파일에 적는 것은 미리보기 포트 하나이고, 명령이 적힌 파일은 데몬이
 * `validateBootstrapOverrides` 로 거부한다 — 설치 · 검사 · 빌드 · 미리보기
 * 명령은 레포의 락파일과 `package.json` 의 scripts 에서 읽는다(repo-config.ts).
 *
 * 관례 최신화 (커미티 판정 2026-09-14): bootstrap 은 계약이 없는 레포에만
 * 돌고 재실행 길이 없으므로, 한 번 연결된 레포의 관례는 연결 시점의 판에
 * 영구 고정된다. CONVENTIONS_REVISION 와 CLAUDE.md 첫 줄의 표식이 그 드리프트를
 * 읽게 하고, REFRESH_BRIEF 턴이 현행 판으로 다시 쓴다 — 결과는 저장 → 넘기기
 * 파이프라인을 타므로 승인자는 개발자의 PR 리뷰다.
 */

export const BOOTSTRAP_TITLE = "연결 준비";

/**
 * 연결 관례의 판. 브리프가 관례에 대해 하는 말이 바뀌면 이 숫자를 올린다 —
 * 낡은 표식을 단 레포는 다시 최신화 대상이 된다.
 */
export const CONVENTIONS_REVISION = 1;

/** CLAUDE.md 첫 줄의 표식 — 도구가 관례의 판을 읽는 유일한 흔적. */
export const conventionsMarker = (revision: number): string =>
  `<!-- colo-design-conventions: v${revision} -->`;

/** 텍스트에서 관례의 판을 읽는다. 표식이 없거나 숫자가 아니면 null. */
export function conventionsRevision(claudeMd: string): number | null {
  const hit = /<!--\s*colo-design-conventions:\s*v(\d+)\s*-->/.exec(claudeMd);
  return hit ? Number(hit[1]) : null;
}

/**
 * 브리프가 "아래 템플릿" 이라 부르는 것 — 실제로 함께 나가는 두 조각.
 * 레포마다 라우터도 JSX 파이프라인도 다르므로 준비 턴이 고쳐 쓸 출발점이지,
 * 그대로 복사해 넣으라는 정답이 아니다. 도구가 읽는 것은 여기 적힌 봉투
 * 이름과 속성 이름뿐이고, 그것들만 바뀌지 않으면 된다.
 */
const BRIDGE_TEMPLATE = `## 화면 브리지 템플릿

\`\`\`ts
// src/dev/colo-bridge.ts — 개발 전용. 프로덕션 번들에 넣지 마세요.
declare global {
  interface Window {
    coloDesign?: { post(envelope: unknown): void };
  }
}

/** 이 레포가 그릴 수 있는 것 전부. */
const SCREENS = [
  { route: "/member/MemberList", title: "회원 목록", states: ["default", "empty"] },
];

/** 데스크톱 네이티브 뷰는 window.coloDesign, 브라우저 개발 경로는 부모 iframe. */
function post(envelope: unknown): void {
  if (window.coloDesign) window.coloDesign.post(envelope);
  else if (window.parent !== window) window.parent.postMessage(envelope, "*");
}

const announce = () => post({ type: "colo-design.screens", screens: SCREENS });
announce();

window.addEventListener("message", (event) => {
  const data = event.data;
  // 도구가 목록을 다시 묻는다(오버레이가 다시 붙었을 때).
  if (data?.type === "colo-design.screens?") return announce();
  // 도구가 화면을 하나 열라고 한다.
  if (data?.type !== "colo-design.navigate" || typeof data.route !== "string") return;
  const state = typeof data.state === "string" && data.state ? data.state : null;
  // 이동은 이 레포의 라우터가 합니다 — react-router 면 navigate(), 직접
  // 라우팅이면 history.pushState + 리렌더. 도구는 레포의 url 에 관여하지 않습니다.
  navigateTo(data.route + (state ? \`?state=\${state}\` : ""));
});
\`\`\`

진입점에서 개발일 때만 부릅니다: \`if (import.meta.env.DEV) void import("./dev/colo-bridge");\``;

const SRC_MARKER_TEMPLATE = `## 소스 표식 템플릿 (선택)

JSX 를 AST 로 고치는 자리에 붙입니다 — 문자열 치환은 코드 안의 문자열까지
건드리므로 쓰지 마세요. 아래는 \`@vitejs/plugin-react\`(babel)를 쓰는 레포의
예이고, SWC 나 다른 파이프라인이면 같은 규칙(소문자 태그만 · 개발 빌드만)으로
그쪽 변환기에 맞춰 주세요.

\`\`\`js
// babel-plugin-colo-src.cjs — 개발 전용.
module.exports = ({ types: t }) => ({
  visitor: {
    JSXOpeningElement(path, state) {
      const name = path.node.name;
      // 소문자로 시작하는 태그만 = 실제 DOM 요소. 컴포넌트 태그는 그대로 둔다.
      if (name.type !== "JSXIdentifier" || !/^[a-z]/.test(name.name)) return;
      const line = path.node.loc?.start.line;
      const file = state.filename?.replace(\`\${state.cwd}/\`, "");
      if (!line || !file) return;
      path.node.attributes.push(
        t.jsxAttribute(t.jsxIdentifier("data-colo-src"), t.stringLiteral(\`\${file}:\${line}\`)),
      );
    },
  },
});
\`\`\`

\`vite.config\` 에서 개발 실행에만 겁니다:

\`\`\`ts
react({ babel: { plugins: command === "serve" ? ["./babel-plugin-colo-src.cjs"] : [] } })
\`\`\``;

export const BOOTSTRAP_BRIEF = `이 레포는 아직 Colo Design 도구와 연결되어 있지 않습니다. 레포를 살펴보고 아래 다섯(마지막은 선택)을 작성해 연결을 준비해 주세요.

1. \`colo-design.json\` (레포 루트) — 딱 한 줄입니다:
   \`{ "preview": { "port": <개발 서버가 뜨는 포트> } }\`
   설치 · 검사 · 빌드 · 미리보기 명령은 적지 마세요 — 도구가 락파일과
   package.json 의 scripts 에서 읽습니다. 명령이 적힌 파일은 거부됩니다.
   그래서 개발 서버가 package.json 의 scripts 에 \`dev\`(없으면 start · serve ·
   preview 중 하나)로 있어야 하고, 위에 적은 포트에서 떠야 합니다 — 없으면
   그 스크립트를 추가해 주세요. 검사 · 빌드 명령은 scripts 의 \`check\` · \`build\` 를
   그대로 읽습니다 — 도구가 스스로 돌리지는 않습니다.
2. 화면 브리지 — 개발 미리보기에만 붙는 작은 스크립트로, 앱이 떠 있을 때
   \`colo-design.screens\` 봉투로 화면 목록을 알려 주고 \`colo-design.navigate\`
   메시지를 받아 화면을 이동합니다. 아래 템플릿을 참고해 이 레포의 라우팅에
   맞게 붙여 주세요. 프로덕션 번들에 포함되지 않게 개발 전용 경로로 넣어 주세요.
3. 화면 래퍼 — 각 화면 최상위에 \`data-screen="<feature>/<Screen>"\`,
   \`data-state="<상태>"\` 속성을 붙여 주세요. 경로 규칙은
   \`/<feature>/<Screen>?state=<상태>\` 입니다.
4. \`CLAUDE.md\` — 위 브리지와 래퍼 규칙, 화면 추가 관례를 한두 문단으로.
   문서 첫 줄에 \`${conventionsMarker(CONVENTIONS_REVISION)}\` 주석을 그대로
   넣어 주세요 — 도구가 관례의 판을 읽는 표식입니다.
5. (선택) 소스 표식 — 개발 빌드의 JSX 소문자 태그에
   \`data-colo-src="<src/ 아래 파일 경로>:<줄>"\` 속성을 붙여 주면, 사용자가
   미리보기에서 찍은 핀이 화면만이 아니라 소스 위치를 가리킵니다. 아래
   템플릿을 이 레포의 JSX 파이프라인에 맞게 고쳐 주세요 — 소문자로 시작하는
   태그에만 붙이고(대문자·숫자로 시작하는 컴포넌트 태그는 그대로 둡니다),
   프로덕션 번들에는 들어가지 않게 합니다.

절대 하지 말 것: 네트워크 내려받기(curl … | sh 등), 비밀키·토큰 다루기.
준비가 끝나면 화면 하나 이상이 미리보기에 떠야 합니다.

${BRIDGE_TEMPLATE}

${SRC_MARKER_TEMPLATE}`;

export const REFRESH_TITLE = "관례 최신화";

export const REFRESH_BRIEF = `이 레포는 이미 Colo Design 도구와 연결되어 있습니다. 도구의 연결 관례가 개선되었으니, 레포의 관례를 현행 판에 맞춰 다시 써 주세요.

1. 화면 브리지 — 개발 미리보기에 붙은 브리지 스크립트를 점검하고 현행 규격
   (\`colo-design.screens\` 봉투 송신, \`colo-design.navigate\` 수신)에 맞춰
   주세요. 이 레포의 라우팅에 맞게 붙은 부분은 그대로 살립니다.
2. 화면 래퍼 — 각 화면 최상위의 \`data-screen="<feature>/<Screen>"\`,
   \`data-state="<상태>"\` 규칙이 지켜지고 있는지 점검해 주세요. 소스 표식
   (\`data-colo-src="<파일>:<줄>"\`)이 없으면 이번에 선택 규약이니 붙여도
   좋습니다 — 개발 빌드 전용입니다.
3. \`CLAUDE.md\` — 브리지와 래퍼 규칙, 화면 추가 관례를 한두 문단으로 다시
   써 주세요. 이 레포 고유의 규칙(개발자가 적어 둔 것)은 그대로 보존하고,
   문서 첫 줄에 \`${conventionsMarker(CONVENTIONS_REVISION)}\` 주석을 그대로
   넣어 주세요 — 도구가 관례의 판을 읽는 표식입니다.

절대 하지 말 것: \`colo-design.json\` 고치기(연결은 이미 살아 있습니다),
네트워크 내려받기(curl … | sh 등), 비밀키·토큰 다루기.
바뀐 파일은 저장 → 넘기기 흐름으로 개발자의 PR 승인을 받습니다 —
스스로 커밋하거나 푸시하지 마세요.

${BRIDGE_TEMPLATE}

${SRC_MARKER_TEMPLATE}`;
