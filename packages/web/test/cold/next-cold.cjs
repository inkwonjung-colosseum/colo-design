// 콜드 리뷰의 과제를 실제 셸(packages/web/src/next)에서 다시 돈다 — PLAN-UI 단계 8.
//
//   node packages/web/test/cold/next-cold.cjs --url <smoke URL> [--first-url <SMOKE_EMPTY URL>]
//        [--tasks 1,2,4] [--real] [--state <smoke state dir>] [--first-state <dir>]
//        [--invite <첫 실행 초대 파일>] [--invite2 <다시 받기 초대 파일(프로젝트 둘)>]
//        [--latest-port 7895] [--shots /tmp/colo-smoke/shots]
//
// 과제: 1 처음 한 번 + 초대 · 2 첫 요청 · 3 찍기 · 4 제출 · 5 되돌리기 · 6 홈 ·
//       7 프로젝트 전환 · 준비 · 8 설정 · 모델 칩 · 9 좁은 창 · 10 AI 답 실패 · 도구가 한 일.
// 문장은 next/labels.ts 의 것을 그대로 찾는다(글자 · 역할 선택자). 걸음마다 스크린샷 한 장,
// 끝에 PASS / BLOCKED(이유) / SKIPPED(이유) 표를 찍는다.
//
// 브라우저 개발 경로에는 데스크톱 브리지가 없다 — 핀(오버레이의 ⌥+클릭)과 초대 파일 지우기는
// 데스크톱만 가진 면이라, 과제 1 · 3 은 가짜 `window.coloDesignDesktop`(아래 BRIDGE)을 심어
// 웹 쪽 절반(말풍선 · 칩 · 빼기 · 지우기 줄)을 본다. 오버레이 자체는 이 드라이버가 보지 못한다.
//
// --real 은 격리 데몬이 SMOKE_REAL_CLAUDE=1 로 떠 있을 때 — 과제 2 · 3 · 5 가 실제 답을 기다린다
// (턴 셋: 첫 요청 · 핀 보내기 · 과제 6 의 홈 보내기는 --real 에서 건너뛴다).
const { chromium } = require("/Users/developjik/.local/lib/node_modules/playwright");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

