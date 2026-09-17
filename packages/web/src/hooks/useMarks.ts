import type { ColoDesignPinsSync, ColoDesignScreen } from "@colo-design/protocol";
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Daemon } from "../lib/daemon-client";
import type { PinAttachment, Pins } from "./usePins";

/**
 * 고침 표시 레지스트리 (preview.md §1-C) — 한 사이클의 마크 번호 단일 원천.
 *
 * 핀의 생애가 곧 마크의 생애다: 트레이에 있는 동안 `live`(accent 배지),
 * 턴이 실어 가면 `ghost`(회색), 턴이 끝나면 `intent:"change"` 핀만 `done`
 * (초록 실선)으로 남는다 — 질문 핀은 고침 표시가 아니라 물음이었으므로 마크를
 * 남기지 않는다. 핀이 가리키지 않은 바뀐 화면은 `screen` 마크가 보완한다.
 *
 * 번호는 사이클 안에서 1부터 단조 증가하고, 보낸 핀은 트레이 번호를 그대로
 * 계승한다(③으로 보냈으면 done 도 ③) — 대화 속 ③④⑤⑥ 참조와 배지가 1:1 로
 * 맞는다. 보내기 전에 지운 핀의 번호만 다음 핀이 물려받는다 — 그 번호를
 * 실은 말은 어디에도 없으므로. 크로스 슬라이스 계약: PinTray 는
 * `MarksContext` 로, 대화의 핀 참조는 `markNumberFor` 로 같은 번호를 읽는다.
 *
 * 진실은 모듈의 slug 별 store 에 있다 — 훅은 구독자일 뿐이라, 레지스트리를
 * 읽는 또 다른 소비자(대화 슬라이스)가 훅 없이도 같은 번호에 닿는다.
 */

/** 마크의 자리 — 핀에서 온 세 상태와, 요소 앵커 없는 화면 마크. */
type MarkStatus = "live" | "ghost" | "done" | "screen";

export interface MarkRecord {
  id: string;
  /** 사이클 안의 번호 — 보낸 마크는 지키고, 보내기 전 지워진 자리는 다음 핀이 물려받는다. */
  n: number;
  status: MarkStatus;
  intent: "change" | "question";
  /** The overlay's screen naming — `data-screen`, no leading slash. */
  screen: string;
  state: string;
  /** "" on a screen mark — there is no element to re-anchor on. */
  path: string;
  rect?: { x: number; y: number; width: number; height: number };
}

interface MarkStore {
  records: Map<string, MarkRecord>;
  /** The next number this cycle hands out — reclaimed to max+1 when a mark leaves. */
  next: number;
  version: number;
  listeners: Set<() => void>;
}

/** One project's marks live under one sessionStorage key — pins' own rule. */
const MARKS_KEY_PREFIX = "colo-design.marks.";
const stores = new Map<string, MarkStore>();

function loadMarks(slug: string): { records: MarkRecord[]; next: number } {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(`${MARKS_KEY_PREFIX}${slug}`) ?? "");
    if (typeof parsed !== "object" || parsed === null) return { records: [], next: 1 };
    const { records } = parsed as { records?: unknown };
    const list = (Array.isArray(records) ? records : []).filter(
      (row): row is MarkRecord =>
        typeof row === "object" &&
        row !== null &&
        typeof (row as MarkRecord).id === "string" &&
        typeof (row as MarkRecord).n === "number" &&
        typeof (row as MarkRecord).screen === "string",
    );
    // 리로드는 턴의 끝이다 (usePins 의 고스트 규칙과 같다): 돌아온 창에
    // live·ghost 자리는 없으므로 수정 핀은 done 으로, 질문 핀은 지운다.
    const settled = list.flatMap((row) =>
      row.status === "live" || row.status === "ghost"
        ? row.intent === "change"
          ? [{ ...row, status: "done" as const }]
          : []
        : [row],
    );
    // 번호는 살아 있는 마크에서 다시 센다 — 지워진 핀의 자리는 다음 핀이
    // 물려받고, 남은 done·화면 마크 위로만 이어 간다.
    return { records: settled, next: Math.max(0, ...settled.map((row) => row.n)) + 1 };
  } catch {
    return { records: [], next: 1 };
  }
}

function storeFor(slug: string): MarkStore {
  let store = stores.get(slug);
  if (!store) {
    const loaded = loadMarks(slug);
    store = {
      records: new Map(loaded.records.map((record) => [record.id, record])),
      next: loaded.next,
      version: 0,
      listeners: new Set(),
    };
    stores.set(slug, store);
  }
  return store;
}

function notify(slug: string, store: MarkStore): void {
  store.version += 1;
  try {
    sessionStorage.setItem(
      `${MARKS_KEY_PREFIX}${slug}`,
      JSON.stringify({ next: store.next, records: [...store.records.values()] }),
    );
  } catch {
    // Quota or private mode: marks stay in memory, they just do not survive a reload.
  }
  for (const listener of store.listeners) listener();
}

