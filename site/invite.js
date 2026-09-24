/**
 * 소개 페이지의 초대장 만들기 — 연결 코드로 레포 목록을 불러와 고른 레포 전부를
 * 초대 파일 하나(v3 봉투)에 실는다. 형식은 ./invite-format.mjs(형식의 한 곳 —
 * 터미널 생성기 scripts/make-invite.mjs 도 같이 읽는다)이 정하고, 이 파일은
 * 입력 → 목록 → 미리 보기 → 내려받기·보내기만 담당한다.
 *
 * 연결 코드는 이 페이지를 떠나지 않는다 — 요청은 GitHub 에만 가고(localStorage ·
 * 주소창에 절대 쓰지 않는다), 미리 보기에는 가린 값만 그린다. 보내기 길(메일
 * 초안 · OS 공유 시트)도 파일을 브라우저 밖 서버가 아니라 로컬 앱에 건넨다.
 */
// ?v=6 — Pages 캐시가 옛 invite-format.mjs를 주지 않게 한다.
import { buildInvite, inviteFileName, sealInvite } from "./invite-format.mjs?v=6";

const form = document.getElementById("invite-form");
const download = document.getElementById("invite-download");
const mailto = document.getElementById("invite-mailto");
const share = document.getElementById("invite-share");
const filename = document.getElementById("invite-filename");
const preview = document.getElementById("invite-preview");
const tokenToggle = document.getElementById("token-toggle");
const tokenInput = form.elements.token;
const reposLoad = document.getElementById("repos-load");
const reposStatus = document.getElementById("repos-status");
const reposList = document.getElementById("repos-list");
const reposSearch = document.getElementById("repos-rows");
const searchInput = document.getElementById("repos-search");
const chosenRows = document.getElementById("chosen-rows");
const chosenCount = document.getElementById("chosen-count");
const manualUrl = document.getElementById("manual-url");
const manualAdd = document.getElementById("manual-add");
const authorStatus = document.getElementById("author-status");
const notifyStatus = document.getElementById("notify-status");
const guideLines = document.getElementById("guide-lines");
const guideCopy = document.getElementById("guide-copy");
const guideOsButtons = [...document.querySelectorAll(".iguide__osbtn")];

/**
 * GitHub API 의 주소 — 기본은 진짜. 127.0.0.1 · localhost 에서 열린 페이지만
 * ?api= 로 바꿀 수 있다(가짜 GitHub 로 검증하는 길). 그 밖의 출처는 무시한다.
 */
const API_BASE = /^(127\.0\.0\.1|localhost)$/.test(location.hostname)
  ? new URLSearchParams(location.search).get("api") ?? "https://api.github.com"
  : "https://api.github.com";

