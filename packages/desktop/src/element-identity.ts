/**
 * 요소 하나의 정체를 페이지 안에서 뽑는 자기완결 함수들 (PLAN-MCP §3.E-1).
 *
 * 한 벌로 사는 이유: 핀 봉투(preview-preload)와 드라이버의 browser_inspect 가
 * 같은 판정을 내야 하기 때문이다. 두 자리 모두 이 함수의 **소스**를 옮겨 쓴다 —
 * 드라이버는 toString() 을 Runtime.callFunctionOn 의 functionDeclaration 으로
 * 페이지의 메인 월드에서 돌리고, preload 는 빌드 스크립트
 * (scripts/build-preloads.mjs)가 이 파일의 컴파일 결과를 preview-preload.cjs
 * 꼬리에 이어 붙인다(샌드박스 preload 는 로컬 require 가 안 되므로). 그러려면
 * 두 함수 모두 모듈 스코프 참조가 없어야 한다 — 부품(ownText · cssPath …)은
 * 전부 몸 안에 들어 있다. 바깥 참조를 끌어들이면 그 자리에서 도구가 깨지므로
 * import 는 type 만.
 */
import type { NovaDesignCommentTarget } from "@nova-design/protocol";

/**
 * 요소 하나의 정체 — 핀 봉투의 element 칸과 같은 모양(재설계 C9 판정 그대로).
 * 드라이버는 callFunctionOn 으로 `this` = 요소 로 부르고, preload 는 인자로
 * 넘겨 부른다. 접근성 노드가 텍스트 노드를 가리킬 때는 그 부모 요소가 정체의
 * 주인이다(select 가 RECT_OF_SELF 에서 그렇게 하는 것과 같은 정규화다).
 */