/**
 * The pins' truth → the registry's truth. A pin that left the tray was either
 * deleted before sending (its number returns to the pool — no turn ever
 * carried it) or carried off by a turn (ghost); a ghost that vanished settled
 * with the turn, and a 수정 ghost settles as a done mark. Screen marks cover
 * changed screens no pin names.
 */
export function reconcile(
  slug: string,
  list: PinAttachment[],
  ghosts: PinAttachment[],
  changedScreens: Set<string>,
  screens: ColoDesignScreen[],
): void {
  const store = storeFor(slug);
  const live = new Map(list.map((pin) => [pin.id, pin]));
  const ghostById = new Map(ghosts.map((pin) => [pin.id, pin]));
  let touched = false;

  const ensure = (pin: PinAttachment, status: "live" | "ghost") => {
    let record = store.records.get(pin.id);
    if (!record) {
      record = {
        id: pin.id,
        n: store.next++,
        status,
        intent: pin.intent,
        screen: pin.screen,
        state: pin.state,
        path: pin.element.path,
        ...(pin.element.kind === "region" ? { rect: pin.element.rect } : {}),
      };
      store.records.set(record.id, record);
      touched = true;
    }
    // The tray's 수정 ↔ 질문 chip can rewrite intent mid-life — a pin
    // flipped to 질문 before sending must not settle as a done mark.
    if (record.status !== status || record.intent !== pin.intent) {
      record.status = status;
      record.intent = pin.intent;
      touched = true;
    }
  };
  // 먼저 사라진 마크를 가라앉힌다 — 지워진 핀의 번호가 같은 패스에 도착한
  // 핀에게로 곧장 돌아갈 수 있게.
  for (const record of [...store.records.values()]) {
    if (record.status !== "live" && record.status !== "ghost") continue;
    if (live.has(record.id) || ghostById.has(record.id)) continue;
    if (record.status === "ghost" && record.intent === "change") {
      record.status = "done";
    } else {
      store.records.delete(record.id);
    }
    touched = true;
  }

  // 지워진 자리는 다음 핀이 물려받는다 — 화면에 남은 마크의 최대 번호
  // 위로만 이어 간다.
  store.next = Math.max(0, ...[...store.records.values()].map((record) => record.n)) + 1;

  for (const pin of list) ensure(pin, "live");
  for (const pin of ghosts) ensure(pin, "ghost");

  // 화면 마크: 핀이 가리키지 않은 바뀐 화면. 같은 화면을 고치라는 핀이
  // 이미 있으면(살아 있든 done 이든) 화면 마크는 중복이라 두지 않는다 —
  // 뒤늦게 찍힌 핀이 화면 마크를 덮어쓰는 것도 같은 규칙이다.
  const covered = new Set(
    [...store.records.values()]
      .filter((record) => record.status !== "screen" && record.intent === "change")
      .map((record) => record.screen),
  );
  for (const route of changedScreens) {
    const screen = route.replace(/^\/+/, "");
    const prefix = `screen:${screen}@`;
    const existing = [...store.records.keys()].filter((id) => id.startsWith(prefix));
    if (covered.has(screen)) {
      for (const id of existing) store.records.delete(id);
      if (existing.length > 0) touched = true;
      continue;
    }
    if (existing.length > 0) continue;
    const declared = screens.find((entry) => entry.route === route);
    const states = declared && declared.states.length > 0 ? declared.states : ["default"];
    // 한 화면 = 한 번호: 상태마다 같은 n 을 단다 — 오버레이는 상태별로
    // 한 칸씩 그리고, 대화의 참조는 그 번호 하나를 가리킨다.
    const n = store.next++;
    for (const state of states) {
      store.records.set(`${prefix}${state}`, {
        id: `${prefix}${state}`,
        n,
        status: "screen",
        intent: "change",
        screen,
        state,
        path: "",
      });
    }
    touched = true;
  }

  if (touched) notify(slug, store);
}

/**
 * diff 경로 → 바뀐 화면 추정 (preview.md §3 `pendingScreens` 의 웹측 근사 —
 * 데몬의 필드가 오면 이 함수만 갈아 끼운다). 파일 바로 위 폴더와 선언 화면
 * route 의 첫 세그먼트가 만나는 곳.
 * 하나도 못 맞추면 빈 셋: 추정이 틀릴 바엔 없는 게 낫다.
 */
function screensOfFiles(files: Array<{ path: string }>, screens: ColoDesignScreen[]): Set<string> {
  const routes = new Set<string>();
  for (const file of files) {
    const segments = file.path.split("/");
    const folder = segments.length >= 2 ? segments[segments.length - 2] : null;
    if (!folder) continue;
    for (const screen of screens) {
      const first = screen.route.replace(/^\/+/, "").split("/")[0];
      if (first && first === folder) routes.add(screen.route);
    }
  }
  return routes;
}

