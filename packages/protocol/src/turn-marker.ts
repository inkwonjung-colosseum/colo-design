/**
 * Machine-authored turns, marked so the transcript can render them as cards
 * (PLAN D9).
 *
 * Some turns in a planner's chat are not typed by the planner: a bundle of
 * comment pins, the brief that opens a 화면 thread, a 기획서 comparison, a
 * failed gate handed back to Claude, a preview error the planner asked
 * Claude to fix. Their text is written for Claude — CSS
 * paths, file paths, command output — and a planner reading their own chat
 * should not meet any of it.
 *
 * The turn carries a marker on its first line:
 *
 *     <!-- cds-design:comments {"screen":"member/MemberList",…} -->
 *     화면 수정 요청 2건 — …
 *
 * An HTML comment, because it has to survive three trips without a sidecar to
 * keep in sync: Claude reads the turn as prose and ignores it, the SDK stores
 * the text verbatim, and a resumed transcript replays the same string — so the
 * same card comes back on reload, with nothing to migrate.
 *
 * The marker carries what the CARD shows and the body carries what CLAUDE
 * reads. They overlap on purpose: a card that re-parsed the body would break
 * silently the day someone reworded the body, and the body is Claude's input,
 * not a data structure.
 */

export type TurnMarkerKind =
  | "comments"
  | "brief"
  | "precheck"
  | "gate"
  | "error"
  | "review";

/**
 * How the preview failed: the page threw, or the dev build serving it did.
 * D89 adds `look` — no error at all, just a screen the planner cannot
 * describe in words (흰 화면 · 무한 로딩 · 통째로 깨진 레이아웃), shown to
 * Claude whole (`이 화면 Claude 에게 보여 주기`).
 */
export type ErrorMarkerKind = "runtime" | "build" | "look";

const KINDS: readonly TurnMarkerKind[] = [
  "comments",
  "brief",
  "precheck",
  "gate",
  "error",
  "review",
];

/** One pinned element, as the card lists it. */
export interface CommentMarkerItem {
  /** What the planner clicked, in words: the element's own text or its name. */
  label: string;
  comment: string;
}

export interface CommentsMarker {
  kind: "comments";
  screen: string;
  state: string;
  items: CommentMarkerItem[];
}

export interface BriefMarker {
  kind: "brief";
  /** The 기획서 title, as the tree shows it. */
  title: string;
  /**
   * D94: the connection-preparation brief — the card reads 연결 준비 instead
   * of the 기획서 wording.
   */
  purpose?: "bootstrap";
}

export interface PrecheckMarker {
  kind: "precheck";
  title: string;
  /** Screen titles the check was asked about; empty means none exist yet. */
  screens: string[];
}

export interface GateMarker {
  kind: "gate";
  /** The step that failed, in the planner's own words ("저장 전 검사"). */
  step: string;
}

export interface ErrorMarker {
  kind: "error";
  /** The route that was up when the preview failed. */
  route: string;
  /** The state the screen was showing. */
  state: string;
  /**
   * Runtime exception, dev build failure, or the D89 `look` (a screen with
   * nothing wrong the console can name). The PLAN writes this payload key
   * as `kind` — which is the marker's own discriminant here — so `hydrate`
   * reads both spellings; `markTurn` emits `errorKind`.
   */
  errorKind: ErrorMarkerKind;
  /**
   * D89: how many times the SAME ask has gone up — the same route·state
   * (`look`) or the same banner message (runtime/build). 2 이상이면 카드가
   * `두 번째 요청` / `아직 같은 오류 · N번째` 를 말해 같은 버튼 연타를
   * 가린다. The count lives with the web (화면이 바뀌면 0).
   */
  count?: number;
}

/**
 * D88: one bundled bundle of developer comments handed to Claude (고치기).
 * `path` is the developer's own location word — the card keeps it out of the
 * first line and behind 자세히 (D37·D38).
 */
export interface ReviewMarker {
  kind: "review";
  pr: number;
  author: string;
  path?: string;
}

