/**
 * 소개 페이지의 살아 있는 자리들 — 데모 타임라인 한 곳.
 *
 * 1. 테마 — 기능 벤토의 칩이 이 페이지 전체를 앱의 네 팔레트로 갈아입힌다.
 * 2. 히어로 목업 창 — 제품의 한 바퀴(말하기 → 만드는 중 → 찍기 → 제출 → 반영됨)를
 *    창 안에서 직접 돌린다. 상태 줄의 여정 세 점이 앱의 어휘로 움직인다.
 * 3. 흐름 — 네 걸음 카드가 차례로 밝아지고 여정 큰 점이 따라 옮아간다.
 * 4. 기능 벤토 — 찍기 놀이 · 작업 기록 되돌림 · 프로젝트 줄 · 알림 시연.
 * 5. 설치 체크리스트 — 화면에 들어오면 셋이 차례로 채워진다.
 *
 * prefers-reduced-motion 이면 루프를 돌리지 않고 완성된 한 장으로 멈춘다.
 * JS 가 통하지 않으면 애초에 정적 장면이 보인다(스타일의 기본값).
 */

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- 테마 — 앱의 네 팔레트를 그대로 ---------- */
const THEME_KEY = "colo-site-theme";
const THEME_META = { dark: "#0d0d0f", light: "#ffffff", claude: "#faf9f5", github: "#0d1117" };
const themeChips = [...document.querySelectorAll("[data-site-theme]")];

function applyTheme(name) {
  const root = document.documentElement;
  if (THEME_META[name] && name !== "dark") root.dataset.theme = name;
  else delete root.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_META[name] ?? THEME_META.dark;
  for (const chip of themeChips) {
    const on = chip.dataset.siteTheme === name;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
  }
  // hero3d 의 파티클 색이 따라 오는 고리.
  dispatchEvent(new CustomEvent("colo-theme", { detail: name }));
}

let savedTheme = null;
try {
  savedTheme = localStorage.getItem(THEME_KEY);
} catch {
  // file:// 나 저장 금지 환경 — 기본 팔레트로 만족한다.
}
applyTheme(THEME_META[savedTheme] ? savedTheme : "dark");

for (const chip of themeChips) {
  chip.addEventListener("click", () => {
    applyTheme(chip.dataset.siteTheme);
    try {
      localStorage.setItem(THEME_KEY, chip.dataset.siteTheme);
    } catch {
      // 마찬가지 — 이 세션 동안만 테마가 바뀐다.
    }
  });
}

/* ---------- 히어로 목업 창 — 제품의 한 바퀴 ---------- */
const appwin = $("appwin");

