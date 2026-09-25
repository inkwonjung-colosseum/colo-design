import type {
  ColoDesignCommentTarget,
  ColoDesignPinEnvelope,
  ColoDesignPinsSync,
} from "@colo-design/protocol";
import { useEffect, useState } from "react";
import type { Daemon } from "../lib/daemon-client";

export interface PinAttachment {
  id: string;
  /** The screen the pin sat on, as the overlay's envelope named it. */
  screen: string;
  /* 2026-09-21 상태 축 철거 — 표식(state) 필드는 이 자리에 있었다. */
  /* 2026-09-21 레포 마커 철거 — pagePath 필드는 이 자리에 있었다
     (screen 이 항상 경로 신원이 되며 폐지). */
  element: ColoDesignCommentTarget;
  /** The crop the view took at pin time — "what the planner saw". */
  shot?: { mediaType: string; data: string };
  /** The planner's optional memo on this one element; the turn's sentence does not live here. */
  note: string;
}

/** The pin state of one project, as every reader consumes it. */
export interface Pins {
  list: PinAttachment[];
  /**
   * 회색 배지: the batch the last send carried off, kept only
   * for the turn's life so its badges keep their numbers in grey while the
   * pins behind them stay put. Not stored — a refresh ends them.
   */
  ghosts: PinAttachment[];
  /** A pin lands from the overlay; a repeated id is the same pin, ignored. */
  add(pin: ColoDesignPinEnvelope["pin"]): void;
  remove(id: string): void;
  setNote(id: string, note: string): void;
  clear(): void;
  /**
   * After the turn left: record the pins and take them off the tray —
   * success or not. A failed record only leaves the store short; the turn has
   * already gone out, so holding the pins hostage to the store would protect
   * nothing (the delivery-first rule the old batch path lived by).
   * The failure itself is NOT silent: `recordError` carries it to the screen
   * panel's warning band — the store's one reader
   * is the pull request body, and the planner must learn that this cycle's
   * `### 수정 요청` will be missing the rows they just sent.
   * Each row carries the pin's own id, and its memo verbatim —
   * empty when none was written.
   */
  markSent(sent: PinAttachment[]): Promise<void>;
  /** The turn ended — the grey badges go with it. */
  dismissGhosts(): void;
  /** The last record round trip's failure, verbatim — null while healthy. */
  recordError: string | null;
}
/** One project's pins live under one sessionStorage key. */
const PINS_KEY_PREFIX = "colo-design.pins.";
/**
 * The 7th pin onward keeps its crop out of storage: six crops × ~40KB is
 * what sessionStorage wants to hold, and six is also the turn's image cap —
 * a stored-but-unsent shot would never ride anywhere anyway.
 */
const SHOT_STORE_MAX = 6;
/**
 * The overlay's projection: ghosts first — the grey
 * numbers hold the front so the pins behind them keep their numbers while
 * the turn runs — then the live list. Region pins carry their page rect:
 * they have no path for the overlay to re-anchor on. The reactive effect in
 * `usePins` and PreviewFrame's after-navigation resend both send THIS shape.
 */
export function pinsSync(ghosts: PinAttachment[], list: PinAttachment[]): ColoDesignPinsSync {
  // PLAN-UI U4: tone · n 을 채운다 — 보낸 핀은 턴 동안 회색(sent), 번호는 말풍선 ·
  // 입력창 칩과 같은 자리 번호(고스트 먼저, 그다음 살아 있는 목록).
  const row = (
    pin: PinAttachment,
    sent: boolean,
    n: number,
  ): ColoDesignPinsSync["pins"][number] => ({
    id: pin.id,
    screen: pin.screen,
    path: pin.element.path,
    sent,
    tone: sent ? "sent" : "live",
    n,
    ...(pin.element.kind === "region" ? { rect: pin.element.rect } : {}),
  });
  return {
    pins: [
      ...ghosts.map((ghost, index) => row(ghost, true, index + 1)),
      ...list.map((pin, index) => row(pin, false, ghosts.length + index + 1)),
    ],
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
          // 2026-09-21 상태 축 철거 — 옛 저장 행이 실어 온 state 키는 필요
          // 필드가 아니므로 그냥 딸려올 뿐(무시된다), 검사에는 없다.
          typeof (row as PinAttachment).element === "object" &&
          (row as PinAttachment).element !== null,
      )
      .map((row) => ({
        ...row,
        note: row.note ?? "",
      }));
  } catch {
    return [];
  }
}

