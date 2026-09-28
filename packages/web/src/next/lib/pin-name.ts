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
