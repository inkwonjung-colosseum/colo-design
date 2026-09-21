/**
 * Machine-authored turns, marked so the transcript can render them as cards
 * (PLAN D9).
 *
 * Some turns in a planner's chat are not typed by the planner: a bundle of
 * comment pins, the brief that opens a 화면 thread, a failed gate handed back
 * to Claude, a preview error the planner asked Claude to fix. Their text is
 * written for Claude — CSS
 * paths, file paths, command output — and a planner reading their own chat
 * should not meet any of it.
 *
 * The turn carries a marker on its first line:
 *
 *     <!-- colo-design:comments {"screen":"member/MemberList",…} -->
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

import type { DeveloperReview } from "./repo.js";

type TurnMarkerKind = "comments" | "brief" | "gate" | "error" | "review";

/**
 * How the preview failed: the page threw, or the dev build serving it did.
 * D89 adds `look` — no error at all, just a screen the planner cannot
 * describe in words (흰 화면 · 무한 로딩 · 통째로 깨진 레이아웃), shown to
 * Claude whole (`이 화면 Claude 에게 보여 주기`).
 */
type ErrorMarkerKind = "runtime" | "build" | "look";

const KINDS: readonly TurnMarkerKind[] = ["comments", "brief", "gate", "error", "review"];

/** One pinned element, as the card lists it. */
export interface CommentMarkerItem {
  /**
   * The pin's overlay UUID (커미티 2차 판정 5) — the same key the tray row,
   * the badge and the store row carry, so a card row can be joined back to
   * the pin that made it. Absent on markers written before the field.
   */
  id?: string;
  /** What the planner clicked, in words: the element's own text or its name. */
  label: string;
  comment: string;
  /**
   * Whether this pin's crop travelled with the turn (D87). The view skips a
   * crop it cannot take — an element scrolled out of the viewport, a capture
   * that came back empty — so the images are a SUBSET of the items, and the
   * card needs this flag to put each thumbnail back on its own row. Absent
   * on markers written before the flag existed; the card falls back to
   * position for those.
   */
  shot?: true;
  /**
   * The screen THIS pin sat on (재설계 C6) — one batch may span screens, and
   * the card suffixes the row when the marker's screen is only the summary
   * word (화면 N곳). Absent on older markers, whose batch was one screen.
   */
  screen?: string;
  /**
   * What the planner asked OF this pin (재설계 C10): a change (default —
   * absent reads as `change`, and older markers carry no intent) or a
   * question. The card titles the mix; the turn words each row.
   */
  intent?: "change" | "question";
}

interface CommentsMarker {
  kind: "comments";
  /** The screen title — or `화면 N곳` when one batch spans several. */
  screen: string;
  items: CommentMarkerItem[];
  /** The planner's own sentence on the turn (재설계 C2); absent when they sent pins alone. */
  note?: string;
}

/**
 * The pins' crops, back on the rows that asked for them. D87 sends the
 * images as a flat list and the view photographs only what it can reach — an
 * element scrolled out of the frame, a capture that came back empty, nothing
 * past the sixth — so `thumbs[i]` is not item `i`, and lining them up by
 * position would file one request's picture under another's.
 *
 * A marker written before the flag existed carries none at all: those meant
 * position, so position is what they get.
 */
export function alignThumbs(items: CommentMarkerItem[], thumbs?: string[]): Array<string | null> {
  if (!thumbs || thumbs.length === 0) return items.map(() => null);
  if (!items.some((item) => item.shot)) return items.map((_, index) => thumbs[index] ?? null);
  let next = 0;
  return items.map((item) => (item.shot ? (thumbs[next++] ?? null) : null));
}

interface BriefMarker {
  kind: "brief";
  /** The thread's title, as the tree shows it. */
  title: string;
  /**
   * D94: the connection-preparation brief — the card reads 연결 준비 instead
   * of the 화면 만들기 wording. "refresh" reads 최신 변경 받아오기: the record a
   * 최신화 leaves when it actually merged the developer's base.
   */
  purpose?: "bootstrap" | "refresh" | "conventions";
}