// ---------------------------------------------------------------- 인자
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const URL0 = opt("url");
const FIRST_URL = opt("first-url");
const REAL = has("real");
const STATE = opt("state");
const FIRST_STATE = opt("first-state");
const INVITE = opt("invite", "/tmp/colo-smoke/invite.colo-invite");
const INVITE2 = opt("invite2", "/tmp/colo-smoke/invite2.colo-invite");
const LATEST_PORT = Number(opt("latest-port", "0"));
const SHOTS = opt("shots", process.env.SHOT_DIR || "/tmp/colo-smoke/shots");
const TASKS = opt("tasks", "1,2,3,4,5,6,7,8,9,10")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter(Boolean);
if (!URL0) {
  console.error("사용: node next-cold.cjs --url <smoke URL> [--first-url …] [--tasks 1,2]");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- 문장 (next/labels.ts)
const T = {
  obTitle: "Colo Design 을 시작해요",
  toolsReady: "필요한 도구 확인됨",
  agentOk: "Claude Code · 로그인됨",
  invitePick: "파일 고르기",
  inviteLineTitle: "초대 파일을 가져왔어요",
  inviteRemove: "파일 지우기",
  inviteRemoved: "초대 파일을 지웠어요",
  later: "나중에",
  newConv: "새 대화",
  home: "홈",
  settings: "설정",
  composerPh: "만들거나 고치고 싶은 것을 말해 주세요",
  homePh: "만들고 싶은 화면을 말해 주세요",
  sendFailed: "AI에게 말을 전하지 못했어요",
  failTitle: "AI가 답을 못 했어요",
  retrying: "조금씩 기다리며 다시 묻는 중",
  retry: "다시 시도",
  editResend: "고쳐서 다시 보내기",
  editResendToast: "이 말 앞까지 이어받은 새 대화예요",
  shotLabel: "고친 화면",
  shotGo: "미리보기에서 보기",
  making: "만드는 중",
  pin: "찍기",
  pinStrip: "찍기 켜짐",
  bubble: "핀 메모",
  removePin: "이 핀 빼기",
  pinRemoved: "핀을 뺐어요",
  kept: (n) => `${n}번을 담았어요`,
  submit: "제출",
  submitTitle: "개발자에게 제출할까요?",
  submitTitleMore: "같은 요청에 더해 제출할까요?",
  note: "개발자에게 한마디",
  cancel: "그만두기",
  submitting: "제출하는 중…",
  resubmitting: "다시 제출하는 중…",
  submitFailed: "제출하지 못했어요",
  whyNothing: "아직 바뀐 화면이 없어요", // L.submit.whyNothing — 잠긴 제출의 이유(만든 것이 없을 때)
  historyEmpty: "아직 보관된 차례가 없어요", // L.history.empty — 서랍의 빈 상태 문장
  notified: "개발자에게 알렸어요",
  work: "이번 작업",
  history: "작업 기록",
  revertAsk: "직후의 화면으로 되돌릴까요?",
  revertKeep: "기록은 지워지지 않고",
  revert: "되돌리기",
  fork: "여기서 새 대화",
  settleMenu: "여기서 새 대화 · 되돌리기",
  forkRevertLink: "작업 기록에서 되돌리기",
  greet: (name) => `${name}님, 무엇을 만들까요?`,
  waiting: "답을 기다려요",
  calm: "기다리는 일이 없어요",
  running: "지금 진행 중",
  recent: "방금 있던 일",
  others: "다른 프로젝트",
  prepareFirst: "처음 열 때 준비해요",
  prepTitle: "이 서비스를 이 컴퓨터에서 처음 켜요",
  prepSteps: ["내려받기", "설치하기", "미리보기 켜기"],
  queued: "준비가 끝나면 바로 보낼게요",
  switched: "옮겼어요 · ",
  pinLocked: "준비가 끝나면 화면을 찍을 수 있어요",
  inviteApply: "가져오기",
  rowNew: "새로",
  rowKeep: "그대로",
  openInvite: "초대 파일 열기",
  sAi: "AI",
  sNotify: "알림",
  sConn: "연결",
  sUpdate: "업데이트",
  sDev: "개발자용",
  authorName: "작업에 적을 이름",
  connOk: "연결 정상",
  checkNow: "지금 확인",
  updateRun: "업데이트",
  latest: "최신이에요",
  updatedAt: "에 업데이트했어요",
  thinkShort: "짧게",
  thinkLong: "길게",
  fast: "빠르게",
  chatTab: "대화",
  screenTab: "화면 · ",
  toolWork: "도구가 한 일",
};

/** U10 금칙어 — 개발자용 폴드 밖의 사용자 면에 서면 안 되는 말. */
const FORBIDDEN = [
  ["턴", /(^|[^가-힣])턴([^가-힣]|$)/],
  ["경로", /경로/],
  ["git", /\bgit\b/i],
  ["데몬", /데몬/],
  ["커밋", /커밋/],
  ["브랜치", /브랜치/],
  ["PR", /\bPR\b/],
  // 0.3 의 어휘 충돌 — 제출 실패와 AI 실패가 같은 말을 쓰던 자리.
  ["보내지 못했어요", /보내지 못했어요/],
];

// ---------------------------------------------------------------- 가짜 데스크톱 브리지
function bridgeScript({ native, invitePath }) {
  return `(() => {
  const subs = {};
  const on = (k) => (cb) => { (subs[k] ||= []).push(cb); return () => { subs[k] = (subs[k] || []).filter((f) => f !== cb); }; };
  const emit = (k, p) => (subs[k] || []).forEach((f) => { try { f(p); } catch (e) { console.error('cold bridge', e); } });
  const rec = (k, p) => { try { window.__coldRecord && window.__coldRecord(k, JSON.stringify(p === undefined ? null : p)); } catch {} };
  let base = null, at = 0; const hist = ['/'];
  const cur = () => hist[at];
  const frame = () => { const w = document.querySelector('webview'); return w && w.querySelector('iframe'); };
  const loc = () => emit('location', { path: cur(), url: base ? base.replace(/\\/$/, '') + cur() : undefined, kind: 'preview', canGoBack: at > 0, canGoForward: at < hist.length - 1 });
  const show = () => { const f = frame(); if (f && base) f.src = base.replace(/\\/$/, '') + cur(); setTimeout(loc, 80); };
  const go = (p) => { hist.splice(at + 1); hist.push(p || '/'); at = hist.length - 1; show(); };
  window.__cold = { emit, go, subs, loc };
  const preview = {
    native: ${native ? "true" : "false"},
    hostReady: async () => {},
    mount: async (url) => { base = url; rec('mount', url); setTimeout(show, 300); },
    open: async (p) => { rec('open', p); go(p); },
    navigate: async (p) => { rec('navigate', p); go(p); },
    history: async (d) => { at = Math.max(0, Math.min(hist.length - 1, at + d)); show(); },
    reload: async () => { rec('reload'); show(); },
    commentsMode: async (onOff) => rec('commentsMode', onOff),
    emulate: async (w) => rec('emulate', w),
    pins: async (s) => { window.__coldSync = s; rec('pins', s); },
    zoom: async (k) => rec('zoom', k),
    snapshot: async () => ({ jpeg: null }),
    pinFlash: async (id) => rec('pinFlash', id),
    onLocation: on('location'), onPin: on('pin'), onPinFocus: on('pinFocus'), onError: on('error'),
    onZoom: on('zoom'), onClose: on('close'), onKey: on('key'), onLoading: on('loading'), onHost: on('host'),
  };
  window.coloDesignDesktop = {
    preview,
    invite: {
      pathOf: () => ${JSON.stringify(invitePath || null)},
      discard: async (p) => { rec('discard', p); if (window.__coldDiscard) await window.__coldDiscard(p); },
    },
  };
  // <webview> 는 크롬에 없는 요소다 — 게스트 자리에 iframe 을 하나 넣어 화면이 보이게 한다.
  new MutationObserver(() => {
    document.querySelectorAll('webview:not([data-cold])').forEach((w) => {
      w.setAttribute('data-cold', '1');
      w.executeJavaScript = () => Promise.reject(new Error('cold shim'));
      w.reload = () => {};
      w.style.display = 'flex';
      const f = document.createElement('iframe');
      f.style.cssText = 'flex:1;border:0;width:100%;height:100%;background:#fff';
      w.appendChild(f);
      setTimeout(show, 50);
    });
  }).observe(document, { childList: true, subtree: true });
})();`;
}

/** 브라우저 경로의 알림 — Notification 생성자를 기록기로 바꾼다(권한은 컨텍스트가 준다). */
const NOTIFY_HOOK = `(() => {
  window.__coldNotes = [];
  const N = function (title, o) { window.__coldNotes.push({ title, body: o && o.body, at: Date.now() }); };
  N.permission = 'granted';
  N.requestPermission = async () => 'granted';
  window.Notification = N;
  try {
    localStorage.setItem('colo-design.notification-asked', '1');
    // 기본(오래 걸린 답만)은 짧은 실패를 조용히 둔다 — 보는/떠난 대화의 규칙만 보려고 「모든 답」으로.
    const s = JSON.parse(localStorage.getItem('colo-design.settings') || '{}') || {};
    s.notifications = { ...(s.notifications || {}), done: 'all', sound: false };
    localStorage.setItem('colo-design.settings', JSON.stringify(s));
  } catch {}
})();`;

// ---------------------------------------------------------------- 기록
const rows = [];
const pageErrors = [];
const vocabHits = [];
class Blocked extends Error {}
class Skipped extends Error {}
const block = (why) => {
  throw new Blocked(why);
};
const skip = (why) => {
  throw new Skipped(why);
};
const check = (cond, why) => {
  if (!cond) block(why);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
let shotN = 0;

async function openPage(url, { width = 1440, height = 900, bridge = null, notify = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "ko-KR" });
  const page = await context.newPage();
  const record = [];
  await page.exposeBinding("__coldRecord", (_src, kind, payload) => {
    record.push({ kind, payload: JSON.parse(payload), at: Date.now() });
  });
  await page.exposeBinding("__coldDiscard", (_src, p) => {
    try {
      fs.unlinkSync(p);
    } catch {}
  });
  if (bridge) await page.addInitScript(bridgeScript(bridge));
  if (notify) await page.addInitScript(NOTIFY_HOOK);
  page.on("pageerror", (e) => pageErrors.push(`${page.__task ?? "?"} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`${page.__task ?? "?"} console: ${m.text().slice(0, 240)}`);
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  page.__record = record;
  return page;
}

async function bodyText(page) {
  return (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
}

/** 보이는 글자에서 금칙어를 센다. 개발자용 폴드가 열려 있으면 그 안은 뺀다. */
async function scanVocab(page, where) {
  // 살아 있는 innerText — 숨은 것(닫힌 폴드 · 화면 밖 서랍)은 읽지 않는다. 열린 개발자용 폴드의 글은 뺀다.
  const text = await page.evaluate(() => {
    let all = document.body.innerText;
    for (const el of document.querySelectorAll("details[open]")) {
      if (!el.innerText.includes("문제 해결 도구")) continue;
      for (const line of el.innerText.split("\n")) if (line.trim()) all = all.split(line).join("");
    }
    return all;
  });
  for (const [word, re] of FORBIDDEN) {
    const m = text.match(re);
    if (m) {
      const i = text.search(re);
      vocabHits.push({ where, word, around: text.slice(Math.max(0, i - 30), i + 30).replace(/\s+/g, " ") });
    }
  }
}

async function shot(page, task, name) {
  shotN += 1;
  const file = `t${task}-${String(shotN).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: path.join(SHOTS, file) }).catch(() => {});
  await scanVocab(page, `${task}:${name}`).catch(() => {});
  return file;
}

async function step(task, name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    rows.push({ task, name, status: "PASS", note: note || "", ms: Date.now() - started });
  } catch (e) {
    const status = e instanceof Skipped ? "SKIPPED" : "BLOCKED";
    const why = e instanceof Blocked || e instanceof Skipped ? e.message : `오류: ${e.message.split("\n")[0]}`;
    rows.push({ task, name, status, note: why, ms: Date.now() - started });
  }
}

const visible = (page, text, opts = {}) =>
  page
    .getByText(text, { exact: false, ...opts })
    .first()
    .isVisible()
    .catch(() => false);
const waitText = (page, text, timeout = 10_000) =>
  page
    .getByText(text, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout })
    .then(
      () => true,
      () => false,
    );
