import { type CSSProperties, useEffect, useState } from "react";
import { TOAST_MS } from "../lib/use-shell-nav";

/** 나가는 애니메이션의 길이 — ui.css 의 `nx-toast-out` 과 같은 값. */
const LEAVE_MS = 220;

/**
 * 셸의 토스트 — 위에서 튕기며 내려앉고, 머무는 동안 아래 막대가 닳고, 사라질 때는
 * 흐려지며 올라간다. 글이 null 이 돼도 나가는 동안은 마지막 글을 붙들고 있는다.
 * 글이 바뀌면 `key` 가 새 토스트로 다시 내려앉힌다.
 */
export function Toast({ text }: { text: string | null }) {
  const [shown, setShown] = useState(text);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (text) {
      setShown(text);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = setTimeout(() => setShown(null), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  if (!shown) return null;
  return (
    <div
      key={shown}
      className={`nx-toast${leaving ? " nx-toast--out" : ""}`}
      role="status"
      style={{ "--nx-toast-ms": `${TOAST_MS}ms` } as CSSProperties}
    >
      <span className="nx-toast-text">{shown}</span>
      <span className="nx-toast-bar" aria-hidden />
    </div>
  );
}
