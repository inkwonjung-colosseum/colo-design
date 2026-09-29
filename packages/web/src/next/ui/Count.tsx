import { useLayoutEffect, useRef, useState } from "react";

/**
 * 숫자 배지 — 값이 바뀔 때 한 번 튄다(처음 그릴 때는 튀지 않는다). 바뀔 때마다 요소를
 * 새로 세워(key) CSS 애니메이션이 처음부터 다시 돈다. 튐은 layout effect 에서 세우므로
 * 새 숫자가 튀기 전의 모양으로 한 프레임 보이는 깜빡임이 없다.
 */
export function Count({ n, className }: { n: number; className?: string }) {
  const shown = useRef(n);
  const [bumps, setBumps] = useState(0);
  useLayoutEffect(() => {
    if (shown.current === n) return;
    shown.current = n;
    setBumps((count) => count + 1);
  }, [n]);
  const classes = ["nx-cnt", className, bumps > 0 ? "nx-cnt--bump" : ""].filter(Boolean).join(" ");
  return (
    <span key={bumps} className={classes}>
      {n}
    </span>
  );
}