/** 여러 문장 중 먼저 보이는 것. */
async function waitAny(page, texts, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const t of texts) if (await visible(page, t)) return t;
    await sleep(250);
  }
  return null;
}
const btn = (page, name, exact = true) => page.getByRole("button", { name, exact }).first();
async function workReady(page) {
  // 연결 뒤 셸이 서기까지 — 사이드바의 `새 대화` 단추가 신호다.
  await btn(page, /새 대화/, false).waitFor({ state: "visible", timeout: 20_000 });
}
async function openNewConv(page) {
  await btn(page, /새 대화/, false).click();
  await page.getByPlaceholder(T.composerPh).first().waitFor({ state: "visible", timeout: 10_000 });
}
async function composerSend(page, text) {
  const box = page.getByPlaceholder(/말해 주세요/).locator("visible=true").first();
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}
/** 사이드바 대화 목록의 첫 대화(사람의 대화)를 연다. */
async function openFirstConv(page) {
  const row = page.locator(".nx-conv-list button.nx-conv").first();
  if (await row.isVisible().catch(() => false)) {
    await row.click();
    return true;
  }
  return false;
}
function appendUserPairs(state, n) {
  if (!state) return;
  const file = path.join(state, "gh", "fixtures.json");
  const pairs = JSON.parse(fs.readFileSync(file, "utf8"));
  for (let i = 0; i < n; i++)
    pairs.push({
      name: `me-${Date.now()}-${i}`,
      cite: "GET /user",
      request: { method: "GET", url: "/user" },
      response: { status: 200, json: { login: "fixture" } },
    });
  fs.writeFileSync(file, JSON.stringify(pairs));
}
const toastText = (page) =>
  page
    .locator(".nx-toast")
    .first()
    .innerText()
    .catch(() => "");

// ================================================================= 과제
const TASK = {};

// 1 — 처음 한 번 · 초대 파일 · 파일 지우기(U11)
TASK[1] = async () => {
  if (!FIRST_URL) {
    await step(1, "처음 한 번", () => skip("--first-url 없음 (SMOKE_EMPTY=1 데몬)"));
    return;
  }
  const copy = path.join(path.dirname(INVITE), "invite-copy.colo-invite");
  fs.copyFileSync(INVITE, copy);
  appendUserPairs(FIRST_STATE, 4);
  const page = await openPage(FIRST_URL, { bridge: { native: false, invitePath: copy } });
  page.__task = 1;
  await step(1, "체크리스트 한 장 — 도구 · AI · 초대 파일", async () => {
    check(await waitText(page, T.obTitle, 15_000), "체크리스트가 서지 않음");
    const ok = await waitAny(page, [T.agentOk], 15_000);
    await shot(page, 1, "checklist");
    check(await visible(page, T.toolsReady), "도구 준비가 채워지지 않음");
    check(ok, "AI 연결이 채워지지 않음");
    check(!(await visible(page, "시작하기", { exact: true })), "`시작하기` 버튼이 있음");
    return "세 항목, 스스로 채워짐 · 시작하기 없음";
  });
  await step(1, "초대 파일 고르기 → 작업 화면", async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 5_000 }),
      btn(page, T.invitePick).click(),
    ]);
    await chooser.setFiles(copy);
    await workReady(page);
    await sleep(1500);
    await shot(page, 1, "after-invite");
    check(!(await visible(page, T.inviteApply, { exact: true })), "첫 가져오기인데 확인판이 섰음");
    const greeted = await visible(page, T.greet("김기획"));
    check(greeted, "홈 인사에 초대장의 이름(김기획)이 없음");
    return "확인판 없이 곧바로 적용 · 「김기획님, 무엇을 만들까요?」";
  });
  let landing = "";
  await step(1, "첫 화면에 `초대 파일을 가져왔어요` 줄", async () => {
    landing = (await page.getByPlaceholder(T.homePh).first().isVisible().catch(() => false)) ? "홈" : "대화";
    const onLanding = await visible(page, T.inviteLineTitle);
    if (!onLanding) {
      await openNewConv(page);
      await sleep(800);
    }
    const inConv = await visible(page, T.inviteLineTitle);
    await shot(page, 1, "invite-line");
    check(onLanding, `첫 화면(${landing})에는 줄이 없음${inConv ? " — 새 대화를 열어야 보임" : " — 새 대화에도 없음"}`);
    return `첫 화면 = ${landing}`;
  });
  await step(1, "`파일 지우기` → 파일이 사라짐", async () => {
    if (!(await visible(page, T.inviteLineTitle))) await openNewConv(page).catch(() => {});
    check(await visible(page, T.inviteRemove, { exact: true }), "지우기 버튼 없음");
    await btn(page, T.inviteRemove).click();
    const toasted = await waitText(page, T.inviteRemoved, 4_000);
    await shot(page, 1, "invite-removed");
    check(toasted, "토스트 없음");
    check(!fs.existsSync(copy), "파일이 남아 있음");
    check(!(await visible(page, T.inviteLineTitle)), "줄이 남아 있음");
    return "discard 기록 · 파일 삭제 · 줄 사라짐";
  });
  await page.context().close();
};

