#!/usr/bin/env node
/**
 * 초대 파일 생성기 (P1-5 단계 A · E4 초대 v2) — 개발자가 사용자마다 한 번 돈다.
 *
 *   node scripts/make-invite.mjs --repo https://github.com/org/repo.git \
 *        --name "회원 관리" --token github_pat_… [--base main] \
 *        [--author "김기획"] [--reviewer dev1 --reviewer dev2] [--out 파일.colo-invite]
 *
 * 초대 파일은 비밀(연결 코드)을 담는다 — 그래서 링크(colo-design://…?token=…)가
 * 아니라 파일이다: 경로만 argv 와 OS 로그에 남고 비밀은 파일 안에 있다. 파일은
 * 슬랙 DM 등 사용자만 보는 경로로 보내고, 가져오기가 끝나면 지우라고 안내한다.
 * 이 스크립트는 화면에 토큰을 다시 출력하지 않는다.
 *
 * v2 필드: --author 는 넘긴 요청의 `> 작성:` 줄에 적힐 이름이고, --reviewer
 * (반복 가능)는 넘긴 요청의 리뷰를 부탁할 개발자의 GitHub 로그인이다.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
/** 반복 가능한 깃발 — --reviewer a --reviewer b → ["a", "b"]. */
const flags = (name) =>
  args.flatMap((arg, index) => (arg === `--${name}` && args[index + 1] ? [args[index + 1]] : []));

const repoUrl = flag("repo");
const name = flag("name");
const token = flag("token");
const baseBranch = flag("base") ?? "main";
const author = flag("author");
const reviewers = flags("reviewer")
  .map((login) => login.trim())
  .filter(Boolean);
const out = flag("out");

if (!repoUrl || !name || !token) {
  console.error(
    [
      "사용법: node scripts/make-invite.mjs --repo <git 주소> --name <프로젝트 이름> --token <연결 코드> [--base main] [--author <작업 이름>] [--reviewer <GitHub 로그인>]… [--out <경로>]",
      "",
      "  --repo     사용자가 작업할 레포의 git 주소 (예: https://github.com/org/repo.git)",
      '  --name     사용자에게 보일 프로젝트 이름 (예: "회원 관리")',
      "  --token    그 사용자용으로 발급한 GitHub 연결 코드(fine-grained PAT)",
      "  --base     넘기기가 겨눌 기본 가지 (기본: main)",
      '  --author   넘긴 요청의 `> 작성:` 줄에 적힐 이름 (예: "김기획") — 사용자가 적을 이름을 미리 정한다',
      "  --reviewer 넘긴 요청의 리뷰를 부탁할 개발자의 GitHub 로그인 (반복 가능)",
      "  --out      출력 파일 경로 (기본: ./<이름>.colo-invite)",
    ].join("\n"),
  );
  process.exit(1);
}

const slug =
  name
    .trim()
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "invite";
const target = resolve(out ?? `./${slug}.colo-invite`);

// readme 는 가져오기 화면에 그대로 보인다 — 전달 경로와 삭제 안내가 본체다.
const invite = {
  v: 2,
  name: name.trim(),
  repoUrl: repoUrl.trim(),
  baseBranch,
  token: token.trim(),
  approveCommands: true,
  ...(author ? { authorName: author.trim() } : {}),
  ...(reviewers.length > 0 ? { reviewers } : {}),
  readme:
    "이 파일에는 당신의 GitHub 연결 코드가 들어 있습니다. Colo Design 에서 가져오기한 뒤에는 이 파일을 지워 주세요. 다른 사람에게 보내지 마세요.",
};

writeFileSync(target, `${JSON.stringify(invite, null, 2)}\n`);
console.log(`초대 파일: ${target}`);
console.log("전달은 사용자만 보는 경로(슬랙 DM 등)로 — 파일에는 연결 코드가 있습니다.");