if (appwin) {
  const dots = [$("demo-dot0"), $("demo-dot1"), $("demo-dot2")];
  const dotLabels = dots.map((dot) => dot?.querySelector("b"));
  const submitBtn = $("demo-submit");
  const userMsg = $("demo-usermsg");
  const aiMsg = $("demo-aimsg");
  const aiText = $("demo-aitext");
  const screenCard = $("demo-screencard");
  const meta = $("demo-meta");
  const receipt = $("demo-receipt");
  const composer = appwin.querySelector(".mock-composer");
  const composerLine = composer?.querySelector(".mc-line");
  const composerCaret = $("demo-caret");
  const chip = $("demo-chip");
  const search = $("demo-search");
  const pin = $("demo-pin");
  const bubble = $("demo-bubble");
  const merged = $("demo-merged");

  const USER_LINE = "회원 목록에 검색창을 넣어 줘";
  const AI_LINE = "검색창을 넣었습니다 — 미리보기에서 확인해 보세요.";
  const typed = document.createElement("span");
  composerLine?.insertBefore(typed, composerCaret);

  // 데모가 맡는 순간부터 .show 를 기다린다 — 이 줄 뒤로 목업은 애니메이션한다.
  appwin.classList.add("demo-live");

  const show = (el, on = true) => el?.classList.toggle("show", on);

  function setJourney(active, { making = false } = {}) {
    dots.forEach((dot, i) => {
      dot.classList.toggle("on", i === active);
      dot.classList.toggle("making", i === active && making);
      dot.classList.toggle("done", i < active);
    });
  }

  function resetScene() {
    typed.textContent = "";
    composer?.classList.remove("typing");
    submitBtn.textContent = "제출";
    submitBtn.className = "mst-submit";
    for (const el of [userMsg, aiMsg, screenCard, meta, receipt, chip, search, pin, bubble, merged]) {
      show(el, false);
    }
    dotLabels[0].textContent = "제출 전 · 화면 1개";
    dotLabels[1].textContent = "개발자 확인";
    dotLabels[2].textContent = "반영됨";
    setJourney(0);
    appwin.dataset.phase = "idle";
  }

  /** 완성된 한 장 — 움직임 줄이기의 목업 창이다. */
  function staticScene() {
    resetScene();
    show(userMsg);
    show(aiMsg);
    aiText.textContent = AI_LINE;
    show(screenCard);
    show(meta);
    show(search);
    show(pin);
    show(bubble);
    show(chip);
    dotLabels[0].textContent = "제출 전 · 화면 2개";
    appwin.dataset.phase = "pin";
  }

  async function type(el, text, speed) {
    el.textContent = "";
    for (const ch of text) {
      el.textContent += ch;
      await sleep(speed);
    }
  }

  let heroVisible = true;
  new IntersectionObserver(([entry]) => {
    heroVisible = entry.isIntersecting;
  }).observe(appwin);

  async function loop() {
    for (;;) {
      // 히어로가 화면 밖이면 아무것도 태우지 않는다 — 돌아오면 이어서 한 바퀴.
      while ((!heroVisible || document.hidden) && !reduced) await sleep(400);

      resetScene();
      await sleep(1500);

      // ① 말하기 — 입력창에 한 글자씩
      appwin.dataset.phase = "compose";
      composer?.classList.add("typing");
      await type(typed, USER_LINE, 46);
      await sleep(650);

      // ② 보내기 — 대화로 내려앉고, 여정 앞에 만드는 중 · N초
      typed.textContent = "";
      composer?.classList.remove("typing");
      show(userMsg);
      appwin.dataset.phase = "making";
      setJourney(0, { making: true });
      for (let s = 1; s <= 8; s += 1) {
        await sleep(680);
        dotLabels[0].textContent = `만드는 중 · ${s}초`;
      }

      // ③ 답 — 흐르고, 고친 화면 카드, 미리보기에 검색창이 자란다
      show(aiMsg);
      await type(aiText, AI_LINE, 15);
      show(screenCard);
      show(search);
      show(meta);
      setJourney(0);
      dotLabels[0].textContent = "제출 전 · 화면 2개";
      appwin.dataset.phase = "reply";
      await sleep(1200);

      // ④ 찍기 — 핀과 말풍선, 입력창의 같은 번호 칩
      show(pin);
      await sleep(500);
      show(bubble);
      show(chip);
      appwin.dataset.phase = "pin";
      await sleep(2300);

      // ⑤ 제출 — 버튼이 스스로 답한다, 여정 둘째 점
      submitBtn.textContent = "제출하는 중…";
      submitBtn.classList.add("busy");
      await sleep(1000);
      submitBtn.textContent = "제출됐어요";
      submitBtn.classList.remove("busy");
      submitBtn.classList.add("done");
      show(receipt);
      setJourney(1);
      dotLabels[1].textContent = "개발자가 보고 있어요";
      appwin.dataset.phase = "review";
      await sleep(2500);

      // ⑥ 반영됨 — 셋째 점, 다음에 만드는 것은 새 작업
      setJourney(2);
      dotLabels[2].textContent = "반영됐어요";
      show(merged);
      appwin.dataset.phase = "merged";
      await sleep(3000);
    }
  }

  if (reduced) staticScene();
  else void loop();
}

/* ---------- 흐름 — 네 걸음과 여정 큰 점 ---------- */
const steps = [...document.querySelectorAll("#flow .flow__step")];
const jDots = [$("jline-0"), $("jline-1"), $("jline-2")];
const jRails = [$("jline-rail0"), $("jline-rail1")];