// 2 — 첫 요청 · 고친 화면 카드 · 고쳐서 다시 보내기 · 알림(브라우저 경로)
const PROMPT = "홈 화면에 '회원 목록' 링크를 넣어 줘";
TASK[2] = async () => {
  const page = await openPage(URL0, { notify: true });
  page.__task = 2;
  await workReady(page);
  await step(2, "새 대화 — 빈 대화의 안내", async () => {
    await openNewConv(page);
    await sleep(1500);
    await shot(page, 2, "empty");
    check(await visible(page, "무엇을 만들까요?"), "빈 대화 제목 없음");
    return "";
  });
  await step(2, "말을 보냄 → 답 또는 실패의 문장", async () => {
    await composerSend(page, PROMPT);
    await sleep(1200);
    await shot(page, 2, "sent");
    if (REAL) {
      const making = await visible(page, T.making);
      const done = await waitAny(page, [T.shotLabel, T.failTitle, T.sendFailed], 240_000);
      await sleep(3000);
      await shot(page, 2, "answered");
      check(done === T.shotLabel, `고친 화면 카드가 서지 않음 (${done ?? "시간 초과"})`);
      return `만드는 중 표식 ${making ? "있음" : "못 봄"} · 고친 화면 카드`;
    }
    const got = await waitAny(page, [T.sendFailed, T.failTitle, T.retrying], 45_000);
    await shot(page, 2, "stub-failed");
    check(got, "45초 안에 실패도 재시도도 말하지 않음");
    return `가짜 claude: 「${got}」`;
  });
  if (REAL) {
    await step(2, "`미리보기에서 보기` → 미리보기가 그 화면", async () => {
      await btn(page, T.shotGo, false).click();
      await sleep(2000);
      await shot(page, 2, "shot-go");
      const addr = await page
        .locator(".nx-addr, [aria-label='화면 고르기']")
        .first()
        .innerText()
        .catch(() => "");
      return `주소창: ${addr.replace(/\s+/g, " ").trim()}`;
    });
  }
  await step(2, "보낸 말 → `고쳐서 다시 보내기`", async () => {
    const bubble = page.locator(".nx-m-user, .nx-user").filter({ hasText: PROMPT }).first();
    if (!REAL && !(await bubble.isVisible().catch(() => false)))
      skip("가짜 claude — 보낸 말이 대화록에 서지 않고 입력창으로 돌아온다");
    await bubble.hover().catch(() => {});
    await sleep(400);
    const shown = await btn(page, new RegExp(T.editResend), false).isVisible().catch(() => false);
    await shot(page, 2, "hover-edit");
    check(shown, "hover 에 버튼이 없음");
    await btn(page, new RegExp(T.editResend), false).click();
    const toasted = await waitText(page, T.editResendToast, 5_000);
    await sleep(600);
    const filled = await page
      .getByPlaceholder(/말해 주세요/)
      .locator("visible=true")
      .first()
      .inputValue()
      .catch(() => "");
    await shot(page, 2, "edit-resend");
    check(filled.includes("회원 목록"), `입력창이 채워지지 않음(${filled || "빈칸"})`);
    return toasted ? "새 대화 · 입력창 채움 · 토스트" : "입력창 채움 · 토스트 못 봄";
  });
  await step(2, "알림(모든 답) — 보는 대화는 조용, 떠난 대화는 부름(브라우저 경로)", async () => {
    if (REAL) skip("--real 에서는 턴을 아낀다");
    const before = await page.evaluate(() => window.__coldNotes.length);
    // 보는 채로 실패 → 조용해야 한다.
    await composerSend(page, "알림 확인 하나");
    await waitAny(page, [T.sendFailed, T.failTitle], 30_000);
    await sleep(1000);
    const watching = (await page.evaluate(() => window.__coldNotes.length)) - before;
    if (!(await page.locator(".nx-m-user, .nx-user").count()))
      skip("가짜 claude — 턴이 running 에 들지 않아 알림 전환이 생기지 않는다");
    // 보낸 뒤 다른 대화로 떠나면 → 불러야 한다(홈은 떠남이 아니다 — 보던 대화가 그대로 `보는 대화`다).
    await openNewConv(page);
    await composerSend(page, "알림 확인 둘");
    await sleep(300);
    await openNewConv(page);
    await sleep(15_000);
    const notes = await page.evaluate(() => window.__coldNotes);
    const away = notes.length - before - watching;
    await shot(page, 2, "notify");
    check(watching === 0, `보는 대화에서 알림 ${watching}개`);
    if (away === 0)
      skip("보는 대화는 조용함(확인) · 떠난 대화는 확인 불가 — 실패한 턴이 0.1초 만에 끝나 떠날 틈이 없다");
    return `떠난 대화: 「${notes[notes.length - 1].title}」 ${notes[notes.length - 1].body}`;
  });
  await page.context().close();
};

// 3 — 찍기 · 말풍선 · 핀 빼기(U4) — 가짜 브리지
function fakePin(n, screen = "index") {
  return {
    type: "colo-design.pin",
    pin: {
      id: `cold-${Date.now()}-${n}`,
      screen,
      element: {
        component: n === 1 ? "h1" : "p",
        text: n === 1 ? "홈" : "fixture 앱",
        path: n === 1 ? "body > h1" : "body > p",
        rect: n === 1 ? { x: 8, y: 21, width: 600, height: 37 } : { x: 8, y: 75, width: 600, height: 20 },
        kind: "element",
        html: n === 1 ? "<h1>홈</h1>" : "<p>fixture 앱</p>",
        a11y: n === 1 ? { role: "heading", name: "홈" } : {},
      },
    },
  };
}
TASK[3] = async () => {
  const page = await openPage(URL0, { bridge: { native: true } });
  page.__task = 3;
  await workReady(page);
  await openNewConv(page);
  await sleep(2500);
  const stage = () => page.locator(".nx-pvdevice").first().boundingBox();
  await step(3, "`찍기` → 떠 있는 알약, 화면을 밀지 않음", async () => {
    const before = await stage();
    await page.getByRole("button", { name: T.pin, exact: true }).last().click();
    await sleep(600);
    const after = await stage();
    await shot(page, 3, "pin-on");
    check(await visible(page, T.pinStrip), "`찍기 켜짐` 이 없음");
    check(before && after && Math.abs(before.y - after.y) < 1 && Math.abs(before.height - after.height) < 1,
      `무대가 움직임 (${before?.y},${before?.height} → ${after?.y},${after?.height})`);
    const mode = page.__record.filter((r) => r.kind === "commentsMode").pop();
    return `무대 그대로 · commentsMode=${mode?.payload}`;
  });
  await step(3, "핀 1 → 말풍선 → 메모 → ↵ 담기", async () => {
    await page.evaluate((env) => window.__cold.emit("pin", env), fakePin(1));
    const dialog = page.getByRole("dialog", { name: T.bubble });
    await dialog.waitFor({ state: "visible", timeout: 4_000 }).catch(() => block("말풍선이 뜨지 않음"));
    await sleep(600); // 들어오는 움직임이 끝난 뒤 — 도중에 누르면 Playwright 의 scrollIntoView 가 칸을 민다
    const head = (await dialog.innerText()).replace(/\s+/g, " ");
    await shot(page, 3, "bubble-1");
    const input = dialog.getByRole("textbox").first();
    await input.fill("제목을 더 크게");
    await input.press("Enter");
    const kept = await waitText(page, T.kept(1), 3_000);
    await sleep(300);
    await shot(page, 3, "kept-1");
    const chip = await page.locator(".nx-composer, .nx-cmp").first().innerText().catch(() => "");
    check(kept, "담았다는 토스트 없음");
    const values = await page.evaluate(() => [...document.querySelectorAll("input, textarea")].map((e) => e.value));
    check(chip.includes("제목을 더 크게") || values.includes("제목을 더 크게"),
      "입력창 칩에 메모가 비치지 않음");
    return `말풍선: ${head.slice(0, 60)}`;
  });
  await step(3, "핀 2 → 말풍선의 휴지통 → 빠짐", async () => {
    await page.evaluate((env) => window.__cold.emit("pin", env), fakePin(2));
    const dialog = page.getByRole("dialog", { name: T.bubble });
    await dialog.waitFor({ state: "visible", timeout: 4_000 }).catch(() => block("말풍선이 뜨지 않음"));
    await sleep(600); // 들어오는 움직임이 끝난 뒤 — 도중에 누르면 Playwright 의 scrollIntoView 가 칸을 민다
    await shot(page, 3, "bubble-2");
    await dialog.getByRole("button", { name: T.removePin }).click();
    const removed = await waitText(page, T.pinRemoved, 3_000);
    await sleep(400);
    await shot(page, 3, "removed-2");
    const sync = await page.evaluate(() => window.__coldSync);
    check(removed, "`핀을 뺐어요` 토스트 없음");
    check(sync && sync.pins.length === 1, `배지 목록이 ${sync?.pins.length}개`);
    return `배지 목록 1개 · n=${sync.pins[0].n ?? "-"} · tone=${sync.pins[0].tone ?? "-"}`;
  });
  await step(3, "보내기 → 보낸 핀은 회색, 턴이 끝나면 사라짐", async () => {
    await composerSend(page, "이 부분 고쳐 줘");
    await sleep(700);
    const during = await page.evaluate(() => window.__coldSync);
    await shot(page, 3, "pins-sent");
    const sentTone = during?.pins.some((p) => p.tone === "sent" || p.sent);
    const end = REAL ? [T.shotLabel, T.failTitle, T.sendFailed] : [T.sendFailed, T.failTitle];
    const got = await waitAny(page, end, REAL ? 240_000 : 45_000);
    await sleep(2500);
    const after = await page.evaluate(() => window.__coldSync);
    await shot(page, 3, "pins-after");
    if (!REAL && (await visible(page, T.sendFailed))) {
      // 가짜 claude 는 말이 닿기 전에 죽는다 — 보내기가 실패하면 핀은 입력창에 그대로 남아야 한다.
      check(after && after.pins.length === 1, `보내기 실패 뒤 핀이 ${after?.pins.length}개(1개가 남아야 함)`);
      skip("가짜 claude — 보내기가 실패해 핀은 입력창에 그대로 남음(회색 → 사라짐은 --real 에서)");
    }
    check(sentTone, "보낸 순간 배지가 회색(sent)이 아님");
    check(after && after.pins.length === 0, `끝난 뒤에도 배지 ${after?.pins.length}개`);
    return `끝: ${got ?? "시간 초과"}`;
  });
  await page.context().close();
};

