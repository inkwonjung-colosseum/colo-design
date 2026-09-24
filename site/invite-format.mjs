/**
 * 초대 파일(`*.colo-invite`)의 형식 — 형식의 한 곳이다: 소개 페이지의 초대장
 * 만들기(site/invite.js)와 터미널 생성기(scripts/make-invite.mjs)가 함께 읽는다.
 *
 * 바깥 봉투는 v3 — 안쪽 JSON 을 AES-256-GCM 으로 가린다(sealInvite). 읽는 쪽은
 * packages/protocol/src/invite.ts(readInviteJson · normalizeInvite)와 그것을 쓰는
 * packages/web/src/components/onboarding/StartFlow.tsx 의 parseInvite.
 * 형식을 고칠 때는 이 셋을 함께 고친다.
 */

/**
 * 봉투를 가리는 앱 내장 키(32바이트, base64). 이 키는 공개 페이지 소스와 앱에 함께
 * 있으므로 비밀이 아니다 — 편집기로 파일을 열었을 때 내용이 읽히지 않게 하는
 * 가림이 목적이다. 비밀은 전달 경로(사용자만 보는 곳)가 지킨다.
 * packages/protocol/src/invite.ts 의 INVITE_KEY 와 같은 값이어야 한다(테스트가 확인한다).
 */
const INVITE_KEY = "8KX6pm1o64K4Vsg7z1uz0wi13POfvA8ddQmH3riPYHw=";

/** 가져오기 확인 카드에 그대로 보이는 한 단락 — 전달 경로와 삭제 안내가 본체다. */
export const INVITE_README =
  "이 파일에는 당신의 GitHub 연결 코드가 들어 있습니다. Colo Design 에서 가져오기한 뒤에는 이 파일을 지워 주세요. 다른 사람에게 보내지 마세요.";

/** 바이트 → base64. btoa 바이트 루프 — 브라우저와 Node 22 양쪽에서 돈다. */
function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64 → 바이트. atob 바이트 루프 — bytesToBase64 의 짝이다. */
function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 초대장 하나를 v3 봉투에 가린다 — 앱 내장 키의 AES-256-GCM, IV 는 매번 12바이트
 * 난수. 돌려주는 값이 파일의 전부다: { v: 3, iv, data(암호문+태그) }.
 * globalThis.crypto.subtle 은 브라우저와 Node 19+ 에 공통으로 있다.
 */
export async function sealInvite(invite) {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    base64ToBytes(INVITE_KEY),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(invite)),
  );
  return { v: 3, iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(data)) };
}

/** 프로젝트 항목의 빈 값은 싣지 않는다 — 읽는 쪽(normalizeInvite)도 같은 규칙이다. */
function buildProject({ repoUrl, name, baseBranch, reviewers, instructions }) {
  const list = (reviewers ?? []).map((login) => login.trim()).filter((login) => login !== "");
  const guide = instructions?.trim();
  return {
    repoUrl: repoUrl.trim(),
    name: name.trim(),
    baseBranch: baseBranch?.trim() || "main",
    approveCommands: true,
    ...(list.length > 0 ? { reviewers: list } : {}),
    ...(guide ? { instructions: guide } : {}),
  };
}

/**
 * 레포 주소 → 짝지음의 키. packages/protocol/src/invite.ts 의 repoKey 와 같은
 * 규칙을 .mjs 로 작게 옮긴 것이다(스킴·사용자 정보 무시, 끝의 .git 과 /
 * 제거, GitHub owner/repo 두 조각, 소문자, 정규식 밖 주소의 대체 키) —
 * 짝은 거기, 여기는 쓰는 쪽이다.
 */
function repoKey(url) {
  const trimmed = url.trim();
  // file:// 스킴은 경로로 다룬다 — "file" 이 호스트 조각이 되는 일이 없게.
  const asPath = trimmed.replace(/^file:\/\//i, "");
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^/:]+)[/:]+(.+)$/i.exec(asPath);
  if (match) {
    const host = match[1].toLowerCase();
    const rest = match[2].replace(/\.git$/i, "").replace(/\/+$/, "");
    if (host === "github.com" || host === "www.github.com") {
      const [owner, repo] = rest.split("/");
      if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
      return `github.com/${owner}/${repo}`.toLowerCase();
    }
    return `${host}/${rest}`.toLowerCase();
  }
  // 정규식이 못 잡는 주소(로컬 절대 경로 · file:// 등)에도 대체 키 — protocol 쪽과 같다.
  const fallback = asPath
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  return fallback === "" ? null : fallback;
}

/**
 * 초대 파일의 내용(봉투 안쪽, v3) — 토큰 하나와 프로젝트 목록이다. token 은
 * 호출자가 trim 해 둔 것을 그대로 싣는다 — 이 함수는 비밀을 가공하지 않는다.
 * author 는 모든 프로젝트가 공유하는 "이 작업에 적을 이름"이고, projects 는
 * [{ repoUrl, name, baseBranch?, reviewers?, instructions? }]다.
 *
 * 예전 단일 인자({ repoUrl, name, baseBranch, reviewers })도 받아 프로젝트
 * 하나짜리로 바꿔 준다 — site/invite.js 가 다음 단계까지 그대로 돌아야 하므로.
 * 같은 레포는 한 번만 싣는다 — "프로젝트 3개"라고 말했는데 실제로는 중복이라
 * 2개였던 일이 없게 뒤의 것을 버린다(읽는 쪽 normalizeInvite 와 같은 규칙).
 */
export function buildInvite({ token, author, projects, ...single }) {
  const seen = new Set();
  const list = (projects ?? [single]).filter((project) => {
    const key = repoKey(project.repoUrl ?? "") ?? project.repoUrl;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    v: 3,
    token: token.trim(),
    ...(author?.trim() ? { authorName: author.trim() } : {}),
    readme: INVITE_README,
    projects: list.map((project) => buildProject(project)),
  };
}

/** 이름 → 파일 조각. make-invite.mjs 의 slug 와 같은 규칙이다. */
export function inviteSlug(name) {
  return (
    name
      .trim()
      .replace(/[^\p{L}\p{N}-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "invite"
  );
}

/**
 * 내려받을 파일 이름. 명시한 out 이 있으면 그것(확장자는 붙여 준다), 없으면
 * 작업 이름 → 프로젝트 이름 순으로 정한다 — 받는 사람이 누구 파일인지 알아보는
 * 이름이 먼저다.
 */
export function inviteFileName({ out, author, name }) {
  const base = out?.trim() || author?.trim() || inviteSlug(name);
  return base.endsWith(".colo-invite") ? base : `${base}.colo-invite`;
}
