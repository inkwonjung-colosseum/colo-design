import { useState } from "react";
import { composing } from "../../lib/ime";
import { L } from "../labels";
import type { ChatColumnProps } from "../slots";
import { SendIcon } from "../ui/icons";

/**
 * 대화 칸의 자리(단계 1) — 단계 2 가 이 파일을 통째로 바꾼다(입력창 · 대화록 ·
 * 카드 다섯 · 고쳐서 다시 보내기). 그때까지 셸의 배선을 눈으로 확인할 만큼만
 * 선다: 열린 대화의 사람 말과 AI 답을 글자 그대로, 그리고 `sessions.submit`
 * 으로 보내는 한 줄 입력창.
 */
export function ChatColumn({ sessions, project }: ChatColumnProps) {
  const [draft, setDraft] = useState("");
  const blocks = sessions.active?.blocks ?? [];
  const lines = blocks.flatMap(
    (block): Array<{ id: string; who: "user" | "ai"; text: string }> =>
      block.type === "user"
        ? [{ id: block.id, who: "user", text: block.text }]
        : block.type === "text" && block.agentId === null
          ? [{ id: block.id, who: "ai", text: block.text }]
          : [],
  );
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    void sessions
      .submit(text, [])
      .then(() => setDraft(""))
      .catch(() => undefined);
  };
  return (
    <section className="nx-chat">
      <div className="nx-transcript">
        {lines.length === 0 ? (
          <div className="nx-empty-chat">
            <h2>{L.transcript.emptyTitle}</h2>
            {project && <p>{L.transcript.emptyBody(project.name)}</p>}
          </div>
        ) : (
          lines.map((line) => (
            <div key={line.id} className={line.who === "user" ? "nx-m-user" : "nx-m-ai"}>
              <div className="nx-btxt">{line.text}</div>
            </div>
          ))
        )}
      </div>
      <div className="nx-cmp-wrap">
        <div className="nx-composer">
          <textarea
            rows={1}
            value={draft}
            placeholder={L.composer.placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (composing(event)) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="nx-cmp-tools">
            <div className="nx-grow" />
            <button
              type="button"
              className="nx-send"
              aria-label={L.composer.send}
              title={L.composer.send}
              disabled={!draft.trim()}
              onClick={send}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