// 4 — 제출 확인 한 장 · 실패의 흔적(U3 · U13)
TASK[4] = async () => {
  const page = await openPage(URL0);
  page.__task = 4;
  await workReady(page);
  await openNewConv(page);
  await sleep(2000);
  let enabled = false;
  await step(4, "`제출` → 확인 한 장", async () => {
    // 잠긴 단추는 aria-disabled 라 playwright 의 기본 클릭이 기다리지 못한다 —
    // 강제로 눌러 앱의 onClick(이유 한 줄)을 지나게 한다.
    await page.locator(".nx-submit").first().click({ force: true });
    await sleep(700);
    await shot(page, 4, "confirm");
    const open = await waitAny(page, [T.submitTitle, T.submitTitleMore], 2_000);
    if (!open) {
      const why = (await page.locator(".nx-why").first().innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();
      // D1 뒤 픽스처에는 제출할 것이 없다(그것이 D1 의 성적) — 잠긴 단추를 누르면
      // 이유가 한 줄로 서는 것이 이 걸음의 옳은 모습이다(labels 의 whyNothing).
      if (!REAL && why) {
        check(
          why.includes(T.whyNothing),
          `잠김 이유가 「${T.whyNothing}」가 아님: ${why}`,
        );
        return `잠김 — 「${why}」`;
      }
      block(`잠김 — ${why || "이유 한 줄 없음"}`);
    }
    enabled = true;
    const pop = (await page.getByRole("dialog").last().innerText()).replace(/\s+/g, " ");
    check(await visible(page, T.note), "`개발자에게 한마디` 없음");
    check(await visible(page, T.cancel, { exact: true }), "`그만두기` 없음");
    return pop.slice(0, 120);
  });
  await step(4, "한마디 + Enter → 제출하는 중 → 실패의 흔적", async () => {
    if (!enabled) skip(REAL ? "확인 창이 열리지 않음" : "제출할 것이 없음");
    const note = page.getByRole("textbox", { name: T.note });
    await note.fill("검색창 위치는 기획 의도예요");
    await note.press("Enter");
    const seen = [];
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      const label = (await page.locator(".nx-submit").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (label && seen[seen.length - 1] !== label) {
        seen.push(label);
        await shot(page, 4, `button-${seen.length}`);
      }
      if (await visible(page, T.beforeBlocked)) break;
      if (label === "제출됐어요") break;
      await sleep(400);
    }
    await sleep(800);
    await shot(page, 4, "after-submit");
    const problem = await page.locator(".nx-problem").first().innerText().catch(() => "");
    check(seen.some((s) => s.includes(T.submitting) || s.includes(T.resubmitting)), `버튼이 스스로 답하지 않음 (${seen.join(" → ")})`);
    return `버튼: ${seen.join(" → ")} · 여정 막힘 ${(await visible(page, T.beforeBlocked)) ? "있음" : "없음"} · 문제 문장: ${problem.replace(/\s+/g, " ").slice(0, 60) || "없음"}`;
  });
  await step(4, "`이번 작업` — 제출 기록", async () => {
    await page.locator(".nx-journey").first().click();
    await sleep(800);
    await shot(page, 4, "work");
    const pop = (await page.getByRole("dialog").last().innerText().catch(() => "")).replace(/\s+/g, " ");
    check(pop.includes(T.work), "팝오버가 열리지 않음");
    await page.keyboard.press("Escape");
    return pop.slice(0, 160);
  });
  await step(4, "개발자 코멘트 도착 → 카드 → 반영", () =>
    skip("GitHub 왕복(요청 · 리뷰)은 오프라인 픽스처에 짝이 없다"),
  );
  await page.context().close();
};

// 5 — 작업 기록 · 되돌리기 문구(U9) · 여기서 새 대화
TASK[5] = async () => {
  const page = await openPage(URL0);
  page.__task = 5;
  await workReady(page);
  if (!(await openFirstConv(page))) await openNewConv(page);
  await sleep(2500);
  let count = 0;
  await step(5, "`작업 기록` 서랍", async () => {
    await btn(page, T.history).click();
    await page.getByRole("complementary", { name: T.history }).or(page.locator(".nx-hist")).first()
      .waitFor({ state: "visible", timeout: 4_000 }).catch(() => {});
    await sleep(1500);
    await shot(page, 5, "drawer");
    count = await page.locator(".nx-hitem").count();
    // D1 뒤 픽스처의 기록은 비어 있다(그것이 D1 의 성적) — 서랍이 빈 상태 문장
    // (labels 의 history.empty)으로 말하는 것이 이 걸음의 옳은 모습이다.
    if (count === 0 && !REAL) {
      const empty = await visible(page, T.historyEmpty);
      check(empty, `기록이 비었는데 빈 상태 문장이 없음 (「${T.historyEmpty}」)`);
      return `빈 서랍 — 「${T.historyEmpty}」`;
    }
    const titles = await page.locator(".nx-hitem .nx-ht").allInnerTexts();
    check(count > 0, "기록이 비어 있음");
    return `${count}줄 — ${titles.map((t) => t.replace(/\s+/g, " ")).join(" / ").slice(0, 140)}`;
  });
  await step(5, "줄을 누름 → 제목으로 묻는 확인", async () => {
    if (count < 2) {
      // 되돌릴 차례가 없는 것은 결함이 아니라 빈 역사다 — 건너뛴다(--real 은 그대로 막힘).
      if (REAL) block(`되돌릴 앞 차례가 없음 (기록 ${count}줄)`);
      skip(`기록 ${count}줄`);
    }
    await page.locator(".nx-hitem").nth(1).locator(".nx-hbody").click();
    const dlg = page.getByRole("alertdialog");
    await dlg.waitFor({ state: "visible", timeout: 3_000 }).catch(() => block("확인이 열리지 않음"));
    const text = (await dlg.innerText()).replace(/\s+/g, " ");
    await shot(page, 5, "confirm");
    check(/^「.+」 직후의 화면으로 되돌릴까요\?/.test(text), `제목으로 묻지 않음: ${text.slice(0, 60)}`);
    check(text.includes(T.revertKeep), "기록이 남는다는 말 없음");
    if (REAL) {
      await dlg.getByRole("button", { name: T.revert, exact: true }).click();
      const done = await waitText(page, "시점으로 되돌렸어요", 20_000);
      await sleep(1500);
      await shot(page, 5, "reverted");
      check(done, "되돌렸다는 토스트 없음");
    } else {
      await dlg.getByRole("button", { name: T.cancel, exact: true }).click();
    }
    return text.slice(0, 120);
  });
  await step(5, "정산 줄 `···` → 여기서 새 대화 · 작업 기록에서 되돌리기", async () => {
    const menu = page.getByRole("button", { name: T.settleMenu });
    if (!(await menu.first().isVisible().catch(() => false))) {
      // 답을 낸 차례가 없는 것도 빈 역사다 — 건너뛴다(--real 은 그대로 막힘).
      if (REAL) block("정산 줄이 없음 — 답을 낸 차례가 이 대화에 없다");
      skip(`기록 ${count}줄 — 답을 낸 차례가 없다`);
    }
    await menu.first().click();
    await sleep(500);
    await shot(page, 5, "settle-menu");
    check(await visible(page, T.fork), "`여기서 새 대화` 없음");
    check(await visible(page, T.forkRevertLink), "`작업 기록에서 되돌리기` 없음");
    return "";
  });
  await page.context().close();
};

// 6 — 홈 · 받은 편지함(U6)
TASK[6] = async () => {
  const page = await openPage(URL0);
  page.__task = 6;
  await workReady(page);
  await step(6, "홈 — 인사 · 큰 입력창 · 받은 편지함 셋", async () => {
    await btn(page, T.home).click();
    await sleep(1200);
    await shot(page, 6, "home");
    const text = await bodyText(page);
    const greet = text.match(/(\S+님, )?무엇을 만들까요\?/)?.[0] ?? "";
    check(await page.getByPlaceholder(T.homePh).first().isVisible().catch(() => false), "큰 입력창 없음");
    check((await visible(page, T.waiting)) || (await visible(page, T.calm)), "`답을 기다려요` 칸 없음");
    check(await visible(page, T.running), "`지금 진행 중` 없음");
    check(await visible(page, T.recent), "`방금 있던 일` 없음");
    return `인사: 「${greet}」`;
  });
  await step(6, "홈에서 보냄 → 새 대화로 넘어감", async () => {
    if (REAL) skip("--real 에서는 턴을 아낀다");
    const box = page.getByPlaceholder(T.homePh);
    await box.fill("홈에서 보낸 말");
    await box.press("Enter");
    await sleep(2500);
    await shot(page, 6, "home-sent");
    const moved = await page.getByPlaceholder(T.composerPh).first().isVisible().catch(() => false);
    check(moved, "작업 화면으로 넘어가지 않음");
    const inThread = await visible(page, "홈에서 보낸 말");
    const failed = await waitAny(page, [T.sendFailed, T.failTitle], 20_000);
    await shot(page, 6, "home-sent-after");
    return `작업 화면으로 넘어감 · 보낸 말 ${inThread ? "대화록에" : "대화록에 없음"}${failed ? ` · 「${failed}」` : ""}`;
  });
  await step(6, "`답을 기다려요` 카드에 홈에서 답하기", () =>
    skip("AI 가 묻거나 허락을 구해야 선다 — 가짜 claude 는 묻지 않는다"),
  );
  await page.context().close();
};

// 7 — 다시 받기 · 다른 프로젝트 줄 · 전환 · 준비(U7 · U8 · U11)
TASK[7] = async () => {
  const page = await openPage(URL0);
  page.__task = 7;
  await workReady(page);
  let other = null;
  await step(7, "설정 → 초대 파일 열기 → 다시 받기 확인판(새로 · 그대로)", async () => {
    appendUserPairs(STATE, 4);
    await btn(page, T.settings).click();
    await sleep(700);
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 5_000 }),
      btn(page, T.openInvite).click(),
    ]);
    await chooser.setFiles(INVITE2);
    const dlg = page.getByRole("dialog", { name: T.inviteLineTitle });
    await dlg.waitFor({ state: "visible", timeout: 10_000 }).catch(() => block("확인판이 서지 않음"));
    await sleep(800);
    const text = (await dlg.innerText()).replace(/\s+/g, " ");
    await shot(page, 7, "invite-confirm");
    check(text.includes(T.rowNew), "`새로` 행 없음");
    check(text.includes(T.rowKeep) || text.includes("바뀜"), "기존 프로젝트 행 없음");
    await dlg.getByRole("button", { name: T.inviteApply, exact: true }).click();
    await sleep(3000);
    await shot(page, 7, "invite-applied");
    const ok = page.getByRole("button", { name: "알겠어요" });
    if (await ok.isVisible().catch(() => false)) await ok.click();
    await page.keyboard.press("Escape");
    return text.slice(0, 160);
  });
  await step(7, "사이드바 — 다른 프로젝트 줄", async () => {
    await sleep(1000);
    await shot(page, 7, "others");
    const line = page.locator(".nx-others, .nx-other").first();
    const text = (await line.innerText().catch(() => "")).replace(/\s+/g, " ");
    check(text, "다른 프로젝트 줄이 없음");
    other = text;
    return text.slice(0, 80);
  });
  await step(7, "다른 프로젝트 줄을 누름 → 옮김 · 토스트 · 준비 화면", async () => {
    const row = page.locator(".nx-others button, .nx-other").first();
    await row.click();
    const toast = await waitText(page, T.switched, 5_000);
    const toastBox = await page.locator(".nx-toast").first().boundingBox().catch(() => null);
    const t = await toastText(page);
    await shot(page, 7, "switched");
    await openNewConv(page).catch(() => {});
    await sleep(300);
    const prep = await waitAny(page, [T.prepTitle, ...T.prepSteps], 4_000);
    await shot(page, 7, "preparing");
    check(toast, "옮겼다는 토스트 없음");
    return `토스트 「${t}」(top ${toastBox ? Math.round(toastBox.y) : "?"}px) · 준비 화면 ${prep ? "봤음" : "못 봄(준비가 이미 끝남)"}`;
  });
  await step(7, "준비 중에 말하기 · 찍기 잠김", async () => {
    const prepping = await visible(page, T.prepTitle);
    if (!prepping) skip("준비가 이미 끝났다 — 픽스처 앱은 설치가 없어 몇 초면 선다");
    await composerSend(page, "준비 중에 먼저 말해 둔 것");
    const queued = await waitText(page, T.queued, 5_000);
    await page.getByRole("button", { name: T.pin, exact: true }).last().click().catch(() => {});
    const locked = await waitText(page, T.pinLocked, 3_000);
    await shot(page, 7, "prep-queued");
    check(queued, "대기 줄 문장 없음");
    check(locked, "찍기 잠김 토스트 없음");
    return "";
  });
  await step(7, "되돌아옴 — 떠난 프로젝트가 다른 프로젝트 줄에", async () => {
    await sleep(4000);
    const row = page.locator(".nx-others button, .nx-other").first();
    const before = (await row.innerText().catch(() => "")).replace(/\s+/g, " ");
    await row.click();
    await waitText(page, T.switched, 5_000);
    await sleep(1500);
    const now = (await page.locator(".nx-others, .nx-other").first().innerText().catch(() => "")).replace(/\s+/g, " ");
    await shot(page, 7, "back");
    check(now, "돌아온 뒤 다른 프로젝트 줄이 없음");
    return `떠나기 전 「${before}」 · 돌아온 뒤 「${now}」`;
  });
  void other;
  await page.context().close();
};