function buildSync(store: MarkStore, marksOn: boolean): ColoDesignPinsSync {
  return {
    pins: [...store.records.values()]
      // 고침 표시 토글은 done·화면 마크만 숨긴다 — 라이브 핀과 고스트는
      // 핀 모드의 것이라 그대로다 (목업 nohl 과 같은 의미).
      .filter((record) => record.status === "live" || record.status === "ghost" || marksOn)
      .map((record) => ({
        id: record.id,
        screen: record.screen,
        state: record.state,
        path: record.path,
        sent: record.status !== "live",
        n: record.n,
        tone:
          record.status === "live"
            ? ("live" as const)
            : record.status === "ghost"
              ? ("sent" as const)
              : ("done" as const),
        ...(record.status === "screen" ? { screenMark: true as const } : {}),
        ...(record.rect ? { rect: record.rect } : {}),
      })),
  };
}

/**
 * 크로스 슬라이스 계약 (preview.md §1-C): 대화 속 ③④⑤⑥ 참조가 읽는 단일
 * 원천. 훅을 거치지 않는 읽기 — 보내는 순간의 번호면 충분하다.
 */
export function markNumberFor(slug: string, pinId: string): number | null {
  return stores.get(slug)?.records.get(pinId)?.n ?? null;
}

/** PinTray 가 번호를 읽는 문 — PageWorkspace 가 레지스트리의 답을 채운다. */
export const MarksContext = createContext<(id: string) => number | null>(() => null);

/**
 * The marks of one project: the overlay's `pinsSync` projection plus the
 * numbering the tray and the conversation read. `pendingChanges === null`
 * means the repo has not reported yet — the reset rule stays disarmed until
 * the daemon's first word, so a booting window cannot wipe restored marks.
 */
export function useMarks({
  slug,
  pins,
  api,
  screens,
  pendingChanges,
  branch,
  marksOn,
}: {
  slug: string | null;
  pins: Pins;
  api: Daemon["api"];
  screens: ColoDesignScreen[];
  /** null until the daemon has reported — as good as "unknown". */
  pendingChanges: number | null;
  /** This cycle's `colo-design/…` branch — null before the first 저장. */
  branch: string | null;
  /** 고침 표시 토글 — done·화면 마크만 거른다. */
  marksOn: boolean;
}): { sync: ColoDesignPinsSync; numberFor: (id: string) => number | null } {
  const store = slug ? storeFor(slug) : null;
  /**
   * 바뀐 화면 추정치 — 사이클 안에서 누적한다(마크의 수명이 사이클 리셋
   * 까지이므로). `pendingChanges` 는 턴이 멈추거나 저장이 끝날 때만 움직이므로
   * 그 변화가 곧 "한 번 읽어라"는 신호다 — 도는 중간에는 읽지 않는다.
   */
  const [changedScreens, setChangedScreens] = useState<Set<string>>(new Set());
  const screensRef = useRef(screens);
  screensRef.current = screens;
  const [loadedSlug, setLoadedSlug] = useState(slug);
  if (loadedSlug !== slug) {
    setLoadedSlug(slug);
    setChangedScreens(new Set());
  }

  // 사이클 리셋: 저장할 것도 사이클 브랜치도 없으면 남은 마크는 지난
  // 사이클의 것이다 — 버리기·치워두기·반영 착지가 모두 이 자리로 온다.
  useEffect(() => {
    if (!slug || pendingChanges === null) return;
    if (pendingChanges !== 0 || branch !== null) return;
    const current = storeFor(slug);
    if (current.records.size === 0) return;
    current.records.clear();
    current.next = 1;
    notify(slug, current);
    setChangedScreens(new Set());
  }, [slug, pendingChanges, branch]);

  useEffect(() => {
    if (!slug || !pendingChanges) return;
    let stale = false;
    void api
      .diff()
      .then((files) => {
        if (stale) return;
        const routes = screensOfFiles(files, screensRef.current);
        if (routes.size === 0) return;
        setChangedScreens((prev) => {
          const next = new Set(prev);
          for (const route of routes) next.add(route);
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [slug, pendingChanges, api]);

  useEffect(() => {
    if (!slug) return;
    reconcile(slug, pins.list, pins.ghosts, changedScreens, screens);
  }, [slug, pins.list, pins.ghosts, changedScreens, screens]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!store) return () => {};
      store.listeners.add(onChange);
      return () => store.listeners.delete(onChange);
    },
    [store],
  );
  const version = useSyncExternalStore(subscribe, () => store?.version ?? 0);

  const sync = useMemo(
    // biome-ignore lint/correctness/useExhaustiveDependencies: version is the
    // store's change counter — the memo must rebuild when it ticks.
    () => (store ? buildSync(store, marksOn) : { pins: [] }),
    [store, version, marksOn],
  );
  const numberFor = useCallback((id: string) => store?.records.get(id)?.n ?? null, [store]);
  return { sync, numberFor };
}
