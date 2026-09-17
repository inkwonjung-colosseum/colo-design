/**
 * The repo bring-up failure table (ex `RepoProgress`): which failure this is,
 * and the words a planner reads for it.
 *
 * The daemon NAMES a failure at the throw site (`RepoStatus.errorKind`);
 * text sniffing the old UI did broke silently whenever a daemon
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
  | "port-undetected"
  | "no-preview-command"
  | "conflict"
  | "commands"
  | "clone"
  | "install"
  | "held-elsewhere"
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
  if (kind === "install") return "install";
  if (kind === "no-preview-command") return "no-preview-command";
  if (kind === "port-undetected") return "port-undetected";
  if (kind === "held-elsewhere") return "held-elsewhere";
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
    // detail; the diverged refusal says 갈라진 and must not match.
    if (detail?.includes("충돌이 남았습니다")) return "conflict";
  }
  return "unknown";
}

/**
 * The "AI에게 해결 요청" payload. `step` names the failed step in the
 * transcript card's words (`<step>에서 멈췄습니다`), `thread` names the
 * conversation the tool opens, `brief` is what the agent reads — the failure
 * said as a task, with the daemon's detail appended as its evidence.
 */
interface AgentAsk {
  step: string;
  thread: string;
  brief: string;
}

export interface Guidance {
  title: string;
  body: string;
  /** A command the planner can paste into a terminal, if one would fix this. */
  command?: string;
  /**
   * 카드의 첫 동작 — 이 실패를 AI 의 과제로 넘긴다. 없는 종류는
   * `commands` 하나다: 승인은 사람의 동의라 AI 의 몫이 될 수 없고,
   * 실행 허용 버튼이 그 자리를 지킨다. `preview` 도 없다 — 죽은 서버의
   * 카드는 미리보기 자리가 자기 AI 버튼을 이미 그린다.
   */
  agent?: AgentAsk;
}

const ask = (step: string, thread: string, lead: string, detail: string | null): AgentAsk => ({
  step,
  thread,
  brief: detail ? `${lead}\n\n${detail}` : lead,
});

