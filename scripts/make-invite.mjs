#!/usr/bin/env node
/**
 * 초대 파일 생성기 (P1-5 단계 A · E4 초대) — 개발자가 사용자마다 한 번 돈다.
 *
 *   node scripts/make-invite.mjs --repo https://github.com/org/a.git \
 *        --repo https://github.com/org/b.git --token github_pat_… \
 *        [--name "회원 관리"] [--base main] [--author "김기획"] \
 *        [--reviewer dev1 --reviewer dev2] [--out 파일.colo-invite]
 *
 * 초대 파일은 비밀(연결 코드)을 담는다 — 그래서 링크(colo-design://…?token=…)가
 * 아니라 파일이다: 경로만 argv 와 OS 로그에 남고 비밀은 파일 안에 있다. 파일은
 * 슬랙 DM 등 사용자만 보는 경로로 보내고, 가져오기가 끝나면 지우라고 안내한다.
 * 이 스크립트는 화면에 토큰을 다시 출력하지 않는다.
 *
 * 파일의 내용은 가려져 나간다(v3 봉투) — 편집기로 열어도 읽히지 않는다. 가림이지
 * 비밀 보호가 아니므로(키가 공개 페이지 소스에 함께 있다) 전달 경로는 여전히
 * 사용자만 보는 곳이어야 한다.
 *
 * --repo 는 반복 가능하다 — 초대장 하나가 프로젝트 여러 개를 싣는다. --name 은
 * 레포가 하나일 때만 쓰고, 이름 기본값은 레포 이름(owner/repo 의 repo)이다.
 * --base 가 없으면 토큰으로 GitHub 의 기본 가지를 묻는다. --author · --reviewer 는
 * 모든 프로젝트 공통이다(v2 필드 — 작성 줄과 리뷰어).
 * 개발 실행도 이 파일로 시작한다 — GitHub 주소나 로컬 경로 둘 다 --repo 로 받는다.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildInvite, inviteSlug, sealInvite } from "../site/invite-format.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
/** 반복 가능한 깃발 — --repo a --repo b → ["a", "b"]. */
const flags = (name) =>
  args.flatMap((arg, index) => (arg === `--${name}` && args[index + 1] ? [args[index + 1]] : []));

const repoUrls = flags("repo");
const name = flag("name");
const token = flag("token");
const baseBranch = flag("base");
const author = flag("author");
const reviewers = flags("reviewer")
  .map((login) => login.trim())
  .filter(Boolean);
const out = flag("out");
// 초대 v4(PLAN 단계 5): 개발자 알림이 갈 Slack 길과 프로젝트의 처음 값·수명.
const slackWebhook = flag("slack-webhook");
const slackBotToken = flag("slack-bot-token");
const slackChannel = flag("slack-channel");
const provider = flag("provider");
const model = flag("model");
const effort = flag("effort");
const keepRejectedDays = flag("keep-rejected-days");
const noDeleteMerged = args.includes("--no-delete-merged");
const noAutoReply = args.includes("--no-auto-reply");
const noSubmitFromChat = args.includes("--no-submit-from-chat");
const instructions = flag("instructions");

if (repoUrls.length === 0 || !token) {
  console.error(
    [
      "사용법: node scripts/make-invite.mjs --repo <git 주소>… --token <연결 코드> [--name <프로젝트 이름>] [--base main] [--author <작업 이름>] [--reviewer <GitHub 로그인>]… [--out <경로>]",
      "",
      "  --repo     사용자가 작업할 레포의 git 주소 (반복 가능 — 초대장 하나에 프로젝트 여러 개)",
      "  --token    그 사용자용으로 발급한 GitHub 연결 코드(fine-grained PAT)",
      '  --name     사용자에게 보일 프로젝트 이름 (예: "회원 관리") — 레포가 하나일 때만 쓰는 옵션',
      "  --base     넘기기가 겨눌 기본 가지 — 없으면 토큰으로 GitHub 의 기본 가지를 묻는다(실패 시 main)",
      '  --author   넘긴 요청의 `> 작성:` 줄에 적힐 이름 (예: "김기획") — 사용자가 적을 이름을 미리 정한다',
      "  --reviewer 넘긴 요청의 리뷰를 부탁할 개발자의 GitHub 로그인 (반복 가능, 모든 프로젝트 공통)",
      "  --out      출력 파일 경로 (기본: ./<프로젝트 이름>.colo-invite — 레포가 여럿이면 ./invite.colo-invite)",
      "",
      "  초대 v4(PLAN 단계 5) — 개발자 알림과 프로젝트의 처음 값·수명:",
      "  --slack-webhook <url>   개발자 알림이 갈 Slack 웹훅 주소(https 만)",
      "  --slack-bot-token <t> --slack-channel <c>   웹훅 대신 봇 토큰+채널",
      "  --provider <p>          새 대화의 처음 프로바이더 (예: claude · codex)",
      "  --model <m>             새 대화의 처음 모델 (예: sonnet)",
      "  --effort <e>            새 대화의 처음 생각 시간 (low · medium · high · xhigh · max)",
      "  --keep-rejected-days <n>  반려된 작업의 보관 일수 (1~365, 기본 14)",
      "  --no-delete-merged      병합된 사이클 브랜치를 정리하지 않는다 (기본은 정리)",
      "  --no-auto-reply         개발자 코멘트에 AI 가 자동으로 답하지 않는다 (기본은 답한다)",
      "  --no-submit-from-chat   채팅으로 제출하는 도구를 싣지 않는다 (기본은 싣는다)",
      "  --instructions <text>   이 프로젝트에서 AI 가 늘 따를 규칙 — 레포가 하나일 때만",
    ].join("\n"),
  );
  process.exit(1);
}

