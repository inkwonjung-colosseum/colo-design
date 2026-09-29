/**
 * 보낸 말의 핀 이름표 판정 — 순수 함수만 산다. 시험이 src 에서 곧장 읽으므로
 * 형제 모듈을 부르지 않고(확장자 없는 import 를 node 가 풀지 못한다), 문장은
 * 부르는 쪽이 넘긴다(lib/thread.ts 머리의 같은 규칙).
 */

/**
 * 이름표로는 쓸 수 없는 태그 이름 — 대화록에 저장된 옛 마커의 label 은
 * `element.component`(태그 이름)로 떨어진 적이 있어 `div` 가 그대로 보였다.
 * 지금 쓰는 이름표는 `찍은 곳`으로 떨어지지만 저장된 것은 그대로라, 그릴 때
 * 가른다. 잣대는 아는 태그 이름의 집합뿐 — 소문자 영어 낱말 전부로 넓히지
 * 않는다(요소의 글자가 `admin` · `menu` 처럼 영어일 수 있다).
 *
 * 자기 글자를 다는 태그 중 흔한 영어 낱말과 겹치는 것(`a` · `label` · `menu` ·
 * `option` · `time` · `data` · `map` · `video` …)은 뺐다 — 그 이름표가 태그
 * 이름인지 요소의 글자인지 모를 때, 지우는 쪽보다 남기는 쪽이 낫다. 태그
 * 이름표는 요소에 글자가 없을 때만 떨어지는 값이므로, 빈 상자 · 글자 없는
 * 폼 부품 태그는 영어 낱말과 겹쳐도(`button` · `select` · `form` …) 넣는다.
 */
const BARE_TAG_NAMES: Record<string, true> = {
  // 뼈대 · 구획
  body: true,
  div: true,
  span: true,
  section: true,
  article: true,
  aside: true,
  header: true,
  footer: true,
  nav: true,
  main: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  hgroup: true,
  p: true,
  pre: true,
  blockquote: true,
  figure: true,
  figcaption: true,
  hr: true,
  br: true,
  wbr: true,
  ol: true,
  ul: true,
  li: true,
  dl: true,
  dt: true,
  dd: true,
  table: true,
  thead: true,
  tbody: true,
  tfoot: true,
  tr: true,
  td: true,
  th: true,
  colgroup: true,
  col: true,
  // 폼 — 글자 없이 찍히는 부품이 흔하다
  form: true,
  fieldset: true,
  input: true,
  textarea: true,
  button: true,
  select: true,
  datalist: true,
  optgroup: true,
  output: true,
  progress: true,
  meter: true,
  // 문장 안 표기
  abbr: true,
  bdi: true,
  bdo: true,
  dfn: true,
  kbd: true,
  samp: true,
  var: true,
  sub: true,
  sup: true,
  ruby: true,
  rt: true,
  rp: true,
  noscript: true,
  // 미디어 · 담는 틀
  img: true,
  audio: true,
  canvas: true,
  iframe: true,
  embed: true,
  object: true,
  portal: true,
  fencedframe: true,
  // SVG — 도형 태그도 같은 마커에 실린다
  svg: true,
  g: true,
  defs: true,
  use: true,
  symbol: true,
  path: true,
  rect: true,
  circle: true,
  ellipse: true,
  polygon: true,
  polyline: true,
  tspan: true,
  textpath: true,
};

/** 저장된 이름표가 태그 이름 하나뿐이면 `spot`(`찍은 곳`)으로, 아니면 그대로. */
export function shownPinLabel(label: string, spot: string): string {
  const trimmed = label.trim();
  if (trimmed === "" || Object.hasOwn(BARE_TAG_NAMES, trimmed)) return spot;
  return trimmed;
}

/** 말풍선 머리의 이름표에 필요한 요소의 모양 — 짚은 요소가 이 정도만 알려 준다. */
export interface PinTitleElement {
  kind?: string;
  /** 태그 이름. */
  component: string;
  text: string;
  a11y?: { role?: string; name?: string };
}

/** 이름표에 필요한 낱말 — 부르는 쪽(`L.pin`)이 넘긴다. */
export interface PinTitleWords {
  area: string;
  point: string;
  kindButton: string;
  kindLink: string;
  kindImage: string;
  kindInput: string;
}

const TITLE_MAX = 18;

/**
 * 핀 말풍선 머리의 이름 — 사람이 읽는 말만: 접근성 이름 → 요소의 글자 → 요소의 종류(버튼 · 링크
 * · 그림 · 입력칸) → `찍은 곳`. 영역이면 `영역`. 컴포넌트 이름과 testid 는 개발자의 어휘라 쓰지
 * 않는다(그것들은 AI 에게 가는 턴에는 그대로 실린다).
 */
export function pinTitle(element: PinTitleElement, words: PinTitleWords): string {
  if (element.kind === "region") return words.area;
  const named = element.a11y?.name?.trim() || element.text.trim();
  if (named) return named.length > TITLE_MAX ? `${named.slice(0, TITLE_MAX)}…` : named;
  const tag = element.component.toLowerCase();
  const role = element.a11y?.role;
  if (tag === "button" || role === "button") return words.kindButton;
  if (tag === "a" || role === "link") return words.kindLink;
  if (tag === "img" || tag === "svg" || role === "img") return words.kindImage;
  if (tag === "input" || tag === "textarea" || tag === "select") return words.kindInput;
  return words.point;
}
