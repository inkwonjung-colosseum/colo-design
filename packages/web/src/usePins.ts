import type {
  ColoDesignCommentTarget,
  ColoDesignPinEnvelope,
  ColoDesignPinsSync,
} from "@colo-design/protocol";
import { useEffect, useState } from "react";
import type { Daemon } from "./daemon-client";

/** What the planner asked of a pin (재설계 C10): have it changed, or have it explained. */
export type PinIntent = "change" | "question";

export interface PinAttachment {
  id: string;
  /** The screen the pin sat on, as the overlay's envelope named it. */
  screen: string;
  state: string;
  element: ColoDesignCommentTarget;
  /** The crop the view took at pin time (C4) — "what the planner saw". */
  shot?: { mediaType: string; data: string };
  /** The planner's optional memo on this one element; the turn's sentence does not live here. */
  note: string;
  /** 수정인가 질문인가 (재설계 C10) — the turn's guide line and card title read it. */
  intent: PinIntent;
}

/** The pin state of one project, as every reader consumes it. */
export interface Pins {
  list: PinAttachment[];
  /**
   * 회색 배지 (재설계 C10): the batch the last send carried off, kept only
   * for the turn's life so its badges keep their numbers in grey while the
   * pins behind them stay put. Not stored — a refresh ends them.
   */
  ghosts: PinAttachment[];
  /** A pin lands from the overlay; a repeated id is the same pin, ignored. */
  add(pin: ColoDesignPinEnvelope["pin"]): void;
  remove(id: string): void;
  setNote(id: string, note: string): void;
  /** 수정 ↔ 질문 (재설계 C10) — the tray's toggle chip writes here. */
  setIntent(id: string, intent: PinIntent): void;
  clear(): void;
  /**
   * After the turn left (C2): record the pins and take them off the tray —
   * success or not. A failed record only leaves the log stale; the turn has
   * already gone out, so holding the pins hostage to the store would protect
   * nothing (the delivery-first rule the old batch path lived by).
   * The failure itself is NOT silent: `recordError` carries it to the same
   * warning band the list's own read failures use (커미티 차단 3, 2026-09-14)
   * — the planner must learn why the log is missing rows they just sent.
   * Each row carries the pin's own id and intent, and its memo verbatim —
   * empty when none was written (커미티 2차 판정 3·4·5).
   */
  markSent(sent: PinAttachment[]): Promise<void>;
  /** The turn ended — the grey badges go with it (재설계 C10). */
  dismissGhosts(): void;
  /** How many times the recorded log's input moved — ScreenPanel's refreshComments trigger. */
  version: number;
  /**
   * The last record round trip's failure, verbatim — null while healthy.
   * `version` moves only on success, so a stale log never masquerades as a
   * fresh one (커미티 차단 3: "보냄"의 목소리).
   */
  recordError: string | null;
}
/** One project's pins live under one sessionStorage key (재설계 C5). */
const PINS_KEY_PREFIX = "colo-design.pins.";
/**
 * The 7th pin onward keeps its crop out of storage: six crops × ~40KB is
 * what sessionStorage wants to hold, and six is also the turn's image cap —
 * a stored-but-unsent shot would never ride anywhere anyway (계획 §7).
 */
const SHOT_STORE_MAX = 6;
/**
 * The overlay's projection (재설계 C1·C9·C10): ghosts first — the grey
 * numbers hold the front so the pins behind them keep their numbers while
 * the turn runs — then the live list. Region pins carry their page rect:
 * they have no path for the overlay to re-anchor on. The reactive effect in
 * `usePins` and NativeHost's after-navigation resend both send THIS shape.
 */
export function pinsSync(ghosts: PinAttachment[], list: PinAttachment[]): ColoDesignPinsSync {
  const row = (pin: PinAttachment, sent: boolean): ColoDesignPinsSync["pins"][number] => ({
    id: pin.id,
    screen: pin.screen,
    state: pin.state,
    path: pin.element.path,
    sent,
    ...(pin.element.kind === "region" ? { rect: pin.element.rect } : {}),
  });
  return {
    pins: [...ghosts.map((ghost) => row(ghost, true)), ...list.map((pin) => row(pin, false))],
  };
}

function loadPins(slug: string): PinAttachment[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(`${PINS_KEY_PREFIX}${slug}`) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (row): row is PinAttachment =>
          typeof row === "object" &&
          row !== null &&
          typeof (row as PinAttachment).id === "string" &&
          typeof (row as PinAttachment).screen === "string" &&
          typeof (row as PinAttachment).state === "string" &&
          typeof (row as PinAttachment).element === "object" &&
          (row as PinAttachment).element !== null,
      )
      .map((row) => ({
        ...row,
        note: row.note ?? "",
        // 옛 저장 분엔 intent 가 없다 — 없던 시절의 핀은 전부 수정이다 (재설계 C10).
        intent: row.intent === "question" ? ("question" as const) : ("change" as const),
      }));
  } catch {
    return [];
  }
}

/**
 * One project's pins (재설계 C1). ChatColumn sends them (`pinsToTurn`),
 * same list — pins outlive screens, routes and reloads (C5).
 */
