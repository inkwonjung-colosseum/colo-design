/**
 * The repo bring-up failure table (ex `RepoProgress`): which failure this is,
 * and the words a planner reads for it.
 *
 * The daemon NAMES a failure at the throw site (`RepoStatus.errorKind`,
 * PLAN D41); text sniffing the old UI did broke silently whenever a daemon
 * message was reworded, so the kind is the only thing consulted. Pure data
 * and functions only — the card that renders them lives in RepoProgress.
 */

import type { RepoStatus } from "@colo-design/protocol";

/**
 * Which failure this is. A dead preview server still leaves the screen worth
 * looking at, so it is answered inside the preview itself; everything else
 * takes over the 화면 column.
 */
export type ErrorKind =
  | "auth"
  | "pnpm"
  | "preview"
  | "port-busy"
  | "conflict"
  | "commands"
  | "clone"
  | "unknown";

export function errorKindOf(repo: RepoStatus | null | undefined): ErrorKind {
  const kind = repo?.errorKind;
  if (kind === "registry-auth") return "auth";
  if (kind === "pnpm-missing") return "pnpm";
  if (kind === "conflict") return "conflict";
  if (kind === "commands") return "commands";
  if (kind === "preview") return "preview";
  if (kind === "port-busy") return "port-busy";
  if (kind === "clone") return "clone";
  if (!kind) {
    const detail = repo?.detail ?? null;
    if (detail?.includes("GitHub 패키지 인증")) return "auth";
    if (detail?.includes("pnpm이 없습니다")) return "pnpm";
    // Same age, same gap: a daemon that predates the kind names the busy port
    // in its detail — its card must still offer the force 다시 시작. The
    // specific sentence wins over the generic 미리보기 below it.
    if (detail?.includes("다른 프로그램이 이미 쓰고 있어")) return "port-busy";
    if (detail?.includes("미리보기")) return "preview";
    // A daemon older than the conflict kind still names the conflict in the
    // detail (D96); the diverged refusal says 갈라진 and must not match.
    if (detail?.includes("충돌이 남았습니다")) return "conflict";
  }
  return "unknown";
}

export interface Guidance {
  title: string;
  body: string;
  /** A command the planner can paste into a terminal, if one would fix this. */
  command?: string;
}

export function guidanceFor(kind: ErrorKind, detail: string | null): Guidance {
  if (kind === "auth") {
    return {
      title: "GitHub 패키지 인증이 필요합니다",
      body: "연결 레포의 의존성을 사내 GitHub 패키지에서 받아옵니다. 설정의 개인 액세스 토큰(read:packages 권한)을 확인한 뒤 다시 시도해 주세요.",
      command: "pnpm config set //npm.pkg.github.com/:_authToken <PAT>",
    };
  }
  if (kind === "pnpm") {
    return {
      title: "pnpm이 설치되어 있지 않습니다",
      body: "연결 레포의 설치·미리보기에 pnpm이 필요합니다. 터미널에 아래 명령을 실행한 뒤 다시 시도해 주세요.",
      command: "corepack enable",
    };
  }
  if (kind === "conflict") {
    // D96: 다시 시도로는 같은 충돌을 도는 것이므로, 카드의 첫 동작은
    // Claude 요청이다. 본문은 데몬이 던진 그 상태의 말을 그대로 읽는다.
    return {
      title: "최신 변경과 충돌이 남았습니다",
      body:
        detail ??
        "저장하지 않은 변경과 개발자의 최신 변경이 겹쳤습니다. Claude에게 정리를 요청하면 대화에서 충돌을 정리합니다.",
    };
  }
  if (kind === "commands") {
    // The repo's own install · preview commands wait on one explicit yes —
    // the button below is the yes; the body is the daemon's own words.
    return {
      title: "명령 실행 승인이 필요합니다",
      body: detail ?? "이 레포가 정의한 설치 · 미리보기 명령의 실행을 허용하면 준비를 계속합니다.",
    };
  }
  if (kind === "port-busy") {
    // 이 카드는 이제 정리가 실패한 경우만 만난다: 평범한 충돌은 활성 프로젝트가
    // 이겨 자동 정리된다 (사용자 결정). 그러므로 다음 과제는 다시 시도가 아니라
    // 직접 종료 또는 포트 변경이다.
    return {
      title: "미리보기 포트를 정리하지 못했어요",
      body:
        detail ??
        "선언된 포트를 쓰는 프로그램을 종료하려 했지만 실패했습니다 — 그 프로그램을 직접 끄거나, 연결 레포의 colo-design.json에서 preview.port를 바꾼 뒤 다시 시도해 주세요.",
    };
  }
  return {
    title: "준비하지 못했습니다",
    body: detail ?? "원인을 알 수 없습니다. 다시 시도해 주세요.",
  };
}
