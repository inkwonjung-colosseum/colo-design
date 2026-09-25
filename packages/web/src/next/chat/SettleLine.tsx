import { useRef, useState } from "react";
import { L } from "../labels";
import { splitDuration } from "../lib/thread";
import { Popover } from "../ui/Popover";
import { CheckIcon, CopyIcon, ForkIcon, FwdIcon, MoreIcon } from "./icons";

/** `12초` · `1분 5초` — 걸린 시간. */
export function durationText(ms: number): string {
  const { minutes, seconds } = splitDuration(ms);
  return minutes === 0
    ? L.transcript.seconds(seconds)
    : L.transcript.minutesSeconds(minutes, seconds);
}

/** 창 밖으로 글을 복사한다 — 실패해도 조용하다(복사는 편의다). */
export function copyText(text: string, onDone: () => void): void {
  void navigator.clipboard
    .writeText(text)
    .then(onDone)
    .catch(() => undefined);
}

/**
 * 정산 줄(목업 `.settle`) — 한 답이 끝난 자리: `✓ 12초 걸렸어요 · 전체 복사 · ···`.
 * `···` 안에 `여기서 새 대화`(대화만 이 답까지 이어받는다 — 화면은 그대로라는
 * 문장과 `작업 기록에서 되돌리기` 링크가 함께), 그리고 `이 답변만 복사`.
 */
export function SettleLine({
  durationMs,
  whole,
  lastAnswer,
  onFork,
  onOpenHistory,
  onToast,
}: {
  durationMs: number | null;
  /** 이 요청이 낸 답 전부 — 없으면 전체 복사가 없다. */
  whole: string | null;
  /** 마지막 답 한 조각 — `이 답변만 복사`. */
  lastAnswer: string | null;
  /** 여기서 새 대화 — 갈래를 낼 수 없는 AI 면 없다. */
  onFork: (() => void) | null;
  onOpenHistory: () => void;
  onToast: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const hasMenu = onFork !== null || lastAnswer !== null;
  if (durationMs == null && whole == null && !hasMenu) return null;
  return (
    <div className="nx-settle">
      <CheckIcon />
      {durationMs != null && <span>{L.transcript.took(durationText(durationMs))}</span>}
      {whole != null && (
        <>
          {durationMs != null && <span className="nx-sep">·</span>}
          <button
            type="button"
            onClick={() => copyText(whole, () => onToast(L.transcript.copyAllToast))}
          >
            <CopyIcon />
            {L.transcript.copyAll}
          </button>
        </>
      )}
      {hasMenu && (
        <span className="nx-anchor">
          <button
            ref={anchor}
            type="button"
            title={L.transcript.settleMenuTip}
            aria-label={L.transcript.settleMenuTip}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <MoreIcon />
          </button>
          {open && (
            <Popover anchor={anchor} onClose={() => setOpen(false)} up className="nx-settle-pop">
              {onFork && (
                <>
                  <button
                    type="button"
                    className="nx-mi"
                    onClick={() => {
                      setOpen(false);
                      onFork();
                    }}
                  >
                    <ForkIcon />
                    <span className="nx-mt">
                      <b>{L.transcript.fork}</b>
                      <small>{L.transcript.forkSub}</small>
                    </span>
                  </button>
                  <div className="nx-mnote">
                    {L.transcript.forkNote}{" "}
                    <button
                      type="button"
                      className="nx-mlink"
                      onClick={() => {
                        setOpen(false);
                        onOpenHistory();
                      }}
                    >
                      {L.transcript.forkRevertLink}
                    </button>
                  </div>
                </>
              )}
              {onFork && lastAnswer !== null && <div className="nx-msep" />}
              {lastAnswer !== null && (
                <button
                  type="button"
                  className="nx-mi"
                  onClick={() => {
                    setOpen(false);
                    copyText(lastAnswer, () => onToast(L.transcript.copyOneToast));
                  }}
                >
                  <CopyIcon />
                  {L.transcript.copyOne}
                </button>
              )}
            </Popover>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * `고친 화면` 카드(U5) — 답이 말한 화면 하나. 누르면 미리보기가 그리로 간다.
 * 썸네일 자리는 목업의 그림(화면 골격)이다 — 실제 캡처를 싣는 선로는 아직 없다.
 */
export function ShotCard({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <button type="button" className="nx-shot" onClick={onOpen}>
      <span className="nx-thumb" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="nx-st">
        <small>{L.transcript.shotLabel}</small>
        <b>{title}</b>
        <span>{L.transcript.shotGo}</span>
      </span>
      <span className="nx-go">
        <FwdIcon />
      </span>
    </button>
  );
}
