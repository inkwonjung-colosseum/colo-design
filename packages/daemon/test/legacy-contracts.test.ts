// 개명 이중 계약의 단위 시험 (RENAME-NOVA-PLAN §1.2 · §8.1) — 쓰기는 nova,
// 읽기는 둘 다. 턴 마커 · PR 도구 구간 · 이슈 표식 · stash 태그 · 공통 규칙
// 머리 · 브라우저 도구 이름 · 연결 코드(복호화 실패 → 만료).
import assert from "node:assert/strict";
import { test } from "node:test";
import { markTurn, readTurn } from "../../protocol/src/turn-marker.ts";
import { isBrowserToolName } from "../dist/browser-tools.js";
import { findIssueMarker } from "../dist/developer-notice.js";
import { GitHubBridge } from "../dist/github-bridge.js";
import { mergeToolBlock, TOOL_BLOCK_END, TOOL_BLOCK_START } from "../dist/handoff-body.js";
import { isToolStashSubject } from "../dist/repo-core.js";
import { alignCycleBranch } from "../dist/repo-publish.js";
import { stripCommonInstructions } from "../src/common-instructions.ts";

// read-legacy — 기대값은 조각으로 잇는다.
const LEGACY = ["co", "lo"].join("");

// ---------------------------------------------------------------------------
// 턴 마커 — 옛 대화 기록의 카드가 그대로 그려진다
// ---------------------------------------------------------------------------

test("옛 접두의 턴 마커를 읽는다 — 카드가 날 글로 보이지 않게", () => {
  const legacyMarker = `<!-- ${LEGACY}-design:comments {"screen":"회원 목록","items":[{"label":"버튼","comment":"눌러 주세요"}]} -->`; // read-legacy
  const { marker, body } = readTurn(`${legacyMarker}\n화면 수정 요청 1건`);
  assert.equal(marker?.kind, "comments");
  assert.equal((marker as { screen?: string }).screen, "회원 목록");
  assert.equal(body, "화면 수정 요청 1건");
  // 새 접두로 쓴 것도 물론 읽는다.
  const fresh = markTurn({ kind: "brief", title: "준비" }, "본문");
  assert.equal(readTurn(fresh).marker?.kind, "brief");
});

// ---------------------------------------------------------------------------
// PR 도구 구간 — 옛 표식으로 싸인 본문을 한 구간으로 합친다
// ---------------------------------------------------------------------------

test("옛 표식의 도구 구간을 새 것 하나로 합친다 — 같은 PR 에 구간이 둘 생기지 않게", () => {
  const legacyStart = `<!-- ${LEGACY}-design:start -->`; // read-legacy
  const legacyEnd = `<!-- ${LEGACY}-design:end -->`; // read-legacy
  const existing = `개발자가 쓴 도입.\n\n${legacyStart}\n옛 내용\n${legacyEnd}\n\n뒤의 말.`;
  const merged = mergeToolBlock(existing, "새 내용");
  assert.ok(merged.includes("개발자가 쓴 도입."));
  assert.ok(merged.includes("새 내용"));
  assert.ok(!merged.includes("옛 내용"));
  assert.ok(!merged.includes(legacyStart));
  // 새 표식이 정확히 한 쌍만 남는다.
  assert.equal(merged.split(TOOL_BLOCK_START).length - 1, 1);
  assert.equal(merged.split(TOOL_BLOCK_END).length - 1, 1);
});

// ---------------------------------------------------------------------------
// 이슈 표식 — 같은 문제의 이슈를 새로 열지 않는다
// ---------------------------------------------------------------------------

test("옛 표식의 이슈에서 문제 키를 찾는다", () => {
  const body = `안내 문단.\n<!-- ${LEGACY}-design:problem preview:blank -->\n`; // read-legacy
  assert.equal(findIssueMarker(body), "preview:blank");
  assert.equal(findIssueMarker("<!-- nova-design:problem preview:blank -->\n"), "preview:blank");
  assert.equal(findIssueMarker("표식 없음"), null);
});

// ---------------------------------------------------------------------------
// stash 태그 — 옛 앱이 남긴 임시 보관을 도구의 것으로 알아본다
// ---------------------------------------------------------------------------

test("옛 이름의 stash 태그도 도구의 임시 보관이다", () => {
  assert.equal(isToolStashSubject("stash@{0}: On main: Nova Design: 최신화 임시 보관"), true);
  assert.equal(
    // read-legacy
    isToolStashSubject(`stash@{0}: On main: ${["Colo", " Design"].join("")}: 최신화 임시 보관`),
    true,
  ); // read-legacy
  assert.equal(isToolStashSubject("stash@{0}: WIP on main: 내 손 보관"), false);
});

