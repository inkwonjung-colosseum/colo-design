/**
 * 팔레트 고르기 — <head> 에서 동기로 도는 작은 스크립트.
 *
 * 앱의 설정 → 테마와 같은 선택지다: Claude · Codex · 밝음 · 어두움 · GitHub 밝음 ·
 * GitHub 어두움, 그리고 시스템 따르기(밝음과 어두움을 OS 설정으로 고른다). 저장된
 * 선택은 첫 페인트 전에 <html data-theme> 로 입힌다 — 모듈 스크립트가 도는 뒤에
 * 입히면 밝은 테마를 고른 사람이 새로 고칠 때마다 어두운 화면이 번쩍인다.
 *
 * 기본은 어두움이다(속성이 없는 :root). 고르는 자리(기능의 테마 카드)는 bento.js 가
 * 그리고, 여기서는 window.novaTheme 로 읽고 쓰는 문만 낸다. 바뀔 때마다 nova-theme
 * 이벤트(detail = 실제로 입힌 팔레트 이름)를 쏜다 — hero3d 의 파티클 색이 따라온다.
 */
(() => {
  const KEY = "nova-site-theme";
  const CHOICES = ["dark", "light", "claude", "github", "github-light", "codex", "system"];
  const META = {
    dark: "#0d0d0f",
    light: "#ffffff",
    claude: "#faf9f5",
    github: "#0d1117",
    "github-light": "#ffffff",
    codex: "#ffffff",
  };

  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");

  let choice = "dark";
  try {
    const saved = localStorage.getItem(KEY);
    if (CHOICES.includes(saved)) choice = saved;
  } catch {
    // file:// 나 저장 금지 환경 — 기본 팔레트로 만족한다.
  }

  /** 시스템 따르기는 그 순간의 OS 설정으로 풀린다. */
  const resolve = (name) => (name === "system" ? (media.matches ? "dark" : "light") : name);

  function paint() {
    const name = resolve(choice);
    if (name === "dark") delete root.dataset.theme;
    else root.dataset.theme = name;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = META[name];
    dispatchEvent(new CustomEvent("nova-theme", { detail: name }));
  }

  // OS 가 밝음 ↔ 어두움을 바꾸면 시스템 따르기만 따라간다.
  media.addEventListener("change", () => {
    if (choice === "system") paint();
  });

  window.novaTheme = {
    /** 사람이 고른 이름 — system 도 그대로 돌려준다(카드의 눌림 표시가 읽는다). */
    get choice() {
      return choice;
    },
    choices: CHOICES,
    set(next) {
      if (!CHOICES.includes(next)) return;
      choice = next;
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // 마찬가지 — 이 세션 동안만 테마가 바뀐다.
      }
      paint();
    },
  };

  paint();
})();
