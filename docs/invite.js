/**
 * 소개 페이지의 초대장 만들기 — make-invite.mjs 와 같은 v2 파일을 브라우저에서
 * 만든다. 형식은 ./invite-format.mjs(scripts/invite-format.mjs 의 그대로 복사본)가
 * 정하고, 이 파일은 입력 → 미리 보기 → 내려받기·보내기만 담당한다.
 *
 * 연결 코드는 이 페이지를 떠나지 않는다 — 정적 페이지라 요청이 나갈 곳 자체가
 * 없고, 미리 보기에는 가린 값만 그린다. 보내기 길(메일 초안 · OS 공유 시트)도
 * 파일을 브라우저 밖 서버가 아니라 로컬 앱에 건넨다.
 */
import { buildInvite, inviteFileName } from "./invite-format.mjs";

const form = document.getElementById("invite-form");
const download = document.getElementById("invite-download");
const mailto = document.getElementById("invite-mailto");
const share = document.getElementById("invite-share");
const filename = document.getElementById("invite-filename");
const preview = document.getElementById("invite-preview");
const tokenToggle = document.getElementById("token-toggle");
const tokenInput = form.elements.token;

/** 주소창의 ?repo= · ?base= 로 개발자가 반복 입력을 아낀다. */
const params = new URLSearchParams(location.search);
if (params.get("repo")) form.elements.repoUrl.value = params.get("repo");
if (params.get("base")) form.elements.baseBranch.value = params.get("base");

function readForm() {
  const data = new FormData(form);
  return {
    repoUrl: String(data.get("repoUrl") ?? "").trim(),
    name: String(data.get("name") ?? "").trim(),
    token: String(data.get("token") ?? "").trim(),
    baseBranch: String(data.get("baseBranch") ?? "").trim() || "main",
    author: String(data.get("author") ?? "").trim(),
    reviewers: String(data.get("reviewers") ?? "")
      .split(/[,\s]+/)
      .map((login) => login.trim())
      .filter(Boolean),
  };
}

function inviteFile(values) {
  return new File(
    [`${JSON.stringify(buildInvite(values), null, 2)}\n`],
    inviteFileName(values),
    { type: "application/json" },
  );
}

/** 메일 앱에 여는 초안 — 첨부는 브라우저가 못 하니 본문이 그 자리를 안내한다. */
function mailtoHref(values) {
  const subject = `[Colo Design] ${values.name} 초대 파일`;
  const body = [
    `${values.name} 작업을 위한 Colo Design 초대 파일을 보냅니다.`,
    "",
    "1. 첨부한 .colo-invite 파일을 내려받습니다.",
    "2. Colo Design 시작 화면에서 파일을 열거나 창에 끌어다 놓습니다.",
    "3. 가져오기가 끝나면 파일을 지워 주세요 — 연결 코드가 들어 있습니다.",
    "",
    "※ 이 메일에는 파일이 첨부되지 않았습니다 — 내려받은 초대 파일을 첨부해 보내세요.",
  ].join("\n");
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** OS 공유 시트가 이 파일을 받을 수 있는지 — 지원이 없으면 버튼이 아예 안 선다. */
function canShare(values) {
  if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") {
    return false;
  }
  return navigator.canShare({ files: [inviteFile(values)] });
}

function render() {
  const values = readForm();
  const ready = Boolean(values.repoUrl && values.name && values.token);
  download.disabled = !ready;
  filename.textContent = ready ? inviteFileName(values) : "";
  // 미리 보기는 비밀을 가린 채 형식만 보여 준다 — 실제 파일에는 진짜 코드가 간다.
  preview.textContent = JSON.stringify(
    { ...buildInvite(values), token: values.token ? "••••••••" : "" },
    null,
    2,
  );
  // 보내기 길은 둘 다 파일이 브라우저를 떠나지 않는다 — 메일 앱의 초안과 OS
  // 공유 시트가 각각 파일을 운반한다.
  mailto.hidden = !ready;
  if (ready) mailto.href = mailtoHref(values);
  share.hidden = !ready || !canShare(values);
}

form.addEventListener("input", render);

tokenToggle.addEventListener("click", () => {
  const showing = tokenInput.type === "text";
  tokenInput.type = showing ? "password" : "text";
  tokenToggle.textContent = showing ? "보기" : "숨기기";
  tokenToggle.setAttribute("aria-label", showing ? "연결 코드 보이기" : "연결 코드 숨기기");
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const values = readForm();
  if (!values.repoUrl || !values.name || !values.token) return;
  const file = inviteFile(values);
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  URL.revokeObjectURL(url);
});

share.addEventListener("click", async () => {
  const values = readForm();
  try {
    await navigator.share({
      files: [inviteFile(values)],
      title: `${values.name} 초대 파일`,
      text: "Colo Design 초대 파일입니다 — 가져온 뒤에는 지워 주세요.",
    });
  } catch {
    // 사용자가 공유 시트를 닫은 것도 여기로 온다 — 다시 누르면 되니 조용히 둔다.
  }
});

render();
