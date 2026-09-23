/**
 * 초대 파일(`*.colo-invite`, v2)의 형식 — 쓰는 쪽 두 곳이 함께 쓰는 한 벌이다:
 *   - scripts/make-invite.mjs (개발자의 터미널)
 *   - docs/invite-format.mjs (소개 페이지의 초대장 만들기 — 이 파일의 그대로 복사본)
 *
 * 읽는 쪽은 packages/web/src/components/onboarding/StartFlow.tsx 의 parseInvite.
 * 형식을 고칠 때는 셋을 함께 고친다.
 */

/** 가져오기 확인 카드에 그대로 보이는 한 단락 — 전달 경로와 삭제 안내가 본체다. */
export const INVITE_README =
  "이 파일에는 당신의 GitHub 연결 코드가 들어 있습니다. Colo Design 에서 가져오기한 뒤에는 이 파일을 지워 주세요. 다른 사람에게 보내지 마세요.";

/**
 * 초대 파일의 내용. token 은 호출자가 trim 해 둔 것을 그대로 싣는다 — 이 함수는
 * 비밀을 가공하지 않는다. author/reviewers 는 있을 때만 실린다(v2).
 */
export function buildInvite({ repoUrl, name, token, baseBranch = "main", author, reviewers = [] }) {
  const list = reviewers.map((login) => login.trim()).filter(Boolean);
  return {
    v: 2,
    name: name.trim(),
    repoUrl: repoUrl.trim(),
    baseBranch,
    token: token.trim(),
    approveCommands: true,
    ...(author?.trim() ? { authorName: author.trim() } : {}),
    ...(list.length > 0 ? { reviewers: list } : {}),
    readme: INVITE_README,
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
