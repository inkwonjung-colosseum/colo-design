import type { InviteRow, InviteRowTarget } from "@colo-design/protocol";
import type { L } from "../labels";

/**
 * 다시 받은 초대장의 행 문장(U11) — `planInviteRows` 의 판정(add · update ·
 * keep)을 확인 창에 줄 설 한국어 한 줄로 바꾼다. 문장은 `labels.ts` 에서 오지만
 * 이 파일은 그것을 부르지 않고 인자로 받는다 — 단위 시험이 src 에서 곧장 읽는
 * 순수 모듈은 형제를 부르지 않는다(journey.ts 와 같은 규칙).
 */
export type InviteRowWords = Pick<typeof L, "invite" | "inviteChange">;

/** 확인 창에 줄 설 행 하나 — `line` 이 목록의 글자 그대로다. */
export interface InviteRowLine {
  action: "add" | "update" | "keep";
  /** 행의 이름 — update 행은 사용자가 지은 이름(currentName)이 이긴다. */
  name: string;
  /** `새로 · <이름>` · `바뀜 · <이름> · <무엇이>` · `그대로 · <이름>`. */
  line: string;
  /** 행 아래의 한 줄 — add 행의 "처음 열 때 준비에 몇 분 걸려요". 없으면 null. */
  sub: string | null;
  /** `지금 열기` 로 열 프로젝트를 찾는 짝의 연결 주소. */
  repoUrl: string;
}

export interface InviteRowsCopy {
  rows: InviteRowLine[];
  /** add 도 update 도 없다 — "연결 코드만 새로 받았어요" 의 판정. */
  nothingChanged: boolean;
}

/** 값이 있는 키만 세는 얕은 비교 — undefined 인 키와 없는 키를 같게 본다. */
function sameRecord(a: object | undefined, b: object | undefined): boolean {
  const left = Object.entries(a ?? {}).filter(([, value]) => value !== undefined);
  const right = new Map(Object.entries(b ?? {}).filter(([, value]) => value !== undefined));
  return left.length === right.size && left.every(([key, value]) => right.get(key) === value);
}

/**
 * 바뀜 행의 "무엇이 바뀌었는가" — 초대장의 값과 짝의 지금 값을 비교해 만든
 * 문장의 목록. 초대장이 정하는 값만 본다(이름 · 지켜 줄 것은 사용자의 몫).
 */
export function inviteUpdateChanges(
  row: Extract<InviteRow, { action: "update" }>,
  words: InviteRowWords,
  target: InviteRowTarget | undefined,
): string[] {
  const changes: string[] = [];
  if (target && target.baseBranch !== undefined && target.baseBranch !== row.project.baseBranch) {
    changes.push(words.inviteChange.baseBranch(target.baseBranch, row.project.baseBranch));
  }
  const want = row.project.reviewers ?? [];
  const have = target?.reviewers ?? [];
  if (want.length !== have.length || want.some((login, i) => login !== have[i])) {
    changes.push(words.inviteChange.reviewers);
  }
  if (row.project.approveCommands === true && target?.commandsApproved !== true) {
    changes.push(words.inviteChange.approve);
  }
  if (!sameRecord(row.project.defaults, target?.defaults)) {
    changes.push(words.inviteChange.defaults);
  }
  if (!sameRecord(row.project.lifecycle, target?.lifecycle)) {
    changes.push(words.inviteChange.lifecycle);
  }
  return changes;
}

export function inviteRowsCopy(
  rows: InviteRow[],
  words: InviteRowWords,
  targets: InviteRowTarget[] = [],
): InviteRowsCopy {
  const lines = rows.map((row): InviteRowLine => {
    if (row.action === "add") {
      const name = row.project.name;
      return {
        action: "add",
        name,
        line: `${words.invite.rowNew} · ${name}`,
        sub: words.invite.addedNote,
        repoUrl: row.project.repoUrl,
      };
    }
    if (row.action === "update") {
      const name = row.currentName || row.project.name;
      const what = inviteUpdateChanges(
        row,
        words,
        "slug" in row ? targets.find((target) => target.slug === row.slug) : undefined,
      ).join(" · ");
      return {
        action: "update",
        name,
        line: what
          ? `${words.invite.rowUpdate} · ${name} · ${what}`
          : `${words.invite.rowUpdate} · ${name}`,
        sub: null,
        repoUrl: row.project.repoUrl,
      };
    }
    const name = row.currentName || row.project.name;
    return {
      action: "keep",
      name,
      line: `${words.invite.rowKeep} · ${name}`,
      sub: null,
      repoUrl: row.project.repoUrl,
    };
  });
  return {
    rows: lines,
    nothingChanged: rows.length > 0 && rows.every((row) => row.action === "keep"),
  };
}
