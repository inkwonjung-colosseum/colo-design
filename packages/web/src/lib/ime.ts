import type { KeyboardEvent } from "react";

/**
 * True while an IME owns the keydown.
 *
 * A composing IME takes every key until the composition ends — Enter commits
 * the hangul, the arrows walk the candidate window. A handler that reacts to
 * those sends half a word, renames on a syllable, or yanks the candidate list
 * away. `isComposing` is the modern signal; `keyCode === 229` is the legacy
 * one some IMEs still report alone, so both are read.
 */
export function composing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
