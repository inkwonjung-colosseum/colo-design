/*!
 * 마운트 전 와치독(PLAN-CRASH-PROCESS 3.A 층 1 · P-3) — index.html 의 모듈
 * 스크립트 앞에 로드되는 클래식 스크립트다. React 가 뜨기 전에 죽는 부팅
 * (모듈 로드 실패 · main 진입의 예외)을 잡아 안내판 한 장을 세운다.
 *
 * 문장이 labels.ts 의 L.crash 와 겹쳐 있는 이유: 이 파일은 번들 밖에서
 * 돌므로 labels.ts 를 import 할 수 없다. 대신 next-labels.test.ts 가
 * 글자 동치를 지킨다 — labels.ts 를 고치면 이 파일도 같이 고쳐야 한다.
 */
(() => {
  const BOOT_MS = 10000;
  const KEY = "nova-design.last-crash";
  const TITLE = "화면이 열리지 않아요";
  const REOPEN = "다시 열기";
  let shown = false;

  /* 번들이 살아 있다는 신호 — 마운트했거나(appMounted) 경계가 사고를 받았으면
     (appCrashed) 화면의 주인은 React 다. 와치독의 판은 번들 자체가 죽은 부팅에만. */
  const reactOwnsScreen = () =>
    document.documentElement.dataset.appMounted === "1" ||
    document.documentElement.dataset.appCrashed === "1";

  /* 직전 부팅이 남긴 사고의 한 줄 — source 접두를 붙인다. 없으면 빈줄. */
  const lastCrashLine = () => {
    try {
      // read-legacy — 개명 전 부팅이 옛 키에 남긴 기록. 이 스크립트는 엔트리의
      // 부팅 이주보다 먼저 읽을 수 있으므로 여기서도 한 번 새 키로 옮겨 둔다.
      const legacyRaw = window.localStorage.getItem("colo-design.last-crash"); // read-legacy
      if (legacyRaw && !window.localStorage.getItem(KEY))
        window.localStorage.setItem(KEY, legacyRaw);
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return "";
      const record = JSON.parse(raw);
      if (!record || typeof record.message !== "string" || !record.message) return "";
      const head = typeof record.source === "string" && record.source ? `${record.source} · ` : "";
      return `${head}${record.message}`;
    } catch {
      return "";
    }
  };

  const styled = (node, style) => {
    node.setAttribute("style", style);
    return node;
  };

  const show = (extraLine) => {
    if (shown) return;
    shown = true;
    const root = document.getElementById("root");
    try {
      if (root) root.textContent = "";
      const panel = styled(
        document.createElement("div"),
        "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;" +
          "justify-content:center;gap:14px;padding:32px;text-align:center;" +
          "background:#faf9f5;color:#26241f;" +
          "font-family:Pretendard Variable,Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      );
      const h1 = styled(document.createElement("h1"), "margin:0;font-size:22px;font-weight:650");
      h1.textContent = TITLE;
      panel.appendChild(h1);
      if (extraLine) {
        const line = styled(
          document.createElement("p"),
          "margin:0;font-size:13px;color:#5c5749;max-width:560px;overflow-wrap:anywhere",
        );
        line.textContent = extraLine;
        panel.appendChild(line);
      }
      const stored = lastCrashLine();
      if (stored && stored !== extraLine) {
        const note = styled(
          document.createElement("p"),
          "margin:0;font-size:12px;color:#8a857a;max-width:560px;overflow-wrap:anywhere",
        );
        note.textContent = stored;
        panel.appendChild(note);
      }
      const button = styled(
        document.createElement("button"),
        "margin-top:8px;padding:9px 22px;font-size:14px;font-weight:600;border-radius:10px;" +
          "border:1px solid #d9d4c4;background:#eceadf;color:inherit;cursor:pointer",
      );
      button.type = "button";
      button.textContent = REOPEN;
      button.addEventListener("click", () => window.location.reload());
      panel.appendChild(button);
      (root ?? document.body).appendChild(panel);
    } catch {
      /* 안내판 자체가 실패하면 더 할 말이 없다 — 타이머는 이미 끝났다. */
    }
  };

  /* 마운트 전 예외는 타이머보다 먼저 안내판을 세운다. 마운트 뒤의 전역 오류는
     화면을 덮지 않는다(P-2) — 앱의 installGlobalHandlers 가 기록만 남긴다. */
  window.addEventListener("error", (event) => {
    if (reactOwnsScreen()) return;
    show(event.message || null);
  });

  window.setTimeout(() => {
    if (!reactOwnsScreen()) show(null);
  }, BOOT_MS);
})();
