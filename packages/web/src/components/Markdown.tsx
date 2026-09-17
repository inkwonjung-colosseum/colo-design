import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { isValidElement, useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { linkClick } from "../lib/open-link";
import { CopyButton } from "./CopyButton";

/**
 * A link the chat renders must never replace the tool itself: a plain <a>
 * navigates this window, and in the desktop app the preload bridge survives
 * that navigation. Every link opens beside the app instead — main's
 * will-navigate guard is the second lock, not the only one.
 */
function ChatLink({
  node: _node,
  href,
  children,
  ...rest
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" {...rest} onClick={linkClick}>
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// ```mermaid 펜스 — 다이어그램
// ---------------------------------------------------------------------------

/**
 * 지금 창의 팔레트가 밝은지. mermaid 는 색을 svg 에 구워 넣으므로 렌더 때마다
 * 팔레트를 읽어 어울리는 테마를 고른다 — 판정 기준은 `--bg` 의 상대 휘도다.
 */
function paletteChannels(raw: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (hex?.[1] !== undefined) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(raw);
  if (rgb?.[1] !== undefined) {
    const [r, g, b] = rgb[1].split(/[\s,]+/);
    const [cr, cg, cb] = [Number(r), Number(g), Number(b)];
    if ([cr, cg, cb].every((n) => Number.isFinite(n))) {
      return [cr, cg, cb];
    }
  }
  return null;
}

function isLightChrome(): boolean {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  const channels = paletteChannels(raw);
  if (!channels) return false;
  const [r, g, b] = channels;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}

/**
 * mermaid 의 initialize·render 는 전역 설정을 두고 경쟁한다 — 한 통에
 * 다이어그램이 여러 개면 호출이 겹치고, 지는 쪽은 실패한다. 페이지에서 한
 * 번에 하나의 렌더만 돌도록 직렬화한다.
 */
let renderChain: Promise<unknown> = Promise.resolve();

function renderDiagram(id: string, source: string, chrome: "dark" | "light"): Promise<string> {
  const task = renderChain.then(async () => {
    // mermaid 는 다이어그램이 실제로 등장할 때만 필요한 수백 KB 다. 정적 import 는
    // 모든 첫 화면에 이 값을 청구하므로, 펜스가 나온 순간의 지연 로드가 맞다.
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      // 모델 출력은 신뢰 대상이 아니다 — strict 가 svg 로 들어가는 태그를 소독한다.
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: chrome === "light" ? "neutral" : "dark",
      fontFamily: "'Pretendard Variable', Pretendard, sans-serif",
    });
    const { svg } = await mermaid.render(id, source);
    return svg;
  });
  renderChain = task.catch(() => undefined);
  return task;
}

/**
 * 한 개의 다이어그램. 지연 로드된 mermaid 로 svg 를 그리고, 파싱이 실패하면
 * 원본 코드 블록으로 돌아간다 — 반쯤 스트리밍된 펜스가 여기 걸리고, 완성되는
 * 순간 다음 렌더에서 그림으로 갈아탄다. 팔레트가 바뀌면 다시 그린다.
 */
function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [chrome, setChrome] = useState<"dark" | "light">(() =>
    isLightChrome() ? "light" : "dark",
  );
  const renderId = `mmd${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  useEffect(() => {
    const observer = new MutationObserver(() => setChrome(isLightChrome() ? "light" : "dark"));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void renderDiagram(renderId, source, chrome)
      .then((next) => {
        if (!cancelled) setSvg(next);
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [source, renderId, chrome]);

  if (svg === null) {
    return (
      <pre>
        <code className="language-mermaid">{source}</code>
      </pre>
    );
  }
  return (
    <div
      className="md__mermaid"
      // mermaid securityLevel=strict (DOMPurify) 가 출력을 소독한다.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by mermaid strict mode
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** 코드 펜스의 텍스트 — 복사 버튼이 들고 나갈 원본. */
function codeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(codeText).join("");
  if (isValidElement<{ children?: unknown }>(value)) return codeText(value.props.children);
  return "";
}

/**
 * 블록 코드의 `pre`. 자식 코드 펜스가 mermaid 면 다이어그램으로 바꿔 그리고
 * 나머지는 평범한 코드 블록으로 남긴다 — 다만 머리 바를 얹어 복사 버튼과,
 * 내용이 잘려 보일 때만, 전체 보기 토글을 단다. 잘림 판정은 CSS 의
 * max-height(420px)와 같은 숫자다 — 펼친 뒤에도 scrollHeight 로 재면
 * 토글이 사라지므로 고정 상수와 비교한다.
 */
const CODE_FOLD_PX = 420;

function ChatPre({ node: _node, children }: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const child = Array.isArray(children) ? children[0] : children;
  const isMermaid =
    isValidElement<ComponentPropsWithoutRef<"code">>(child) &&
    typeof child.props.className === "string" &&
    child.props.className.split(" ").includes("language-mermaid");
  if (isMermaid && isValidElement<ComponentPropsWithoutRef<"code">>(child)) {
    const source = String(child.props.children ?? "").replace(/\n$/, "");
    return <Mermaid source={source} />;
  }
  const lang = isValidElement<ComponentPropsWithoutRef<"code">>(child)
    ? (/language-(\S+)/.exec(String(child.props.className ?? ""))?.[1] ?? null)
    : null;
  return (
    <CodeBlock lang={lang} source={codeText(child)}>
      {children}
    </CodeBlock>
  );
}

function CodeBlock({
  lang,
  source,
  children,
}: {
  lang: string | null;
  /** 복사가 들고 나갈 코드 원문 — 렌더된 children 과 같은 내용의 문자열. */
  source: string;
  children: ReactNode;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = preRef.current;
    if (el) setTall(el.scrollHeight > CODE_FOLD_PX);
  });
  return (
    <div className={`md__code${open ? " md__code--open" : ""}`}>
      <div className="md__codehead">
        {lang && <span className="md__codelang">{lang}</span>}
        <span className="md__codeacts">
          {tall && (
            <button type="button" className="ghost" onClick={() => setOpen((v) => !v)}>
              {open ? "접기" : "전체 보기"}
            </button>
          )}
          <CopyButton value={source} label="복사" />
        </span>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

/**
 * Renders an assistant message as GitHub-flavored markdown. Styling lives in
 * the `.md` rules in styles.css; the wrapper div keeps `white-space: normal`
 * so streamed prose wraps like a document instead of a pre block. A closed
 * ```mermaid fence becomes a diagram (Mermaid); anything else stays a code
 * block.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ChatLink, pre: ChatPre }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
