/**
 * One selector chip with its dropdown (ex `Composer`), plus the Korean names
 * for the commands a planner meets often enough to deserve one. Options arrive
 * pre-shaped: a name, and — where the provider itself says more — a muted
 * secondary text. The menu still teaches nothing: a hint only ever carries
 * what the row IS (omp's `provider/id`), never what picking it costs.
 */

import type { SessionCommand } from "@colo-design/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { composing } from "../../lib/ime";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "../icons";
import { Tip } from "../shell/Tip";

/**
 * 이 줄부터 메뉴가 찾기 필드를 얻는다. 모델 목록은 CLI 가 주는 그대로라
 * 열 개를 훌쩍 넘기도 하고(omp 카탈로그), 스크롤만으로는 고를 수가 없다.
 * 노력·확인 방식 같은 짧은 메뉴는 그대로 — 찾기가 할 일이 없는 자리에
 * 필드를 놓지 않는다.
 */
const SEARCH_MIN_ROWS = 9;

/**
 * The few commands a planner meets often enough to deserve Korean names.
 * Every command the CLI advertises shows — the terminal's `/`, translated
 * only where the translation earns its place.
 */
export const COMMAND_LABEL: Record<string, { label: string; hint: string }> = {
  clear: {
    label: "대화 새로 시작",
    hint: "지금까지 대화를 지우고 처음부터 이야기해요",
  },
  compact: { label: "대화 정리", hint: "길어진 대화를 요약해서 이어가요" },
  usage: {
    label: "사용량 보기",
    hint: "5시간·주간 한도를 얼마나 썼는지 알려줘요",
  },
  context: {
    label: "대화 길이 보기",
    hint: "지금 대화가 얼마나 찼는지 알려줘요",
  },
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
  icon,
  open,
  disabled,
  tip,
  onToggle,
  onClose,
  onPick,
  options,
  header,
  levelKey,
  alwaysSearch = false,
}: {
  label: string;
  /** The glyph for what this chip governs. It leads, so two chips that both
      read 자동 are still told apart at a glance — without a word spent. */
  icon?: ReactNode;
  open: boolean;
  disabled?: boolean;
  /** What the chip governs, said on hover. Suppressed while its own menu is
      open — the menu is the explanation then. */
  tip?: string;
  onToggle: () => void;
  onClose: () => void;
  onPick: (value: string | null) => void;
  options: Array<{
    value: string | null;
    label: string;
    hint?: string;
    picked: boolean;
    /** A row the planner may read but not pick — an agent this machine lacks. */
    disabled?: boolean;
  }>;
  /**
   * 드릴다운 헤더 — 메뉴 카드 최상단의 한 줄(← 뒤로가기·⚙ 같은 자리).
   * 열려 있을 때만 목록 위에 그려진다.
   */
  header?: ReactNode;
  /**
   * 메뉴 안의 단계 (모델 ↔ 에이전트). 바뀌는 순간 찾기·강조를 리셋한다 —
   * 이전 단계에서 반쯤 친 검색어가 다음 단계의 목록에 남으면 안 된다.
   */
  levelKey?: string;
  /** 행이 적어도 찾기 필드를 내는 칩 — 통합 모델 메뉴는 늘 검색부터 보여 준다. */
  alwaysSearch?: boolean;
}) {
  const chip = useRef<HTMLButtonElement>(null);
  const searchable = alwaysSearch || options.length >= SEARCH_MIN_ROWS;
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLSpanElement>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  // 메뉴가 열릴 때마다 새 필드 — 이전에 반쯤 친 검색어가 다음 열림에
  // 남아 있으면, 지금 고르려는 것과 다른 목록을 보여 준다.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    if (searchable) search.current?.focus();
  }, [open, searchable]);

  // 단계가 바뀔 때도 같은 리셋 — 모델 목록에서 친 찾기가 에이전트 목록을
  // 그대로 걸러 버리는 일이 없게.
  useEffect(() => {
    setQuery("");
    setHighlight(0);
  }, [levelKey]);

  // 찾기는 행이 말하는 것으로만: 이름과, 모델 행이라면 오른쪽 가장자리의
  // 공급자·id. 대소문자는 잡아 주되 그 이상의 지능은 없다 — 팔레트와 같은
  // 걸음이다.
  const needle = query.trim().toLowerCase();
  const rows =
    searchable && needle
      ? options.filter(
          (option) =>
            option.label.toLowerCase().includes(needle) ||
            (option.hint ?? "").toLowerCase().includes(needle),
        )
      : options;
  // 줄어든 목록이 끝을 지나쳐도 강조가 남지 않게.
  const at = Math.min(highlight, Math.max(0, rows.length - 1));
  useEffect(() => {
    if (!open || !searchable) return;
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, searchable, at]);
  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Composition keys pass straight through: Enter would run a half-typed
    // search and the arrows would yank the IME's candidate list.
    if (composing(event)) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight(Math.min(at + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(Math.max(at - 1, 0));
    } else if (event.key === "Enter" && rows[at] && !rows[at].disabled) {
      event.preventDefault();
      onPick(rows[at].value);
    }
  };

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
      {open && (
        <button
          type="button"
          className="selector__backdrop"
          aria-label="선택 닫기"
          onClick={onClose}
        />
      )}
      <Tip label={open ? undefined : tip} side="bottom">
        <button
          ref={chip}
          type="button"
          className="selector__chip"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={onToggle}
        >
          {icon && <span className="selector__chipicon">{icon}</span>}
          {label}
          <ChevronDownIcon size={10} />
        </button>
      </Tip>
      {open && searchable && (
        <span className="selector__menu selector__menu--search">
          {header && <div className="selector__head">{header}</div>}
          <span className="selector__searchrow">
            <SearchIcon size={13} />
            <input
              ref={search}
              className="selector__search"
              value={query}
              placeholder="찾기…"
              aria-label="목록에서 찾기"
              role="combobox"
              aria-expanded="true"
              aria-controls="selector-list"
              aria-activedescendant={rows[at] ? `selector-opt-${at}` : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onSearchKey}
            />
          </span>
          <span className="selector__list" role="listbox" id="selector-list" ref={list}>
            {rows.length === 0 && (
              <span className="menuempty">
                <span className="ic">
                  <SearchIcon size={13} />
                </span>
                <span>
                  {needle
                    ? `'${query.trim()}'와 맞는 것이 없습니다.`
                    : "아직 목록이 비어 있습니다."}
                </span>
              </span>
            )}
            {rows.map((option, index) => (
              <button
                key={String(option.value)}
                id={`selector-opt-${index}`}
                data-index={index}
                type="button"
                role="option"
                aria-selected={option.picked}
                disabled={option.disabled}
                className={`selector__row${index === at ? " selector__row--on" : ""}${
                  option.hint ? " selector__row--hint" : ""
                }`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => onPick(option.value)}
              >
                <span className="selector__check">
                  {option.picked ? <CheckIcon size={11} /> : null}
                </span>
                <span className="selector__label">{option.label}</span>
                {option.hint && <span className="selector__hint">{option.hint}</span>}
              </button>
            ))}
          </span>
        </span>
      )}
      {open && !searchable && (
        <span className="selector__menu" role="listbox">
          {header && <div className="selector__head">{header}</div>}
          {options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              role="option"
              aria-selected={option.picked}
              disabled={option.disabled}
              className={`selector__row${option.hint ? " selector__row--hint" : ""}`}
              onClick={() => onPick(option.value)}
            >
              <span className="selector__check">
                {option.picked ? <CheckIcon size={11} /> : null}
              </span>
              <span className="selector__label">{option.label}</span>
              {option.hint && <span className="selector__hint">{option.hint}</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
