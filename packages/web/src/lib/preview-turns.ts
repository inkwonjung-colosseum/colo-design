/**
 * The machine turns the preview column composes — pure functions, each one
 * a structured Korean turn the agent reads and the transcript renders back as
 * the marker card it carries. 핀 턴은 다음을 따른다:
 * 문장은 컴포저에서 온 노트 하나, 목록은 마커가 실고, json fence 는 없다.
 */
import type { TurnMarker } from "@colo-design/protocol";
import { markTurn } from "@colo-design/protocol";
import type { PreviewError } from "../components/preview/PreviewHost";
import type { PinAttachment } from "../hooks/usePins";

/**
 * 고치기 의 턴은 프로토콜이 조립한다(슬라이스 2) — 데몬의 폴링이 같은 문장을
 * 내려놓기 때문이다. 웹은 이제 부르지 않는다: 고치기의 문은 데몬 하나뿐이다.
 */

/**
 * The pins turn: N pins plus the composer's sentence become
 * ONE turn. The marker carries the card (one screen's title, or 화면 N곳
 * when the batch spans screens); the body is the sentence, one guide
 * line, and one readable block per pin — what was pinned, the repo's own
 * source stamp, the memo, the React owner chain and the CSS path with
 * the pin-time rect, which is all the agent ever needed the json fence
 * for. `titleFor` resolves what the repo called a screen; a screen the
 * registry no longer declares falls back to its raw id.
 */
export function pinsToTurn(
  pins: PinAttachment[],
  note: string,
  titleFor: (screen: string) => string | null,
): string {
  const sentence = note.trim();
  const screens = new Set(pins.map((pin) => pin.screen));
  const spread = screens.size > 1;
  const first = pins[0]!;
  // 영역 핀의 이름표: a region has no words of its own — its
  // size is what the planner recognises.
  const pinLabel = (pin: PinAttachment) =>
    pin.element.kind === "region"
      ? `영역 ${pin.element.rect.width}×${pin.element.rect.height}`
      : pin.element.text || pin.element.component;
  const marker: TurnMarker = {
    kind: "comments",
    screen: spread ? `화면 ${screens.size}곳` : (titleFor(first.screen) ?? first.screen),
    // The element's own text is what the planner clicked and recognises;
    // its component name is the fallback nobody should normally read.
    ...(sentence ? { note: sentence } : {}),
    items: pins.map((pin) => ({
      // The pin's own key: the card row joins back to the
      // tray row, the badge and the store row on the same id.
      id: pin.id,
      label: pinLabel(pin),
      comment: pin.note.trim(),
      // Remember which pins actually carried a crop, so the card can
      // put each image back on its own row later.
      ...(pin.shot ? { shot: true as const } : {}),
      // 여러 화면을 한 턴에 — 행마다 화면을 새긴다; 머리글은 요약일 뿐이다.
      ...(spread ? { screen: titleFor(pin.screen) ?? pin.screen } : {}),
    })),
  };
  const blocks = pins.map((pin, index) => {
    const rows = [
      `${index + 1}. ${pinLabel(pin)}${pin.element.text ? ` — "${pin.element.text}"` : ""}${
        spread ? ` · ${titleFor(pin.screen) ?? pin.screen}` : ""
      }`,
    ];
    if (pin.note.trim()) {
      rows.push(`   ${pin.note.trim()}`);
    }
    // React owner 체인 — dev 빌드에서만 온다.
    if (pin.element.owners?.length) rows.push(`   컴포넌트: ${pin.element.owners.join(" › ")}`);
    if (pin.element.kind === "region") {
      // 영역 핀은 경로가 없다 — 좌표만이 위치다.
      const { x, y, width, height } = pin.element.rect;
      rows.push(`   위치: rect ${x},${y} ${width}×${height}`);
    } else {
      // The agent's anchors on this element, richest first: the runtime CSS
      // path (position facts), the repo's testid (the one hook that maps to
      // source when the path's nth-of-type does not survive a re-render),
      // and the accessible identity the page declares — a missing name on a
      // clickable element is the fix a planner most often pins asking for.
      const rect = pin.element.rect;
      rows.push(
        `   위치: ${pin.element.path} (rect ${rect.x},${rect.y} ${rect.width}×${rect.height})`,
      );
      if (pin.element.attrs?.testId) {
        rows.push(`   셀렉터: [data-testid="${pin.element.attrs.testId}"]`);
      }
      const a11yFacts = [
        ...(pin.element.a11y?.role ? [`role ${pin.element.a11y.role}`] : []),
        ...(pin.element.a11y?.name ? [`이름 "${pin.element.a11y.name}"`] : []),
      ];
      if (a11yFacts.length > 0) rows.push(`   접근성: ${a11yFacts.join(" · ")}`);
    }
    // 계산된 스타일의 일부 — the planner saw these values.
    const styleRows = Object.entries(pin.element.styles ?? {})
      .slice(0, 6)
      .map(([key, value]) => `${key} ${value}`);
    if (styleRows.length > 0) rows.push(`   스타일: ${styleRows.join(" · ")}`);
    // outerHTML — one line; the markup is context, not a file. 500 of the
    // envelope's 1,500: a utility-class tag alone eats the old 200 before
    // the element's own attributes begin.
    if (pin.element.html) {
      rows.push(`   HTML: ${pin.element.html.replace(/\s+/g, " ").trim().slice(0, 500)}`);
    }
    return rows.join("\n");
  });
  const lines = [
    // 문장이 있으면 첫 줄 — 마커의 note 와 같은 말이다.
    ...(sentence ? [sentence, ""] : []),
    "아래는 사용자가 가리킨 자리입니다 — 사용자의 말대로 해 주세요.",
    "",
    blocks.join("\n\n"),
  ];
  return markTurn(marker, lines.join("\n"));
}

/**
 * The error banner's structured turn: the marker names where it
 * happened, and the body is the message itself — the stack or build output
 * is what the agent fixes from; prose around it would only be in the way.
 * `count` marks the same message coming back after a fix turn.
 */
export function errorToTurn(error: PreviewError, count = 1): string {
  const marker: TurnMarker = {
    kind: "error",
    route: error.route,
    errorKind: error.kind,
    ...(count > 1 ? { count } : {}),
  };
  return markTurn(marker, error.message);
}

/**
 * 화면 보여 주기: the screen the agent cannot be told about in words.
 * The body carries the planner's sentence and the console tail; the picture
 * rides as the turn's image, not in the text.
 */
export function lookToTurn(route: string, body: string, count = 1): string {
  const marker: TurnMarker = {
    kind: "error",
    route,
    errorKind: "look",
    ...(count > 1 ? { count } : {}),
  };
  return markTurn(marker, body);
}
