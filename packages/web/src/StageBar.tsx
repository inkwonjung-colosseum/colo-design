import { CheckIcon } from "./icons";
import { STAGES, type Stage } from "./stage";

/**
 * 미리보기 열 아래의 스테퍼 (PLAN D44): 다섯 단계 레일, 판정 근거 한 줄, 주 버튼
 * 하나. 판정은 stage.ts 의 순수 함수가 내리고 이 컴포넌트는 그릴 뿐이다 — 주
 * 버튼의 동작은 props 로 온다 (저장=onSave, 넘기기=onHandoff). 보조 버튼
 * `넘기기 전 점검` 은 검토·수정 단계에서만 주 버튼 옆에 선다.
 */
export function StageBar({
  stage,
  onNewSession,
  onSave,
  onHandoff,
  onCheckState,
  onPrecheck,
  precheckDisabled = false,
  unresolvedComments = 0,
}: {
  stage: Stage;
  /** 화면 만들기 단계의 주 버튼 — 새 대화 (컴포저 포커스). */
  onNewSession: () => void;
  /** 검토·수정 단계의 주 버튼 — 저장 검토를 연다. */
  onSave: () => void;
  /** 저장 단계의 주 버튼 — 개발자에게 넘기기 대화상자를 연다. */
  onHandoff: () => void;
  /** 넘기기 단계의 주 버튼 — 개발자의 답을 다시 읽는다. */
  onCheckState: () => void;
  /** 검토·수정 단계의 보조 버튼 — 기획서와 화면을 맞춰 보는 턴을 보낸다. */
  onPrecheck: () => void;
  /** 점검은 열려 있는 대화가 필요하다 — 없으면 보조 버튼이 잠긴다. */
  precheckDisabled?: boolean;
  /** 미해결 코멘트 수(PLAN D57) — why 한 줄에 붙는다; 0이면 문장이 없다. */
  unresolvedComments?: number;
}) {
  const { step, primary, why } = stage;
  if (!step) return null;

  const current = STAGES.findIndex((entry) => entry.id === step);
  const primaryClick =
    step === "create" ? onNewSession : step === "review" ? onSave : step === "save" ? onHandoff : onCheckState;

  return (
    <div className="stepper">
      <div className="stepper__rail">
        {STAGES.map((entry, index) => (
          <div
            key={entry.id}
            className={`step${index < current ? " step--done" : ""}${index === current ? " step--now" : ""}`}
          >
            <span className="step__mark" aria-current={index === current ? "step" : undefined}>
              {index < current ? "✓" : index + 1}
            </span>
            <span className="step__label">{entry.label}</span>
            {index < STAGES.length - 1 && <span className="step__line" />}
          </div>
        ))}
      </div>
      <div className="stepper__foot">
        <span className="stepper__why">
          {why}
          {unresolvedComments > 0 ? ` · 미해결 코멘트 ${unresolvedComments}` : ""}
        </span>
        {step === "review" && (
          <button
            type="button"
            className="ghost"
            disabled={precheckDisabled}
            title={precheckDisabled ? "먼저 대화를 열어 주세요" : "열려 있는 대화에서 기획서와 화면을 맞춰 봅니다"}
            onClick={onPrecheck}
          >
            <CheckIcon size={12} /> 넘기기 전 점검
          </button>
        )}
        {primary && (
          <button type="button" className="primary" disabled={primary.disabled} onClick={primaryClick}>
            {primary.label}
          </button>
        )}
      </div>
    </div>
  );
}
