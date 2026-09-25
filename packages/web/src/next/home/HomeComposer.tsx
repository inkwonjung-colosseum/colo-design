import type { ProjectSummary } from "@colo-design/protocol";
import { useRef, useState } from "react";
import type { Attachment } from "../../components/chat/Composer";
import type { Sessions } from "../../hooks/useSessions";
import type { Daemon } from "../../lib/daemon-client";
import { Composer } from "../chat/Composer";
import { L } from "../labels";
import { CheckIcon, ChevronDownIcon } from "../ui/icons";
import { Popover } from "../ui/Popover";
import { ProjectMark } from "../ui/ProjectMark";

/**
 * 홈의 큰 입력창(U6) — 대화 칸과 같은 입력창(`chat/Composer`)에 프로젝트 칩을
 * 앞에 세운 것. 보내면 `session.create` → `session.send` 로 활성 프로젝트의 새
 * 대화가 열리고 대화 보기로 넘어간다. 첨부 · 설정 칩도 대화 칸과 같다.
 *
 * 프로젝트 칩은 활성 프로젝트를 따라간다 — 다른 것을 고르면 그 프로젝트로
 * 옮긴다(홈은 그대로). 세션은 활성 프로젝트의 클론에서만 태어나기 때문이다.
 */
export function HomeComposer({
  daemon,
  sessions,
  projects,
  active,
  onSwitch,
  onOpened,
}: {
  daemon: Daemon;
  sessions: Sessions;
  projects: ProjectSummary[];
  active: ProjectSummary | null;
  onSwitch: (slug: string) => void;
  /** 새 대화가 태어났다 — 셸이 대화 보기로 넘어간다. */
  onOpened: () => void;
}) {
  const [pickOpen, setPickOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);

  const send = async (text: string, attachments: Attachment[]) => {
    if (!active) throw new Error(L.chat.somethingWrong);
    // create 가 돌려준 id 로 곧장 보낸다 — 클로저의 activeId 는 아직 create
    // 전의 값이라, 그것을 믿으면 이름 없는 두 번째 대화가 열린다(useSessions).
    const id = await sessions.create();
    if (!id) throw new Error(L.chat.somethingWrong);
    onOpened();
    await sessions.sendTurn(
      text,
      attachments.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
      id,
    );
  };

  const projectChip = active && (
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
  );

  return (
    <Composer
      daemon={daemon}
      sessions={sessions}
      variant="home"
      draftKey={`home:${active?.slug ?? "none"}`}
      placeholder={L.home.placeholder}
      leading={projectChip}
      lockReason={daemon.connection === "open" ? null : L.chat.connecting}
      onSend={(text, attachments) => send(text, attachments)}
    />
  );
}
