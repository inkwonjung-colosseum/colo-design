/**
 * 기능 카드의 놀이 — 카드마다 그 기능이 실제로 하는 일을 손으로 해 보게 한다.
 *
 * 주문(끌어다 놓기) · 진짜 서비스(크기 · 검색) · 찍기(여러 곳 · 문장이 뜻을 정한다) ·
 * 제출(확인 한 장) · 작업 기록(시점 되돌리기) · 오류(도구가 먼저 열어 본다) ·
 * 여러 프로젝트 · 알림 · 테마 카드.
 *
 * 문구는 앱의 것을 그대로 쓴다(packages/web/src/next/labels.ts) — 첨부 한도 8MB 와
 * 그 거절 문장, 되돌리기 확인 문장, 영수증 줄이 그렇다. 파일을 끌어다 놓아도 이름과
 * 크기만 읽고 어디로도 보내지 않는다.
 *
 * prefers-reduced-motion 이면 시간으로 흐르는 장면(오류 카드)은 끝난 한 장으로 멈춘다.
 */

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 받침이 있는 낱말인가 — 조사(은/는)를 고르는 데 쓴다. */
const hasBatchim = (word) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0;
};
const eunNeun = (word) => `${word}${hasBatchim(word) ? "은" : "는"}`;

/** 숨은 쪽은 탭으로도 못 들어가게 — 겹쳐 놓은 두 장면 중 안 보이는 장면에 건다. */
const setInert = (el, on) => {
  if (el) el.inert = on;
};

/* ---------- 테마 카드 — 누르면 이 페이지 전체가 갈아입는다 ---------- */
const themeCards = [...document.querySelectorAll("[data-site-theme]")];

function syncThemeCards() {
  const choice = window.novaTheme?.choice;
  for (const card of themeCards) {
    card.setAttribute("aria-pressed", card.dataset.siteTheme === choice ? "true" : "false");
  }
}
for (const card of themeCards) {
  card.addEventListener("click", () => window.novaTheme?.set(card.dataset.siteTheme));
}
// 눌림 표시는 테마가 실제로 바뀔 때 따라온다 — 카드를 누르든, 시스템 따르기가 OS 를 따라가든.
addEventListener("nova-theme", syncThemeCards);
syncThemeCards();

