/**
 * 문서가 화면 밖으로 밀리는지를 페이지 안에서 재는 자기완결 함수 (2026-09-29).
 *
 * element-identity.ts 와 같은 결이다 — 드라이버가 이 함수의 **소스**(toString)를
 * 페이지의 메인 월드에서 돌리므로 모듈 스코프 참조가 없어야 한다. 부품은 전부
 * 몸 안에 들어 있고 import 는 type 만이다.
 *
 * 재는 것은 셋이다: 화면 폭(레이아웃 뷰포트) · 문서 폭(스크롤 폭) · 사용자가 문서를
 * 옆으로 밀 수 있는가(뷰포트가 넘침을 가리면 문서는 밀리지 않는다). 밀릴 때만 원인을
 * 찾는다 — 원인은 두 갈래다.
 *  - 상자: 화면 오른쪽 밖으로 삐져나온 요소 중 **바깥쪽 것만**(표가 넘치면 표 안의
 *    칸이 아니라 표).
 *  - 글자: 상자는 화면 안인데 길게 이어진 단어 · 주소가 상자 밖으로 나간다. 요소의
 *    사각형으로는 안 잡히므로 글자 조각의 사각형을 직접 본다.
 * 고정 배치(`position: fixed`)와, 넘침을 제 안에 가두는 조상(overflow-x 가 visible 이
 * 아닌 것 — 표를 감싼 가로 스크롤 상자) 안의 것은 뺀다. 둘 다 문서를 밀지 못한다.
 * 몇 px 부터 문제인가의 문턱은 데몬의 판정이다(screen-gate.ts `overflowOf`).
 */
import type { PreviewOverflow } from "@nova-design/daemon/server";

export function measureOverflowInPage(): PreviewOverflow | null {
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) return null;
  const viewportWidth = root.clientWidth;
  const documentWidth = (document.scrollingElement ?? root).scrollWidth;
  // 뷰포트에 걸리는 overflow-x — html 이 visible 이면 body 의 것이 뷰포트로 올라간다.
  let viewportOverflowX = getComputedStyle(root).overflowX;
  if (viewportOverflowX === "visible") viewportOverflowX = getComputedStyle(body).overflowX;
  const scrollable = viewportOverflowX !== "hidden" && viewportOverflowX !== "clip";

  const found: Array<{ el: Element; label: string; right: number }> = [];
  if (scrollable && documentWidth > viewportWidth) {
    /** 요소를 알아볼 만큼의 표기 — 태그 · id · class 둘 · testid, 그리고 글자 앞머리. */
    const labelOf = (el: Element): string => {
      let label = el.tagName.toLowerCase();
      if (el.id) label += `#${el.id}`;
      for (const name of Array.from(el.classList).slice(0, 2)) label += `.${name}`;
      const testId = el.getAttribute("data-testid");
      if (testId) label += `[data-testid=${testId}]`;
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 16);
      if (text) label += ` "${text}"`;
      return label.slice(0, 60);
    };
    /**
     * 원인 하나를 적는다. 이미 적은 요소의 안쪽은 그 요소의 일부라 건너뛰고, 고정 배치나
     * 넘침을 가두는 조상 안이면 문서를 밀지 못하므로 건너뛴다. 조상 살피기가 어디서
     * 시작하는가가 상자와 글자의 차이다 — 상자는 제 overflow 와 무관하게 제 자리를
     * 차지하지만(부모부터), 글자는 그 글자를 품은 요소가 가두면 갇힌다(제 자신부터).
     */
    const record = (el: Element, right: number, ownContent: boolean): void => {
      if (found.some((entry) => entry.el.contains(el))) return;
      if (getComputedStyle(el).position === "fixed") return;
      for (
        let ancestor: Element | null = ownContent ? el : el.parentElement;
        ancestor && ancestor !== body && ancestor !== root;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== "visible" || style.position === "fixed") return;
      }
      found.push({ el, label: labelOf(el), right: Math.round(right) });
    };

    // 상자 — 본문 자체가 넓은 경우(min-width)까지 잡도록 body 가 첫 후보다. 나머지는
    // 4000개까지 — 거대한 문서가 재는 데 시간을 끌지 않게.
    const candidates: Element[] = [
      body,
      ...Array.from(body.getElementsByTagName("*")).slice(0, 4000),
    ];
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.right <= viewportWidth + 1) continue;
      record(el, rect.right, false);
    }

    // 글자 — 상자를 먼저 적었으므로, 넓은 상자 안의 글자는 거기서 이미 걸러진다.
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let visited = 0;
    for (let node = walker.nextNode(); node && visited < 4000; node = walker.nextNode()) {
      visited += 1;
      const parent = node.parentElement;
      if (!parent || !(node.nodeValue ?? "").trim()) continue;
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 || rect.right <= viewportWidth + 1) continue;
      record(parent, rect.right, true);
    }
    found.sort((a, b) => b.right - a.right);
  }
  return {
    viewportWidth,
    documentWidth,
    scrollable,
    offenders: found.slice(0, 3).map(({ label, right }) => ({ label, right })),
  };
}