/** 요청이 다 만들어지면 매번 같은 머리 — 코드는 여기만 실린다. */
const apiHeaders = () => ({
  Authorization: `Bearer ${state.token.trim()}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

/** 페이지의 상태 전부 — render() 가 이것만 본다. */
const state = {
  token: "",
  /** 불러온 레포: 체크박스 행의 원료. */
  repos: [],
  listStatus: "",
  listBusy: false,
  search: "",
  /** 고른 프로젝트: 순서가 초대장 순서다. */
  projects: [],
  author: "",
  reviewers: "",
  manualUrl: "",
  /**
   * /user/repos 응답의 x-oauth-scopes — 고전 토큰의 범위 목록. undefined 는
   * "아직 불러오지 않았다", null 은 "헤더가 없었다"(세밀 토큰)다(PLAN L11
   * 권한 확인).
   */
  scopes: undefined,
  /** 개발자 알림(Slack) — 웹훅 주소 또는 봇 토큰+채널. */
  slackWebhook: "",
  slackBotToken: "",
  slackChannel: "",
};

const params = new URLSearchParams(location.search);
const tokenWarning = document.createElement("p");
if (params.get("token")) {
  // 주소창의 ?token= 은 쓰지 않는다 — 주소는 로그와 공유에 남는다.
  tokenWarning.className = "irepos__status irepos__status--error";
  tokenWarning.textContent =
    "주소창의 ?token= 은 쓰지 않습니다 — 연결 코드는 폼에만 붙여넣고 주소창에서 지워 주세요.";
  form.before(tokenWarning);
}

/** 리뷰어 칸(쉼표·공백 구분) → 목록. */
function parseLogins(text) {
  return text
    .split(/[,\s]+/)
    .map((login) => login.trim())
    .filter(Boolean);
}

/** 지금 입력으로 만들 안쪽 JSON — 미리 보기(토큰 가림)와 봉인이 같은 값을 본다. */
function buildValues() {
  const commonReviewers = parseLogins(state.reviewers);
  const slack = slackValue();
  return buildInvite({
    token: state.token,
    author: state.author,
    // 초대 v4(PLAN 단계 5): 개발자 알림이 갈 Slack 길은 기계 몫이다.
    ...(slack ? { notify: { slack } } : {}),
    projects: state.projects.map((project) => {
      // 행의 리뷰어가 있으면 그 행은 행의 것, 없으면 공통 — 둘 다 없으면 싣지
      // 않는다. 공통 리뷰어를 최상위로 넘겨 봐야 projects 가 있으면 버려진다.
      const reviewers = project.reviewers.trim() ? parseLogins(project.reviewers) : commonReviewers;
      const defaults = {
        ...(project.provider ? { provider: project.provider } : {}),
        ...(project.model?.trim() ? { model: project.model.trim() } : {}),
        ...(project.effort ? { effort: project.effort } : {}),
      };
      // 수명 칸은 기본값이 채워져 있다 — 개발자가 건드리지 않아도 그 값이
      // 실려, 나중에 도구의 기본이 바뀌어도 이 초대장의 뜻은 변하지 않는다.
      const lifecycle = {
        deleteMergedBranches: project.deleteMergedBranches,
        keepRejectedDays: project.keepRejectedDays,
        autoReply: project.autoReply,
        submitFromChat: project.submitFromChat,
      };
      return {
        repoUrl: project.repoUrl,
        name: project.name,
        baseBranch: project.baseBranch,
        instructions: project.instructions,
        ...(reviewers.length > 0 ? { reviewers } : {}),
        ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
        lifecycle,
      };
    }),
  });
}

/**
 * Slack 칸의 값을 notify.slack 모양으로 — 웹훅이 있으면 웹훅, 없으면 봇
 * 토큰과 채널이 함께 있을 때만 봇이다. 반쪽짜리 봇 입력은 없는 것으로 친다.
 */
function slackValue() {
  const webhook = state.slackWebhook.trim();
  if (webhook) return { kind: "webhook", url: webhook };
  const token = state.slackBotToken.trim();
  const channel = state.slackChannel.trim();
  if (token && channel) return { kind: "bot", token, channel };
  return null;
}

/**
 * 이 연결 코드가 저장소에 알림(이슈·코멘트)을 남길 수 있는가 — 고전 토큰의
 * `repo` 범위가 보이면 된다(PLAN L11 권한). 세밀 토큰은 헤더가 없어 확인할
 * 수 없다.
 */
function canNotifyRepo() {
  return typeof state.scopes === "string" && state.scopes.split(",").map((s) => s.trim()).includes("repo");
}

/** 봉투(v3) → 내려받기·보내기가 건네는 File 한 장 — 이름은 render 가 정한다. */
function inviteFile(envelope, name) {
  return new File([`${JSON.stringify(envelope, null, 2)}\n`], name, {
    type: "application/json",
  });
}

/** 메일 앱에 여는 초안 — 첨부는 브라우저가 못 하니 본문이 그 자리를 안내한다.
 *  세 줄은 안내문 블록과 같은 것(4단계) — 고른 OS 만 담는다. */
function mailtoHref(values) {
  const subject = `[Colo Design] ${values.authorName ?? values.projects[0].name} 초대 파일`;
  const body = [
    // "외" 뒤에는 나머지 수(전체 − 1)가 온다 — 1개면 "외" 없이.
    `${values.authorName ?? ""} ${values.projects[0].name}${
      values.projects.length > 1 ? ` 외 ${values.projects.length - 1}개 프로젝트` : ""
    } 작업을 위한 Colo Design 초대 파일을 보냅니다.`.trim(),
    "",
    ...values.projects.map((project) => `- ${project.name} (${project.repoUrl})`),
    "",
    ...guideLinesFor(guideOs),
    "",
    "가져오기가 끝나면 초대 파일을 지워 주세요 — 연결 코드가 들어 있습니다.",
    "",
    "※ 이 메일에는 파일이 첨부되지 않았습니다 — 내려받은 초대 파일을 첨부해 보내세요.",
  ].join("\n");
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ---------------------------------------------------------------------------
// 사용자에게 보낼 안내문(4단계) — 고른 OS 에 맞춘 세 줄. 개발자가 메일에
// 붙여 넣는 문장이라 비밀은 하나도 없다: 앱 내려받기 링크와 절차만 실린다.
// ---------------------------------------------------------------------------

const GUIDE_INSTALL_LINE = {
  mac: "설치: https://github.com/inkwonjung-colosseum/colo-design/releases/latest 에서 colo-design-…-mac-arm64.dmg 를 내려받아 설치하세요. 처음 열 때 막히면 시스템 설정 → 개인정보 보호 및 보안에서 확인 없이 열기를 눌러 주세요.",
  win: '설치: https://github.com/inkwonjung-colosseum/colo-design/releases/latest 에서 colo-design-Setup-…-win-x64.exe 를 내려받아 설치하세요. 처음 실행할 때 한 번만 "추가 정보" → "실행" 을 눌러 주세요.',
};
const GUIDE_COMMON_LINES = [
  '앱이 필요한 것을 스스로 설치합니다. "Claude Code 로그인" 을 누르고 브라우저에서 본인 계정으로 로그인만 하면 됩니다.',
  "준비가 끝나면 함께 보낸 초대 파일을 앱 창에 끌어다 놓으세요. 그다음부터는 앱을 켜면 바로 작업 화면이 열립니다.",
];
/** 고른 OS 의 세 줄 — 메일 초안과 복사 버튼이 같은 것을 쓴다. */
const guideLinesFor = (os) => [GUIDE_INSTALL_LINE[os], ...GUIDE_COMMON_LINES];

// 기본은 페이지를 연 개발자의 OS — 받는 사람이 아니라 보내는 쪽의 기계다.
let guideOs = navigator.userAgent.includes("Win") ? "win" : "mac";

function renderGuide() {
  guideLines.replaceChildren(
    ...guideLinesFor(guideOs).map((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      return item;
    }),
  );
  for (const button of guideOsButtons) {
    const on = button.dataset.os === guideOs;
    button.classList.toggle("iguide__osbtn--on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

for (const button of guideOsButtons) {
  button.addEventListener("click", () => {
    guideOs = button.dataset.os;
    renderGuide();
    // 메일 초안의 세 줄도 고른 OS 로 다시 만들어 둔다 — 다음에 열리는 초안부터.
    if (!mailto.hidden) mailto.href = mailtoHref(buildValues());
  });
}

guideCopy.addEventListener("click", () => {
  void navigator.clipboard
    .writeText(guideLinesFor(guideOs).join("\n"))
    .then(() => {
      guideCopy.textContent = "복사했어요";
      window.setTimeout(() => {
        guideCopy.textContent = "안내문 복사";
      }, 2500);
    })
    .catch(() => undefined);
});

renderGuide();

/** OS 공유 시트가 이 파일을 받을 수 있는지 — 지원이 없으면 버튼이 아예 안 선다. */
function canShare(file) {
  if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") {
    return false;
  }
  return navigator.canShare({ files: [file] });
}

// ---------------------------------------------------------------------------
// 레포 목록 — Link 머리의 rel="next" 를 따라 최대 10쪽.
// ---------------------------------------------------------------------------

/** 불러온 레포의 행 하나 — 체크와 개발 서버 확인 배지를 달고 산다. */
function repoRow(repo) {
  const row = document.createElement("li");
  row.className = "irepos__row";
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = state.projects.some((project) => project.repoUrl === repo.cloneUrl);
  box.addEventListener("change", () => {
    if (box.checked) checkRepo(repo);
    else uncheckRepo(repo.cloneUrl);
  });
  const name = document.createElement("span");
  name.className = "irepos__name";
  name.textContent = repo.fullName;
  const branch = document.createElement("span");
  branch.className = "irepos__branch";
  branch.textContent = repo.defaultBranch;
  label.append(box, name, branch);
  if (repo.private) {
    const badge = document.createElement("span");
    badge.className = "irepos__badge";
    badge.textContent = "비공개";
    label.append(badge);
  }
  // 개발 서버 확인(B-3)의 자리 — 늦게 도착하면 여기에 달린다.
  const dev = document.createElement("span");
  dev.className = "irepos__badge irepos__badge--warn";
  dev.hidden = true;
  row.append(label, dev);
  repo.devBadge = dev;
  return row;
}

/** 검색에 맞는 불러온 레포만 줄 세운다. */
function renderRepos() {
  const query = state.search.trim().toLowerCase();
  const rows = state.repos.filter((repo) => repo.fullName.toLowerCase().includes(query));
  reposSearch.replaceChildren(...rows.map((repo) => repo.row));
  reposList.hidden = state.repos.length === 0;
}

/** GET /user/repos — push 가능하고 보관되지 않은 것만 남긴다. */
async function loadRepos() {
  const token = state.token.trim();
  if (!token || state.listBusy) return;
  state.listBusy = true;
  state.repos = [];
  state.listStatus = "레포 목록을 불러오는 중…";
  renderStatus();
  let url = `${API_BASE}/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100`;
  const all = [];
  try {
    for (let page = 0; page < 10; page += 1) {
      const reply = await fetch(url, { headers: apiHeaders() });
      // 권한 확인(PLAN L11): 고전 토큰은 x-oauth-scopes 에 범위를 실어
      // 보낸다 — `repo` 가 있으면 저장소에 알림을 남길 수 있다고 본다.
      // 세밀 토큰은 헤더가 없어 확인할 수 없다(null).
      if (state.scopes === undefined) {
        state.scopes = reply.headers.get("x-oauth-scopes");
      }
      if (reply.status === 401) {
        state.listStatus = "연결 코드가 거절됐어요 — 코드를 다시 확인해 주세요.";
        break;
      }
      if (reply.status === 403 && reply.headers.get("x-ratelimit-remaining") === "0") {
        state.listStatus = "GitHub 사용 한도에 걸렸어요 — 잠시 뒤 다시 시도해 주세요.";
        break;
      }
      if (!reply.ok) {
        state.listStatus = "GitHub 에 연결하지 못했어요 — 잠시 뒤 다시 시도해 주세요.";
        break;
      }
      const list = await reply.json();
      all.push(
        ...list
          .filter((repo) => repo.permissions?.push === true && repo.archived !== true)
          .map((repo) => ({
            fullName: repo.full_name,
            defaultBranch: repo.default_branch || "main",
            private: repo.private === true,
            cloneUrl: `https://github.com/${repo.full_name}.git`,
          })),
      );
      const next = reply.headers.get("Link")?.match(/<([^>]+)>\s*;\s*rel="next"/)?.[1];
      if (!next) break;
      // 다음 쪽 주소가 API 의 호스트가 아니면 거기서 멈춘다 — 연결 코드를 실은
      // 요청이 다른 호스트로 가는 일을 원천 차단한다.
      try {
        if (new URL(next).origin !== new URL(API_BASE).origin) break;
      } catch {
        break;
      }
      url = next; // GitHub 은 절대 주소를 준다 — 같은 호스트만 따라간다.
    }
    if (state.listStatus.startsWith("레포 목록")) {
      state.listStatus =
        all.length === 0
          ? "이 코드로 쓸 수 있는 레포가 없어요 — 코드의 권한을 확인하거나 아래에 주소를 직접 넣어 주세요."
          : `쓸 수 있는 레포 ${all.length}개`;
      state.repos = all;
      for (const repo of state.repos) repo.row = repoRow(repo);
      prefillRepos();
    }
  } catch {
    state.listStatus = "GitHub 에 연결하지 못했어요 — 잠시 뒤 다시 시도해 주세요.";
  } finally {
    state.listBusy = false;
    renderStatus();
    // 목록(성공이든 실패든)을 그리고 — render 가 체크박스를 고른 프로젝트와
    // 맞춘다. prefillRepos 가 있든 없든 목록은 그려져야 한다.
    renderRepos();
    render();
  }
}

