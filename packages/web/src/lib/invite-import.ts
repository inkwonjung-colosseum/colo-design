import {
  disambiguateProjectNames,
  type InviteRow,
  type InviteRowTarget,
  inviteUpdatePatch,
  type NormalizedInvite,
  normalizeInvite,
  planInviteRows,
  readInviteJson,
  repoKey,
  sameRepo,
} from "@colo-design/protocol";
import type { Daemon } from "./daemon-client";

/**
 * 초대 파일의 읽기와 적용 — 화면(카드 · 컨트롤러)이 묻는 일의 본체다. 읽는 쪽은
 * 파일 하나를 정규화된 초대장으로, 적용 쪽은 초대장과 행 계획(planInviteRows)을
 * 선로 명령의 차례로 바꾼다. 비밀(token)은 화면에 다시 그리지 않는다.
 */

/** 파일 하나 → 초대장, 또는 사람이 읽는 오류 문장 한 줄. */
export async function readInviteFile(
  file: File,
): Promise<{ ok: true; invite: NormalizedInvite } | { ok: false; error: string }> {
  if (!file.name.endsWith(".colo-invite")) {
    return {
      ok: false,
      error: "초대 파일(.colo-invite)이 아닙니다 — 개발자가 보낸 파일을 선택해 주세요.",
    };
  }
  const read = await readInviteJson(await file.text());
  if (!read.ok) {
    return {
      ok: false,
      error:
        read.reason === "sealed"
          ? "초대 파일을 열지 못했습니다 — 파일이 손상됐을 수 있습니다. 개발자에게 파일을 다시 보내달라고 요청하세요."
          : "초대 파일을 읽지 못했습니다 — 개발자에게 파일을 다시 보내달라고 요청하세요.",
    };
  }
  const normalized = normalizeInvite(read.value);
  if (normalized.ok) return { ok: true, invite: normalized.invite };
  const retryAsk = " — 개발자에게 다시 만들어 달라고 요청하세요.";
  if (normalized.reason === "version") {
    return {
      ok: false,
      error: "지원하지 않는 초대 파일입니다 — 앱을 최신 버전으로 업데이트했는지 확인해 주세요.",
    };
  }
  if (normalized.reason === "token") {
    return { ok: false, error: `초대 파일에 연결 코드가 없습니다${retryAsk}` };
  }
  return {
    ok: false,
    error: (normalized.detail ?? "초대 파일을 읽지 못했습니다") + retryAsk,
  };
}

export interface ApplyOptions {
  /** 첫 실행(프로젝트가 하나도 없던 시작)인가 — 첫 add 만 화면을 연다. */
  firstRun: boolean;
  /** 확인 카드의 이름 칸 초안 — 초대장이 이름을 실어 오지 않았을 때만 쓴다. */
  authorDraft?: string;
  /** 한 행이 끝날 때마다 끝난 수를 알린다(진행 문구 "N개 중 M개"). */
  onRow?: (finished: number) => void;
}

/**
 * 행 계획에 이름 겹침 규칙을 얹는다 — 새로 추가(add)되는 프로젝트의 이름이
 * 이미 등록된 프로젝트와 겹치면 저장소 이름을 덧붙인다(normalizeInvite 가
 * 초대장 안에서 쓰는 것과 같은 `<이름> · <repo>`). 저장소 칩이 개발 실행
 * 전용이 된 지금(단계 10) 실사용 화면은 이름만으로 프로젝트를 구별한다.
 * 갱신(update) 행의 이름은 사용자의 몫이라 건드리지 않는다 — 다만 겹침의
 * 잣에는 들어간다.
 */
export function planInviteRowsNamed(
  invite: NormalizedInvite,
  projects: InviteRowTarget[],
): InviteRow[] {
  const rows = planInviteRows(invite, projects);
  const adds = rows.filter(
    (row): row is Extract<InviteRow, { action: "add" }> => row.action === "add",
  );
  const renamed = disambiguateProjectNames(
    adds.map((row) => row.project),
    projects.map((project) => project.name),
  );
  let addIndex = 0;
  return rows.map((row) =>
    row.action === "add"
      ? { ...row, project: { ...row.project, name: renamed[addIndex++] ?? row.project.name } }
      : row,
  );
}

export interface ApplyResult {
  /** 토큰이 거절된 문장 — 있으면 프로젝트는 하나도 건드리지 않았다. */
  tokenError?: string;
  results: Array<{ row: InviteRow; ok: boolean; error?: string }>;
  reachWarnings: string[];
}

