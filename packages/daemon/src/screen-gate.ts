import { markTurn } from "@colo-design/protocol";
import type { PreviewConsoleLine, PreviewDriver } from "./preview-tools.js";

/**
 * 화면 확인 게이트 — 턴이 끝나면 기계가 그 화면을 열어 본다.
 *
 * 도구는 이미 있다(`screen_open`·`screen_read`·`screen_console`). 없는 것은
 * **반드시 본다**는 보장이다: 지금은 Claude 가 화면을 고치고 열어 보지 않은
 * 채 답할 수 있고, 그러면 콘솔에서 죽은 화면을 **비개발자가** 발견한다.
 * 그 사람에게는 고칠 말이 없다 — 그게 이 게이트가 있는 이유다.
 *
 * 판정은 기계의 것이다: 이 턴이 실제로 연 화면을 다시 열어, 그 화면이
 * 자리를 잡았는지(`settled`)와 콘솔의 error·실패한 요청만 본다. 경고는
 * 세지 않는다 — 레포의 개발 빌드는 원래 경고를 뱉고, 그것은 이 도구가
 * 만든 문제가 아니다.
 *
 * 범위가 "이 턴이 연 화면" 인 이유: 바뀐 파일에서 화면 주소를 끌어낼 길이
 * 없다(경로↔라우트 지도가 어디에도 없다). 선언된 화면 전부를 쓸면 이번 턴과
 * 무관한 화면의 문제까지 Claude 에게 떠넘기게 된다.
 */

/** 이 턴이 연 화면 하나. */
export interface GateScreen {
  route: string;
  state: string | null;
}

/** 한 화면에서 기계가 본 것. */
export interface ScreenTrouble {
  route: string;
  state: string | null;
  /** 문서는 왔는데 그 화면의 표식이 끝내 나타나지 않았다. */
  unsettled: boolean;
  /** error·실패한 요청만 — 경고는 세지 않는다. */
  lines: PreviewConsoleLine[];
}

/** 게이트가 문제로 세는 줄. `warn` 은 빠진다(레포 개발 빌드의 기본 소음). */
const TROUBLE_LEVELS: Record<string, true> = { error: true, net: true };
/** 한 화면이 실어 보낼 수 있는 줄 수 — 같은 오류의 반복이 브리프를 삼키지 않게. */
const MAX_LINES_PER_SCREEN = 8;
/** 한 번에 다시 열어 보는 화면 수의 상한 — 게이트가 턴만큼 길어지지 않게. */
export const MAX_GATE_SCREENS = 6;
/**
 * 화면들을 다시 열어 본다. 드라이버의 `open` 이 그 화면의 콘솔 기록을 먼저
 * 비우므로(desktop 의 구현), 여기서 읽는 줄은 정확히 **그 화면의 것**이다 —
 * 세션이 쓰던 창을 빌려 읽으면 "Claude 가 마지막으로 연 이후" 라는 흐릿한
 * 창을 보게 된다. 그래서 부르는 쪽이 제 드라이버를 만들어 넘긴다.
 */
export async function inspectScreens(
  driver: PreviewDriver,
  screens: GateScreen[],
): Promise<ScreenTrouble[]> {
  const troubles: ScreenTrouble[] = [];
  for (const screen of screens.slice(0, MAX_GATE_SCREENS)) {
    const opened = await driver.open(screen.route, screen.state).catch(() => null);
    // 열지 못한 것은 게이트의 판정이 아니다 — 미리보기 서버가 방금 죽었거나
    // 주소가 사라진 것이고, 그 사실은 다른 자리(레포 상태)가 이미 말한다.
    if (opened === null || opened.ok !== true) continue;
    const lines = (await driver.consoleLines().catch(() => []))
      .filter((line) => TROUBLE_LEVELS[line.level.toLowerCase()] === true)
      .slice(0, MAX_LINES_PER_SCREEN);
    if (opened.settled && lines.length === 0) continue;
    troubles.push({
      route: screen.route,
      state: screen.state,
      unsettled: !opened.settled,
      lines,
    });
  }
  return troubles;
}

/**
 * Claude 에게 가는 턴. `gate` 마커를 달아 대화록이 카드로 그리고(components
 * 의 `${step}에서 멈췄습니다`), 본문은 화면 하나당 한 묶음이다. 파일 경로도
 * 컴포넌트 이름도 쓰지 않는다 — 다른 기계 턴들과 같은 규칙이다.
 */
export function gateBrief(troubles: ScreenTrouble[]): string {
  const blocks = troubles.map((trouble) => {
    const head = trouble.state ? `${trouble.route} · ${trouble.state}` : trouble.route;
    const reasons: string[] = [];
    if (trouble.unsettled) {
      reasons.push(
        "화면이 자리를 잡지 못했습니다 — 요청한 상태의 표식이 끝내 나타나지 않았습니다.",
      );
    }
    for (const line of trouble.lines) reasons.push(`${line.level}: ${line.text}`);
    return [`### ${head}`, ...reasons].join("\n");
  });
  return markTurn(
    { kind: "gate", step: "화면 확인" },
    [
      "방금 만진 화면을 도구가 다시 열어 봤습니다. 아래를 고친 뒤 screen_open · screen_console 로 직접 확인하고 답해 주세요.",
      ...blocks,
    ].join("\n\n"),
  );
}
