import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { takeFreshKeys } from "./fresh-keys";

/** 등장 표시를 붙들어 두는 시간 — 애니메이션(220ms)이 끝난 뒤에 거둔다. */
const HOLD_MS = 600;

const NONE: ReadonlySet<string> = new Set();

/**
 * 이번 렌더에 새로 들어온 줄의 열쇠 — 그 줄에 등장 클래스를 붙이는 데 쓴다. 처음 그릴
 * 때와 `scope` 가 바뀔 때(프로젝트를 옮길 때)는 이미 있는 줄을 새 것으로 치지 않는다.
 * 표시는 layout effect 에서 세워 첫 그림 전에 붙으므로 줄이 한 프레임 보였다 흐려지는
 * 깜빡임이 없고, 애니메이션이 끝날 만큼 붙들었다가 거둔다.
 */
export function useFreshKeys(keys: readonly string[], scope = ""): ReadonlySet<string> {
  const before = useRef<{ scope: string; keys: ReadonlySet<string> } | null>(null);
  const timers = useRef<number[]>([]);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NONE);
  // 열쇠 배열은 렌더마다 새로 지어지므로 의존성에는 신원 문자열을 둔다.
  const identity = keys.join("\u0000");

  useLayoutEffect(() => {
    const now = identity === "" ? [] : identity.split("\u0000");
    const prior = before.current?.scope === scope ? before.current.keys : null;
    const taken = takeFreshKeys(prior, now);
    before.current = { scope, keys: taken.keys };
    if (taken.fresh.length === 0) return;
    setFresh((old) => new Set([...old, ...taken.fresh]));
    timers.current.push(
      window.setTimeout(() => {
        setFresh((old) => {
          const next = new Set(old);
          for (const key of taken.fresh) next.delete(key);
          return next;
        });
      }, HOLD_MS),
    );
  }, [identity, scope]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);

  return fresh;
}
