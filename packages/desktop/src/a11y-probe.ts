/**
 * 접근성 점검의 재료를 모으는 부품들 (2026-09-29) — 이름 없는 컨트롤 · 그림, 그리고
 * 글자 색과 배경.
 *
 * overflow-probe.ts 와 같은 결이다: 드라이버는 브라우저가 아는 것만 말하고, 무엇이 문제인가의
 * 판정(문턱 · 비율 · 지난번과의 차)은 데몬의 것이다(screen-gate.ts `a11yOf`). 페이지 안에서 도는
 * 함수(`labelOfInPage` · `collectAuditInPage`)는 드라이버가 소스(toString)를 페이지의 메인 월드에서
 * 돌리므로 모듈 스코프 참조가 없어야 하고 import 는 type 만이다 — 둘이 함께 쓰는 표기는
 * 인자로 넘겨 받는다.
 *
 * 무엇을 어디서 알아내는가:
 *  - 컨트롤의 이름: 브라우저의 접근성 트리가 계산한 이름(`Accessibility.getFullAXTree`)이다 —
 *    aria-label · label · title · placeholder 를 우리가 흉내 내지 않는다.
 *  - 그림의 이름: 접근성 트리에서는 장식용 `<svg>` 까지 이름 없는 그림으로 나와 소음이 되므로
 *    페이지 안에서 직접 본다 — `alt` 가 아예 없는 `<img>` 와 이름 없는 `role="img"` 만.
 *  - 글자의 배경: 브라우저가 페인트한 화면에서 잰 색(`CSS.getBackgroundColors`)이다 — 그라디언트 ·
 *    이미지 · 겹친 요소 위의 글자도 실제로 보이는 색으로 본다.
 */

/** 이름이 있어야 하는 접근성 역할 — 화면 낭독기가 읽어 줄 이름이 없으면 쓸 수 없는 컨트롤들. */
const NAMED_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
]);

/** Chromium 이 돌려주는 접근성 노드 — 쓰는 부분만 적는다. */
export interface AxNodeLike {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
}

/**
 * 접근성 트리에서 이름이 빈 컨트롤을 고른다. 무시된 노드(숨김 · 장식)는 화면 낭독기에도
 * 보이지 않으므로 제외한다. `total` 은 셈 전체, `targets` 는 표본이다(라벨을 붙이려면 노드마다
 * DOM 을 풀어야 하므로 `cap` 개까지만 돈다).
 */
export function unnamedControlsOf(
  nodes: readonly AxNodeLike[],
  cap: number,
): { total: number; targets: Array<{ role: string; backendNodeId: number }> } {
  let total = 0;
  const targets: Array<{ role: string; backendNodeId: number }> = [];
  for (const node of nodes) {
    if (node.ignored === true) continue;
    const role = typeof node.role?.value === "string" ? node.role.value : "";
    if (!NAMED_ROLES.has(role)) continue;
    const name = node.name?.value;
    if (typeof name === "string" && name.trim() !== "") continue;
    if (typeof node.backendDOMNodeId !== "number") continue;
    total += 1;
    if (targets.length < cap) targets.push({ role, backendNodeId: node.backendDOMNodeId });
  }
  return { total, targets };
}

