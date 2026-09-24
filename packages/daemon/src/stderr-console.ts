import { Console } from "node:console";

/**
 * stdout 이 프로토콜 채널인 진입점(browser-mcp)의 콘솔 출력 경계.
 *
 * browser-mcp 는 줄 단위 JSON-RPC 를 stdout 으로만 말하는 stdio MCP 자식이다.
 * 여기 걸리는 의존성이 모듈 로드 때든 실행 중이든 console.* 한 줄을 흘리면 그
 * 줄이 곧 프레임으로 읽혀 부모(claude · codex) 와의 대화가 깨진다. 이 모듈을
 * 진입점의 첫 import 로 두면 그 뒤의 어떤 콘솔 출력도 stderr 로만 나간다 —
 * 프로토콜은 process.stdout.write 로 직접 말하므로 경계와 겹치지 않는다.
 * 소비자 쪽(부모가 줄을 읽는 jsonrpc.ts)은 이미 파싱 실패 줄을 조용히 버리는
 * 관용을 갖추었고, 이것이 생산자 쪽 짝이다.
 *
 * ZCode(zai-org/ZCode, Apache-2.0, 872ad960)의 protocol-console.ts
 * installStderrConsoleBoundary에서 가져와 고쳤다: 복원 스위치를 빼고 로드 시
 * 설치만 남겼다 — 이 진입점은 프로세스가 끝날 때까지 프로토콜 자식이므로
 * 되돌릴 순간이 없다.
 */
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