function renderStatus() {
  reposStatus.hidden = state.listStatus === "";
  reposStatus.textContent = state.listStatus;
}

/** github.com 의 owner/repo 두 조각 — 아니면 null(확인하지 않는다). */
function githubSlugOf(url) {
  const match = /(?:^|@|\/\/)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
    url.trim(),
  );
  return match ? { owner: match[1], name: match[2] } : null;
}

function checkRepo(repo) {
  const project = {
    repoUrl: repo.cloneUrl,
    name: repo.fullName.split("/")[1] ?? repo.fullName,
    baseBranch: repo.defaultBranch,
    instructions: "",
    reviewers: "",
    // 초대 v4(PLAN 단계 5): 새 대화의 처음 값과 수명 — 기본값이 채워져 있다.
    provider: "",
    model: "",
    effort: "",
    deleteMergedBranches: true,
    keepRejectedDays: 14,
    autoReply: true,
    submitFromChat: true,
    key: repo.cloneUrl,
    devChecked: false,
    devWarning: null,
  };
  state.projects.push(project);
  void checkDevServer(project);
  render();
}

function uncheckRepo(cloneUrl) {
  state.projects = state.projects.filter((project) => project.repoUrl !== cloneUrl);
  render();
}

/** 주소의 마지막 조각 — 이름의 기본값. */
function repoNameOf(url) {
  const last = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean)
    .at(-1);
  return last ?? url.trim();
}

