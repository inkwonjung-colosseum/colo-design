import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders an assistant message as GitHub-flavored markdown. Styling lives in
 * the `.md` rules in styles.css; the wrapper div keeps `white-space: normal`
 * so streamed prose wraps like a document instead of a pre block.
 */

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
    <a href={href} target="_blank" rel="noreferrer" {...rest}>
      {children}
    </a>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ChatLink }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