function applyStep(index) {
  steps.forEach((li, i) => li.classList.toggle("on", i === index));
  const dot = Number(steps[index]?.dataset.dot ?? 0);
  jDots.forEach((d, i) => {
    d?.classList.toggle("on", i === dot);
    d?.classList.toggle("done", i < dot);
  });
  jRails.forEach((rail, i) => {
    if (rail) rail.style.width = i < dot ? "100%" : "0";
  });
}

if (steps.length > 0) {
  let stepIndex = 0;
  let timer = null;
  let userTouched = false;

  const advance = () => {
    stepIndex = (stepIndex + 1) % steps.length;
    applyStep(stepIndex);
  };
  const play = () => {
    if (reduced || userTouched || timer !== null) return;
    timer = setInterval(advance, 4200);
  };
  const pause = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  steps.forEach((li, i) => {
    li.addEventListener("click", () => {
      userTouched = true;
      pause();
      stepIndex = i;
      applyStep(i);
    });
  });

  const flow = $("flow");
  flow?.addEventListener("pointerenter", pause);
  flow?.addEventListener("pointerleave", play);

  applyStep(0);
  play();
}

/* ---------- 기능 벤토 ---------- */

// 찍기 놀이 — 커서를 따라오는 항아리 핀, 누르면 그 자리에 찍힌다.
const bpStage = $("bp-stage");
if (bpStage) {
  const ghost = $("bp-ghost");
  const bpPin = $("bp-pin");
  const bpBubble = $("bp-bubble");

  bpStage.addEventListener("pointermove", (e) => {
    const rect = bpStage.getBoundingClientRect();
    ghost.style.left = `${e.clientX - rect.left}px`;
    ghost.style.top = `${e.clientY - rect.top}px`;
  });
  bpStage.addEventListener("pointerleave", () => {
    ghost.style.opacity = "";
  });
  bpStage.addEventListener("pointerdown", (e) => {
    const rect = bpStage.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    bpPin.hidden = false;
    bpPin.style.left = `${x}px`;
    bpPin.style.top = `${y}px`;
    bpBubble.hidden = false;
    bpBubble.style.left = `${Math.min(x + 14, rect.width - 158)}px`;
    bpBubble.style.top = `${Math.min(y + 18, rect.height - 64)}px`;
    bpStage.classList.add("pinned");
  });
}

// 작업 기록 — 줄을 누르면 그 시점으로, 뒤의 변경은 사라진다.
const bhRows = [...document.querySelectorAll("#bh-list .bh-row")];
for (const [i, row] of bhRows.entries()) {
  row.addEventListener("click", () => {
    bhRows.forEach((other, k) => {
      other.classList.toggle("on", k === i);
      other.classList.toggle("undo", k > i);
    });
  });
}
bhRows[0]?.classList.add("on");

// 여러 프로젝트 — 줄을 누르면 가장 급한 것이 바뀐다.
const bjRows = [...document.querySelectorAll("#bj-rows .bj-row")];
const bjNote = $("bj-note");
for (const row of bjRows) {
  row.addEventListener("click", () => {
    for (const other of bjRows) other.classList.toggle("on", other === row);
    if (bjNote) bjNote.textContent = row.dataset.note ?? "";
  });
}

// 알림 시연 — OS 알림의 재현을 화면 구석에 띄운다.
const bnTry = $("bn-try");
const toast = $("site-toast");
const toastText = $("site-toast-text");
let toastTimer = null;
bnTry?.addEventListener("click", () => {
  if (!toast) return;
  toast.hidden = false;
  if (toastText) toastText.textContent = "다 만들었어요 — 대화를 확인해 보세요";
  // 다시 열릴 때 애니메이션이 살아나게 — display 토글로 재생된다.
  toast.style.animation = "none";
  void toast.offsetWidth;
  toast.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
});

/* ---------- 설치 체크리스트 — 들어오면 차례로 채운다 ---------- */
const checklist = $("install-checklist");
if (checklist) {
  const items = [...checklist.querySelectorAll("li")];
  const fillAll = () => {
    items.forEach((li, i) => {
      setTimeout(() => li.classList.add("ok"), reduced ? 0 : 550 * (i + 1));
    });
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
