/**
 * The machine turns the preview column composes (ex `ScreenPanel` tail) —
 * pure functions, each one a structured Korean turn Claude reads and the
 * transcript renders back as the marker card it carries (PLAN D9).
 */
import type {
  ColoDesignCommentsEnvelope,
  DeveloperReview,
  TurnMarker,
} from "@colo-design/protocol";
import { markTurn } from "@colo-design/protocol";
import { stateLabel } from "./format";
import type { PreviewError } from "./PreviewHost";

/**
 * 고치기 의 턴 (PLAN D88): the bundled developer comments, as Claude should
 * read them. The marker keeps one author and one path for the card; the body
 * carries every comment's words.
 */
export function reviewToTurn(reviews: DeveloperReview[]): string {
  const first = reviews[0];
  const marker: TurnMarker = {
    kind: "review",
    pr: first?.pr ?? 0,
    author: first?.author ?? "",
    ...(first?.path ? { path: first.path } : {}),
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

/**
 * The structured turn: readable Korean first, machine shape in a json fence,
 * and a marker so the planner's own chat shows what they asked for rather
 * than the CSS paths Claude needs (PLAN D9).
 *
 * `screenTitle` is what the repo called the screen; the envelope only carries
 * its route-shaped id, and a card is the wrong place to meet one.
 */
export function commentsToTurn(envelope: ColoDesignCommentsEnvelope, screenTitle: string): string {
  const marker: TurnMarker = {
    kind: "comments",
    screen: screenTitle,
    state: stateLabel(envelope.state),
    items: envelope.items.map((item) => ({
      // The element's own text is what the planner clicked and recognises;
      // its component name is the fallback nobody should normally read.
      label: item.element.text || item.element.component,
      comment: item.comment,
      // D87: remember which pins actually carried a crop, so the card can
      // put each image back on its own row later.
      ...(item.shot ? { shot: true as const } : {}),
    })),
  };
  const lines = [
    `화면 수정 요청 ${envelope.items.length}건 — ${envelope.screen} (${envelope.state} 상태)`,
    "미리보기에서 핀으로 찍은 요소들입니다. 화면을 고친 뒤 다시 보여 주세요.",
    "",
  ];
  envelope.items.forEach((item, index) => {
    const target = item.element;
    lines.push(
      `${index + 1}. ${target.component}${target.text ? ` — "${target.text}"` : ""}`,
      `   요청: ${item.comment}`,
      `   위치: ${target.path} (rect ${target.rect.x},${target.rect.y} ${target.rect.width}×${target.rect.height})`,
      "",
    );
  });
  lines.push("```json", JSON.stringify(envelope, null, 2), "```");
  return markTurn(marker, lines.join("\n"));
}

/**
 * The error banner's structured turn (PLAN D49): the marker names where it
 * happened, and the body is the message itself — the stack or build output
 * is what Claude fixes from; prose around it would only be in the way.
 * `count` marks the same message coming back after a fix turn (D89).
 */
export function errorToTurn(error: PreviewError, count = 1): string {
  const marker: TurnMarker = {
    kind: "error",
    route: error.route,
    state: error.state,
    errorKind: error.kind,
    ...(count > 1 ? { count } : {}),
  };
  return markTurn(marker, error.message);
}

/**
 * 화면 보여 주기 (D89): the screen Claude cannot be told about in words.
 * The body carries the planner's sentence and the console tail; the picture
 * rides as the turn's image, not in the text.
 */
export function lookToTurn(route: string, state: string, body: string, count = 1): string {
  const marker: TurnMarker = {
    kind: "error",
    route,
    state,
    errorKind: "look",
    ...(count > 1 ? { count } : {}),
  };
  return markTurn(marker, body);
}
