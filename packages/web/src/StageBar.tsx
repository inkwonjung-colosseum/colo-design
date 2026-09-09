import { useEffect, useRef, useState } from "react";
import { STAGES, type Stage, type StageAction } from "./stage";
import { ChevronDownIcon } from "./icons";

/**
 * Where this 기획서 is, and the one thing to do about it (PLAN D8).
 *
 * The four buttons this replaces used to live in four different columns — 기획서
 * 게시 over the tree, 이 문서로 화면 만들기 in the editor bar, 저장 and
 * 개발자에게 넘기기 over the preview — so "what do I do next" was a question you
 * answered by scanning the whole window. They are one button now, and which
 * one it is comes from `deriveStage`.
 *
 * Everything still lives in 더 보기: a planner who wants to publish a document
 * while the stepper is asking them to save a screen should not have to satisfy
 * the stepper first. The rail is advice about the usual path, not a gate.
 */
export interface StageMenuItem {
  label: string;
  action: StageAction | "precheck" | "openInConfluence";
  disabled?: boolean;
  title?: string;
}

export function StageBar({
  stage,
  busy,
  menu,
  onAct,
  onPrecheck,
}: {
  stage: Stage;
  /** A save or handoff in flight: the primary must not be pressed twice. */
  busy: boolean;
  /** Everything reachable regardless of step, in the order a cycle uses them. */
  menu: StageMenuItem[];
  onAct: (action: StageAction | "precheck" | "openInConfluence") => void;
  /**
   * 넘기기 전 점검 — the one judgement the tool refuses to make itself, offered
   * beside the primary while there is something to check.
   */
  onPrecheck?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      more.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="stagebar" data-stage={stage.id}>
      <ol className="stagerail" aria-label="기획서 진행 단계">
        {STAGES.map((entry, index) => {
          const state =
            index < stage.index ? "done" : index === stage.index ? "on" : "todo";
          return (
            <li key={entry.id} className={`stagerail__step stagerail__step--${state}`}>
              {/* The current step is the only one a screen reader should
                  announce as the state of things; the rest are a map. */}
              <span className="stagerail__dot" aria-hidden="true" />
              <span className="stagerail__label">{entry.label}</span>
              {state === "on" && <span className="sr-only">— 현재 단계</span>}
            </li>
          );
        })}
      </ol>

      <div className="stagebar__act">
        <span className="stagebar__reason">{stage.reason}</span>
        <span className="stagebar__spacer" />
        {onPrecheck && (
          <button
            type="button"
            className="ghost"
            title="기획서에 적힌 항목이 화면에 다 있는지 화면 대화에 물어봅니다"
            onClick={onPrecheck}
          >
            넘기기 전 점검
          </button>
        )}
        {stage.primary && (
          <button
            type="button"
            className="primary stagebar__primary"
            data-action={stage.primary.action}
            disabled={busy}
            onClick={() => stage.primary && onAct(stage.primary.action)}
          >
            {busy ? "진행 중…" : stage.primary.label}
          </button>
        )}
        <span className="selector stagebar__more">
          {open && (
            <button
              type="button"
              className="selector__backdrop"
              aria-label="더 보기 닫기"
              onClick={() => setOpen(false)}
            />
          )}
          <button
            ref={more}
            type="button"
            className="selector__chip"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            더 보기
            <ChevronDownIcon size={10} />
          </button>
          {open && (
            <span className="selector__menu" role="menu">
              {menu.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className="selector__row"
                  disabled={item.disabled ?? false}
                  {...(item.title ? { title: item.title } : {})}
                  onClick={() => {
                    setOpen(false);
                    onAct(item.action);
                  }}
                >
                  <span className="selector__check" />
                  <span className="selector__label">{item.label}</span>
                </button>
              ))}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
