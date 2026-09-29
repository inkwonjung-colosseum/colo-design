/**
 * 소개 페이지의 자잘한 살아 있는 자리들 — 최신 릴리스 · 내 컴퓨터 · 복사 · 설치 체크리스트 ·
 * 지금 보는 구역.
 *
 * 릴리스 정보는 GitHub 의 공개 릴리스 API 한 번이다(무인증, 브라우저 세션에 10분 캐시).
 * 답이 없거나 형식이 다르면 아무것도 바꾸지 않는다 — 링크는 릴리스 페이지 그대로, 파일
 * 이름은 `<버전>` 자리표시 그대로다. 버전을 손으로 적어 두지 않으므로 낡을 일이 없다.
 * 초대장 폼도 GitHub 에만 요청을 보내므로 "요청은 GitHub 에만" 이라는 말이 그대로 참이다.
 */

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- 최신 릴리스 — 버전과 내려받기 링크 ---------- */
const RELEASE_API = "https://api.github.com/repos/inkwonjung-colosseum/nova-design/releases/latest";
const CACHE_KEY = "nova-site-release";
const CACHE_MS = 10 * 60 * 1000;

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw);
    return Date.now() - at < CACHE_MS ? data : null;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // 저장 금지 환경 — 다음 방문에 다시 묻는다.
  }
}

/** 파일 크기 — 바이트 → "307 MB". */
const formatSize = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

async function fetchRelease() {
  const cached = readCache();
  if (cached) return cached;
  const reply = await fetch(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
    signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(6000) : undefined,
  });
  if (!reply.ok) throw new Error(`release ${reply.status}`);
  const release = await reply.json();
  const tag = String(release.tag_name ?? "");
  if (!/^v?\d+\.\d+\.\d+/.test(tag)) throw new Error("release tag");
  // 내려받기 링크는 GitHub 안의 주소만 받는다.
  const pick = (pattern) => {
    const asset = (release.assets ?? []).find((entry) => pattern.test(entry.name));
    const url = asset?.browser_download_url;
    return typeof url === "string" && url.startsWith("https://github.com/")
      ? { name: asset.name, size: asset.size, url }
      : null;
  };
  const data = {
    version: tag.replace(/^v/, ""),
    mac: pick(/-mac-arm64\.dmg$/),
    win: pick(/-win-x64\.exe$/),
  };
  writeCache(data);
  return data;
}

function applyRelease(release) {
  const chip = $("hero-version");
  if (chip) {
    chip.textContent = `v${release.version}`;
    chip.hidden = false;
  }
  for (const os of ["mac", "win"]) {
    const asset = release[os];
    const row = $(`file-${os}`);
    if (!asset || !row) continue;
    row.href = asset.url;
    $(`file-${os}-name`).textContent = asset.name;
    $(`file-${os}-size`).textContent = Number.isFinite(asset.size) ? formatSize(asset.size) : "";
  }
}

fetchRelease().then(applyRelease, () => {
  // 조용히 — 릴리스 페이지 링크가 그대로 남는다.
});

/* ---------- 내 컴퓨터 — 맞는 파일 줄에 표시 ---------- */
function detectOs() {
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  if (/win/i.test(platform)) return "win";
  // iPad 의 데스크톱 모드도 MacIntel 로 답한다 — 터치 화면은 mac 이 아니다.
  if (/mac/i.test(platform) && navigator.maxTouchPoints < 2) return "mac";
  return null;
}
const myOs = detectOs();
if (myOs) $(`file-${myOs}`)?.classList.add("mine");

/* ---------- 복사 ---------- */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 클립보드 권한이 없을 때 — 임시 입력칸으로 복사한다.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

// 첫날의 말풍선 — 누르면 문장이 복사된다.
for (const row of document.querySelectorAll(".say__row[data-copy]")) {
  const label = row.querySelector(".say__copy");
  let timer = null;
  row.addEventListener("click", async () => {
    if (!(await copyText(row.dataset.copy))) return;
    row.classList.add("copied");
    if (label) label.textContent = "복사했어요";
    clearTimeout(timer);
    timer = setTimeout(() => {
      row.classList.remove("copied");
      if (label) label.textContent = "복사";
    }, 1800);
  });
}

// 개발자에게 보낼 부탁 한 줄.
const askCopy = $("ask-copy");
const askText = $("ask-text");
if (askCopy && askText) {
  let timer = null;
  askCopy.addEventListener("click", async () => {
    if (!(await copyText(askText.textContent ?? ""))) return;
    askCopy.textContent = "복사했어요";
    clearTimeout(timer);
    timer = setTimeout(() => {
      askCopy.textContent = "메시지 복사";
    }, 2200);
  });
}

/* ---------- 설치 체크리스트 — 들어오면 차례로 채우고, 다 차면 준비됐어요 ---------- */
const checklist = $("install-checklist");
if (checklist) {
  const items = [...checklist.querySelectorAll("li")];
  const done = $("install-done");
  const fillAll = () => {
    items.forEach((li, i) => {
      setTimeout(() => li.classList.add("ok"), reduced ? 0 : 550 * (i + 1));
    });
    // 셋이 다 차면 앱처럼 한 박자 뒤에 "준비됐어요"가 선다.
    setTimeout(() => done?.classList.add("show"), reduced ? 0 : 550 * items.length + 500);
  };
  if (reduced) fillAll();
  else {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          fillAll();
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -15% 0px" },
    );
    observer.observe(checklist);
  }
}

/* ---------- 지금 보는 구역 — 상단 바의 알약 ---------- */
const navLinks = [...document.querySelectorAll('.top__nav a[href^="#"]')];
const sectionOf = new Map();
for (const link of navLinks) {
  const target = document.getElementById(link.getAttribute("href").slice(1));
  if (target) sectionOf.set(target, link);
}
if (sectionOf.size > 0 && "IntersectionObserver" in window) {
  const inLine = new Set();
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) inLine.add(entry.target);
        else inLine.delete(entry.target);
      }
      // 읽는 선(화면 위쪽 40%)에 걸친 구역 중 문서에서 가장 위의 것이 지금 구역이다.
      let current = null;
      for (const target of sectionOf.keys()) {
        if (inLine.has(target)) {
          current = target;
          break;
        }
      }
      for (const [target, link] of sectionOf) {
        if (target === current) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
      }
    },
    { rootMargin: "-40% 0px -55% 0px" },
  );
  for (const target of sectionOf.keys()) spy.observe(target);
}
