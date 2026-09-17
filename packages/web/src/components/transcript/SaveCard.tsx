/**
 * 상태 카드 (docs/plan/chat.md §1.1 #5): 저장 · 넘기기의 한살이가 대화 안에서
 * 읽히는 자리. 네 상태 — 대기(행동 버튼 있음) · 진행(버튼 사라지고 도는 중) ·
 * 완료(--done, 버튼 사라짐) · 실패(오류 문장 + 다시 시도) — 를 하나의 카드가
 * 옷만 갈아입으며 전부 그린다. 데이터·전이는 호출부(ChatColumn·Transcript)의
 * 몫이다: 이 컴포넌트는 순수 렌더 + 버튼 클릭 배선만 쥔다.
 */
import type { ReactNode } from "react";
import { CheckIcon, CloseIcon, SaveIcon } from "../icons";
import { Tip } from "../shell/Tip";

export type SaveCardStatus = "pending" | "progress" | "done" | "failed";

/** `.frow` 한 행 — 이번 사이클에 얹힌 화면 하나. */
export interface SaveCardFile {
  title: string;
  detail: string;
  /** "고침" · "새로 만듦" 같은 태그 글자; 없으면 태그를 그리지 않는다. */
  tag?: string;
  tagAccent?: boolean;
}

export interface SaveCardAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 잠긴 이유 — Tip 으로 뜬다. */
  reason?: string;
}

export interface SaveCardProps {
  /** 살아있는 대기 카드로 스크롤하는 목적지 — 컴포저 칩이 겨눈다. */
  id?: string;
  status: SaveCardStatus;
  title: string;
  sub: string;
  tagLabel: string;
  tagTone: "warn" | "ok" | "danger";
  files?: SaveCardFile[];
  /** 대기 상태의 안내 한 줄. */
  hint?: string | null;
  /** 실패 상태의 오류 문장. */
  detail?: string | null;
  primary?: SaveCardAction | null;
  secondary?: SaveCardAction | null;
  onRetry?: () => void;
  /** 도는 턴 중의 재시도 잠금 사유 (chat.md §4.1 각주 1) — Tip 으로 뜬다. */
  retryReason?: string | null;
  /** 방금 스크롤되어 온 카드 — panelring 을 두 번 두른다. */
  flash?: boolean;
  /** 저장의 세 걸음 레일 — 진행 상태에서만 호출부가 그려 넣는다. */
  rail?: ReactNode;
  /**
   * 검토 몸통(요약·메모·`자세히 보기` 폴드 — 구 DiffPanel 의 내용): 이 카드가
   * 대기·진행·실패 어느 옷을 입었든 검토할 거리는 몸통이 함께 간다.
   */
  review?: ReactNode;
  /** 카드 맨바닥 칸 — 완료 카드의 저장 메모 줄과 복도 버튼이 산다. */
  foot?: ReactNode;
}

function StatusIcon({ status }: { status: SaveCardStatus }) {
  if (status === "done") return <CheckIcon />;
  if (status === "failed") return <CloseIcon />;
  if (status === "progress") return <span className="spinner" />;
  return <SaveIcon />;
}

export function SaveCard({
  id,
  status,
  title,
  sub,
  tagLabel,
  tagTone,
  files = [],
  hint,
  detail,
  primary,
  secondary,
  onRetry,
  retryReason,
  flash,
  rail,
  review,
  foot,
}: SaveCardProps) {
  const iconTone = status === "done" ? "ok" : status === "failed" ? "danger" : "default";
  return (
    <div id={id} className={`savecard savecard--${status}${flash ? " flash" : ""}`}>
      <div className="savecard__head">
        <span
          className={`savecard__ic${iconTone === "default" ? "" : ` savecard__ic--${iconTone}`}`}
        >
          <StatusIcon status={status} />
        </span>
        <div className="savecard__tt">
          <strong>{title}</strong>
          <span className="savecard__sub">{sub}</span>
        </div>
        <span className={`tag tag--${tagTone}`}>{tagLabel}</span>
      </div>
      {rail}
      {review}
      {files.length > 0 && (
        <div className="savecard__files">
          {files.map((file, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 같은 제목의 화면이 한 사이클에 둘일 수 있어 index 로만 식별한다 — 목록은 뒤에만 붙는다.
            <div className="frow" key={`${file.title}-${index}`}>
              <span className="frow__ic">▣</span>
              <div className="frow__tx">
                <strong>{file.title}</strong>
                <span className="frow__d">{file.detail}</span>
              </div>
              {file.tag && (
                <span className={`tag${file.tagAccent ? " tag--accent" : ""}`}>{file.tag}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {status === "failed" ? (
        <>
          {detail && <div className="savecard__hint">{detail}</div>}
          {onRetry && (
            <div className="savecard__actions">
              {retryReason ? (
                <Tip label={retryReason}>
                  <button type="button" className="primary" disabled onClick={onRetry}>
                    다시 시도
                  </button>
                </Tip>
              ) : (
                <button type="button" className="primary" onClick={onRetry}>
                  다시 시도
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {hint && status === "pending" && <div className="savecard__hint">{hint}</div>}
          {status === "pending" && (primary || secondary) && (
            <div className="savecard__actions">
              {secondary &&
                (secondary.reason ? (
                  <Tip label={secondary.reason}>
                    <button
                      type="button"
                      className="ghost"
                      disabled={secondary.disabled}
                      onClick={secondary.onClick}
                    >
                      {secondary.label}
                    </button>
                  </Tip>
                ) : (
                  <button
                    type="button"
                    className="ghost"
                    disabled={secondary.disabled}
                    onClick={secondary.onClick}
                  >
                    {secondary.label}
                  </button>
                ))}
              {primary &&
                (primary.reason ? (
                  <Tip label={primary.reason}>
                    <button
                      type="button"
                      className="primary"
                      disabled={primary.disabled}
                      onClick={primary.onClick}
                    >
                      {primary.label}
                    </button>
                  </Tip>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    disabled={primary.disabled}
                    onClick={primary.onClick}
                  >
                    {primary.label}
                  </button>
                ))}
            </div>
          )}
        </>
      )}
      {foot}
    </div>
  );
}