// 8 — 설정 네 줄 · 업데이트 버튼 · 모델 칩(U12 · 단계 2)
TASK[8] = async () => {
  let server = null;
  if (LATEST_PORT) {
    server = http
      .createServer((req, res) => {
        if (req.url.includes("codex")) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ tag_name: "rust-v0.99.0", assets: [] }));
          return;
        }
        res.end("2.2.0\n");
      })
      .listen(LATEST_PORT, "127.0.0.1");
  }
  const page = await openPage(URL0);
  page.__task = 8;
  await workReady(page);
  await step(8, "설정 — 네 줄과 개발자용 폴드", async () => {
    await btn(page, T.settings).click();
    const dlg = page.getByRole("dialog", { name: T.settings });
    await dlg.waitFor({ state: "visible", timeout: 4_000 });
    await sleep(800);
    await shot(page, 8, "settings");
    const text = (await dlg.innerText()).replace(/\s+/g, " ");
    for (const w of [T.sAi, T.sNotify, T.sConn, T.sUpdate, T.sDev]) check(text.includes(w), `\`${w}\` 줄 없음`);
    check(text.includes(T.authorName), "작업에 적을 이름 칸 없음");
    check(text.includes(T.connOk), "`연결 정상` 없음");
    return text.match(/연결 정상[^가-힣]*[가-힣 0-9·]*/)?.[0]?.slice(0, 40) ?? "";
  });
  await step(8, "업데이트 — `지금 확인` → 새 버전 → `업데이트` → 최신이에요", async () => {
    if (!LATEST_PORT) skip("--latest-port 없음 (가짜 최신 버전 서버)");
    const dlg = page.getByRole("dialog", { name: T.settings });
    await dlg.getByRole("button", { name: T.checkNow }).click();
    const found = await waitText(page, "2.2.0 있어요", 20_000);
    if (!found && (await dlg.innerText()).includes("2.2.0")) skip("이미 2.2.0 — 앞선 실행이 올려 두었다(격리 데몬을 새로 띄우면 다시 돈다)");
    await shot(page, 8, "update-found");
    check(found, "`→ 2.2.0 있어요` 가 서지 않음");
    const row = dlg.locator(".nx-urow, .nx-update-row, li, div").filter({ hasText: "2.2.0 있어요" }).last();
    await row.getByRole("button", { name: T.updateRun, exact: true }).click();
    const seen = [];
    const end = Date.now() + 30_000;
    let done = false;
    while (Date.now() < end) {
      const t = (await row.innerText().catch(() => "")).replace(/\s+/g, " ");
      if (t && seen[seen.length - 1] !== t) {
        seen.push(t);
        await shot(page, 8, `update-${seen.length}`);
      }
      if ((await visible(page, T.updatedAt)) || /2\.2\.0 · 최신이에요/.test(await bodyText(page))) {
        done = true;
        break;
      }
      await sleep(300);
    }
    await sleep(500);
    await shot(page, 8, "update-done");
    check(done, `끝의 문장이 서지 않음 — ${seen.join(" → ").slice(0, 200)}`);
    return seen.slice(0, 4).join(" → ").slice(0, 200);
  });
  await step(8, "알림 줄 — 세 선택지 · 시험 알림", async () => {
    const dlg = page.getByRole("dialog", { name: T.settings });
    const text = (await dlg.innerText()).replace(/\s+/g, " ");
    for (const w of ["끔", "오래 걸린 답만", "모든 답", "시험 알림"]) check(text.includes(w), `\`${w}\` 없음`);
    return "";
  });
  await step(8, "개발자용 폴드 — 열어야 보임", async () => {
    const dlg = page.getByRole("dialog", { name: T.settings });
    const before = (await dlg.innerText()).includes("데몬");
    await dlg.getByText("문제 해결 도구 펼치기").first().click().catch(() => {});
    await sleep(400);
    await shot(page, 8, "dev-fold");
    const after = (await dlg.innerText()).includes("데몬");
    check(!before, "폴드가 닫혔는데 개발자 말이 보임");
    await dlg.getByRole("button", { name: "닫기" }).first().click();
    await sleep(400);
    return after ? "펼치면 데몬 줄" : "펼쳐도 데몬 줄 없음";
  });
  await step(8, "모델 칩 — 모델 · 생각 시간 · 빠르게", async () => {
    await openNewConv(page);
    await sleep(800);
    await page.locator(".nx-tbtn--model").locator("visible=true").last().click();
    await sleep(600);
    await shot(page, 8, "model-chip");
    const text = await bodyText(page);
    check(text.includes("생각 시간"), "생각 시간 없음");
    check(text.includes(T.thinkShort) && text.includes(T.thinkLong), "짧게 · 길게 없음");
    const fast = text.includes(T.fast);
    await page.keyboard.press("Escape");
    return fast ? "빠르게 있음" : "빠르게 없음(이 모델이 받지 않음)";
  });
  await page.context().close();
  if (server) server.close();
};