function addManual(url, baseBranch = "main") {
  const trimmed = url.trim();
  if (!trimmed) return;
  if (state.projects.some((project) => project.repoUrl === trimmed)) return;
  const project = {
    repoUrl: trimmed,
    name: repoNameOf(trimmed),
    baseBranch,
    instructions: "",
    reviewers: "",
    // 초대 v4(PLAN 단계 5): 새 대화의 처음 값과 수명 — 기본값이 채워져 있다.
    provider: "",
    model: "",
    effort: "",
    deleteMergedBranches: true,
    keepRejectedDays: 14,
    autoReply: true,
    submitFromChat: true,
    key: trimmed,
    devChecked: false,
    devWarning: null,
  };
  state.projects.push(project);
  // github.com 의 owner/repo 라면 직접 넣은 주소도 같은 확인을 돌린다.
  void checkDevServer(project);
  render();
}

/** ?repos= — 목록에 있으면 체크, 없으면 직접 추가. 목록을 부른 뒤에만 될 수 있다. */
function prefillRepos() {
  for (const wanted of params.getAll("repos").flatMap((value) => value.split(","))) {
    const slug = wanted.trim().toLowerCase();
    if (!slug) continue;
    const repo = state.repos.find((entry) => entry.fullName.toLowerCase() === slug);
    if (repo) {
      if (!state.projects.some((project) => project.repoUrl === repo.cloneUrl)) checkRepo(repo);
    } else {
      addManual(`https://github.com/${slug}.git`);
    }
  }
}

