/**
 * One Paseo-style selector chip with its dropdown (ex `Composer`), plus the
 * Korean names for the commands a planner meets often enough to deserve one.
 * Options arrive pre-shaped; picked rows carry a check, hints ride on the
 * right.
 */
import { useEffect, useRef } from "react";
import type { SessionCommand } from "@cds-design/protocol";
import { CheckIcon, ChevronDownIcon } from "./icons";

/**
 * The few commands a planner meets often enough to deserve Korean names.
 * Every command the CLI advertises shows — the terminal's `/`, translated
 * only where the translation earns its place.
 */
export const COMMAND_LABEL: Record<string, { label: string; hint: string }> = {
  clear: { label: "대화 새로 시작", hint: "지금까지 대화를 지우고 처음부터 이야기해요" },
  compact: { label: "대화 정리", hint: "길어진 대화를 요약해서 이어가요" },
  usage: { label: "사용량 보기", hint: "5시간·주간 한도를 얼마나 썼는지 알려줘요" },
  context: { label: "대화 길이 보기", hint: "지금 대화가 얼마나 찼는지 알려줘요" },
};

/**
 * The palette reads the CLI, which answers only once a thread exists — and an
 * empty thread is exactly where a planner reaches for `/`. These four stand
 * in until a real answer lands, so the first keystroke still offers something
 * true.
 */
export const COMMAND_FALLBACK: SessionCommand[] = Object.keys(COMMAND_LABEL).map((name) => ({
  name,
  description: "",
  argumentHint: "",
  aliases: [],
}));

export function SelectorChip({
  label,
  prefix,
  open,
  disabled,
  title,
  onToggle,
  onClose,
  onPick,
  options,
}: {
  label: string;
  /** The chip's domain in one word ("모델"), so two chips that both default
      to 자동 never read as one control drawn twice. */
  prefix?: string;
  open: boolean;
  disabled?: boolean;
  title?: string;
  onToggle: () => void;
  onClose: () => void;
  onPick: (value: string | null) => void;
  options: Array<{ value: string | null; label: string; hint?: string; picked: boolean }>;
}) {
  const chip = useRef<HTMLButtonElement>(null);

  // Escape closes — the one dismissal a keyboard-only planner will try first.
  // Focus returns to the chip, so the next Tab keeps going from where it was.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        chip.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <span className="selector">
      {open && <button type="button" className="selector__backdrop" aria-label="선택 닫기" onClick={onClose} />}
      <button
        ref={chip}
        type="button"
        className="selector__chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={onToggle}
      >
        {prefix && <span className="selector__chipprefix">{prefix} ·</span>}
        {label}
        <ChevronDownIcon size={10} />
      </button>
      {open && (
        <span className="selector__menu" role="listbox">
          {options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              role="option"
              aria-selected={option.picked}
              className="selector__row"
              onClick={() => onPick(option.value)}
            >
              <span className="selector__check">{option.picked ? <CheckIcon size={11} /> : null}</span>
              <span className="selector__label">{option.label}</span>
              {option.hint && <span className="selector__hint">{option.hint}</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