/* ---------- 말 · 그림 · 문서 — 끌어다 놓으면 대화에 첨부된다 ---------- */
const boStage = $("bo-stage");
if (boStage) {
  // 앱의 첨부 한도와 같은 값 — 한 건 8MB.
  const MAX_BYTES = 8 * 1024 * 1024;
  const drop = $("bo-drop");
  const flow = boStage.querySelector(".bo-flow");
  const filesEl = $("bo-files");
  const aiText = $("bo-ai-text");
  const screenName = $("bo-screen-name");
  const reset = $("bo-reset");
  const sub = boStage.querySelector(".bo-drop__sub");
  const SUB_DEFAULT = sub.textContent;
  const SAMPLES = [
    { name: "주문 상세 기획서.pdf", size: 1_240_000, type: "application/pdf" },
    { name: "참고 시안.png", size: 480_000, type: "image/png" },
  ];

  let timers = [];
  let objectUrls = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));

  function setState(state) {
    boStage.dataset.state = state;
    setInert(drop, state !== "idle");
    setInert(flow, state === "idle");
    reset.hidden = state === "idle";
  }

  /** 첨부 칩 하나 — 그림이면 작은 미리보기, 아니면 문서 아이콘. */
  function fileChip(file) {
    const chip = document.createElement("span");
    chip.className = "bo-file";
    if (file.blob?.type.startsWith("image/")) {
      const img = document.createElement("img");
      const url = URL.createObjectURL(file.blob);
      objectUrls.push(url);
      img.src = url;
      img.alt = "";
      chip.append(img);
    } else {
      chip.insertAdjacentHTML(
        "beforeend",
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></svg>',
      );
    }
    const name = document.createElement("span");
    name.className = "bo-file__name";
    name.textContent = file.name;
    chip.append(name);
    return chip;
  }

  function clearRun() {
    for (const id of timers) clearTimeout(id);
    timers = [];
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
  }

  function attach(files) {
    const okFiles = files.filter((file) => file.size <= MAX_BYTES);
    const tooBig = files.find((file) => file.size > MAX_BYTES);
    if (tooBig) {
      // 앱과 같은 문장으로 거절한다.
      sub.textContent = `${tooBig.name} — 8MB 보다 큰 파일은 보낼 수 없어요`;
      sub.classList.add("bad");
      later(() => {
        sub.textContent = SUB_DEFAULT;
        sub.classList.remove("bad");
      }, 3400);
    }
    if (okFiles.length === 0) return;
    clearRun();
    const shown = okFiles.slice(0, 4);
    filesEl.replaceChildren(...shown.map(fileChip));
    // 일부만 너무 컸다면 대화에서도 그 사실을 말한다 — 조용히 빠지지 않게.
    aiText.textContent = `첨부한 ${okFiles.length}건을 읽고 새 화면을 지었어요.${
      tooBig ? " 8MB 를 넘는 파일은 뺐어요." : ""
    }`;
    screenName.textContent = "주문 상세";
    setState("dropped");
    later(() => setState("done"), reduced ? 0 : 1100);
  }

  const wrapNative = (files) =>
    files.map((file) => ({ name: file.name, size: file.size, blob: file }));
  const trySample = () => attach(SAMPLES.map((sample) => ({ ...sample, blob: null })));

  drop.addEventListener("click", trySample);
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      trySample();
    }
  });
  reset.addEventListener("click", () => {
    clearRun();
    filesEl.replaceChildren();
    sub.textContent = SUB_DEFAULT;
    sub.classList.remove("bad");
    setState("idle");
    drop.focus();
  });

  // 진짜 파일 끌어다 놓기 — 이름과 크기만 읽는다. 어디로도 보내지 않는다.
  let dragDepth = 0;
  boStage.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragDepth += 1;
    boStage.classList.add("dragover");
  });
  boStage.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  boStage.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) boStage.classList.remove("dragover");
  });
  boStage.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    boStage.classList.remove("dragover");
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) attach(wrapNative(files));
  });

  setState("idle");
}

/* ---------- 진짜 서비스 — 크기를 바꾸고, 검색해 본다 ---------- */
const brFrame = $("br-frame");
if (brFrame) {
  const sizeButtons = [...document.querySelectorAll(".br-size")];
  for (const button of sizeButtons) {
    button.addEventListener("click", () => {
      brFrame.dataset.size = button.dataset.size;
      for (const other of sizeButtons) {
        const on = other === button;
        other.classList.toggle("on", on);
        other.setAttribute("aria-pressed", on ? "true" : "false");
      }
    });
  }

  const input = $("br-input");
  const rows = [...$("br-list").children];
  const empty = $("br-empty");
  input.addEventListener("input", () => {
    const query = input.value.trim();
    let shown = 0;
    for (const row of rows) {
      const match = query === "" || row.firstElementChild.textContent.includes(query);
      row.hidden = !match;
      if (match) shown += 1;
    }
    empty.hidden = shown > 0;
  });
}

