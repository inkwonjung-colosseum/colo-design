/**
 * What each half of the product IS, as the daemon has to know it: where its
 * sessions run, what they may write there, and — for 기획 — what tells Claude
 * that the folder is a Confluence mirror rather than a pile of markdown.
 *
 * The 기획 instructions ride as a system-prompt append rather than a
 * `CLAUDE.md` on disk, on purpose: a file in the mirror would also load into a
 * design session (which mounts the mirror to read 기획서), would show up in
 * the page tree and the watcher, and would be one more file a session could
 * talk itself into editing. An append belongs to the session that asked for
 * it and to nothing else.
 *
 * What lives here is only what the TOOL owns: the mirror's file format, the
 * optimistic-locking fields a hand edit must not touch, and how a brand-new
 * page is spelled before 게시 creates it remotely. Everything domain-shaped —
 * how this team writes a 기획서, its vocabulary, its sections — is the
 * connected repo's decision and arrives as `drafthouse.json`'s
 * `planning.rules`, appended below the invariants.
 */

import type { Workspace } from "@drafthouse/protocol";
import { sep } from "node:path";
import { containsPath } from "./paths.js";
import type { WriteDecision, WritePolicy } from "./session.js";

/** Mirror bookkeeping a planning session must never rewrite. */
export const MIRROR_STATE_FILE = ".confluence-sync.json";

/**
 * What a workspace's sessions may write without asking.
 *
 * Planning owns the mirror's page files and attachments, but never the sync
 * state: a session that rewrites `.confluence-sync.json` breaks the
 * optimistic lock, and the next push overwrites somebody's edit silently.
 *
 * Design keeps the historical rule — silent inside the clone, a card
 * everywhere else — which is also what keeps the mirror read-only for it: the
 * `confluence` link inside the clone resolves out of the clone, so a write
 * through it lands on the card path.
 *
 * Both roots must already be realpath-resolved, as must the path a policy is
 * asked about; `Session` does that before calling.
 */
export function writePolicyFor(
  workspace: Workspace,
  roots: { repoRoot: string; mirrorRoot: string },
): WritePolicy {
  if (workspace === "design") {
    return (path) => (containsPath(roots.repoRoot, path) ? "allow" : "ask");
  }
  return (path): WriteDecision => {
    if (!containsPath(roots.mirrorRoot, path)) return "ask";
    return path.endsWith(`${sep}${MIRROR_STATE_FILE}`) ? "deny" : "allow";
  };
}

const INVARIANTS = `**모든 문장은 한국어로 쓴다.** 작업 중간에 흘리는 진행 설명도 기획자 화면에 그대로
보이므로 한국어여야 한다.

여기는 Drafthouse의 **기획 작업 공간**이다. 작업 폴더는 Confluence 스페이스의 로컬
미러이고, 폴더 하나가 스페이스 하나(\`<스페이스키>/\`), 파일 하나가 페이지 하나다.
파일을 고치면 기획자가 편집기에서 바로 보고, 기획자가 **게시**를 누르면 Confluence로
올라간다. 화면(코드)은 여기서 만들지 않는다 — 그것은 같은 기획서의 화면 대화가 하는 일이다.

## 파일 형식

각 페이지 파일은 YAML frontmatter + 본문이다:

\`\`\`
---
pageId: "123456"
version: 7
space: ENG
title: 회원 관리 기획서
parentPageId: "123400"
---

## 개요
...
\`\`\`

## 불변식

1. **frontmatter의 \`pageId\`와 \`version\`은 절대 바꾸지 않는다.** 도구가 낙관적 잠금에
   쓰는 값이다. 손대면 남의 편집을 조용히 덮어쓴다. \`title\`·\`parentPageId\`는 기획자가
   요청했을 때만 바꾼다.
2. **\`\`\`confluence 펜스 블록의 내용은 수정하지 않는다.** Markdown이 담을 수 없는 것
   (매크로·병합 셀·레이아웃)이 그대로 들어 있다. 위치를 옮기거나 통째로 지울 수는 있지만,
   안쪽 글자는 건드리지 않는다.
3. **이미지는 \`attachments/<pageId>/<파일명>\` 참조로만 쓴다.** 외부 URL을 넣지 않는다.
4. **\`${MIRROR_STATE_FILE}\`은 도구 소유다 — 읽지도 쓰지도 않는다.**
5. **표는 Markdown 표로 쓴다.** HTML을 직접 쓰지 않는다.

## 새 기획서를 만들 때

아직 Confluence에 없는 페이지는 \`<스페이스키>/<제목>.md\`로 만들고 frontmatter를 이렇게
적는다:

\`\`\`
---
pageId: "new-회원관리"
version: 0
space: ENG
title: 회원 관리 기획서
parentPageId: null
---
\`\`\`

- \`pageId\`는 \`new-\`로 시작하는 아무 이름이나 좋다. 게시할 때 도구가 실제 Confluence
  페이지를 만들고 진짜 id로 바꿔 적는다.
- \`version\`은 반드시 \`0\`.
- \`parentPageId\`는 트리에서 어디에 붙일지다. 모르겠으면 기획자에게 묻는다.
- 스페이스 키는 이미 있는 폴더 이름 중에서 고른다. 새 폴더를 만들지 않는다.

## 기획서를 고칠 때

- 먼저 파일을 **끝까지** 읽는다. 앞부분만 보고 고치면 뒤에서 모순이 난다.
- 기존 구조(제목 단계·섹션 순서)를 유지한 채 고친다. 전면 재작성은 기획자가 그렇게
  요청했을 때만 한다.
- 기획서에 없는 것은 지어내지 않고 AskUserQuestion으로 묻는다.

## 답변 형식

- 만들거나 고친 문서를 제목으로 적는다: \`회원 관리 기획서 — 조회 조건 절 추가\`
- **파일 경로를 쓰지 않는다.** \`ENG/회원 관리 기획서.md\` 대신 \`회원 관리 기획서\`라고 쓴다.
  미러 경로는 파일을 읽고 쓸 때만 필요한 것이고, 기획자는 페이지 제목으로만 문서를 안다.
  절을 가리킬 때는 그 절의 제목을 쓴다.
- \`<!-- drafthouse:… -->\`로 시작하는 줄은 도구가 붙인 표시다. 읽을 필요도, 답변에
  옮겨 적을 필요도 없다.
- 기획자가 말한 것과 다르게 쓴 부분이 있으면 무엇을 왜 그렇게 했는지 한 줄로
- 게시는 기획자가 누른다. 직접 올리려 하지 않는다.`;

/** The planning session's system-prompt append, repo rules included. */
export function planningRules(repoRules: string | null): string {
  const extra = repoRules?.trim();
  if (!extra) return INVARIANTS;
  return `${INVARIANTS}

## 이 팀의 기획 규칙

연결 레포가 정한 규칙이다. 위 불변식과 충돌하면 위가 이긴다.

${extra}`;
}