export function describeElementInPage(this: unknown, el?: unknown): NovaDesignCommentTarget | null {
  /** 요소의 직접 텍스트 노드만 — 공백을 누르고 400자에서 자른다. */
  const ownText = (element: Element): string => {
    let text = "";
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 400);
  };

  /** body 부터의 CSS 경로 — 같은 태그의 형제가 둘 이상일 때만 nth-of-type.
   *  레포 마커 철거(2026-09-21)와 같은 결: 닻은 언제나 body 다. */
  const cssPath = (element: Element): string => {
    const parts: string[] = [];
    for (
      let node: Element | null = element;
      node && node !== document.body;
      node = node.parentElement
    ) {
      // const 로 붙잡아야 클로저 안에서 좁힘이 살는다 — 단언(!) 없이 같은 판정.
      const current = node;
      const tag = current.tagName.toLowerCase();
      const siblings = Array.from(current.parentElement?.children ?? []).filter(
        (candidate) => candidate.tagName === current.tagName,
      );
      const index = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
      const id = current.id ? `#${current.id}` : "";
      parts.unshift(`${tag}${id}${index}`);
    }
    return ["body", ...parts].join(" > ");
  };

  /** body 부터의 XPath — cssPath 와 같은 결(같은 태그의 형제가 둘 이상일
   *  때만 위치), locator 도구가 읽는 주소 모양이다. */
  const xpathPath = (element: Element): string => {
    const parts: string[] = [];
    for (
      let node: Element | null = element;
      node && node !== document.body;
      node = node.parentElement
    ) {
      const current = node;
      const siblings = Array.from(current.parentElement?.children ?? []).filter(
        (candidate) => candidate.tagName === current.tagName,
      );
      const index = siblings.length > 1 ? `[${siblings.indexOf(current) + 1}]` : "";
      parts.unshift(`${current.tagName.toLowerCase()}${index}`);
    }
    return ["/body", ...parts].join("/");
  };
  /** rect 의 네 칸을 정수로 — 핀 봉투의 rect 모양 그대로. */
  const roundRect = (rect: DOMRect): { x: number; y: number; width: number; height: number } => ({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });

  /** 요소 자기 자신의 HTML — 도구의 노드(배지 · 오버레이)를 벗기고 1,500자. */
  const describeHtml = (element: Element): string | undefined => {
    try {
      const clone = element.cloneNode(true);
      if (!(clone instanceof Element)) return undefined;
      for (const node of Array.from(
        clone.querySelectorAll("[data-nova-pick],[data-nova-design-overlay]"),
      )) {
        node.remove();
      }
      const html = clone.outerHTML;
      return html === "" ? undefined : html.length > 3000 ? `${html.slice(0, 3000)}…` : html;
    } catch {
      return undefined;
    }
  };

  /** 인용할 만한 계산 스타일의 부분 — 기본값 · 0 을 걷어내고 열두 칸까지. */
  const describeStyles = (element: Element): Record<string, string> | undefined => {
    const styleKeys = [
      "color",
      "background-color",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "padding",
      "margin",
      "border-radius",
      "display",
      "width",
      "height",
      "gap",
    ];
    let styles: Record<string, string> | undefined;
    try {
      const computed = window.getComputedStyle(element);
      for (const key of styleKeys) {
        if (styles && Object.keys(styles).length >= 12) break;
        const value = computed.getPropertyValue(key).trim();
        if (value === "" || value === "none" || value === "normal" || value === "0px") continue;
        styles ??= {};
        styles[key] = value;
      }
    } catch {
      return undefined;
    }
    return styles;
  };

  /** 태그가 암시하는 역할 — 페이지가 role 을 밝히지 않았을 때의 판정.
   *  명세의 전부가 아니라 기획자가 짚을 만한 것만 담는다. */
  const implicitRole = (element: Element): string | undefined => {
    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.getAttribute("href") !== null) return "link";
    if (tag === "img") return "img";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") return undefined;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset" || type === "image") {
        return "button";
      }
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "aside") return "complementary";
    if (tag === "form") return "form";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    return undefined;
  };

  /** 접근성 정체 — 선언된 role, 없으면 태그가 암시하는 role 과 처음으로
   *  걸리는 이름. 연결된 label 까지는 손이 안 닿는다. */
  const describeA11y = (element: Element): NovaDesignCommentTarget["a11y"] | undefined => {
    try {
      const role = element.getAttribute("role") ?? implicitRole(element);
      const name =
        element.getAttribute("aria-label") ??
        element.getAttribute("alt") ??
        element.getAttribute("title") ??
        element.getAttribute("placeholder") ??
        undefined;
      if (!role && !name) return undefined;
      const a11y: { role?: string; name?: string } = {};
      if (role) a11y.role = role;
      if (name) a11y.name = name;
      return a11y;
    } catch {
      return undefined;
    }
  };

  /** 레포가 시험에 남긴 고리(id · test id · 클래스)와 locator 가 읽는
   *  링크 · 입력 속성 — 값마다 200자에서 자른다. 무엇을 실을지는 이 리스트가
   *  전부다: `value` 는 일부러 없다(사용자가 친 글은 핀의 짐이 아니다). */
  const describeAttrs = (element: Element): NovaDesignCommentTarget["attrs"] | undefined => {
    try {
      const id = element.id || undefined;
      const testId =
        element.getAttribute("data-testid") ?? element.getAttribute("data-test") ?? undefined;
      const classes = Array.from(element.classList).slice(0, 5);
      const attrs: {
        id?: string;
        testId?: string;
        classes?: string[];
        href?: string;
        src?: string;
        name?: string;
        type?: string;
        placeholder?: string;
      } = {};
      if (id) attrs.id = id;
      if (testId) attrs.testId = testId;
      if (classes.length > 0) attrs.classes = classes;
      for (const key of ["href", "src", "name", "type", "placeholder"] as const) {
        const value = element.getAttribute(key);
        if (value === null || value === "") continue;
        attrs[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
      }
      return Object.keys(attrs).length === 0 ? undefined : attrs;
    } catch {
      return undefined;
    }
  };

  /** 핀이 서 있는 말들 — 가장 가까운 구획(article · section · form · 행…)
   *  의 글자 300자. 요소 자신이 거의 아무 말도 없을 때의 위치 설명이다. */
  const describeNearby = (element: Element): string | undefined => {
    try {
      const landmark = element.closest("article,section,main,form,li,tr,dialog");
      if (!(landmark instanceof HTMLElement)) return undefined;
      const text = landmark.innerText.replace(/\s+/g, " ").trim();
      if (text === "") return undefined;
      return text.length > 300 ? `${text.slice(0, 300)}…` : text;
    } catch {
      return undefined;
    }
  };

  const node = el !== undefined && el !== null ? el : this;
  const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  if (!element) return null;
  const target: NovaDesignCommentTarget = {
    component: element.tagName.toLowerCase(),
    text: ownText(element),
    path: cssPath(element),
    xpath: xpathPath(element),
    rect: roundRect(element.getBoundingClientRect()),
  };
  // 보강 — 모든 칸이 선택이고, 실패는 칸 하나의 값일 뿐 핀을 죽이지 않는다.
  const html = describeHtml(element);
  if (html) target.html = html;
  const styles = describeStyles(element);
  if (styles) target.styles = styles;
  const a11y = describeA11y(element);
  if (a11y) target.a11y = a11y;
  const attrs = describeAttrs(element);
  if (attrs) target.attrs = attrs;
  const nearby = describeNearby(element);
  if (nearby) target.nearby = nearby;
  return target;
}

/**
 * 요소의 React owner 사슬 — 안쪽 컴포넌트부터 최대 셋(재설계 C9 판정 그대로).
 * fiber expando 는 메인 월드의 래퍼에만 살아 있어 격리 preload 에서는 보이지
 * 않는다: 드라이버는 callFunctionOn(this = 요소), 핀 relay 는
 * executeJavaScript(…, true) 로 메인 월드에서 이 함수를 부른다. React 가 아닌
 * 페이지 · 프로덕션 빌드는 null — owners 는 선택 칸이다.
 */
export function ownersOfElement(this: unknown): string[] | null {
  const el = this instanceof Element ? this : this instanceof Node ? this.parentElement : null;
  if (!el) return null;
  type OwnerLike = {
    _debugOwner?: OwnerLike | null;
    type?: { displayName?: string; name?: string } | null;
  };
  let fiber: OwnerLike | null = null;
  for (const key of Object.keys(el)) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
      fiber = (el as unknown as Record<string, OwnerLike>)[key] ?? null;
      break;
    }
  }
  const names: string[] = [];
  for (
    let owner: OwnerLike | null | undefined = fiber?._debugOwner ?? null;
    owner != null && names.length < 3;
    owner = owner._debugOwner ?? null
  ) {
    const name = owner.type?.displayName || owner.type?.name;
    if (typeof name === "string" && name !== "") names.push(name);
  }
  return names.length > 0 ? names : null;
}