export type TurnMarker =
  | CommentsMarker
  | BriefMarker
  | PrecheckMarker
  | GateMarker
  | ErrorMarker
  | ReviewMarker;

export interface MarkedTurn {
  /** Null when this is an ordinary typed message. */
  marker: TurnMarker | null;
  /** The turn without its marker line — what a card's 자세히 fold shows. */
  body: string;
}

/**
 * Anchored at the start, non-greedy to the first `-->`: a marker is the first
 * line or it is not a marker. A turn whose BODY happens to contain the string
 * must not be reinterpreted from the middle.
 */
const MARKER = /^<!--\s*cds-design:([a-z]+)\s+(\{[^\n]*\})\s*-->\n?/;

function isKind(value: string): value is TurnMarkerKind {
  return (KINDS as readonly string[]).includes(value);
}

/**
 * Prefix `body` with its marker. The body is unchanged — whatever Claude was
 * going to read, it still reads.
 */
export function markTurn(marker: TurnMarker, body: string): string {
  const { kind, ...data } = marker;
  return `<!-- cds-design:${kind} ${JSON.stringify(data)} -->\n${body}`;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Rebuild the marker from its JSON, field by field. A marker written by an
 * older build (or hand-edited) must degrade to a card with blanks rather than
 * throw inside a transcript render — but a marker whose SHAPE is wrong is not
 * a marker, and the raw turn is the honest fallback for that.
 */
function hydrate(kind: TurnMarkerKind, data: Record<string, unknown>): TurnMarker | null {
  switch (kind) {
    case "comments": {
      if (!Array.isArray(data.items)) return null;
      return {
        kind,
        screen: str(data.screen),
        state: str(data.state),
        items: data.items.flatMap((entry): CommentMarkerItem[] =>
          entry && typeof entry === "object"
            ? [
                {
                  label: str((entry as Record<string, unknown>).label),
                  comment: str((entry as Record<string, unknown>).comment),
                },
              ]
            : [],
        ),
      };
    }
    case "brief":
      return {
        kind,
        title: str(data.title),
        ...(data.purpose === "bootstrap" ? { purpose: "bootstrap" as const } : {}),
      };
    case "precheck":
      return {
        kind,
        title: str(data.title),
        screens: Array.isArray(data.screens) ? data.screens.map((entry) => str(entry)) : [],
      };
    case "gate":
      return { kind, step: str(data.step) };
    case "review": {
      const pr = Number(data.pr);
      const marker: ReviewMarker = {
        kind,
        pr: Number.isFinite(pr) ? pr : 0,
        author: str(data.author),
        ...(data.path ? { path: str(data.path) } : {}),
      };
      return marker;
    }
    case "error": {
      // The PLAN's literal spelling names the failure `kind` — the tag
      // already said "error", so the payload key is free to mean the failure
      // sort. An unknown or missing one degrades to runtime: a card with a
      // plausible failure beats no card at all.
      const errorKind = str(data.errorKind) || str(data.kind);
      return {
        kind,
        route: str(data.route),
        state: str(data.state),
        errorKind: errorKind === "build" ? "build" : errorKind === "look" ? "look" : "runtime",
        ...(typeof data.count === "number" && data.count > 1 ? { count: data.count } : {}),
      };
    }
  }
}

/**
 * Split a stored turn into its marker and its body.
 *
 * Anything that is not a marker we can read — no marker, an unknown kind,
 * broken JSON, the wrong shape — comes back as the original text with no
 * marker. Showing the raw turn is worse than a card; inventing a card out of
 * something we could not parse is worse than both.
 */
export function readTurn(text: string): MarkedTurn {
  const match = MARKER.exec(text);
  const kind = match?.[1];
  const json = match?.[2];
  if (!match || !kind || !json || !isKind(kind)) return { marker: null, body: text };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { marker: null, body: text };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { marker: null, body: text };
  }

  const marker = hydrate(kind, parsed as Record<string, unknown>);
  if (!marker) return { marker: null, body: text };
  return { marker, body: text.slice(match[0].length) };
}