// 9 — 좁은 창(U16)
TASK[9] = async () => {
  const page = await openPage(URL0, { width: 860, height: 900 });
  page.__task = 9;
  await btn(page, /새 대화/, false).waitFor({ state: "attached", timeout: 20_000 }).catch(() => {});
  await sleep(1500);
  await step(9, "사이드바는 ≡ 뒤로, 대화 | 화면 탭", async () => {
    await shot(page, 9, "narrow-home");
    const menu = page.getByRole("button", { name: "메뉴 열기" }).first();
    check(await menu.isVisible().catch(() => false), "≡ 가 없음");
    await menu.click();
    await sleep(500);
    await shot(page, 9, "narrow-menu");
    await btn(page, /새 대화/, false).click();
    await sleep(1200);
    await shot(page, 9, "narrow-conv");
    const tabs = await page.getByRole("tab").allInnerTexts();
    check(tabs.some((t) => t.includes(T.chatTab)) && tabs.some((t) => t.includes(T.screenTab)), `탭: ${tabs.join(" | ")}`);
    return tabs.join(" | ");
  });
  await step(9, "여정은 지금 점만 글자 · 입력창의 `찍기`", async () => {
    const labels = await page.locator(".nx-journey .nx-jl").allInnerTexts();
    const pinInComposer = await page.locator(".nx-composer, .nx-cmp").getByRole("button", { name: /찍기/ }).count();
    check(labels.length === 1, `여정 글자 ${labels.length}개`);
    check(pinInComposer > 0, "좁은 창 입력창에 찍기 없음");
    await page.getByRole("tab", { name: new RegExp(T.screenTab) }).click();
    await sleep(1200);
    await shot(page, 9, "narrow-screen");
    return `여정 「${labels.join("")}」`;
  });
  await page.context().close();
};