/* ---------- 찍기 — 여러 곳을 찍고, 문장 하나로 보낸다. 뜻은 문장이 정한다 ---------- */
const bpStage = $("bp-stage");
if (bpStage) {
  const ghost = $("bp-ghost");
  const bubble = $("bp-bubble");
  const chips = $("bp-chips");
  const send = $("bp-send");
  const reply = $("bp-reply");
  const intentButtons = [...document.querySelectorAll(".bp-say__btn")];
  const MAX_PINS = 4;
  const REPLY_IDLE = "화면을 찍고 문장을 골라 보내 보세요 — 뜻은 문장이 정해요.";
  // 짚은 것이 무엇인지 — "이게 뭐야?"의 답이 되는 한 줄.
  const DESC = {
    머리글: "맨 위의 제목 줄",
    "큰 그림": "첫머리의 큰 그림 영역",
    카드: "내용을 나눠 담는 카드 칸",
    "찍은 곳": "짚어 준 곳",
  };
  const KEY_SPOTS = [".bp-head", ".bp-hero", ".bp-cols i"];

  let intent = "fix";
  let pins = [];
  let keySpot = 0;
  let bubbleTimer = null;
  let sendTimer = null;

  const say = (text) => {
    reply.textContent = text;
    reply.classList.remove("fresh");
    void reply.offsetWidth;
    reply.classList.add("fresh");
  };

  function renderChips() {
    chips.replaceChildren();
    if (pins.length === 0) {
      const empty = document.createElement("span");
      empty.className = "bp-chips__empty";
      empty.textContent = "아직 찍은 곳이 없어요";
      chips.append(empty);
    }
    for (const pin of pins) {
      const chip = document.createElement("span");
      chip.className = "bp-chip";
      const num = document.createElement("b");
      num.textContent = String(pin.n);
      chip.append(num, pin.name);
      chips.append(chip);
    }
    send.disabled = pins.length === 0 || sendTimer !== null;
    bpStage.classList.toggle("pinned", pins.length > 0);
  }

  function renumber() {
    pins.forEach((pin, i) => {
      pin.n = i + 1;
      pin.el.textContent = String(pin.n);
      pin.el.setAttribute("aria-label", `${pin.n}번 핀 빼기`);
    });
  }

  function showBubble(pin, x, y) {
    const rect = bpStage.getBoundingClientRect();
    const title = document.createElement("b");
    title.textContent = `${pin.n} · ${pin.name}`;
    bubble.replaceChildren(title, "입력창에 담았어요 — 더 찍어도 돼요");
    bubble.hidden = false;
    bubble.style.left = `${Math.max(6, Math.min(x + 14, rect.width - 158))}px`;
    bubble.style.top = `${Math.max(6, Math.min(y + 18, rect.height - 64))}px`;
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubble.hidden = true;
    }, 2800);
  }

  function removePin(pin) {
    pin.el.remove();
    pins = pins.filter((other) => other !== pin);
    renumber();
    renderChips();
    if (pins.length === 0) bubble.hidden = true;
  }

  function place(x, y, name) {
    if (sendTimer !== null) return; // 보낸 뒤 답이 도는 동안은 찍지 않는다.
    if (pins.length >= MAX_PINS) {
      say("핀은 네 개까지 찍어 볼 수 있어요 — 핀을 누르면 뺄 수 있어요.");
      return;
    }
    const el = document.createElement("button");
    el.type = "button";
    el.className = "bp-pin";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const pin = { n: pins.length + 1, name, el };
    el.textContent = String(pin.n);
    el.setAttribute("aria-label", `${pin.n}번 핀 빼기`);
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      removePin(pin);
    });
    bpStage.append(el);
    pins.push(pin);
    showBubble(pin, x, y);
    renderChips();
  }

  const nameAt = (target) => target.closest?.("[data-pin-name]")?.dataset.pinName ?? "찍은 곳";

  bpStage.addEventListener("pointermove", (event) => {
    const rect = bpStage.getBoundingClientRect();
    ghost.style.left = `${event.clientX - rect.left}px`;
    ghost.style.top = `${event.clientY - rect.top}px`;
  });
  // pointerdown 이 아니라 click — 스크롤하려고 손을 댄 것이 핀이 되지 않게.
  bpStage.addEventListener("click", (event) => {
    if (event.target.closest(".bp-pin")) return;
    const rect = bpStage.getBoundingClientRect();
    place(event.clientX - rect.left, event.clientY - rect.top, nameAt(event.target));
  });
  // 키보드 — Enter 로 머리글 → 큰 그림 → 카드 순으로 다음 자리를 찍는다.
  bpStage.addEventListener("keydown", (event) => {
    if (event.target !== bpStage || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    const spot = bpStage.querySelector(KEY_SPOTS[keySpot % KEY_SPOTS.length]);
    keySpot += 1;
    if (!spot) return;
    const stage = bpStage.getBoundingClientRect();
    const rect = spot.getBoundingClientRect();
    place(
      rect.left - stage.left + rect.width / 2,
      rect.top - stage.top + rect.height / 2,
      nameAt(spot),
    );
  });

  for (const button of intentButtons) {
    button.addEventListener("click", () => {
      intent = button.dataset.intent;
      for (const other of intentButtons) {
        const on = other === button;
        other.classList.toggle("on", on);
        other.setAttribute("aria-pressed", on ? "true" : "false");
      }
    });
  }

  send.addEventListener("click", () => {
    if (pins.length === 0 || sendTimer !== null) return;
    const sent = pins.slice();
    // 보낸 핀은 답이 도는 동안 흐린 색으로 남았다가 답이 끝나면 사라진다.
    for (const pin of sent) pin.el.classList.add("sent");
    bubble.hidden = true;
    say(intent === "fix" ? "고치는 중이에요…" : "살펴보는 중이에요…");
    sendTimer = setTimeout(
      () => {
        sendTimer = null;
        for (const pin of sent) pin.el.remove();
        pins = [];
        renderChips();
        const names = [...new Set(sent.map((pin) => pin.name))];
        if (intent === "fix") {
          for (const name of names) {
            const block = bpStage.querySelector(`[data-pin-name="${name}"]`);
            if (!block) continue;
            block.classList.remove("bp-fixed");
            void block.offsetWidth;
            block.classList.add("bp-fixed");
          }
          say(
            `찍은 ${sent.length}곳(${names.join(" · ")})을 고쳤어요 — 미리보기에서 확인해 보세요.`,
          );
        } else {
          const parts = names.map((name) => `${eunNeun(name)} ${DESC[name] ?? DESC["찍은 곳"]}`);
          say(`고치지 않고 설명만 했어요 — ${parts.join("이고, ")}이에요.`);
        }
      },
      reduced ? 200 : 1100,
    );
    renderChips();
  });

  renderChips();
  reply.textContent = REPLY_IDLE;
}

