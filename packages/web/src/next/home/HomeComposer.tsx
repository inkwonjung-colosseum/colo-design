import type { ProjectSummary } from "@colo-design/protocol";
import { useRef, useState } from "react";
import type { Sessions } from "../../hooks/useSessions";
import { composing } from "../../lib/ime";
import { L } from "../labels";
import { CheckIcon, ChevronDownIcon, SendIcon } from "../ui/icons";
import { Popover } from "../ui/Popover";
import { ProjectMark } from "../ui/ProjectMark";

/**
 * 홈의 큰 입력창(U6) — 뼈대의 얇은 판: 글 + 프로젝트 칩 + 보내기. 보내면
 * `session.create` → `session.send` 로 활성 프로젝트의 새 대화가 열리고 대화
 * 보기로 넘어간다. 첨부 · 모델 칩은 단계 2 의 입력창이 들어오며 붙는다.
 *
 * 프로젝트 칩은 활성 프로젝트를 따라간다 — 다른 것을 고르면 그 프로젝트로
 * 옮긴다(홈은 그대로). 세션은 활성 프로젝트의 클론에서만 태어나기 때문이다.
 */
export function HomeComposer({
  sessions,
  projects,
  active,
  onSwitch,
  onOpened,
}: {
  sessions: Sessions;
  projects: ProjectSummary[];
  active: ProjectSummary | null;
  onSwitch: (slug: string) => void;
  /** 새 대화가 태어났다 — 셸이 대화 보기로 넘어간다. */
  onOpened: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const canSend = draft.trim().length > 0 && !sending && active !== null;

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !active) return;
    setSending(true);
    try {
      // create 가 돌려준 id 로 곧장 보낸다 — 클로저의 activeId 는 아직 create
      // 전의 값이라, 그것을 믿으면 이름 없는 두 번째 대화가 열린다(useSessions).
      const id = await sessions.create();
      if (!id) return;
      onOpened();
      await sessions.sendTurn(text, undefined, id);
      setDraft("");
    } catch {
      // 거절된 말은 입력창에 남는다 — 이유는 sessions.error 가 쥐고 대화 칸이 말한다.
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="nx-composer nx-composer--home">
      <textarea
        rows={2}
        value={draft}
        placeholder={L.home.placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="nx-cmp-tools">
        {active && (
          <div className="nx-anchor">
            <button
              ref={chip}
              type="button"
              className="nx-pchip"
              aria-haspopup="dialog"
              aria-expanded={pickOpen}
              onClick={() => setPickOpen((open) => !open)}
            >
              <ProjectMark slug={active.slug} name={active.name} size="sm" />
              {active.name}
              <ChevronDownIcon />
            </button>
            {pickOpen && (
              <Popover anchor={chip} onClose={() => setPickOpen(false)} up>
                <div className="nx-mh">{L.home.whichService}</div>
                {projects.map((project) => (
                  <button
                    key={project.slug}
                    type="button"
                    className="nx-mi"
                    onClick={() => {
                      setPickOpen(false);
                      if (project.slug !== active.slug) onSwitch(project.slug);
                    }}
                  >
                    <ProjectMark slug={project.slug} name={project.name} size="sm" />
                    <b>{project.name}</b>
                    {project.slug === active.slug && (
                      <span className="nx-ck nx-r">
                        <CheckIcon />
                      </span>
                    )}
                  </button>
                ))}
              </Popover>
            )}
          </div>
        )}
        <div className="nx-grow" />
        <button
          type="button"
          className="nx-send"
          aria-label={L.inbox.send}
          title={L.inbox.send}
          disabled={!canSend}
          onClick={() => void send()}
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
}