/** 느린 호출 하나가 게이트를 붙잡지 않게 — 시간이 지나면 null 이다(호출은 버린다). */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  const { promise, resolve } = Promise.withResolvers<null>();
  const timer = setTimeout(() => resolve(null), ms);
  timer.unref();
  try {
    return await Promise.race([work, promise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 요소를 알아볼 만큼의 표기 — 태그 · id · class 둘 · type · role · testid, 링크는 href, 그림은
 * 파일 이름. 이름 없는 것에는 글자가 없으므로 글자 앞머리는 싣지 않는다. 페이지 안에서 도는
 * 함수다(위 머리말) — 요소는 인자로 받는다.
 */
export function labelOfInPage(el: Element): string {
  const tag = el.tagName.toLowerCase();
  let label = tag;
  if (el.id) label += `#${el.id}`;
  for (const name of Array.from(el.classList).slice(0, 2)) label += `.${name}`;
  const attr = (name: string): string => el.getAttribute(name) ?? "";
  if ((tag === "input" || tag === "button") && attr("type")) label += `[type=${attr("type")}]`;
  if (attr("role")) label += `[role=${attr("role")}]`;
  if (attr("data-testid")) label += `[data-testid=${attr("data-testid")}]`;
  if (tag === "a" && attr("href")) label += `[href=${attr("href").slice(0, 30)}]`;
  if (tag === "img") {
    const src = attr("src");
    const file = src.startsWith("data:") ? "data:" : (src.split("?")[0]?.split("/").pop() ?? "");
    if (file) label += `[src=${file.slice(0, 30)}]`;
  }
  return label.replace(/\s+/g, " ").slice(0, 80);
}

/** 글자 색 조합 하나 — 같은 조합의 요소들은 한 대표로 묶는다. */
export interface TextColorMeta {
  label: string;
  /** 글자색 `[r, g, b, a]` — 브라우저가 sRGB 로 바꾼 값(a 는 0~1). */
  color: [number, number, number, number];
  /** 조상까지 곱한 불투명도. */
  opacity: number;
  fontSize: number;
  fontWeight: number;
  /** 이 조합을 가진 요소의 수. */
  count: number;
}

/** 페이지 안 수집의 결과 — `texts.els` 는 `texts.meta` 와 같은 순서의 대표 요소들이다. */
export interface AuditCollected {
  images: { total: number; labels: string[] };
  texts: { els: Element[]; meta: TextColorMeta[] };
}

/**
 * 페이지 안에서 두 가지를 모은다: 이름 없는 그림, 그리고 글자 색 조합. 페이지 안에서 도는
 * 자기완결 함수다(위 머리말).
 *
 * 글자는 요소마다 재지 않고 **색 조합**으로 묶는다(글자색 · 불투명도 · 크기 · 굵기 · 조상의
 * 배경색 사슬) — 조합이 같으면 배경도 같으므로 대표 하나만 브라우저에 묻는다. 배경 이미지 ·
 * 필터가 낀 조상 밑의 글자는 위치마다 배경이 달라 묶지 않는다(스무 곳까지).
 * 대비 면제이거나 보이지 않는 글자는 뺀다: 비활성 컨트롤(WCAG 가 면제한다), 숨김
 * (`aria-hidden` · `hidden` · `inert`), 화면 낭독기 전용의 접힌 글자, 그라디언트 글자처럼 투명한 글자,
 * 그리고 지금 움직이는 중인 요소(전환이 끝나기 전의 옅은 색은 이 화면의 모습이 아니다).
 */
export function collectAuditInPage(labelOf: (el: Element) => string): AuditCollected {
  const body = document.body;
  const collected: AuditCollected = {
    images: { total: 0, labels: [] },
    texts: { els: [], meta: [] },
  };
  if (!body) return collected;

  // ——— 이름 없는 그림: alt 가 아예 없는 <img>, 이름 없는 role="img".
  for (const el of Array.from(document.querySelectorAll("img:not([alt]), [role='img']"))) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (el.closest("[aria-hidden='true'], [hidden]")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) continue;
    if (el.tagName !== "IMG") {
      const named =
        (el.getAttribute("aria-label") ?? "").trim() !== "" ||
        (el.getAttribute("aria-labelledby") ?? "").trim() !== "" ||
        (el.getAttribute("title") ?? "").trim() !== "" ||
        (el.querySelector("title")?.textContent ?? "").trim() !== "";
      if (named) continue;
    }
    collected.images.total += 1;
    if (collected.images.labels.length < 20) collected.images.labels.push(labelOf(el));
  }

  // ——— 글자 색 조합.
  const animated = new Set<Element>();
  try {
    for (const animation of document.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (target) animated.add(target);
    }
  } catch {
    // 움직임을 못 읽으면 걸러내지 못할 뿐이다.
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const colorCache = new Map<string, [number, number, number, number] | null>();
  /** CSS 색을 sRGB `[r, g, b, a]` 로 — oklch() 같은 새 표기도 브라우저가 풀어 준다. */
  const rgbaOf = (css: string): [number, number, number, number] | null => {
    const known = colorCache.get(css);
    if (known !== undefined) return known;
    let value: [number, number, number, number] | null = null;
    if (context) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000000";
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      value = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255];
    }
    colorCache.set(css, value);
    return value;
  };

  interface Up {
    sig: string;
    unknownBg: boolean;
    animated: boolean;
    opacity: number;
  }
  const upOf = new Map<Element, Up>();
  const walkUp = (el: Element): Up => {
    const known = upOf.get(el);
    if (known) return known;
    const style = getComputedStyle(el);
    const parent = el === document.documentElement ? null : el.parentElement;
    const above: Up = parent
      ? walkUp(parent)
      : { sig: "", unknownBg: false, animated: false, opacity: 1 };
    const opacity = Number.parseFloat(style.opacity);
    /** 켜진 효과인가 — 지원하지 않는 속성이 빈 문자열로 와도 켜진 것으로 세지 않는다. */
    const on = (value: string): boolean => value !== "" && value !== "none";
    const own: Up = {
      sig:
        style.backgroundColor === "rgba(0, 0, 0, 0)"
          ? above.sig
          : `${above.sig}${style.backgroundColor};`,
      unknownBg:
        above.unknownBg ||
        on(style.backgroundImage) ||
        on(style.filter) ||
        on(style.getPropertyValue("backdrop-filter")) ||
        (style.mixBlendMode !== "" && style.mixBlendMode !== "normal"),
      animated: above.animated || animated.has(el),
      opacity: above.opacity * (Number.isNaN(opacity) ? 1 : opacity),
    };
    upOf.set(el, own);
    return own;
  };

  const groups = new Map<string, { el: Element; meta: TextColorMeta }>();
  let unpooled = 0;
  const elements = Array.from(body.getElementsByTagName("*")).slice(0, 5000);
  for (const [index, el] of elements.entries()) {
    if (el instanceof SVGElement) continue;
    let hasText = false;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? "").trim() !== "") {
        hasText = true;
        break;
      }
    }
    if (!hasText) continue;
    const style = getComputedStyle(el);
    if (style.visibility !== "visible" || style.display === "none") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4 || rect.right <= 0 || rect.bottom <= 0) continue;
    if (el.closest(":disabled, [aria-disabled='true'], [aria-hidden='true'], [hidden], [inert]")) {
      continue;
    }
    const up = walkUp(el);
    if (up.animated || up.opacity < 0.05) continue;
    const color = rgbaOf(style.getPropertyValue("-webkit-text-fill-color") || style.color);
    if (!color || color[3] === 0) continue;
    const fontSize = Number.parseFloat(style.fontSize);
    const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
    const key = up.unknownBg
      ? `position:${index}`
      : `${color.join(",")}|${up.opacity.toFixed(2)}|${fontSize}|${fontWeight}|${up.sig}`;
    const known = groups.get(key);
    if (known) {
      known.meta.count += 1;
      continue;
    }
    if (groups.size >= 60) continue;
    if (up.unknownBg) {
      unpooled += 1;
      if (unpooled > 20) continue;
    }
    groups.set(key, {
      el,
      meta: {
        label: labelOf(el),
        color,
        opacity: up.opacity,
        fontSize,
        fontWeight,
        count: 1,
      },
    });
  }
  const found = Array.from(groups.values());
  collected.texts = { els: found.map((g) => g.el), meta: found.map((g) => g.meta) };
  return collected;
}
