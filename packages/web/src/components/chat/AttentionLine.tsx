import type { Attention } from "@colo-design/protocol";
import { useState } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { requestInvitePicker } from "../../lib/invite-bus";
import { StateBanner } from "../StateBanner";

/**
 * 화면의 문제 문장 (PLAN L8) — 활성 프로젝트의 주의와 기계 전체의 주의 중
 * 우선순위가 높은 하나를 한 줄로 그린다. 문장은 셋뿐이다: `AI가 고치는
 * 중이에요` · `개발자에게 알렸어요` · `다시 연결이 필요해요`. reconnect 일
 * 때만 버튼 하나가 선다 — github 는 초대 파일 열기, agent-login 은 다시
 * 로그인(헤더의 로그인 띠와 같은 손).
 */
export function AttentionLine({ daemon }: { daemon: Daemon }) {
  const attention = pickAttention(daemon.repo?.attention ?? null, daemon.status?.attention ?? null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  if (attention === null) return null;

  const action =
    attention.kind === "reconnect"
      ? attention.what === "github"
        ? {
            // 초대 파일 열기 — 통로(invite-bus)가 Shell 의 컨트롤러에 닿는다.
            label: "초대 파일 열기",
            onClick: () => requestInvitePicker(),
          }
        : {
            // 다시 로그인 — 헤더의 로그인 띠가 부르는 것과 같은 동작.
            label: busy ? "확인 중…" : started ? "다시 확인" : "다시 로그인",
            disabled: busy,
            onClick: () => {
              setBusy(true);
              void (
                started
                  ? daemon.api.refreshStatus()
                  : daemon.api.onboardingFix("login-claude").then(() => setStarted(true))
              )
                .catch(() => undefined)
                .finally(() => setBusy(false));
            },
          }
      : undefined;

  const title =
    attention.kind === "ai-fixing"
      ? "AI가 고치는 중이에요"
      : attention.kind === "developer-notified"
        ? "개발자에게 알렸어요"
        : "다시 연결이 필요해요";

  return (
    <StateBanner
      tone={attention.kind === "reconnect" ? "warn" : "accent"}
      title={title}
      action={action}
      role="status"
    />
  );
}

/** 우선순위는 composeAttention 과 같다 — reconnect > developer-notified > ai-fixing. */
function pickAttention(a: Attention | null, b: Attention | null): Attention | null {
  if (a === null) return b;
  if (b === null) return a;
  const rank = (attention: Attention) =>
    attention.kind === "reconnect" ? 0 : attention.kind === "developer-notified" ? 1 : 2;
  return rank(a) <= rank(b) ? a : b;
}
