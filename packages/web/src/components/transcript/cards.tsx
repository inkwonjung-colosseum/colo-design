import type { AskQuestion, RepoStatus } from "@colo-design/protocol";
import { useState } from "react";
import type { PendingPermission, PendingQuestion } from "../../lib/daemon-client";
import { composing } from "../../lib/ime";
import { bashHeadline, objectParticle, toolLabel } from "../../lib/labels";
import { ShieldIcon, SparkIcon } from "../icons";
import { Markdown } from "../Markdown";
import { Tip } from "../shell/Tip";
import { preview, toolHeadline } from "./shared";

/** The commands the clone resolved to, as RepoStatus carries them. */
type RepoCommands = NonNullable<RepoStatus["commands"]>;

// ---------------------------------------------------------------------------
// Human-in-the-loop cards
// ---------------------------------------------------------------------------

/**
 * 계획의 승인 카드 (계획 모드 완결): 권한 카드의 형식을 빌리되 물는 것이
 * 다르다 — "이 수행을 허용할까요"가 아니라 "이것을 만들까요". 본문은
 * 계획 그 자체(AI 가 ExitPlanMode 에 실어 보낸 마크다운)이고, 승인은
 * 착수이며 거절은 수정 요청이다. 본문이 없는 요청은 있는 셈 치고 그리지
 * 않고 본래의 권한 카드로 돌려 보낸다.
 */
export function PlanCard({
  request,
  onRespond,
}: {
  request: PendingPermission;
  onRespond: (decision: "allow" | "allowAlways" | "deny", message?: string) => void;
}) {
  const [changes, setChanges] = useState("");
  const [showChanges, setShowChanges] = useState(false);
  const plan = (request.input as { plan?: unknown } | null)?.plan;
  if (typeof plan !== "string" || plan.trim() === "") {
    return <PermissionCard request={request} onRespond={onRespond} />;
  }

  return (
    <div className="card card--plan" role="alert">
      <div className="card__title">
        <span className="card__badge">
          <SparkIcon size={14} />
        </span>
        <span>
          <strong>만들 것</strong>을 승인해 주세요
        </span>
      </div>
      <p className="plan__lead">
        AI가 화면을 만들기 전에 무엇을 만들지 보여 드립니다 — 승인하면 바로 만듭니다.
      </p>
      <div className="card__plan">
        <Markdown text={plan} />
      </div>
      {showChanges ? (
        <div className="card__reason">
          <textarea
            autoFocus
            value={changes}
            placeholder="무엇을 어떻게 바꿀지 알려 주세요"
            onChange={(e) => setChanges(e.target.value)}
          />
          <button
            type="button"
            className="danger"
            onClick={() => onRespond("deny", changes || undefined)}
          >
            바꿔 달라 보내기
          </button>
          <button type="button" className="ghost" onClick={() => setShowChanges(false)}>
            뒤로
          </button>
        </div>
      ) : (
        <div className="card__actions">
          <button type="button" className="primary" onClick={() => onRespond("allow")}>
            승인하고 만들기
          </button>
          <button type="button" className="danger" onClick={() => setShowChanges(true)}>
            바꿔 달라…
          </button>
        </div>
      )}
    </div>
  );
}

