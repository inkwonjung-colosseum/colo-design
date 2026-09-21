import type { ReactNode } from "react";
import { CircleCheckIcon, CloseIcon, WarnIcon } from "./icons";

/** 배너의 심각도 — 왼쪽 스트립과 아이콘 칸이 같은 색을 읽는다. */
type BannerTone = "warn" | "danger" | "accent" | "neutral";

const DEFAULT_ICON: Record<BannerTone, ReactNode> = {
  warn: <WarnIcon />,
  danger: <CloseIcon />,
  accent: <CircleCheckIcon />,
  neutral: null,
};

/**
 * 상태 배너 — 앱 수준 조건 상태의 한 줄 문법(목업 states/03): 왼쪽 스트립이
 * 심각도를, 아이콘이 종류를, 문장이 사실을, 오른쪽 끝이 동작(최대 하나)과
 * 거둠 ✕를 맡는다. 제자리가 없는 조건 상태 — 연결 끊김 · 기록 읽기 실패 ·
 * 사이드바 동작 실패 · 저장과 넘기기의 실패 · 첨부와 전송의 실패 — 가 여기
 * 선다. 필드 · 카드 · 패널 안의 한 줄 안내(폼 오류 · 선택 경고 · 진행 안내)는
 * 여기 오지 않는다 — 그 자리의 notice 가 그 몫이다. 콘텐츠가 본문을 품는
 * 상태 — 스켈레톤 · 빈 상태 · 턴 실패 카드 — 는 각자의 자리에 그대로 있고
 * 이 배너로 오지 않는다.
 */
export function StateBanner({
  tone,
  icon = DEFAULT_ICON[tone],
  title,
  sub,
  action,
  actionSlot,
  onClose,
  closeLabel = "닫기",
  role,
  className,
}: {
  tone: BannerTone;
  /** 아이콘 칸의 그림 — 생략하면 심각도의 기본 그림(경고 · ✕ · 확인)이 선다. */
  icon?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  /** 오른쪽 끝의 유일한 동작 — 배너 문법은 동작을 하나만 둔다. */
  action?: { label: ReactNode; onClick: () => void; disabled?: boolean };
  /**
   * 같은 자리를, 스스로 상태를 가진 동작이 쓸 때(보내는 중 · 보냄 · 잠김의
   * 이유). `action` 과 함께 쓰지 않는다 — 배너의 동작은 여전히 하나다.
   */
  actionSlot?: ReactNode;
  /** 거둠 ✕ — 거둬도 사라지지 않을 상태(연결 끊김 같은)에는 두지 않는다. */
  onClose?: () => void;
  closeLabel?: string;
  role?: "status" | "alert";
  className?: string;
}) {
  return (
    <div className={["banner", `banner--${tone}`, className].filter(Boolean).join(" ")} role={role}>
      {icon != null && (
        <span className="banner__ic" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="banner__tx">
        <span className="banner__t">{title}</span>
        {sub != null && <span className="banner__s">{sub}</span>}
      </span>
      {actionSlot != null && <span className="banner__act">{actionSlot}</span>}
      {action && (
        <span className="banner__act">
          <button
            type="button"
            className="chip"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        </span>
      )}
      {onClose && (
        <button type="button" className="banner__close" aria-label={closeLabel} onClick={onClose}>
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