// 10 — AI 답 실패 카드 · 도구가 한 일 · 문제 문장
TASK[10] = async () => {
  const page = await openPage(URL0);
  page.__task = 10;
  await workReady(page);
  await step(10, "실패한 대화 — `AI가 답을 못 했어요` · `다시 시도`", async () => {
    if (REAL) skip("--real 에서는 실패가 없다");
    if (!(await openFirstConv(page))) {
      // 가짜 claude 는 세션이 태어나자마자 죽는다 — 첫 보내기의 거절은 세션째
      // 거두므로(W4) 실패한 대화가 아예 남지 않는 것이 옳은 모습이다. 실패 카드는
      // 받아들여진 뒤 망한 턴(경주에 이긴 보내기)이 있을 때만 선다.
      skip("가짜 claude — 첫 보내기가 모두 거절돼 실패한 대화가 남지 않는다(W4)");
    }
    await sleep(2000);
    await shot(page, 10, "failed-conv");
    const side = (await page.locator(".nx-conv-list button.nx-conv").first().innerText()).replace(/\s+/g, " ");
    const chat = page.locator(".nx-chat").locator("visible=true").first();
    const card = await chat.getByText(T.failTitle).first().isVisible().catch(() => false);
    const retry = await chat.getByRole("button", { name: T.retry }).first().isVisible().catch(() => false);
    const restored = await chat.getByText(T.sendFailed).first().isVisible().catch(() => false);
    check(card && retry, `사이드바는 「${side}」 인데 대화에는 ${card ? "카드만" : "실패 카드가 없음"}${retry ? "" : " · `다시 시도` 없음"}${restored ? " (입력창 아래 「AI에게 말을 전하지 못했어요」만)" : ""}`);
    return "카드 · 다시 시도";
  });
  await step(10, "몇 분 뒤 — 막힌 제출의 흔적(여정 · 문제 문장 · 버튼)", async () => {
    await openNewConv(page).catch(() => {});
    await sleep(1000);
    const label = (await page.locator(".nx-submit").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const journey = (await page.locator(".nx-journey").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const problem = (await page.locator(".nx-problem").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    await shot(page, 10, "submit-later");
    return `버튼 「${label}」 · 여정 「${journey}」 · 문제 문장 「${problem || "없음"}」`;
  });
  await step(10, "`도구가 한 일` 묶음", async () => {
    const g = page.getByText(new RegExp(T.toolWork)).first();
    if (!(await g.isVisible().catch(() => false))) skip("도구가 스스로 연 대화가 없다");
    await g.click();
    await sleep(500);
    await shot(page, 10, "tool-work");
    return "";
  });
  await step(10, "개발자 확인 · 코멘트 · 반영됨 상태", () =>
    skip("열린 요청이 있어야 선다 — GitHub 픽스처에 요청 짝이 없다"),
  );
  await page.context().close();
};

// ================================================================= 실행
(async () => {
  browser = await chromium.launch();
  for (const t of TASKS) {
    if (!TASK[t]) continue;
    const started = Date.now();
    try {
      await TASK[t]();
    } catch (e) {
      rows.push({ task: t, name: "(과제 전체)", status: "BLOCKED", note: `오류: ${e.message.split("\n")[0]}`, ms: Date.now() - started });
    }
  }
  await browser.close();

  const pad = (s, n) => {
    const w = [...String(s)].reduce((a, c) => a + (/[ㄱ-힝·]/.test(c) ? 2 : 1), 0);
    return String(s) + " ".repeat(Math.max(0, n - w));
  };
  console.log("\n과제 | 걸음 | 결과 | 메모");
  for (const r of rows) {
    const status = r.status === "PASS" ? "PASS" : `${r.status}(${r.note})`;
    console.log(`${pad(r.task, 3)}| ${pad(r.name, 58)}| ${status}${r.status === "PASS" && r.note ? ` — ${r.note}` : ""}`);
  }
  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`\nPASS ${count("PASS")} · BLOCKED ${count("BLOCKED")} · SKIPPED ${count("SKIPPED")}`);
  console.log(`\n금칙어(개발자용 폴드 밖): ${vocabHits.length ? "" : "없음"}`);
  const seenHit = new Set();
  for (const h of vocabHits) {
    const key = `${h.word}|${h.around}`;
    if (seenHit.has(key)) continue;
    seenHit.add(key);
    console.log(`  ${h.where} 「${h.word}」 …${h.around}…`);
  }
  console.log(`\n페이지 오류: ${pageErrors.length ? "" : "없음"}`);
  for (const e of [...new Set(pageErrors)]) console.log(`  ${e}`);
  fs.writeFileSync(path.join(SHOTS, "result.json"), JSON.stringify({ rows, vocabHits, pageErrors }, null, 2));
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