/**
 * One project's pins. ChatColumn sends them (`pinsToTurn`),
 * same list — pins outlive screens, routes and reloads.
 */
export function usePins(slug: string | null, api: Daemon["api"]): Pins {
  const [list, setList] = useState<PinAttachment[]>([]);
  // 회색 배지의 원본 — the batch the last send carried off.
  // Lives in memory only: it belongs to a running turn, and a refresh ends
  // the turn as surely as it ends the page.
  const [ghosts, setGhosts] = useState<PinAttachment[]>([]);
  // The record round trip's voice: null while healthy, the
  // failure verbatim when the store refused — ScreenPanel shows it in the
  // screen column's warning band.
  const [recordError, setRecordError] = useState<string | null>(null);

  const [loadedSlug, setLoadedSlug] = useState(slug);
  if (loadedSlug !== slug) {
    setLoadedSlug(slug);
    setList(slug ? loadPins(slug) : []);
    setGhosts([]);
    // 이전 프로젝트의 기록 실패가 새 프로젝트의 경고 띠를 누르지 않게 —
    // 실패는 프로젝트 스코프다.
    setRecordError(null);
  }

  // Every change is written back, crops included up to the sixth pin;
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
  const add = (pin: ColoDesignPinEnvelope["pin"]) => {
    setList((current) =>
      current.some((row) => row.id === pin.id) ? current : [...current, { ...pin, note: "" }],
    );
  };

  const remove = (id: string) => {
    setList((current) => current.filter((row) => row.id !== id));
  };

  const setNote = (id: string, note: string) => {
    setList((current) => current.map((row) => (row.id === id ? { ...row, note } : row)));
  };
  const markSent = async (sent: PinAttachment[]): Promise<void> => {
    // The tray empties FIRST (자동 정리): the turn is out, and a
    // record round trip that waits behind the running turn must not leave
    // sent pins sitting on the screen.
    setList((current) => current.filter((pin) => !sent.some((sentPin) => sentPin.id === pin.id)));
    // The grey badges: the batch stays visible — sent semantics,
    // shot intact — until the turn ends and PageWorkspace calls dismissGhosts.
    setGhosts((current) => [...current, ...sent]);
    // A memo-less pin records an EMPTY text — the PR body
    // draws (메모 없음). Borrowing the turn's sentence made one sentence
    // count N times in the PR body the developer reads.
    try {
      await api.recordComments({
        items: sent.map((pin) => ({
          // The pin's own key rides along: the store row
          // meets the tray row, the badge and the card on the same id.
          id: pin.id,
          screen: pin.screen,
          text: pin.note.trim(),
          elementText: pin.element.text || pin.element.component,
          element: {
            component: pin.element.component,
            path: pin.element.path,
            rect: pin.element.rect,
          },
        })),
      });
      setRecordError(null);
    } catch (e) {
      // 기록 실패는 침묵하지 않는다 — 턴은 이미 나갔다(전달 우선). 이 사이클의
      // 핀들은 개발자가 읽을 `### 수정 요청` 에서 빠진다; 대화에 남은 말은
      // 그대로이므로 AI 는 이미 들었다.
      setRecordError(
        e instanceof Error && e.message
          ? `코멘트 기록을 저장하지 못했습니다 — ${e.message}. 요청은 그대로 갔어요 — 개발자에게 보낼 기록에만 남지 않아요`
          : "코멘트 기록을 저장하지 못했습니다 — 요청은 그대로 갔어요 — 개발자에게 보낼 기록에만 남지 않아요",
      );
    }
  };

  const clear = () => setList([]);

  // The turn is over — 성공이든 실패든 — and the grey badges go with it.
  // No resolved-state is kept: a sent pin is history, and the
  // conversation is where that history is read.
  const dismissGhosts = () => setGhosts([]);

  return {
    list,
    ghosts,
    add,
    remove,
    setNote,
    clear,
    markSent,
    dismissGhosts,
    recordError,
  };
}