interface GateMarker {
  kind: "gate";
  /** The step that failed, in the planner's own words ("저장한 내용 올리기"). */
  step: string;
}

export interface ErrorMarker {
  kind: "error";
  /** The route that was up when the preview failed. */
  route: string;
  /**
   * Runtime exception, dev build failure, or the D89 `look` (a screen with
   * nothing wrong the console can name). The PLAN writes this payload key
   * as `kind` — which is the marker's own discriminant here — so `hydrate`
   * reads both spellings; `markTurn` emits `errorKind`.
   */
  errorKind: ErrorMarkerKind;
  /**
   * D89: how many times the SAME ask has gone up — the same route
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
interface ReviewMarker {
  kind: "review";
  pr: number;
  author: string;
  path?: string;
  /**
   * E3: 첫 코멘트의 GitHub id — 카드의 답하기가 이 스레드로 간다. 묶음에
   * 여러 코멘트가 섞여 있으면 첫 스레드가 대표다(나머지는 상태 확인
   * 패널에서 각자 답한다). 옛 턴에는 없다 — 카드는 답하기 없이 읽는 자리.
   */
  id?: number;
}

export type TurnMarker = CommentsMarker | BriefMarker | GateMarker | ErrorMarker | ReviewMarker;

interface MarkedTurn {
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
const MARKER = /^<!--\s*colo-design:([a-z]+)\s+(\{[^\n]*\})\s*-->\n?/;

function isKind(value: string): value is TurnMarkerKind {
  return (KINDS as readonly string[]).includes(value);
}

/**
 * Prefix `body` with its marker. The body is unchanged — whatever Claude was
 * going to read, it still reads.
 */
export function markTurn(marker: TurnMarker, body: string): string {
  const { kind, ...data } = marker;
  return `<!-- colo-design:${kind} ${JSON.stringify(data)} -->\n${body}`;
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
        ...(data.note ? { note: str(data.note) } : {}),
        items: data.items.flatMap((entry): CommentMarkerItem[] => {
          if (!entry || typeof entry !== "object") return [];
          const row = entry as Record<string, unknown>;
          return [
            {
              ...(row.id ? { id: str(row.id) } : {}),
              label: str(row.label),
              comment: str(row.comment),
              ...(row.shot === true ? { shot: true as const } : {}),
              ...(row.screen ? { screen: str(row.screen) } : {}),
              ...(row.intent === "question" ? { intent: "question" as const } : {}),
            },
          ];
        }),
      };
    }
    case "brief":
      return {
        kind,
        title: str(data.title),
        ...(data.purpose === "bootstrap" ||
        data.purpose === "refresh" ||
        data.purpose === "conventions"
          ? { purpose: data.purpose }
          : {}),
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
        ...(Number.isFinite(Number(data.id)) ? { id: Number(data.id) } : {}),
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

/**
 * 고치기 의 턴 (D88): the bundled developer comments, as the agent should
 * read them. The marker keeps one author and one path for the card; the body
 * carries every comment's words. 프로토콜에 사는 이유 (슬라이스 2, 2026-09-19):
 * 데몬이 폴링에서 스스로 이 턴을 내려놓는다 — 웹이 아닌 쪽에서도 같은 문장이
 * 나와야 화면의 카드와 데몬의 턴이 어긋나지 않는다.
 */
export function reviewToTurn(reviews: DeveloperReview[]): string {
  const first = reviews[0];
  const marker: TurnMarker = {
    kind: "review",
    pr: first?.pr ?? 0,
    author: first?.author ?? "",
    ...(first?.path ? { path: first.path } : {}),
    ...(first ? { id: first.id } : {}),
  };
  const lines = [
    `개발자 코멘트 ${reviews.length}건에 답합니다 — 아래 코멘트를 반영해 화면을 고쳐 주세요.`,
    "",
    ...reviews.map((review, index) => {
      const at = review.path ? `${review.path}${review.line ? `:${review.line}` : ""}` : "";
      return `${index + 1}. ${review.author}${at ? ` (${at})` : ""}: ${review.body}`;
    }),
  ];
  return markTurn(marker, lines.join("\n"));
}