// ---------------------------------------------------------------------------
// 공통 규칙 머리 — 옛 저장본의 제목 파생이 규칙 문구가 되지 않게
// ---------------------------------------------------------------------------

test("옛 머리의 공통 규칙 블록도 걷어낸다 — 첫 줄이 사용자의 말", () => {
  const legacyTurn = [
    // read-legacy
    `# ${["Colo", " Design"].join("")} 공통 규칙`,
    "",
    "이 규칙은 어떤 레포를 연결했는지와 무관하게 모든 대화에 함께 간다.",
    "- 첫 불릿",
    "- 둘째 불릿",
    "",
    "로그인 버튼을 오른쪽으로 옮겨 주세요",
    "두 번째 줄",
  ].join("\n");
  assert.equal(
    stripCommonInstructions(legacyTurn),
    "로그인 버튼을 오른쪽으로 옮겨 주세요\n두 번째 줄",
  );
  const freshTurn = [
    "# Nova Design 공통 규칙",
    "",
    "이 규칙은 어떤 레포를 연결했는지와 무관하게 모든 대화에 함께 간다.",
    "- 불릿",
    "",
    "다른 부탁",
  ].join("\n");
  assert.equal(stripCommonInstructions(freshTurn), "다른 부탁");
});

// ---------------------------------------------------------------------------
// 브라우저 도구 이름 — 이어 든 대화가 옛 서버 이름을 불러도 묶는다
// ---------------------------------------------------------------------------

test("옛 MCP 서버 이름의 브라우저 도구도 브라우저 도구다", () => {
  assert.equal(isBrowserToolName("mcp__nova-browser__browser_snapshot"), true);
  assert.equal(isBrowserToolName(`mcp__${LEGACY}-browser__browser_snapshot`), true); // read-legacy
  assert.equal(isBrowserToolName(`${LEGACY}-browser/browser_snapshot`), true); // read-legacy
  assert.equal(isBrowserToolName("mcp__other-server__browser_snapshot"), false);
});

// ---------------------------------------------------------------------------
// 사이클 브랜치 — 원장이 기억한 옛 접두의 브랜치로 끝까지 간다
// ---------------------------------------------------------------------------

test("원장의 옛 접두 브랜치를 그 이름 그대로 이어 쓴다", async () => {
  // read-legacy — 0.3.x 가 연 사이클의 브랜치 이름.
  const legacyBranch = `${LEGACY}-design/20260928-1`;
  const checks: string[][] = [];
  const git = (args: string[]): Promise<string> => {
    checks.push(args);
    if (args[0] === "symbolic-ref") return Promise.resolve("main\n");
    if (args[0] === "rev-parse") return Promise.resolve("abc123\n");
    return Promise.resolve("");
  };
  const name = await alignCycleBranch(git, legacyBranch);
  assert.equal(name, legacyBranch);
  // 로커에 있으면 checkout name — 이름을 다시 짓지 않는다.
  assert.deepEqual(checks[1], ["rev-parse", "--verify", "--quiet", `refs/heads/${legacyBranch}`]);
  assert.deepEqual(checks.at(-1), ["checkout", legacyBranch]);
});

// ---------------------------------------------------------------------------
// 연결 코드 — 암호문이 있는데 풀리지 않으면 만료로 잇는다(§5)
// ---------------------------------------------------------------------------

test("풀 수 없는 암호문 → 만료 — 다시 연결이 필요해요 가 선다", async () => {
  const authChanges: boolean[] = [];
  const store = {
    kind: "dpapi" as const,
    async save() {},
    async load() {
      return null;
    },
    async delete() {},
    undecryptable(item: string) {
      return item === "pat";
    },
  };
  const bridge = new GitHubBridge({
    credentials: store,
    claudeExecutableOverride: () => undefined,
    onToken: () => {},
    onAuthChange: (expired: boolean) => authChanges.push(expired),
  });
  assert.equal(bridge.authExpired, false);
  await bridge.load();
  assert.equal(bridge.token, null);
  assert.equal(bridge.authExpired, true);
  assert.deepEqual(authChanges, [true]);
});

test("그냥 없는 토큰은 만료가 아니다 — 온보딩의 경고일 뿐", async () => {
  const store = {
    kind: "dpapi" as const,
    async save() {},
    async load() {
      return null;
    },
    async delete() {},
    undecryptable() {
      return false;
    },
  };
  const bridge = new GitHubBridge({
    credentials: store,
    claudeExecutableOverride: () => undefined,
    onToken: () => {},
  });
  await bridge.load();
  assert.equal(bridge.authExpired, false);
});
