/**
 * 히어로의 3D 층 — 외부 라이브러리 없이 손수 짠다.
 *
 * 1. 제품 창 틸트: 마우스를 따라 rotateX/rotateY, 손을 떼면 아주 느린 idle 흔들림.
 * 2. 파티클 필드: 깊이(z)를 가진 점들을 canvas에 투영 — 가까울수록 크고 밝다.
 * 3. 떠 있는 핀/칩: translateZ 로 창 위에 띄우고 마우스 반대 방향으로 패럴랙스.
 *
 * prefers-reduced-motion 이면 아무것도 움직이지 않는다 — 캔버스도 그리지 않는다.
 * 문서가 숨겨지거나 히어로가 화면 밖이면 rAF 를 쉰다.
 */

const hero = document.querySelector(".hero");
const appwin = document.getElementById("appwin");
const floats = [...document.querySelectorAll(".float")];
const canvas = document.querySelector(".hero__field");

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!reduced && hero && appwin) {
  /* ---- 입력 상태 ---- */
  let targetX = 0; // -1..1
  let targetY = 0;
  let curX = 0;
  let curY = 0;
  let lastPointer = 0;

  hero.addEventListener("pointermove", (e) => {
    const r = hero.getBoundingClientRect();
    targetX = ((e.clientX - r.left) / r.width) * 2 - 1;
    targetY = ((e.clientY - r.top) / r.height) * 2 - 1;
    lastPointer = performance.now();
  });
  hero.addEventListener("pointerleave", () => {
    targetX = 0;
    targetY = 0;
  });

  /* ---- 파티클 ---- */
  const ctx = canvas.getContext("2d");
  const DPR = Math.min(devicePixelRatio || 1, 2);
  const DEPTH = 900; // z: 0(가까움)..DEPTH(멂)
  let W = 0;
  let H = 0;
  let particles = [];

  function resize() {
    const r = hero.getBoundingClientRect();
    W = r.width;
    H = r.height;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    const count = Math.round((W * H) / 16000); // 면적 비례 — 모바일은 적게
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      z: Math.random() * DEPTH,
      drift: 0.15 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
    }));
  }
  resize();
  addEventListener("resize", resize);

  /* ---- 루프 ---- */
  let running = true;
  let heroVisible = true;

  new IntersectionObserver(([e]) => (heroVisible = e.isIntersecting)).observe(hero);
  document.addEventListener("visibilitychange", () => (running = !document.hidden));

  function frame(t) {
    requestAnimationFrame(frame);
    if (!running || !heroVisible) return;

    // 마우스가 3초 이상 조용하면 아주 느린 idle 흔들림으로 목표를 대신한다
    const idle = t - lastPointer > 3000;
    const gx = idle ? Math.sin(t / 2600) * 0.35 : targetX;
    const gy = idle ? Math.cos(t / 3100) * 0.25 : targetY;

    curX += (gx - curX) * 0.06;
    curY += (gy - curY) * 0.06;

    appwin.style.transform =
      `rotateX(${8 - curY * 5}deg) rotateY(${curX * 7}deg)`;

    for (const f of floats) {
      const depth = f.classList.contains("float--pin") ? 90 : 60;
      f.style.transform =
        `translate3d(${-curX * depth * 0.45}px, ${-curY * depth * 0.3}px, ${depth}px)`;
    }

    // 파티클 — 위로 천천히 떠오르고, 마우스 반대로 살짝 밀린다
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    for (const p of particles) {
      p.y -= p.drift;
      p.x += Math.sin(t / 2400 + p.phase) * 0.12;
      if (p.y < -8) {
        p.y = H + 8;
        p.x = Math.random() * W;
      }
      const s = 1 - p.z / DEPTH; // 1 가까움 .. 0 멂
      const px = p.x - curX * 26 * s;
      const py = p.y - curY * 18 * s;
      ctx.globalAlpha = 0.08 + s * 0.5;
      ctx.fillStyle = "#9db1c7";
      ctx.beginPath();
      ctx.arc(px, py, 0.6 + s * 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(frame);
}
