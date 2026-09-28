/**
 * 옛 localStorage 키의 부팅 이주(RENAME-NOVA-PLAN §7.2 G · §1.2). 기계적
 * 치환으로 앱은 새 `nova-design.*` 키만 읽고 쓰므로, 옛 앱이 창에 남긴
 * `colo-design.*` 값을 첫 Nova 부팅 때 한 번 새 키로 옮긴다. 옛 키는 지우지
 * 않는다 — 되돌려 깐 옛 앱이 자기 저장값을 잃지 않게(쓰기는 nova · 읽기는
 * 둘 다, D-8).
 *
 * DOM 없이 시험되게 저장소를 주입받는다(crash.ts 의 CrashStorage 와 같은
 * 결). 호출은 엔트리(main.tsx)의 맨 위에서 한 번뿐이다.
 */

const LEGACY_PREFIX = "colo-design."; // read-legacy
const NEXT_PREFIX = "nova-design.";

/**
 * `colo-design.*` 키 전부를 같은 접미사의 `nova-design.*` 키로 복사한다.
 * 새 키가 이미 있으면 건드리지 않고(옛 값으로 덮어쓰지 않는다), 옛 키도
 * 지우지 않는다. 복사한 개수를 돌려준다 — 시험이 세는 몸값이다.
 */
export function copyLegacyStorageKeys(
  store: Pick<Storage, "getItem" | "setItem" | "key" | "length">,
): number {
  // 옛 키 목록을 먼저 떼어 낸다 — 복사하며 늘어난 새 키를 다시 세지 않게.
  const legacyKeys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key?.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
  }
  let copied = 0;
  for (const legacyKey of legacyKeys) {
    const nextKey = NEXT_PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
    if (store.getItem(nextKey) !== null) continue; // 새 키가 이미 사는 접미는 넘긴다
    const value = store.getItem(legacyKey);
    if (value === null) continue; // 순회 사이에 사라졌다 — 없었던 것으로 한다
    store.setItem(nextKey, value);
    copied += 1;
  }
  return copied;
}