/**
 * 개발 서버 확인(고를 때 한 번) — package.json 의 scripts 를 본다. 결과는 고른
 * 프로젝트 행에 달고, 불러온 목록의 같은 행에도 복제한다 — 개발자가 실제로 보는
 * 쪽은 고른 프로젝트 목록이다.
 */
async function checkDevServer(project) {
  if (project.devChecked) return;
  project.devChecked = true;
  const slug = githubSlugOf(project.repoUrl);
  if (!slug) return; // github.com 의 owner/repo 가 아니면 확인하지 않는다.
  try {
    const reply = await fetch(`${API_BASE}/repos/${slug.owner}/${slug.name}/contents/package.json`, {
      headers: apiHeaders(),
    });
    if (reply.status === 404) {
      showDevWarning(project, "package.json 없음");
      return;
    }
    if (!reply.ok) return; // 실패는 조용히 — 배지 없음.
    const file = await reply.json();
    const text = atob((file.content ?? "").replace(/\n/g, ""));
    const scripts = JSON.parse(text)?.scripts ?? {};
    const hasServer = ["dev", "start", "serve", "preview"].some((key) => key in scripts);
    if (!hasServer) {
      showDevWarning(project, "개발 서버 스크립트 없음 — 사용자 화면에서 AI 가 먼저 고치려 들 수 있어요");
    }
  } catch {
    // 조용히 — 확인은 덤이다.
  }
}

/** 확인 결과를 프로젝트와 목록 행에 같이 달고 다시 그린다. */
function showDevWarning(project, text) {
  project.devWarning = text;
  const repo = state.repos.find((entry) => entry.cloneUrl === project.repoUrl);
  if (repo?.devBadge) {
    repo.devBadge.textContent = text;
    repo.devBadge.hidden = false;
  }
  render();
}


// ---------------------------------------------------------------------------
// 고른 프로젝트 — 행마다 이름 · 기본 가지 · 접힌 지침과 리뷰어.
// ---------------------------------------------------------------------------


