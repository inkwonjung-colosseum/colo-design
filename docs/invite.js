/**
 * 소개 페이지의 초대장 만들기 — make-invite.mjs 와 같은 v2 파일을 브라우저에서
 * 만든다. 형식은 ./invite-format.mjs(scripts/invite-format.mjs 의 그대로 복사본)가
 * 정하고, 이 파일은 입력 → 미리 보기 → 내려받기만 담당한다.
 *
 * 연결 코드는 이 페이지를 떠나지 않는다 — 정적 페이지라 요청이 나갈 곳 자체가
 * 없고, 미리 보기에는 가린 값만 그린다.
 */
import { buildInvite, inviteFileName } from "./invite-format.mjs";

const form = document.getElementById("invite-form");
const download = document.getElementById("invite-download");
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
  const invite = buildInvite(values);
  const blob = new Blob([`${JSON.stringify(invite, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = inviteFileName(values);
  anchor.click();
  URL.revokeObjectURL(url);
});

render();
