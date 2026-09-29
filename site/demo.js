/**
 * 소개 페이지의 큰 움직임 — 히어로 데모와 흐름, 스크롤 리빌 한 곳.
 *
 * 1. 히어로 목업 창 — 제품의 한 바퀴(말하기 → 만드는 중 → 찍기 → 제출 확인 → 반영됨)를
 *    창 안에서 직접 돌린다. 상태 줄의 여정 세 점은 앱의 라벨(labels.ts 의 journey)을
 *    그대로 쓴다 — 아는 만큼만 말한다: 제출 뒤에는 "개발자가 보고 있어요"가 아니라
 *    "개발자 확인을 기다려요"다.
 * 2. 흐름 — 네 걸음 카드가 차례로 밝아지고 여정 큰 점이 따라 옮아간다.
 * 3. 스크롤 리빌 — 섹션이 들어올 때 떠오르고, 카드는 차례로 올라온다.
 *
 * 테마는 theme.js(동기, <head>), 기능 카드의 놀이는 bento.js, 릴리스 · 복사 · 설치
 * 체크리스트는 page.js 가 맡는다.
 *
 * prefers-reduced-motion 이면 루프를 돌리지 않고 완성된 한 장으로 멈춘다.
 * JS 가 통하지 않으면 애초에 정적 장면이 보인다(스타일의 기본값).
 */

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const receiptNote = $("demo-receipt-note");
  const composer = appwin.querySelector(".mock-composer");
  const composerLine = composer?.querySelector(".mc-line");
  const composerCaret = $("demo-caret");
  const chip = $("demo-chip");
  const search = $("demo-search");
  const pin = $("demo-pin");
  const bubble = $("demo-bubble");
  const merged = $("demo-merged");
  const confirmSheet = $("demo-confirm");
  const confirmGo = $("demo-confirm-go");
  const note = $("demo-note");

  const USER_LINE = "회원 목록에 검색창을 넣어 줘";
  const AI_LINE = "검색창을 넣었습니다 — 미리보기에서 확인해 보세요.";
  const NOTE_LINE = "검색창 폭만 봐 주세요";
  const typed = document.createElement("span");
  composerLine?.insertBefore(typed, composerCaret);
  receiptNote.textContent = `내 한마디 · “${NOTE_LINE}”`;

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
    note.textContent = "";
    composer?.classList.remove("typing");
    submitBtn.textContent = "제출";
    submitBtn.className = "mst-submit";
    confirmGo.classList.remove("press");
    for (const el of [
      userMsg,
      aiMsg,
      screenCard,
      meta,
      receipt,
      chip,
      search,
      pin,
      bubble,
      merged,
      confirmSheet,
    ]) {
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

      // ⑤ 제출 — 확인 한 장이 서고, 한마디를 적고, 제출을 누른다
      submitBtn.classList.add("press");
      await sleep(260);
      submitBtn.classList.remove("press");
      show(confirmSheet);
      appwin.dataset.phase = "confirm";
      await sleep(800);
      await type(note, NOTE_LINE, 70);
      await sleep(650);
      confirmGo.classList.add("press");
      await sleep(240);
      show(confirmSheet, false);
      confirmGo.classList.remove("press");
      // 버튼이 스스로 답한다 — 제출하는 중… → 제출됐어요, 여정 둘째 점
      submitBtn.textContent = "제출하는 중…";
      submitBtn.classList.add("busy");
      await sleep(1000);
      submitBtn.textContent = "제출됐어요";
      submitBtn.classList.remove("busy");
      submitBtn.classList.add("done");
      show(receipt);
      setJourney(1);
      dotLabels[0].textContent = "제출됨";
      dotLabels[1].textContent = "개발자 확인을 기다려요";
      appwin.dataset.phase = "review";
      await sleep(2800);

      // ⑥ 반영됨 — 셋째 점, 다음에 만드는 것은 새 작업
      setJourney(2);
      dotLabels[1].textContent = "확인됨";
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
  for (const [i, li] of steps.entries()) li.classList.toggle("on", i === index);
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

/* ---------- 스크롤 리빌 ----------
   .js 를 먼저 달아 숨김 상태를 켜고, 들어온 요소에 .in 을 단다. 여기서 실패하면 .js 가
   달리지 않아 페이지는 그냥 다 보인다. IntersectionObserver 가 답하지 않는 환경(숨겨진
   탭 등)을 위해 스크롤 폴백을 둔다. */
document.documentElement.classList.add("js");

// 카드 묶음은 차례로 올라온다 — 자식마다 순번(--i)을 매긴다.
for (const list of document.querySelectorAll("[data-stagger]")) {
  for (const [i, el] of [...list.children].entries()) el.style.setProperty("--i", String(i));
}

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