export function PermissionCard({
  request,
  onRespond,
  commands,
}: {
  request: PendingPermission;
  onRespond: (decision: "allow" | "allowAlways" | "deny", message?: string) => void;
  /** The repo's resolved commands, for naming Bash calls. */
  commands?: RepoCommands;
}) {
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const raw = toolHeadline(request.input);
  const headline = request.toolName === "Bash" ? bashHeadline(raw, commands) : raw;
  const action = toolLabel(request.toolName);
  const suggestion = request.suggestions[0];

  return (
    <div className="card card--permission" role="alert">
      <div className="card__title">
        <span className="card__badge">
          <ShieldIcon />
        </span>
        <span>
          <strong>{action}</strong>
          {objectParticle(action)} 허용할까요?
        </span>
      </div>
      {headline && <pre className="card__headline">{headline}</pre>}
      <details className="card__details">
        <summary>자세히 보기</summary>
        <pre>{preview(request.input, 4000)}</pre>
      </details>

      {showReason ? (
        <div className="card__reason">
          <input
            autoFocus
            value={reason}
            placeholder="왜 안 되는지, 대신 무엇을 할지 알려 주세요"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              // Composition keys pass straight through: Enter would hand
              // the agent half a sentence as the refusal.
              if (composing(e)) return;
              if (e.key === "Enter") onRespond("deny", reason || undefined);
            }}
          />
          <button type="button" onClick={() => onRespond("deny", reason || undefined)}>
            거절 보내기
          </button>
          <button type="button" className="ghost" onClick={() => setShowReason(false)}>
            뒤로
          </button>
        </div>
      ) : (
        <div className="card__actions">
          {/* 선택지가 결과를 말한다(cycle/permission.html perm__opt): 범위·의미는
              버튼 글자에 있고, 목업의 보조 줄(.d)은 이 마크업의 한 줄 버튼에
              맞지 않아 접미사로 옮겼다. */}
          <button type="button" className="primary" onClick={() => onRespond("allow")}>
            허용 · 이번 한 번만
          </button>
          {suggestion ? (
            <Tip label={suggestion.label}>
              <button type="button" onClick={() => onRespond("allowAlways")}>
                항상 허용 · 이 프로젝트에서
              </button>
            </Tip>
          ) : (
            // 이유는 hover 가 아니라 행이 말한다 — 터치·키보드는 Tip 을 못 연다.
            <button type="button" disabled>
              항상 허용 — 이 동작은 매번 물어봐야 합니다
            </button>
          )}
          <button type="button" className="danger" onClick={() => setShowReason(true)}>
            거절 · 다른 방법 찾기
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 선택지의 미리보기: `previewFormat: "html"` 로 받은 시안은 글이
 * 아니라 그림이다. 스크립트도 부모 문서도 닿을 수 없는 sandbox iframe 안에서만
 * 그린다 — 카드에 들어오는 HTML 은 모델이 쓴 것이고, 이 앱의 DOM 은 그것과
 * 같은 세계에 있으면 안 된다. `srcdoc` 의 문서에 CSP 를 직접 심어 바깥으로
 * 나가는 요청(원격 폰트 · 이미지 · 추적)까지 막는다.
 */
function OptionPreview({ html, tall }: { html: string; tall: boolean }) {
  // 마크다운으로 온 옛 미리보기(또는 HTML 이 아닌 무엇)는 글자 그대로 읽힌다.
  if (!/^\s*</.test(html)) return <pre className="option__previewtext">{html}</pre>;
  const doc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>body{margin:0;padding:12px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1c1c1f;background:#fff}</style>${html}`;
  return (
    <iframe
      className={tall ? "option__preview option__preview--tall" : "option__preview"}
      title="선택지 미리보기"
      sandbox=""
      srcDoc={doc}
    />
  );
}

export function QuestionCard({
  request,
  onRespond,
}: {
  request: PendingQuestion;
  onRespond: (
    answers: Record<string, string | string[]>,
    annotations: Record<string, { preview?: string; notes?: string }>,
  ) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  /** 선택 옆의 메모: 질문 글자를 키로, 계획자가 덧붙인 말. */
  const [notes, setNotes] = useState<Record<string, string>>({});

  const pick = (q: AskQuestion, label: string) => {
    setAnswers((prev) => {
      if (!q.multiSelect) return { ...prev, [q.question]: label };
      const current = prev[q.question];
      const list = Array.isArray(current) ? current : current ? [current] : [];
      return {
        ...prev,
        [q.question]: list.includes(label) ? list.filter((l) => l !== label) : [...list, label],
      };
    });
  };

  const isPicked = (q: AskQuestion, label: string) => {
    const current = answers[q.question];
    return Array.isArray(current) ? current.includes(label) : current === label;
  };

  const merged = (): Record<string, string | string[]> => {
    const out = { ...answers };
    for (const [question, text] of Object.entries(custom)) {
      if (text.trim()) out[question] = text.trim();
    }
    return out;
  };

  /**
   * 무엇을 돌려보내는가: 메모와, 그 메모가 붙은 선택지의 시안. 고른 것이 없는
   * 질문(직접 입력으로 답한 질문)은 시안 없이 메모만 간다.
   */
  const annotations = (): Record<string, { preview?: string; notes?: string }> => {
    const out: Record<string, { preview?: string; notes?: string }> = {};
    for (const q of request.questions) {
      const note = notes[q.question]?.trim();
      if (!note) continue;
      const picked = q.options.find((option) => isPicked(q, option.label));
      out[q.question] = { notes: note, ...(picked?.preview ? { preview: picked.preview } : {}) };
    }
    return out;
  };

  const complete = request.questions.every((q) => {
    const value = merged()[q.question];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });

  return (
    <div className="card card--question" role="alert">
      <div className="card__title">
        <span className="card__badge">
          <SparkIcon size={14} />
        </span>
        <span>확인이 필요합니다</span>
      </div>
      {request.questions.map((q) => {
        const previews = q.options.filter((option) => option.preview);
        // 시안이 전부 있고 셋 이하면 나란히 놓는다 — 시안은 비교하라고 있는
        // 것이고, 위아래로 쌓인 시안은 비교가 아니라 스크롤이다.
        const compare = previews.length === q.options.length && q.options.length <= 3;
        const pickedPreview = q.options.find(
          (option) => isPicked(q, option.label) && option.preview,
        )?.preview;
        const answered = (() => {
          const value = merged()[q.question];
          return Array.isArray(value) ? value.length > 0 : Boolean(value);
        })();
        return (
          <div key={q.question} className="question">
            <div className="question__header">
              {q.header}
              {q.multiSelect && <span className="question__multi">여러 개 고를 수 있어요</span>}
              {!answered && <span className="question__unanswered">아직 답하지 않음</span>}
            </div>
            <div className="question__text">{q.question}</div>
            <div
              className={
                compare ? "question__options question__options--wide" : "question__options"
              }
            >
              {q.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={isPicked(q, option.label) ? "option option--picked" : "option"}
                  onClick={() => pick(q, option.label)}
                >
                  <span className="option__label">{option.label}</span>
                  <span className="option__description">{option.description}</span>
                  {compare && option.preview && (
                    <OptionPreview html={option.preview} tall={false} />
                  )}
                </button>
              ))}
            </div>
            {/* 나란히 놓지 못한 시안은 고른 것 하나만 크게 — 고르기 전에는
                아무것도 그리지 않는다(빈 액자는 카드를 밀어낼 뿐이다). */}
            {!compare && pickedPreview && <OptionPreview html={pickedPreview} tall={true} />}
            <input
              className="question__custom"
              placeholder="기타: 직접 입력"
              value={custom[q.question] ?? ""}
              onChange={(e) => setCustom((prev) => ({ ...prev, [q.question]: e.target.value }))}
            />
            <input
              className="question__notes"
              placeholder="메모: 고른 이유나 바꿀 점 (선택)"
              value={notes[q.question] ?? ""}
              onChange={(e) => setNotes((prev) => ({ ...prev, [q.question]: e.target.value }))}
            />
          </div>
        );
      })}
      <div className="card__actions">
        <button
          type="button"
          className="primary"
          disabled={!complete}
          onClick={() => onRespond(merged(), annotations())}
        >
          답변 보내기
        </button>
      </div>
    </div>
  );
}