export function usePins(slug: string | null, api: Daemon["api"]): Pins {
  const [list, setList] = useState<PinAttachment[]>([]);
  // 회색 배지의 원본 (재설계 C10) — the batch the last send carried off.
  // Lives in memory only: it belongs to a running turn, and a refresh ends
  // the turn as surely as it ends the page (계획 §6).
  const [ghosts, setGhosts] = useState<PinAttachment[]>([]);
  const [version, setVersion] = useState(0);
  // The record round trip's voice (커미티 차단 3): null while healthy, the
  // failure verbatim when the store refused — ScreenPanel shows it through
  // the same band the list's own read failures use.
  const [recordError, setRecordError] = useState<string | null>(null);

  const [loadedSlug, setLoadedSlug] = useState(slug);
  if (loadedSlug !== slug) {
    setLoadedSlug(slug);
    setList(slug ? loadPins(slug) : []);
    setGhosts([]);
  }

  // Every change is written back (C5), crops included up to the sixth pin;
  // a full store fails quietly — the in-memory list still covers the session.
  useEffect(() => {
    if (!slug) return;
    try {
      sessionStorage.setItem(
        `${PINS_KEY_PREFIX}${slug}`,
        JSON.stringify(
          list.map((pin, index) => (index < SHOT_STORE_MAX ? pin : { ...pin, shot: undefined })),
        ),
      );
    } catch {
      // Quota or private mode: pins stay in memory, they just do not survive a reload.
    }
  }, [slug, list]);
  // The overlay's projection (C1), resent on every change and on mount —
  // idempotent, and the badge order IS this order. NativeHost resends the
  // same shape after a navigation (재설계 §3.6).
  useEffect(() => {
    void window.coloDesignDesktop?.preview?.pins?.(pinsSync(ghosts, list));
  }, [list, ghosts]);

  const add = (pin: ColoDesignPinEnvelope["pin"]) => {
    setList((current) =>
      current.some((row) => row.id === pin.id)
        ? current
        : [...current, { ...pin, note: "", intent: "change" as const }],
    );
  };

  const remove = (id: string) => {
    setList((current) => current.filter((row) => row.id !== id));
  };

  const setNote = (id: string, note: string) => {
    setList((current) => current.map((row) => (row.id === id ? { ...row, note } : row)));
  };
  const markSent = async (sent: PinAttachment[]): Promise<void> => {
    // The tray empties FIRST (재설계 C2 — 자동 정리): the turn is out, and a
    // record round trip that waits behind the running turn must not leave
    // sent pins sitting on the screen. The version — the popover's cue to
    // re-read — moves after the store has actually taken the rows.
    setList((current) => current.filter((pin) => !sent.some((sentPin) => sentPin.id === pin.id)));
    // The grey badges (재설계 C10): the batch stays visible — sent semantics,
    // shot intact — until the turn ends and PageWorkspace calls dismissGhosts.
    setGhosts((current) => [...current, ...sent]);
    // A memo-less pin records an EMPTY text (커미티 2차 판정 3) — the display
    // layers draw (메모 없음). Borrowing the turn's sentence made one sentence
    // count N times, in the log and in the PR body the developer reads.
    try {
      await api.recordComments({
        items: sent.map((pin) => ({
          // The pin's own key rides along (커미티 2차 판정 5): the store row
          // meets the tray row, the badge and the card on the same id.
          id: pin.id,
          screen: pin.screen,
          state: pin.state,
          text: pin.note.trim(),
          elementText: pin.element.text || pin.element.component,
          intent: pin.intent,
          element: {
            component: pin.element.component,
            path: pin.element.path,
            rect: pin.element.rect,
          },
        })),
      });
      setRecordError(null);
      // The re-read cue moves ONLY on success (커미티 차단 3): a failed record
      // would otherwise bump the log's freshness while the rows are missing.
      setVersion((v) => v + 1);
    } catch (e) {
      // 기록 실패는 목록을 낡게 두되 침묵하지 않는다 — 턴은 이미 나갔다(전달
      // 우선). The old batch path said this in a toast; the band the list
      // reads through (ScreenPanel's commentsError) says it now.
      setRecordError(
        e instanceof Error && e.message
          ? `코멘트 기록을 저장하지 못했습니다 — ${e.message}`
          : "코멘트 기록을 저장하지 못했습니다 — 목록이 최신이 아닐 수 있습니다",
      );
    }
  };

  // 수정 ↔ 질문 (재설계 C10): the tray's toggle chip, one click either way.
  const setIntent = (id: string, intent: PinIntent) => {
    setList((current) => current.map((row) => (row.id === id ? { ...row, intent } : row)));
  };

  const clear = () => setList([]);

  // The turn is over — 성공이든 실패든 — and the grey badges go with it
  // (재설계 C10). No resolved-state is kept: a sent pin is history, and the
  // record popover is where the past is read.
  const dismissGhosts = () => setGhosts([]);

  return {
    list,
    ghosts,
    add,
    remove,
    setNote,
    setIntent,
    clear,
    markSent,
    dismissGhosts,
    version,
    recordError,
  };
}