/** 선로가 남긴 오류 문장 — Error 가 아니더라도 사람 말로 돌려준다. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 초대장 하나를 적용한다 — 확인 카드의 "초대 받기" 한 번이 부르는 전부다.
 * 1) 토큰을 먼저: pass 가 아니면 그 즉시 끝낸다(프로젝트는 손대지 않는다).
 * 2) 작성자 이름: 초대장이 정했거나 사용자가 칸에 적었을 때만 저장한다.
 * 3) 행마다 하나씩 차례로. add 는 등록(첫 add 만 activate), update 는 기본
 *    가지·리뷰어만 맞춘다 — 이름과 지침은 사용자의 몫이므로 절대 보내지 않는다.
 *    한 행이 실패해도 나머지는 계속한다.
 * 4) 도달 검사: 초대장에 없는 기존 GitHub 프로젝트가 새 토큰으로 넘길 수 있는지
 *    본다 — 못 넘기면 개발자에게 알리라는 경고를 남긴다.
 */
export async function applyInvite(
  daemon: Daemon,
  invite: NormalizedInvite,
  rows: InviteRow[],
  options: ApplyOptions,
): Promise<ApplyResult> {
  const results: ApplyResult["results"] = [];
  const reachWarnings: string[] = [];

  // 1) 연결 코드 — 문이 열리지 않으면 아무것도 하지 않는다.
  try {
    const step = await daemon.api.githubTokenSet(invite.token);
    if (step.status !== "pass") {
      return { tokenError: step.detail, results, reachWarnings };
    }
  } catch (e) {
    return { tokenError: errorText(e), results, reachWarnings };
  }

  // 초대 v4(PLAN 단계 5): 개발자 알림이 갈 Slack 길은 기계 몫 — 토큰 다음,
  // 프로젝트보다 먼저 싣는다. 없으면 지금 설정을 그대로 둔다(지우지 않는다).
  if (invite.notify?.slack) {
    try {
      await daemon.api.escalationSet(invite.notify.slack);
    } catch {
      // Slack 길이 안 닿아도 프로젝트 가져오기는 멈추지 않는다 — 알림은
      // 보조 경로(PLAN L11)라 실패를 조용히 견딘다.
    }
  }
  const author =
    invite.authorName ??
    (options.authorDraft && options.authorDraft.trim() !== "" ? options.authorDraft.trim() : null);
  if (author) {
    try {
      await daemon.api.machineAuthorSet(author);
    } catch {
      // 조용히 넘어간다 — 다음 초대장이나 설정에서 다시 정할 수 있다.
    }
  }

  // 3) 행마다 차례로 — activate 는 첫 실행의 첫 add 에만(나머지는 등록만).
  let finished = 0;
  let firstAddSeen = false;
  for (const row of rows) {
    try {
      if (row.action === "add") {
        const activate = options.firstRun && !firstAddSeen;
        firstAddSeen = true;
        await daemon.api.projectCreate({
          name: row.project.name,
          repoUrl: row.project.repoUrl,
          baseBranch: row.project.baseBranch,
          ...(row.project.reviewers ? { reviewers: row.project.reviewers } : {}),
          ...(row.project.instructions ? { instructions: row.project.instructions } : {}),
          ...(row.project.approveCommands ? { approveCommands: true } : {}),
          // 초대 v4(PLAN 단계 5): 개발자가 실어 보낸 처음 값과 수명.
          ...(row.project.defaults ? { defaults: row.project.defaults } : {}),
          ...(row.project.lifecycle ? { lifecycle: row.project.lifecycle } : {}),
          activate,
        });
      } else if (row.action === "update") {
        await daemon.api.projectUpdate(row.slug, {
          // 초대 v4(PLAN 단계 5): 개발자의 값(기본 가지 · 리뷰어 · 명령 허용 ·
          // 처음 값 · 수명)은 덮고, 초대장에 없으면 지우는 값(null)을 보낸다.
          // 이름·지침은 사용자의 것이라 패치에 없다.
          ...inviteUpdatePatch(row.project),
        });
      }
      results.push({ row, ok: true });
    } catch (e) {
      results.push({ row, ok: false, error: errorText(e) });
    }
    finished += 1;
    options.onRow?.(finished);
  }

  // 4) 도달 검사 — 초대장에 없는 기존 GitHub 프로젝트가 새 코드로도 넘길 수 있는지.
  const invited = rows.map((row) => row.project.repoUrl);
  for (const project of daemon.projects) {
    if (typeof project.repoUrl !== "string") continue;
    if (invited.some((url) => sameRepo(url, project.repoUrl as string))) continue;
    const key = repoKey(project.repoUrl);
    // github.com/<owner>/<repo> 의 두 조각만 검사할 수 있다.
    const slug = key?.startsWith("github.com/") ? key.slice("github.com/".length).split("/") : null;
    if (slug?.length !== 2) continue;
    try {
      const inspection = await daemon.api.githubRepoInspect(slug[0] as string, slug[1] as string);
      if (!inspection.canPush) {
        reachWarnings.push(
          `‘${project.name}’ 프로젝트는 새 연결 코드로 개발자에게 넘길 수 없어요 — 개발자에게 알려 주세요.`,
        );
      }
    } catch {
      reachWarnings.push(
        `‘${project.name}’ 프로젝트는 새 연결 코드로 개발자에게 넘길 수 없어요 — 개발자에게 알려 주세요.`,
      );
    }
  }

  return { results, reachWarnings };
}