export function guidanceFor(kind: ErrorKind, detail: string | null): Guidance {
  if (kind === "auth") {
    return {
      title: "GitHub 패키지 인증이 필요합니다",
      body: "연결 레포의 의존성을 사내 GitHub 패키지에서 받아옵니다. 설정의 개인 액세스 토큰(read:packages 권한)을 확인한 뒤 다시 시도해 주세요.",
      command: "pnpm config set //npm.pkg.github.com/:_authToken <PAT>",
      agent: ask(
        "의존성 설치",
        "패키지 인증 해결",
        "설치가 GitHub 패키지 인증에서 멈췄습니다. 이 머신의 npm 인증 설정(~/.npmrc 등)을 점검해 고칠 수 있으면 고치고, read:packages 권한의 토큰이 없는 것처럼 기획자가 해야 할 일이면 무엇이 필요한지 한국어로 알려 주세요.",
        detail,
      ),
    };
  }
  if (kind === "pnpm") {
    return {
      title: "pnpm이 설치되어 있지 않습니다",
      body: "연결 레포의 설치·미리보기에 pnpm이 필요합니다. 터미널에 아래 명령을 실행한 뒤 다시 시도해 주세요.",
      command: "corepack enable",
      agent: ask(
        "의존성 설치",
        "pnpm 준비",
        "준비에 필요한 pnpm이 이 머신에 없습니다 — corepack enable(또는 npm i -g pnpm)으로 pnpm을 준비해 주세요.",
        detail,
      ),
    };
  }
  if (kind === "conflict") {
    // 다시 시도로는 같은 충돌을 도는 것이므로, 카드의 첫 동작은
    // AI 요청이다. 본문은 데몬이 던진 그 상태의 말을 그대로 읽는다.
    return {
      title: "최신 변경과 충돌이 남았습니다",
      body:
        detail ??
        "저장하지 않은 변경과 개발자의 최신 변경이 겹쳤습니다. AI에게 정리를 요청하면 대화에서 충돌을 정리합니다.",
      agent: ask(
        "최신 변경 받아오기",
        "최신화 충돌 정리",
        "준비가 최신화 충돌로 멈춰 있습니다. 충돌을 정리해 저장 전 상태로 돌려 놓고, 미리보기가 다시 뜨도록 준비를 마쳐 주세요.",
        detail,
      ),
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
    // 이겨 자동 정리된다 (사용자 결정). 그러므로 첫 과제는 AI 의 정리이고,
    // preview.port 변경은 그 다음의 손수 해법이다.
    return {
      title: "미리보기 포트를 정리하지 못했어요",
      body:
        detail ??
        "선언된 포트를 쓰는 프로그램을 종료하려 했지만 실패했습니다 — AI에게 정리를 요청하거나, 연결 레포의 colo-design.json에서 preview.port를 바꾼 뒤 다시 시도해 주세요.",
      agent: ask(
        "미리보기 띄우기",
        "미리보기 포트 정리",
        "선언된 미리보기 포트를 다른 프로그램이 쓰고 있어 자동 정리도 실패했습니다. 그 포트를 쓰는 프로세스를 찾아 정리하거나, 연결 레포의 colo-design.json의 preview.port를 비어 있는 포트로 바꿔 주세요.",
        detail,
      ),
    };
  }
  if (kind === "held-elsewhere") {
    // 두 인스턴스 전쟁의 울타리(실사): 다른 창(앱·데몬)의 살아 있는 미리보기를
    // 발견하면 이쪽은 죽이지 않고 멈춘다. 해법은 이 창 밖에 있다 — 다른
    // 인스턴스를 끄는 일이라, AI 도 그 프로세스를 죽이는 대신 이
    // 프로젝트의 포트를 옮기는 쪽으로 정리한다.
    return {
      title: "다른 Colo Design이 미리보기를 쓰고 있어요",
      body:
        detail ??
        "다른 Colo Design 인스턴스(데스크톱 앱 또는 데몬)가 이 프로젝트의 미리보기를 이미 돌리고 있습니다. 다른 인스턴스를 끄거나, 이 프로젝트의 preview.port를 옮긴 뒤 다시 시도해 주세요.",
      agent: ask(
        "미리보기 띄우기",
        "미리보기 포트 정리",
        "다른 Colo Design 인스턴스가 이 프로젝트의 미리보기를 이미 돌리고 있어 이 창의 준비가 멈췄습니다. 그쪽 프로세스를 죽이지는 말고, 이 프로젝트가 다른 포트를 쓰도록 연결 레포의 colo-design.json의 preview.port를 바꾸는 식으로 정리해 주세요.",
        detail,
      ),
    };
  }
  if (kind === "install") {
    // 클론은 살아 있고 설치만 넘어진 자리 — 출력이 곧 증거다.
    return {
      title: "설치를 마치지 못했습니다",
      body:
        detail ??
        "연결 레포의 의존성 설치가 실패했습니다 — AI에게 해결을 요청하면 대화에서 원인을 찾아 고칩니다.",
      agent: ask(
        "의존성 설치",
        "설치 실패 해결",
        "연결 레포의 의존성 설치가 실패해 준비가 멈춰 있습니다. 아래 출력에서 원인을 찾아 고쳐 주세요 — 레포의 문제면 레포를, 이 머신의 환경 문제면 환경을 고칩니다.",
        detail,
      ),
    };
  }
  if (kind === "no-preview-command") {
    // 띄울 명령 자체가 없는 레포 — package.json 에 dev 계열 스크립트가 없고
    // colo-design.json 의 preview.command 도 없다. 명령을 마련하는 일은
    // AI 의 과제다.
    return {
      title: "미리보기 명령이 없습니다",
      body:
        detail ??
        "연결 레포의 package.json에 dev · start · serve · preview 스크립트가 없어 띄울 미리보기 명령을 찾지 못했습니다 — AI에게 해결을 요청하면 대화에서 명령을 준비합니다.",
      agent: ask(
        "미리보기 띄우기",
        "미리보기 명령 준비",
        "연결 레포에 미리보기를 띄울 명령이 없어 준비가 멈춰 있습니다. 레포를 살펴 개발 서버를 띄우는 적절한 스크립트를 package.json에 추가해 주세요 — 명령이 package 스크립트가 아니라면 colo-design.json의 preview.command로 지정해 주세요.",
        detail,
      ),
    };
  }
  if (kind === "port-undetected") {
    // 서버는 떴는데 주소를 못 읽은 상태 — 출력에서 URL 을 못 찾았고 프로세스의
    // LISTEN 포트도 못 잡았다. 주소를 알려 주게 하는 일이 AI 의 과제다.
    return {
      title: "미리보기 주소를 찾지 못했습니다",
      body:
        detail ??
        "미리보기 서버는 시작됐지만 주소를 찾지 못했습니다 — AI에게 해결을 요청하면 대화에서 서버가 주소를 알리도록 고칩니다.",
      agent: ask(
        "미리보기 띄우기",
        "미리보기 주소 감지",
        "미리보기 서버는 시작됐지만 주소를 자동으로 찾지 못해 준비가 멈춰 있습니다. 개발 서버가 뜨는 주소를 출력에 남기도록(예: `Local: http://localhost:PORT`) 고치거나, 연결 레포의 colo-design.json에 preview.port를 지정해 주세요.",
        detail,
      ),
    };
  }
  if (kind === "preview") {
    // 죽은 미리보기는 진행 판이 아니라 미리보기 자리의 멈춤 카드가 답한다 —
    // 그 카드가 자기 "AI에게 고쳐 달라고 하기" 를 이미 그리므로 여기의
    // agent 는 비워 둔다 (두 문이 하나의 실패를 두고 다투지 않게).
    return {
      title: "준비하지 못했습니다",
      body: detail ?? "원인을 알 수 없습니다. 다시 시도해 주세요.",
    };
  }
  if (kind === "clone") {
    return {
      title: "준비하지 못했습니다",
      body: detail ?? "연결 레포를 내려받지 못했습니다 — 다시 시도해 주세요.",
      agent: ask(
        "레포 내려받기",
        "내려받기 실패 해결",
        "연결 레포를 내려받지 못해 준비가 멈춰 있습니다. 실패 원인을 확인해 주세요 — 이 머신의 git 인증으로 직접 clone 하거나 환경 문제(인증 · 네트워크 · 주소)를 고칠 수 있으면 고치고, 접근 권한이 없는 것이라면 무엇이 필요한지 한국어로 알려 주세요.",
        detail,
      ),
    };
  }
  return {
    title: "준비하지 못했습니다",
    body: detail ?? "원인을 알 수 없습니다. 다시 시도해 주세요.",
    agent: ask(
      "준비",
      "준비 오류 해결",
      "준비가 멈췄습니다 — 어느 단계에서 왜 멈췄는지 아래에서 읽고 원인을 고쳐 주세요.",
      detail,
    ),
  };
}
