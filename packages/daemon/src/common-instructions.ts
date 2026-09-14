/**
 * 앱이 모든 세션에 늘 붙이는 공통 지침(커미티 판정 2026-09-14,
 * docs/repo-common-settings-injection-debate-2026-09-14.md 3장).
 *
 * 주인은 앱 릴리스다 — 사용자는 설정의 "지켜 줄 것" 대화상자에서 읽기
 * 전용으로 볼 수 있고 편집하지는 못한다. 프로젝트별 지침(기획자 소유,
 * projects.json 의 instructions)과 레포의 CLAUDE.md(개발자 소유)는
 * server.ts 의 projectInstructions() 에서 이 블록 뒤에 이어 붙는다.
 * 세 계층의 주인이 겹치지 않으므로 갱신·덮어쓰기 드리프트도 없다:
 * 이 상수는 앱 버전과 함께 움직인다.
 */
export const COMMON_INSTRUCTIONS = `# Colo Design 공통 규칙

이 규칙은 어떤 레포를 연결했는지와 무관하게 모든 대화에 함께 간다. 레포가 CLAUDE.md 로 자기 규칙을 밝히면 이 규칙과 함께 지킨다.

- 화면을 만들거나 고치면 그 화면의 제목과 화면 주소를 답변 끝에 남긴다. 파일 경로 · 컴포넌트 · prop 이름은 답변에 쓰지 않는다.
- 레포의 colo-design.json scripts(install · check · build · preview)에 없는 명령은 실행하지 않는다.
- 네트워크에서 내려받아 곧바로 실행하는 명령(curl … | sh 따위)은 절대 실행하지 않는다.
- 비밀 키 · 토큰 · 자격 증명을 읽거나 옮기거나 파일에 남기지 않는다.`;
