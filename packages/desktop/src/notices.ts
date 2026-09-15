import type { DaemonNotice } from "@colo-design/daemon/server";

/**
 * 알림 한 장의 문구. 사용자의 어휘만 나간다 — 도구 이름도, git 도 없다.
 * 스레드 이름이 제목이 되고, 몸글은 창을 열면 무엇을 확인하게 되는지를
 * 한 문장으로 말한다. 데몬은 의미만 건넨다(DaemonNotice); 문장은 여기서 정한다.
 */
export function noticeCopy(notice: DaemonNotice): {
  title: string;
  body: string;
} {
  switch (notice.kind) {
    case "done":
      return {
        title: `${notice.title} · 완료`,
        body: "Claude가 화면 작업을 마쳤습니다. 미리보기를 확인해 보세요.",
      };
    case "crashed":
      return {
        title: `${notice.title} · 중단`,
        body: "Claude가 중단됐습니다. 대화에서 이유를 확인할 수 있습니다.",
      };
    case "ask":
      return notice.what === "question"
        ? {
            title: `${notice.title} · 답 필요`,
            body: "Claude가 질문에 대한 답을 기다리고 있습니다.",
          }
        : {
            title: `${notice.title} · 확인 필요`,
            body: "Claude가 진행 허락을 기다리고 있습니다.",
          };
    case "gate":
      return notice.stage === "save"
        ? {
            title: `${notice.title} · 저장 실패`,
            body: "저장이 끝나지 못했습니다. Claude에게 고치도록 맡겼습니다.",
          }
        : notice.stage === "handoff"
          ? {
              title: `${notice.title} · 넘기기 실패`,
              body: "넘기기가 끝나지 못했습니다. Claude에게 고치도록 맡겼습니다.",
            }
          : notice.stage === "screen"
            ? {
                title: `${notice.title} · 화면 확인`,
                body: "만든 화면에서 오류를 찾았습니다. Claude에게 고치도록 맡겼습니다.",
              }
            : {
                title: `${notice.title} · 최신화 충돌`,
                body: "최신 변경과 저장하지 않은 변경이 겹쳤습니다. Claude에게 정리를 맡겼습니다.",
              };
    case "handoff":
      // 커미티 B1+A (2026-09-15): 단위는 프로젝트다 — 한 사이클에 화면이
      // 여럿이라 첫 화면 하나만 부르면 나머지가 안 간 것처럼 읽힌다.
      return notice.event === "merged"
        ? {
            title: `${notice.projectName} · 반영됨`,
            body: "개발자가 이번 작업을 제품에 합쳤습니다. 다음 저장은 새 작업을 시작합니다.",
          }
        : notice.event === "closed"
          ? {
              title: `${notice.projectName} · 반려됨`,
              body: "개발자가 이번 요청을 닫았습니다 — 상태 확인에서 이유를 읽어 보세요.",
            }
          : notice.event === "changes_requested"
            ? {
                title: `${notice.projectName} · 변경 요청`,
                body: "개발자가 넘긴 요청에 코멘트를 남겼습니다 — 상태 확인에서 이어 가세요.",
              }
            : {
                title: `${notice.projectName} · 개발자 코멘트`,
                body: `개발자 코멘트 ${notice.count ?? 1}건이 새로 달렸습니다 — 상태 확인에서 읽어 보세요.`,
              };
  }
}
