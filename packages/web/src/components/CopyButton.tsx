import { type ReactNode, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";
import { Tip } from "./shell/Tip";

/**
 * The one copy button. Five screens had each grown their own
 * copied-state and reset dance; the words and the timing live here now.
 * `icon` swaps the idle glyph (a link, for example); `null` drops it, for the
 * rows that read as text links rather than buttons. `className` keeps a
 * caller's own placement class on the button. An empty `label` drops the
 * word — the glyph carries the button alone then, so `ariaLabel` names it
 * (and `doneLabel` still says the copy happened, to tip and reader alike).
 */
export function CopyButton({
  value,
  label = "복사",
  doneLabel = "복사됨",
  icon,
  className = "ghost",
  ariaLabel,
}: {
  value: string;
  label?: string;
  doneLabel?: string;
  icon?: ReactNode | null;
  className?: string;
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the text is visible to retype anyway.
    }
  };
  return (
    <Tip label={copied ? doneLabel : (ariaLabel ?? label)}>
      <button
        type="button"
        className={className}
        aria-label={copied ? doneLabel : (ariaLabel ?? label)}
        onClick={() => void copy()}
      >
        {icon === null ? null : copied ? <CheckIcon size={11} /> : (icon ?? <CopyIcon size={12} />)}
        {label !== "" && (copied ? doneLabel : label)}
      </button>
    </Tip>
  );
}
