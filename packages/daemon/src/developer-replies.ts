/**
 * 개발자 코멘트 자동 답장 (PLAN L9 · 단계 7) — 순수 도우미만 산다. 게시는
 * 감독자(cycle-supervisor 의 settleReviewReplies)가 하고, 여기서는 그 재료를
 * 뽑는다. 답변의 마지막 문장에서 `개발자에게 (#<id>):` 줄을 찾아 코멘트별
 * 답장 문장으로 돌려준다.
 */

/** 답장 줄의 머리 — reviewToTurn 이 AI 에게 가르치는 바로 그 모양. */
const REPLY_HEAD = /^개발자에게\s*\(#(\d+)\)\s*:?\s*(.*)$/;

/**
 * 답변 본문에서 ids 에 든 코멘트의 답장 줄을 뽑는다.
 *
 * - 머리 줄(`개발자에게 (#101): 문구를 바꿨습니다`)이 그 코멘트의 답장이다.
 * - 바로 다음의 빈 줄이 아닌 줄은 이어지는 문장으로 붙인다(줄바꿈 이어짐) —
 *   다른 답장 줄이 시작되면 거기서 끊는다.
 * - 같은 id 가 두 번 나오면 첫 줄이 이긴다. ids 에 없는 id 는 무시한다.
 */
export function extractDeveloperReplies(text: string, ids: number[]): Map<number, string> {
  const wanted = new Set(ids);
  const found = new Map<number, string[]>();
  let open: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = REPLY_HEAD.exec(line);
    if (head !== null) {
      const id = Number(head[1]);
      const first = head[2] ?? "";
      open = wanted.has(id) && !found.has(id) ? id : null;
      if (open === null) continue;
      found.set(open, first === "" ? [] : [first]);
      continue;
    }
    // 빈 줄은 문장의 끝이다 — 한두 문장이 원칙이라 그 뒤는 다른 이야기다.
    if (line === "" || open === null) {
      open = open === null ? open : null;
      continue;
    }
    found.get(open)?.push(line);
  }
  const replies = new Map<number, string>();
  for (const [id, parts] of found) {
    const joined = parts.join(" ").replace(/\s+/g, " ").trim();
    if (joined !== "") replies.set(id, joined);
  }
  return replies;
}

/**
 * 모든 답장 끝에 줄을 바꿔 붙는 대리 표기 (O5) — 사용자의 이름으로 나간
 * 글이라는 오해를 막는다. 이름은 machine.json 의 작성자 이름, 없으면
 * "사용자".
 */
export function replyFooter(authorName: string | null): string {
  return `— Colo Design 이 ${authorName ?? "사용자"} 님 대신 남김`;
}
