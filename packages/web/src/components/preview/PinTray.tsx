import { useEffect, useRef, useState } from "react";
import type { PinAttachment, PinIntent } from "../../hooks/usePins";
import { composing } from "../../lib/ime";
import { ChevronDownIcon } from "../icons";
import { Tip } from "../shell/Tip";

/**
 * The composer's pin tray: one row per pin — the number the
 * overlay's badge wears, the crop the view took at pin time, the
 * element's own words, and the memo that rides the turn. The tray only
 * stacks and annotates: 전송은 컴포저의 몫이다.
 */
export function PinTray({
  pins,
  numberStart = 1,
  focusPinId,
  onPinRemove,
  onPinNote,
  onPinIntent,
  onPinFocus,
  titleFor,
  fold,
}: {
  pins: PinAttachment[];
  /**
   * The first number the rows wear — the badge order
   * counts the turn's grey ghosts first, so the tray starts after them and
   * one number means one pin on every surface that wears numbers. Defaults
   * to 1: the dev harness and a fresh composer have no ghosts.
   */
  numberStart?: number;
  /** 배지 클릭이 흔든 상태 — 그 행의 메모 입력으로 포커스가 간다. */
  focusPinId?: { id: string; nonce: number } | null;
  onPinRemove: (id: string) => void;
  onPinNote: (id: string, note: string) => void;
  /** 수정 ↔ 질문 칩 — the turn's wording and card title read it. */
  onPinIntent: (id: string, intent: PinIntent) => void;
  /** 행 클릭 — 오버레이의 배지를 깜빡여 그 핀을 다시 가리킨다. */
  onPinFocus: (id: string) => void;
  /** 화면 id → 제목. 못 찾으면 null — 원 id 로 읽는다. */
  titleFor: (screen: string) => string | null;
  /**
   * 접개 — 목록이 필드를 누르기 전에 접는 손. 건네지 않으면 트레이는
   * 늘 펼쳐 있다. 접힌 동안에는 머리의 숫자만 말한다.
   */
  fold?: { folded: boolean; onToggle: () => void };
}) {
  // 배지 → 메모 입력의 다리. PinTray 의 행은 지워졌다 붙을 수 있어서
  // index 가 아니라 pin id 로 찾는다.
  const noteInputs = useRef(new Map<string, HTMLInputElement>());
  /** 모두 지우기의 두 번 누르기 — 첫 클릭이 묻고, 3초 안의 두 번째가 지운다. */
  const [clearArmed, setClearArmed] = useState(false);
  /** 접개의 최신 값 — 효과의 재실행 조건은 focusPinId 하나로 좁힌다. */
  const foldRef = useRef(fold);
  foldRef.current = fold;
  useEffect(() => {
    if (!focusPinId) return;
    // 접힌 트레이에는 행이 없어 포커스가 빗나간다 — 먼저 펼치고, 행이 그려진
    // 뒤(다음 프레임) 입력으로 간다.
    const foldNow = foldRef.current;
    if (foldNow?.folded) foldNow.onToggle();
    const frame = requestAnimationFrame(() => {
      noteInputs.current.get(focusPinId.id)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusPinId]);
  // 행 번호는 트레이 순서 그대로다.

  const screens = new Set(pins.map((pin) => pin.screen));
  const first = pins[0]!;
  const head =
    screens.size > 1
      ? `핀 ${pins.length}개 · 화면 ${screens.size}곳`
      : `핀 ${pins.length}개 · ${titleFor(first.screen) ?? first.screen}`;

  return (
    <div className="pintray">
      <div className="pintray__head">
        <span className="pintray__title">{head}</span>
        {/* 되돌리기 없다 — 핀은 다시 찍는 게 더 싸다. 그래도 전체를 한
            클릭에 버리지는 않는다: 첫 클릭이 묻고, 3초 안의 두 번째가 지운다.
            묻는 쪽이 유예를 말한다. 라벨이 바뀌는 것도 낭독기에 닿는다 —
            live 칸은 늘 있는 것이어야 소식이 되므로 span 이 몸이다. */}
        <button
          type="button"
          className="ghost pintray__clear"
          onClick={() => {
            if (clearArmed) {
              setClearArmed(false);
              pins.forEach((pin) => void onPinRemove(pin.id));
            } else {
              setClearArmed(true);
              window.setTimeout(() => setClearArmed(false), 3000);
            }
          }}
        >
          <span aria-live="polite">{clearArmed ? "다시 누르면 모두 지웁니다" : "모두 지우기"}</span>
        </button>
        {fold && (
          <button
            type="button"
            className="ghost pintray__fold"
            aria-expanded={!fold.folded}
            aria-label={fold.folded ? "핀 목록 펼치기" : "핀 목록 접기"}
            onClick={fold.onToggle}
          >
            <ChevronDownIcon />
          </button>
        )}
      </div>
      {!fold?.folded && (
        <ul className="pintray__list">
          {pins.map((pin, index) => {
            const n = numberStart + index;
            return (
              <li key={pin.id} className="pintray__row">
                {/* 행의 몸통은 버튼이다 — 배지 가리키기가 포인터의 전유물이지
                    않게. 의도 칩·메모·지우기는 각자의 손으로 남는다. */}
                <button
                  type="button"
                  className="pintray__focusbtn"
                  aria-label={`${n}번 핀을 화면에서 가리키기`}
                  onClick={() => onPinFocus(pin.id)}
                >
                  <span className="pintray__num" aria-hidden="true">
                    {n}
                  </span>
                  {pin.shot ? (
                    <img
                      className="pintray__thumb"
                      src={`data:${pin.shot.mediaType};base64,${pin.shot.data}`}
                      alt=""
                    />
                  ) : pin.element.kind === "region" ? (
                    // 영역 핀 — 찍은 좌표가 있을 뿐 요소는 없다. 점선
                    // 사각이 그 경계를, 라벨이 그 크기를 말한다.
                    <span className="pintray__thumb pintray__thumb--region" aria-hidden="true" />
                  ) : (
                    <span className="pintray__thumb pintray__thumb--empty" aria-hidden="true">
                      —
                    </span>
                  )}
                  <span className="pintray__what">
                    <span className="pintray__label">
                      {pin.element.kind === "region"
                        ? `영역 ${pin.element.rect.width}×${pin.element.rect.height}`
                        : pin.element.text || pin.element.component}
                    </span>
                    <span className="pintray__where">{titleFor(pin.screen) ?? pin.screen}</span>
                  </span>
                </button>
                {/* 이 핀이 바라는 것: 고치라는 말인가, 설명을 원하는 말인가. */}
                <span className="pintray__intent" aria-label={`${n}번 핀 의도`} role="group">
                  <Tip label="이 요소를 고쳐 달라는 핀입니다">
                    <button
                      type="button"
                      className="pintray__intentbtn"
                      aria-pressed={pin.intent !== "question"}
                      onClick={() => onPinIntent(pin.id, "change")}
                    >
                      수정
                    </button>
                  </Tip>
                  <Tip label="이 요소가 왜 이런지 묻는 핀입니다">
                    <button
                      type="button"
                      className="pintray__intentbtn"
                      aria-pressed={pin.intent === "question"}
                      onClick={() => onPinIntent(pin.id, "question")}
                    >
                      질문
                    </button>
                  </Tip>
                </span>
                <input
                  className="pintray__note"
                  type="text"
                  placeholder="이 요소에 바라는 점 (선택)"
                  value={pin.note}
                  ref={(el) => {
                    if (el) noteInputs.current.set(pin.id, el);
                    else noteInputs.current.delete(pin.id);
                  }}
                  onChange={(event) => onPinNote(pin.id, event.target.value)}
                  onKeyDown={(event) => {
                    if (composing(event)) return;
                    if (event.key !== "Enter") return;
                    // 전송 아님 — 메모를 붙이고 이벤트를 삼킨다. 본문으로의
                    // 포커스 이동은 Composer 가 capture 에서 한다.
                    event.preventDefault();
                    event.stopPropagation();
                    onPinNote(pin.id, event.currentTarget.value);
                  }}
                />
                <Tip label={`${n}번 핀 지우기`}>
                  <button
                    type="button"
                    className="ghost"
                    aria-label={`${n}번 핀 지우기`}
                    onClick={() => onPinRemove(pin.id)}
                  >
                    ×
                  </button>
                </Tip>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
