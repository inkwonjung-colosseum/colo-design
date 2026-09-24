/**
 * Windows 경로가 마크다운 링크 목적지에서 흔적 없이 변형되는 것을 remark 단계에서
 * 되돌린다. 비개발자가 채팅에 붙여넣는 `C:\Users\보고서.docx` 같은 경로가
 * `[보고서](C:\Users\…)` 링크로 parse 되면 `\.` 가 CommonMark 표점 escape 로
 * 먹혀 `C:\Users.보고서.docx` 처럼 유실되어 버린다.
 *
 * ZCode(zai-org/ZCode, Apache-2.0, 872ad960)의
 * packages/ui/src/lib/windowsFileLinkEscapeRemarkPlugin.ts에서 가져왔다 —
 * 로직은 그대로, 주석만 우리 말로 옮겼다(unified 의 Plugin 타입 갖다 쓰지
 * 않은 것만 우리 쪽 사정이다).
 */

interface MarkdownPoint {
  offset?: number;
}

interface MarkdownNode {
  children?: MarkdownNode[];
  position?: { end?: MarkdownPoint; start?: MarkdownPoint };
  title?: string | null;
  type: string;
  url?: string;
}

// 드라이브 절대경로와 UNC. 이것들만 원문 복구 대상이고 일반 URL 은 이 플러그인의
// 개입면에 들어오지 않는다. UNC 에 앞선 `\` 가 하나인 것만 보는 이유: 소스의
// `\\host` 에서 `\\` 자체가 이미 표점 escape 니까 parse 되면 `\` 하나만 남고,
// 둘을 요구하면 복구가 필요한 UNC 를 전부 놓친다.
const windowsDestinationPattern = /^(?:[a-zA-Z]:[\\/]|\\)/u;

// CommonMark: 링크 목적지의 `\X` 는 X 가 ASCII 표점일 때만 X 를 낸다. 나머지는
// 그대로 둔다. 네 구간은 !-/ · :-@ · [-` · {-~ — 합치면 ASCII 표점 전부다.
const punctuationEscapePattern = /\\([!-/:-@[-`{-~])/gu;

/**
 * 노드 모양에 따라 목적지 원문을 자른다.
 *
 * - 행내 `link` / `image`: `[label](dest)` / `![alt](dest)` — 닫는 `)` 앞까지.
 *   Windows 경로는 `](` 를 품지 않으므로 마지막 구분자를 잡는 것이 안전하고,
 *   label/alt 안의 대괄호도 잘림을 흔들지 않는다.
 * - `definition`: `[ref]: dest` — `]:` 뒤. 참조 링크의 URL 이 정의쪽에 있으므로
 *   같은 유실이 여기서도 일어나고, 함께 복구해야 한다.
 */
function extractRawDestination(node: MarkdownNode, slice: string): string | null {
  if (node.type === "definition") {
    const marker = slice.indexOf("]:");
    return marker < 0 ? null : slice.slice(marker + 2).trim();
  }

  if (!slice.endsWith(")")) return null;
  const marker = slice.lastIndexOf("](");
  return marker < 0 ? null : slice.slice(marker + 2, -1).trim();
}

/**
 * VFile 원문에서 이 노드의 escape 되돌리기 전 목적지 원문을 찾는다.
 *
 * `[x](C:\Users\개발\.zcode\a.png)` 는 remark-parse 단계에서 `\.` 를 표점
 * escape 로 먹는다(`\U` `\z` `\w` 는 뒤가 표점이 아니라서 살아남는다). 유실은
 * parse 때 일어나므로 rehype 단계의 뒤늦은 플러그인이 보는 문자열은 이미
 * 망가진 뒤다 — 그래서 remark 단계에서 해야 한다.
 *
 * 「원문을 CommonMark 규칙으로 escape 풀었을 때 node.url 과 정확히 같은가」를
 * 복구 조건으로 건다. 아니면 지금 상태를 유지한다 — 틀린 경로를 쓰느니보다 낫다.
 */
function recoverRawDestination(node: MarkdownNode, source: string): string | null {
  const url = node.url;
  if (typeof url !== "string" || !windowsDestinationPattern.test(url)) return null;
  // title 있는 링크는 인용구 문법까지 parse 해야 목적지 끝을 알 수 있다 — 잘못
  // 자르면 따옴표가 경로에 섞인다. 이 자리에선 안 나오므로 복구를 포기한다.
  if (node.title !== null && node.title !== undefined) return null;

  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return null;

  const raw = extractRawDestination(node, source.slice(start, end));
  // 꺾쇠 형식(`<...>`)은 escape 규칙이 다르다 — 복구하지 않는다.
  if (raw === null || !raw || raw.startsWith("<") || raw === url) return null;
  if (raw.replace(punctuationEscapePattern, "$1") !== url) return null;

  return raw;
}

export function windowsFileLinkEscapeRemarkPlugin() {
  return (tree: unknown, file: unknown) => {
    const source = String(file ?? "");
    if (!source) return;

    const visit = (node: MarkdownNode): void => {
      if (node.type === "link" || node.type === "image" || node.type === "definition") {
        const raw = recoverRawDestination(node, source);
        if (raw !== null) node.url = raw;
      }

      node.children?.forEach(visit);
    };

    visit(tree as MarkdownNode);
  };
}