/** owner/repo 를 뽑는다 — GitHub 주소의 두 조각(스킴·userinfo·.git 무시). */
function repoSlug(url) {
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?(?:[^/:]+)[/:]+(.+?)\.git$/i.exec(
    url.trim(),
  );
  const path = (match?.[1] ?? url.trim()).replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  const repo = segments.at(-1) ?? path;
  return { owner: segments.at(-2) ?? "", repo };
}
/** GitHub 주소인가 — 기본 가지 조회는 이 주소일 때만 한다(file:// · 로컬 경로는
 *  조회 없이 main). 스킴 없는 owner/repo 표기도 GitHub 로 본다. */
function isGitHubUrl(url) {
  return (
    /^(?:https?:\/\/|git@|ssh:\/\/git@)github\.com[/:]/i.test(url.trim()) ||
    /^[^/:@]+\/[^/:@]+$/.test(url.trim())
  );
}

/** GitHub 가 말하는 이 레포의 기본 가지 — 물을 수 없으면 "main". */
async function defaultBranch(url) {
  const slug = repoSlug(url);
  if (!isGitHubUrl(url) || !slug.owner) return "main";
  try {
    const reply = await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "colo-design-invite",
      },
    });
    if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
    const branch = (await reply.json())?.default_branch;
    if (typeof branch !== "string" || !branch.trim()) throw new Error("default_branch 없음");
    return branch;
  } catch {
    console.error(
      `경고: ${slug.owner}/${slug.repo} 의 기본 가지를 못 읽었습니다 — main 으로 둡니다.`,
    );
    return "main";
  }
}

const projects = [];
for (const url of repoUrls) {
  const slug = repoSlug(url);
  // 초대 v4(PLAN 단계 5): 처음 값과 수명은 프로젝트마다 같은 값을 실는다 —
  // --name · --instructions 와 달리 레포가 여럿이어도 개발자의 한 뜻이다.
  const defaults = {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
  const lifecycle = {
    ...(noDeleteMerged ? { deleteMergedBranches: false } : {}),
    ...(keepRejectedDays ? { keepRejectedDays: Number.parseInt(keepRejectedDays, 10) } : {}),
    ...(noAutoReply ? { autoReply: false } : {}),
    ...(noSubmitFromChat ? { submitFromChat: false } : {}),
  };
  projects.push({
    repoUrl: url,
    name: (repoUrls.length === 1 && name ? name : slug.repo) || url,
    ...(baseBranch ? { baseBranch } : { baseBranch: await defaultBranch(url) }),
    ...(reviewers.length > 0 ? { reviewers } : {}),
    ...(repoUrls.length === 1 && instructions ? { instructions } : {}),
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    ...(Object.keys(lifecycle).length > 0 ? { lifecycle } : {}),
  });
}

// 개발자 알림이 갈 Slack 길 — 웹훅이 있으면 웹훅, 없으면 봇 토큰+채널이 함께
// 있을 때만 봇이다. 반쪽짜리 봇 입력은 없는 것으로 친다.
const notify = slackWebhook
  ? { slack: { kind: "webhook", url: slackWebhook } }
  : slackBotToken && slackChannel
    ? { slack: { kind: "bot", token: slackBotToken, channel: slackChannel } }
    : undefined;

// 기본 파일 이름은 프로젝트 slug — 스크립트의 기본값이 늘 그랬다(페이지의
// inviteFileName 은 작업 이름을 먼저 쓰는 같은 규칙의 다른 기본값). 레포가
// 여럿이면 한 장이 여러 프로젝트를 싣는다는 뜻의 이름으로 둔다.
const target = resolve(
  out ?? `./${repoUrls.length === 1 ? inviteSlug(projects[0].name) : "invite"}.colo-invite`,
);

const invite = buildInvite({ token, author, projects, ...(notify ? { notify } : {}) });
const sealed = await sealInvite(invite);

writeFileSync(target, `${JSON.stringify(sealed, null, 2)}\n`);
console.log(`초대 파일: ${target}`);
console.log(
  projects.length > 1
    ? `프로젝트 ${projects.length}개가 들어 있습니다 — 전달은 사용자만 보는 경로(슬랙 DM 등)로.`
    : "전달은 사용자만 보는 경로(슬랙 DM 등)로 — 파일에는 연결 코드가 있습니다.",
);