/* ---------- 제출 — 확인 한 장에 한마디를 얹는다 ---------- */
const bsCard = $("bs-card");
if (bsCard) {
  const ask = bsCard.querySelector(".bs-ask");
  const done = bsCard.querySelector(".bs-done");
  const input = $("bs-input");
  const go = $("bs-go");
  const cancel = $("bs-cancel");
  const again = $("bs-again");
  const note = $("bs-done-note");
  let timer = null;

  function setState(state) {
    bsCard.dataset.state = state;
    setInert(ask, state === "done");
    setInert(done, state !== "done");
  }

  function submit() {
    if (bsCard.dataset.state !== "ask") return;
    setState("busy");
    go.textContent = "제출하는 중…";
    timer = setTimeout(
      () => {
        const text = input.value.trim();
        note.hidden = text === "";
        note.textContent = text === "" ? "" : `내 한마디 · “${text}”`;
        go.textContent = "제출됐어요";
        setState("done");
        again.focus({ preventScroll: true });
      },
      reduced ? 0 : 900,
    );
  }

  function reset() {
    clearTimeout(timer);
    go.textContent = "제출";
    input.value = "";
    setState("ask");
  }

  go.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  cancel.addEventListener("click", () => {
    input.value = "";
    input.focus();
  });
  again.addEventListener("click", () => {
    reset();
    input.focus({ preventScroll: true });
  });
  setState("ask");
}

