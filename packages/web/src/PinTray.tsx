import { useEffect, useRef } from "react";
import { stateLabel } from "./format";
import type { PinAttachment, PinIntent } from "./usePins";

/**
 * The composer's pin tray (재설계 C1): one row per pin — the number the
 * overlay's badge wears, the crop the view took at pin time (C4), the
 * element's own words, and the memo that rides the turn. The tray only
 * stacks and annotates: 전송은 컴포저의 몫이다 (C2).
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
}: {
  pins: PinAttachment[];
  /**
   * The first number the rows wear (커미티 2차 판정 2) — the badge order
   * counts the turn's grey ghosts first, so the tray starts after them and
   * one number means one pin on every surface that wears numbers. Defaults
   * to 1: the dev harness and a fresh composer have no ghosts.
   */
  numberStart?: number;
  /** 배지 클릭이 흔든 상태 — 그 행의 메모 입력으로 포커스가 간다. */
  focusPinId?: { id: string; nonce: number } | null;
  onPinRemove: (id: string) => void;
  onPinNote: (id: string, note: string) => void;
  /** 수정 ↔ 질문 칩 (재설계 C10) — the turn's wording and card title read it. */
  onPinIntent: (id: string, intent: PinIntent) => void;
  /** 행 클릭 — 오버레이의 배지를 깜빡여 그 핀을 다시 가리킨다. */
  onPinFocus: (id: string) => void;
  /** 화면 id → 제목. 못 찾으면 null — 원 id 로 읽는다. */
  titleFor: (screen: string) => string | null;
}) {
  // 배지 → 메모 입력의 다리. PinTray 의 행은 지워졌다 붙을 수 있어서
  // index 가 아니라 pin id 로 찾는다.
  const noteInputs = useRef(new Map<string, HTMLInputElement>());
  useEffect(() => {
    if (!focusPinId) return;
    noteInputs.current.get(focusPinId.id)?.focus();
  }, [focusPinId]);

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
        {/* 되돌리기 없다 (재설계 §3.9) — 핀은 다시 찍는 게 더 싸다. */}
        <button
          type="button"
          className="ghost pintray__clear"
          onClick={() => pins.forEach((pin) => void onPinRemove(pin.id))}
        >
          모두 지우기
        </button>
      </div>
      <ul className="pintray__list">
        {pins.map((pin, index) => (
          <li
            key={pin.id}
            className="pintray__row"
            onClick={(event) => {
              // 메모 입력과 × 의 클릭은 그것 자체의 동작이다 — 나머지는 배지를 가리킨다.
              if ((event.target as HTMLElement).closest("input, button")) return;
              onPinFocus(pin.id);
            }}
          >
            <span className="pintray__num" aria-hidden="true">
              {numberStart + index}
            </span>
            {pin.shot ? (
              <img
                className="pintray__thumb"
                src={`data:${pin.shot.mediaType};base64,${pin.shot.data}`}
                alt=""
              />
            ) : pin.element.kind === "region" ? (
              // 영역 핀 (재설계 C9) — 찍은 좌표가 있을 뿐 요소는 없다. 점선
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
              <span className="pintray__where">
                {/* 레포가 새긴 출처 (재설계 C8) — path:line 의 파일 부분만 회색으로. */}
                {pin.element.source && (
                  <span className="pintray__source">{pin.element.source.replace(/:\d+$/, "")}</span>
                )}
                {titleFor(pin.screen) ?? pin.screen} · {stateLabel(pin.state)}
              </span>
            </span>
            {/* 이 핀이 바라는 것 (재설계 C10): 고치라는 말인가, 설명을 원하는 말인가. */}
            <span
              className="pintray__intent"
              role="group"
              aria-label={`${numberStart + index}번 핀 의도`}
            >
              <button
                type="button"
                className="pintray__intentbtn"
                aria-pressed={pin.intent !== "question"}
                onClick={() => onPinIntent(pin.id, "change")}
              >
                수정
              </button>
              <button
                type="button"
                className="pintray__intentbtn"
                aria-pressed={pin.intent === "question"}
                onClick={() => onPinIntent(pin.id, "question")}
              >
                질문
              </button>
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
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key !== "Enter") return;
                // 전송 아님 — 메모를 붙이고 이벤트를 삼킨다. 본문으로의
                // 포커스 이동은 Composer 가 capture 에서 한다.
                event.preventDefault();
                event.stopPropagation();
                onPinNote(pin.id, event.currentTarget.value);
              }}
            />
            <button
              type="button"
              className="ghost"
              aria-label={`${numberStart + index}번 핀 지우기`}
              onClick={() => onPinRemove(pin.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
