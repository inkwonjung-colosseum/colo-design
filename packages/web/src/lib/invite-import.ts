import {
  type InviteRow,
  type NormalizedInvite,
  normalizeInvite,
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

  // 2) 이 작업에 적을 이름 — 저장에 실패해도 연결을 막지 않는다(이름은 부속이다).
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
          activate,
        });
      } else {
        await daemon.api.projectUpdate(row.slug, {
          baseBranch: row.project.baseBranch,
          // 리뷰어는 초대장의 말이 우선이다 — 없으면 지운다(null).
          reviewers: row.project.reviewers ?? null,
          ...(row.project.approveCommands ? { approveCommands: true } : {}),
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