/** 고른 프로젝트의 행 하나 — 삭제와 접힌 세부가 달려 있다. */
function chosenRow(project, index) {
  const row = document.createElement("div");
  row.className = "ichosen__row";

  const head = document.createElement("div");
  head.className = "ichosen__rowhead";
  const num = document.createElement("span");
  num.className = "ichosen__num";
  num.textContent = String(index + 1);
  const name = document.createElement("input");
  name.value = project.name;
  name.placeholder = "프로젝트 이름";
  name.setAttribute("aria-label", `${index + 1}번 프로젝트 이름`);
  name.addEventListener("input", () => {
    project.name = name.value;
    render();
  });
  const branch = document.createElement("input");
  branch.value = project.baseBranch;
  branch.placeholder = "기본 가지";
  branch.setAttribute("aria-label", `${index + 1}번 프로젝트 기본 가지`);
  branch.addEventListener("input", () => {
    project.baseBranch = branch.value;
    render();
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn";
  remove.textContent = "삭제";
  remove.addEventListener("click", () => {
    state.projects = state.projects.filter((entry) => entry !== project);
    if (project.key) {
      const repo = state.repos.find((entry) => entry.cloneUrl === project.key);
      if (repo) repo.row.querySelector("input").checked = false;
    }
    render();
  });
  head.append(num, name, branch, remove);

  // 개발 서버 확인의 경고 — 개발자가 실제로 보는 이 행에 달린다(조립은 아래
  // row.append 에서: 이 시점의 head 는 아직 부모가 없어 after() 가 묵살된다).
  const warning = document.createElement("span");
  warning.className = "irepos__badge irepos__badge--warn ichosen__devbadge";
  warning.textContent = project.devWarning ?? "";
  warning.hidden = !project.devWarning;


  const fold = document.createElement("details");
  fold.className = "ichosen__fold";
  const summary = document.createElement("summary");
  summary.textContent = "이 프로젝트만의 설정";
  fold.append(summary);

  const guideLabel = document.createElement("label");
  guideLabel.className = "ifield";
  const guideText = document.createElement("span");
  guideText.className = "ifield__label";
  guideText.textContent = "지켜 줄 것 (선택)";
  const guide = document.createElement("textarea");
  guide.rows = 3;
  guide.placeholder = "예: 목 데이터는 mock 폴더에만 둔다";
  guide.value = project.instructions;
  guide.addEventListener("input", () => {
    project.instructions = guide.value;
    render();
  });
  guideLabel.append(guideText, guide);

  const reviewerLabel = document.createElement("label");
  reviewerLabel.className = "ifield";
  const reviewerText = document.createElement("span");
  reviewerText.className = "ifield__label";
  reviewerText.textContent = "이 프로젝트만의 리뷰어 (선택)";
  const reviewers = document.createElement("input");
  reviewers.placeholder = "dev1, dev2 — 비우면 공통 리뷰어";
  reviewers.value = project.reviewers;
  reviewers.addEventListener("input", () => {
    project.reviewers = reviewers.value;
    render();
  });
  reviewerLabel.append(reviewerText, reviewers);

  // 초대 v4(PLAN 단계 5): 새 대화의 처음 값 — 비우면 도구의 기본이 선다.
  const defaultsLabel = document.createElement("div");
  defaultsLabel.className = "ifield";
  const defaultsText = document.createElement("span");
  defaultsText.className = "ifield__label";
  defaultsText.textContent = "새 대화의 처음 값 (선택)";
  const defaultsRow = document.createElement("div");
  defaultsRow.className = "iform__row iform__row--three";
  const providerSel = document.createElement("select");
  providerSel.setAttribute("aria-label", `${index + 1}번 프로젝트 기본 프로바이더`);
  for (const [value, label] of [
    ["", "프로바이더 — 도구 기본"],
    ["claude", "Claude"],
    ["codex", "Codex"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    providerSel.append(option);
  }
  providerSel.value = project.provider;
  providerSel.addEventListener("change", () => {
    project.provider = providerSel.value;
    render();
  });
  const modelInput = document.createElement("input");
  modelInput.placeholder = "모델 — 예: sonnet";
  modelInput.value = project.model;
  modelInput.setAttribute("aria-label", `${index + 1}번 프로젝트 기본 모델`);
  modelInput.addEventListener("input", () => {
    project.model = modelInput.value;
    render();
  });
  const effortSel = document.createElement("select");
  effortSel.setAttribute("aria-label", `${index + 1}번 프로젝트 기본 생각 시간`);
  for (const [value, label] of [
    ["", "생각 시간 — 도구 기본"],
    ["low", "낮음"],
    ["medium", "보통"],
    ["high", "높음"],
    ["xhigh", "아주 높음"],
    ["max", "최대"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    effortSel.append(option);
  }
  effortSel.value = project.effort;
  effortSel.addEventListener("change", () => {
    project.effort = effortSel.value;
    render();
  });
  defaultsRow.append(providerSel, modelInput, effortSel);
  defaultsLabel.append(defaultsText, defaultsRow);

  // 초대 v4: 사이클의 수명 — 기본값이 채워져 있고, 건드리면 그 값이 실린다.
  const lifeLabel = document.createElement("div");
  lifeLabel.className = "ifield";
  const lifeText = document.createElement("span");
  lifeText.className = "ifield__label";
  lifeText.textContent = "사이클 수명";
  const lifeRow = document.createElement("div");
  lifeRow.className = "ichosen__life";
  const check = (label, key) => {
    const wrap = document.createElement("label");
    wrap.className = "icheck";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = project[key];
    box.addEventListener("change", () => {
      project[key] = box.checked;
      render();
    });
    const text = document.createElement("span");
    text.textContent = label;
    wrap.append(box, text);
    return wrap;
  };
  const daysWrap = document.createElement("label");
  daysWrap.className = "icheck";
  const daysText = document.createElement("span");
  daysText.textContent = "반려 보관";
  const days = document.createElement("input");
  days.type = "number";
  days.min = "1";
  days.max = "365";
  days.value = String(project.keepRejectedDays);
  days.setAttribute("aria-label", `${index + 1}번 프로젝트 반려 보관 일수`);
  days.addEventListener("input", () => {
    const parsed = Number.parseInt(days.value, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 365) {
      project.keepRejectedDays = parsed;
      render();
    }
  });
  const daysTail = document.createElement("span");
  daysTail.textContent = "일";
  daysWrap.append(daysText, days, daysTail);
  lifeRow.append(
    check("병합된 브랜치 정리", "deleteMergedBranches"),
    daysWrap,
    check("코멘트 자동 답장", "autoReply"),
    check("채팅으로 제출", "submitFromChat"),
  );
  lifeLabel.append(lifeText, lifeRow);

  fold.append(guideLabel, reviewerLabel, defaultsLabel, lifeLabel);
  // head → (경고가 있으면 보이는) 배지 → fold 순서로.
  row.append(head, warning, fold);
  return row;
}

// ---------------------------------------------------------------------------
// 봉인 캐시와 그림 — 순번 카운터가 늦게 도착한 옛 결과를 버린다.
// ---------------------------------------------------------------------------

let sealedFile = null;
let sealedName = "";
let sealTicket = 0;

async function render() {
  const values = buildValues();
  // 권한 확인(PLAN L11): 저장소에 알림을 남길 수 있는지 확인하지 못하는
  // 연결 코드(세밀 토큰)는 Slack 길이 필수다 — 둘 다 없으면 만들 수 없다.
  const notifyOk = canNotifyRepo() || slackValue() !== null;
  // 작업 이름은 필수다 — 비면 봉인·내려받기·보내기 어느 것도 켜지지 않고,
  // 이유가 actions 바로 위 한 줄로 선다.
  const ready = Boolean(
    state.token.trim() && state.author.trim() && values.projects.length > 0 && notifyOk,
  );
  const ticket = ++sealTicket;
  // 입력이 움직였다 옛 봉인은 현재 입력의 것이 아니다 — 새 것이 올 때까지
  // 내려받기·공유는 꺼진다.
  sealedFile = null;
  download.disabled = true;
  share.hidden = true;
  chosenCount.textContent = state.projects.length > 0 ? `${state.projects.length}개` : "";
  chosenRows.replaceChildren(...state.projects.map((project, index) => chosenRow(project, index)));
  // 불러온 목록의 체크박스를 고른 프로젝트와 맞춘다 — 미리 채움(?repos=)이 체크를
  // 놓치지 않게, 행을 다시 만들지 않고 checked 만 동기화한다.
  for (const repo of state.repos) {
    const box = repo.row?.querySelector("input");
    if (box) box.checked = state.projects.some((project) => project.repoUrl === repo.cloneUrl);
  }
  // 작업 이름 안내는 마지막 남은 빈칸일 때만 — 연결 코드와 프로젝트가 이미
  // 갖춰져 이름만 비었을 때 보인다. 처음부터 보이면 아무것도 넣지 않은
  // 사람에게 오류로 읽힌다.
  const authorMissing =
    !state.author.trim() && Boolean(state.token.trim()) && values.projects.length > 0;
  authorStatus.hidden = !authorMissing;
  if (authorMissing) {
    authorStatus.textContent = "작업 이름을 적어 주세요 — 넘긴 요청에 작성자로 적힙니다.";
  }
  // Slack 칸이 필수가 된 이유 — 확인할 수 없는 연결 코드에는 이 한 줄이 선다.
  const notifyMissing =
    !notifyOk && Boolean(state.token.trim()) && values.projects.length > 0;
  notifyStatus.hidden = !notifyMissing;
  if (notifyMissing) {
    notifyStatus.textContent =
      "이 연결 코드로는 문제가 생겼을 때 저장소에 알림을 남길 수 있는지 확인하지 못했어요 — 슬랙 주소를 넣어 주세요.";
  }
  filename.textContent = ready
    ? inviteFileName({ author: state.author, name: values.projects[0].name })
    : "";
  // 미리 보기는 비밀을 가린 채 형식만 보여 준다 — 실제 파일에는 진짜 코드가 간다.
  preview.textContent = JSON.stringify({ ...values, token: state.token.trim() ? "••••••••" : "" }, null, 2);
  mailto.hidden = !ready;
  if (ready) mailto.href = mailtoHref(values);
  if (!ready) return;
  const envelope = await sealInvite(values);
  if (ticket !== sealTicket) return; // 옛 입력의 결과 — 이미 다음 봉인이 도는 중이다
  const fileBase = inviteFileName({ author: state.author, name: values.projects[0].name });
  sealedFile = inviteFile(envelope, fileBase);
  sealedName = values.authorName ?? values.projects[0].name;
  download.disabled = false;
  share.hidden = !canShare(sealedFile);
}

// ---------------------------------------------------------------------------
// 사건 연결
// ---------------------------------------------------------------------------
form.addEventListener("input", (event) => {
  const field = event.target;
  if (field === tokenInput) {
    // 코드가 바뀌면 목록의 열쇠가 달라졌다 — 불러온 목록과 권한 확인을 비운다.
    state.token = tokenInput.value;
    state.repos = [];
    state.listStatus = "";
    state.scopes = undefined;
    renderRepos();
    renderStatus();
  }
  if (field.name === "author") {
    state.author = field.value;
    render();
  }
  if (field.name === "reviewers") {
    state.reviewers = field.value;
    render();
  }
  // 초대 v4(PLAN 단계 5): 개발자 알림이 갈 Slack 길 — 웹훅 또는 봇 토큰+채널.
  if (field.name === "slackWebhook") {
    state.slackWebhook = field.value;
    render();
  }
  if (field.name === "slackBotToken") {
    state.slackBotToken = field.value;
    render();
  }
  if (field.name === "slackChannel") {
    state.slackChannel = field.value;
    render();
  }
});
searchInput.addEventListener("input", () => {
  state.search = searchInput.value;
  renderRepos();
});

reposLoad.addEventListener("click", () => {
  state.token = tokenInput.value;
  void loadRepos();
});

manualAdd.addEventListener("click", () => {
  addManual(manualUrl.value);
  manualUrl.value = "";
});

manualUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addManual(manualUrl.value);
    manualUrl.value = "";
  }
});

tokenToggle.addEventListener("click", () => {
  const showing = tokenInput.type === "text";
  tokenInput.type = showing ? "password" : "text";
  tokenToggle.textContent = showing ? "보기" : "숨기기";
  tokenToggle.setAttribute("aria-label", showing ? "연결 코드 보이기" : "연결 코드 숨기기");
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  // 캐시된 File 을 동기적으로 쓴다 — 봉인을 기다리는 사이 사용자 제스처를 잃지 않는다(Safari).
  const file = sealedFile;
  if (!file) return;
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  URL.revokeObjectURL(url);
});

share.addEventListener("click", () => {
  // 같은 이유로 동기적으로 꺼낸다 — navigator.share 는 제스처 안에서 불려야 한다.
  const file = sealedFile;
  if (!file) return;
  void navigator
    .share({
      files: [file],
      title: `${sealedName} 초대 파일`,
      text: "Colo Design 초대 파일입니다 — 가져온 뒤에는 지워 주세요.",
    })
    .catch(() => {
      // 사용자가 공유 시트를 닫은 것도 여기로 온다 — 다시 누르면 되니 조용히 둔다.
    });
});

// 미리 채움 — 주소로 주는 것들은 목록 없이도 바로 받는다.
if (params.get("author")) form.elements.author.value = params.get("author");
if (params.get("reviewers")) form.elements.reviewers.value = params.get("reviewers");
// 옛 ?repo= · ?base= — 직접 추가 한 줄로 받아 준다.
if (params.get("repo")) addManual(params.get("repo"), params.get("base") ?? "main");
state.author = form.elements.author.value;
state.reviewers = form.elements.reviewers.value;
render();

/* 스크롤 리빌 — .js 를 먼저 달아 숨김 상태를 켜고, 들어온 요소에 .in 을 단다.
   IntersectionObserver 가 답하지 않는 환경(숨겨진 탭 등)을 위해 스크롤 폴백을 둔다. */
document.documentElement.classList.add("js");
const revealTargets = [...document.querySelectorAll(".section, .appwin")];
const revealInView = () => {
  for (const el of revealTargets) {
    if (el.classList.contains("in")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.92 && rect.bottom > 0) el.classList.add("in");
  }
};
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of revealTargets) observer.observe(el);
}
window.addEventListener("scroll", revealInView, { passive: true });
revealInView();
