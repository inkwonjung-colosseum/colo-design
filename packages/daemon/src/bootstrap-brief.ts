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
   \`data-colo-src="<src/ 아래 파일 경로>:<줄>"\` 속성을 붙여 주면, 기획자가
   미리보기에서 찍은 핀이 화면만이 아니라 소스 위치를 가리킵니다. Vite
   플러그인 한 조각(dev 전용, enforce: "pre")으로 소문자로 시작하는 태그
   오프닝에만 붙이면 충분합니다 — 대문자나 숫자로 시작하는 컴포넌트 태그는
   그대로 둡니다. 프로덕션 번들에 포함되지 않게 해 주세요.

절대 하지 말 것: 네트워크 내려받기(curl … | sh 등), 비밀키·토큰 다루기.
준비가 끝나면 화면 하나 이상이 미리보기에 떠야 합니다.`;

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
스스로 커밋하거나 푸시하지 마세요.`;