/* ---------- 작업 기록 — 내가 한 말로 시점을 고른다. 되돌리기도 기록에 남는다 ---------- */
const bhList = $("bh-list");
if (bhList) {
  const rows = [...bhList.querySelectorAll(".bh-row[data-i]")];
  const confirmBox = $("bh-confirm");
  const confirmQ = $("bh-confirm-q");
  const foot = $("bh-foot");
  const FOOT_IDLE = foot.textContent;
  const MAX_REVERTS = 3;
  let selected = -1;

  const titleOf = (row) => row.querySelector("span").textContent;

  function clearSelection() {
    selected = -1;
    for (const row of rows) row.classList.remove("on", "undo");
    confirmBox.hidden = true;
  }

  function select(index) {
    selected = index;
    rows.forEach((row, i) => {
      row.classList.toggle("on", i === index);
      row.classList.toggle("undo", i > index);
    });
    // 앱과 같은 문장 — 시각이 아니라 내가 한 말로 묻는다.
    confirmQ.textContent = `${titleOf(rows[index])} 직후의 화면으로 되돌릴까요?`;
    confirmBox.hidden = false;
  }

  for (const [i, row] of rows.entries()) row.addEventListener("click", () => select(i));
  $("bh-cancel").addEventListener("click", clearSelection);
  $("bh-do").addEventListener("click", () => {
    if (selected < 0) return;
    const title = titleOf(rows[selected]);
    // 되돌리기도 새 기록으로 쌓인다 — 지워지는 것은 없다.
    const item = document.createElement("li");
    const entry = document.createElement("div");
    entry.className = "bh-row bh-row--revert";
    const text = document.createElement("span");
    text.textContent = `↺ ${title} 직후로 되돌렸어요`;
    const em = document.createElement("em");
    em.textContent = "작업 기록";
    entry.append(text, em);
    item.append(entry);
    bhList.append(item);
    const reverts = bhList.querySelectorAll(".bh-row--revert");
    if (reverts.length > MAX_REVERTS) reverts[0].closest("li").remove();
    confirmBox.hidden = true;
    foot.textContent = "되돌리기도 기록에 남았어요 — 개발자에게는 다음 제출 때 전해져요";
    for (const row of rows) row.classList.remove("on");
    selected = -1;
    setTimeout(() => {
      foot.textContent = FOOT_IDLE;
    }, 4200);
  });
}

/* ---------- 오류는 사람 몫이 아니에요 — 도구가 먼저 열어 보고, AI 가 고친다 ---------- */
const bgStage = $("bg-stage");
if (bgStage) {
  const replay = $("bg-replay");
  // 단계 사이의 간격(ms) — 열어 보고 → 빈 화면을 찾고 → 휴대폰으로도 열어 보고 → 끝.
  const GAPS = [600, 1100, 1700, 1300];
  let timers = [];

  function run() {
    for (const id of timers) clearTimeout(id);
    timers = [];
    bgStage.dataset.step = "0";
    replay.disabled = true;
    let at = 0;
    GAPS.forEach((gap, i) => {
      at += gap;
      timers.push(
        setTimeout(() => {
          bgStage.dataset.step = String(i + 1);
          if (i === GAPS.length - 1) replay.disabled = false;
        }, at),
      );
    });
  }

  if (reduced) {
    bgStage.dataset.step = "4";
    replay.hidden = true;
  } else {
    // 카드가 화면에 들어오면 한 번 저절로 돈다 — 그 전에는 처음 장면에서 기다린다.
    bgStage.dataset.step = "0";
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          run();
        }
      },
      { threshold: 0.6 },
    );
    observer.observe(bgStage);
    replay.addEventListener("click", run);
  }
}

/* ---------- 여러 프로젝트 — 줄을 누르면 가장 급한 것이 바뀐다 ---------- */
const bjRows = [...document.querySelectorAll("#bj-rows .bj-row")];
const bjNote = $("bj-note");
for (const row of bjRows) {
  row.addEventListener("click", () => {
    for (const other of bjRows) other.classList.toggle("bj-row--on", other === row);
    if (bjNote) bjNote.textContent = row.dataset.note ?? "";
  });
}

/* ---------- 알림 — OS 알림의 재현을 화면 구석에 띄운다 ---------- */
const bnTry = $("bn-try");
const toast = $("site-toast");
let toastTimer = null;
bnTry?.addEventListener("click", () => {
  if (!toast) return;
  toast.hidden = false;
  // 다시 열릴 때 애니메이션이 살아나게 — 리플로로 다시 재생한다.
  toast.style.animation = "none";
  void toast.offsetWidth;
  toast.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
});
